import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createAssetImportPolicy, chooseAssetImportDestination, verifyAssetImportDestination, verifyAssetImportSource } from '../assetImportPolicy.js';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { handleGetServerCapabilities } from './serverStatus.js';
import { handleReimportAsset, ReimportAssetSchema } from './assetInfo.js';
import {
  AssetGetImportSettingsSchema,
  AssetImportSchema,
  AssetOperationStatusSchema,
  AssetReimportSchema,
  AssetSetImportSettingsSchema,
  handleAssetGetImportSettings,
  handleAssetImport,
  handleAssetImportStatus,
  handleAssetReimport,
  handleAssetReimportStatus,
  handleAssetSetImportSettings,
} from './assetImport.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ASSET_ID = 'a'.repeat(32);

interface Fixture {
  root: string;
  sourceRoot: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup(): Promise<void>;
}

async function fixture(bridgeVersion = 9): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-asset-import-'));
  const sourceRoot = path.join(root, 'approved-source');
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([
    fs.mkdir(path.join(root, 'Content', 'Imported'), { recursive: true }),
    fs.mkdir(path.join(root, 'Source'), { recursive: true }),
    fs.mkdir(path.join(root, 'Logs'), { recursive: true }),
    fs.mkdir(sourceRoot, { recursive: true }),
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' })),
    fs.writeFile(path.join(root, 'Content', 'Existing.flax'), Buffer.from('CFWF')),
    fs.writeFile(path.join(sourceRoot, 'texture.png'), Buffer.from([1, 2, 3])),
    fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
      Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1,
    })),
    fs.writeFile(path.join(cache, 'token'), TOKEN),
  ]);
  const ctx = await createProjectContext(root);
  ctx.assetImportPolicy = await createAssetImportPolicy(['node', 'server', '--asset-import-root', sourceRoot]);
  return { root, sourceRoot, ctx, requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    const name = (await fs.readdir(f.requests)).find(value => value.endsWith('.json'));
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for asset import RPC request.');
}

async function reply(f: Fixture, request: { name: string; body: Record<string, unknown> }, body: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(f.responses, request.name), JSON.stringify({
    id: request.body.id,
    token: TOKEN,
    timestamp: Date.now(),
    ...body,
  }));
}

async function requestGone(f: Fixture, name: string): Promise<void> {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    if (!(await fs.readdir(f.requests)).includes(name)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for client request cleanup.');
}

function envelope(result: Awaited<ReturnType<typeof handleAssetImport>>): Record<string, any> {
  return result.structuredContent as Record<string, any>;
}

test('asset import root CLI canonicalizes repeated roots and fails closed without roots', async () => {
  const f = await fixture();
  try {
    const policy = await createAssetImportPolicy(['node', 'server', '--asset-import-root', f.sourceRoot, '--asset-import-root', f.sourceRoot]);
    assert.equal(policy.roots.length, 1);
    assert.equal(policy.roots[0], await fs.realpath(f.sourceRoot));
    await assert.rejects(() => verifyAssetImportSource(path.join(f.sourceRoot, 'texture.png'), { ...policy, roots: [] }), (error: any) => error.code === 'IMPORT_SOURCE_NOT_ALLOWED');
    await assert.rejects(() => createAssetImportPolicy(['node', 'server', '--asset-import-root']), /requires an existing directory/);
  } finally { await f.cleanup(); }
});

test('asset source/destination policy rejects traversal, extensions, size, collisions, and symlink escapes', async t => {
  const f = await fixture();
  try {
    const policy = f.ctx.assetImportPolicy!;
    await assert.rejects(() => verifyAssetImportSource(path.join(f.sourceRoot, 'unknown.txt'), policy), (error: any) => error.code === 'IMPORT_SOURCE_NOT_ALLOWED');
    await fs.writeFile(path.join(f.sourceRoot, 'unknown.txt'), 'x');
    await assert.rejects(() => verifyAssetImportSource(path.join(f.sourceRoot, 'unknown.txt'), policy), (error: any) => error.code === 'IMPORT_SOURCE_NOT_ALLOWED');
    await fs.writeFile(path.join(f.sourceRoot, 'big.png'), Buffer.alloc(policy.maxSourceBytes + 1));
    await assert.rejects(() => verifyAssetImportSource(path.join(f.sourceRoot, 'big.png'), policy), (error: any) => error.code === 'IMPORT_SOURCE_NOT_ALLOWED');
    await assert.rejects(() => verifyAssetImportDestination('Content/../escape.flax', f.ctx), /without traversal/);
    await assert.rejects(() => verifyAssetImportDestination('C:/escape.flax', f.ctx), /under Content/);
    const destination = await verifyAssetImportDestination('Content/Existing.flax', f.ctx);
    await assert.rejects(() => chooseAssetImportDestination(destination, 'error'), (error: any) => error.code === 'FILE_EXISTS');
    assert.match((await chooseAssetImportDestination(destination, 'rename')).relativePath, /Existing-1\.flax$/);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-import-outside-'));
    const link = path.join(f.sourceRoot, 'escape-link');
    try {
      await fs.writeFile(path.join(outside, 'outside.png'), Buffer.from([1]));
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('The current test environment cannot create a directory symlink/junction.');
      return;
    }
    try {
      await assert.rejects(() => verifyAssetImportSource(path.join(link, 'outside.png'), policy), (error: any) => error.code === 'IMPORT_SOURCE_NOT_ALLOWED');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  } finally { await f.cleanup(); }
});

test('asset_import maps to a strict PascalCase v9 RPC and supports dry-run/collision rename', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Existing.flax', collision_policy: 'rename', dry_run: true,
      operation_id: 'b'.repeat(32), idempotency_key: 'asset-import-test',
    }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.import_start');
    const params = JSON.parse(String(request.body.paramsJson));
    assert.deepEqual(Object.keys(params).sort(), ['AllowedImportRoots', 'CollisionPolicy', 'DestinationPath', 'DryRun', 'IdempotencyKey', 'MaxSourceBytes', 'OperationId', 'SourceLastWriteUnixMs', 'SourcePath', 'SourceSizeBytes'].sort());
    assert.equal(params.OperationId, 'b'.repeat(32));
    assert.equal(params.DestinationPath, 'Content/Existing-1.flax');
    assert.equal(params.DryRun, true);
    assert.equal(params.CollisionPolicy, 'rename');
    await reply(f, request, { ok: true, resultJson: JSON.stringify({ OperationId: 'b'.repeat(32), Kind: 'import', Phase: 'dry_run', Progress: 1, ResultPath: 'Content/Existing-1.flax', DryRun: true }) });
    const result = await pending;
    assert.equal(envelope(result).ok, true);
    assert.equal(envelope(result).data.operation.Phase, 'dry_run');
    assert.doesNotMatch(JSON.stringify(envelope(result).data), /approved-source|SourcePath/);
    // The rename was decided by the Node side (the bridge only saw a free name), so the result must say so.
    assert.deepEqual(envelope(result).data.destination, { path: 'Content/Existing-1.flax', requested: 'Content/Existing.flax', renamed: true });
    assert.equal(envelope(result).data.operation.Renamed, true);
  } finally { await f.cleanup(); }
});

test('asset operation status/polling maps statuses, adoption responses, and stable errors', async () => {
  const f = await fixture();
  try {
    const importPending = handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/Texture.flax', operation_id: 'c'.repeat(32), wait: true, timeout_ms: 1_000,
    }), f.ctx);
    const start = await nextRequest(f);
    await reply(f, start, { ok: true, resultJson: JSON.stringify({ OperationId: 'c'.repeat(32), Kind: 'import', Phase: 'requested', Progress: 0 }) });
    await requestGone(f, start.name);
    const poll = await nextRequest(f);
    assert.equal(poll.body.method, 'asset.import_status');
    assert.deepEqual(JSON.parse(String(poll.body.paramsJson)), { OperationId: 'c'.repeat(32) });
    await reply(f, poll, { ok: true, resultJson: JSON.stringify({ OperationId: 'c'.repeat(32), Kind: 'import', Phase: 'succeeded', Progress: 1, ResultPath: 'Content/Imported/Texture.flax' }) });
    assert.equal(envelope(await importPending).data.operation.Phase, 'succeeded');

    const statusPending = handleAssetReimportStatus(AssetOperationStatusSchema.parse({ operation_id: 'd'.repeat(32) }), f.ctx);
    const status = await nextRequest(f);
    assert.equal(status.body.method, 'asset.reimport_status');
    await reply(f, status, { ok: false, errorCode: 'OPERATION_NOT_FOUND', error: 'Operation expired.' });
    const missing = await statusPending;
    assert.equal((missing.structuredContent as Record<string, any>).error.code, 'OPERATION_NOT_FOUND');

    const importStatusPending = handleAssetImportStatus(AssetOperationStatusSchema.parse({ operation_id: 'e'.repeat(32) }), f.ctx);
    const importStatus = await nextRequest(f);
    await reply(f, importStatus, { ok: false, errorCode: 'OPERATION_NOT_FOUND', error: 'Operation expired.' });
    assert.equal((await importStatusPending).isError, true);

    const adopted = handleAssetReimport(AssetReimportSchema.parse({ path: 'Content/Existing.flax', operation_id: 'f'.repeat(32), idempotency_key: 'reuse' }), f.ctx);
    const adoptRequest = await nextRequest(f);
    assert.equal(adoptRequest.body.method, 'asset.reimport_start');
    await reply(f, adoptRequest, { ok: true, resultJson: JSON.stringify({ OperationId: 'f'.repeat(32), Kind: 'reimport', Phase: 'succeeded', Progress: 1, ResultPath: 'Content/Existing.flax' }) });
    assert.equal(envelope(await adopted).data.operation.OperationId, 'f'.repeat(32));
  } finally { await f.cleanup(); }
});

test('v9 gating, capability reporting, and reimport compatibility alias never launch an editor process', async () => {
  const old = await fixture(8);
  try {
    const denied = await handleAssetImport(AssetImportSchema.parse({ source_path: path.join(old.sourceRoot, 'texture.png'), destination: 'Content/New.flax' }), old.ctx);
    assert.equal((denied.structuredContent as Record<string, any>).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
    const capabilities = await handleGetServerCapabilities({}, old.ctx);
    const data = (capabilities.structuredContent as Record<string, any>).data;
    assert.equal(data.features.assetImport.available, false);
    assert.equal(data.features.assetImport.enabled, false);
    assert.equal(data.features.assetImport.configuredRootCount, 1);
  } finally { await old.cleanup(); }

  const offline = await fixture(9);
  try {
    await fs.rm(path.join(offline.root, 'Cache'), { recursive: true, force: true });
    const legacy = await handleReimportAsset(ReimportAssetSchema.parse({ path: 'Content/Existing.flax', open_editor: true }), offline.ctx);
    assert.equal(legacy.isError, undefined);
    assert.match(legacy.content[0]?.type === 'text' ? legacy.content[0].text : '', /never launches OS editor processes/);
  } finally { await offline.cleanup(); }
});

function textureSettingsResult(restored: boolean): Record<string, unknown> {
  return {
    Asset: { Id: ASSET_ID, Path: 'Content/Imported/Texture.flax', TypeName: 'FlaxEngine.Texture', Extension: '.flax', Folder: 'Content/Imported' },
    Type: 'texture',
    Restored: restored,
    Settings: [
      { Key: 'Type', Value: { Text: 'ColorRGBA' } },
      { Key: 'sRGB', Value: { Boolean: true } },
      { Key: 'Compress', Value: { Boolean: true } },
      { Key: 'MaxSize', Value: { Integer: 2048 } },
      { Key: 'Scale', Value: { Number: 1 } },
      { Key: 'GenerateMipMaps', Value: { Boolean: true } },
      { Key: 'NeverStream', Value: { Boolean: false } },
    ],
  };
}

test('asset_get_import_settings maps to a strict v32 RPC and projects snake_case scalars', async () => {
  const f = await fixture(32);
  try {
    const pending = handleAssetGetImportSettings(AssetGetImportSettingsSchema.parse({ path: 'Content/Imported/Texture.flax' }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.get_import_settings');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { Path: 'Content/Imported/Texture.flax' });
    await reply(f, request, { ok: true, resultJson: JSON.stringify(textureSettingsResult(true)) });
    const result = await pending;
    const data = envelope(result).data;
    assert.equal(envelope(result).ok, true);
    assert.equal(data.type, 'texture');
    assert.equal(data.restored, true);
    assert.deepEqual(data.settings, { type: 'ColorRGBA', srgb: true, compress: true, max_size: 2048, scale: 1, generate_mipmaps: true, never_stream: false });
    assert.equal(data.asset.Path, 'Content/Imported/Texture.flax');
  } finally { await f.cleanup(); }
});

test('asset import-settings tools require bridge v32 and exactly one selector before any RPC', async () => {
  const old = await fixture(31);
  try {
    const deniedGet = await handleAssetGetImportSettings(AssetGetImportSettingsSchema.parse({ path: 'Content/Imported/Texture.flax' }), old.ctx);
    assert.equal((deniedGet.structuredContent as Record<string, any>).error.code, 'UNSUPPORTED_FLAX_VERSION');
    const deniedSet = await handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
      path: 'Content/Imported/Texture.flax', settings: { max_size: 1024 }, dry_run: true,
    }), old.ctx);
    assert.equal((deniedSet.structuredContent as Record<string, any>).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
    const capabilities = await handleGetServerCapabilities({}, old.ctx);
    const data = (capabilities.structuredContent as Record<string, any>).data;
    assert.equal(data.features.assetImportSettings, false);
    assert.equal(data.features.assetImport.settings, false);
  } finally { await old.cleanup(); }

  const current = await fixture(32);
  try {
    const capabilities = await handleGetServerCapabilities({}, current.ctx);
    const data = (capabilities.structuredContent as Record<string, any>).data;
    assert.equal(data.features.assetImportSettings, true);
    assert.equal(data.features.assetImport.settings, true);
    assert.throws(() => AssetGetImportSettingsSchema.parse({}), /exactly one of asset_id or path/);
    assert.throws(() => AssetGetImportSettingsSchema.parse({ asset_id: ASSET_ID, path: 'Content/Existing.flax' }), /exactly one of asset_id or path/);
    assert.throws(() => AssetSetImportSettingsSchema.parse({ path: 'Content/Existing.flax', settings: { max_size: 1 }, unknown_extra: true }), /unrecognized/i);
  } finally { await current.cleanup(); }
});

test('asset_set_import_settings rejects unknown keys and missing roots without any RPC', async () => {
  const f = await fixture(32);
  try {
    // The strict settings schema rejects unknown and read-only keys before the handler runs.
    assert.throws(() => AssetSetImportSettingsSchema.parse({
      path: 'Content/Existing.flax', settings: { max_size: 1024, bogus_key: true }, dry_run: true,
    }), /bogus_key/);
    assert.throws(() => AssetSetImportSettingsSchema.parse({
      path: 'Content/Existing.flax', settings: { type: 'ColorRGBA' }, dry_run: true,
    }), /unrecognized/i);
    // A caller that skips the schema still gets VALIDATION_FAILED and no RPC.
    const unparsed = (settings: Record<string, unknown>) => handleAssetSetImportSettings(
      { path: 'Content/Existing.flax', settings, dry_run: true, wait: false, timeout_ms: 1_000 } as Parameters<typeof handleAssetSetImportSettings>[0], f.ctx);
    const unknown = await unparsed({ max_size: 1024, bogus_key: true });
    assert.equal((unknown.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED');
    assert.match(JSON.stringify((unknown.structuredContent as Record<string, any>).error), /bogus_key/);
    for (const settings of [{ type: 'ColorRGBA' }, { max_size: 1e19 }, { max_size: 10.5 }, { scale: Number.NaN }, { compress: 'yes' }, { format: 1 }, {}]) {
      const rejected = await unparsed(settings);
      assert.equal((rejected.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED', JSON.stringify(settings));
    }
    assert.deepEqual(await fs.readdir(f.requests), []);

    const noRoots = await fixture(32);
    try {
      noRoots.ctx.assetImportPolicy = { roots: [], extensions: [], maxSourceBytes: 1 };
      const gated = await handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
        path: 'Content/Existing.flax', settings: { max_size: 1024 }, dry_run: true,
      }), noRoots.ctx);
      assert.equal((gated.structuredContent as Record<string, any>).error.code, 'IMPORT_SOURCE_NOT_ALLOWED');
      assert.deepEqual(await fs.readdir(noRoots.requests), []);
    } finally { await noRoots.cleanup(); }
  } finally { await f.cleanup(); }
});

test('asset_set_import_settings dry_run returns would_change with before/after projections', async () => {
  const f = await fixture(32);
  try {
    const after = textureSettingsResult(true);
    (after.Settings as Array<Record<string, unknown>>).find(entry => entry.Key === 'MaxSize')!.Value = { Integer: 1024 };
    const pending = handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
      path: 'Content/Imported/Texture.flax', settings: { max_size: 1024 }, dry_run: true, operation_id: 'a'.repeat(32), idempotency_key: 'settings-test',
    }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.set_import_settings');
    const params = JSON.parse(String(request.body.paramsJson));
    assert.deepEqual(Object.keys(params).sort(), ['AllowedImportRoots', 'DryRun', 'IdempotencyKey', 'MaxSourceBytes', 'OperationId', 'Path', 'Settings'].sort());
    assert.deepEqual(params.Settings, [{ Key: 'MaxSize', Value: { Integer: 1024 } }]);
    assert.equal(params.DryRun, true);
    assert.equal(params.OperationId, 'a'.repeat(32));
    await reply(f, request, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'a'.repeat(32), Kind: 'reimport', Phase: 'dry_run', Progress: 1, DryRun: true },
      WouldChange: true, Before: textureSettingsResult(true), After: after,
    }) });
    const result = await pending;
    const data = envelope(result).data;
    assert.equal(envelope(result).ok, true);
    assert.equal(data.would_change, true);
    assert.equal(data.before.settings.max_size, 2048);
    assert.equal(data.after.settings.max_size, 1024);
  } finally { await f.cleanup(); }
});

test('asset_set_import_settings writes reuse reimport operation tracking for status polling', async () => {
  const f = await fixture(32);
  try {
    const pending = handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
      path: 'Content/Imported/Texture.flax', settings: { compress: false }, operation_id: 'b'.repeat(32), wait: true, timeout_ms: 1_000,
    }), f.ctx);
    const start = await nextRequest(f);
    assert.equal(start.body.method, 'asset.set_import_settings');
    const params = JSON.parse(String(start.body.paramsJson));
    assert.deepEqual(params.Settings, [{ Key: 'Compress', Value: { Boolean: false } }]);
    const after = textureSettingsResult(true);
    (after.Settings as Array<Record<string, unknown>>).find(entry => entry.Key === 'Compress')!.Value = { Boolean: false };
    await reply(f, start, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'b'.repeat(32), Kind: 'reimport', Phase: 'running', Progress: 0 },
      WouldChange: true, Before: textureSettingsResult(true), After: after, Adopted: false,
    }) });
    await requestGone(f, start.name);
    const poll = await nextRequest(f);
    assert.equal(poll.body.method, 'asset.reimport_status');
    assert.deepEqual(JSON.parse(String(poll.body.paramsJson)), { OperationId: 'b'.repeat(32) });
    await reply(f, poll, { ok: true, resultJson: JSON.stringify({ OperationId: 'b'.repeat(32), Kind: 'reimport', Phase: 'succeeded', Progress: 1, ResultPath: 'Content/Imported/Texture.flax' }) });
    const result = await pending;
    assert.equal(envelope(result).data.operation.Phase, 'succeeded');
    // A real write keeps the preview it was started with and reports one change.
    assert.equal(envelope(result).data.would_change, true);
    assert.equal(envelope(result).data.before.settings.compress, true);
    assert.equal(envelope(result).data.after.settings.compress, false);
    assert.equal('adopted' in envelope(result).data, false);
    assert.deepEqual(envelope(result).changes, [{ kind: 'reimport-asset', operationId: 'b'.repeat(32) }]);

    const statusPending = handleAssetReimportStatus(AssetOperationStatusSchema.parse({ operation_id: 'b'.repeat(32) }), f.ctx);
    const status = await nextRequest(f);
    assert.equal(status.body.method, 'asset.reimport_status');
    await reply(f, status, { ok: true, resultJson: JSON.stringify({ OperationId: 'b'.repeat(32), Kind: 'reimport', Phase: 'succeeded', Progress: 1 }) });
    assert.equal(envelope(await statusPending).data.operation.Phase, 'succeeded');
  } finally { await f.cleanup(); }
});

test('asset_set_import_settings publishes the typed settings shape and rejects values the bridge cannot hold', () => {
  const schema = zodToJsonSchema(AssetSetImportSettingsSchema) as Record<string, any>;
  const settings = schema.properties.settings;
  assert.equal(settings.type, 'object');
  assert.equal(settings.additionalProperties, false);
  assert.deepEqual(Object.keys(settings.properties).sort(), [
    'base_lod', 'bit_depth', 'calculate_normals', 'calculate_tangents', 'compress', 'disable_streaming', 'flip_normals', 'format',
    'generate_mipmaps', 'import_lods', 'import_vertex_colors', 'is_3d', 'lod_count', 'max_size', 'merge_meshes', 'never_stream',
    'optimize_meshes', 'quality', 'reverse_winding_order', 'scale', 'smoothing_normals_angle', 'smoothing_tangents_angle', 'srgb',
  ]);
  assert.equal(settings.required, undefined);
  assert.deepEqual(settings.properties.bit_depth.enum, ['_8', '_16', '_24', '_32']);
  assert.deepEqual(settings.properties.format.enum, ['Raw', 'Vorbis']);
  assert.equal(settings.properties.srgb.type, 'boolean');
  assert.deepEqual([settings.properties.max_size.type, settings.properties.max_size.minimum, settings.properties.max_size.maximum], ['integer', 1, 16384]);
  assert.deepEqual([settings.properties.scale.type, settings.properties.scale.minimum, settings.properties.scale.maximum], ['number', 0.0001, 1000]);
  // Engine limits from ModelTool.h / AudioTool.h (Flax 1.12).
  assert.deepEqual([settings.properties.smoothing_normals_angle.minimum, settings.properties.smoothing_normals_angle.maximum], [0, 175]);
  assert.deepEqual([settings.properties.smoothing_tangents_angle.minimum, settings.properties.smoothing_tangents_angle.maximum], [0, 45]);
  assert.deepEqual([settings.properties.base_lod.type, settings.properties.base_lod.minimum, settings.properties.base_lod.maximum], ['integer', 0, 5]);
  assert.deepEqual([settings.properties.lod_count.type, settings.properties.lod_count.minimum, settings.properties.lod_count.maximum], ['integer', 1, 6]);
  assert.deepEqual([settings.properties.quality.minimum, settings.properties.quality.maximum], [0, 1]);
  for (const property of Object.values(settings.properties) as Array<Record<string, unknown>>) assert.equal(typeof property.description, 'string');

  const parse = (value: Record<string, unknown>) => AssetSetImportSettingsSchema.parse({ path: 'Content/Existing.flax', settings: value });
  const rejected: Array<Record<string, unknown>> = [
    { max_size: 1e300 }, { max_size: 1e19 }, { max_size: 2.5 }, { max_size: 0 }, { max_size: 16385 },
    { scale: 1e19 }, { scale: Number.NaN }, { scale: 0 }, { scale: Number.POSITIVE_INFINITY },
    { quality: Number.NaN }, { quality: 1.5 }, { smoothing_normals_angle: 176 }, { smoothing_tangents_angle: 46 },
    { base_lod: 6 }, { lod_count: 7 }, { lod_count: 0 }, { bit_depth: '16' }, { format: 'vorbis' }, { compress: 1 }, { type: 'ColorRGBA' }, {},
  ];
  for (const value of rejected) assert.throws(() => parse(value), Error, `settings ${JSON.stringify(value)} must be rejected`);
  const accepted = parse({ scale: 1, lod_count: 6, base_lod: 5, smoothing_normals_angle: 175, smoothing_tangents_angle: 45, bit_depth: '_16', format: 'Raw' });
  assert.equal(accepted.settings.lod_count, 6);
});

test('asset_set_import_settings sends float options as Number and integer options as Integer', async () => {
  const f = await fixture(32);
  try {
    const pending = handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
      path: 'Content/Imported/Texture.flax', settings: { scale: 2, max_size: 1024, srgb: false }, dry_run: true,
    }), f.ctx);
    const request = await nextRequest(f);
    const params = JSON.parse(String(request.body.paramsJson));
    // Entries follow the schema order, so the bridge fingerprint does not depend on the caller's key order.
    assert.deepEqual(params.Settings, [
      { Key: 'sRGB', Value: { Boolean: false } },
      { Key: 'MaxSize', Value: { Integer: 1024 } },
      { Key: 'Scale', Value: { Number: 2 } },
    ]);
    await reply(f, request, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'a'.repeat(32), Kind: 'reimport', Phase: 'dry_run', Progress: 1, DryRun: true },
      WouldChange: false, Before: textureSettingsResult(true), After: textureSettingsResult(true), Adopted: false,
    }) });
    const data = envelope(await pending).data;
    assert.equal(data.would_change, false);
    assert.equal('adopted' in data, false);
  } finally { await f.cleanup(); }
});

test('asset_set_import_settings never reports an adopted or failed operation as a no-change preview', async () => {
  const f = await fixture(32);
  try {
    const dryRun = (operation: string) => handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
      path: 'Content/Imported/Texture.flax', settings: { max_size: 1024 }, dry_run: true, operation_id: operation,
    }), f.ctx);

    // Adopted without a stored preview (also the shape older bridges return): would_change is unknown.
    const unknownPending = dryRun('c'.repeat(32));
    const unknownRequest = await nextRequest(f);
    await reply(f, unknownRequest, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'c'.repeat(32), Kind: 'reimport', Phase: 'dry_run', Progress: 1, DryRun: true },
      WouldChange: false, Before: null, After: null,
    }) });
    const unknown = await unknownPending;
    assert.equal(envelope(unknown).ok, true);
    assert.equal('would_change' in envelope(unknown).data, false);
    assert.equal(envelope(unknown).data.adopted, true);
    assert.equal(envelope(unknown).data.operation.OperationId, 'c'.repeat(32));
    assert.match(envelope(unknown).warnings.join(' '), /would_change is unknown/);
    await requestGone(f, unknownRequest.name);

    // Adopted operation whose first attempt failed: the failure is reported with its own code.
    const failedPending = dryRun('d'.repeat(32));
    const failedRequest = await nextRequest(f);
    await reply(f, failedRequest, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'd'.repeat(32), Kind: 'reimport', Phase: 'failed', Progress: 1, DryRun: true, ErrorCode: 'EDITOR_BUSY', Error: 'Asset import is unavailable while the editor is playing.' },
      WouldChange: null, Before: null, After: null, Adopted: true,
    }) });
    const failed = await failedPending;
    assert.equal(failed.isError, true);
    assert.equal(envelope(failed).error.code, 'EDITOR_BUSY');
    assert.match(envelope(failed).error.message, /editor is playing.*new operation_id/);
    assert.deepEqual(envelope(failed).error.details, { operationId: 'd'.repeat(32), adopted: true });
    await requestGone(f, failedRequest.name);

    // Adopted operation with its stored preview: the original answer is replayed and marked adopted.
    const after = textureSettingsResult(true);
    (after.Settings as Array<Record<string, unknown>>).find(entry => entry.Key === 'MaxSize')!.Value = { Integer: 1024 };
    const replayPending = dryRun('e'.repeat(32));
    const replayRequest = await nextRequest(f);
    await reply(f, replayRequest, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'e'.repeat(32), Kind: 'reimport', Phase: 'dry_run', Progress: 1, DryRun: true },
      WouldChange: true, Before: textureSettingsResult(true), After: after, Adopted: true,
    }) });
    const replay = envelope(await replayPending);
    assert.equal(replay.data.would_change, true);
    assert.equal(replay.data.after.settings.max_size, 1024);
    assert.equal(replay.data.adopted, true);
    assert.deepEqual(replay.warnings, []);
  } finally { await f.cleanup(); }
});

test('asset_set_import_settings reports a no-op write as unchanged without polling or claiming a reimport', async () => {
  const f = await fixture(32);
  try {
    const pending = handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({
      path: 'Content/Imported/Texture.flax', settings: { compress: true }, operation_id: 'b'.repeat(32), wait: true, timeout_ms: 1_000,
    }), f.ctx);
    const start = await nextRequest(f);
    assert.equal(JSON.parse(String(start.body.paramsJson)).DryRun, false);
    await reply(f, start, { ok: true, resultJson: JSON.stringify({
      Operation: { OperationId: 'b'.repeat(32), Kind: 'reimport', Phase: 'succeeded', Progress: 1, ResultPath: 'Content/Imported/Texture.flax' },
      WouldChange: false, Before: textureSettingsResult(true), After: textureSettingsResult(true), Adopted: false,
    }) });
    const result = envelope(await pending);
    assert.equal(result.ok, true);
    assert.equal(result.data.would_change, false);
    assert.equal(result.data.operation.Phase, 'succeeded');
    assert.deepEqual(result.data.before.settings, result.data.after.settings);
    assert.deepEqual(result.changes, []);
    assert.match(result.warnings.join(' '), /No reimport was queued/);
    assert.equal('pending' in result.data, false);
    await requestGone(f, start.name);
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('asset import-settings tools surface bridge refusals and default-valued reads honestly', async () => {
  const f = await fixture(32);
  try {
    const getPending = handleAssetGetImportSettings(AssetGetImportSettingsSchema.parse({ path: 'Content/Imported/Texture.flax' }), f.ctx);
    const getRequest = await nextRequest(f);
    await reply(f, getRequest, { ok: true, resultJson: JSON.stringify(textureSettingsResult(false)) });
    const defaults = envelope(await getPending);
    assert.equal(defaults.data.restored, false);
    assert.match(defaults.warnings.join(' '), /engine defaults.*refuse to write/);
    await requestGone(f, getRequest.name);

    const restoredPending = handleAssetGetImportSettings(AssetGetImportSettingsSchema.parse({ path: 'Content/Imported/Texture.flax' }), f.ctx);
    const restoredRequest = await nextRequest(f);
    await reply(f, restoredRequest, { ok: true, resultJson: JSON.stringify(textureSettingsResult(true)) });
    assert.deepEqual(envelope(await restoredPending).warnings, []);
    await requestGone(f, restoredRequest.name);

    const unsupportedPending = handleAssetGetImportSettings(AssetGetImportSettingsSchema.parse({ path: 'Content/Existing.flax' }), f.ctx);
    const unsupportedRequest = await nextRequest(f);
    await reply(f, unsupportedRequest, { ok: false, errorCode: 'VALIDATION_FAILED', error: 'Import settings are only supported for texture, model, and audio assets.' });
    assert.equal(envelope(await unsupportedPending).error.code, 'VALIDATION_FAILED');
    await requestGone(f, unsupportedRequest.name);

    const refusedPending = handleAssetSetImportSettings(AssetSetImportSettingsSchema.parse({ path: 'Content/Imported/Texture.flax', settings: { max_size: 1024 } }), f.ctx);
    const refusedRequest = await nextRequest(f);
    await reply(f, refusedRequest, { ok: false, errorCode: 'IMPORT_FAILED', error: 'The asset\'s current import options could not be restored from its import metadata.' });
    const refused = await refusedPending;
    assert.equal(refused.isError, true);
    assert.equal(envelope(refused).error.code, 'IMPORT_FAILED');
    assert.match(envelope(refused).error.message, /could not be restored/);
    await requestGone(f, refusedRequest.name);

    // A failed operation record keeps its own error code when it maps onto a tool error code.
    for (const [errorCode, expected] of [['VALIDATION_FAILED', 'VALIDATION_FAILED'], ['EDITOR_BUSY', 'EDITOR_BUSY'], ['SOMETHING_ELSE', 'IMPORT_FAILED']]) {
      const statusPending = handleAssetReimportStatus(AssetOperationStatusSchema.parse({ operation_id: 'f'.repeat(32) }), f.ctx);
      const status = await nextRequest(f);
      await reply(f, status, { ok: true, resultJson: JSON.stringify({ OperationId: 'f'.repeat(32), Kind: 'reimport', Phase: 'failed', Progress: 1, ErrorCode: errorCode, Error: 'failed' }) });
      assert.equal(envelope(await statusPending).error.code, expected);
      await requestGone(f, status.name);
    }
  } finally { await f.cleanup(); }
});

test('--asset-import-root resolves relative roots against the project path, not the working directory', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'Content', 'Raws'), { recursive: true });
    const policy = await createAssetImportPolicy(['node', 'server', '--asset-import-root', 'Content/Raws', '--asset-import-root', 'approved-source', '--asset-import-root', f.sourceRoot], f.root);
    assert.deepEqual(policy.roots, [await fs.realpath(path.join(f.root, 'Content', 'Raws')), await fs.realpath(f.sourceRoot)]);
    assert.notEqual(path.resolve('.'), f.root);
    await assert.rejects(() => createAssetImportPolicy(['node', 'server', '--asset-import-root', 'Content/Missing'], f.root), /existing readable directory/);
    // Without a project path the legacy cwd-relative behaviour is unchanged.
    await assert.rejects(() => createAssetImportPolicy(['node', 'server', '--asset-import-root', 'approved-source']), /existing readable directory/);
    const absolute = await createAssetImportPolicy(['node', 'server', '--asset-import-root', f.sourceRoot], path.join(f.root, 'Source'));
    assert.equal(absolute.roots[0], await fs.realpath(f.sourceRoot));
  } finally { await f.cleanup(); }
});

test('asset_import start timeouts carry the operation_id so the caller can poll asset_import_status', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/Slow.flax', operation_id: '1'.repeat(32),
    }), f.ctx);
    const request = await nextRequest(f);
    await reply(f, request, { ok: false, errorCode: 'DEADLINE_EXCEEDED', error: 'Import ran past its deadline.' });
    const result = await pending;
    const error = envelope(result).error;
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.details.operation_id, '1'.repeat(32));
    assert.match(error.details.hint, /asset_import_status/);
  } finally { await f.cleanup(); }
});

test('asset_import maps bridge failures through the shared mapper', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/Busy.flax',
    }), f.ctx);
    const request = await nextRequest(f);
    await reply(f, request, { ok: false, errorCode: 'UNAUTHORIZED', error: 'Missing or invalid bridge session token.' });
    const error = envelope(await pending).error;
    assert.equal(error.code, 'EDITOR_BUSY');
    assert.equal(error.details.reason, 'bridge_session_changed');
    assert.equal(error.details.retryable, true);
  } finally { await f.cleanup(); }
});

test('asset_import replace needs confirm:true and a v34 bridge, then sends CollisionPolicy replace with Confirm', async () => {
  const f = await fixture(34);
  try {
    const noConfirm = await handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Existing.flax', collision_policy: 'replace',
    }), f.ctx);
    assert.equal(envelope(noConfirm).error.code, 'VALIDATION_FAILED');
    assert.match(envelope(noConfirm).error.message, /confirm:true/);
    assert.deepEqual(await fs.readdir(f.requests), []);

    const pending = handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Existing.flax', collision_policy: 'replace', confirm: true,
      operation_id: '2'.repeat(32),
    }), f.ctx);
    const request = await nextRequest(f);
    const params = JSON.parse(String(request.body.paramsJson));
    assert.equal(params.CollisionPolicy, 'replace');
    assert.equal(params.Confirm, true);
    assert.equal(params.DestinationPath, 'Content/Existing.flax');
    await reply(f, request, { ok: true, resultJson: JSON.stringify({ OperationId: '2'.repeat(32), Kind: 'import', Phase: 'succeeded', Progress: 1, ResultPath: 'Content/Existing.flax', ResultAssetId: ASSET_ID }) });
    const result = await pending;
    assert.equal(envelope(result).ok, true);
    assert.equal(envelope(result).data.destination.renamed, false);
    assert.equal(envelope(result).data.operation.ResultAssetId, ASSET_ID);
  } finally { await f.cleanup(); }

  const old = await fixture(33);
  try {
    const refused = await handleAssetImport(AssetImportSchema.parse({
      source_path: path.join(old.sourceRoot, 'texture.png'), destination: 'Content/Existing.flax', collision_policy: 'replace', confirm: true,
    }), old.ctx);
    assert.equal(envelope(refused).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }
});

test('asset_import schema: items are 1-32 and exclusive with the single-item fields', () => {
  const item = { source_path: 'a.png', destination: 'Content/A.flax' };
  assert.equal(AssetImportSchema.safeParse({ items: [item] }).success, true);
  assert.equal(AssetImportSchema.safeParse({ items: [] }).success, false);
  assert.equal(AssetImportSchema.safeParse({ items: Array.from({ length: 33 }, (_, i) => ({ ...item, destination: `Content/A${i}.flax` })) }).success, false);
  assert.equal(AssetImportSchema.safeParse({ items: Array.from({ length: 32 }, (_, i) => ({ ...item, destination: `Content/A${i}.flax` })) }).success, true);
  assert.equal(AssetImportSchema.safeParse({ items: [item], source_path: 'b.png' }).success, false);
  assert.equal(AssetImportSchema.safeParse({ items: [item], destination: 'Content/B.flax' }).success, false);
  assert.equal(AssetImportSchema.safeParse({ items: [item], operation_id: 'a'.repeat(32) }).success, false);
  assert.equal(AssetImportSchema.safeParse({ items: [{ ...item, extra: 1 }] }).success, false);
  assert.equal(AssetImportSchema.safeParse({}).success, false);
  assert.equal(AssetImportSchema.safeParse({ source_path: 'a.png' }).success, false);
  assert.equal(AssetImportSchema.safeParse({ ...item, collision_policy: 'replace' }).success, true);
  assert.equal(AssetImportSchema.safeParse({ ...item, collision_policy: 'overwrite' }).success, false);
  assert.ok(zodToJsonSchema(AssetImportSchema));
});

test('asset_import items run sequentially with their own operation ids and an aggregate status', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.sourceRoot, 'second.png'), Buffer.from([4, 5]));
    const pending = handleAssetImport(AssetImportSchema.parse({
      items: [
        { source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/One.flax' },
        { source_path: path.join(f.sourceRoot, 'second.png'), destination: 'Content/Existing.flax' },
        { source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/Three.flax' },
      ],
      collision_policy: 'rename',
      idempotency_key: 'batch',
    }), f.ctx);
    const seen: Array<Record<string, any>> = [];
    for (let index = 0; index < 3; index += 1) {
      const request = await nextRequest(f);
      const params = JSON.parse(String(request.body.paramsJson));
      seen.push(params);
      if (index === 1) {
        await reply(f, request, { ok: false, errorCode: 'IMPORT_FAILED', error: 'Importer rejected the source.' });
      } else {
        await reply(f, request, { ok: true, resultJson: JSON.stringify({ OperationId: params.OperationId, Kind: 'import', Phase: 'succeeded', Progress: 1, ResultPath: params.DestinationPath, ResultAssetId: ASSET_ID }) });
      }
      await requestGone(f, request.name);
    }
    assert.equal(new Set(seen.map(params => params.OperationId)).size, 3);
    assert.deepEqual(seen.map(params => params.IdempotencyKey), ['batch:0', 'batch:1', 'batch:2']);
    assert.equal(seen[1]!.DestinationPath, 'Content/Existing-1.flax');
    const result = await pending;
    assert.equal(envelope(result).ok, true);
    const data = envelope(result).data;
    assert.equal(data.status, 'partial');
    assert.deepEqual(data.counts, { total: 3, succeeded: 2, pending: 0, failed: 1, skipped: 0 });
    assert.deepEqual(data.items.map((entry: any) => [entry.index, entry.ok, entry.status]), [[0, true, 'succeeded'], [1, false, 'failed'], [2, true, 'succeeded']]);
    assert.equal(data.items[1].error.code, 'IMPORT_FAILED');
    assert.equal(data.items[1].operation_id, seen[1]!.OperationId);
    assert.equal(data.items[2].destination.path, 'Content/Imported/Three.flax');
    assert.doesNotMatch(JSON.stringify(data), /approved-source|SourcePath/);
  } finally { await f.cleanup(); }
});

test('asset_import items: all-failed, duplicates, and stop-on-editor-error', async () => {
  const f = await fixture();
  try {
    const dup = await handleAssetImport(AssetImportSchema.parse({
      items: [
        { source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/A.flax' },
        { source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/imported/a.flax' },
      ],
    }), f.ctx);
    assert.equal(envelope(dup).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(f.requests), []);

    // Every item fails locally (destination exists, collision_policy error): no bridge call, aggregate failed.
    const failed = await handleAssetImport(AssetImportSchema.parse({
      items: [{ source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Existing.flax' }],
    }), f.ctx);
    assert.equal(failed.isError, true);
    assert.equal(envelope(failed).error.code, 'FILE_EXISTS');
    assert.equal(envelope(failed).error.details.status, 'failed');
    assert.equal(envelope(failed).error.details.items[0].error.code, 'FILE_EXISTS');

    const pending = handleAssetImport(AssetImportSchema.parse({
      items: [
        { source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/B.flax' },
        { source_path: path.join(f.sourceRoot, 'texture.png'), destination: 'Content/Imported/C.flax' },
      ],
      dry_run: true,
    }), f.ctx);
    const request = await nextRequest(f);
    await reply(f, request, { ok: false, errorCode: 'EDITOR_BUSY', error: 'Editor is compiling.' });
    const aborted = envelope(await pending);
    assert.equal(aborted.error.code, 'EDITOR_BUSY');
    assert.deepEqual(aborted.error.details.items.map((entry: any) => entry.status), ['failed', 'skipped']);
  } finally { await f.cleanup(); }
});
