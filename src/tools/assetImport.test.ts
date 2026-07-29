import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAssetImportPolicy, chooseAssetImportDestination, verifyAssetImportDestination, verifyAssetImportSource } from '../assetImportPolicy.js';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { handleGetServerCapabilities } from './serverStatus.js';
import { handleReimportAsset, ReimportAssetSchema } from './assetInfo.js';
import {
  AssetImportSchema,
  AssetOperationStatusSchema,
  AssetReimportSchema,
  handleAssetImport,
  handleAssetImportStatus,
  handleAssetReimport,
  handleAssetReimportStatus,
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
