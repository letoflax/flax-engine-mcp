import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import type { ToolResponse } from '../errors.js';
import { ActorSetPropertySchema, handleActorSetProperty } from './editorLive.js';
import {
  ActorGetPropertiesSchema, ParticleGetParametersSchema, ParticleSetParameterSchema, UiControlCreateSchema, UiControlGetPropertiesSchema, UiControlSetPropertySchema,
  handleActorGetProperties, handleParticleGetParameters, handleParticleSetParameter, handleUiControlCreate, handleUiControlGetProperties, handleUiControlSetProperty,
} from './memberLive.js';
import { RuntimeInvokeScriptMethodSchema, RuntimeSetScriptValueSchema, handleRuntimeInvokeScriptMethod, handleRuntimeSetScriptValue } from './runtimeScriptLive.js';
import {
  SettingsAddTagSchema, SettingsRemoveInputMappingSchema, SettingsSetFirstSceneSchema, SettingsSetInputActionSchema, SettingsSetInputAxisSchema, SettingsSetLayerNameSchema,
  handleSettingsAddTag, handleSettingsRemoveInputMapping, handleSettingsSetFirstScene, handleSettingsSetInputAction, handleSettingsSetInputAxis, handleSettingsSetLayerName,
} from './settingsLive.js';
import {
  AssetCreateSchema, ContentCreateFolderSchema, SceneCloseSchema, SceneCreateSchema,
  handleAssetCreate, handleContentCreateFolder, handleSceneClose, handleSceneCreate,
} from './contentLifecycleLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ACTOR = 'a'.repeat(32);
const SCRIPT = 'b'.repeat(32);
const SCENE = 'c'.repeat(32);

interface Fixture { root: string; requests: string; responses: string; ctx: ProjectMeta; cleanup(): Promise<void>; }

async function fixture(version = 33): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-v33-'));
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
  if (!name) throw new Error('No v33 RPC request.');
  const request = JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, string>;
  await fs.writeFile(path.join(f.responses, `${request.id}.json`), JSON.stringify({ id: request.id, token: TOKEN, timestamp: Date.now(), ...result }));
  return { method: request.method, params: JSON.parse(request.paramsJson) };
}

/** Runs one handler against the fixture, answers its single RPC, and returns both sides. */
async function roundTrip(
  f: Fixture,
  pending: Promise<ToolResponse>,
  result: Record<string, unknown>,
): Promise<{ request: { method: string; params: Record<string, unknown> }; envelope: Record<string, any>; isError: boolean }> {
  const request = await reply(f, result);
  const response = await pending;
  return { request, envelope: response.structuredContent as Record<string, any>, isError: response.isError === true };
}

const ok = (payload: Record<string, unknown>) => ({ ok: true, resultJson: JSON.stringify(payload) });

test('v33 schemas bound member names, confirmations, and creation targets', () => {
  assert.equal(ActorGetPropertiesSchema.safeParse({ actor_id: ACTOR, limit: 257 }).success, false);
  assert.equal(ActorGetPropertiesSchema.parse({ actor_id: ACTOR }).limit, 128);
  assert.equal(UiControlSetPropertySchema.safeParse({ actor_id: ACTOR, property: 'Text', value: 'Play' }).success, true);
  assert.equal(UiControlSetPropertySchema.safeParse({ actor_id: ACTOR, property: 'A.B.C', value: 1 }).success, false);
  assert.equal(UiControlSetPropertySchema.safeParse({ actor_id: ACTOR, property: 'Bad-Name', value: 1 }).success, false);
  assert.equal(RuntimeInvokeScriptMethodSchema.safeParse({ script_id: SCRIPT, method: 'Jump', args: [1, 2, 3, 4, 5] }).success, false);
  assert.equal(RuntimeInvokeScriptMethodSchema.safeParse({ script_id: SCRIPT, method: 'get-Value' }).success, false);
  assert.deepEqual(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT, method: 'Jump' }).args, []);

  // Durable settings writes need an explicit confirm unless they are previews.
  assert.equal(SettingsSetInputActionSchema.safeParse({ name: 'Jump', key: 'Spacebar' }).success, false);
  assert.equal(SettingsSetInputActionSchema.safeParse({ name: 'Jump', key: 'Spacebar', dry_run: true }).success, true);
  assert.equal(SettingsSetInputActionSchema.safeParse({ name: 'Jump', key: 'Spacebar', confirm: true }).success, true);
  assert.equal(SettingsSetInputActionSchema.safeParse({ name: 'Jump', confirm: true }).success, false);
  assert.equal(SettingsSetInputActionSchema.safeParse({ name: 'Jump', key: '42', confirm: true }).success, false);
  assert.equal(SettingsSetInputAxisSchema.safeParse({ name: 'Move', confirm: true }).success, false);
  assert.equal(SettingsSetInputAxisSchema.safeParse({ name: 'Look', axis: 'MouseX', confirm: true }).success, true);
  assert.equal(SettingsSetInputAxisSchema.safeParse({ name: 'Move', positive_button: 'D', dead_zone: 2, confirm: true }).success, false);
  assert.equal(SettingsSetLayerNameSchema.safeParse({ index: 32, name: 'Enemy', confirm: true }).success, false);
  assert.equal(SettingsSetFirstSceneSchema.safeParse({ confirm: true }).success, false);
  assert.equal(SettingsSetFirstSceneSchema.safeParse({ asset_id: SCENE, path: 'Content/A.scene', confirm: true }).success, false);

  assert.equal(SceneCreateSchema.safeParse({ path: 'Content/Scenes/Level.flax', confirm: true }).success, false);
  assert.equal(SceneCreateSchema.safeParse({ path: 'Content/../Level.scene', confirm: true }).success, false);
  assert.equal(SceneCreateSchema.safeParse({ path: 'Content/Scenes/Level.scene' }).success, false);
  assert.equal(ContentCreateFolderSchema.safeParse({ path: 'Content' }).success, false);
  assert.equal(ContentCreateFolderSchema.safeParse({ path: 'Content/Gameplay/' }).success, false);
  assert.equal(ContentCreateFolderSchema.safeParse({ path: 'Content/Gameplay/Enemies' }).success, true);
  assert.equal(AssetCreateSchema.safeParse({ kind: 'Material', path: 'Content/M.json', confirm: true }).success, false);
  assert.equal(AssetCreateSchema.safeParse({ kind: 'Material', path: 'Content/M.flax', type_name: 'Game.Data', confirm: true }).success, false);
  assert.equal(AssetCreateSchema.safeParse({ kind: 'JsonAsset', path: 'Content/D.json', confirm: true }).success, false);
  assert.equal(AssetCreateSchema.safeParse({ kind: 'JsonAsset', path: 'Content/D.json', type_name: 'Game.Data', confirm: true }).success, true);
  assert.equal(AssetCreateSchema.safeParse({ kind: 'Texture', path: 'Content/T.flax', confirm: true }).success, false);
});

test('every v33 tool fails closed on a v32 bridge before any RPC', async () => {
  const f = await fixture(32);
  try {
    // The bridge client is single-flight per project, so the calls run one at a time.
    const calls: Array<() => Promise<ToolResponse>> = [
      () => handleActorGetProperties(ActorGetPropertiesSchema.parse({ actor_id: ACTOR }), f.ctx),
      () => handleUiControlCreate(UiControlCreateSchema.parse({ parent_id: ACTOR }), f.ctx),
      () => handleUiControlGetProperties(UiControlGetPropertiesSchema.parse({ actor_id: ACTOR }), f.ctx),
      () => handleUiControlSetProperty(UiControlSetPropertySchema.parse({ actor_id: ACTOR, property: 'Text', value: 'x' }), f.ctx),
      () => handleParticleGetParameters(ParticleGetParametersSchema.parse({ actor_id: ACTOR }), f.ctx),
      () => handleParticleSetParameter(ParticleSetParameterSchema.parse({ actor_id: ACTOR, name: 'Rate', value: 5 }), f.ctx),
      () => handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT, member: 'Speed', value: 5 }), f.ctx),
      () => handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT, method: 'Jump' }), f.ctx),
      () => handleSettingsSetInputAction(SettingsSetInputActionSchema.parse({ name: 'Jump', key: 'Spacebar', dry_run: true }), f.ctx),
      () => handleSettingsSetInputAxis(SettingsSetInputAxisSchema.parse({ name: 'Look', axis: 'MouseX', dry_run: true }), f.ctx),
      () => handleSettingsRemoveInputMapping(SettingsRemoveInputMappingSchema.parse({ kind: 'action', name: 'Jump', dry_run: true }), f.ctx),
      () => handleSettingsSetLayerName(SettingsSetLayerNameSchema.parse({ index: 3, name: 'Enemy', dry_run: true }), f.ctx),
      () => handleSettingsAddTag(SettingsAddTagSchema.parse({ tag: 'Enemy', dry_run: true }), f.ctx),
      () => handleSettingsSetFirstScene(SettingsSetFirstSceneSchema.parse({ asset_id: SCENE, dry_run: true }), f.ctx),
      () => handleSceneCreate(SceneCreateSchema.parse({ path: 'Content/Scenes/L.scene', dry_run: true }), f.ctx),
      () => handleSceneClose(SceneCloseSchema.parse({ scene_id: SCENE }), f.ctx),
      () => handleContentCreateFolder(ContentCreateFolderSchema.parse({ path: 'Content/Gameplay' }), f.ctx),
      () => handleAssetCreate(AssetCreateSchema.parse({ kind: 'Material', path: 'Content/M.flax', dry_run: true }), f.ctx),
      // Generic members and dry-run previews of actor_set_property are v33 too.
      () => handleActorSetProperty(ActorSetPropertySchema.parse({ target_id: ACTOR, property: 'Mass', value: 5 }), f.ctx),
      () => handleActorSetProperty(ActorSetPropertySchema.parse({ target_id: ACTOR, property: 'Camera.FieldOfView', value: 60, dry_run: true }), f.ctx),
    ];
    for (const call of calls) {
      const response = await call();
      assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    }
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('actor_set_property sends generic members and dry-run previews to a v33 bridge', async () => {
  const f = await fixture();
  try {
    const write = await roundTrip(f, handleActorSetProperty(ActorSetPropertySchema.parse({
      target_id: ACTOR, property: 'RigidBody.Mass', value: 12.5, expected_scene_revision: 2, idempotency_key: 'mass-1',
    }), f.ctx), ok({ ActorId: ACTOR, Property: 'Mass', WouldChange: true }));
    assert.equal(write.request.method, 'actor.set_property');
    assert.deepEqual(write.request.params, { ActorId: ACTOR, Property: 'RigidBody.Mass', Number: 12.5, ExpectedSceneRevision: 2, IdempotencyKey: 'mass-1' });
    assert.deepEqual(write.envelope.changes, [{ kind: 'actor.property_set', id: ACTOR, property: 'RigidBody.Mass' }]);

    // A preview carries DryRun, never consumes the idempotency key, and reports no change.
    const preview = await roundTrip(f, handleActorSetProperty(ActorSetPropertySchema.parse({
      target_id: ACTOR, property: 'Clip', value: '', dry_run: true, idempotency_key: 'clip-1',
    }), f.ctx), ok({ ActorId: ACTOR, Property: 'Clip', DryRun: true, WouldChange: true }));
    assert.deepEqual(preview.request.params, { ActorId: ACTOR, Property: 'Clip', Text: '', DryRun: true });
    assert.deepEqual(preview.envelope.changes, []);

    // Writing the value the member already holds changes nothing, so nothing is reported.
    const noop = await roundTrip(f, handleActorSetProperty(ActorSetPropertySchema.parse({ target_id: ACTOR, property: 'Mass', value: 12.5 }), f.ctx),
      ok({ ActorId: ACTOR, Property: 'Mass', DryRun: false, WouldChange: false }));
    assert.deepEqual(noop.envelope.changes, []);
    const uiNoop = await roundTrip(f, handleUiControlSetProperty(UiControlSetPropertySchema.parse({ actor_id: ACTOR, property: 'Text', value: 'Play' }), f.ctx),
      ok({ ActorId: ACTOR, Property: 'Text', DryRun: false, WouldChange: false }));
    assert.deepEqual(uiNoop.envelope.changes, []);
  } finally { await f.cleanup(); }
});

test('member reads and UI writes marshal PascalCase DTOs and surface bridge warnings', async () => {
  const f = await fixture();
  try {
    const listed = await roundTrip(f, handleActorGetProperties(ActorGetPropertiesSchema.parse({ actor_id: ACTOR, filter: 'mass', include_unsupported: true, limit: 20 }), f.ctx),
      ok({ ActorId: ACTOR, Target: 'actor', Members: [{ Name: 'Mass', Kind: 'number', Writable: true }], Warnings: ['mirrors the property grid'] }));
    assert.equal(listed.request.method, 'actor.get_properties');
    assert.deepEqual(listed.request.params, { ActorId: ACTOR, Filter: 'mass', IncludeUnsupported: true, Limit: 20 });
    assert.equal(listed.envelope.mode, 'editor-connected');
    assert.deepEqual(listed.envelope.warnings, ['mirrors the property grid']);
    assert.deepEqual(listed.envelope.changes, []);

    const controls = await roundTrip(f, handleUiControlGetProperties(UiControlGetPropertiesSchema.parse({ actor_id: ACTOR }), f.ctx), ok({ Target: 'control', Members: [] }));
    assert.equal(controls.request.method, 'ui.get_control_properties');
    assert.deepEqual(controls.request.params, { ActorId: ACTOR, IncludeUnsupported: false, Limit: 128 });

    const created = await roundTrip(f, handleUiControlCreate(UiControlCreateSchema.parse({ parent_id: ACTOR, control_type: 'FlaxEngine.GUI.Label', name: 'Title', lease_id: 'd'.repeat(32) }), f.ctx),
      ok({ DryRun: false, ControlType: 'FlaxEngine.GUI.Label' }));
    assert.equal(created.request.method, 'ui.create_control');
    assert.deepEqual(created.request.params, { ParentId: ACTOR, ControlType: 'FlaxEngine.GUI.Label', Name: 'Title', DryRun: false, LeaseId: 'd'.repeat(32) });
    assert.deepEqual(created.envelope.changes, [{ kind: 'ui.control_created', parentId: ACTOR, controlType: 'FlaxEngine.GUI.Label' }]);

    const set = await roundTrip(f, handleUiControlSetProperty(UiControlSetPropertySchema.parse({ actor_id: ACTOR, property: 'Visible', value: false, dry_run: true, idempotency_key: 'k' }), f.ctx),
      ok({ DryRun: true, WouldChange: true }));
    assert.equal(set.request.method, 'ui.set_control_property');
    assert.deepEqual(set.request.params, { ActorId: ACTOR, Property: 'Visible', Bool: false, DryRun: true });
    assert.deepEqual(set.envelope.changes, []);
  } finally { await f.cleanup(); }
});

test('particle parameter tools marshal track selection and scalar values', async () => {
  const f = await fixture();
  try {
    const listed = await roundTrip(f, handleParticleGetParameters(ParticleGetParametersSchema.parse({ actor_id: ACTOR }), f.ctx), ok({ ActorId: ACTOR, Parameters: [] }));
    assert.equal(listed.request.method, 'particle.get_parameters');
    assert.deepEqual(listed.request.params, { ActorId: ACTOR });

    const set = await roundTrip(f, handleParticleSetParameter(ParticleSetParameterSchema.parse({ actor_id: ACTOR, track: 'Sparks', name: 'Color', value: '#ff8800' }), f.ctx),
      ok({ ActorId: ACTOR, Name: 'Color', WouldChange: true }));
    assert.equal(set.request.method, 'particle.set_parameter');
    assert.deepEqual(set.request.params, { ActorId: ACTOR, Track: 'Sparks', Name: 'Color', Text: '#ff8800', DryRun: false });
    assert.deepEqual(set.envelope.changes, [{ kind: 'particle.parameter_set', id: ACTOR, name: 'Color' }]);
  } finally { await f.cleanup(); }
});

test('runtime script tools split scalar arguments and map a wrong play state', async () => {
  const f = await fixture();
  try {
    const set = await roundTrip(f, handleRuntimeSetScriptValue(RuntimeSetScriptValueSchema.parse({ script_id: SCRIPT, member: 'MoveInput', value: '1,0' }), f.ctx),
      ok({ ScriptId: SCRIPT, Member: 'MoveInput', Warnings: ['Runtime write'] }));
    assert.equal(set.request.method, 'runtime.set_script_value');
    assert.deepEqual(set.request.params, { ScriptId: SCRIPT, Member: 'MoveInput', Text: '1,0' });
    assert.deepEqual(set.envelope.warnings, ['Runtime write']);

    const invoked = await roundTrip(f, handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT, method: 'ApplyDamage', args: [25, true, 'fire'] }), f.ctx),
      ok({ ScriptId: SCRIPT, Method: 'ApplyDamage', Invoked: true, Threw: true, ExceptionType: 'System.InvalidOperationException' }));
    assert.equal(invoked.request.method, 'runtime.invoke_script_method');
    assert.deepEqual(invoked.request.params, { ScriptId: SCRIPT, Method: 'ApplyDamage', Args: [{ Number: 25 }, { Bool: true }, { Text: 'fire' }] });
    // A game exception is data, not a tool failure, and the invocation is still reported.
    assert.equal(invoked.isError, false);
    assert.equal(invoked.envelope.data.result.Threw, true);
    assert.deepEqual(invoked.envelope.changes, [{ kind: 'runtime.script_method_invoked', id: SCRIPT, method: 'ApplyDamage' }]);

    const stopped = await roundTrip(f, handleRuntimeInvokeScriptMethod(RuntimeInvokeScriptMethodSchema.parse({ script_id: SCRIPT, method: 'Jump' }), f.ctx),
      { ok: false, errorCode: 'INVALID_STATE', error: 'runtime.invoke_script_method requires play mode.' });
    assert.equal(stopped.isError, true);
    assert.equal(stopped.envelope.error.code, 'INVALID_PLAY_STATE');
  } finally { await f.cleanup(); }
});

test('settings writes marshal confirmations and report a change only when saved', async () => {
  const f = await fixture();
  try {
    const preview = await roundTrip(f, handleSettingsSetInputAction(SettingsSetInputActionSchema.parse({ name: 'Jump', key: 'Spacebar', dry_run: true }), f.ctx),
      ok({ Operation: 'set_input_action', DryRun: true, Saved: false, WouldChange: true }));
    assert.equal(preview.request.method, 'settings.set_input_action');
    assert.deepEqual(preview.request.params, { Name: 'Jump', Mode: 'Pressing', Key: 'Spacebar', Gamepad: 'All', Replace: false, DryRun: true, Confirm: false });
    assert.deepEqual(preview.envelope.changes, []);

    const saved = await roundTrip(f, handleSettingsSetInputAction(SettingsSetInputActionSchema.parse({ name: 'Fire', mouse_button: 'Left', mode: 'Press', replace: true, confirm: true }), f.ctx),
      ok({ Operation: 'set_input_action', DryRun: false, Saved: true, WouldChange: true }));
    assert.deepEqual(saved.request.params, { Name: 'Fire', Mode: 'Press', MouseButton: 'Left', Gamepad: 'All', Replace: true, DryRun: false, Confirm: true });
    assert.deepEqual(saved.envelope.changes, [{ kind: 'settings.input_action_set', name: 'Fire' }]);

    const axis = await roundTrip(f, handleSettingsSetInputAxis(SettingsSetInputAxisSchema.parse({ name: 'Horizontal', positive_button: 'D', negative_button: 'A', sensitivity: 5, gravity: 5, snap: true, confirm: true }), f.ctx),
      ok({ Operation: 'set_input_axis', Saved: true }));
    assert.equal(axis.request.method, 'settings.set_input_axis');
    assert.deepEqual(axis.request.params, {
      Name: 'Horizontal', Axis: 'KeyboardOnly', PositiveButton: 'D', NegativeButton: 'A', Gamepad: 'All',
      DeadZone: 0.1, Sensitivity: 5, Gravity: 5, Scale: 1, Snap: true, Replace: false, DryRun: false, Confirm: true,
    });

    const removed = await roundTrip(f, handleSettingsRemoveInputMapping(SettingsRemoveInputMappingSchema.parse({ kind: 'axis', name: 'Horizontal', confirm: true }), f.ctx),
      ok({ Operation: 'remove_input_mapping', Saved: true, RemovedCount: 1 }));
    assert.deepEqual(removed.request.params, { Kind: 'axis', Name: 'Horizontal', DryRun: false, Confirm: true });
    assert.deepEqual(removed.envelope.changes, [{ kind: 'settings.input_mapping_removed', mappingKind: 'axis', name: 'Horizontal' }]);

    const layer = await roundTrip(f, handleSettingsSetLayerName(SettingsSetLayerNameSchema.parse({ index: 4, name: 'Enemy', confirm: true }), f.ctx),
      ok({ Operation: 'set_layer_name', Saved: false, WouldChange: false }));
    assert.deepEqual(layer.request.params, { Index: 4, Name: 'Enemy', DryRun: false, Confirm: true });
    // The layer already had that name: nothing was saved, so nothing changed.
    assert.deepEqual(layer.envelope.changes, []);

    const tag = await roundTrip(f, handleSettingsAddTag(SettingsAddTagSchema.parse({ tag: 'Pickup', confirm: true }), f.ctx), ok({ Saved: true }));
    assert.equal(tag.request.method, 'settings.add_tag');
    assert.deepEqual(tag.request.params, { Tag: 'Pickup', DryRun: false, Confirm: true });

    const first = await roundTrip(f, handleSettingsSetFirstScene(SettingsSetFirstSceneSchema.parse({ path: 'Content/Scenes/Menu.scene', confirm: true }), f.ctx), ok({ Saved: true }));
    assert.equal(first.request.method, 'settings.set_first_scene');
    assert.deepEqual(first.request.params, { Path: 'Content/Scenes/Menu.scene', DryRun: false, Confirm: true });
    assert.deepEqual(first.envelope.changes, [{ kind: 'settings.first_scene_set', scene: 'Content/Scenes/Menu.scene' }]);
  } finally { await f.cleanup(); }
});

test('settings writes map the open-window and play-mode refusals to EDITOR_BUSY', async () => {
  const f = await fixture();
  try {
    const open = await roundTrip(f, handleSettingsAddTag(SettingsAddTagSchema.parse({ tag: 'Pickup', confirm: true }), f.ctx),
      { ok: false, errorCode: 'EDITOR_BUSY', error: 'Layers and Tags settings are open in an Editor window.' });
    assert.equal(open.envelope.error.code, 'EDITOR_BUSY');
    const playing = await roundTrip(f, handleSettingsAddTag(SettingsAddTagSchema.parse({ tag: 'Pickup', confirm: true }), f.ctx),
      { ok: false, errorCode: 'INVALID_STATE', error: 'settings.add_tag is unavailable while the editor is in play mode or play was requested.' });
    assert.equal(playing.envelope.error.code, 'EDITOR_BUSY');
  } finally { await f.cleanup(); }
});

test('scene and content lifecycle tools marshal DTOs and report only real creations', async () => {
  const f = await fixture();
  try {
    const scene = await roundTrip(f, handleSceneCreate(SceneCreateSchema.parse({ path: 'Content/Scenes/Level02.scene', confirm: true, idempotency_key: 'scene-1' }), f.ctx),
      ok({ DryRun: false, Created: true, Path: 'Content/Scenes/Level02.scene', SceneId: SCENE, Warnings: ['not opened'] }));
    assert.equal(scene.request.method, 'scene.create');
    assert.deepEqual(scene.request.params, { Path: 'Content/Scenes/Level02.scene', DryRun: false, Confirm: true, IdempotencyKey: 'scene-1' });
    assert.deepEqual(scene.envelope.changes, [{ kind: 'scene.created', path: 'Content/Scenes/Level02.scene' }]);
    assert.deepEqual(scene.envelope.warnings, ['not opened']);

    const close = await roundTrip(f, handleSceneClose(SceneCloseSchema.parse({ scene_id: SCENE, allow_dirty: true }), f.ctx), ok({ SceneId: SCENE, Phase: 'closing' }));
    assert.equal(close.request.method, 'scene.close');
    assert.deepEqual(close.request.params, { SceneId: SCENE, AllowDirty: true });

    const existing = await roundTrip(f, handleContentCreateFolder(ContentCreateFolderSchema.parse({ path: 'Content/Gameplay' }), f.ctx),
      ok({ Created: false, AlreadyExists: true, Path: 'Content/Gameplay' }));
    assert.equal(existing.request.method, 'content.create_folder');
    assert.deepEqual(existing.request.params, { Path: 'Content/Gameplay', DryRun: false });
    assert.deepEqual(existing.envelope.changes, []);

    const asset = await roundTrip(f, handleAssetCreate(AssetCreateSchema.parse({ kind: 'JsonAsset', path: 'Content/Data/Ice.json', type_name: 'FlaxEngine.PhysicalMaterial', dry_run: true, idempotency_key: 'ice' }), f.ctx),
      ok({ DryRun: true, Created: false, Kind: 'JsonAsset' }));
    assert.equal(asset.request.method, 'asset.create');
    assert.deepEqual(asset.request.params, { Kind: 'JsonAsset', Path: 'Content/Data/Ice.json', TypeName: 'FlaxEngine.PhysicalMaterial', DryRun: true, Confirm: false });
    assert.deepEqual(asset.envelope.changes, []);
  } finally { await f.cleanup(); }
});

test('lifecycle tools keep bridge conflict codes instead of collapsing them to INTERNAL_ERROR', async () => {
  const f = await fixture();
  try {
    const exists = await roundTrip(f, handleAssetCreate(AssetCreateSchema.parse({ kind: 'Material', path: 'Content/M.flax', confirm: true }), f.ctx),
      { ok: false, errorCode: 'FILE_EXISTS', error: 'A file already exists at the requested destination.' });
    assert.equal(exists.envelope.error.code, 'FILE_EXISTS');

    const dirty = await roundTrip(f, handleSceneClose(SceneCloseSchema.parse({ scene_id: SCENE }), f.ctx),
      { ok: false, errorCode: 'DIRTY_SCENE', error: 'The scene has unsaved edits.', errorDetails: JSON.stringify({ DirtyScenes: ['Main'] }) });
    assert.equal(dirty.envelope.error.code, 'DIRTY_SCENES');
    assert.deepEqual(dirty.envelope.error.details, { DirtyScenes: ['Main'] });

    const stale = await roundTrip(f, handleUiControlSetProperty(UiControlSetPropertySchema.parse({ actor_id: ACTOR, property: 'Width', value: 200, expected_scene_revision: 1 }), f.ctx),
      { ok: false, errorCode: 'SCENE_REVISION_CONFLICT', error: 'ExpectedSceneRevision does not match.', errorDetails: JSON.stringify({ CurrentSceneRevision: 4 }) });
    assert.equal(stale.envelope.error.code, 'SCENE_REVISION_CONFLICT');

    const headless = await roundTrip(f, handleUiControlCreate(UiControlCreateSchema.parse({ parent_id: ACTOR }), f.ctx),
      { ok: false, errorCode: 'INVALID_STATE', error: 'ui.create_control is unavailable in headless editor mode.' });
    assert.equal(headless.envelope.error.code, 'HEADLESS_MODE');

    const playing = await roundTrip(f, handleUiControlCreate(UiControlCreateSchema.parse({ parent_id: ACTOR }), f.ctx),
      { ok: false, errorCode: 'INVALID_STATE', error: 'ui.create_control is an edit-time operation and is unavailable while the editor is in play mode or play was requested.' });
    assert.equal(playing.envelope.error.code, 'EDITOR_BUSY');
  } finally { await f.cleanup(); }
});
