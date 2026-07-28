import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { CreateActorSchema, handleCreateActor } from './sceneWrite.js';

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
