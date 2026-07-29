import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectMeta, createProjectContext } from '../projectContext.js';
import {
  AssetDependenciesSchema,
  AssetFindReferencesSchema,
  AssetGetSchema,
  AssetSearchSchema,
  handleAssetDependencies,
  handleAssetFindReferences,
  handleAssetGet,
  handleAssetSearch,
  handleGetAssetInfoCompatibility,
  handleListAssetsCompatibility,
} from './assetLive.js';
import { ListAssetsSchema } from './assets.js';
import { GetAssetInfoSchema } from './assetInfo.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ASSET_ID = 'a'.repeat(32);

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup(): Promise<void>;
}

async function fixture(bridgeVersion = 8): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-asset-live-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(cache, { recursive: true });
  await Promise.all([
    fs.mkdir(path.join(root, 'Content'), { recursive: true }),
    fs.mkdir(path.join(root, 'Source'), { recursive: true }),
    fs.mkdir(path.join(root, 'Logs'), { recursive: true }),
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
    fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' })),
    fs.writeFile(path.join(root, 'Content', 'Fixture.scene'), JSON.stringify({ ID: ASSET_ID, TypeName: 'FlaxEngine.Scene', Data: [] })),
    fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
      Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1,
    })),
    fs.writeFile(path.join(cache, 'token'), TOKEN),
  ]);
  return { root, ctx: await createProjectContext(root), requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    const name = (await fs.readdir(f.requests)).find(value => value.endsWith('.json'));
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for asset RPC request.');
}

async function reply(f: Fixture, request: { name: string; body: Record<string, unknown> }, body: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(f.responses, request.name), JSON.stringify({
    id: request.body.id,
    token: TOKEN,
    timestamp: Date.now(),
    ...body,
  }));
}

test('asset live schemas are strict, scoped, and bound pagination/depth', () => {
  assert.equal(AssetSearchSchema.safeParse({ limit: 201 }).success, false);
  assert.equal(AssetSearchSchema.safeParse({ unexpected: true }).success, false);
  assert.equal(AssetGetSchema.safeParse({}).success, false);
  assert.equal(AssetGetSchema.safeParse({ asset_id: ASSET_ID, path: 'Content/Fixture.scene' }).success, false);
  assert.equal(AssetGetSchema.safeParse({ path: '../Fixture.scene' }).success, false);
  assert.equal(AssetDependenciesSchema.safeParse({ asset_id: ASSET_ID, max_depth: 17, transitive: true }).success, false);
  assert.equal(AssetDependenciesSchema.safeParse({ asset_id: ASSET_ID, max_depth: 2 }).success, false);
  assert.equal(AssetFindReferencesSchema.safeParse({ asset_id: ASSET_ID, cursor: 'invalid' }).success, false);
});

test('asset_search sends strict PascalCase DTOs and preserves opaque pagination', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetSearch(AssetSearchSchema.parse({
      query: 'blue', path: 'Materials', type: 'Material', extension: '.flax', guid: ASSET_ID,
      folder: 'Content/Materials', has_missing_dependency: false, limit: 2, cursor: 'b'.repeat(32),
    }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.search');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), {
      Query: 'blue', Path: 'Materials', Type: 'Material', Extension: '.flax', Guid: ASSET_ID,
      Folder: 'Content/Materials', HasMissingDependency: false, Limit: 2, Cursor: 'b'.repeat(32),
    });
    await reply(f, request, { ok: true, resultJson: JSON.stringify({
      Entries: [{ Id: ASSET_ID, Path: 'Content/Materials/Blue.flax', DependencyCount: 1, ReferenceCount: 2 }],
      NextCursor: 'c'.repeat(32), HasMore: true, IndexRevision: 'revision', Warnings: [],
    }) });
    const result = await pending;
    const data = (result.structuredContent as Record<string, any>).data;
    assert.equal(data.result.NextCursor, 'c'.repeat(32));
    assert.equal(data.result.Entries[0].DependencyCount, 1);
  } finally {
    await f.cleanup();
  }
});

test('asset graph handlers map dependency depth/cycles and cursor invalidation errors', async () => {
  const f = await fixture();
  try {
    const dependencies = handleAssetDependencies(AssetDependenciesSchema.parse({ asset_id: ASSET_ID, transitive: true, max_depth: 16, limit: 1 }), f.ctx);
    const depRequest = await nextRequest(f);
    assert.equal(depRequest.body.method, 'asset.dependencies');
    assert.deepEqual(JSON.parse(String(depRequest.body.paramsJson)), { AssetId: ASSET_ID, Transitive: true, MaxDepth: 16, Limit: 1 });
    await reply(f, depRequest, { ok: true, resultJson: JSON.stringify({
      Root: { Id: ASSET_ID }, Entries: [{ FromId: ASSET_ID, Asset: { Id: 'b'.repeat(32) }, Depth: 16, Cycle: true }],
      HasMore: false, IndexRevision: 'revision', Warnings: [],
    }) });
    const dependencyResult = await dependencies;
    assert.equal((dependencyResult.structuredContent as Record<string, any>).data.result.Entries[0].Cycle, true);

    const references = handleAssetFindReferences(AssetFindReferencesSchema.parse({ path: 'Content/Fixture.scene', cursor: 'c'.repeat(32) }), f.ctx);
    const refRequest = await nextRequest(f);
    assert.equal(refRequest.body.method, 'asset.find_references');
    assert.deepEqual(JSON.parse(String(refRequest.body.paramsJson)), { Path: 'Content/Fixture.scene', Transitive: false, MaxDepth: 1, Limit: 50, Cursor: 'c'.repeat(32) });
    await reply(f, refRequest, { ok: false, errorCode: 'CURSOR_INVALID', error: 'Asset cursor scope changed.', resultJson: null });
    const referenceResult = await references;
    assert.equal((referenceResult.structuredContent as Record<string, any>).error.code, 'CURSOR_INVALID');
  } finally {
    await f.cleanup();
  }
});

test('asset_get maps ASSET_NOT_FOUND and requires bridge v8 before a request is written', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetGet(AssetGetSchema.parse({ path: 'Content/Fixture.scene' }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.get');
    await reply(f, request, { ok: false, errorCode: 'ASSET_NOT_FOUND', error: 'Asset missing.', resultJson: null });
    const missing = await pending;
    assert.equal((missing.structuredContent as Record<string, any>).error.code, 'ASSET_NOT_FOUND');
  } finally {
    await f.cleanup();
  }

  const old = await fixture(7);
  try {
    const result = await handleAssetGet(AssetGetSchema.parse({ asset_id: ASSET_ID }), old.ctx);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally {
    await old.cleanup();
  }
});

test('legacy asset aliases retain offline behavior when bridge v8 is unavailable', async () => {
  const f = await fixture(7);
  try {
    const listed = await handleListAssetsCompatibility(ListAssetsSchema.parse({ type: 'all' }), f.ctx);
    assert.match(listed.content[0]?.type === 'text' ? listed.content[0].text : '', /Fixture\.scene/);
    assert.equal((listed.structuredContent as Record<string, any>).mode, 'offline');
    const info = await handleGetAssetInfoCompatibility(GetAssetInfoSchema.parse({ path: 'Fixture.scene' }), f.ctx);
    assert.match(info.content[0]?.type === 'text' ? info.content[0].text : '', /Asset: Content[\\/]Fixture\.scene/);
  } finally {
    await f.cleanup();
  }
});
