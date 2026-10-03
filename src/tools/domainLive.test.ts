import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { EnvironmentProbeBakeSchema, FoliageAddInstancesSchema, FoliageRemoveInstancesSchema, LightingBakeSchema, NavigationBuildSchema, PhysicsFindOverlapsSchema, PhysicsRaycastSchema, TerrainGetSummarySchema, TerrainPaintSchema, handleEnvironmentProbeBake, handleFoliageAddInstances, handleFoliageRemoveInstances, handleLightingBake, handleNavigationBuild, handlePhysicsRaycast, handleTerrainGetSummary, handleTerrainPaint } from './domainLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
interface Fixture { root: string; requests: string; responses: string; ctx: ProjectMeta; cleanup(): Promise<void>; }
async function fixture(version = 14): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-domain-')); const cache = path.join(root, 'Cache', 'MCP'); const requests = path.join(cache, 'requests'); const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true }); await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: version, ProtocolVersion: 1 }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, requests, responses, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
async function reply(f: Fixture, result: Record<string, unknown>): Promise<{ method: string; params: unknown }> {
  const deadline = Date.now() + 1000; let name: string | undefined;
  while (Date.now() < deadline) { name = (await fs.readdir(f.requests)).find(value => value.endsWith('.json')); if (name) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  if (!name) throw new Error('No domain RPC request.');
  const request = JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, string>;
  await fs.writeFile(path.join(f.responses, `${request.id}.json`), JSON.stringify({ id: request.id, token: TOKEN, timestamp: Date.now(), ...result }));
  return { method: request.method, params: JSON.parse(request.paramsJson) };
}

test('domain schemas bound vectors, masks, and terrain pages', () => {
  assert.equal(PhysicsRaycastSchema.safeParse({ origin: { x: 0, y: 0, z: 0 }, direction: { x: Infinity, y: 0, z: 1 } }).success, false);
  assert.equal(PhysicsFindOverlapsSchema.safeParse({ center: { x: 0, y: 0, z: 0 }, radius: 0 }).success, false);
  assert.equal(TerrainGetSummarySchema.safeParse({ limit: 101 }).success, false);
});

test('physics raycast marshals only bounded PascalCase DTO fields', async () => {
  const f = await fixture();
  try {
    const pending = handlePhysicsRaycast(PhysicsRaycastSchema.parse({ origin: { x: 1, y: 2, z: 3 }, direction: { x: 0, y: -1, z: 0 }, distance: 50, layer_mask: 7, include_triggers: false }), f.ctx);
    const request = await reply(f, { ok: true, resultJson: JSON.stringify({ Hit: false, Result: null }) });
    assert.equal(request.method, 'physics.raycast');
    assert.deepEqual(request.params, { Origin: { X: 1, Y: 2, Z: 3 }, Direction: { X: 0, Y: -1, Z: 0 }, Distance: 50, LayerMask: 7, IncludeTriggers: false });
    assert.equal((await pending).isError, undefined);
  } finally { await f.cleanup(); }
});

test('v31 writes fail closed on older bridges before any RPC', async () => {
  const f = await fixture(30);
  try {
    const response = await handleNavigationBuild(NavigationBuildSchema.parse({}), f.ctx);
    assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
  const old = await fixture(13);
  try {
    const response = await handleTerrainGetSummary(TerrainGetSummarySchema.parse({}), old.ctx);
    assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }
});

test('v31 schemas enforce rect budgets, value arity, batch caps, and bounds', () => {
  const terrainId = 'a'.repeat(32);
  assert.equal(TerrainPaintSchema.safeParse({ terrain_id: terrainId, mode: 'height', offset_x: 0, offset_y: 0, size_w: 129, size_h: 128, values: new Array(129 * 128).fill(0) }).success, false);
  assert.equal(TerrainPaintSchema.safeParse({ terrain_id: terrainId, mode: 'splat', offset_x: 0, offset_y: 0, size_w: 2, size_h: 2, values: [0, 1, 0] }).success, false);
  assert.equal(TerrainPaintSchema.safeParse({ terrain_id: terrainId, mode: 'carve', offset_x: 0, offset_y: 0, size_w: 1, size_h: 1, values: [0] }).success, false);
  assert.equal(TerrainPaintSchema.safeParse({ terrain_id: 'short', mode: 'holes', offset_x: 0, offset_y: 0, size_w: 1, size_h: 1, values: [1] }).success, false);
  assert.equal(TerrainPaintSchema.safeParse({ terrain_id: terrainId, mode: 'height', offset_x: 0, offset_y: 0, size_w: 128, size_h: 128, values: new Array(128 * 128).fill(1.5) }).success, true);
  const foliageId = 'b'.repeat(32);
  assert.equal(FoliageAddInstancesSchema.safeParse({ foliage_id: foliageId, instances: [] }).success, false);
  assert.equal(FoliageAddInstancesSchema.safeParse({ foliage_id: foliageId, instances: new Array(201).fill({ position: [0, 0, 0] }) }).success, false);
  assert.equal(FoliageAddInstancesSchema.safeParse({ foliage_id: foliageId, instances: [{ position: [0, 0, 0], scale: 0 }] }).success, false);
  assert.equal(FoliageAddInstancesSchema.safeParse({ foliage_id: foliageId, instances: [{ position: [1, 2, 3] }] }).success, true);
  assert.equal(FoliageRemoveInstancesSchema.safeParse({ foliage_id: foliageId, instance_indices: [] }).success, false);
  assert.equal(FoliageRemoveInstancesSchema.safeParse({ foliage_id: foliageId, instance_indices: [1, 1] }).success, false);
  assert.equal(NavigationBuildSchema.safeParse({ bounds: { min: [1, 0, 0], max: [0, 0, 0] } }).success, false);
  assert.equal(NavigationBuildSchema.safeParse({ timeout_ms: 100 }).success, false);
  assert.equal(NavigationBuildSchema.safeParse({}).success, true);
  assert.equal(LightingBakeSchema.safeParse({ action: 'ignite' }).success, false);
  assert.equal(LightingBakeSchema.parse({}).action, 'status');
  assert.equal(EnvironmentProbeBakeSchema.safeParse({ actor_id: 'short' }).success, false);
});

test('foliage add marshals PascalCase DTOs with local-space defaults', async () => {
  const f = await fixture(31);
  try {
    const pending = handleFoliageAddInstances(FoliageAddInstancesSchema.parse({
      foliage_id: 'b'.repeat(32), type_index: 2, instances: [{ position: [1, 2, 3] }, { position: [4, 5, 6], rotation: [10, 20, 30], scale: 2 }],
    }), f.ctx);
    const request = await reply(f, { ok: true, resultJson: JSON.stringify({ FoliageId: 'b'.repeat(32), TypeIndex: 2, AddedCount: 2, InstancesCount: 7, UndoRegistered: true, SceneEdited: true, Warnings: ['local-space'] }) });
    assert.equal(request.method, 'foliage.add_instances');
    assert.deepEqual(request.params, {
      FoliageId: 'b'.repeat(32), TypeIndex: 2,
      Instances: [
        { Position: { X: 1, Y: 2, Z: 3 }, Rotation: { X: 0, Y: 0, Z: 0 }, Scale: 1 },
        { Position: { X: 4, Y: 5, Z: 6 }, Rotation: { X: 10, Y: 20, Z: 30 }, Scale: 2 },
      ],
    });
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.deepEqual((response.structuredContent as any).changes, [{ kind: 'foliage.instances_added', foliageId: 'b'.repeat(32), added: 2 }]);
    assert.ok(((response.structuredContent as any).warnings as string[]).includes('local-space'));
  } finally { await f.cleanup(); }
});

test('foliage remove marshals index batches and maps headless gates', async () => {
  const f = await fixture(31);
  try {
    const pending = handleFoliageRemoveInstances(FoliageRemoveInstancesSchema.parse({ foliage_id: 'b'.repeat(32), instance_indices: [3, 1] }), f.ctx);
    const request = await reply(f, { ok: true, resultJson: JSON.stringify({ RemovedCount: 2, InstancesCount: 5, Warnings: [] }) });
    assert.equal(request.method, 'foliage.remove_instances');
    assert.deepEqual(request.params, { FoliageId: 'b'.repeat(32), InstanceIndices: [3, 1] });
    assert.equal((await pending).isError, undefined);
  } finally { await f.cleanup(); }
  const gated = await fixture(31);
  try {
    const pending = handleFoliageAddInstances(FoliageAddInstancesSchema.parse({ foliage_id: 'b'.repeat(32), instances: [{ position: [0, 0, 0] }] }), gated.ctx);
    await reply(gated, { ok: false, errorCode: 'INVALID_STATE', error: 'foliage.add_instances is unavailable in headless editor mode.' });
    assert.equal(((await pending).structuredContent as any).error.code, 'HEADLESS_MODE');
  } finally { await gated.cleanup(); }
});

test('navigation build warns on whole-scene and maps timeout phases', async () => {
  const f = await fixture(31);
  try {
    const pending = handleNavigationBuild(NavigationBuildSchema.parse({ timeout_ms: 500 }), f.ctx);
    const request = await reply(f, { ok: true, resultJson: JSON.stringify({ Phase: 'completed', Progress: 1, WholeScene: true, Warnings: [] }) });
    assert.equal(request.method, 'navigation.build');
    assert.deepEqual(request.params, { SceneId: null, Min: null, Max: null, TimeoutMs: 500 });
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.ok(((response.structuredContent as any).warnings as string[]).some(text => text.includes('whole-scene')));
  } finally { await f.cleanup(); }
  const slow = await fixture(31);
  try {
    const pending = handleNavigationBuild(NavigationBuildSchema.parse({ scene_id: 'c'.repeat(32), bounds: { min: [0, 0, 0], max: [10, 10, 10] } }), slow.ctx);
    const request = await reply(slow, { ok: true, resultJson: JSON.stringify({ Phase: 'timeout', Progress: 0.25, Warnings: [] }) });
    assert.deepEqual(request.params, { SceneId: 'c'.repeat(32), Min: { X: 0, Y: 0, Z: 0 }, Max: { X: 10, Y: 10, Z: 10 }, TimeoutMs: 15_000 });
    const response = await pending;
    assert.equal(response.isError, true);
    assert.equal((response.structuredContent as any).error.code, 'TIMEOUT');
    assert.match((response.structuredContent as any).error.message, /continues in the background/);
  } finally { await slow.cleanup(); }
});

test('navigation build reports queued and running phases as unfinished, never completed', async () => {
  for (const phase of ['queued', 'running']) {
    const f = await fixture(34);
    try {
      const pending = handleNavigationBuild(NavigationBuildSchema.parse({ timeout_ms: 500 }), f.ctx);
      await reply(f, { ok: true, resultJson: JSON.stringify({ Phase: phase, Progress: 0, ObservedBuilding: phase === 'running', Warnings: [] }) });
      const response = await pending;
      assert.equal(response.isError, true);
      assert.equal((response.structuredContent as any).error.code, 'TIMEOUT');
      assert.equal((response.structuredContent as any).error.details.phase, phase);
    } finally { await f.cleanup(); }
  }
});

test('lighting bake and probe bake marshal actions and map timeout phases', async () => {
  const f = await fixture(31);
  try {
    const pending = handleLightingBake(LightingBakeSchema.parse({ action: 'start' }), f.ctx);
    const request = await reply(f, { ok: true, resultJson: JSON.stringify({ Phase: 'baking', IsBaking: true, Warnings: [] }) });
    assert.equal(request.method, 'lighting.bake');
    assert.deepEqual(request.params, { Action: 'start' });
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.deepEqual((response.structuredContent as any).changes, [{ kind: 'lighting.bake.requested', action: 'start', phase: 'baking' }]);
  } finally { await f.cleanup(); }
  const probe = await fixture(31);
  try {
    const pending = handleEnvironmentProbeBake(EnvironmentProbeBakeSchema.parse({ actor_id: 'd'.repeat(32) }), probe.ctx);
    const request = await reply(probe, { ok: true, resultJson: JSON.stringify({ Phase: 'completed', Kind: 'EnvironmentProbe', Warnings: [] }) });
    assert.equal(request.method, 'environment_probe.bake');
    assert.deepEqual(request.params, { ActorId: 'd'.repeat(32), TimeoutMs: 10_000 });
    assert.equal((await pending).isError, undefined);
  } finally { await probe.cleanup(); }
  const expired = await fixture(31);
  try {
    const pending = handleEnvironmentProbeBake(EnvironmentProbeBakeSchema.parse({ actor_id: 'd'.repeat(32), timeout_ms: 1000 }), expired.ctx);
    await reply(expired, { ok: true, resultJson: JSON.stringify({ Phase: 'timeout', Kind: 'SkyLight', Warnings: [] }) });
    const response = await pending;
    assert.equal(response.isError, true);
    assert.equal((response.structuredContent as any).error.code, 'TIMEOUT');
  } finally { await expired.cleanup(); }
});

test('terrain paint validates the full contract then reports the honest stub', async () => {
  const f = await fixture(31);
  try {
    const pending = handleTerrainPaint(TerrainPaintSchema.parse({
      terrain_id: 'e'.repeat(32), mode: 'height', offset_x: 0, offset_y: 0, size_w: 2, size_h: 2, values: [1, 2, 3, 4],
    }), f.ctx);
    const request = await reply(f, { ok: false, errorCode: 'UNSUPPORTED_FLAX_VERSION', error: 'terrain.paint has no verified managed write path.' });
    assert.equal(request.method, 'terrain.paint');
    assert.deepEqual(request.params, {
      TerrainId: 'e'.repeat(32), PatchIndex: 0, Mode: 'height', OffsetX: 0, OffsetY: 0, SizeW: 2, SizeH: 2, Values: [1, 2, 3, 4], DryRun: false,
    });
    const response = await pending;
    assert.equal(response.isError, true);
    assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await f.cleanup(); }
  const old = await fixture(30);
  try {
    const response = await handleTerrainPaint(TerrainPaintSchema.parse({
      terrain_id: 'e'.repeat(32), mode: 'holes', offset_x: 0, offset_y: 0, size_w: 1, size_h: 1, values: [1],
    }), old.ctx);
    assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }
});
