import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, safeReadFile } from '../projectContext.js';
import { ToolDomainError, toolError, toolResult, ToolMode, ToolResponse } from '../errors.js';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { reportProgress } from '../progress.js';
import { SERVER_VERSION } from '../version.js';
import { classifiedToolNames, permissionSummary } from '../permissions.js';
import { assetImportPolicyForContext } from '../assetImportPolicy.js';
import { comparablePathKey } from '../platform.js';

export const GetServerCapabilitiesSchema = z.object({});
export const EditorGetStatusSchema = z.object({
  wait_ready: z.boolean().optional().default(false)
    .describe('Wait until the Editor bridge is up and idle (not compiling, reloading scripts, importing or switching scenes) before answering. Heartbeat gaps and token changes during a script reload count as "reloading" and are waited out. Default false: report the heartbeat state at once.'),
  timeout_ms: z.number().int().min(1).max(300_000).optional().default(120_000)
    .describe('With wait_ready: how long to wait (at most 300000, default 120000). On timeout the tool returns TIMEOUT with the last observed state.'),
  require_scene: z.boolean().optional().default(false)
    .describe('With wait_ready: also wait until at least one scene is loaded (bridge v34).'),
  min_bridge_version: z.number().int().min(1).max(1000).optional()
    .describe('With wait_ready: also wait until the bridge reports at least this version (for example 34 after installing a new bridge file and letting the Editor recompile).'),
});

export const BRIDGE_HEARTBEAT_MAX_AGE_MS = 30_000;
const BRIDGE_HEARTBEAT_MAX_FUTURE_SKEW_MS = 5_000;

interface ProjectIdentity {
  name: string;
  version: string | null;
  id: string;
  explicitId: string | null;
  pathHash: string;
  minEngineVersion: string | null;
}

interface BridgeHeartbeat {
  pid?: unknown;
  Pid?: unknown;
  Project?: unknown;
  projectPath?: unknown;
  project_path?: unknown;
  projectId?: unknown;
  projectGuid?: unknown;
  project_id?: unknown;
  heartbeatAt?: unknown;
  heartbeat_at?: unknown;
  updatedAt?: unknown;
  timestamp?: unknown;
  Timestamp?: unknown;
  editorVersion?: unknown;
  EditorVersion?: unknown;
  bridgeVersion?: unknown;
  BridgeVersion?: unknown;
  protocolVersion?: unknown;
  ProtocolVersion?: unknown;
  endpoint?: unknown;
  [key: string]: unknown;
}

export interface EditorBridgeStatus {
  connected: boolean;
  reason: 'connected' | 'heartbeat_missing' | 'heartbeat_invalid' | 'project_mismatch' | 'process_not_running' | 'heartbeat_stale';
  pid: number | null;
  heartbeatAgeMs: number | null;
  editorVersion: string | null;
  bridgeVersion: string | null;
  protocolVersion: string | null;
  endpoint: string | null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function versionValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function normalizeProjectPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * The Editor reports Globals.ProjectFolder, which may differ in spelling from --project-path:
 * letter case on macOS, or a symlinked / bind-mounted folder on Linux. Equal canonical paths match.
 */
async function sameProjectPath(reported: string, projectPath: string): Promise<boolean> {
  if (normalizeProjectPath(reported) === normalizeProjectPath(projectPath)) return true;
  if (comparablePathKey(reported) === comparablePathKey(projectPath)) return true;
  try {
    const [left, right] = await Promise.all([fs.realpath(path.resolve(reported)), fs.realpath(path.resolve(projectPath))]);
    return comparablePathKey(left) === comparablePathKey(right);
  } catch {
    return false;
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readProjectIdentity(ctx: ProjectMeta): Promise<ProjectIdentity> {
  const raw = await fs.readFile(ctx.flaxprojPath, 'utf8');
  const project = JSON.parse(raw) as Record<string, unknown>;
  const explicitId =
    stringValue(project['ProjectId']) ??
    stringValue(project['ProjectID']) ??
    stringValue(project['Guid']) ??
    stringValue(project['GUID']) ??
    stringValue(project['ID']);
  const pathHash = crypto.createHash('sha256').update(normalizeProjectPath(ctx.projectPath)).digest('hex');

  return {
    name: stringValue(project['Name']) ?? ctx.projectName,
    version: stringValue(project['Version']),
    id: explicitId ?? pathHash,
    explicitId,
    pathHash,
    minEngineVersion: stringValue(project['MinEngineVersion']),
  };
}

function baseBridgeStatus(reason: EditorBridgeStatus['reason']): EditorBridgeStatus {
  return {
    connected: false,
    reason,
    pid: null,
    heartbeatAgeMs: null,
    editorVersion: null,
    bridgeVersion: null,
    protocolVersion: null,
    endpoint: null,
  };
}

const HEARTBEAT_READ_RETRIES = 3;
const HEARTBEAT_READ_RETRY_MS = 40;

/**
 * Reads bridge.json. The Editor replaces it every two seconds; on Windows a reader can land in the
 * replace window and see no file (seen live: one call in a burst reported heartbeat_missing and
 * failed). While the session token still exists the Editor is up, so a missing file is retried.
 */
async function readHeartbeatFile(heartbeatPath: string): Promise<string | null> {
  let raw = await safeReadFile(heartbeatPath);
  if (raw) return raw;
  const tokenPath = path.join(path.dirname(heartbeatPath), 'token');
  for (let attempt = 0; attempt < HEARTBEAT_READ_RETRIES; attempt += 1) {
    if (!(await fs.stat(tokenPath).then(() => true, () => false))) return null;
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_READ_RETRY_MS));
    raw = await safeReadFile(heartbeatPath);
    if (raw) return raw;
  }
  return null;
}

export async function inspectEditorBridge(
  ctx: ProjectMeta,
  now = Date.now(),
  processAlive: (pid: number) => boolean = isProcessAlive
): Promise<EditorBridgeStatus> {
  const heartbeatPath = path.join(ctx.projectPath, 'Cache', 'MCP', 'bridge.json');
  const raw = await readHeartbeatFile(heartbeatPath);
  if (!raw) return baseBridgeStatus('heartbeat_missing');

  let heartbeat: BridgeHeartbeat;
  try {
    heartbeat = JSON.parse(raw) as BridgeHeartbeat;
  } catch {
    return baseBridgeStatus('heartbeat_invalid');
  }

  const rawPid = heartbeat.pid ?? heartbeat.Pid;
  const pid = typeof rawPid === 'number' ? rawPid : Number(rawPid);
  const heartbeatTime = parseTimestamp(
    heartbeat.heartbeatAt ?? heartbeat.heartbeat_at ?? heartbeat.updatedAt ?? heartbeat.timestamp ?? heartbeat.Timestamp
  );
  if (!Number.isInteger(pid) || pid <= 0 || heartbeatTime === null) {
    return baseBridgeStatus('heartbeat_invalid');
  }

  const identity = await readProjectIdentity(ctx);
  const heartbeatProjectPath = stringValue(heartbeat.projectPath ?? heartbeat.project_path ?? heartbeat.Project);
  const heartbeatProjectId = stringValue(heartbeat.projectId ?? heartbeat.projectGuid ?? heartbeat.project_id);
  const pathMatches = heartbeatProjectPath !== null && await sameProjectPath(heartbeatProjectPath, ctx.projectPath);
  const idMatches = heartbeatProjectId !== null &&
    [identity.id, identity.explicitId, identity.pathHash]
      .some(candidate => candidate !== null && heartbeatProjectId.toLowerCase() === candidate.toLowerCase());
  const projectMatches = pathMatches || idMatches;
  const age = Math.max(0, now - heartbeatTime);

  const status: EditorBridgeStatus = {
    connected: false,
    reason: 'project_mismatch',
    pid,
    heartbeatAgeMs: age,
    editorVersion: versionValue(heartbeat.editorVersion ?? heartbeat.EditorVersion),
    bridgeVersion: versionValue(heartbeat.bridgeVersion ?? heartbeat.BridgeVersion),
    protocolVersion: versionValue(heartbeat.protocolVersion ?? heartbeat.ProtocolVersion),
    endpoint: stringValue(heartbeat.endpoint),
  };

  if (!projectMatches) return status;
  if (!processAlive(pid)) return { ...status, reason: 'process_not_running' };
  if (heartbeatTime - now > BRIDGE_HEARTBEAT_MAX_FUTURE_SKEW_MS) {
    return { ...status, reason: 'heartbeat_invalid' };
  }
  if (age > BRIDGE_HEARTBEAT_MAX_AGE_MS) return { ...status, reason: 'heartbeat_stale' };
  return { ...status, connected: true, reason: 'connected' };
}

/** True when a live bridge speaking protocol v1 reports at least this bridge version. */
export function bridgeAtLeast(editor: EditorBridgeStatus, minimumBridgeVersion: number): boolean {
  return editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= minimumBridgeVersion;
}

export async function handleGetServerCapabilities(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const [identity, editor] = await Promise.all([readProjectIdentity(ctx), inspectEditorBridge(ctx)]);
    const mode: ToolMode = editor.connected ? 'editor-connected' : 'offline';
    const supports = (minimumBridgeVersion: number) => bridgeAtLeast(editor, minimumBridgeVersion);
    const phase2 = supports(6);
    const phase3 = supports(7);
    const phase4Assets = supports(8);
    const phase5AssetImport = supports(9);
    const phase6AssetOrganization = supports(10);
    const operationHandles = supports(11);
    const phase6Prefabs = supports(12);
    const prefabOverrideWorkflows = supports(30);
    const assetQuarantineDelete = supports(13);
    const buildCook = supports(13);
    const materialAnimation = supports(13);
    const domainQueries = supports(14);
    const editorViewportCapture = supports(22);
    const playTimeScale = supports(23);
    const editorSelection = supports(24);
    const sceneOpen = supports(25);
    const inputSimulation = supports(26);
    const perfSnapshot = supports(27);
    const perfGpuEvents = supports(36);
    const assetModelStats = supports(36);
    const scriptFieldWrite = supports(28);
    const actorPropertyWrite = supports(28);
    const materialParameterWrite = supports(29);
    const materialInstanceCreation = supports(29);
    const materialAssignment = supports(29);
    const terrainFoliageWrites = supports(31);
    const assetImportSettings = supports(32);
    const navigationBuild = supports(31);
    const lightingBake = supports(31);
    const environmentProbeBake = supports(31);
    const bridgeV33 = supports(33);
    const assetImportPolicy = assetImportPolicyForContext(ctx);
    const data = {
      serverVersion: SERVER_VERSION,
      project: identity,
      mode,
      editorBridge: editor,
      features: {
        fileTools: true,
        liveEditor: editor.connected,
        sceneFileWrite: true,
        structuredOutput: true,
        codeCompile: phase2,
        playMode: phase2,
        liveLogs: phase2,
        viewportCapture: phase2,
        editorViewportCapture,
        playTimeScale,
        editorSelection,
        sceneOpen,
        inputSimulation,
        perfSnapshot,
        perfGpuEvents,
        assetModelStats,
        runtimeInspection: phase2,
        sceneRevisions: phase3,
        editLeases: phase3,
        idempotentEditorWrites: phase3,
        safeActorSurface: phase3,
        // Still false on v33: writes reach editor-visible members only
        // (what the property grid shows), never arbitrary reflected ones.
        arbitraryActorProperties: false,
        scriptInstanceEnabledPatch: supports(5),
        scriptFieldWrite,
        actorPropertyWrite,
        actorPropertyRead: bridgeV33,
        editorVisibleActorProperties: bridgeV33,
        uiControls: bridgeV33,
        particleParameters: bridgeV33,
        runtimeScriptDrive: bridgeV33,
        settingsWrite: bridgeV33,
        sceneCreate: bridgeV33,
        sceneClose: bridgeV33,
        contentFolderCreate: bridgeV33,
        assetCreate: bridgeV33,
        // Node-side: tools/call requests carrying _meta.progressToken receive
        // notifications/progress from long polls, with or without a bridge.
        progressNotifications: true,
        arbitrarySerializedScriptProperties: false,
        assetSearch: phase4Assets,
        assetRegistryMetadata: phase4Assets,
        assetDependencyGraph: phase4Assets,
        assetReverseReferences: phase4Assets,
        assetImportSettings,
        assetReferenceLocations: false,
        assetImport: {
          available: phase5AssetImport,
          enabled: phase5AssetImport && assetImportPolicy.roots.length > 0,
          configuredRootCount: assetImportPolicy.roots.length,
          maxSourceBytes: assetImportPolicy.maxSourceBytes,
          allowedExtensionCount: assetImportPolicy.extensions.length,
          settings: assetImportSettings,
        },
        assetOrganization: {
          available: phase6AssetOrganization,
          move: phase6AssetOrganization,
          rename: phase6AssetOrganization,
          duplicate: phase6AssetOrganization,
          quarantineDelete: assetQuarantineDelete,
          permanentDelete: false,
          undo: false,
          editLeases: false,
          referenceImpact: phase6AssetOrganization,
        },
        operationHandles,
        operationProgress: operationHandles,
        operationCancel: operationHandles,
        mcpTasks: false,
        prefab: {
          available: phase6Prefabs,
          create: phase6Prefabs,
          instantiate: phase6Prefabs,
          loadedSceneInstances: phase6Prefabs,
          overrides: prefabOverrideWorkflows,
          applyOverrides: prefabOverrideWorkflows,
          revertOverrides: prefabOverrideWorkflows,
          breakLink: prefabOverrideWorkflows,
        },
        buildCook: {
          available: buildCook,
          targets: buildCook,
          preflightOnly: buildCook,
          cancel: buildCook,
          outputScope: buildCook ? 'project-relative-Builds-only' : null,
        },
        material: {
          available: materialAnimation,
          parameters: materialAnimation,
          setParameters: materialParameterWrite,
          createInstance: materialInstanceCreation,
          assignToActor: materialAssignment,
        },
        animation: {
          available: materialAnimation,
          listClips: materialAnimation,
          graphParameters: materialAnimation,
          setGraphParameter: false,
          validateBindings: materialAnimation,
        },
        domainTools: {
          available: domainQueries,
          physicsQueries: domainQueries,
          navigationQueries: domainQueries,
          navigationBuild,
          lightingValidation: domainQueries,
          lightingBake,
          environmentProbeBake,
          terrainFoliageRead: domainQueries,
          // terrain.paint is a validated v31 stub (no verified managed write
          // path), so paint stays false even on v31 bridges; foliage instance
          // writes are real.
          terrainPaint: false,
          foliageInstanceWrite: terrainFoliageWrites,
        },
      },
      permissions: permissionSummary(ctx.permissionPolicy ?? {
        profile: 'full', allowTools: [], denyTools: [], emergencyReadOnly: false,
      }, classifiedToolNames()),
    };
    return toolResult(JSON.stringify(data, null, 2), { mode, data });
  } catch (error) {
    return toolError(error);
  }
}

const READY_EDITOR_STATES = new Set(['EditingSceneState', 'PlayingState']);
const READINESS_POLL_MS = 250;

/** Readiness fields of the bridge `status` RPC (bridge v34), normalised to camelCase. */
export interface EditorReadiness {
  editorState: string | null;
  isEditMode: boolean | null;
  isCompiling: boolean | null;
  scriptsReady: boolean | null;
  isImporting: boolean | null;
  lastCompileFailed: boolean | null;
  loadedSceneCount: number | null;
}

export interface EditorReadyObservation {
  /** Why the last poll was not ready, or 'ready'. */
  phase: 'ready' | 'reloading' | 'busy' | 'no_scene';
  detail: string;
  editor: EditorBridgeStatus | null;
  readiness: EditorReadiness | null;
}

export interface EditorReadyOptions {
  timeoutMs: number;
  requireScene: boolean;
  minBridgeVersion?: number;
}

export interface EditorReadyDeps {
  inspect: (ctx: ProjectMeta) => Promise<EditorBridgeStatus>;
  callStatus: (ctx: ProjectMeta, deadlineMs: number) => Promise<Record<string, unknown>>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultReadyDeps: EditorReadyDeps = {
  inspect: ctx => inspectEditorBridge(ctx),
  callStatus: async (ctx, deadlineMs) => {
    const response = await callEditorBridge(ctx, 'status', {}, { deadlineMs });
    return typeof response.data === 'object' && response.data !== null ? response.data as Record<string, unknown> : {};
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
};

function pick(record: Record<string, unknown>, name: string): unknown {
  return record[name] ?? record[name.charAt(0).toLowerCase() + name.slice(1)];
}
function pickBool(record: Record<string, unknown>, name: string): boolean | null {
  const value = pick(record, name);
  return typeof value === 'boolean' ? value : null;
}

export function readEditorReadiness(status: Record<string, unknown>): EditorReadiness {
  const state = pick(status, 'EditorState');
  const scenes = pick(status, 'LoadedSceneCount');
  return {
    editorState: typeof state === 'string' && state ? state : null,
    isEditMode: pickBool(status, 'IsEditMode'),
    isCompiling: pickBool(status, 'IsCompiling'),
    scriptsReady: pickBool(status, 'ScriptsReady'),
    isImporting: pickBool(status, 'IsImporting'),
    lastCompileFailed: pickBool(status, 'LastCompileFailed'),
    loadedSceneCount: typeof scenes === 'number' ? scenes : null,
  };
}

/** A missing or stale heartbeat, a changed token or an unanswered call is what a script reload looks like from outside. */
export function isReloadTransientError(error: unknown): boolean {
  if (!(error instanceof BridgeRpcError)) return false;
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED' || error.code === 'BRIDGE_TIMEOUT') return true;
  return error.code === 'BRIDGE_REMOTE_ERROR'
    && (error.details as { code?: unknown } | undefined)?.code === 'UNAUTHORIZED';
}

/** One readiness probe: heartbeat, then the `status` RPC. Transient reload errors become a 'reloading' observation. */
export async function observeEditorReadiness(
  ctx: ProjectMeta,
  options: Pick<EditorReadyOptions, 'requireScene' | 'minBridgeVersion'> & { deadlineMs: number },
  deps: EditorReadyDeps,
): Promise<EditorReadyObservation> {
  const editor = await deps.inspect(ctx);
  if (!editor.connected) {
    return { phase: 'reloading', detail: `Editor bridge heartbeat is not valid (${editor.reason}); the Editor may be starting, reloading scripts or restarting.`, editor, readiness: null };
  }
  let status: Record<string, unknown>;
  try {
    status = await deps.callStatus(ctx, options.deadlineMs);
  } catch (error) {
    if (!isReloadTransientError(error)) throw error;
    return { phase: 'reloading', detail: `Editor bridge did not answer status (${(error as BridgeRpcError).code}); it is probably reloading scripts.`, editor, readiness: null };
  }
  const reportedVersion = Number(pick(status, 'BridgeVersion') ?? editor.bridgeVersion);
  const readiness = readEditorReadiness(status);
  const live: EditorBridgeStatus = { ...editor, bridgeVersion: Number.isFinite(reportedVersion) ? String(reportedVersion) : editor.bridgeVersion };
  if (options.minBridgeVersion !== undefined && !(reportedVersion >= options.minBridgeVersion)) {
    return { phase: 'reloading', detail: `Bridge version ${live.bridgeVersion ?? 'unknown'} is below the required ${options.minBridgeVersion}; waiting for the Editor to load a newer bridge.`, editor: live, readiness };
  }
  if (pick(status, 'EditorReadinessSupported') !== true) {
    // A bridge older than v34 cannot report readiness: answering is all it can prove.
    if (options.requireScene) {
      throw new ToolDomainError('UNSUPPORTED_FLAX_VERSION', 'require_scene needs bridge v34 readiness fields; this bridge does not report LoadedSceneCount.', { bridgeVersion: live.bridgeVersion });
    }
    return { phase: 'ready', detail: 'Bridge answers status. It predates bridge v34, so compile/import/scene readiness is unknown.', editor: live, readiness };
  }
  if (readiness.isCompiling === true || readiness.scriptsReady === false) {
    return { phase: 'busy', detail: 'Scripts are compiling or reloading.', editor: live, readiness };
  }
  if (readiness.isImporting === true) return { phase: 'busy', detail: 'Content is importing.', editor: live, readiness };
  if (readiness.editorState !== null && !READY_EDITOR_STATES.has(readiness.editorState)) {
    return { phase: 'busy', detail: `Editor is in ${readiness.editorState} (waiting for EditingSceneState).`, editor: live, readiness };
  }
  if (options.requireScene && (readiness.loadedSceneCount ?? 0) < 1) {
    return { phase: 'no_scene', detail: 'No scene is loaded yet.', editor: live, readiness };
  }
  return { phase: 'ready', detail: 'Editor bridge is ready.', editor: live, readiness };
}

/** Polls until the Editor is ready or the timeout passes. The last observation is returned either way. */
export async function waitForEditorReady(
  ctx: ProjectMeta,
  options: EditorReadyOptions,
  deps: EditorReadyDeps = defaultReadyDeps,
): Promise<{ ready: boolean; observation: EditorReadyObservation; waitedMs: number }> {
  const startedAt = deps.now();
  const end = startedAt + options.timeoutMs;
  for (;;) {
    const remaining = end - deps.now();
    const observation = await observeEditorReadiness(ctx, {
      requireScene: options.requireScene,
      minBridgeVersion: options.minBridgeVersion,
      deadlineMs: Math.min(10_000, Math.max(250, remaining)),
    }, deps);
    reportProgress(`Waiting for the Editor: ${observation.detail}`, options.timeoutMs);
    if (observation.phase === 'ready') return { ready: true, observation, waitedMs: deps.now() - startedAt };
    if (deps.now() + READINESS_POLL_MS > end) return { ready: false, observation, waitedMs: deps.now() - startedAt };
    await deps.sleep(READINESS_POLL_MS);
  }
}

export async function handleEditorGetStatus(
  args: Partial<z.infer<typeof EditorGetStatusSchema>> | undefined,
  ctx: ProjectMeta,
  deps?: EditorReadyDeps,
): Promise<ToolResponse> {
  try {
    if (args?.wait_ready === true) {
      const identity = await readProjectIdentity(ctx);
      const timeoutMs = args.timeout_ms ?? 120_000;
      const waited = await waitForEditorReady(ctx, {
        timeoutMs,
        requireScene: args.require_scene === true,
        minBridgeVersion: args.min_bridge_version,
      }, deps);
      const editor = waited.observation.editor ?? await inspectEditorBridge(ctx);
      const mode: ToolMode = editor.connected ? 'editor-connected' : 'offline';
      const data = {
        mode,
        projectId: identity.id,
        ...editor,
        ready: waited.ready,
        waitedMs: waited.waitedMs,
        readiness: waited.observation.readiness,
        readinessPhase: waited.observation.phase,
        readinessDetail: waited.observation.detail,
      };
      if (!waited.ready) {
        return toolError(new ToolDomainError('TIMEOUT', `Editor was not ready within ${timeoutMs} ms: ${waited.observation.detail}`, data));
      }
      return toolResult(JSON.stringify(data, null, 2), { mode, data });
    }
    const [identity, editor] = await Promise.all([readProjectIdentity(ctx), inspectEditorBridge(ctx)]);
    const mode: ToolMode = editor.connected ? 'editor-connected' : 'offline';
    const data = {
      mode,
      projectId: identity.id,
      ...editor,
    };
    return toolResult(JSON.stringify(data, null, 2), { mode, data });
  } catch (error) {
    return toolError(error instanceof BridgeRpcError ? mapBridgeError(error) : error);
  }
}
