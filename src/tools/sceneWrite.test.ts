import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { nativeToManaged } from '../guid.js';
import { CreateActorSchema, ModifyActorSchema, handleCreateActor, handleModifyActor } from './sceneWrite.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-scene-write-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  return {
    root,
    ctx: await createProjectContext(root),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('legacy scene write requires explicit offline opt-in', async () => {
  const f = await fixture();
  try {
    const result = await handleCreateActor(CreateActorSchema.parse({
      type_name: 'FlaxEngine.EmptyActor',
      name: 'Unsafe',
    }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
    assert.match((result.structuredContent as any).error.message, /allow_offline_write:true/);
  } finally {
    await f.cleanup();
  }
});

test('legacy scene write is rejected while the editor bridge is connected', async () => {
  const f = await fixture();
  try {
    const cache = path.join(f.root, 'Cache', 'MCP');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
      Pid: process.pid,
      Project: f.root,
      Timestamp: Date.now(),
      BridgeVersion: 5,
      ProtocolVersion: 1,
    }));
    const result = await handleCreateActor(CreateActorSchema.parse({
      type_name: 'FlaxEngine.EmptyActor',
      name: 'Unsafe',
      allow_offline_write: true,
    }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
    assert.match((result.structuredContent as any).error.message, /disabled while Flax Editor is connected/);
  } finally {
    await f.cleanup();
  }
});

test('legacy scene write maps managed IDs to the native IDs stored in the scene file', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'Content'), { recursive: true });
    const scenePath = path.join(f.root, 'Content', 'S.scene');
    // Native scene-file ID and its managed (bridge) spelling, from docs/GUID_AUDIT_P7.md.
    const nativeParent = 'a2fbb236413310c2a053e2ab9c83d1c8';
    const managedParent = 'a2fbb23610c24133abe253a0c8d1839c';
    await fs.writeFile(scenePath, JSON.stringify({
      ID: '11111111111111111111111111111111',
      Data: [
        { ID: 'dddddddddddddddddddddddddddddddd', TypeName: 'FlaxEngine.Scene', Name: 'Scene' },
        { ID: nativeParent, ParentID: 'dddddddddddddddddddddddddddddddd', TypeName: 'FlaxEngine.EmptyActor', Name: 'Parent' },
      ],
    }));
    const created = await handleCreateActor(CreateActorSchema.parse({
      type_name: 'FlaxEngine.EmptyActor',
      name: 'Child',
      scene: 'S.scene',
      parent_id: managedParent,
      allow_offline_write: true,
    }), f.ctx);
    assert.equal(created.isError, undefined);
    const saved = JSON.parse(await fs.readFile(scenePath, 'utf8')) as { Data: Array<{ ID: string; ParentID?: string; Name?: string }> };
    const child = saved.Data.find(a => a.Name === 'Child')!;
    assert.equal(child.ParentID, nativeParent);
    assert.match(child.ID, /^[0-9a-f]{32}$/);
    const text = (created.content[0] as { text: string }).text;
    assert.match(text, new RegExp(`Parent: ${managedParent}`));
    assert.match(text, new RegExp(`ID: ${nativeToManaged(child.ID)}`));

    const modified = await handleModifyActor(ModifyActorSchema.parse({
      actor_id_or_name: managedParent,
      scene: 'S.scene',
      name: 'Renamed',
      allow_offline_write: true,
    }), f.ctx);
    assert.equal(modified.isError, undefined);
    const after = JSON.parse(await fs.readFile(scenePath, 'utf8')) as { Data: Array<{ ID: string; Name?: string }> };
    assert.equal(after.Data.find(a => a.ID === nativeParent)?.Name, 'Renamed');
  } finally {
    await f.cleanup();
  }
});
