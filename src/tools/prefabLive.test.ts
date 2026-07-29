import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  PrefabApplyOverridesSchema,
  PrefabBreakLinkSchema,
  PrefabCreateFromActorSchema,
  PrefabGetInstancesSchema,
  PrefabInstantiateSchema,
  PrefabRevertOverridesSchema,
  handlePrefabApplyOverrides,
  handlePrefabCreateFromActor,
  handlePrefabGetInstances,
  handlePrefabInstantiate,
  handlePrefabRevertOverrides,
} from './prefabLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const PREFAB_ID = 'a'.repeat(32);
const ACTOR_ID = 'b'.repeat(32);
const PARENT_ID = 'c'.repeat(32);

interface Fixture {
  root: string;
  requests: string;
  responses: string;
  ctx: ProjectMeta;
  cleanup: () => Promise<void>;
}

async function fixture(bridgeVersion = 12): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-prefab-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'prefab-fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid,
    Project: root,
    Timestamp: Date.now(),
    BridgeVersion: bridgeVersion,
    ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, requests, responses, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function waitForRequest(directory: string, timeoutMs = 1_000): Promise<{ file: string; body: Record<string, unknown> }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() <= end) {
    const names = await fs.readdir(directory);
    const name = names.find(value => value.endsWith('.json'));
    if (name) {
      const file = path.join(directory, name);
      return { file, body: JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown> };
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for prefab bridge request.');
}

async function respond(f: Fixture, body: Record<string, unknown>): Promise<{ body: Record<string, unknown>; params: Record<string, unknown> }> {
  const request = await waitForRequest(f.requests);
  const target = path.join(f.responses, `${request.body.id}.json`);
  await fs.writeFile(`${target}.tmp`, JSON.stringify({ id: request.body.id, token: TOKEN, timestamp: Date.now(), ...body }));
  await fs.rename(`${target}.tmp`, target);
  return { body: request.body, params: JSON.parse(String(request.body.paramsJson)) as Record<string, unknown> };
}

test('prefab schemas enforce strict selectors, bounded transforms, pagination, and destructive dry-run confirmation', () => {
  assert.equal(PrefabCreateFromActorSchema.safeParse({ actor_id: ACTOR_ID, destination_path: 'Content/Prefabs/Unit.prefab', unexpected: true }).success, false);
  assert.equal(PrefabCreateFromActorSchema.safeParse({ actor_id: ACTOR_ID, destination_path: 'Content/../Unit.prefab' }).success, false);
  assert.equal(PrefabInstantiateSchema.safeParse({ asset_id: PREFAB_ID }).success, false);
  assert.equal(PrefabInstantiateSchema.safeParse({ asset_id: PREFAB_ID, path: 'Content/Prefabs/Unit.prefab', parent_id: PARENT_ID }).success, false);
  assert.equal(PrefabInstantiateSchema.safeParse({ asset_id: PREFAB_ID, parent_id: PARENT_ID, position: { x: Infinity, y: 0, z: 0 } }).success, false);
  assert.equal(PrefabGetInstancesSchema.safeParse({ asset_id: PREFAB_ID, limit: 201 }).success, false);
  assert.equal(PrefabRevertOverridesSchema.parse({ actor_id: ACTOR_ID }).dry_run, true);
  assert.equal(PrefabApplyOverridesSchema.safeParse({ actor_id: ACTOR_ID, dry_run: false }).success, false);
  assert.equal(PrefabBreakLinkSchema.safeParse({ actor_id: ACTOR_ID, dry_run: false, confirm: true }).success, true);
});

test('prefab create marshals PascalCase mutation gates and returns a structured change', async () => {
  const f = await fixture();
  try {
    const pending = handlePrefabCreateFromActor(PrefabCreateFromActorSchema.parse({
      actor_id: ACTOR_ID,
      destination_path: 'Content/Prefabs/Unit.prefab',
      auto_link: true,
      expected_scene_revision: 4,
      lease_id: 'd'.repeat(32),
      idempotency_key: 'prefab-create-1',
    }), f.ctx);
    const request = await respond(f, { ok: true, resultJson: JSON.stringify({ Created: true, PrefabPath: 'Content/Prefabs/Unit.prefab', ProjectRevision: 5, SceneRevision: 5 }) });
    assert.equal(request.body.method, 'prefab.create_from_actor');
    assert.deepEqual(request.params, {
      ActorId: ACTOR_ID,
      DestinationPath: 'Content/Prefabs/Unit.prefab',
      AutoLink: true,
      DryRun: false,
      ExpectedSceneRevision: 4,
      LeaseId: 'd'.repeat(32),
      IdempotencyKey: 'prefab-create-1',
    });
    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.deepEqual((result.structuredContent as any).changes, [{ kind: 'prefab.created', sourceActorId: ACTOR_ID, path: 'Content/Prefabs/Unit.prefab', autoLinked: true }]);
  } finally {
    await f.cleanup();
  }
});

test('prefab instantiate marshals strict parent/transform and get_instances preserves pagination cursor casing', async () => {
  const f = await fixture();
  try {
    const instantiate = handlePrefabInstantiate(PrefabInstantiateSchema.parse({
      path: 'Content/Prefabs/Unit.prefab',
      parent_id: PARENT_ID,
      name: 'Unit One',
      position: { x: 1, y: 2, z: 3 },
      scale: { x: 2, y: 2, z: 2 },
      euler_angles: { x: 0, y: 90, z: 0 },
      expected_scene_revision: 9,
      idempotency_key: 'prefab-instantiate-1',
    }), f.ctx);
    const first = await respond(f, { ok: true, resultJson: JSON.stringify({ Actor: { Id: ACTOR_ID }, VerifiedLink: true, ProjectRevision: 10, SceneRevision: 10 }) });
    assert.equal(first.body.method, 'prefab.instantiate');
    assert.deepEqual(first.params, {
      Path: 'Content/Prefabs/Unit.prefab',
      ParentId: PARENT_ID,
      Name: 'Unit One',
      Position: { X: 1, Y: 2, Z: 3 },
      Scale: { X: 2, Y: 2, Z: 2 },
      EulerAngles: { X: 0, Y: 90, Z: 0 },
      DryRun: false,
      ExpectedSceneRevision: 9,
      IdempotencyKey: 'prefab-instantiate-1',
    });
    assert.equal((await instantiate).isError, undefined);

    const list = handlePrefabGetInstances(PrefabGetInstancesSchema.parse({ asset_id: PREFAB_ID, scene_id: 'e'.repeat(32), limit: 2, cursor: 'f'.repeat(32) }), f.ctx);
    const second = await respond(f, { ok: true, resultJson: JSON.stringify({ Entries: [], HasMore: false }) });
    assert.equal(second.body.method, 'prefab.get_instances');
    assert.deepEqual(second.params, { AssetId: PREFAB_ID, SceneId: 'e'.repeat(32), Limit: 2, Cursor: 'f'.repeat(32) });
    assert.equal((await list).isError, undefined);
  } finally {
    await f.cleanup();
  }
});

test('unsupported prefab override/revert capabilities are stable remote errors and default destructive calls to dry-run', async () => {
  const f = await fixture();
  try {
    const pending = handlePrefabRevertOverrides(PrefabRevertOverridesSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    const request = await respond(f, {
      ok: false,
      errorCode: 'UNSUPPORTED_FLAX_VERSION',
      error: 'prefab_revert_overrides is intentionally unavailable.',
      errorDetails: JSON.stringify({ Capability: 'prefab_revert_overrides', BridgeVersion: 12, DryRun: true }),
      resultJson: null,
    });
    assert.equal(request.body.method, 'prefab.revert_overrides');
    assert.deepEqual(request.params, {
      ActorId: ACTOR_ID,
      DryRun: true,
      Confirm: false,
    });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual((result.structuredContent as any).error.details, { Capability: 'prefab_revert_overrides', BridgeVersion: 12, DryRun: true });
  } finally {
    await f.cleanup();
  }
});

test('prefab methods fail closed before writing a request to a bridge older than v12', async () => {
  const f = await fixture(11);
  try {
    const result = await handlePrefabApplyOverrides(PrefabApplyOverridesSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});
