import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import type { ToolResponse } from '../errors.js';
import {
  ActorSetPropertySchema, MemberPathSchema, SceneOpenSchema, ScriptInstanceSetValueSchema,
  handleActorSetProperty, handleSceneOpen, handleScriptInstanceSetValue,
} from './editorLive.js';
import { RuntimeSetScriptValueSchema, handleRuntimeSetScriptValue } from './runtimeScriptLive.js';
import { buildToolRegistry } from './index.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ACTOR = 'a'.repeat(32);
const SCRIPT = 'b'.repeat(32);
const SCENE_ASSET = 'c'.repeat(32);

interface Fixture { root: string; requests: string; responses: string; ctx: ProjectMeta; cleanup(): Promise<void>; }

async function fixture(version: number): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-v34-scene-member-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: version, ProtocolVersion: 1 }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, requests, responses, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function reply(f: Fixture, result: Record<string, unknown>): Promise<{ method: string; params: Record<string, unknown> }> {
  const deadline = Date.now() + 1000;
  let name: string | undefined;
  while (Date.now() < deadline) {
    name = (await fs.readdir(f.requests)).find(value => value.endsWith('.json'));
    if (name) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!name) throw new Error('No RPC request.');
  const request = JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, string>;
  await fs.writeFile(path.join(f.responses, `${request.id}.json`), JSON.stringify({ id: request.id, token: TOKEN, timestamp: Date.now(), ...result }));
  return { method: request.method, params: JSON.parse(request.paramsJson) };
}

async function roundTrip(f: Fixture, pending: Promise<ToolResponse>, result: Record<string, unknown>) {
  const request = await reply(f, result);
  const response = await pending;
  return { request, envelope: response.structuredContent as Record<string, any>, isError: response.isError === true };
}

const ok = (payload: Record<string, unknown>) => ({ ok: true, resultJson: JSON.stringify(payload) });

test('scene_open replace, reload, and discard_unsaved are mutually consistent and documented', async () => {
  assert.equal(SceneOpenSchema.safeParse({ asset_id: SCENE_ASSET, replace: true }).success, true);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: SCENE_ASSET, reload: true, discard_unsaved: true }).success, true);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: SCENE_ASSET, replace: true, reload: true }).success, false);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: SCENE_ASSET, discard_unsaved: true }).success, false);
  assert.equal(SceneOpenSchema.safeParse({ asset_id: SCENE_ASSET, replace: 'yes' }).success, false);
  // The plain form keeps its exact parse output (no defaults for the new flags).
  assert.deepEqual(SceneOpenSchema.parse({ asset_id: SCENE_ASSET }), { asset_id: SCENE_ASSET, allow_dirty_scenes: false });
  const f = await fixture(34);
  try {
    const tool = buildToolRegistry(f.ctx).find(entry => entry.name === 'scene_open');
    assert.ok(tool);
    assert.match(tool.description, /replace/);
    assert.match(tool.description, /reload/);
    assert.match(tool.description, /poll scene_list_loaded/);
    assert.match(tool.description, /autosave/i);
    assert.match(tool.description, /disk_sha256/);
  } finally { await f.cleanup(); }
});

test('scene_open replace and reload send the v34 flags and pass the unloaded scenes and disk hash through', async () => {
  const f = await fixture(34);
  try {
    const replaced = await roundTrip(
      f,
      handleSceneOpen(SceneOpenSchema.parse({ asset_id: SCENE_ASSET, replace: true, discard_unsaved: true }), f.ctx),
      ok({ SceneId: SCENE_ASSET, Phase: 'replacing', UnloadedSceneIds: ['d'.repeat(32), 'e'.repeat(32)] }),
    );
    assert.equal(replaced.request.method, 'scene.open');
    assert.deepEqual(replaced.request.params, { AssetId: SCENE_ASSET, AllowDirtyScenes: false, Replace: true, DiscardUnsaved: true });
    assert.deepEqual(replaced.envelope.data.result.UnloadedSceneIds, ['d'.repeat(32), 'e'.repeat(32)]);
    assert.deepEqual(replaced.envelope.changes, [{ kind: 'scene.replaced', id: SCENE_ASSET }]);

    const reloaded = await roundTrip(
      f,
      handleSceneOpen(SceneOpenSchema.parse({ path: 'Content/Levels/Arena.scene', reload: true }), f.ctx),
      ok({ SceneId: SCENE_ASSET, Phase: 'reloading', UnloadedSceneIds: [], DiskSha256: 'f'.repeat(64) }),
    );
    assert.deepEqual(reloaded.request.params, { Path: 'Content/Levels/Arena.scene', AllowDirtyScenes: false, Reload: true });
    assert.equal(reloaded.envelope.data.result.DiskSha256, 'f'.repeat(64));
    assert.deepEqual(reloaded.envelope.changes, [{ kind: 'scene.reloaded', id: 'Content/Levels/Arena.scene' }]);
  } finally { await f.cleanup(); }
});

test('scene_open replace and reload fail closed on a v33 bridge, a plain open still runs on v25', async () => {
  const old = await fixture(33);
  try {
    for (const flags of [{ replace: true }, { reload: true }]) {
      const response = await handleSceneOpen(SceneOpenSchema.parse({ asset_id: SCENE_ASSET, ...flags }), old.ctx);
      assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    }
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }
  const v25 = await fixture(25);
  try {
    const plain = await roundTrip(v25, handleSceneOpen(SceneOpenSchema.parse({ asset_id: SCENE_ASSET }), v25.ctx), ok({ SceneId: SCENE_ASSET, Phase: 'opening' }));
    assert.deepEqual(plain.request.params, { AssetId: SCENE_ASSET, AllowDirtyScenes: false });
  } finally { await v25.cleanup(); }
});

test('path schema: 1-4 identifiers, and exactly one of the plain name or path', () => {
  assert.equal(MemberPathSchema.safeParse(['Settings']).success, true);
  assert.equal(MemberPathSchema.safeParse(['A', 'B', 'C', 'D']).success, true);
  assert.equal(MemberPathSchema.safeParse([]).success, false);
  assert.equal(MemberPathSchema.safeParse(['A', 'B', 'C', 'D', 'E']).success, false);
  assert.equal(MemberPathSchema.safeParse(['A.B']).success, false);
  assert.equal(MemberPathSchema.safeParse(['9A']).success, false);
  assert.equal(MemberPathSchema.safeParse(['']).success, false);
  assert.equal(MemberPathSchema.safeParse(['A'.repeat(129)]).success, false);

  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, path: ['Settings', 'Speed'], value: 2 }).success, true);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, field: 'Settings', path: ['Settings', 'Speed'], value: 2 }).success, false);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, value: 2 }).success, false);
  assert.equal(ActorSetPropertySchema.safeParse({ target_id: ACTOR, path: ['Stats', 'Max'], value: 2 }).success, true);
  assert.equal(ActorSetPropertySchema.safeParse({ target_id: ACTOR, property: 'Stats', path: ['Stats', 'Max'], value: 2 }).success, false);
  assert.equal(ActorSetPropertySchema.safeParse({ target_id: ACTOR, value: 2 }).success, false);
  assert.equal(RuntimeSetScriptValueSchema.safeParse({ script_id: SCRIPT, path: ['Stats', 'Max'], value: 2 }).success, true);
  assert.equal(RuntimeSetScriptValueSchema.safeParse({ script_id: SCRIPT, member: 'Stats', path: ['Stats', 'Max'], value: 2 }).success, false);
  assert.equal(RuntimeSetScriptValueSchema.safeParse({ script_id: SCRIPT, value: 2 }).success, false);
  assert.equal(RuntimeSetScriptValueSchema.safeParse({ script_id: SCRIPT, member: 'Speed', value: 2 }).success, true);
});

test('script_instance_set_value takes the actor_set_property value forms (asset references, quaternion, clear)', async () => {
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, field: 'Mesh', value: 'engine:Editor/Primitives/Cube' }).success, true);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, field: 'Rotation', value: '0,0,0,1' }).success, true);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, field: 'Mesh', value: '' }).success, true);
  assert.equal(ScriptInstanceSetValueSchema.safeParse({ script_id: SCRIPT, field: 'Mesh', value: { id: 1 } }).success, false);
  const description = (ScriptInstanceSetValueSchema as any)._def.schema.shape.value.description as string;
  assert.match(description, /engine:<path>/);
  assert.match(description, /quaternions/);
  assert.match(description, /"" clears/);
  const f = await fixture(34);
  try {
    const result = await roundTrip(
      f,
      handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({ script_id: SCRIPT, field: 'Mesh', value: 'Content/Models/Crate.flax' }), f.ctx),
      ok({ ScriptId: SCRIPT, Field: 'Mesh', Type: 'FlaxEngine.Model', DryRun: false, WouldChange: true, Before: { Kind: 'null' }, After: { Kind: 'asset', AssetId: 'd'.repeat(32) } }),
    );
    assert.deepEqual(result.request.params, { ScriptId: SCRIPT, Field: 'Mesh', Text: 'Content/Models/Crate.flax', DryRun: false });
    assert.deepEqual(result.envelope.changes, [{ kind: 'script.field_set', id: SCRIPT, field: 'Mesh' }]);
    // A write of the value the member already held changes nothing.
    const unchanged = await roundTrip(
      f,
      handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({ script_id: SCRIPT, field: 'Mesh', value: 'Content/Models/Crate.flax' }), f.ctx),
      ok({ ScriptId: SCRIPT, Field: 'Mesh', DryRun: false, WouldChange: false }),
    );
    assert.deepEqual(unchanged.envelope.changes, []);
  } finally { await f.cleanup(); }
});

test('nested path writes send Path without the plain name and need bridge v34', async () => {
  const f = await fixture(34);
  try {
    const script = await roundTrip(
      f,
      handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({ script_id: SCRIPT, path: ['Settings', 'Speed'], value: 2.5, dry_run: true }), f.ctx),
      ok({ ScriptId: SCRIPT, Field: 'Settings.Speed', Type: 'System.Single', DryRun: true, WouldChange: true, Path: ['Settings', 'Speed'], Before: { Kind: 'number', Number: 1 }, After: { Kind: 'number', Number: 2.5 } }),
    );
    assert.equal(script.request.method, 'script.instance_set_value');
    assert.deepEqual(script.request.params, { ScriptId: SCRIPT, Path: ['Settings', 'Speed'], Number: 2.5, DryRun: true });
    assert.deepEqual(script.envelope.data.result.Path, ['Settings', 'Speed']);
    assert.deepEqual(script.envelope.changes, []);

    const real = await roundTrip(
      f,
      handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({ script_id: SCRIPT, path: ['Settings', 'Limits', 'Max'], value: 9 }), f.ctx),
      ok({ ScriptId: SCRIPT, Field: 'Settings.Limits.Max', DryRun: false, WouldChange: true, Path: ['Settings', 'Limits', 'Max'] }),
    );
    assert.deepEqual(real.envelope.changes, [{ kind: 'script.field_set', id: SCRIPT, field: 'Settings.Limits.Max' }]);

    const actor = await roundTrip(
      f,
      handleActorSetProperty(ActorSetPropertySchema.parse({ target_id: ACTOR, path: ['Stats', 'Max'], value: '1,2,3', idempotency_key: 'k1' }), f.ctx),
      ok({ ActorId: ACTOR, Property: 'Stats.Max', WouldChange: true, Path: ['Stats', 'Max'] }),
    );
    assert.equal(actor.request.method, 'actor.set_property');
    assert.deepEqual(actor.request.params, { ActorId: ACTOR, Path: ['Stats', 'Max'], Text: '1,2,3', IdempotencyKey: 'k1' });
    assert.deepEqual(actor.envelope.changes, [{ kind: 'actor.property_set', id: ACTOR, property: 'Stats.Max' }]);

    const runtime = await roundTrip(
      f,
      handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT, path: ['Stats', 'Max'], value: true }), f.ctx),
      ok({ ScriptId: SCRIPT, Member: 'Stats.Max', Path: ['Stats', 'Max'], PlaySessionId: 'p1' }),
    );
    assert.equal(runtime.request.method, 'runtime.set_script_value');
    assert.deepEqual(runtime.request.params, { ScriptId: SCRIPT, Path: ['Stats', 'Max'], Bool: true });
    assert.deepEqual(runtime.envelope.changes, [{ kind: 'runtime.script_value_set', id: SCRIPT, member: 'Stats.Max' }]);

    // The plain member form is unchanged on the wire.
    const plain = await roundTrip(
      f,
      handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT, member: 'Speed', value: 3 }), f.ctx),
      ok({ ScriptId: SCRIPT, Member: 'Speed', PlaySessionId: 'p1' }),
    );
    assert.deepEqual(plain.request.params, { ScriptId: SCRIPT, Member: 'Speed', Number: 3 });
  } finally { await f.cleanup(); }

  const old = await fixture(33);
  try {
    const calls: Array<() => Promise<ToolResponse>> = [
      () => handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({ script_id: SCRIPT, path: ['A', 'B'], value: 1 }), old.ctx),
      () => handleActorSetProperty(ActorSetPropertySchema.parse({ target_id: ACTOR, path: ['A', 'B'], value: 1 }), old.ctx),
      () => handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT, path: ['A', 'B'], value: 1 }), old.ctx),
    ];
    for (const call of calls) {
      const response = await call();
      assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    }
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }
});

test('a nested path failure names the failing segment', async () => {
  const f = await fixture(34);
  try {
    const failed = await roundTrip(
      f,
      handleScriptInstanceSetValue(ScriptInstanceSetValueSchema.parse({ script_id: SCRIPT, path: ['Settings', 'Hidden'], value: 1 }), f.ctx),
      {
        ok: false,
        errorCode: 'VALIDATION_FAILED',
        error: "Path segment 1 ('Hidden'): is not an editor-visible member of Game.Settings (public or [ShowInEditor], never [HideInEditor]).",
        errorDetails: JSON.stringify({ Path: ['Settings', 'Hidden'], SegmentIndex: 1, Segment: 'Hidden' }),
      },
    );
    assert.equal(failed.isError, true);
    assert.equal(failed.envelope.error.code, 'VALIDATION_FAILED');
    assert.match(failed.envelope.error.message, /Path segment 1 \('Hidden'\)/);
  } finally { await f.cleanup(); }
});
