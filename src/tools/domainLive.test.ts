import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import { NavigationBuildSchema, PhysicsFindOverlapsSchema, PhysicsRaycastSchema, TerrainGetSummarySchema, handleNavigationBuild, handlePhysicsRaycast, handleTerrainGetSummary } from './domainLive.js';

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

test('unsupported navigation build preserves the stable capability error and v14 tools fail closed on old bridges', async () => {
  const f = await fixture();
  try {
    const pending = handleNavigationBuild(NavigationBuildSchema.parse({}), f.ctx);
    const request = await reply(f, { ok: false, errorCode: 'UNSUPPORTED_FLAX_VERSION', error: 'No reviewed cancellation.' });
    assert.equal(request.method, 'navigation.build');
    const response = await pending;
    assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await f.cleanup(); }
  const old = await fixture(13);
  try {
    const response = await handleTerrainGetSummary(TerrainGetSummarySchema.parse({}), old.ctx);
    assert.equal((response.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }
});
