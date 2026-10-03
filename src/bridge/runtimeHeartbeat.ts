import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectMeta } from '../projectContext.js';
import { BRIDGE_HEARTBEAT_MAX_AGE_MS, isProcessAlive } from '../tools/serverStatus.js';
import {
  BRIDGE_HEARTBEAT_FILE,
  BRIDGE_TOKEN_FILE,
  BridgeRpcError,
  RUNTIME_BRIDGE_CACHE_DIRECTORY,
  RUNTIME_INSTANCE_NAME_PATTERN,
} from './protocol.js';

/** Minimum bridge version a runtime (game) bridge reports. */
export const RUNTIME_BRIDGE_MIN_VERSION = 35;

const HEARTBEAT_MAX_FUTURE_SKEW_MS = 5_000;
const HEARTBEAT_MAX_BYTES = 64 * 1024;
const HEARTBEAT_READ_RETRIES = 3;
const HEARTBEAT_READ_RETRY_MS = 40;

export type RuntimeBridgeReason =
  | 'connected'
  | 'heartbeat_missing'
  | 'heartbeat_invalid'
  | 'wrong_kind'
  | 'instance_mismatch'
  | 'process_not_running'
  | 'heartbeat_stale';

/** What the heartbeat of one runtime instance says. Never carries a filesystem path. */
export interface RuntimeBridgeStatus {
  connected: boolean;
  reason: RuntimeBridgeReason;
  instance: string;
  pid: number | null;
  heartbeatAgeMs: number | null;
  bridgeVersion: string | null;
  protocolVersion: string | null;
  productName: string | null;
  engineVersion: string | null;
}

export function isValidRuntimeInstanceName(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_INSTANCE_NAME_PATTERN.test(value);
}

/** Throws for any name that could leave Cache/MCP-Runtime (separators, dots, empty, too long). */
export function assertRuntimeInstanceName(value: unknown): string {
  if (!isValidRuntimeInstanceName(value)) {
    throw new BridgeRpcError('BRIDGE_PROTOCOL_ERROR', 'Runtime instance names use only letters, digits, "_" and "-" (1-64 characters).');
  }
  return value;
}

/** <project>/Cache/MCP-Runtime */
export function runtimeInstancesRoot(ctx: ProjectMeta): string {
  return path.join(ctx.projectPath, ...RUNTIME_BRIDGE_CACHE_DIRECTORY.split('/'));
}

/** <project>/Cache/MCP-Runtime/<instance>; internal use only, never returned to tools. */
export function runtimeInstanceDirectory(ctx: ProjectMeta, instance: string): string {
  return path.join(runtimeInstancesRoot(ctx), assertRuntimeInstanceName(instance));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
}

function versionValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function emptyStatus(instance: string, reason: RuntimeBridgeReason): RuntimeBridgeStatus {
  return { connected: false, reason, instance, pid: null, heartbeatAgeMs: null, bridgeVersion: null, protocolVersion: null, productName: null, engineVersion: null };
}

async function readBounded(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > HEARTBEAT_MAX_BYTES) return '';
    return await handle.readFile({ encoding: 'utf8' });
  } finally { await handle.close(); }
}

/** bridge.json is replaced every two seconds; while the token exists a missing file is a replace window and is retried. */
async function readHeartbeat(directory: string): Promise<string | null> {
  const heartbeatPath = path.join(directory, BRIDGE_HEARTBEAT_FILE);
  let raw = await readBounded(heartbeatPath);
  if (raw !== null) return raw;
  const tokenPath = path.join(directory, BRIDGE_TOKEN_FILE);
  for (let attempt = 0; attempt < HEARTBEAT_READ_RETRIES; attempt += 1) {
    if (!(await fs.stat(tokenPath).then(() => true, () => false))) return null;
    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_READ_RETRY_MS));
    raw = await readBounded(heartbeatPath);
    if (raw !== null) return raw;
  }
  return null;
}

/**
 * Validates the heartbeat of one runtime instance: Kind "game", a matching
 * instance name, a live PID and a fresh timestamp (at most 30 s old). The
 * bridge version and protocol are reported, and enforced by the RPC client.
 */
export async function inspectRuntimeBridge(
  ctx: ProjectMeta,
  instance: string,
  now = Date.now(),
  processAlive: (pid: number) => boolean = isProcessAlive,
): Promise<RuntimeBridgeStatus> {
  const name = assertRuntimeInstanceName(instance);
  const raw = await readHeartbeat(runtimeInstanceDirectory(ctx, name));
  if (raw === null) return emptyStatus(name, 'heartbeat_missing');

  let heartbeat: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyStatus(name, 'heartbeat_invalid');
    heartbeat = parsed as Record<string, unknown>;
  } catch {
    return emptyStatus(name, 'heartbeat_invalid');
  }
  const rawPid = heartbeat.Pid ?? heartbeat.pid;
  const pid = typeof rawPid === 'number' ? rawPid : Number(rawPid);
  const rawTime = heartbeat.Timestamp ?? heartbeat.timestamp;
  const timestamp = typeof rawTime === 'number' ? rawTime : Number(rawTime);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) return emptyStatus(name, 'heartbeat_invalid');

  const age = Math.max(0, now - timestamp);
  const status: RuntimeBridgeStatus = {
    connected: false,
    reason: 'heartbeat_invalid',
    instance: name,
    pid,
    heartbeatAgeMs: age,
    bridgeVersion: versionValue(heartbeat.BridgeVersion ?? heartbeat.bridgeVersion),
    protocolVersion: versionValue(heartbeat.ProtocolVersion ?? heartbeat.protocolVersion),
    productName: stringValue(heartbeat.ProductName ?? heartbeat.productName),
    engineVersion: stringValue(heartbeat.EngineVersion ?? heartbeat.engineVersion),
  };
  if ((heartbeat.Kind ?? heartbeat.kind) !== 'game') return { ...status, reason: 'wrong_kind' };
  const reportedInstance = heartbeat.Instance ?? heartbeat.instance;
  if (reportedInstance !== undefined && reportedInstance !== null && String(reportedInstance) !== name) return { ...status, reason: 'instance_mismatch' };
  if (!processAlive(pid)) return { ...status, reason: 'process_not_running' };
  if (timestamp - now > HEARTBEAT_MAX_FUTURE_SKEW_MS) return { ...status, reason: 'heartbeat_invalid' };
  if (age > BRIDGE_HEARTBEAT_MAX_AGE_MS) return { ...status, reason: 'heartbeat_stale' };
  return { ...status, connected: true, reason: 'connected' };
}

/** Instance directories under Cache/MCP-Runtime that hold a heartbeat file, sorted by name. */
export async function listRuntimeBridges(
  ctx: ProjectMeta,
  now = Date.now(),
  processAlive: (pid: number) => boolean = isProcessAlive,
): Promise<RuntimeBridgeStatus[]> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(runtimeInstancesRoot(ctx), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const names = entries
    .filter(entry => entry.isDirectory() && isValidRuntimeInstanceName(entry.name))
    .map(entry => entry.name)
    .sort();
  const statuses = await Promise.all(names.map(name => inspectRuntimeBridge(ctx, name, now, processAlive)));
  return statuses.filter(status => status.reason !== 'heartbeat_missing');
}
