import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  ActorFindSchema,
  ActorCreateSchema,
  ActorGetSchema,
  ActorSetPropertySchema,
  ActorUpdateSchema,
  EditLeaseBeginSchema,
  EditLeaseGetSchema,
  EditorGetSelectionSchema,
  EditorSetSelectionSchema,
  SceneOpenSchema,
  ScriptInstanceGetSchema,
  ScriptInstanceSetValueSchema,
  ScriptInstanceUpdateSchema,
  handleActorCreate,
  handleActorFind,
  handleActorGet,
  handleActorSetProperty,
  handleActorUpdate,
  handleEditLeaseBegin,
  handleEditLeaseGet,
  handleEditorGetSelection,
  handleEditorSetSelection,
  handleSceneOpen,
  handleScriptInstanceGet,
  handleScriptInstanceSetValue,
  handleScriptInstanceUpdate,
} from './editorLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ACTOR_ID = 'a'.repeat(32);

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup: () => Promise<void>;
}

async function fixture(bridgeVersion = 5): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-editor-live-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid,
    Project: root,
    Timestamp: Date.now(),
    BridgeVersion: bridgeVersion,
    ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return {
    root,
    ctx: await createProjectContext(root),
    requests,
    responses,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function waitForRequest(directory: string): Promise<{ name: string; body: Record<string, unknown> }> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    const name = (await fs.readdir(directory)).find(item => item.endsWith('.json'));
    if (name) {
      return {
        name,
        body: JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as Record<string, unknown>,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for live-tool request.');
}

async function respond(
  fixtureValue: Fixture,
  response: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const request = await waitForRequest(fixtureValue.requests);
  const body = { token: TOKEN, ...response(request.body) };
  const target = path.join(fixtureValue.responses, request.name);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(body));
  await fs.rename(temporary, target);
  return request.body;
}

test('actor_create maps parameters to bridge DTO and preserves editor-connected structured mode', async () => {
  const f = await fixture();
  try {
    const pending = handleActorCreate(ActorCreateSchema.parse({
      name: 'Spawned',
      type_name: 'FlaxEngine.PointLight',
      parent_id: 'b'.repeat(32),
      active: false,
      position: { x: 1, y: 2, z: 3 },
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, Name: 'Spawned' }),
      timestamp: Date.now(),
    }));
    const result = await pending;
    assert.equal(request.method, 'actor.create');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      TypeName: 'FlaxEngine.PointLight',
      Name: 'Spawned',
      ParentId: 'b'.repeat(32),
      Active: false,
      Position: { X: 1, Y: 2, Z: 3 },
    });
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.mode, 'editor-connected');
    assert.equal(envelope.data.result.Id, ACTOR_ID);
    assert.deepEqual(envelope.changes, [{ kind: 'actor.created', name: 'Spawned' }]);
  } finally {
    await f.cleanup();
  }
});

test('actor_update rejects an empty update without writing an RPC request', async () => {
  const f = await fixture();
  try {
    const result = await handleActorUpdate(ActorUpdateSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('actor_update maps component asset assignments in PascalCase', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorUpdate(ActorUpdateSchema.parse({
      actor_id: ACTOR_ID,
      skinned_model_path: 'Content/Characters/MotusMan/MotusMan_v2.flax',
      update_when_offscreen: true,
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, Name: 'MotusMan' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.update');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      ActorId: ACTOR_ID,
      SkinnedModelPath: 'Content/Characters/MotusMan/MotusMan_v2.flax',
      UpdateWhenOffscreen: true,
    });
    await pending;
  } finally {
    await f.cleanup();
  }
});

test('actor_update maps v7-only local transform and layer fields in PascalCase', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorUpdate(ActorUpdateSchema.parse({
      actor_id: ACTOR_ID,
      local_position: { x: 1, y: 2, z: 3 },
      local_scale: { x: 4, y: 5, z: 6 },
      local_euler_angles: { x: 7, y: 8, z: 9 },
      layer: 31,
      expected_scene_revision: 4,
      lease_id: 'b'.repeat(32),
      idempotency_key: 'local-layer-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, Layer: 31, ProjectRevision: 5, SceneRevision: 5 }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.update');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      ActorId: ACTOR_ID,
      LocalPosition: { X: 1, Y: 2, Z: 3 },
      LocalScale: { X: 4, Y: 5, Z: 6 },
      LocalEulerAngles: { X: 7, Y: 8, Z: 9 },
      Layer: 31,
      ExpectedSceneRevision: 4,
      LeaseId: 'b'.repeat(32),
      IdempotencyKey: 'local-layer-1',
    });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.Layer, 31);
  } finally {
    await f.cleanup();
  }
});

test('actor_update rejects mixed transform spaces before sending an RPC request', async () => {
  const f = await fixture(7);
  try {
    const result = await handleActorUpdate(ActorUpdateSchema.parse({
      actor_id: ACTOR_ID,
      position: { x: 1, y: 2, z: 3 },
      local_position: { x: 4, y: 5, z: 6 },
    }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('v7-only actor patches and find filters fail closed on a pre-v7 bridge', async () => {
  const f = await fixture(6);
  try {
    const patch = await handleActorUpdate(ActorUpdateSchema.parse({
      actor_id: ACTOR_ID, layer: 3,
    }), f.ctx);
    assert.equal(patch.isError, true);
    assert.equal((patch.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');

    const find = await handleActorFind(ActorFindSchema.parse({
      type_name: 'FlaxEngine.EmptyActor',
    }), f.ctx);
    assert.equal(find.isError, true);
    assert.equal((find.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('actor_find maps v7 filters to PascalCase bridge fields', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorFind(ActorFindSchema.parse({
      name: 'Light', type_name: 'FlaxEngine.PointLight', parent_id: 'b'.repeat(32), active: false, max_results: 7,
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true, resultJson: JSON.stringify([]), timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.find');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      Name: 'Light', TypeName: 'FlaxEngine.PointLight', ParentId: 'b'.repeat(32), Active: false, MaxResults: 7,
    });
    assert.equal((await pending).isError, undefined);
  } finally {
    await f.cleanup();
  }
});

test('remote NOT_FOUND maps to the stable tool-domain NOT_FOUND error', async () => {
  const f = await fixture();
  try {
    const pending = handleActorGet(ActorGetSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: false,
      errorCode: 'NOT_FOUND',
      error: 'Actor was not found.',
      resultJson: null,
      timestamp: Date.now(),
    }));
    const result = await pending;
    assert.equal(request.method, 'actor.get');
    assert.equal(result.isError, true);
    const error = (result.structuredContent as any).error;
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'Actor was not found.');
  } finally {
    await f.cleanup();
  }
});

test('actor_create dry-run validates creation and never sends the mutation method', async () => {
  const f = await fixture();
  try {
    const pending = handleActorCreate(ActorCreateSchema.parse({
      name: 'Preview',
      dry_run: true,
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: true,
      resultJson: JSON.stringify({ TypeName: 'FlaxEngine.EmptyActor', ParentId: null }),
      timestamp: Date.now(),
    }));
    const result = await pending;
    assert.equal(request.method, 'actor.validate_create');
    assert.equal(JSON.parse(String(request.paramsJson)).Name, 'Preview');
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.mode, 'editor-connected');
    assert.equal(envelope.data.dryRun, true);
    assert.equal(envelope.data.preview.Name, 'Preview');
    assert.deepEqual(envelope.changes, []);
  } finally {
    await f.cleanup();
  }
});

test('v7 live writes marshal revision, lease, and idempotency fields in PascalCase', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorCreate(ActorCreateSchema.parse({
      name: 'Idempotent',
      parent_id: 'b'.repeat(32),
      expected_scene_revision: 4,
      lease_id: 'c'.repeat(32),
      idempotency_key: 'create-idempotent-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, ProjectRevision: 5, SceneRevision: 5 }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.create');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      TypeName: 'FlaxEngine.EmptyActor', Name: 'Idempotent', ParentId: 'b'.repeat(32), Active: true,
      ExpectedSceneRevision: 4, LeaseId: 'c'.repeat(32), IdempotencyKey: 'create-idempotent-1',
    });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.SceneRevision, 5);
  } finally {
    await f.cleanup();
  }
});

test('script_instance_update accepts an enabled patch and rejects an empty patch without writing', async () => {
  const f = await fixture(7);
  try {
    const rejected = await handleScriptInstanceUpdate(ScriptInstanceUpdateSchema.parse({ script_id: ACTOR_ID }), f.ctx);
    assert.equal(rejected.isError, true);
    assert.equal((rejected.structuredContent as any).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(f.requests), []);

    const pending = handleScriptInstanceUpdate(ScriptInstanceUpdateSchema.parse({
      script_id: ACTOR_ID, enabled: false, expected_scene_revision: 3, lease_id: 'b'.repeat(32), idempotency_key: 'disable-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, Enabled: false, ProjectRevision: 4, SceneRevision: 4 }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'script.instance_update');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      ScriptId: ACTOR_ID, Enabled: false, ExpectedSceneRevision: 3, LeaseId: 'b'.repeat(32), IdempotencyKey: 'disable-1',
    });
    assert.equal(((await pending).structuredContent as any).data.result.Enabled, false);
  } finally {
    await f.cleanup();
  }
});

test('script_instance_get defaults to identity-only and passes include_values through as IncludeValues', async () => {
  const f = await fixture();
  try {
    const defaultPending = handleScriptInstanceGet(ScriptInstanceGetSchema.parse({ script_id: ACTOR_ID }), f.ctx);
    const defaultRequest = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, Enabled: true }),
      timestamp: Date.now(),
    }));
    assert.equal(defaultRequest.method, 'script.instance_get');
    assert.deepEqual(JSON.parse(String(defaultRequest.paramsJson)), { ScriptId: ACTOR_ID });
    const defaultEnvelope = (await defaultPending).structuredContent as Record<string, any>;
    assert.equal(defaultEnvelope.data.result.Enabled, true);

    const valuesPending = handleScriptInstanceGet(ScriptInstanceGetSchema.parse({ script_id: ACTOR_ID, include_values: true }), f.ctx);
    const valuesRequest = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({
        Id: ACTOR_ID, Enabled: true, ValuesIncluded: true, ValuesTruncated: false,
        Values: [
          { Name: 'Speed', Type: 'System.Single', Value: { Kind: 'number', Number: 5.5 }, Reason: null },
          { Name: 'Target', Type: 'FlaxEngine.Actor', Value: null, Reason: 'Unsupported type FlaxEngine.Actor.' },
        ],
        Warnings: ['Script values are a bounded read-only projection of public script fields. Unsupported types are null with a reason. Script writes remain limited to Enabled.'],
      }),
      timestamp: Date.now(),
    }));
    assert.equal(valuesRequest.method, 'script.instance_get');
    assert.deepEqual(JSON.parse(String(valuesRequest.paramsJson)), { ScriptId: ACTOR_ID, IncludeValues: true });
    const valuesEnvelope = (await valuesPending).structuredContent as Record<string, any>;
    assert.equal(valuesEnvelope.data.result.ValuesIncluded, true);
    assert.equal(valuesEnvelope.data.result.Values.length, 2);
    assert.equal(valuesEnvelope.data.result.Values[0].Value.Number, 5.5);
    assert.equal(valuesEnvelope.data.result.Values[1].Value, null);
    assert.match(valuesEnvelope.data.result.Values[1].Reason, /Unsupported type/);
  } finally {
    await f.cleanup();
  }
});

test('script_instance_get delegates bridge errors through the shared mapper', async () => {
  const f = await fixture();
  try {
    const missing = handleScriptInstanceGet(ScriptInstanceGetSchema.parse({ script_id: ACTOR_ID, include_values: true }), f.ctx);
    const missingRequest = await respond(f, body => ({
      id: body.id, ok: false, errorCode: 'NOT_FOUND',
      error: 'Script was not found.', resultJson: null, timestamp: Date.now(),
    }));
    assert.equal(missingRequest.method, 'script.instance_get');
    const missingResult = await missing;
    assert.equal(missingResult.isError, true);
    assert.equal((missingResult.structuredContent as any).error.code, 'NOT_FOUND');

    const gated = handleScriptInstanceGet(ScriptInstanceGetSchema.parse({ script_id: ACTOR_ID }), f.ctx);
    await respond(f, body => ({
      id: body.id, ok: false, errorCode: 'METHOD_NOT_ALLOWED',
      error: "Method 'script.instance_get' is not in the bridge allowlist.",
      resultJson: null, timestamp: Date.now(),
    }));
    const gatedResult = await gated;
    assert.equal(gatedResult.isError, true);
    assert.equal((gatedResult.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally {
    await f.cleanup();
  }
});

test('revision-aware live writes fail closed on a pre-v7 bridge before creating a request', async () => {
  const f = await fixture(6);
  try {
    const result = await handleActorUpdate(ActorUpdateSchema.parse({
      actor_id: ACTOR_ID, name: 'Blocked', expected_scene_revision: 0,
    }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('stale revision bridge errors preserve the current revision in a stable domain error', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorUpdate(ActorUpdateSchema.parse({ actor_id: ACTOR_ID, name: 'Stale', expected_scene_revision: 2 }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: false, errorCode: 'SCENE_REVISION_CONFLICT',
      error: 'ExpectedSceneRevision does not match the current bridge-known scene revision.',
      errorDetails: JSON.stringify({ SceneId: 'b'.repeat(32), ExpectedSceneRevision: 2, CurrentSceneRevision: 3, ProjectRevision: 8 }),
      resultJson: null, timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.update');
    const result = await pending;
    const error = (result.structuredContent as any).error;
    assert.equal(error.code, 'SCENE_REVISION_CONFLICT');
    assert.equal(error.details.CurrentSceneRevision, 3);
    assert.equal(error.details.ProjectRevision, 8);
  } finally {
    await f.cleanup();
  }
});

test('v7 edit leases use explicit lease RPC methods and preserve lease semantics', async () => {
  const f = await fixture(7);
  try {
    const pending = handleEditLeaseBegin(EditLeaseBeginSchema.parse({ scene_id: 'b'.repeat(32), owner: 'fixture', ttl_ms: 10_000 }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ LeaseId: 'c'.repeat(32), SceneId: 'b'.repeat(32), State: 'active', Semantics: 'visible-immediately-no-rollback' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'edit.lease_begin');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { SceneId: 'b'.repeat(32), Owner: 'fixture', TtlMs: 10_000 });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.Semantics, 'visible-immediately-no-rollback');

    const getPending = handleEditLeaseGet(EditLeaseGetSchema.parse({ lease_id: 'c'.repeat(32) }), f.ctx);
    const getRequest = await respond(f, body => ({ id: body.id, ok: false, errorCode: 'NOT_FOUND', error: 'Edit lease was not found or has expired.', resultJson: null, timestamp: Date.now() }));
    assert.equal(getRequest.method, 'edit.lease_get');
    const getResult = await getPending;
    assert.equal((getResult.structuredContent as any).error.code, 'NOT_FOUND');
  } finally {
    await f.cleanup();
  }
});

test('edit lease begin supports a scene-less graph asset scope', async () => {
  assert.equal(EditLeaseBeginSchema.safeParse({ owner: 'graph-smoke' }).success, false);
  assert.equal(EditLeaseBeginSchema.safeParse({ scene_id: 'b'.repeat(32), asset_id: 'a'.repeat(32), owner: 'graph-smoke' }).success, false);
  assert.equal(EditLeaseBeginSchema.safeParse({ asset_id: 'a'.repeat(32), path: 'Content/Graphs/G.flax', owner: 'graph-smoke' }).success, false);
  assert.equal(EditLeaseBeginSchema.safeParse({ asset_id: 'a'.repeat(32), owner: 'graph-smoke' }).success, true);
  const f = await fixture(7);
  try {
    const pending = handleEditLeaseBegin(EditLeaseBeginSchema.parse({ asset_id: 'a'.repeat(32), owner: 'graph-smoke' }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ LeaseId: 'c'.repeat(32), SceneId: 'graph:' + 'a'.repeat(32), State: 'active' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'edit.lease_begin');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { AssetId: 'a'.repeat(32), Owner: 'graph-smoke', TtlMs: 30_000 });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.LeaseId, 'c'.repeat(32));
  } finally {
    await f.cleanup();
  }
});

test('editor_get_selection returns the bounded bridge selection list', async () => {
  const f = await fixture(24);
  try {
    const pending = handleEditorGetSelection(EditorGetSelectionSchema.parse({}), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({
        Selection: [{ ActorId: ACTOR_ID, Name: 'Player', SceneId: 'b'.repeat(32) }],
        Count: 1,
      }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'editor.get_selection');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {});
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.result.Selection, [{ ActorId: ACTOR_ID, Name: 'Player', SceneId: 'b'.repeat(32) }]);
    assert.equal(envelope.data.result.Count, 1);
  } finally {
    await f.cleanup();
  }
});

test('editor_get_selection returns an empty list for an empty selection', async () => {
  const f = await fixture(24);
  try {
    const pending = handleEditorGetSelection(EditorGetSelectionSchema.parse({}), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ Selection: [], Count: 0 }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'editor.get_selection');
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.result.Selection, []);
  } finally {
    await f.cleanup();
  }
});

test('editor_set_selection sends PascalCase ActorIds and returns the new selection', async () => {
  const f = await fixture(24);
  try {
    const pending = handleEditorSetSelection(EditorSetSelectionSchema.parse({
      actor_ids: [ACTOR_ID, 'b'.repeat(32)], focus_viewport: true,
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({
        Selection: [
          { ActorId: ACTOR_ID, Name: 'Player', SceneId: 'c'.repeat(32) },
          { ActorId: 'b'.repeat(32), Name: 'Light', SceneId: 'c'.repeat(32) },
        ],
        Count: 2,
      }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'editor.set_selection');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { ActorIds: [ACTOR_ID, 'b'.repeat(32)], FocusViewport: true });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.result.Count, 2);
    assert.deepEqual(envelope.changes, [{ kind: 'editor.selection', count: 2 }]);
  } finally {
    await f.cleanup();
  }
});

test('editor_set_selection rejects bad GUIDs, empty arrays, and oversized arrays via zod', () => {
  assert.equal(EditorSetSelectionSchema.safeParse({ actor_ids: ['not-a-guid'] }).success, false);
  assert.equal(EditorSetSelectionSchema.safeParse({ actor_ids: [] }).success, false);
  assert.equal(EditorSetSelectionSchema.safeParse({ actor_ids: Array.from({ length: 201 }, () => ACTOR_ID) }).success, false);
  assert.equal(EditorSetSelectionSchema.safeParse({ actor_ids: [ACTOR_ID] }).success, true);
  assert.deepEqual(EditorSetSelectionSchema.parse({ actor_ids: [ACTOR_ID] }), { actor_ids: [ACTOR_ID], focus_viewport: false });
});

test('editor selection tools fail closed on a pre-v24 bridge before creating a request', async () => {
  const f = await fixture(6);
  try {
    const get = await handleEditorGetSelection(EditorGetSelectionSchema.parse({}), f.ctx);
    assert.equal(get.isError, true);
    assert.equal((get.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');

    const set = await handleEditorSetSelection(EditorSetSelectionSchema.parse({ actor_ids: [ACTOR_ID] }), f.ctx);
    assert.equal(set.isError, true);
    assert.equal((set.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('editor_set_selection maps remote NOT_FOUND to the stable tool-domain error', async () => {
  const f = await fixture(24);
  try {
    const pending = handleEditorSetSelection(EditorSetSelectionSchema.parse({ actor_ids: ['d'.repeat(32)] }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: false, errorCode: 'NOT_FOUND',
      error: 'Actor was not found.', resultJson: null, timestamp: Date.now(),
    }));
    assert.equal(request.method, 'editor.set_selection');
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'NOT_FOUND');
  } finally {
    await f.cleanup();
  }
});

test('scene_open sends a PascalCase selector and returns the opening phase', async () => {
  const f = await fixture(25);
  try {
    const pending = handleSceneOpen(SceneOpenSchema.parse({ asset_id: ACTOR_ID }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ SceneId: ACTOR_ID, Phase: 'opening' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'scene.open');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { AssetId: ACTOR_ID, AllowDirtyScenes: false });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.mode, 'editor-connected');
    assert.equal(envelope.data.result.Phase, 'opening');
    assert.equal(envelope.data.result.SceneId, ACTOR_ID);
    assert.deepEqual(envelope.changes, [{ kind: 'scene.opened', id: ACTOR_ID }]);
  } finally {
    await f.cleanup();
  }
});

test('scene_open maps a path selector and explicit dirty acknowledgement in PascalCase', async () => {
  const f = await fixture(25);
  try {
    const pending = handleSceneOpen(SceneOpenSchema.parse({
      path: 'Content/Levels/Arena.scene', allow_dirty_scenes: true,
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ SceneId: 'b'.repeat(32), Phase: 'already_loaded' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'scene.open');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { Path: 'Content/Levels/Arena.scene', AllowDirtyScenes: true });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.Phase, 'already_loaded');
  } finally {
    await f.cleanup();
  }
});

test('scene_open maps a dirty-scene refusal to the stable DIRTY_SCENES domain error', async () => {
  const f = await fixture(25);
  try {
    const pending = handleSceneOpen(SceneOpenSchema.parse({ asset_id: ACTOR_ID }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: false, errorCode: 'DIRTY_SCENE',
      error: 'Edited scenes must be saved or AllowDirtyScenes:true must be explicit before opening a scene: Arena',
      errorDetails: JSON.stringify({ DirtyScenes: ['Arena'] }),
      resultJson: null, timestamp: Date.now(),
    }));
    assert.equal(request.method, 'scene.open');
    const result = await pending;
    assert.equal(result.isError, true);
    const error = (result.structuredContent as any).error;
    assert.equal(error.code, 'DIRTY_SCENES');
    assert.deepEqual(error.details, { DirtyScenes: ['Arena'] });
  } finally {
    await f.cleanup();
  }
});

test('scene_open requires exactly one selector via zod', () => {
  assert.equal(SceneOpenSchema.safeParse({}).success, false);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: ACTOR_ID, path: 'Content/Levels/Arena.scene' }).success, false);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: 'not-a-guid' }).success, false);
  assert.equal(SceneOpenSchema.safeParse({ path: 'Other/Arena.scene' }).success, false);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: ACTOR_ID }).success, true);
  assert.equal(SceneOpenSchema.safeParse({ path: 'Content/Levels/Arena.scene' }).success, true);
  assert.deepEqual(SceneOpenSchema.parse({ asset_id: ACTOR_ID }), { asset_id: ACTOR_ID, allow_dirty_scenes: false });
});

test('scene_open fails closed on a pre-v25 bridge before creating a request', async () => {
  const f = await fixture(24);
  try {
    const result = await handleSceneOpen(SceneOpenSchema.parse({ asset_id: ACTOR_ID }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('script_instance_set_value splits the value union and requires bridge v28', async () => {
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: ACTOR_ID, field: '9bad', value: 1 }).success, false);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: ACTOR_ID, field: 'a'.repeat(129), value: 1 }).success, false);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: ACTOR_ID, field: 'Speed', value: Number.NaN }).success, false);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: ACTOR_ID, field: 'Speed', value: 2.5 }).success, true);
  const f = await fixture(28);
  try {
    const pending = handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({
      script_id: ACTOR_ID, field: 'Speed', value: 2.5,
      expected_scene_revision: 4, lease_id: 'b'.repeat(32), idempotency_key: 'field-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ ScriptId: ACTOR_ID, Field: 'Speed', DryRun: false, WouldChange: true }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'script.instance_set_value');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      ScriptId: ACTOR_ID, Field: 'Speed', Number: 2.5, DryRun: false,
      ExpectedSceneRevision: 4, LeaseId: 'b'.repeat(32), IdempotencyKey: 'field-1',
    });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.WouldChange, true);
    assert.deepEqual(envelope.changes, [{ kind: 'script.field_set', id: ACTOR_ID, field: 'Speed' }]);
  } finally {
    await f.cleanup();
  }
});

test('script_instance_set_value dry-run previews without idempotency or changes', async () => {
  const f = await fixture(28);
  try {
    const pending = handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({
      script_id: ACTOR_ID, field: 'Title', value: 'Hi', dry_run: true, idempotency_key: 'field-dry-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ ScriptId: ACTOR_ID, Field: 'Title', DryRun: true, WouldChange: false }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'script.instance_set_value');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      ScriptId: ACTOR_ID, Field: 'Title', Text: 'Hi', DryRun: true,
    });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.DryRun, true);
    assert.deepEqual(envelope.changes, []);
  } finally {
    await f.cleanup();
  }
});

test('v28 writes fail closed on a pre-v28 bridge before creating a request', async () => {
  const f = await fixture(27);
  try {
    const field = await handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({
      script_id: ACTOR_ID, field: 'Speed', value: 1,
    }), f.ctx);
    assert.equal(field.isError, true);
    assert.equal((field.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');

    const property = await handleActorSetProperty(ActorSetPropertySchema.parse({
      target_id: ACTOR_ID, property: 'Camera.FieldOfView', value: 60,
    }), f.ctx);
    assert.equal(property.isError, true);
    assert.equal((property.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('actor_set_property maps the allowlisted property and value in PascalCase', async () => {
  const f = await fixture(28);
  try {
    const pending = handleActorSetProperty(ActorSetPropertySchema.parse({
      target_id: ACTOR_ID, property: 'Camera.FieldOfView', value: 60,
      expected_scene_revision: 4, lease_id: 'b'.repeat(32), idempotency_key: 'prop-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ ActorId: ACTOR_ID, Property: 'Camera.FieldOfView' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.set_property');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      ActorId: ACTOR_ID, Property: 'Camera.FieldOfView', Number: 60,
      ExpectedSceneRevision: 4, LeaseId: 'b'.repeat(32), IdempotencyKey: 'prop-1',
    });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.Property, 'Camera.FieldOfView');
    assert.deepEqual(envelope.changes, [{ kind: 'actor.property_set', id: ACTOR_ID, property: 'Camera.FieldOfView' }]);
  } finally {
    await f.cleanup();
  }
});
