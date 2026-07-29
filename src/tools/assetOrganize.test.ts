import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import {
  AssetDeleteSchema,
  AssetDuplicateSchema,
  AssetMoveSchema,
  AssetRenameSchema,
  handleAssetDelete,
  handleAssetDuplicate,
  handleAssetMove,
  handleAssetRename,
} from './assetOrganize.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ASSET_ID = 'a'.repeat(32);
const INDEX = 'b'.repeat(64);

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup(): Promise<void>;
}

async function fixture(bridgeVersion = 10): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-asset-organize-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([
    fs.mkdir(path.join(root, 'Content', 'Destination'), { recursive: true }),
    fs.mkdir(path.join(root, 'Source'), { recursive: true }),
    fs.mkdir(path.join(root, 'Logs'), { recursive: true }),
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' })),
    fs.writeFile(path.join(root, 'Content', 'Fixture.scene'), JSON.stringify({ ID: ASSET_ID, TypeName: 'FlaxEngine.Scene', Data: [] })),
    fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1 })),
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
  throw new Error('Timed out waiting for asset organization RPC request.');
}

async function reply(f: Fixture, request: { name: string; body: Record<string, unknown> }, body: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(f.responses, request.name), JSON.stringify({
    id: request.body.id, token: TOKEN, timestamp: Date.now(), ...body,
  }));
}

test('asset organization schemas require normalized Content paths, names, and one selector', () => {
  assert.equal(AssetMoveSchema.safeParse({ asset_id: ASSET_ID, destination: 'content/Destination' }).success, false);
  assert.equal(AssetMoveSchema.safeParse({ asset_id: ASSET_ID, destination: 'Content\\Destination' }).success, false);
  assert.equal(AssetMoveSchema.safeParse({ asset_id: ASSET_ID, path: 'Content/Fixture.scene', destination: 'Content/Destination' }).success, false);
  assert.equal(AssetRenameSchema.safeParse({ path: 'Content/Fixture.scene', name: 'Fixture.scene' }).success, false);
  assert.equal(AssetDuplicateSchema.safeParse({ path: 'Content/Fixture.scene', destination: 'Content/Destination', name: 'Copy', collision_policy: 'overwrite' }).success, false);
  assert.equal(AssetDeleteSchema.safeParse({ path: 'Content/Fixture.scene', quarantine_destination: 'Content/Destination' }).success, true);
  assert.equal(AssetDeleteSchema.safeParse({ path: 'Content/Fixture.scene', quarantine_destination: 'Content/Destination', dry_run: true }).success, true);
  assert.equal(AssetDeleteSchema.safeParse({ path: 'Content/Fixture.scene', quarantine_destination: 'Content/Destination', dry_run: false, confirm: true, confirm_reference_count: 2 }).success, true);
  assert.equal(AssetDeleteSchema.safeParse({ path: 'Content/Fixture.scene', quarantine_destination: 'Content/Destination', dry_run: false, confirm: true, require_unreferenced: true }).success, true);
  assert.equal(AssetRenameSchema.safeParse({ path: 'Content/Fixture.scene', name: 'Renamed', expected_index_revision: INDEX }).success, true);
});

test('asset_delete previews and then quarantines through v13 only after reference-count confirmation', async () => {
  const f = await fixture(13);
  try {
    const preview = handleAssetDelete(AssetDeleteSchema.parse({
      asset_id: ASSET_ID, quarantine_destination: 'Content/Destination', dry_run: true, expected_path: 'Content/Fixture.scene', expected_index_revision: INDEX,
    }), f.ctx);
    const previewRequest = await nextRequest(f);
    assert.equal(previewRequest.body.method, 'asset.delete');
    assert.deepEqual(JSON.parse(String(previewRequest.body.paramsJson)), {
      AssetId: ASSET_ID, Destination: 'Content/Destination', CollisionPolicy: 'error', DryRun: true,
      ExpectedPath: 'Content/Fixture.scene', ExpectedIndexRevision: INDEX,
    });
    await reply(f, previewRequest, { ok: true, resultJson: JSON.stringify({
      Operation: 'delete', Source: { Id: ASSET_ID, Path: 'Content/Fixture.scene' }, Result: { Id: ASSET_ID, Path: 'Content/Destination/Fixture.scene' },
      IndexRevisionBefore: INDEX, IndexRevisionAfter: INDEX, DryRun: true, GuidPreserved: true,
      ReferenceImpact: { DirectReferenceCount: 2, Sample: [], Truncated: false }, Warnings: ['Quarantine preview'],
    }) });
    assert.equal(((await preview).structuredContent as Record<string, any>).data.result.ReferenceImpact.DirectReferenceCount, 2);

    const confirmed = handleAssetDelete(AssetDeleteSchema.parse({
      asset_id: ASSET_ID, quarantine_destination: 'Content/Destination', dry_run: false, confirm: true, confirm_reference_count: 2, idempotency_key: 'delete-1',
    }), f.ctx);
    const confirmedRequest = await nextRequest(f);
    assert.deepEqual(JSON.parse(String(confirmedRequest.body.paramsJson)), {
      AssetId: ASSET_ID, Destination: 'Content/Destination', CollisionPolicy: 'error', DryRun: false,
      ConfirmReferenceCount: 2, Confirm: true, IdempotencyKey: 'delete-1',
    });
    await reply(f, confirmedRequest, { ok: true, resultJson: JSON.stringify({
      Operation: 'delete', Source: { Id: ASSET_ID, Path: 'Content/Fixture.scene' }, Result: { Id: ASSET_ID, Path: 'Content/Destination/Fixture.scene' },
      IndexRevisionBefore: INDEX, IndexRevisionAfter: 'c'.repeat(64), DryRun: false, GuidPreserved: true,
      ReferenceImpact: { DirectReferenceCount: 2, Sample: [], Truncated: false }, Warnings: ['Quarantine move, not permanent delete'],
    }) });
    const envelope = (await confirmed).structuredContent as Record<string, any>;
    assert.equal(envelope.changes[0].kind, 'asset-delete');
    const audit = await fs.readFile(path.join(f.root, '.flax-mcp', 'audit.jsonl'), 'utf8');
    assert.match(audit, /asset_delete/);
  } finally { await f.cleanup(); }
});

test('asset_move sends strict v10 PascalCase guards and returns a dry-run reference impact', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetMove(AssetMoveSchema.parse({
      asset_id: ASSET_ID.toUpperCase(), destination: 'Content/Destination', collision_policy: 'rename', dry_run: true,
      expected_path: 'Content/Fixture.scene', expected_index_revision: INDEX, idempotency_key: 'move-1',
    }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.move');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), {
      AssetId: ASSET_ID.toUpperCase(), Destination: 'Content/Destination',
      CollisionPolicy: 'rename', DryRun: true, ExpectedPath: 'Content/Fixture.scene', ExpectedIndexRevision: INDEX, IdempotencyKey: 'move-1',
    });
    await reply(f, request, { ok: true, resultJson: JSON.stringify({
      Operation: 'move', Source: { Id: ASSET_ID, Path: 'Content/Fixture.scene' }, Result: { Id: ASSET_ID, Path: 'Content/Destination/Fixture.scene' },
      IndexRevisionBefore: INDEX, IndexRevisionAfter: INDEX, DryRun: true, Renamed: true, GuidPreserved: true, ExistingReferencesPreserved: true,
      UndoSupported: false, ReferenceImpact: { DirectReferenceCount: 2, Sample: [{ Asset: { Id: 'c'.repeat(32), Path: 'Content/Uses.scene' }, Kind: 'scene' }], Truncated: false }, Warnings: ['No verified undo'],
    }) });
    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.changes.length, 0);
    assert.equal(envelope.data.result.GuidPreserved, true);
    assert.equal(envelope.data.result.ReferenceImpact.DirectReferenceCount, 2);
    const audit = await fs.readFile(path.join(f.root, '.flax-mcp', 'audit.jsonl'), 'utf8');
    assert.match(audit, /asset_move/);
    assert.doesNotMatch(audit, /Content\\/);
  } finally { await f.cleanup(); }
});

test('asset_duplicate reports a new identity and leaves source references unchanged', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetDuplicate(AssetDuplicateSchema.parse({
      path: 'Content/Fixture.scene', destination: 'Content/Destination', name: 'FixtureCopy', idempotency_key: 'copy-1',
    }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'asset.duplicate');
    await reply(f, request, { ok: true, resultJson: JSON.stringify({
      Operation: 'duplicate', Source: { Id: ASSET_ID, Path: 'Content/Fixture.scene' }, Result: { Id: 'd'.repeat(32), Path: 'Content/Destination/FixtureCopy.scene' },
      IndexRevisionBefore: INDEX, IndexRevisionAfter: 'e'.repeat(64), DryRun: false, Renamed: false, GuidPreserved: false, ExistingReferencesPreserved: true, ReferencesRemainBoundToSource: true,
      ReferenceImpact: { DirectReferenceCount: 1, Sample: [], Truncated: false }, Warnings: ['Source references remain bound'],
    }) });
    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.Result.Id, 'd'.repeat(32));
    assert.equal(envelope.data.result.GuidPreserved, false);
    assert.equal(envelope.changes[0].direct_reference_count, 1);
    assert.equal(envelope.changes[0].kind, 'asset-duplicate');
  } finally { await f.cleanup(); }
});

test('asset organization maps conflict and expected-revision errors and gates pre-v10 bridges', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetRename(AssetRenameSchema.parse({ path: 'Content/Fixture.scene', name: 'Renamed' }), f.ctx);
    const request = await nextRequest(f);
    await reply(f, request, { ok: false, errorCode: 'FILE_EXISTS', error: 'Destination exists.', resultJson: null });
    assert.equal(((await pending).structuredContent as Record<string, any>).error.code, 'FILE_EXISTS');
  } finally { await f.cleanup(); }

  const conflict = await fixture();
  try {
    const pending = handleAssetRename(AssetRenameSchema.parse({ path: 'Content/Fixture.scene', name: 'Renamed', expected_index_revision: INDEX }), conflict.ctx);
    const request = await nextRequest(conflict);
    await reply(conflict, request, { ok: false, errorCode: 'ASSET_REVISION_CONFLICT', error: 'Registry changed.', errorDetails: JSON.stringify({ CurrentIndexRevision: 'f'.repeat(64) }), resultJson: null });
    assert.equal(((await pending).structuredContent as Record<string, any>).error.code, 'ASSET_REVISION_CONFLICT');
  } finally { await conflict.cleanup(); }

  const old = await fixture(9);
  try {
    const result = await handleAssetMove(AssetMoveSchema.parse({ path: 'Content/Fixture.scene', destination: 'Content/Destination' }), old.ctx);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }

  const oldDelete = await fixture(12);
  try {
    const result = await handleAssetDelete(AssetDeleteSchema.parse({ path: 'Content/Fixture.scene', quarantine_destination: 'Content/Destination', dry_run: false, confirm: true, confirm_reference_count: 0 }), oldDelete.ctx);
    assert.equal((result.structuredContent as Record<string, any>).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(oldDelete.requests), []);
  } finally { await oldDelete.cleanup(); }
});
