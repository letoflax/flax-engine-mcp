import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  AnimationGetGraphParametersSchema,
  AnimationListClipsSchema,
  AnimationSetGraphParameterSchema,
  AnimationValidateBindingsSchema,
  MaterialAssignToActorSchema,
  MaterialCreateInstanceSchema,
  MaterialGetParametersSchema,
  MaterialSetParametersSchema,
  handleAnimationGetGraphParameters,
  handleAnimationListClips,
  handleAnimationSetGraphParameter,
  handleAnimationValidateBindings,
  handleMaterialGetParameters,
  handleMaterialSetParameters,
} from './materialAnimationLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const MATERIAL_ID = 'a'.repeat(32);
const ACTOR_ID = 'b'.repeat(32);
const PARAMETER_ID = 'c'.repeat(32);

interface Fixture {
  root: string;
  requests: string;
  responses: string;
  ctx: ProjectMeta;
  cleanup: () => Promise<void>;
}

async function fixture(bridgeVersion = 13): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-material-animation-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'material-animation-fixture' }));
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
  throw new Error('Timed out waiting for material/animation bridge request.');
}

async function respond(f: Fixture, body: Record<string, unknown>): Promise<{ body: Record<string, unknown>; params: Record<string, unknown> }> {
  const request = await waitForRequest(f.requests);
  const target = path.join(f.responses, String(request.body.id) + '.json');
  await fs.writeFile(target + '.tmp', JSON.stringify({ id: request.body.id, token: TOKEN, timestamp: Date.now(), ...body }));
  await fs.rename(target + '.tmp', target);
  return { body: request.body, params: JSON.parse(String(request.body.paramsJson)) as Record<string, unknown> };
}

test('material and animation schemas reject ambiguous selectors, unsafe paths, non-finite values, and unconfirmed writes', () => {
  assert.equal(MaterialGetParametersSchema.safeParse({ asset_id: MATERIAL_ID, path: 'Content/Materials/Surface.flax' }).success, false);
  assert.equal(MaterialGetParametersSchema.safeParse({ path: 'Content/../Surface.flax' }).success, false);
  assert.equal(MaterialSetParametersSchema.safeParse({ asset_id: MATERIAL_ID, parameters: [] }).success, false);
  assert.equal(MaterialSetParametersSchema.safeParse({ asset_id: MATERIAL_ID, parameters: [{ name: 'Tint', value: Infinity }] }).success, false);
  assert.equal(MaterialSetParametersSchema.safeParse({ asset_id: MATERIAL_ID, parameters: [{ name: 'Tint', value: 1 }], dry_run: false }).success, false);
  assert.equal(MaterialCreateInstanceSchema.safeParse({ asset_id: MATERIAL_ID, destination_path: 'Content/Materials/Instance.material' }).success, false);
  assert.equal(MaterialAssignToActorSchema.safeParse({ asset_id: MATERIAL_ID, actor_id: ACTOR_ID, dry_run: false, confirm: true }).success, true);
  assert.equal(AnimationListClipsSchema.safeParse({ folder: 'Content/Animations', limit: 201 }).success, false);
  assert.equal(AnimationSetGraphParameterSchema.safeParse({ actor_id: ACTOR_ID, parameter_id: PARAMETER_ID, parameter_name: 'Speed', value: 1 }).success, false);
  assert.equal(AnimationSetGraphParameterSchema.safeParse({ actor_id: ACTOR_ID, parameter_name: 'Speed', value: 1 }).success, true);
});

test('material and animation reads marshal PascalCase requests and preserve cursor parameters', async () => {
  const f = await fixture();
  try {
    const material = handleMaterialGetParameters(MaterialGetParametersSchema.parse({ path: 'Content/Materials/Surface.flax', include_non_public: true }), f.ctx);
    const first = await respond(f, { ok: true, resultJson: JSON.stringify({ Parameters: [], IsInstance: false }) });
    assert.equal(first.body.method, 'material.get_parameters');
    assert.deepEqual(first.params, { Path: 'Content/Materials/Surface.flax', IncludeNonPublic: true });
    assert.equal((await material).isError, undefined);

    const clips = handleAnimationListClips(AnimationListClipsSchema.parse({ folder: 'Content/Animations', limit: 2, cursor: 'd'.repeat(32) }), f.ctx);
    const second = await respond(f, { ok: true, resultJson: JSON.stringify({ Entries: [], HasMore: false }) });
    assert.equal(second.body.method, 'animation.list_clips');
    assert.deepEqual(second.params, { Folder: 'Content/Animations', Limit: 2, Cursor: 'd'.repeat(32) });
    assert.equal((await clips).isError, undefined);

    const parameters = handleAnimationGetGraphParameters(AnimationGetGraphParametersSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    const third = await respond(f, { ok: true, resultJson: JSON.stringify({ ActorId: ACTOR_ID, Parameters: [] }) });
    assert.equal(third.body.method, 'animation.get_graph_parameters');
    assert.deepEqual(third.params, { ActorId: ACTOR_ID });
    assert.equal((await parameters).isError, undefined);

    const validation = handleAnimationValidateBindings(AnimationValidateBindingsSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    const fourth = await respond(f, { ok: true, resultJson: JSON.stringify({ ActorId: ACTOR_ID, Valid: true }) });
    assert.equal(fourth.body.method, 'animation.validate_bindings');
    assert.deepEqual(fourth.params, { ActorId: ACTOR_ID });
    assert.equal((await validation).isError, undefined);
  } finally {
    await f.cleanup();
  }
});

test('unsupported material and animation writes expose stable bridge capability errors without reporting changes', async () => {
  const f = await fixture();
  try {
    const material = handleMaterialSetParameters(MaterialSetParametersSchema.parse({
      asset_id: MATERIAL_ID,
      parameters: [{ parameter_id: PARAMETER_ID, value: { x: 1, y: 0, z: 0, w: 1 } }],
    }), f.ctx);
    const first = await respond(f, {
      ok: false,
      errorCode: 'UNSUPPORTED_FLAX_VERSION',
      error: 'material_set_parameters is intentionally unavailable.',
      errorDetails: JSON.stringify({ Capability: 'material_set_parameters', BridgeVersion: 13, DryRun: true }),
      resultJson: null,
    });
    assert.equal(first.body.method, 'material.set_parameters');
    assert.deepEqual(first.params, {
      AssetId: MATERIAL_ID,
      Parameters: [{ ParameterId: PARAMETER_ID, Value: { x: 1, y: 0, z: 0, w: 1 } }],
      DryRun: true,
      Confirm: false,
    });
    const materialResult = await material;
    assert.equal(materialResult.isError, true);
    assert.equal((materialResult.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');

    const animation = handleAnimationSetGraphParameter(AnimationSetGraphParameterSchema.parse({
      actor_id: ACTOR_ID,
      parameter_name: 'Speed',
      value: 2,
    }), f.ctx);
    const second = await respond(f, {
      ok: false,
      errorCode: 'UNSUPPORTED_FLAX_VERSION',
      error: 'animation_set_graph_parameter is intentionally unavailable.',
      errorDetails: JSON.stringify({ Capability: 'animation_set_graph_parameter', BridgeVersion: 13, DryRun: true }),
      resultJson: null,
    });
    assert.equal(second.body.method, 'animation.set_graph_parameter');
    assert.deepEqual(second.params, {
      ActorId: ACTOR_ID,
      ParameterName: 'Speed',
      Value: 2,
      DryRun: true,
      Confirm: false,
    });
    const animationResult = await animation;
    assert.equal(animationResult.isError, true);
    assert.equal((animationResult.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally {
    await f.cleanup();
  }
});

test('material and animation methods fail closed before writing a request to bridges older than v13', async () => {
  const f = await fixture(12);
  try {
    const result = await handleMaterialGetParameters(MaterialGetParametersSchema.parse({ asset_id: MATERIAL_ID }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});
