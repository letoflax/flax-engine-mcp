import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FileRpcClient } from '../bridge/fileRpcClient.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError } from '../errors.js';
import { atomicWriteConfined } from '../writeSafety.js';
import {
  canCreateDirectorySymlink,
  createEditorIntegrationFixture,
  respondToHarness,
  TEST_BRIDGE_TOKEN,
  waitForHarnessRequest,
  writeBridgeHeartbeat,
} from '../testSupport/editorIntegrationFixture.js';

async function expectBridgeError(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof BridgeRpcError && error.code === code);
}

test('generated editor fixture has the documented two-scene, actor asset, script, and compile-failure inputs', async () => {
  const f = await createEditorIntegrationFixture();
  try {
    for (const relative of [
      'Content/Scenes/Main.scene', 'Content/Scenes/Secondary.scene', 'Content/Prefabs/TestActor.prefab',
      'Content/Materials/Test.material', 'Content/Textures/Test.png', 'Content/Models/Test.fbx',
      'Source/Game/FixtureScript.cs', 'Source/Game/NetworkFixtureScript.cs', 'Source/Game/IntentionalCompileFailure.cs',
    ]) await fs.access(path.join(f.root, relative));
    assert.match(await fs.readFile(path.join(f.source, 'IntentionalCompileFailure.cs'), 'utf8'), /BROKEN/);
    const mainScene = await fs.readFile(path.join(f.content, 'Scenes', 'Main.scene'), 'utf8');
    assert.match(mainScene, /FlaxEngine\.Camera/);
    assert.match(mainScene, /FlaxEngine\.DirectionalLight/);
    assert.match(mainScene, /FlaxEngine\.StaticModel/);
    assert.match(mainScene, /FlaxEngine\.BoxCollider/);
  } finally { await f.cleanup(); }
});

test('file-RPC integration harness serializes a bridge DTO and consumes an Editor-shaped response', async () => {
  const f = await createEditorIntegrationFixture();
  try {
    const client = new FileRpcClient(f.ctx, { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call<'actor.get', { ActorId: string }, { Id: string; Name: string }>('actor.get', { ActorId: 'a'.repeat(32) });
    const request = await waitForHarnessRequest(f.requests);
    assert.deepEqual(Object.keys(request.body).sort(), ['deadlineUnixMs', 'id', 'method', 'paramsJson', 'token']);
    assert.equal(request.body.method, 'actor.get');
    assert.equal(request.body.token, TEST_BRIDGE_TOKEN);
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { ActorId: 'a'.repeat(32) });
    await respondToHarness(f, request, { id: request.body.id, ok: true, resultJson: JSON.stringify({ Id: 'a'.repeat(32), Name: 'Fixture Actor' }), timestamp: Date.now() });
    assert.deepEqual((await pending).result, { Id: 'a'.repeat(32), Name: 'Fixture Actor' });
  } finally { await f.cleanup(); }
});

test('fault injection rejects malformed responses and cleans scoped request artifacts', async () => {
  const f = await createEditorIntegrationFixture();
  try {
    const client = new FileRpcClient(f.ctx, { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call('status', {});
    const request = await waitForHarnessRequest(f.requests);
    await fs.writeFile(path.join(f.responses, request.name), '{not-json');
    await expectBridgeError(() => pending, 'BRIDGE_RESPONSE_INVALID');
    assert.deepEqual(await fs.readdir(f.requests), []);
    assert.deepEqual(await fs.readdir(f.responses), []);
  } finally { await f.cleanup(); }
});

test('fault injection handles timeout plus editor disconnect/reload without leaking requests', async () => {
  const f = await createEditorIntegrationFixture();
  try {
    const client = new FileRpcClient(f.ctx, { deadlineMs: 60, pollIntervalMs: 5 });
    const pending = client.call('status', {});
    await waitForHarnessRequest(f.requests);
    // Model an Editor closing/reloading after it accepted the request. No GUI or
    // Editor process is claimed here; transport must still time out safely.
    await writeBridgeHeartbeat(f.root, { remove: true });
    await expectBridgeError(() => pending, 'BRIDGE_TIMEOUT');
    await expectBridgeError(() => client.call('status', {}), 'BRIDGE_UNAVAILABLE');
    await writeBridgeHeartbeat(f.root);
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('fault injection maps a remote permission denial without exposing transport tokens', async () => {
  const f = await createEditorIntegrationFixture();
  try {
    const client = new FileRpcClient(f.ctx, { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call('actor.delete', { ActorId: 'b'.repeat(32) });
    const request = await waitForHarnessRequest(f.requests);
    await respondToHarness(f, request, { id: request.body.id, ok: false, errorCode: 'PERMISSION_DENIED', error: 'Editor policy denied this mutation.', resultJson: null, timestamp: Date.now() });
    await expectBridgeError(() => pending, 'BRIDGE_REMOTE_ERROR');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('fault injection catches a stale file immediately before an atomic patch replacement', async () => {
  const f = await createEditorIntegrationFixture();
  try {
    const file = path.join(f.source, 'FixtureScript.cs');
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(
      atomicWriteConfined(file, 'public class FixtureScript { }\n', f.root, before, async () => {
        await fs.writeFile(file, 'external editor save\n');
      }),
      (error: unknown) => error instanceof ToolDomainError && error.code === 'FILE_CHANGED',
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'external editor save\n');
  } finally { await f.cleanup(); }
});

test('fault injection models an idempotent duplicate retry as one bridge-side mutation', async () => {
  const f = await createEditorIntegrationFixture({ bridgeVersion: 8 });
  try {
    const client = new FileRpcClient(f.ctx, { deadlineMs: 500, pollIntervalMs: 5 });
    const seenKeys = new Map<string, { Id: string }>();
    let mutations = 0;
    for (let retry = 0; retry < 2; retry++) {
      const pending = client.call('actor.create', { Name: 'RetryActor', IdempotencyKey: 'retry-key-1' }, { minimumBridgeVersion: 7 });
      const request = await waitForHarnessRequest(f.requests);
      const params = JSON.parse(String(request.body.paramsJson)) as { IdempotencyKey: string };
      let result = seenKeys.get(params.IdempotencyKey);
      if (!result) { result = { Id: 'c'.repeat(32) }; seenKeys.set(params.IdempotencyKey, result); mutations++; }
      await respondToHarness(f, request, { id: request.body.id, ok: true, resultJson: JSON.stringify(result), timestamp: Date.now() });
      assert.deepEqual((await pending).result, { Id: 'c'.repeat(32) });
    }
    assert.equal(mutations, 1, 'the simulated bridge ledger must replay, not execute twice');
  } finally { await f.cleanup(); }
});

test('fixture symlink capability is explicit for hosts that restrict junction creation', async t => {
  const f = await createEditorIntegrationFixture();
  try {
    if (!await canCreateDirectorySymlink(f.root)) t.skip('Directory symlinks/junctions are not permitted on this host.');
    else assert.ok(true);
  } finally { await f.cleanup(); }
});

test('real Flax GUI integration is opt-in and skipped unless an explicit host command is configured', { skip: 'No FlaxEditor.exe is configured in this test environment; see docs/TESTING.md for the manual Flax 1.12 matrix.' }, () => {
  // Intentionally skipped: Flax 1.12 headed play tests require a real game
  // window. The tests above exercise only a deterministic file-RPC peer.
});

test('operation cancellation has no released bridge API and remains explicitly untested', { skip: 'Bridge v8 has no cancellable build/import operation API; add this probe with the operation contract.' }, () => {});
