import { z } from 'zod';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { isToolAllowed, policyForContext } from '../permissions.js';
import { ProjectMeta } from '../projectContext.js';
import {
  handlePlayGetStatus,
  handlePlayStartGame,
  handlePlayStartScenes,
  handlePlayStop,
} from './runtimeLive.js';
import {
  handleLogGetRuntimeErrors,
  handleLogSearch,
  handleViewportCapture,
} from './liveObservability.js';
import { BRIDGE_V33, ScalarValue, ScalarValueInput } from './liveToolSupport.js';
import {
  RuntimeInvokeScriptMethodSchema,
  RuntimeSetScriptValueMemberSchema,
  handleRuntimeInvokeScriptMethod,
  handleRuntimeSetScriptValue,
} from './runtimeScriptLive.js';
import { bridgeAtLeast, inspectEditorBridge } from './serverStatus.js';

const LogSeverity = z.enum(['trace', 'debug', 'info', 'warning', 'error', 'fatal']);

const AssertLogContainsSchema = z.object({
  type: z.literal('log_contains'),
  query: z.string().min(1).max(256),
  severities: z.array(LogSeverity).max(6).optional(),
});

const AssertLogAbsentSchema = z.object({
  type: z.literal('log_absent'),
  query: z.string().min(1).max(256),
  severities: z.array(LogSeverity).max(6).optional(),
});

const AssertNoErrorsSchema = z.object({
  type: z.literal('no_errors'),
});

const AssertViewportSchema = z.object({
  type: z.literal('viewport_captured'),
});

const ScenarioAssertSchema = z.discriminatedUnion('type', [
  AssertLogContainsSchema,
  AssertLogAbsentSchema,
  AssertNoErrorsSchema,
  AssertViewportSchema,
]);

export type ScenarioAssert = z.infer<typeof ScenarioAssertSchema>;

/** Upper bound on scripted steps in one scenario. */
export const MAX_SCENARIO_STEPS = 16;

const StepAtSeconds = z.number().min(0).max(60)
  .describe('Seconds after play is confirmed running at which the step runs, from 0 up to run_seconds. Steps run in time order; steps at the same time run in the order listed.');

// Step payloads reuse the runtime_* tool schemas, so the members, arguments, and
// limits are exactly the ones those tools enforce.
const SetScriptValueStepSchema = RuntimeSetScriptValueMemberSchema.extend({
  type: z.literal('set_script_value'),
  at_seconds: StepAtSeconds,
}).strict();

const InvokeExpectationSchema = z.object({
  threw: z.boolean().optional()
    .describe('Whether the game method is expected to throw. Defaults to false: a method that throws fails the step unless threw is true.'),
  returned: ScalarValue.optional()
    .describe('Expected return value: a boolean, a number (integers exactly, floating point within a relative 1e-6), or a string (string results, enum names, or an actor, script, or asset GUID). Vector and other structured results cannot be compared.'),
}).strict().superRefine((value, ctx) => {
  if (value.threw === true && value.returned !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returned'], message: 'A method that throws returns nothing: drop returned or set threw to false.' });
  }
});

const InvokeScriptMethodStepSchema = RuntimeInvokeScriptMethodSchema.extend({
  type: z.literal('invoke_script_method'),
  at_seconds: StepAtSeconds,
  expect: InvokeExpectationSchema.optional()
    .describe('Optional expectation on the invocation result. Without it the step only requires that the method runs and does not throw.'),
}).strict();

const ScenarioStepSchema = z.discriminatedUnion('type', [SetScriptValueStepSchema, InvokeScriptMethodStepSchema]);

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const TestRunScenarioSchema = z.object({
  scenario_name: z.string().min(1).max(64),
  run_seconds: z.number().min(1).max(60).optional().default(5),
  start: z.enum(['scenes', 'game']).optional().default('scenes'),
  allow_failed_compile: z.boolean().optional().default(false),
  asserts: z.array(ScenarioAssertSchema).max(8).optional().default([]),
  steps: z.array(ScenarioStepSchema).max(MAX_SCENARIO_STEPS).optional().default([])
    .describe(`Optional scripted actions (max ${MAX_SCENARIO_STEPS}) run during play at at_seconds after play is confirmed running: set_script_value writes a game script member, invoke_script_method calls a public game method and can check what it returned or whether it threw. Flax 1.12 has no key or mouse injection, so this is how a scenario acts on the game. Needs bridge v33 and permission for the runtime_* tools; a failed step or expectation fails the scenario.`),
  dry_run: z.boolean().optional().default(false),
}).strict().superRefine((value, ctx) => {
  value.steps.forEach((step, index) => {
    if (step.at_seconds > value.run_seconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps', index, 'at_seconds'],
        message: `at_seconds (${step.at_seconds}) must not exceed run_seconds (${value.run_seconds}); the step would never run.`,
      });
    }
  });
});

export type TestRunScenarioArgs = z.infer<typeof TestRunScenarioSchema>;

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function sessionIdOf(value: unknown): string | null {
  const row = asRow(value);
  for (const key of ['SessionId', 'sessionId', 'PlaySessionId', 'playSessionId']) {
    if (typeof row[key] === 'string' && (row[key] as string).length > 0) return row[key] as string;
  }
  return null;
}

function extractSessionId(data: unknown): string | null {
  const row = asRow(data);
  // Direct shape (play.status bridge payload).
  const direct = sessionIdOf(data);
  if (direct) return direct;
  // handlePlayStartScenes/Game envelope data: { result, state, bridge }.
  const fromState = sessionIdOf(row.state);
  if (fromState) return fromState;
  const fromResult = sessionIdOf(row.result);
  if (fromResult) return fromResult;
  return null;
}

function playStateOf(value: unknown): string {
  const row = asRow(value);
  for (const key of ['Phase', 'phase']) {
    if (typeof row[key] === 'string') {
      const phase = (row[key] as string).toLowerCase();
      if (phase) return phase;
    }
  }
  for (const key of ['State', 'state', 'Status', 'status']) {
    if (typeof row[key] === 'string') {
      const display = (row[key] as string).toLowerCase();
      if (display === 'starting' || display === 'stopping') return display;
      if (display === 'running' || display === 'paused' || display === 'stopped') return display;
    }
  }
  if (row.IsPlayMode === true || row.isPlayMode === true) {
    return row.IsPaused === true || row.isPaused === true ? 'paused' : 'running';
  }
  if (row.IsPlayModeRequested === true || row.isPlayModeRequested === true) return 'starting';
  if ('IsPlayMode' in row || 'isPlayMode' in row || 'IsPlayModeRequested' in row || 'isPlayModeRequested' in row) {
    return 'stopped';
  }
  return 'unknown';
}

function envelopeOf(response: ToolResponse): { ok: boolean; data?: unknown; error?: { code?: string; message?: string }; warnings: string[]; changes: unknown[] } {
  const envelope = response.structuredContent as Row | undefined;
  return {
    ok: envelope?.ok === true && !response.isError,
    data: (envelope as Row | undefined)?.data,
    error: asRow((envelope as Row | undefined)?.error) as { code?: string; message?: string },
    warnings: Array.isArray((envelope as Row | undefined)?.warnings) ? ((envelope as unknown as { warnings: string[] }).warnings ?? []) : [],
    changes: Array.isArray(envelope?.changes) ? envelope.changes as unknown[] : [],
  };
}

function errorText(env: { error?: { code?: string; message?: string } }, fallback: string): string {
  if (env.error?.code || env.error?.message) {
    return `${env.error?.code ?? 'ERROR'}: ${env.error?.message ?? fallback}`;
  }
  return fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function success(data: unknown, bridge: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings, changes });
}

// ── Scripted steps ──────────────────────────────────────────────────────────
// A step is the runtime_set_script_value or runtime_invoke_script_method tool
// run through its own handler, so request shapes, version gating, and error
// mapping are the tools' own. The scenario adds timing, expectations, and reports.

/** The tool each step type stands for. Its permission and bridge minimum apply to the step. */
const STEP_TOOL: Record<ScenarioStep['type'], string> = {
  set_script_value: 'runtime_set_script_value',
  invoke_script_method: 'runtime_invoke_script_method',
};

/** A step failing with one of these means later steps cannot succeed either: stop scripting. */
const FATAL_STEP_CODES = new Set(['TIMEOUT', 'EDITOR_NOT_CONNECTED', 'INVALID_PLAY_STATE']);

const COMPARABLE_KINDS = ['boolean', 'integer', 'number', 'string', 'enum', 'actor', 'script', 'asset', 'asset_id'];

function pick(row: Row, ...keys: string[]): unknown {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
}

function pickText(row: Row, ...keys: string[]): string | undefined {
  const value = pick(row, ...keys);
  return typeof value === 'string' ? value : undefined;
}

function brief(value: unknown, limit = 80): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function stepLabel(step: ScenarioStep, index: number): string {
  const action = step.type === 'set_script_value' ? `set_script_value ${step.member}` : `invoke_script_method ${step.method}`;
  return `steps[${index}] (${action} at ${step.at_seconds}s)`;
}

function describeStep(step: ScenarioStep): string {
  if (step.type === 'set_script_value') {
    return `${STEP_TOOL[step.type]} (${step.member} = ${brief(step.value)} on script ${step.script_id})`;
  }
  const expectations: string[] = [];
  if (step.expect?.threw !== undefined) expectations.push(`threw=${step.expect.threw}`);
  if (step.expect?.returned !== undefined) expectations.push(`returned=${brief(step.expect.returned)}`);
  const expected = expectations.length > 0 ? `, expecting ${expectations.join(' and ')}` : ', expecting no exception';
  return `${STEP_TOOL[step.type]} (${step.method}(${step.args.map(arg => brief(arg)).join(', ')}) on script ${step.script_id}${expected})`;
}

function typedKind(typed: Row): string {
  const kind = pickText(typed, 'Kind', 'kind');
  return kind ? kind.toLowerCase() : '';
}

/** Compares an expected scalar with the bridge's typed return value. Comparison is strict: no cross-type coercion. */
function returnedMatches(expected: ScalarValueInput, typed: Row): boolean {
  const kind = typedKind(typed);
  if (typeof expected === 'boolean') return kind === 'boolean' && pick(typed, 'Boolean', 'boolean') === expected;
  if (typeof expected === 'number') {
    if (kind === 'integer' || kind === 'enum') return pick(typed, 'Integer', 'integer') === expected;
    if (kind !== 'number') return false;
    const actual = pick(typed, 'Number', 'number');
    // Float results reach the bridge as 32-bit values, so allow their rounding.
    return typeof actual === 'number' && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(actual), Math.abs(expected));
  }
  if (kind === 'string' || kind === 'enum') return pick(typed, 'Text', 'text') === expected;
  const identity = kind === 'actor' || kind === 'script'
    ? pickText(typed, 'Text', 'text')
    : kind === 'asset' || kind === 'asset_id' ? pickText(typed, 'AssetId', 'assetId') : undefined;
  return identity !== undefined && identity.toLowerCase() === expected.toLowerCase();
}

function describeTyped(typed: Row): string {
  const kind = typedKind(typed) || 'unknown';
  const value = (...keys: string[]) => pick(typed, ...keys);
  if (kind === 'boolean') return `boolean ${brief(value('Boolean', 'boolean'))}`;
  if (kind === 'integer') return `integer ${brief(value('Integer', 'integer'))}`;
  if (kind === 'number') return `number ${brief(value('Number', 'number'))}`;
  if (kind === 'string') return `string ${brief(value('Text', 'text'))}`;
  if (kind === 'enum') return `enum ${brief(value('Text', 'text'))} (${brief(value('Integer', 'integer'))})`;
  if (kind === 'actor' || kind === 'script') return `${kind} ${brief(value('Text', 'text'))}`;
  if (kind === 'asset' || kind === 'asset_id') return `${kind} ${brief(value('AssetId', 'assetId'))}`;
  return kind;
}

interface StepOutcome {
  report: Row;
  failures: string[];
  warnings: string[];
  changes: unknown[];
  /** True when later steps cannot succeed either (bridge gone or play no longer running). */
  fatal: boolean;
}

async function runStep(step: ScenarioStep, index: number, sessionId: string | null, ctx: ProjectMeta): Promise<StepOutcome> {
  const label = stepLabel(step, index);
  const outcome: StepOutcome = {
    report: { index, type: step.type, at_seconds: step.at_seconds, script_id: step.script_id, ok: false },
    failures: [],
    warnings: [],
    changes: [],
    fatal: false,
  };
  const { report } = outcome;
  const fail = (message: string) => { outcome.failures.push(`${label} ${message}`); };
  try {
    const response = step.type === 'set_script_value'
      ? await handleRuntimeSetScriptValue({ script_id: step.script_id, member: step.member, value: step.value }, ctx)
      : await handleRuntimeInvokeScriptMethod({ script_id: step.script_id, method: step.method, args: step.args }, ctx);
    const env = envelopeOf(response);
    if (!env.ok) {
      report.error = { code: env.error?.code ?? 'ERROR', message: env.error?.message ?? 'call failed' };
      fail(`failed: ${errorText(env, 'call failed')}`);
      outcome.fatal = FATAL_STEP_CODES.has(env.error?.code ?? '');
      return outcome;
    }
    outcome.warnings.push(...env.warnings);
    outcome.changes.push(...env.changes);
    const result = asRow(asRow(env.data).result);

    // The bridge names the play session it acted in; it must be the one this scenario started.
    const ranIn = pickText(result, 'PlaySessionId', 'playSessionId');
    if (sessionId && ranIn && ranIn !== sessionId) {
      fail(`ran in play session ${ranIn}, not this scenario's session ${sessionId}`);
    }

    if (step.type === 'set_script_value') {
      report.member = pickText(result, 'Member', 'member') ?? step.member;
      report.before = pick(result, 'Before', 'before') ?? null;
      report.after = pick(result, 'After', 'after') ?? null;
    } else {
      const threw = pick(result, 'Threw', 'threw') === true;
      report.method = pickText(result, 'Method', 'method') ?? step.method;
      report.invoked = pick(result, 'Invoked', 'invoked') === true;
      report.threw = threw;
      if (report.invoked !== true) {
        fail('was not invoked: the bridge did not report an invocation');
      } else if (threw) {
        const exceptionType = pickText(result, 'ExceptionType', 'exceptionType') ?? 'an exception';
        const exceptionMessage = pickText(result, 'ExceptionMessage', 'exceptionMessage');
        report.exception_type = exceptionType;
        if (exceptionMessage !== undefined) report.exception_message = exceptionMessage;
        if (step.expect?.threw !== true) {
          fail(`threw ${exceptionType}${exceptionMessage ? `: ${exceptionMessage}` : ''}`);
        }
      } else {
        const returned = pick(result, 'Result', 'result');
        report.result = returned ?? null;
        if (step.expect?.threw === true) {
          fail('was expected to throw but returned normally');
        } else if (step.expect?.returned !== undefined) {
          const typed = asRow(returned);
          if (!returnedMatches(step.expect.returned, typed)) {
            const kind = typedKind(typed);
            const hint = COMPARABLE_KINDS.includes(kind)
              ? ''
              : ' (only boolean, integer, number, string, enum, actor, script, and asset results can be compared)';
            fail(`expected result ${brief(step.expect.returned)} but got ${describeTyped(typed)}${hint}`);
          }
        }
      }
    }
    report.ok = outcome.failures.length === 0;
  } catch (error) {
    fail(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  return outcome;
}

/**
 * Checks everything about the steps that needs no play session, before any request
 * is sent: permission for the tools the steps stand for, and the bridge version.
 * Reads the bridge heartbeat file only; it makes no RPC.
 */
async function preflightSteps(args: TestRunScenarioArgs, ctx: ProjectMeta): Promise<ToolResponse | undefined> {
  if (args.steps.length === 0) return undefined;
  const policy = policyForContext(ctx);
  for (const type of new Set(args.steps.map(step => step.type))) {
    const tool = STEP_TOOL[type];
    if (!isToolAllowed(tool, policy)) {
      return toolError(new ToolDomainError(
        'PERMISSION_DENIED',
        `A ${type} step in test_run_scenario needs the "${tool}" tool, which the active permission policy does not permit.`,
      ));
    }
  }
  let editor;
  try {
    editor = await inspectEditorBridge(ctx);
  } catch {
    // An unreadable project or heartbeat surfaces through the first bridge call instead.
    return undefined;
  }
  if (editor.connected && !bridgeAtLeast(editor, BRIDGE_V33)) {
    return toolError(new ToolDomainError(
      'UNSUPPORTED_FLAX_VERSION',
      `test_run_scenario steps need Editor bridge v${BRIDGE_V33} or newer, but the connected bridge reports v${editor.bridgeVersion ?? 'unknown'} (protocol ${editor.protocolVersion ?? 'unknown'}). Update it with install_editor_bridge, or run the scenario without steps.`,
      { bridgeVersion: editor.bridgeVersion, protocolVersion: editor.protocolVersion, minimumBridgeVersion: BRIDGE_V33 },
    ));
  }
  return undefined;
}

type TimelineEvent =
  | { kind: 'capture'; atMs: number }
  | { kind: 'step'; atMs: number; index: number; step: ScenarioStep };

export async function handleTestRunScenario(args: TestRunScenarioArgs, ctx: ProjectMeta): Promise<ToolResponse> {
  const needsViewport = args.asserts.some(assert => assert.type === 'viewport_captured');

  const blocked = await preflightSteps(args, ctx);
  if (blocked) return blocked;

  if (args.dry_run) {
    // Array.prototype.sort is stable, so steps at the same time keep their listed order.
    const timedSteps = [...args.steps].sort((a, b) => a.at_seconds - b.at_seconds);
    const plannedSteps = [
      args.start === 'game' ? 'play_start_game' : 'play_start_scenes',
      'play_get_status (confirm running)',
      `wait ${args.run_seconds}s`,
      ...timedSteps.map(step => `at ${step.at_seconds}s: ${describeStep(step)}`),
      ...(needsViewport ? ['viewport_capture (game, once mid-run)'] : []),
      ...args.asserts
        .filter(assert => assert.type !== 'viewport_captured')
        .map(assert => {
          if (assert.type === 'no_errors') return 'log_get_runtime_errors (session-scoped)';
          return `log_search (${assert.type}: "${assert.query}")`;
        }),
      'play_stop (always, even on failure/timeout)',
    ];
    const data = {
      dryRun: true,
      scenario: args.scenario_name,
      plannedSteps,
      preview: {
        start: args.start,
        run_seconds: args.run_seconds,
        allow_failed_compile: args.allow_failed_compile,
        asserts: args.asserts,
        ...(args.steps.length > 0 ? { steps: args.steps } : {}),
      },
    };
    return success(data, undefined, ['Dry-run validated arguments and did not start or stop simulation.']);
  }

  const startedAt = Date.now();
  const failures: string[] = [];
  const warnings: string[] = [];
  const stepReports: Row[] = [];
  const stepChanges: unknown[] = [];
  let bridge: unknown;
  let sessionId: string | null = null;
  let viewportOk = false;
  let captureFailureReported = false;

  try {
    const startArgs = {
      wait: true,
      timeout_ms: 30_000,
      dry_run: false,
      allow_dirty: false,
      allow_failed_compile: args.allow_failed_compile,
    };
    const startResponse = args.start === 'game'
      ? await handlePlayStartGame(startArgs, ctx)
      : await handlePlayStartScenes(startArgs, ctx);
    const startEnv = envelopeOf(startResponse);
    if (!startEnv.ok) {
      failures.push(`start failed: ${errorText(startEnv, 'play start failed')}`);
    } else {
      const dataRow = asRow(startEnv.data);
      sessionId = extractSessionId(dataRow.state) ?? extractSessionId(dataRow.result) ?? null;
      const bridgeRow = asRow(dataRow.bridge);
      if (Object.keys(bridgeRow).length > 0) bridge = dataRow.bridge;
      warnings.push(...startEnv.warnings);

      try {
        const statusResponse = await handlePlayGetStatus({}, ctx);
        const statusEnv = envelopeOf(statusResponse);
        if (!statusEnv.ok) {
          failures.push(`status check failed: ${errorText(statusEnv, 'play_get_status failed')}`);
        } else {
          const statusData = asRow(statusEnv.data);
          const result = statusData.result !== undefined ? statusData.result : statusEnv.data;
          const sid = extractSessionId(result);
          if (sid) sessionId = sid;
          if (asRow(statusData.bridge).connected !== undefined || typeof statusData.bridge === 'object') {
            bridge = statusData.bridge ?? bridge;
          }
          warnings.push(...statusEnv.warnings);
          const state = playStateOf(result);
          if (state !== 'running' && state !== 'paused') {
            failures.push(`play did not reach running state (state=${state})`);
          }
        }
      } catch (error) {
        failures.push(`status check threw: ${error instanceof Error ? error.message : String(error)}`);
      }

      // The run is a timeline of timed events (scripted steps and the mid-run capture)
      // separated by sleeps. Each sleep is the gap to the next event, so a slow event
      // delays the ones after it and never shortens the run. Without steps this is
      // the original wait, capture, wait sequence.
      const totalMs = Math.round(args.run_seconds * 1000);
      const timeline: TimelineEvent[] = args.steps.map((step, index): TimelineEvent => (
        { kind: 'step', atMs: Math.round(step.at_seconds * 1000), index, step }
      ));
      if (needsViewport) timeline.push({ kind: 'capture', atMs: Math.floor(totalMs / 2) });
      // Stable: events at the same time keep their order, listed steps before the capture.
      timeline.sort((a, b) => a.atMs - b.atMs);

      let elapsedMs = 0;
      let scriptingStopped = false;
      for (let position = 0; position < timeline.length && !scriptingStopped; position++) {
        const event = timeline[position];
        await sleep(event.atMs - elapsedMs);
        elapsedMs = event.atMs;
        if (event.kind === 'capture') {
          try {
            const captureResponse = await handleViewportCapture({ viewport: 'game', timeout_ms: 10_000, poll_interval_ms: 100 }, ctx);
            const captureEnv = envelopeOf(captureResponse);
            if (!captureEnv.ok) {
              captureFailureReported = true;
              failures.push(`viewport_captured failed: ${errorText(captureEnv, 'viewport capture failed')}`);
            } else {
              viewportOk = true;
              warnings.push(...captureEnv.warnings);
            }
          } catch (error) {
            captureFailureReported = true;
            failures.push(`viewport_captured threw: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          const outcome = await runStep(event.step, event.index, sessionId, ctx);
          stepReports.push(outcome.report);
          failures.push(...outcome.failures);
          stepChanges.push(...outcome.changes);
          // Every step reports the same bridge notes (for example "no undo was recorded"); list each once.
          for (const warning of outcome.warnings) if (!warnings.includes(warning)) warnings.push(warning);
          if (outcome.fatal) {
            scriptingStopped = true;
            const skipped = timeline.slice(position + 1).filter(later => later.kind === 'step');
            for (const later of skipped) {
              if (later.kind !== 'step') continue;
              stepReports.push({ index: later.index, type: later.step.type, at_seconds: later.step.at_seconds, script_id: later.step.script_id, ok: false, skipped: true });
            }
            if (skipped.length > 0) {
              failures.push(`${skipped.length} later step(s) not run: the bridge or the play session is no longer usable`);
            }
          }
        }
      }
      if (!scriptingStopped) await sleep(totalMs - elapsedMs);

      for (const assert of args.asserts) {
        try {
          if (assert.type === 'viewport_captured') {
            if (!viewportOk && !captureFailureReported) {
              failures.push('viewport_captured violated: no successful viewport capture during run');
            }
          } else if (assert.type === 'no_errors') {
            const logResponse = await handleLogGetRuntimeErrors(
              { since_sequence: 0, play_session_id: sessionId ?? undefined, limit: 100, max_scan: 1000 },
              ctx,
            );
            const logEnv = envelopeOf(logResponse);
            if (!logEnv.ok) {
              failures.push(`no_errors check failed: ${errorText(logEnv, 'log_get_runtime_errors failed')}`);
            } else {
              const errors = asRow(logEnv.data).errors;
              const list = Array.isArray(errors) ? errors : [];
              if (list.length > 0) {
                failures.push(`no_errors violated: ${list.length} error(s) in session logs`);
              }
              warnings.push(...logEnv.warnings);
            }
          } else if (assert.type === 'log_contains') {
            const logResponse = await handleLogSearch(
              {
                since_sequence: 0,
                severities: assert.severities,
                play_session_id: sessionId ?? undefined,
                query: assert.query,
                match: 'substring',
                case_sensitive: false,
                limit: 100,
                max_scan: 1000,
              },
              ctx,
            );
            const logEnv = envelopeOf(logResponse);
            if (!logEnv.ok) {
              failures.push(`log_contains check failed: ${errorText(logEnv, 'log_search failed')}`);
            } else {
              const entries = asRow(logEnv.data).entries;
              const list = Array.isArray(entries) ? entries : [];
              if (list.length === 0) {
                failures.push(`log_contains violated: query "${assert.query}" not found in session logs`);
              }
              warnings.push(...logEnv.warnings);
            }
          } else if (assert.type === 'log_absent') {
            const logResponse = await handleLogSearch(
              {
                since_sequence: 0,
                severities: assert.severities,
                play_session_id: sessionId ?? undefined,
                query: assert.query,
                match: 'substring',
                case_sensitive: false,
                limit: 100,
                max_scan: 1000,
              },
              ctx,
            );
            const logEnv = envelopeOf(logResponse);
            if (!logEnv.ok) {
              failures.push(`log_absent check failed: ${errorText(logEnv, 'log_search failed')}`);
            } else {
              const entries = asRow(logEnv.data).entries;
              const list = Array.isArray(entries) ? entries : [];
              if (list.length > 0) {
                failures.push(`log_absent violated: query "${assert.query}" found ${list.length} time(s) in session logs`);
              }
              warnings.push(...logEnv.warnings);
            }
          }
        } catch (error) {
          failures.push(`${assert.type} check threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error) {
    failures.push(`scenario failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      const stopResponse = await handlePlayStop({ wait: true, timeout_ms: 30_000, dry_run: false }, ctx);
      const stopEnv = envelopeOf(stopResponse);
      if (!stopEnv.ok) {
        failures.push(`cleanup play_stop failed: ${errorText(stopEnv, 'play_stop failed')}`);
      } else {
        warnings.push(...stopEnv.warnings);
      }
    } catch (error) {
      failures.push(`cleanup play_stop threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const duration = (Date.now() - startedAt) / 1000;
  const passed = failures.length === 0;
  const data = {
    scenario: args.scenario_name,
    passed,
    failures,
    duration,
    session_id: sessionId,
    // Only present when the request had steps, so a scenario without steps reports exactly what it always did.
    ...(args.steps.length > 0 ? { steps: stepReports } : {}),
  };
  return success(data, bridge, warnings, [...stepChanges, { kind: 'test.scenario.completed', scenario: args.scenario_name, passed }]);
}
