import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  GraphAddParameterSchema,
  GraphInspectSchema,
  GraphSetDefaultParameterSchema,
  GraphUndoSchema,
  handleGraphAddParameter,
  handleGraphInspect,
  handleGraphSetDefaultParameter,
  handleGraphUndo,
} from './graphLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const GRAPH_ID = 'a'.repeat(32);
const PARAMETER_ID = 'c'.repeat(32);

interface Fixture {
  root: string;
  requests: string;
  responses: string;
  ctx: ProjectMeta;
  cleanup: () => Promise<void>;
}

async function fixture(bridgeVersion = 16): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-graph-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'graph-fixture' }));
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
  throw new Error('Timed out waiting for graph bridge request.');
}

async function respond(f: Fixture, body: Record<string, unknown>): Promise<{ body: Record<string, unknown>; params: Record<string, unknown> }> {
  const request = await waitForRequest(f.requests);
  const target = path.join(f.responses, String(request.body.id) + '.json');
  await fs.writeFile(target + '.tmp', JSON.stringify({ id: request.body.id, token: TOKEN, timestamp: Date.now(), ...body }));
  await fs.rename(target + '.tmp', target);
  return { body: request.body, params: JSON.parse(String(request.body.paramsJson)) as Record<string, unknown> };
}

test('graph schemas reject ambiguous selectors, bad limits, and unconfirmed writes', () => {
  assert.equal(GraphInspectSchema.safeParse({ asset_id: GRAPH_ID, path: 'Content/Graphs/G.flax' }).success, false);
  assert.equal(GraphInspectSchema.safeParse({ path: 'Content/../G.flax' }).success, false);
  assert.equal(GraphInspectSchema.safeParse({ path: 'Content/Graphs/G.flax', limit: 501 }).success, false);
  assert.equal(GraphInspectSchema.safeParse({ path: 'Content/Graphs/G.flax' }).success, true);
  assert.equal(GraphSetDefaultParameterSchema.safeParse({ asset_id: GRAPH_ID, parameter_id: PARAMETER_ID, parameter_name: 'Speed', value: 1 }).success, false);
  assert.equal(GraphSetDefaultParameterSchema.safeParse({ asset_id: GRAPH_ID, parameter_name: 'Speed', value: 1 }).success, true);
  assert.equal(GraphSetDefaultParameterSchema.safeParse({ asset_id: GRAPH_ID, parameter_name: 'Speed', value: 1, dry_run: false }).success, false);
  assert.equal(GraphAddParameterSchema.safeParse({ asset_id: GRAPH_ID, name: 'P', type: 'texture' }).success, false);
  assert.equal(GraphAddParameterSchema.safeParse({ asset_id: GRAPH_ID, name: 'P', type: 'color', dry_run: false }).success, false);
  assert.equal(GraphAddParameterSchema.safeParse({ asset_id: GRAPH_ID, name: 'P', type: 'color' }).success, true);
  assert.equal(GraphUndoSchema.safeParse({}).success, false);
});

test('graph reads marshal PascalCase requests against bridge v16', async () => {
  const f = await fixture();
  try {
    const inspect = handleGraphInspect(GraphInspectSchema.parse({ path: 'Content/Graphs/G.flax', limit: 10 }), f.ctx);
    const first = await respond(f, { ok: true, resultJson: JSON.stringify({ Nodes: [], Boxes: [], Parameters: [], HasMore: false }) });
    assert.equal(first.body.method, 'graph.inspect');
    assert.deepEqual(first.params, { Path: 'Content/Graphs/G.flax', IncludeValues: false, IncludeBoxes: true, Limit: 10 });
    assert.equal((await inspect).isError, undefined);

    const undo = handleGraphUndo(GraphUndoSchema.parse({ asset_id: GRAPH_ID }), f.ctx);
    const second = await respond(f, { ok: true, resultJson: JSON.stringify({ Asset: null, Undone: false, CanUndo: false }) });
    assert.equal(second.body.method, 'graph.undo');
    assert.deepEqual(second.params, { AssetId: GRAPH_ID });
    assert.equal((await undo).isError, undefined);
  } finally {
    await f.cleanup();
  }
});

test('graph writes stay dry-run by default and marshal typed values', async () => {
  const f = await fixture();
  try {
    const setDefault = handleGraphSetDefaultParameter(GraphSetDefaultParameterSchema.parse({
      asset_id: GRAPH_ID,
      parameter_name: 'Speed',
      value: { x: 1, y: 2 },
    }), f.ctx);
    const first = await respond(f, { ok: true, resultJson: JSON.stringify({ DryRun: true, Saved: false }) });
    assert.equal(first.body.method, 'graph.set_default_parameter');
    assert.deepEqual(first.params, {
      AssetId: GRAPH_ID,
      ParameterName: 'Speed',
      Value: { Kind: 'vector2', Vector2: { X: 1, Y: 2 } },
      DryRun: true,
      Confirm: false,
    });
    assert.equal((await setDefault).isError, undefined);

    const add = handleGraphAddParameter(GraphAddParameterSchema.parse({
      path: 'Content/Materials/M.flax',
      name: 'Tint',
      type: 'vector4',
      value: { x: 1, y: 0, z: 0, w: 1 },
      dry_run: false,
      confirm: true,
      idempotency_key: 'key-1',
    }), f.ctx);
    const second = await respond(f, { ok: true, resultJson: JSON.stringify({ DryRun: false, Saved: true }) });
    assert.equal(second.body.method, 'graph.add_parameter');
    assert.deepEqual(second.params, {
      Path: 'Content/Materials/M.flax',
      Name: 'Tint',
      Type: 'vector4',
      Value: { Kind: 'vector4', Vector4: { X: 1, Y: 0, Z: 0, W: 1 } },
      IsPublic: true,
      DryRun: false,
      Confirm: true,
      IdempotencyKey: 'key-1',
    });
    assert.equal((await add).isError, undefined);
  } finally {
    await f.cleanup();
  }
});

test('graph methods fail closed before writing a request to bridges older than v16', async () => {
  const f = await fixture(15);
  try {
    const result = await handleGraphInspect(GraphInspectSchema.parse({ asset_id: GRAPH_ID }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

// Pops exactly one pending request (mimics the editor bridge pickup, which
// moves the file to processing/) so retry tests pair responses 1:1.
async function respondOnce(f: Fixture, body: Record<string, unknown>): Promise<{ body: Record<string, unknown>; params: Record<string, unknown> }> {
  const request = await waitForRequest(f.requests);
  await fs.unlink(request.file);
  const target = path.join(f.responses, String(request.body.id) + '.json');
  await fs.writeFile(target + '.tmp', JSON.stringify({ id: request.body.id, token: TOKEN, timestamp: Date.now(), ...body }));
  await fs.rename(target + '.tmp', target);
  return { body: request.body, params: JSON.parse(String(request.body.paramsJson)) as Record<string, unknown> };
}

function notReadyResponse(retryAfterMs = 25): Record<string, unknown> {
  return {
    ok: false,
    errorCode: 'INVALID_STATE',
    error: 'The graph asset is still loading in the editor window.',
    errorDetails: JSON.stringify({ NotReady: true, RetryAfterMs: retryAfterMs, AssetId: GRAPH_ID }),
  };
}

test('graph calls retry not-ready surface responses then succeed', async () => {
  const f = await fixture();
  try {
    const inspect = handleGraphInspect(GraphInspectSchema.parse({ path: 'Content/Graphs/G.flax' }), f.ctx);
    await respondOnce(f, notReadyResponse());
    await respondOnce(f, notReadyResponse());
    const third = await respondOnce(f, { ok: true, resultJson: JSON.stringify({ Nodes: [{ Id: 7 }], Boxes: [], Parameters: [] }) });
    assert.equal(third.body.method, 'graph.inspect');
    const out = await inspect;
    assert.equal(out.isError, undefined);
    assert.match(JSON.stringify(out.structuredContent), /"Id":7/);
  } finally {
    await f.cleanup();
  }
});

test('graph calls stop retrying after repeated not-ready responses', async () => {
  const f = await fixture();
  try {
    const inspect = handleGraphInspect(GraphInspectSchema.parse({ path: 'Content/Graphs/G.flax' }), f.ctx);
    for (let i = 0; i < 6; i++) await respondOnce(f, notReadyResponse(10));
    const out = await inspect;
    assert.equal(out.isError, true);
    assert.equal((out.structuredContent as any).error.code, 'EDITOR_BUSY');
  } finally {
    await f.cleanup();
  }
});

test('graph calls do not retry INVALID_STATE without the not-ready marker', async () => {
  const f = await fixture();
  try {
    const inspect = handleGraphInspect(GraphInspectSchema.parse({ path: 'Content/Graphs/G.flax' }), f.ctx);
    await respondOnce(f, { ok: false, errorCode: 'INVALID_STATE', error: 'Headless mode has no GUI surface.' });
    const out = await inspect;
    assert.equal(out.isError, true);
    assert.equal((out.structuredContent as any).error.code, 'EDITOR_BUSY');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});
