import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { handleMMTuning, MMTuningSchema } from './mmTuning.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

interface Fixture { root: string; ctx: ProjectMeta; requests: string; responses: string; cleanup: () => Promise<void>; }

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-mm-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 20, ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, ctx: await createProjectContext(root), requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 1_500;
  while (Date.now() < end) {
    const name = (await fs.readdir(f.requests)).find(item => item.endsWith('.json'));
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for mm bridge request.');
}

async function respondFailure(f: Fixture, request: { name: string; body: Record<string, unknown> }, errorCode: string, error: string, errorDetails?: unknown): Promise<void> {
  const response = {
    id: request.body.id, token: TOKEN, ok: false, errorCode, error, resultJson: null, timestamp: Date.now(),
    ...(errorDetails !== undefined ? { errorDetails: JSON.stringify(errorDetails) } : {}),
  };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

function errorCodeOf(result: Awaited<ReturnType<typeof handleMMTuning>>): string {
  return (result.structuredContent as Record<string, any>).error.code;
}

test('mm tuning keeps INVALID_PLAY_STATE for non-headless INVALID_STATE (pre-P2 behavior)', async () => {
  const f = await fixture();
  try {
    const pending = handleMMTuning(MMTuningSchema.parse({ op: 'status' }), f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'mm.tuning');
    await respondFailure(f, request, 'INVALID_STATE', 'No play session is active.', { PlayMode: false });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(errorCodeOf(result), 'INVALID_PLAY_STATE');
  } finally { await f.cleanup(); }
});

test('mm tuning delegates headless INVALID_STATE to HEADLESS_MODE via the shared mapper', async () => {
  const f = await fixture();
  try {
    const pending = handleMMTuning(MMTuningSchema.parse({ op: 'clip_motion' }), f.ctx);
    const request = await nextRequest(f);
    await respondFailure(f, request, 'INVALID_STATE', 'No surface.', { Reason: 'Headless editor has no GUI surface.' });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(errorCodeOf(result), 'HEADLESS_MODE');
  } finally { await f.cleanup(); }
});
