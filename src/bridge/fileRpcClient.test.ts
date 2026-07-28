import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { BRIDGE_HEARTBEAT_MAX_AGE_MS } from '../tools/serverStatus.js';
import { FileRpcClient } from './fileRpcClient.js';
import { BridgeRpcError } from './protocol.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

interface Fixture {
  root: string;
  requests: string;
  responses: string;
  cleanup: () => Promise<void>;
}

async function fixture(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-bridge-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'fixture-guid' }));
  // serverStatus accepts this legacy/Pascal heartbeat shape. The transport DTOs
  // remain lowercase, as required by the bridge file protocol.
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid,
    Project: root,
    Timestamp: Date.now(),
    BridgeVersion: 5,
    ProtocolVersion: 1,
    ...overrides,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
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
  throw new Error('Timed out waiting for bridge request.');
}

async function writeResponse(directory: string, id: string, body: Record<string, unknown>): Promise<void> {
  const target = path.join(directory, `${id}.json`);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ token: TOKEN, ...body }));
  await fs.rename(temporary, target);
}

async function expectBridgeError(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof BridgeRpcError && error.code === code);
}

test('file RPC writes the bridge DTO atomically, validates status, and cleans up', async () => {
  const f = await fixture();
  try {
    const ctx = await createProjectContext(f.root);
    const client = new FileRpcClient(ctx, { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call<'status', { include: string }, { running: boolean }>('status', { include: 'scene' });
    const request = await waitForRequest(f.requests);

    assert.deepEqual(Object.keys(request.body).sort(), ['deadlineUnixMs', 'id', 'method', 'paramsJson', 'token']);
    assert.equal(request.body.method, 'status');
    assert.equal(request.body.token, TOKEN);
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { include: 'scene' });
    assert.equal(typeof request.body.deadlineUnixMs, 'number');
    assert.ok(Number(request.body.deadlineUnixMs) > Date.now());

    await writeResponse(f.responses, String(request.body.id), {
      id: request.body.id,
      ok: true,
      resultJson: JSON.stringify({ running: true }),
      timestamp: Date.now(),
    });
    const result = await pending;
    assert.deepEqual(result.result, { running: true });
    assert.equal(result.bridge.connected, true);
    assert.equal(result.bridge.reason, 'connected');
    assert.equal(result.bridge.pid, process.pid);
    assert.deepEqual(await fs.readdir(f.requests), []);
    assert.deepEqual(await fs.readdir(f.responses), []);
  } finally {
    await f.cleanup();
  }
});

test('file RPC rejects stale or mismatched bridge heartbeats before writing a request', async () => {
  const stale = await fixture({ Timestamp: Date.now() - BRIDGE_HEARTBEAT_MAX_AGE_MS - 1 });
  const mismatch = await fixture({ Project: path.join(os.tmpdir(), 'wrong-project') });
  try {
    const staleCtx = await createProjectContext(stale.root);
    const mismatchCtx = await createProjectContext(mismatch.root);
    await expectBridgeError(
      () => new FileRpcClient(staleCtx, { deadlineMs: 100 }).call('status', {}),
      'BRIDGE_UNAVAILABLE',
    );
    await expectBridgeError(
      () => new FileRpcClient(mismatchCtx, { deadlineMs: 100 }).call('status', {}),
      'BRIDGE_UNAVAILABLE',
    );
    assert.deepEqual(await fs.readdir(stale.requests), []);
    assert.deepEqual(await fs.readdir(mismatch.requests), []);
  } finally {
    await Promise.all([stale.cleanup(), mismatch.cleanup()]);
  }
});

test('file RPC rejects an incompatible bridge protocol before writing a request', async () => {
  const f = await fixture({ ProtocolVersion: 2 });
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 100 });
    await expectBridgeError(() => client.call('status', {}), 'BRIDGE_UNSUPPORTED');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('Phase 2 methods require bridge version 6 while Phase 1 remains compatible with version 5', async () => {
  const f = await fixture({ BridgeVersion: 5, ProtocolVersion: 1 });
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 100 });
    await expectBridgeError(() => client.call('code.status', {}), 'BRIDGE_UNSUPPORTED');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('file RPC requires a token and rejects a mismatched response id', async () => {
  const missingToken = await fixture();
  const mismatch = await fixture();
  try {
    const missingTokenCtx = await createProjectContext(missingToken.root);
    await fs.unlink(path.join(missingToken.root, 'Cache', 'MCP', 'token'));
    await expectBridgeError(
      () => new FileRpcClient(missingTokenCtx, { deadlineMs: 100 }).call('status', {}),
      'BRIDGE_AUTH_FAILED',
    );

    const client = new FileRpcClient(await createProjectContext(mismatch.root), { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call('status', {});
    const request = await waitForRequest(mismatch.requests);
    await writeResponse(mismatch.responses, String(request.body.id), {
      id: 'unrelated-response', ok: true, resultJson: '{}', timestamp: Date.now(),
    });
    await expectBridgeError(() => pending, 'BRIDGE_RESPONSE_INVALID');
    assert.deepEqual(await fs.readdir(mismatch.requests), []);
    assert.deepEqual(await fs.readdir(mismatch.responses), []);
  } finally {
    await Promise.all([missingToken.cleanup(), mismatch.cleanup()]);
  }
});

test('file RPC rejects a response from a different bridge session', async () => {
  const f = await fixture();
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call('status', {});
    const request = await waitForRequest(f.requests);
    await writeResponse(f.responses, String(request.body.id), {
      id: request.body.id,
      token: 'different-session-token',
      ok: true,
      resultJson: '{}',
      timestamp: Date.now(),
    });
    await expectBridgeError(() => pending, 'BRIDGE_AUTH_FAILED');
  } finally {
    await f.cleanup();
  }
});

test('file RPC preserves a remote error when resultJson is null', async () => {
  const f = await fixture();
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 500, pollIntervalMs: 5 });
    const pending = client.call('actor.get', { ActorId: '0'.repeat(32) });
    const request = await waitForRequest(f.requests);
    await writeResponse(f.responses, String(request.body.id), {
      id: request.body.id,
      ok: false,
      errorCode: 'NOT_FOUND',
      error: 'Actor was not found.',
      resultJson: null,
      timestamp: Date.now(),
    });
    await expectBridgeError(() => pending, 'BRIDGE_REMOTE_ERROR');
    assert.deepEqual(await fs.readdir(f.requests), []);
    assert.deepEqual(await fs.readdir(f.responses), []);
  } finally {
    await f.cleanup();
  }
});

test('file RPC times out, enforces single-flight calls, and cleans abandoned files', async () => {
  const f = await fixture();
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 60, pollIntervalMs: 5 });
    const first = client.call('status', {});
    await waitForRequest(f.requests);
    const separateClient = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 60, pollIntervalMs: 5 });
    await expectBridgeError(() => separateClient.call('status', {}), 'BRIDGE_CONCURRENT_CALL');
    await expectBridgeError(() => first, 'BRIDGE_TIMEOUT');
    assert.deepEqual(await fs.readdir(f.requests), []);
    assert.deepEqual(await fs.readdir(f.responses), []);
  } finally {
    await f.cleanup();
  }
});

test('file RPC bounds response messages before parsing them', async () => {
  const f = await fixture();
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), {
      deadlineMs: 500,
      pollIntervalMs: 5,
      maxMessageBytes: 256,
    });
    const pending = client.call('status', {});
    const request = await waitForRequest(f.requests);
    await writeResponse(f.responses, String(request.body.id), {
      id: request.body.id,
      ok: true,
      resultJson: JSON.stringify({ payload: 'x'.repeat(512) }),
      timestamp: Date.now(),
    });
    await expectBridgeError(() => pending, 'BRIDGE_MESSAGE_TOO_LARGE');
    assert.deepEqual(await fs.readdir(f.requests), []);
    assert.deepEqual(await fs.readdir(f.responses), []);
  } finally {
    await f.cleanup();
  }
});

test('file RPC rejects parameters over the bridge 64 KiB protocol limit', async () => {
  const f = await fixture();
  try {
    const client = new FileRpcClient(await createProjectContext(f.root), { deadlineMs: 100 });
    await expectBridgeError(
      () => client.call('status', { payload: 'x'.repeat(64 * 1024) }),
      'BRIDGE_MESSAGE_TOO_LARGE',
    );
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});
