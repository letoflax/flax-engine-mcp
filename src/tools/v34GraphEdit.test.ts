import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { GraphEditSchema, GraphListArchetypesSchema, handleGraphEdit, handleGraphListArchetypes } from './graphLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const GRAPH_ID = 'a'.repeat(32);
const CLIP_ID = 'b'.repeat(32);

interface Fixture {
  requests: string;
  responses: string;
  ctx: ProjectMeta;
  cleanup: () => Promise<void>;
}

async function fixture(bridgeVersion = 34): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-graph-edit-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', ProjectId: 'graph-edit-fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1 }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { requests, responses, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function waitForRequest(directory: string, timeoutMs = 1_000): Promise<{ file: string; body: Record<string, unknown> }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() <= end) {
    const name = (await fs.readdir(directory)).find(value => value.endsWith('.json'));
    if (name) {
      const file = path.join(directory, name);
      return { file, body: JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown> };
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the bridge request.');
}

async function respond(f: Fixture, body: Record<string, unknown>): Promise<{ method: unknown; params: Record<string, unknown> }> {
  const request = await waitForRequest(f.requests);
  const target = path.join(f.responses, String(request.body.id) + '.json');
  await fs.writeFile(target + '.tmp', JSON.stringify({ id: request.body.id, token: TOKEN, timestamp: Date.now(), ...body }));
  await fs.rename(target + '.tmp', target);
  return { method: request.body.method, params: JSON.parse(String(request.body.paramsJson)) as Record<string, unknown> };
}

const ok = (result: unknown): Record<string, unknown> => ({ ok: true, resultJson: JSON.stringify(result) });

test('graph_list_archetypes accepts node-id and transition context_path forms and rejects the rest', () => {
  const parse = (value: Record<string, unknown>) => GraphListArchetypesSchema.safeParse(value).success;
  assert.equal(parse({ asset_id: GRAPH_ID }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: [] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: ['4', '12'] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: ['4', 'transition:7:9'] }), true);
  assert.equal(parse({ path: 'Content/Anim/G.flax', context_path: ['4'] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: ['transition:7'] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: ['transition:a:b'] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: ['-1'] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: ['4.5'] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, context_path: Array.from({ length: 9 }, () => '1') }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, path: 'Content/Anim/G.flax' }), false);
  assert.equal(parse({}), false);
  assert.equal(parse({ asset_id: GRAPH_ID, extra: true }), false);
});

test('graph_edit schema enforces op bounds, ref and node id forms, coordinates, and confirmation', () => {
  const parse = (value: Record<string, unknown>) => GraphEditSchema.safeParse(value).success;
  const remove = { op: 'remove', node_id: 3 };
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [remove] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: Array.from({ length: 64 }, () => remove) }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: Array.from({ length: 65 }, () => remove) }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'rename', node_id: 3 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: 3, extra: 1 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: '$n1' }] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: '$1bad' }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: 'abc' }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: -1 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'add_node', ref: 'n1', group_id: 9, type_id: 20 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'add_node', ref: '$n1', group_id: 9, type_id: 20, x: 10001 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'add_node', group_id: 9, type_id: 20, values: [] }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'add_node', group_id: 9, type_id: 20, context_path: ['transition:1:2'] }] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'connect', from_node_id: '$a', from_box_id: 0, to_node_id: 5, to_box_id: 1 }] }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'connect', from_node_id: '$a', from_box_id: -1, to_node_id: 5, to_box_id: 1 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [{ op: 'move', node_id: 1, x: 5 }] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [remove], dry_run: false }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [remove], dry_run: false, confirm: true }), true);
  assert.equal(parse({ asset_id: GRAPH_ID, ops: [remove], dry_run: false, confirm: false }), false);
  assert.equal(parse({ ops: [remove] }), false);
  assert.equal(parse({ asset_id: GRAPH_ID, path: 'Content/Anim/G.flax', ops: [remove] }), false);
});

test('graph_list_archetypes marshals the context path and returns snake_case results', async () => {
  const f = await fixture();
  try {
    const pending = handleGraphListArchetypes(GraphListArchetypesSchema.parse({ asset_id: GRAPH_ID, context_path: ['4', 'transition:7:9'] }), f.ctx);
    const request = await respond(f, ok({
      AssetId: GRAPH_ID,
      ContextKind: 'transition',
      Archetypes: [{
        GroupId: 12, TypeId: 1, Title: '==', Description: 'Equal',
        Inputs: [{ Id: 0, Name: 'A', Type: 'Single' }, { Id: 1, Name: 'B', Type: 'Single' }],
        Outputs: [{ Id: 2, Name: 'Result', Type: 'Boolean' }],
        DefaultValueKinds: ['number', 'number'],
      }],
      ExistingNodes: [{ Id: 1, GroupID: 9, TypeID: 22, Title: 'Rule Output', X: 0, Y: 0, ValuesCount: 0 }],
      Warnings: ['note'],
    }));
    assert.equal(request.method, 'graph.list_archetypes');
    assert.deepEqual(request.params, { AssetId: GRAPH_ID, ContextPath: ['4', 'transition:7:9'] });
    const result = await pending;
    assert.equal(result.isError, undefined);
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    assert.equal(data.asset_id, GRAPH_ID);
    assert.equal(data.context_kind, 'transition');
    assert.deepEqual(data.archetypes, [{
      group_id: 12, type_id: 1, title: '==', description: 'Equal',
      inputs: [{ id: 0, name: 'A', type: 'Single' }, { id: 1, name: 'B', type: 'Single' }],
      outputs: [{ id: 2, name: 'Result', type: 'Boolean' }],
      default_value_kinds: ['number', 'number'],
    }]);
    assert.deepEqual(data.existing_nodes, [{ id: 1, group_id: 9, type_id: 22, title: 'Rule Output', x: 0, y: 0, values_count: 0 }]);
  } finally {
    await f.cleanup();
  }
});

test('graph_edit is a dry run by default and marshals refs, context paths, and typed values', async () => {
  const f = await fixture();
  try {
    const pending = handleGraphEdit(GraphEditSchema.parse({
      path: 'Content/Anim/G.flax',
      ops: [
        { op: 'add_node', context_path: ['4'], ref: '$s', group_id: 9, type_id: 20, x: 10, y: 20, values: [{ index: 0, value: 'Dead' }] },
        { op: 'add_node', context_path: ['4', 'transition:7:9'], ref: '$n1', group_id: 6, type_id: 1, values: [{ index: 0, value: { asset_id: CLIP_ID } }] },
        { op: 'connect', context_path: ['4', 'transition:7:9'], from_node_id: '$n1', from_box_id: 0, to_node_id: 1, to_box_id: 0 },
        { op: 'set_values', node_id: 12, values: [{ index: 4, value: { x: 0, y: 0, z: 0, w: 1.5 } }, { index: 5, value: { asset_id: CLIP_ID } }, { index: 2, value: true }] },
        { op: 'move', node_id: '$s', x: -5.5, y: 7 },
        { op: 'disconnect', from_node_id: 3, from_box_id: 1, to_node_id: 4, to_box_id: 2 },
        { op: 'remove', context_path: [], node_id: 9 },
      ],
    }), f.ctx);
    const request = await respond(f, ok({
      AssetId: GRAPH_ID, DryRun: true, Saved: false,
      Ops: [{ Index: 0, Op: 'add_node', Ref: '$s', NodeId: null, Applied: false, Warnings: ['would add'] }],
      Refs: [{ Ref: '$s', NodeId: null }],
      ProjectRevision: 5,
      Warnings: ['Dry-run preview only.'],
    }));
    assert.equal(request.method, 'graph.edit');
    assert.deepEqual(request.params, {
      Path: 'Content/Anim/G.flax',
      Ops: [
        { Op: 'add_node', ContextPath: ['4'], Ref: '$s', GroupId: 9, TypeId: 20, X: 10, Y: 20, Values: [{ Index: 0, Value: { Kind: 'string', Text: 'Dead' } }] },
        { Op: 'add_node', ContextPath: ['4', 'transition:7:9'], Ref: '$n1', GroupId: 6, TypeId: 1, X: 0, Y: 0, Values: [{ Index: 0, Value: { Kind: 'asset_id', AssetId: CLIP_ID } }] },
        { Op: 'connect', ContextPath: ['4', 'transition:7:9'], FromNodeId: '$n1', FromBoxId: 0, ToNodeId: '1', ToBoxId: 0 },
        {
          Op: 'set_values', NodeId: '12',
          Values: [
            { Index: 4, Value: { Kind: 'vector4', Vector4: { X: 0, Y: 0, Z: 0, W: 1.5 } } },
            { Index: 5, Value: { Kind: 'asset_id', AssetId: CLIP_ID } },
            { Index: 2, Value: { Kind: 'boolean', Boolean: true } },
          ],
        },
        { Op: 'move', NodeId: '$s', X: -5.5, Y: 7 },
        { Op: 'disconnect', FromNodeId: '3', FromBoxId: 1, ToNodeId: '4', ToBoxId: 2 },
        { Op: 'remove', ContextPath: [], NodeId: '9' },
      ],
      DryRun: true,
      Confirm: false,
    });
    const result = await pending;
    assert.equal(result.isError, undefined);
    const envelope = result.structuredContent as { data: Record<string, unknown>; changes?: unknown[]; warnings?: string[] };
    assert.equal(envelope.data.dry_run, true);
    assert.equal(envelope.data.saved, false);
    assert.deepEqual(envelope.data.refs, [{ ref: '$s', node_id: null }]);
    assert.deepEqual(envelope.data.ops, [{ index: 0, op: 'add_node', ref: '$s', node_id: null, applied: false, warnings: ['would add'] }]);
    assert.equal(envelope.data.project_revision, 5);
    assert.deepEqual(envelope.changes ?? [], []);
    assert.ok((envelope.warnings ?? []).includes('Dry-run preview only.'));
  } finally {
    await f.cleanup();
  }
});

test('graph_edit real runs need confirm, carry the lease and idempotency key, and report the change', async () => {
  const f = await fixture();
  try {
    const lease = 'c'.repeat(32);
    const args = { asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: 3 }], dry_run: false, idempotency_key: 'edit-1', lease_id: lease };
    assert.equal(GraphEditSchema.safeParse(args).success, false);
    const pending = handleGraphEdit(GraphEditSchema.parse({ ...args, confirm: true }), f.ctx);
    const request = await respond(f, ok({
      AssetId: GRAPH_ID, DryRun: false, Saved: true,
      Ops: [{ Index: 0, Op: 'remove', Ref: null, NodeId: '3', Applied: true, Warnings: [] }],
      Refs: [], ProjectRevision: 9,
    }));
    assert.deepEqual(request.params, {
      AssetId: GRAPH_ID,
      Ops: [{ Op: 'remove', NodeId: '3' }],
      DryRun: false,
      Confirm: true,
      IdempotencyKey: 'edit-1',
      LeaseId: lease,
    });
    const result = await pending;
    assert.equal(result.isError, undefined);
    const envelope = result.structuredContent as { data: Record<string, unknown>; changes: Array<Record<string, unknown>> };
    assert.equal(envelope.data.saved, true);
    assert.deepEqual(envelope.data.ops, [{ index: 0, op: 'remove', ref: null, node_id: '3', applied: true, warnings: [] }]);
    assert.equal(envelope.changes.length, 1);
    assert.equal(envelope.changes[0].kind, 'graph-edit');
    assert.equal(envelope.changes[0].ops, 1);
  } finally {
    await f.cleanup();
  }
});

test('graph_edit maps bridge failures through the graph error mapping', async () => {
  const f = await fixture();
  try {
    const pending = handleGraphEdit(GraphEditSchema.parse({ asset_id: GRAPH_ID, ops: [{ op: 'add_node', group_id: 9, type_id: 20 }] }), f.ctx);
    await respond(f, {
      ok: false,
      errorCode: 'VALIDATION_FAILED',
      error: 'graph.edit op 0 (add_node) failed: Node archetype (9,20) is not offered in this root context.',
      errorDetails: JSON.stringify({ OpIndex: 0, Op: 'add_node' }),
    });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
  } finally {
    await f.cleanup();
  }
});

test('graph_list_archetypes and graph_edit fail closed on bridges older than v34 without writing a request', async () => {
  const f = await fixture(33);
  try {
    const list = await handleGraphListArchetypes(GraphListArchetypesSchema.parse({ asset_id: GRAPH_ID }), f.ctx);
    assert.equal(list.isError, true);
    assert.equal((list.structuredContent as { error: { code: string } }).error.code, 'UNSUPPORTED_FLAX_VERSION');
    const edit = await handleGraphEdit(GraphEditSchema.parse({ asset_id: GRAPH_ID, ops: [{ op: 'remove', node_id: 3 }] }), f.ctx);
    assert.equal(edit.isError, true);
    assert.equal((edit.structuredContent as { error: { code: string } }).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});
