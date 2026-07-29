import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { callEditorBridge } from './bridge/fileRpcClient.js';
import { ProjectMeta, safeReadFile, walkDir } from './projectContext.js';
import { inspectEditorBridge, readProjectIdentity } from './tools/serverStatus.js';

const CaptureId = /^[0-9a-f]{32}$/i;
const FlaxId = /^[0-9a-f]{32}$/i;
const MaxCaptureBytes = 16 * 1024 * 1024;
const MaxJsonBytes = 256 * 1024;
const MaxListedCaptures = 64;
const MaxResourcePage = 16;
const CaptureTtlMs = 24 * 60 * 60 * 1000;
const CursorTtlMs = 10 * 60 * 1000;
const MaxCursors = 128;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Resource = {
  uri: string; name: string; description: string; mimeType: string;
  size?: number; annotations: { audience: ('user' | 'assistant')[]; priority: number; lastModified: string };
};
interface Cursor { created: number; snapshot: string; offset: number; }
const cursors = new Map<string, Cursor>();

function captureDirectory(ctx: ProjectMeta): string { return path.join(ctx.projectPath, 'Cache', 'MCP', 'captures'); }
function nowIso(): string { return new Date().toISOString(); }

function invalid(message: string): McpError { return new McpError(ErrorCode.InvalidParams, message); }
function internal(message: string): McpError { return new McpError(ErrorCode.InternalError, message); }

/** Reject URL normalization, query strings, encoded separators, credentials, and non-canonical forms. */
function parseUri(uri: string): { host: string; path: string[] } {
  if (typeof uri !== 'string' || uri.length > 512 || /[%\\?#]/.test(uri)) throw invalid('Flax resource URI must not contain encoded, query, fragment, or backslash characters.');
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw invalid('Invalid Flax resource URI.'); }
  if (parsed.protocol !== 'flax:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !parsed.hostname || parsed.pathname.includes('//')) throw invalid('Invalid Flax resource URI.');
  const pieces = parsed.pathname.split('/').filter(Boolean);
  if (pieces.some(piece => piece === '.' || piece === '..') || uri !== `flax://${parsed.hostname}/${pieces.join('/')}`) {
    throw invalid('Flax resource URI must use a canonical project-local path.');
  }
  return { host: parsed.hostname, path: pieces };
}

async function canonicalCaptureDirectory(ctx: ProjectMeta): Promise<string> {
  const project = await fs.realpath(ctx.projectPath);
  const expected = path.resolve(captureDirectory(ctx));
  const directory = await fs.realpath(expected);
  const relative = path.relative(project, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || directory.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
    throw invalid('Capture cache must be a real directory inside the project.');
  }
  return directory;
}

async function confinedCaptureFile(directory: string, id: string): Promise<{ file: string; stat: Awaited<ReturnType<typeof fs.stat>> }> {
  const lexical = path.join(directory, `${id}.png`);
  const linkStat = await fs.lstat(lexical);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw invalid('Capture resource must be a regular project-local file.');
  const file = await fs.realpath(lexical);
  const relative = path.relative(directory, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw invalid('Capture resource escapes the project cache.');
  return { file, stat: await fs.stat(file) };
}

function numericStat(stat: Awaited<ReturnType<typeof fs.stat>>): { size: number; mtimeMs: number } {
  return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
}

function scrub(value: unknown, ctx: ProjectMeta, depth = 0): Json {
  if (depth > 12) return '<truncated-depth>';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const root = path.resolve(ctx.projectPath).replaceAll('\\', '/').toLowerCase();
    let text = value.replaceAll('\\', '/');
    if (text.toLowerCase().includes(root)) text = '<project>' + text.slice(text.toLowerCase().indexOf(root) + root.length);
    // Bridge diagnostics/logs may contain unrelated host paths. Do not place those in MCP context.
    text = text.replace(/[A-Za-z]:\/(?:[^\\/:*?"<>|\s]+\/)*[^\\/:*?"<>|\s]+/g, '<redacted-path>');
    text = text.replace(/(^|[\s("'=:])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, '$1<redacted-path>');
    return text.length > 8192 ? `${text.slice(0, 8192)}…` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map(item => scrub(item, ctx, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 500)
      .map(([key, item]) => [key.slice(0, 128), scrub(item, ctx, depth + 1)]));
  }
  return String(value);
}

function jsonText(value: unknown, ctx: ProjectMeta): string {
  const safe = scrub(value, ctx);
  let text = JSON.stringify(safe, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= MaxJsonBytes) return text;
  // A resource reader never emits a partial JSON token. The bounded summary is deliberate.
  text = JSON.stringify({ truncated: true, reason: 'Resource payload exceeded the 256 KiB quota. Use the corresponding tool for filtered/paginated data.' }, null, 2);
  return text;
}

async function captureResources(ctx: ProjectMeta): Promise<Resource[]> {
  let directory: string;
  let names: string[];
  try { directory = await canonicalCaptureDirectory(ctx); names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const candidates = await Promise.all(names
    .filter(name => CaptureId.test(path.basename(name, '.png')) && path.extname(name).toLowerCase() === '.png')
    .map(async name => {
      const id = path.basename(name, '.png');
      try {
        const { stat } = await confinedCaptureFile(directory, id);
        const numeric = numericStat(stat);
        if (numeric.size <= 0 || numeric.size > MaxCaptureBytes || Date.now() - numeric.mtimeMs > CaptureTtlMs) return null;
        return { id, stat, ...numeric };
      } catch { return null; }
    }));
  return candidates.filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MaxListedCaptures).map(({ id, stat }) => ({
      uri: `flax://capture/${id}`, name: `Flax viewport capture ${id}`,
      description: 'Temporary game-viewport PNG; expires automatically.', mimeType: 'image/png', size: Number(stat.size),
      annotations: { audience: ['user', 'assistant'], priority: 0.7, lastModified: stat.mtime.toISOString() },
    }));
}

async function fixedResources(ctx: ProjectMeta): Promise<Resource[]> {
  const mtime = (await fs.stat(ctx.flaxprojPath)).mtime.toISOString();
  const make = (uri: string, name: string, description: string, priority = 0.5): Resource => ({
    uri, name, description, mimeType: 'application/json', annotations: { audience: ['assistant'], priority, lastModified: mtime },
  });
  return [
    make('flax://project/info', 'Flax project information', 'Bounded public project identity and configuration.', 0.9),
    make('flax://project/summary', 'Flax project summary', 'Bounded project inventory summary.', 0.7),
    make('flax://project/settings', 'Flax game settings', 'Public GameSettings JSON.', 0.7),
    make('flax://editor/status', 'Flax Editor status', 'Connected Editor Bridge status.', 0.9),
    make('flax://scene/loaded', 'Loaded Flax scenes', 'Scenes currently loaded in the Editor.', 0.8),
    make('flax://code/diagnostics/latest', 'Latest code diagnostics', 'Bounded current compiler diagnostics.', 0.8),
    make('flax://logs/recent', 'Recent Flax logs', 'Bounded redacted Editor log tail.', 0.5),
    make('flax://build/status', 'Build status', 'Current script compilation status.', 0.6),
    make('flax://audit/recent', 'Recent MCP audit entries', 'Bounded redacted script mutation audit history.', 0.6),
  ];
}

function snapshotOf(resources: Resource[]): string {
  return createHash('sha256').update(resources.map(resource => `${resource.uri}:${resource.annotations.lastModified}`).join('\n')).digest('base64url');
}
function pruneCursors(): void {
  const threshold = Date.now() - CursorTtlMs;
  for (const [token, cursor] of cursors) if (cursor.created < threshold) cursors.delete(token);
  while (cursors.size >= MaxCursors) cursors.delete(cursors.keys().next().value as string);
}

/** Listed resources are bounded and use server-held opaque cursors to prevent forged offsets. */
export async function listFlaxResources(ctx: ProjectMeta, cursor?: string): Promise<{ resources: Resource[]; nextCursor?: string }> {
  const resources = [...await fixedResources(ctx), ...await captureResources(ctx)].sort((a, b) => a.uri.localeCompare(b.uri));
  const snapshot = snapshotOf(resources);
  let offset = 0;
  if (cursor) {
    const existing = cursors.get(cursor);
    if (!existing || existing.created < Date.now() - CursorTtlMs || existing.snapshot !== snapshot) {
      cursors.delete(cursor); throw invalid('Resource cursor is invalid, expired, or stale.');
    }
    offset = existing.offset;
  }
  const page = resources.slice(offset, offset + MaxResourcePage);
  const nextOffset = offset + page.length;
  if (nextOffset >= resources.length) return { resources: page };
  pruneCursors();
  const token = randomUUID();
  cursors.set(token, { created: Date.now(), snapshot, offset: nextOffset });
  return { resources: page, nextCursor: token };
}

export async function listFlaxResourceTemplates(ctx: ProjectMeta) {
  const bridge = await inspectEditorBridge(ctx);
  const available = bridge.connected && bridge.protocolVersion === '1' ? Number(bridge.bridgeVersion) : 0;
  const annotations = { audience: ['assistant'] as ('assistant')[], priority: 0.7, lastModified: nowIso() };
  const templates = [] as Array<{ uriTemplate: string; name: string; description: string; mimeType: string; annotations: typeof annotations }>;
  if (available >= 5) {
    templates.push(
      { uriTemplate: 'flax://scene/{sceneId}/tree', name: 'Flax scene tree', description: 'Live tree for a 32-character loaded scene GUID.', mimeType: 'application/json', annotations },
      { uriTemplate: 'flax://actor/{actorId}', name: 'Flax actor snapshot', description: 'Live snapshot for a 32-character actor GUID.', mimeType: 'application/json', annotations },
    );
  }
  if (available >= 8) templates.push(
    { uriTemplate: 'flax://asset/{assetId}', name: 'Flax asset metadata', description: 'Live asset metadata for a 32-character asset GUID.', mimeType: 'application/json', annotations },
    { uriTemplate: 'flax://asset/{assetId}/dependencies', name: 'Flax asset dependencies', description: 'Bounded direct dependency edges for an asset GUID.', mimeType: 'application/json', annotations },
  );
  return { resourceTemplates: templates };
}

async function projectInfo(ctx: ProjectMeta): Promise<Json> {
  const raw = await safeReadFile(ctx.flaxprojPath);
  if (!raw) throw internal('Project configuration is unavailable.');
  const project = JSON.parse(raw) as Record<string, unknown>;
  const identity = await readProjectIdentity(ctx);
  return { name: identity.name, version: identity.version, id: identity.id, minEngineVersion: identity.minEngineVersion,
    defaultScene: typeof project.DefaultScene === 'string' ? project.DefaultScene : null,
    gameTarget: typeof project.GameTarget === 'string' ? project.GameTarget : null,
    editorTarget: typeof project.EditorTarget === 'string' ? project.EditorTarget : null };
}
async function projectSummary(ctx: ProjectMeta): Promise<Json> {
  const [scripts, scenes, assets, settings] = await Promise.all([
    walkDir(ctx.sourceDir, ['.cs']), walkDir(ctx.contentDir, ['.scene']), walkDir(ctx.contentDir, []), fs.readdir(ctx.settingsDir).catch(() => [] as string[]),
  ]);
  return { project: ctx.projectName, counts: { scripts: scripts.length, scenes: scenes.length, assets: assets.length, settings: settings.filter(item => item.endsWith('.json')).length },
    limits: { resourceJsonBytes: MaxJsonBytes, note: 'Use dedicated tools for detailed inventories.' } };
}
async function gameSettings(ctx: ProjectMeta): Promise<Json> {
  const raw = await safeReadFile(path.join(ctx.contentDir, 'GameSettings.json'));
  return raw ? JSON.parse(raw) as Json : { available: false };
}
async function auditRecent(ctx: ProjectMeta): Promise<Json> {
  const raw = await safeReadFile(path.join(ctx.projectPath, '.flax-mcp', 'audit.jsonl')) ?? '';
  const entries = raw.split('\n').filter(Boolean).slice(-25).flatMap(line => {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      return [{ timestamp: String(row.timestamp ?? ''), operation: row.operation === 'apply_script_patch' ? 'apply_script_patch' : 'write_script',
        target: typeof row.target === 'string' ? row.target : '', dry_run: row.dry_run === true, success: row.success === true }];
    } catch { return []; }
  }).reverse();
  return { entries, redacted_fields: ['content', 'patch', 'request'] };
}
async function bridgeData(ctx: ProjectMeta, method: string, params: Record<string, unknown>, minimumBridgeVersion?: number): Promise<Json> {
  try {
    const response = await callEditorBridge(ctx, method as never, params, minimumBridgeVersion ? { minimumBridgeVersion } : undefined);
    return { data: response.data as Json, bridge: response.bridge as unknown as Json, warnings: response.warnings };
  } catch (error) { throw internal(`Live resource is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Read fixed and capability-backed template resources. No URI accepts a query or caller-selected filesystem path. */
export async function readFlaxResource(uri: string, ctx: ProjectMeta): Promise<any> {
  const parsed = parseUri(uri);
  if (parsed.host === 'capture' && parsed.path.length === 1 && CaptureId.test(parsed.path[0])) return readCapture(parsed.path[0], ctx);
  let data: Json;
  if (parsed.host === 'project' && parsed.path.length === 1 && parsed.path[0] === 'info') data = await projectInfo(ctx);
  else if (parsed.host === 'project' && parsed.path.length === 1 && parsed.path[0] === 'summary') data = await projectSummary(ctx);
  else if (parsed.host === 'project' && parsed.path.length === 1 && parsed.path[0] === 'settings') data = await gameSettings(ctx);
  else if (parsed.host === 'editor' && parsed.path.length === 1 && parsed.path[0] === 'status') data = await inspectEditorBridge(ctx) as unknown as Json;
  else if (parsed.host === 'scene' && parsed.path.length === 1 && parsed.path[0] === 'loaded') data = await bridgeData(ctx, 'scene.list_loaded', {});
  else if (parsed.host === 'scene' && parsed.path.length === 2 && FlaxId.test(parsed.path[0]) && parsed.path[1] === 'tree') data = await bridgeData(ctx, 'scene.get_tree', { SceneId: parsed.path[0] });
  else if (parsed.host === 'actor' && parsed.path.length === 1 && FlaxId.test(parsed.path[0])) data = await bridgeData(ctx, 'actor.get', { ActorId: parsed.path[0] });
  else if (parsed.host === 'asset' && parsed.path.length === 1 && FlaxId.test(parsed.path[0])) data = await bridgeData(ctx, 'asset.get', { AssetId: parsed.path[0] }, 8);
  else if (parsed.host === 'asset' && parsed.path.length === 2 && FlaxId.test(parsed.path[0]) && parsed.path[1] === 'dependencies') data = await bridgeData(ctx, 'asset.dependencies', { AssetId: parsed.path[0], Limit: 100, Transitive: false }, 8);
  else if (parsed.host === 'code' && parsed.path.length === 2 && parsed.path[0] === 'diagnostics' && parsed.path[1] === 'latest') data = await bridgeData(ctx, 'code.diagnostics', { MaxResults: 100, Severities: ['error', 'warning'] }, 6);
  else if (parsed.host === 'logs' && parsed.path.length === 1 && parsed.path[0] === 'recent') data = await bridgeData(ctx, 'log.query', { Tail: true, Limit: 100, SinceSequence: 0 }, 6);
  else if (parsed.host === 'build' && parsed.path.length === 1 && parsed.path[0] === 'status') data = await bridgeData(ctx, 'code.status', {}, 6);
  else if (parsed.host === 'audit' && parsed.path.length === 1 && parsed.path[0] === 'recent') data = await auditRecent(ctx);
  else throw invalid('Unknown or unsupported Flax resource URI.');
  return { contents: [{ uri, mimeType: 'application/json', text: jsonText(data, ctx) }] };
}

async function readCapture(id: string, ctx: ProjectMeta) {
  let confined: { file: string; stat: Awaited<ReturnType<typeof fs.stat>> };
  try { confined = await confinedCaptureFile(await canonicalCaptureDirectory(ctx), id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw invalid('Capture resource was not found or has expired.'); throw error; }
  const { file, stat } = confined;
  const numeric = numericStat(stat);
  if (numeric.size <= 0 || numeric.size > MaxCaptureBytes || Date.now() - numeric.mtimeMs > CaptureTtlMs) throw invalid('Capture resource is empty, too large, or expired.');
  const handle = await fs.open(file, 'r');
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || Number(opened.size) !== numeric.size || Number(opened.size) > MaxCaptureBytes) throw invalid('Capture resource changed while being opened.');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid('Capture resource is not a valid PNG file.');
  return { contents: [{ uri: `flax://capture/${id}`, mimeType: 'image/png', blob: bytes.toString('base64') }] };
}

/** Only these resource forms are subscription-safe; captures and project files use resources/list_changed instead. */
export function isSubscribableFlaxResource(uri: string): boolean {
  try {
    const parsed = parseUri(uri);
    return (parsed.host === 'editor' && parsed.path.join('/') === 'status')
      || (parsed.host === 'code' && parsed.path.join('/') === 'diagnostics/latest')
      || (parsed.host === 'logs' && parsed.path.join('/') === 'recent')
      || (parsed.host === 'scene' && parsed.path.length === 2 && FlaxId.test(parsed.path[0]) && parsed.path[1] === 'tree');
  } catch { return false; }
}
