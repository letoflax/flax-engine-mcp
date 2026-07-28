import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';

type RuntimeBridgeMethod =
  | 'code.status' | 'code.compile_start' | 'code.diagnostics'
  | 'code.generate_project_start' | 'code.generate_project_status'
  | 'play.status' | 'play.start_scenes' | 'play.start_game' | 'play.stop'
  | 'play.pause' | 'play.resume' | 'play.step' | 'log.query';

const asBridgeMethod = (method: RuntimeBridgeMethod): BridgeMethod => method as unknown as BridgeMethod;
const TimeoutMs = z.number().int().min(250).max(120_000);
const PlayTimeoutMs = z.number().int().min(250).max(60_000);
const Severity = z.enum(['error', 'warning', 'info']);

export const CodeCompileSchema = z.object({
  wait: z.boolean().optional().default(true),
  timeout_ms: TimeoutMs.optional().default(120_000),
  generate_project_first: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(false),
});
export const CodeGetDiagnosticsSchema = z.object({
  compilation_id: z.string().min(1).max(128).optional(),
  severities: z.array(Severity).min(1).max(3).optional().default(['error', 'warning']),
  file: z.string().min(1).max(512).optional(),
  include_context: z.boolean().optional().default(false),
  max_results: z.number().int().min(1).max(200).optional().default(100),
  // The bridge's McpDiagnosticsRequest exposes Cursor as an integer. Keep the
  // public JSON input string-shaped for MCP clients, but reject opaque cursors.
  cursor: z.string().regex(/^\d+$/, 'cursor must be a non-negative integer string.').max(15).optional(),
});
export const CodeGenerateProjectSchema = z.object({
  wait: z.boolean().optional().default(true),
  timeout_ms: TimeoutMs.optional().default(120_000),
  dry_run: z.boolean().optional().default(false),
});
export const PlayGetStatusSchema = z.object({});
const PlayMutation = z.object({
  wait: z.boolean().optional().default(true),
  timeout_ms: PlayTimeoutMs.optional().default(30_000),
  dry_run: z.boolean().optional().default(false),
});
export const PlayStartScenesSchema = PlayMutation.extend({
  allow_dirty: z.boolean().optional().default(false),
  allow_failed_compile: z.boolean().optional().default(false),
});
export const PlayStartGameSchema = PlayMutation.extend({
  allow_dirty: z.boolean().optional().default(false),
  allow_failed_compile: z.boolean().optional().default(false),
});
export const PlayStopSchema = PlayMutation;
export const PlayPauseSchema = PlayMutation;
export const PlayResumeSchema = PlayMutation;
export const PlayStepFrameSchema = PlayMutation.extend({
  frames: z.number().int().min(1).max(120).optional().default(1),
});
export const PlayRunForSchema = z.object({
  seconds: z.number().positive().max(60).optional(),
  frames: z.number().int().min(1).max(120).optional(),
  until_log: z.string().min(1).max(256).optional(),
  start: z.enum(['scenes', 'game']).optional().default('scenes'),
  timeout_ms: PlayTimeoutMs.optional().default(30_000),
  dry_run: z.boolean().optional().default(false),
});

type RecordValue = Record<string, unknown>;
interface RuntimeCall { data: unknown; bridge: unknown; warnings: string[]; }

function record(value: unknown): RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}; }
function stringField(value: unknown, ...keys: string[]): string | null {
  const source = record(value);
  for (const key of keys) if (typeof source[key] === 'string') return source[key] as string;
  return null;
}
function stateOf(value: unknown): string {
  const phase = stringField(value, 'Phase', 'phase');
  if (phase) return phase.toLowerCase();
  const display = (stringField(value, 'State', 'state', 'Status', 'status') ?? '').toLowerCase();
  // Lifecycle events are authoritative for transitional states that the
  // public Flax flags cannot distinguish.
  if (display === 'starting' || display === 'stopping') return display;
  const source = record(value);
  if (source.IsPlayMode === true || source.isPlayMode === true) {
    return (source.IsPaused === true || source.isPaused === true) ? 'paused' : 'running';
  }
  if (source.IsPlayModeRequested === true || source.isPlayModeRequested === true) return 'starting';
  if ('IsPlayMode' in source || 'isPlayMode' in source || 'IsPlayModeRequested' in source || 'isPlayModeRequested' in source) return 'stopped';
  return display || 'unknown';
}
function operationIdOf(value: unknown): string | null { return stringField(value, 'OperationId', 'operationId', 'CompilationId', 'compilationId'); }
function numberField(value: unknown, ...keys: string[]): number | null {
  const source = record(value);
  for (const key of keys) if (typeof source[key] === 'number' && Number.isFinite(source[key])) return source[key] as number;
  return null;
}
function terminalCompile(state: string): boolean { return ['succeeded', 'success', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(state); }
function terminalProject(state: string): boolean { return ['succeeded', 'success', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(state); }
function terminalPlay(state: string, wanted: string): boolean { return state === wanted || (wanted === 'running' && state === 'paused'); }
function boolField(value: unknown, ...keys: string[]): boolean {
  const source = record(value);
  return keys.some(key => source[key] === true);
}

function runtimeError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  const remote = (error.details as { code?: unknown } | undefined)?.code;
  if (remote === 'NOT_FOUND') return new ToolDomainError('NOT_FOUND', error.message, error.details);
  if (remote === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (remote === 'COMPILATION_IN_PROGRESS' || remote === 'PLAY_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (remote === 'INVALID_STATE') return new ToolDomainError('INVALID_PLAY_STATE', error.message, error.details);
  if (remote === 'PLAY_STATE_CONFLICT' || remote === 'DIRTY_SCENES' || remote === 'INVALID_REQUEST' || remote === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, error.details);
  if (remote === 'REQUEST_TOO_LARGE' || remote === 'RESPONSE_TOO_LARGE') return new ToolDomainError('CONTENT_TOO_LARGE', error.message, error.details);
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function sleep(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, ms)))); }
function isReloadTransient(error: unknown): boolean {
  if (!(error instanceof BridgeRpcError)) return false;
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return true;
  return error.code === 'BRIDGE_REMOTE_ERROR'
    && (error.details as { code?: unknown } | undefined)?.code === 'UNAUTHORIZED';
}
async function callRuntime(ctx: ProjectMeta, method: RuntimeBridgeMethod, params: RecordValue, deadlineMs = 15_000): Promise<RuntimeCall> {
  const response = await callEditorBridge(ctx, asBridgeMethod(method), params, { deadlineMs: Math.min(60_000, deadlineMs) });
  return { data: response.data, bridge: response.bridge, warnings: response.warnings };
}

function success(data: unknown, bridge: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings, changes });
}

async function pollOperation(
  ctx: ProjectMeta,
  method: 'code.status' | 'code.generate_project_status',
  operationId: string | null,
  timeoutMs: number,
): Promise<RuntimeCall> {
  const end = Date.now() + timeoutMs;
  let lastTransient: unknown;
  let terminalObservation: { operationId: string | null; state: string } | undefined;
  while (Date.now() <= end) {
    try {
      const response = await callRuntime(ctx, method, operationId ? { OperationId: operationId } : {}, Math.min(10_000, Math.max(250, end - Date.now())));
      const state = stateOf(response.data);
      const responseOperationId = operationIdOf(response.data);
      if (operationId && responseOperationId && responseOperationId !== operationId) {
        throw new ToolDomainError('OPERATION_NOT_FOUND', `Editor returned operation ${responseOperationId} while waiting for ${operationId}.`);
      }
      if (method === 'code.generate_project_status' && terminalProject(state)) return response;
      if (method === 'code.status' && terminalCompile(state)) {
        // A successful CompilationEnd is followed by script reload. Require the
        // same ready terminal state twice so we do not return in that gap.
        if (['failed', 'cancelled', 'canceled'].includes(state)) return response;
        const ready = record(response.data).IsReady ?? record(response.data).isReady;
        const compiling = record(response.data).IsCompiling ?? record(response.data).isCompiling;
        if (ready !== false && compiling !== true) {
          if (terminalObservation?.operationId === responseOperationId && terminalObservation.state === state) return response;
          terminalObservation = { operationId: responseOperationId, state };
        } else {
          terminalObservation = undefined;
        }
      } else {
        terminalObservation = undefined;
      }
      lastTransient = undefined;
    } catch (error) {
      if (!isReloadTransient(error)) throw error;
      lastTransient = error;
      terminalObservation = undefined;
    }
    await sleep(150);
  }
  if (lastTransient) throw lastTransient;
  throw new BridgeRpcError('BRIDGE_TIMEOUT', 'Editor operation did not reach a terminal state before timeout.');
}

async function waitForCompilerQuiet(ctx: ProjectMeta, timeoutMs: number, quietMs = 750): Promise<RuntimeCall> {
  const end = Date.now() + timeoutMs;
  let quietSince = 0;
  let latest: RuntimeCall | undefined;
  while (Date.now() <= end) {
    try {
      latest = await callRuntime(ctx, 'code.status', {}, Math.min(10_000, Math.max(250, end - Date.now())));
      const state = stateOf(latest.data);
      const ready = record(latest.data).IsReady ?? record(latest.data).isReady;
      const compiling = record(latest.data).IsCompiling ?? record(latest.data).isCompiling;
      const quiet = !['requested', 'starting', 'compiling', 'reloading'].includes(state) && ready !== false && compiling !== true;
      if (quiet) {
        if (quietSince === 0) quietSince = Date.now();
        if (Date.now() - quietSince >= quietMs) return latest;
      } else {
        quietSince = 0;
      }
    } catch (error) {
      if (!isReloadTransient(error)) throw error;
      quietSince = 0;
    }
    await sleep(150);
  }
  if (latest) throw new ToolDomainError('TIMEOUT', 'Compiler did not remain ready after project generation.', { lastStatus: latest.data });
  throw new BridgeRpcError('BRIDGE_TIMEOUT', 'Compiler did not become available after project generation.');
}

async function startCompileWithAdoption(ctx: ProjectMeta, baseline: RuntimeCall, timeoutMs: number): Promise<RuntimeCall> {
  const baselineId = operationIdOf(baseline.data);
  const requestedOperationId = randomUUID().replaceAll('-', '');
  try {
    return await callRuntime(ctx, 'code.compile_start', { GenerateProjectFirst: false, OperationId: requestedOperationId });
  } catch (original) {
    if (!isReloadTransient(original)) throw original;
    // The mutation may have executed before the bridge assembly/token rotated.
    // Never retry it. The caller-selected operation ID is persisted before
    // Flax compilation begins, so only that exact operation can be adopted.
    const end = Date.now() + Math.min(timeoutMs, 15_000);
    while (Date.now() <= end) {
      try {
        const status = await callRuntime(ctx, 'code.status', {}, Math.min(5_000, Math.max(250, end - Date.now())));
        const id = operationIdOf(status.data);
        if (id === requestedOperationId && id !== baselineId) {
          return {
            ...status,
            warnings: [...status.warnings, 'Recovered compile operation after the Editor Bridge reloaded and rotated its session token.'],
          };
        }
      } catch (error) {
        if (!isReloadTransient(error)) throw error;
      }
      await sleep(150);
    }
    throw original;
  }
}

async function pollPlay(ctx: ProjectMeta, wanted: string, timeoutMs: number): Promise<RuntimeCall> {
  const end = Date.now() + timeoutMs;
  while (Date.now() <= end) {
    const response = await callRuntime(ctx, 'play.status', {}, Math.min(10_000, Math.max(250, end - Date.now())));
    if (terminalPlay(stateOf(response.data), wanted)) return response;
    await sleep(100);
  }
  throw new BridgeRpcError('BRIDGE_TIMEOUT', `Play state did not become ${wanted} before timeout.`);
}

async function gatePlayStart(ctx: ProjectMeta, allowDirty: boolean, allowFailedCompile: boolean): Promise<void> {
  // Gate locally before a mutating request so an agent receives a stable reason
  // even when a bridge implementation has not yet added its own policy check.
  const compiler = await callRuntime(ctx, 'code.status', {});
  const compileState = stateOf(compiler.data);
  if (['requested', 'starting', 'compiling', 'reloading'].includes(compileState)) {
    throw new ToolDomainError('EDITOR_BUSY', 'Cannot start play while scripts are compiling or reloading.');
  }
  if (['failed', 'failure'].includes(compileState) && !allowFailedCompile) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Cannot start play because the latest compilation failed. Set allow_failed_compile:true only when intentionally testing this state.');
  }
  const play = await callRuntime(ctx, 'play.status', {});
  if (['starting', 'running', 'paused', 'stopping'].includes(stateOf(play.data))) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Play is not stopped; stop the current simulation before starting another one.');
  }
  if (boolField(play.data, 'HasDirtyScenes', 'hasDirtyScenes', 'DirtyScenes', 'dirtyScenes') && !allowDirty) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Dirty scenes must be saved before starting play. Set allow_dirty:true to override the bridge policy.');
  }
}

async function generateProjectBeforeCompile(ctx: ProjectMeta, timeoutMs: number): Promise<RuntimeCall> {
  const started = await callRuntime(ctx, 'code.generate_project_start', {});
  const operationId = operationIdOf(started.data);
  const completed = await pollOperation(ctx, 'code.generate_project_status', operationId, timeoutMs);
  if (!['succeeded', 'success'].includes(stateOf(completed.data))) {
    throw new ToolDomainError('VALIDATION_FAILED', 'Project file generation did not succeed; compilation was not started.', {
      operationId,
      result: completed.data,
    });
  }
  const ready = await waitForCompilerQuiet(ctx, timeoutMs);
  return {
    data: { operationId, started: started.data, result: completed.data, compiler: ready.data },
    bridge: ready.bridge,
    warnings: [...started.warnings, ...completed.warnings, ...ready.warnings],
  };
}

function diagnosticEntries(value: unknown): RecordValue[] {
  const entries = record(value).Entries ?? record(value).entries;
  return Array.isArray(entries) ? entries.map(record) : [];
}

function filteredDiagnostics(value: unknown, args: z.infer<typeof CodeGetDiagnosticsSchema>): { result: unknown; filtered: boolean } {
  const source = record(value);
  const all = diagnosticEntries(value);
  const requestedLevels = new Set(args.severities.map(level => level.toLowerCase()));
  const requestedFile = args.file?.replace(/\\/g, '/').toLowerCase();
  const matching = all.filter(entry => {
    const level = (stringField(entry, 'Level', 'level') ?? 'info').toLowerCase();
    const file = stringField(entry, 'File', 'file')?.replace(/\\/g, '/').toLowerCase();
    return requestedLevels.has(level) && (!requestedFile || file === requestedFile);
  }).slice(0, args.max_results);
  return {
    result: { ...source, Entries: matching, LocalFilteringApplied: true },
    filtered: matching.length !== all.length,
  };
}

async function addDiagnosticContext(value: unknown, ctx: ProjectMeta): Promise<unknown> {
  const source = record(value);
  const entries = diagnosticEntries(value);
  const root = await fs.realpath(ctx.projectPath);
  const cache = new Map<string, string[] | null>();
  const enriched = await Promise.all(entries.map(async entry => {
    const relative = stringField(entry, 'File', 'file');
    const line = numberField(entry, 'Line', 'line');
    if (!relative || line === null || line < 1 || path.isAbsolute(relative)) return entry;
    const candidate = path.resolve(ctx.projectPath, relative);
    const lexical = path.relative(ctx.projectPath, candidate);
    if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) return entry;
    let lines = cache.get(candidate);
    if (lines === undefined) {
      try {
        const real = await fs.realpath(candidate);
        const contained = path.relative(root, real);
        const stat = await fs.stat(real);
        if (!contained || contained.startsWith('..') || path.isAbsolute(contained) || !stat.isFile() || stat.size > 1024 * 1024) {
          lines = null;
        } else {
          lines = (await fs.readFile(real, 'utf8')).split(/\r?\n/);
        }
      } catch {
        lines = null;
      }
      cache.set(candidate, lines);
    }
    if (!lines) return entry;
    const start = Math.max(1, line - 2);
    const end = Math.min(lines.length, line + 2);
    return {
      ...entry,
      ContextLines: lines.slice(start - 1, end).map((text, index) => ({
        Line: start + index,
        Text: text.slice(0, 500),
      })),
    };
  }));
  return { ...source, Entries: enriched };
}

export async function handleCodeCompile(args: z.infer<typeof CodeCompileSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    if (args.dry_run) {
      const current = await callRuntime(ctx, 'code.status', {});
      return success({ dryRun: true, current: current.data, preview: { generateProjectFirst: args.generate_project_first } }, current.bridge,
        ['Dry-run inspected compiler state and did not start compilation.']);
    }
    const generated = args.generate_project_first ? await generateProjectBeforeCompile(ctx, args.timeout_ms) : undefined;
    const baseline = await callRuntime(ctx, 'code.status', {});
    const started = await startCompileWithAdoption(ctx, baseline, args.timeout_ms);
    const operationId = operationIdOf(started.data);
    const generationData = generated ? { projectGeneration: generated.data } : {};
    const priorWarnings = generated?.warnings ?? [];
    if (!args.wait) return success({ started: true, operationId, state: stateOf(started.data), result: started.data, ...generationData }, started.bridge, [...priorWarnings, ...started.warnings], [{ kind: 'code.compile.started', operationId }]);
    const completed = await pollOperation(ctx, 'code.status', operationId, args.timeout_ms);
    const diagnostics = await callRuntime(ctx, 'code.diagnostics', { CompilationId: operationId, Severities: ['error', 'warning'], MaxResults: 100 });
    const data = { started: true, operationId, state: stateOf(completed.data), status: completed.data, diagnostics: diagnostics.data, ...generationData };
    if (!['succeeded', 'success'].includes(data.state)) {
      return toolError(new ToolDomainError('COMPILATION_FAILED', 'Flax script compilation did not succeed.', data));
    }
    return success(data, completed.bridge, [...priorWarnings, ...started.warnings, ...completed.warnings, ...diagnostics.warnings], [{ kind: 'code.compile.completed', operationId, state: data.state }]);
  } catch (error) { return toolError(runtimeError(error)); }
}

export async function handleCodeGetDiagnostics(args: z.infer<typeof CodeGetDiagnosticsSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callRuntime(ctx, 'code.diagnostics', {
      CompilationId: args.compilation_id, Severities: args.severities, File: args.file,
      IncludeContext: args.include_context, MaxResults: args.max_results, Cursor: args.cursor === undefined ? undefined : Number(args.cursor),
    });
    const filtered = filteredDiagnostics(response.data, args);
    const phase = stateOf(filtered.result);
    if (phase === 'not_found') {
      throw new ToolDomainError('COMPILATION_NOT_FOUND', `Compilation ${args.compilation_id ?? 'requested'} is not available in the current bridge session.`);
    }
    const result = args.include_context ? await addDiagnosticContext(filtered.result, ctx) : filtered.result;
    const warnings = filtered.filtered ? [...response.warnings, 'Diagnostics were filtered locally because the bridge returned an unfiltered Entries collection.'] : response.warnings;
    return success({ result, bridge: response.bridge }, response.bridge, warnings);
  } catch (error) { return toolError(runtimeError(error)); }
}

export async function handleCodeGenerateProject(args: z.infer<typeof CodeGenerateProjectSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    if (args.dry_run) {
      const current = await callRuntime(ctx, 'code.status', {});
      return success({ dryRun: true, current: current.data, preview: { action: 'generate_project' } }, current.bridge, ['Dry-run did not generate project files.']);
    }
    const started = await callRuntime(ctx, 'code.generate_project_start', {});
    const operationId = operationIdOf(started.data);
    if (!args.wait) return success({ started: true, operationId, result: started.data }, started.bridge, started.warnings, [{ kind: 'code.project_generation.started', operationId }]);
    const completed = await pollOperation(ctx, 'code.generate_project_status', operationId, args.timeout_ms);
    const state = stateOf(completed.data);
    if (!['succeeded', 'success'].includes(state)) {
      return toolError(new ToolDomainError('VALIDATION_FAILED', 'Flax project-file generation did not succeed.', {
        started: true, operationId, state, result: completed.data,
      }));
    }
    const ready = await waitForCompilerQuiet(ctx, args.timeout_ms);
    return success({ started: true, operationId, state, result: completed.data, compiler: ready.data }, ready.bridge,
      [...started.warnings, ...completed.warnings], [{ kind: 'code.project_generation.completed', operationId, state: stateOf(completed.data) }]);
  } catch (error) { return toolError(runtimeError(error)); }
}

export async function handlePlayGetStatus(_: z.infer<typeof PlayGetStatusSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try { const response = await callRuntime(ctx, 'play.status', {}); return success({ result: response.data, bridge: response.bridge }, response.bridge, response.warnings); }
  catch (error) { return toolError(runtimeError(error)); }
}

async function playMutation(
  ctx: ProjectMeta,
  method: 'play.start_scenes' | 'play.start_game' | 'play.stop' | 'play.pause' | 'play.resume' | 'play.step',
  expectedState: string | null,
  args: { wait: boolean; timeout_ms: number; dry_run: boolean },
  params: RecordValue,
  change: unknown,
): Promise<ToolResponse> {
  try {
    if (args.dry_run) {
      const current = await callRuntime(ctx, 'play.status', {});
      return success({ dryRun: true, current: current.data, preview: params }, current.bridge, ['Dry-run inspected play state and did not change simulation state.']);
    }
    if (method === 'play.start_scenes' || method === 'play.start_game') {
      await gatePlayStart(ctx, params.AllowDirtyScenes === true, params.AllowCompileFailure === true);
    }
    const response = await callRuntime(ctx, method, params);
    if (!args.wait || !expectedState) return success({ result: response.data, bridge: response.bridge }, response.bridge, response.warnings, [change]);
    const verified = await pollPlay(ctx, expectedState, args.timeout_ms);
    return success({ result: response.data, state: verified.data, bridge: verified.bridge }, verified.bridge, [...response.warnings, ...verified.warnings], [change]);
  } catch (error) { return toolError(runtimeError(error)); }
}

export const handlePlayStartScenes = (args: z.infer<typeof PlayStartScenesSchema>, ctx: ProjectMeta) =>
  playMutation(ctx, 'play.start_scenes', 'running', args, { AllowDirtyScenes: args.allow_dirty, AllowCompileFailure: args.allow_failed_compile }, { kind: 'play.started', mode: 'scenes' });
export const handlePlayStartGame = (args: z.infer<typeof PlayStartGameSchema>, ctx: ProjectMeta) =>
  playMutation(ctx, 'play.start_game', 'running', args, { AllowDirtyScenes: args.allow_dirty, AllowCompileFailure: args.allow_failed_compile }, { kind: 'play.started', mode: 'game' });
export const handlePlayStop = (args: z.infer<typeof PlayStopSchema>, ctx: ProjectMeta) =>
  playMutation(ctx, 'play.stop', 'stopped', args, {}, { kind: 'play.stopped' });
export const handlePlayPause = (args: z.infer<typeof PlayPauseSchema>, ctx: ProjectMeta) =>
  playMutation(ctx, 'play.pause', 'paused', args, {}, { kind: 'play.paused' });
export const handlePlayResume = (args: z.infer<typeof PlayResumeSchema>, ctx: ProjectMeta) =>
  playMutation(ctx, 'play.resume', 'running', args, {}, { kind: 'play.resumed' });

export async function handlePlayStepFrame(args: z.infer<typeof PlayStepFrameSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const current = await callRuntime(ctx, 'play.status', {});
    if (args.dry_run) return success({ dryRun: true, current: current.data, preview: { frames: args.frames } }, current.bridge, ['Dry-run did not step simulation frames.']);
    if (stateOf(current.data) !== 'paused') {
      throw new ToolDomainError('INVALID_PLAY_STATE', 'play_step_frame requires an active, paused play session.');
    }
    let latest = current;
    const warnings = [...current.warnings];
    for (let frame = 0; frame < args.frames; frame++) {
      latest = await callRuntime(ctx, 'play.step', {});
      warnings.push(...latest.warnings);
      // Flax 1.12 synchronously unpauses when it accepts RequestPlayOneFrame,
      // then pauses again only after an Update/FixedUpdate was consumed. The
      // bridge response proves the transition began; polling paused proves it
      // completed before another request is issued.
      if (stateOf(latest.data) !== 'running') {
        throw new ToolDomainError('INVALID_PLAY_STATE', 'Flax did not acknowledge the frame-step transition.');
      }
      const completed = await pollPlay(ctx, 'paused', args.timeout_ms);
      latest = completed;
      warnings.push(...completed.warnings);
    }
    return success({ framesRequested: args.frames, framesStepped: args.frames, result: latest.data }, latest.bridge, warnings,
      [{ kind: 'play.stepped', frames: args.frames }]);
  } catch (error) { return toolError(runtimeError(error)); }
}

function logMatches(value: unknown, contains: string): boolean {
  const expected = contains.toLowerCase();
  return diagnosticEntries({ Entries: record(value).Entries ?? record(value).entries })
    .some(entry => (stringField(entry, 'Message', 'message') ?? '').toLowerCase().includes(expected));
}

async function cleanupPlayRun(ctx: ProjectMeta, timeoutMs: number): Promise<{ attempted: boolean; stopped: boolean; status?: unknown; error?: string }> {
  try {
    const stopped = await callRuntime(ctx, 'play.stop', {}, Math.min(timeoutMs, 10_000));
    try {
      const verified = await pollPlay(ctx, 'stopped', Math.min(timeoutMs, 5_000));
      return { attempted: true, stopped: true, status: verified.data };
    } catch (error) {
      return { attempted: true, stopped: false, status: stopped.data, error: runtimeError(error).message };
    }
  } catch (error) {
    // Stop may race with an editor-initiated stop. In that case a final status
    // check still gives callers an accurate cleanup result.
    try {
      const status = await callRuntime(ctx, 'play.status', {});
      if (stateOf(status.data) === 'stopped') return { attempted: true, stopped: true, status: status.data };
    } catch { /* retain original cleanup error */ }
    return { attempted: true, stopped: false, error: runtimeError(error).message };
  }
}

export async function handlePlayRunFor(args: z.infer<typeof PlayRunForSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  if (args.seconds === undefined && args.frames === undefined && args.until_log === undefined) {
    return toolError(new ToolDomainError('VALIDATION_FAILED', 'Provide seconds, frames, and/or until_log.'));
  }
  if (args.dry_run) {
    try {
      const current = await callRuntime(ctx, 'play.status', {});
      return success({ dryRun: true, current: current.data, preview: { start: args.start, seconds: args.seconds, frames: args.frames, untilLog: args.until_log } }, current.bridge, ['Dry-run did not start or stop simulation.']);
    } catch (error) { return toolError(runtimeError(error)); }
  }
  let started = false;
  let bridge: unknown;
  const warnings: string[] = [];
  let payload: RecordValue | undefined;
  let failure: unknown;
  let cleanup: { attempted: boolean; stopped: boolean; status?: unknown; error?: string } = { attempted: false, stopped: false };
  try {
    const startMethod = args.start === 'game' ? 'play.start_game' : 'play.start_scenes';
    await gatePlayStart(ctx, false, false);
    const response = await callRuntime(ctx, startMethod, { AllowDirtyScenes: false, AllowCompileFailure: false });
    bridge = response.bridge; warnings.push(...response.warnings); started = true;
    const running = await pollPlay(ctx, 'running', args.timeout_ms);
    const playSessionId = stringField(running.data, 'SessionId', 'sessionId');
    const hardEnd = Date.now() + args.timeout_ms;
    const end = args.seconds === undefined ? undefined : Date.now() + Math.min(args.timeout_ms, Math.round(args.seconds * 1000));
    let stepped = 0;
    let matchedLog: unknown;
    let logSequence = 0;
    if (args.frames !== undefined) {
      const pause = await callRuntime(ctx, 'play.pause', {});
      bridge = pause.bridge; warnings.push(...pause.warnings);
      const paused = await pollPlay(ctx, 'paused', args.timeout_ms);
      bridge = paused.bridge;
    }
    while (true) {
      if (args.frames !== undefined && stepped >= args.frames) break;
      if (end !== undefined && Date.now() >= end) break;
      if (args.until_log && matchedLog !== undefined) break;
      if (Date.now() >= hardEnd) {
        throw new ToolDomainError('TIMEOUT', 'Simulation did not reach a requested play_run_for condition before timeout.');
      }
      if (args.frames !== undefined) {
        const transition = await callRuntime(ctx, 'play.step', {});
        if (stateOf(transition.data) !== 'running') {
          throw new ToolDomainError('INVALID_PLAY_STATE', 'Flax did not acknowledge the frame-step transition.');
        }
        const completed = await pollPlay(ctx, 'paused', Math.max(250, hardEnd - Date.now()));
        bridge = completed.bridge;
        stepped++;
      }
      else await sleep(25);
      const status = await callRuntime(ctx, 'play.status', {});
      bridge = status.bridge;
      if (stateOf(status.data) === 'stopped') throw new ToolDomainError('OPERATION_CANCELLED', 'Simulation stopped before play_run_for completed.');
      if (args.until_log) {
        const logs = await callRuntime(ctx, 'log.query', {
          SinceSequence: logSequence,
          Limit: 100,
          ...(playSessionId ? { PlaySessionId: playSessionId } : {}),
          Contains: args.until_log,
          IncludeStackTrace: false,
        });
        bridge = logs.bridge; warnings.push(...logs.warnings);
        const next = record(logs.data).NextSequence ?? record(logs.data).nextSequence;
        if (typeof next === 'number') logSequence = next;
        if (logMatches(logs.data, args.until_log)) matchedLog = logs.data;
      }
    }
    payload = { completed: true, seconds: args.seconds, frames: stepped, untilLog: args.until_log, logMatched: matchedLog !== undefined, matchedLog };
  } catch (error) { failure = error; }
  finally {
    if (started) cleanup = await cleanupPlayRun(ctx, args.timeout_ms);
  }
  if (failure) {
    const original = runtimeError(failure);
    return toolError(new ToolDomainError(original.code, original.message, { original: original.details, cleanup }));
  }
  if (!cleanup.stopped) warnings.push(`Play cleanup did not verify a stopped state${cleanup.error ? `: ${cleanup.error}` : '.'}`);
  return success({ ...payload, cleanup }, bridge, warnings, [{ kind: 'play.run_for.completed', frames: payload?.frames }]);
}
