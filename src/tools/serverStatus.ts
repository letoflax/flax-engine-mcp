import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, safeReadFile } from '../projectContext.js';
import { toolError, toolResult, ToolMode, ToolResponse } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import { classifiedToolNames, permissionSummary } from '../permissions.js';
import { assetImportPolicyForContext } from '../assetImportPolicy.js';

export const GetServerCapabilitiesSchema = z.object({});
export const EditorGetStatusSchema = z.object({});

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

export async function inspectEditorBridge(
  ctx: ProjectMeta,
  now = Date.now(),
  processAlive: (pid: number) => boolean = isProcessAlive
): Promise<EditorBridgeStatus> {
  const heartbeatPath = path.join(ctx.projectPath, 'Cache', 'MCP', 'bridge.json');
  const raw = await safeReadFile(heartbeatPath);
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
  const pathMatches = heartbeatProjectPath !== null &&
    normalizeProjectPath(heartbeatProjectPath) === normalizeProjectPath(ctx.projectPath);
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

export async function handleGetServerCapabilities(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const [identity, editor] = await Promise.all([readProjectIdentity(ctx), inspectEditorBridge(ctx)]);
    const mode: ToolMode = editor.connected ? 'editor-connected' : 'offline';
    const phase2 = editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 6;
    const phase3 = editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 7;
    const phase4Assets = editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 8;
    const phase5AssetImport = editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 9;
    const phase6AssetOrganization = editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 10;
    const operationHandles = editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 11;
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
        runtimeInspection: phase2,
        sceneRevisions: phase3,
        editLeases: phase3,
        idempotentEditorWrites: phase3,
        safeActorSurface: phase3,
        arbitraryActorProperties: false,
        scriptInstanceEnabledPatch: editor.connected && editor.protocolVersion === '1' && Number(editor.bridgeVersion) >= 5,
        arbitrarySerializedScriptProperties: false,
        assetSearch: phase4Assets,
        assetRegistryMetadata: phase4Assets,
        assetDependencyGraph: phase4Assets,
        assetReverseReferences: phase4Assets,
        assetImportSettings: false,
        assetReferenceLocations: false,
        assetImport: {
          available: phase5AssetImport,
          enabled: phase5AssetImport && assetImportPolicy.roots.length > 0,
          configuredRootCount: assetImportPolicy.roots.length,
          maxSourceBytes: assetImportPolicy.maxSourceBytes,
          allowedExtensionCount: assetImportPolicy.extensions.length,
          settings: false,
        },
        assetOrganization: {
          available: phase6AssetOrganization,
          move: phase6AssetOrganization,
          rename: phase6AssetOrganization,
          duplicate: phase6AssetOrganization,
          undo: false,
          editLeases: false,
          referenceImpact: phase6AssetOrganization,
        },
        operationHandles,
        operationProgress: operationHandles,
        operationCancel: operationHandles,
        mcpTasks: false,
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

export async function handleEditorGetStatus(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const [identity, editor] = await Promise.all([readProjectIdentity(ctx), inspectEditorBridge(ctx)]);
    const mode: ToolMode = editor.connected ? 'editor-connected' : 'offline';
    const data = {
      mode,
      projectId: identity.id,
      ...editor,
    };
    return toolResult(JSON.stringify(data, null, 2), { mode, data });
  } catch (error) {
    return toolError(error);
  }
}
