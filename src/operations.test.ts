import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from './projectContext.js';
import { HeavyOperationRateLimiter, handleOperationCancel, handleOperationGetStatus } from './operations.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const OPERATION_ID = '0123456789abcdef0123456789abcdef';

async function fixture(): Promise<{ root: string; requests: string; responses: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-operation-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'fixture-guid' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 11, ProtocolVersion: 1 }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function waitForRequest(directory: string): Promise<{ id: string; method: string; params: Record<string, unknown> }> {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    const files = await fs.readdir(directory);
    const file = files.find(value => value.endsWith('.json'));
    if (file) {
      const body = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as Record<string, unknown>;
      return { id: String(body.id), method: String(body.method), params: JSON.parse(String(body.paramsJson)) as Record<string, unknown> };
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for operation request');
}

async function respond(directory: string, id: string, value: unknown, error?: { code: string; message: string }): Promise<void> {
  const target = path.join(directory, `${id}.json`);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(error
    ? { id, token: TOKEN, ok: false, errorCode: error.code, error: error.message }
    : { id, token: TOKEN, ok: true, resultJson: JSON.stringify(value) }));
  await fs.rename(`${target}.tmp`, target);
}

test('operation manager uses exact raw handles and exposes bounded persisted status', async () => {
  const f = await fixture();
  try {
    const ctx = await createProjectContext(f.root);
    const pending = handleOperationGetStatus({ operation_id: OPERATION_ID }, ctx);
    const request = await waitForRequest(f.requests);
    assert.equal(request.method, 'operation.status');
    assert.deepEqual(request.params, { OperationId: OPERATION_ID });
    await respond(f.responses, request.id, { OperationId: OPERATION_ID, Kind: 'compile', Phase: 'compiling', Progress: 0.5, CanCancel: false, Diagnostics: [] });
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.equal((response.structuredContent as { data: { operation: { OperationId: string } } }).data.operation.OperationId, OPERATION_ID);
  } finally { await f.cleanup(); }
});

test('operation cancellation reports unsupported backends instead of claiming cancellation', async () => {
  const f = await fixture();
  try {
    const ctx = await createProjectContext(f.root);
    const pending = handleOperationCancel({ operation_id: OPERATION_ID }, ctx);
    const request = await waitForRequest(f.requests);
    assert.equal(request.method, 'operation.cancel');
    await respond(f.responses, request.id, null, { code: 'CANCELLATION_UNSUPPORTED', message: 'No safe backend checkpoint.' });
    const response = await pending;
    assert.equal(response.isError, true);
    assert.equal((response.structuredContent as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
  } finally { await f.cleanup(); }
});

test('operation status degrades cleanly when the editor disconnects and rate limiting is per project', async () => {
  const f = await fixture();
  try {
    const ctx = await createProjectContext(f.root);
    await fs.unlink(path.join(f.root, 'Cache', 'MCP', 'bridge.json'));
    const disconnected = await handleOperationGetStatus({ operation_id: OPERATION_ID }, ctx);
    assert.equal(disconnected.isError, true);
    assert.equal((disconnected.structuredContent as { error: { code: string } }).error.code, 'EDITOR_NOT_CONNECTED');
    const limiter = new HeavyOperationRateLimiter(1);
    const release = limiter.acquire(ctx);
    assert.throws(() => limiter.acquire(ctx), error => (error as { code?: unknown }).code === 'RATE_LIMITED');
    release();
    limiter.acquire(ctx)();
  } finally { await f.cleanup(); }
});
