import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import type { ToolResponse } from '../errors.js';
import { AnimgraphSetTransitionSchema, handleAnimgraphSetTransition } from './graphLive.js';
import { AssetCreateSchema, handleAssetCreate } from './contentLifecycleLive.js';
import { buildToolRegistry } from './index.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const GRAPH_ID = 'a'.repeat(32);

interface Fixture { root: string; requests: string; responses: string; ctx: ProjectMeta; cleanup(): Promise<void>; }

async function fixture(version = 34): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-v34-tg-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: version, ProtocolVersion: 1 }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, requests, responses, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function respondOnce(f: Fixture, result: Record<string, unknown>): Promise<{ method: string; params: Record<string, unknown> }> {
  const deadline = Date.now() + 2000;
  let name: string | undefined;
  while (Date.now() < deadline) {
    name = (await fs.readdir(f.requests)).find(value => value.endsWith('.json'));
    if (name) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!name) throw new Error('No bridge request arrived.');
  const file = path.join(f.requests, name);
  const request = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>;
  await fs.unlink(file);
  const target = path.join(f.responses, `${request.id}.json`);
  await fs.writeFile(`${target}.tmp`, JSON.stringify({ id: request.id, token: TOKEN, timestamp: Date.now(), ...result }));
  await fs.rename(`${target}.tmp`, target);
  return { method: request.method, params: JSON.parse(request.paramsJson) as Record<string, unknown> };
}

const ok = (payload: Record<string, unknown>) => ({ ok: true, resultJson: JSON.stringify(payload) });
const envelopeOf = (response: ToolResponse) => response.structuredContent as Record<string, any>;

const base = { asset_id: GRAPH_ID, from_state_node_id: '4', to_state_node_id: '5' };

const settings = (over: Record<string, unknown> = {}) => ({
  BlendDuration: 0.1, BlendMode: 'HermiteCubic', Enabled: true, Solo: false, UseDefaultRule: false, Interruption: [], Order: 0, ...over,
});

test('animgraph_set_transition schema: selector, ids, bounds, at-least-one-setting and confirmation', () => {
  const parse = (value: Record<string, unknown>) => AnimgraphSetTransitionSchema.safeParse(value).success;
  assert.equal(parse({ ...base, blend_duration: 0.35 }), true);
  assert.equal(parse({ from_state_node_id: '4', to_state_node_id: '5', blend_duration: 0.35 }), false, 'a selector is required');
  assert.equal(parse({ ...base, path: 'Content/G.flax', blend_duration: 0.35 }), false, 'exactly one selector');
  assert.equal(parse({ ...base }), false, 'at least one setting is required');
  assert.equal(parse({ ...base, from_state_node_id: 'Idle', blend_duration: 0.2 }), false, 'ids are decimal node ids, not names');
  assert.equal(parse({ asset_id: GRAPH_ID, to_state_node_id: '5', blend_duration: 0.2 }), false, 'from_state_node_id is required');
  assert.equal(parse({ ...base, blend_duration: -0.1 }), false);
  assert.equal(parse({ ...base, blend_duration: 21 }), false);
  assert.equal(parse({ ...base, interruption: ['Nope'] }), false);
  assert.equal(parse({ ...base, interruption: [] }), true, 'an empty interruption list clears the flags');
  assert.equal(parse({ ...base, interruption: ['Instant', 'SourceState'], enabled: false, solo: true, use_default_rule: true, order: 3, blend_mode: 'Linear' }), true);
  assert.equal(parse({ ...base, order: 1.5 }), false);
  assert.equal(parse({ ...base, enabled: true, bogus: 1 }), false, 'strict');
  assert.equal(parse({ ...base, enabled: true, dry_run: false }), false, 'a real write needs confirm');
  assert.equal(parse({ ...base, enabled: true, dry_run: false, confirm: true }), true);
  assert.equal(AnimgraphSetTransitionSchema.parse({ ...base, enabled: true }).dry_run, true, 'dry_run defaults to true');
});

test('animgraph_set_transition marshals snake_case to the DTO, defaults to a dry run and answers snake_case before/after', async () => {
  const f = await fixture();
  try {
    const pending = handleAnimgraphSetTransition(AnimgraphSetTransitionSchema.parse({
      ...base, state_machine_node_id: '3', blend_duration: 0.35, blend_mode: 'Linear', enabled: false, solo: true,
      use_default_rule: true, interruption: ['RuleRechecking', 'DestinationState'], order: 2, lease_id: 'd'.repeat(32),
    }), f.ctx);
    const request = await respondOnce(f, ok({
      AssetId: GRAPH_ID, StateMachineNodeId: '3', FromStateNodeId: '4', ToStateNodeId: '5',
      Before: settings(), After: settings({ BlendDuration: 0.35, BlendMode: 'Linear', Enabled: false, Solo: true, UseDefaultRule: true, Interruption: ['RuleRechecking', 'DestinationState'], Order: 2 }),
      DryRun: true, WouldChange: true, Saved: false, ProjectRevision: 7, Warnings: ['Dry-run preview only.'],
    }));
    assert.equal(request.method, 'animgraph.set_transition');
    assert.deepEqual(request.params, {
      AssetId: GRAPH_ID, StateMachineNodeId: '3', FromStateNodeId: '4', ToStateNodeId: '5',
      BlendDuration: 0.35, BlendMode: 'Linear', Enabled: false, Solo: true, UseDefaultRule: true,
      Interruption: ['RuleRechecking', 'DestinationState'], Order: 2, DryRun: true, Confirm: false, LeaseId: 'd'.repeat(32),
    });
    const response = await pending;
    assert.equal(response.isError, undefined);
    const envelope = envelopeOf(response);
    assert.deepEqual(envelope.warnings, ['Dry-run preview only.']);
    assert.deepEqual(envelope.changes ?? [], []);
    const result = envelope.data.result;
    assert.deepEqual(result.before, { blend_duration: 0.1, blend_mode: 'HermiteCubic', enabled: true, solo: false, use_default_rule: false, interruption: [], order: 0 });
    assert.deepEqual(result.after, { blend_duration: 0.35, blend_mode: 'Linear', enabled: false, solo: true, use_default_rule: true, interruption: ['RuleRechecking', 'DestinationState'], order: 2 });
    assert.equal(result.dry_run, true);
    assert.equal(result.would_change, true);
    assert.equal(result.saved, false);
    assert.equal(result.from_state_node_id, '4');
    assert.equal(result.to_state_node_id, '5');
    assert.equal(result.project_revision, 7);
    assert.equal(JSON.stringify(result).includes('BlendDuration'), false, 'no PascalCase leaks into the result');
  } finally { await f.cleanup(); }
});

test('animgraph_set_transition sends only the given fields and records a change on a confirmed write', async () => {
  const f = await fixture();
  try {
    const pending = handleAnimgraphSetTransition(AnimgraphSetTransitionSchema.parse({
      path: 'Content/Graphs/G.flax', from_state_node_id: '4', to_state_node_id: '5', interruption: [], dry_run: false, confirm: true, idempotency_key: 'k-1',
    }), f.ctx);
    const request = await respondOnce(f, ok({
      AssetId: GRAPH_ID, StateMachineNodeId: '3', FromStateNodeId: '4', ToStateNodeId: '5',
      Before: settings({ Interruption: ['Instant'] }), After: settings(), DryRun: false, WouldChange: true, Saved: true, ProjectRevision: 8, Warnings: [],
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(request.params)), {
      Path: 'Content/Graphs/G.flax', FromStateNodeId: '4', ToStateNodeId: '5', Interruption: [], DryRun: false, Confirm: true, IdempotencyKey: 'k-1',
    });
    const response = await pending;
    const envelope = envelopeOf(response);
    assert.equal(envelope.data.result.saved, true);
    assert.deepEqual(envelope.data.result.before.interruption, ['Instant']);
    assert.deepEqual(envelope.data.result.after.interruption, []);
    assert.equal(envelope.changes.length, 1);
    assert.equal(envelope.changes[0].kind, 'animgraph-transition-settings');
  } finally { await f.cleanup(); }
});

test('animgraph_set_transition is gated on bridge v34 and maps bridge errors', async () => {
  const old = await fixture(33);
  try {
    const response = await handleAnimgraphSetTransition(AnimgraphSetTransitionSchema.parse({ ...base, enabled: true }), old.ctx);
    assert.equal(response.isError, true);
    assert.equal(envelopeOf(response).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
  } finally { await old.cleanup(); }

  const f = await fixture();
  try {
    const missing = handleAnimgraphSetTransition(AnimgraphSetTransitionSchema.parse({ ...base, enabled: true }), f.ctx);
    await respondOnce(f, { ok: false, errorCode: 'NOT_FOUND', error: 'No transition connects the source state to the destination state.' });
    const notFound = await missing;
    assert.equal(notFound.isError, true);
    assert.equal(envelopeOf(notFound).error.code, 'NOT_FOUND');

    const unsupported = handleAnimgraphSetTransition(AnimgraphSetTransitionSchema.parse({ ...base, enabled: true }), f.ctx);
    await respondOnce(f, { ok: false, errorCode: 'UNSUPPORTED_FLAX_VERSION', error: "The Flax Editor does not expose the internal member 'Animation+StateMachineStateBase.Transitions' in this version.", errorDetails: JSON.stringify({ Member: 'Animation+StateMachineStateBase.Transitions' }) });
    const refused = await unsupported;
    assert.equal(refused.isError, true);
    assert.equal(envelopeOf(refused).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.match(envelopeOf(refused).error.message, /StateMachineStateBase\.Transitions/);
  } finally { await f.cleanup(); }
});

test('animgraph_set_transition retries a not-ready surface like the other graph tools', async () => {
  const f = await fixture();
  try {
    const pending = handleAnimgraphSetTransition(AnimgraphSetTransitionSchema.parse({ ...base, enabled: true }), f.ctx);
    await respondOnce(f, { ok: false, errorCode: 'INVALID_STATE', error: 'loading', errorDetails: JSON.stringify({ NotReady: true, RetryAfterMs: 25 }) });
    await respondOnce(f, ok({ AssetId: GRAPH_ID, Before: settings(), After: settings(), DryRun: true, WouldChange: false, Saved: false }));
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.equal(envelopeOf(response).data.result.would_change, false);
  } finally { await f.cleanup(); }
});

test('asset_create GameplayGlobals schema: kind, variables bounds, types, duplicates and kind restriction', () => {
  const parse = (value: Record<string, unknown>) => AssetCreateSchema.safeParse(value).success;
  const create = { kind: 'GameplayGlobals', path: 'Content/Weather/Globals.flax', dry_run: true };
  assert.equal(parse(create), true);
  assert.equal(parse({ ...create, variables: [] }), true);
  assert.equal(parse({ ...create, variables: [{ name: 'Wind', type: 'float', value: '1.5' }, { name: 'Tint', type: 'Color', value: '1,0.5,0.25,1' }] }), true);
  for (const type of ['float', 'int', 'bool', 'Float2', 'Float3', 'Float4', 'Color']) {
    assert.equal(parse({ ...create, variables: [{ name: 'V', type, value: '1' }] }), true, type);
  }
  assert.equal(parse({ ...create, variables: [{ name: 'V', type: 'string', value: 'x' }] }), false, 'unknown type');
  assert.equal(parse({ ...create, variables: [{ name: 'V', type: 'Quaternion', value: '0,0,0,1' }] }), false);
  assert.equal(parse({ ...create, variables: [{ name: 'V', type: 'float', value: '1' }, { name: 'V', type: 'int', value: '2' }] }), false, 'duplicate names');
  assert.equal(parse({ ...create, variables: [{ name: ' ', type: 'float', value: '1' }] }), false, 'blank name');
  assert.equal(parse({ ...create, variables: [{ name: 'V', type: 'float', value: '' }] }), false, 'empty value');
  assert.equal(parse({ ...create, variables: [{ name: 'V', type: 'float', value: 1 }] }), false, 'value is a string');
  assert.equal(parse({ ...create, variables: [{ name: 'V', type: 'float', value: '1', extra: true }] }), false, 'strict entries');
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `V${index}`, type: 'int', value: String(index) }));
  assert.equal(parse({ ...create, variables: many(64) }), true);
  assert.equal(parse({ ...create, variables: many(65) }), false, 'at most 64 variables');
  assert.equal(parse({ kind: 'Material', path: 'Content/M.flax', dry_run: true, variables: [{ name: 'V', type: 'int', value: '1' }] }), false, 'variables only with GameplayGlobals');
  assert.equal(parse({ kind: 'Material', path: 'Content/M.flax', dry_run: true, variables: [] }), false, 'even an empty list is refused for other kinds');
  assert.equal(parse({ kind: 'GameplayGlobals', path: 'Content/Weather/Globals.json', dry_run: true }), false, 'binary kinds use .flax');
  assert.equal(parse({ kind: 'GameplayGlobals', path: 'Content/Weather/Globals.flax' }), false, 'a real write needs confirm');
  assert.equal(parse({ kind: 'GameplayGlobals', path: 'Content/Weather/Globals.flax', confirm: true }), true);
});

test('asset_create GameplayGlobals marshals Variables, requires bridge v34 and still serves other kinds on v33', async () => {
  const f = await fixture();
  try {
    const pending = handleAssetCreate(AssetCreateSchema.parse({
      kind: 'GameplayGlobals', path: 'Content/Weather/Globals.flax', confirm: true, idempotency_key: 'g-1',
      variables: [{ name: 'Wind', type: 'float', value: '1.5' }, { name: 'Tint', type: 'Color', value: '1,0.5,0.25' }],
    }), f.ctx);
    const request = await respondOnce(f, ok({ DryRun: false, Created: true, Kind: 'GameplayGlobals', Path: 'Content/Weather/Globals.flax', Warnings: [] }));
    assert.equal(request.method, 'asset.create');
    assert.deepEqual(JSON.parse(JSON.stringify(request.params)), {
      Kind: 'GameplayGlobals', Path: 'Content/Weather/Globals.flax',
      Variables: [{ Name: 'Wind', Type: 'float', Value: '1.5' }, { Name: 'Tint', Type: 'Color', Value: '1,0.5,0.25' }],
      DryRun: false, Confirm: true, IdempotencyKey: 'g-1',
    });
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.equal(envelopeOf(response).changes[0].assetKind, 'GameplayGlobals');

    const dry = handleAssetCreate(AssetCreateSchema.parse({ kind: 'GameplayGlobals', path: 'Content/Weather/G2.flax', dry_run: true }), f.ctx);
    const preview = await respondOnce(f, ok({ DryRun: true, Created: false, Kind: 'GameplayGlobals', Path: 'Content/Weather/G2.flax' }));
    assert.equal(preview.params.DryRun, true);
    assert.equal('Variables' in JSON.parse(JSON.stringify(preview.params)), false, 'no variables key when none were given');
    assert.deepEqual(envelopeOf(await dry).changes ?? [], []);
  } finally { await f.cleanup(); }

  const old = await fixture(33);
  try {
    const refused = await handleAssetCreate(AssetCreateSchema.parse({ kind: 'GameplayGlobals', path: 'Content/G.flax', dry_run: true }), old.ctx);
    assert.equal(refused.isError, true);
    assert.equal(envelopeOf(refused).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(old.requests), []);
    const material = handleAssetCreate(AssetCreateSchema.parse({ kind: 'Material', path: 'Content/M.flax', dry_run: true }), old.ctx);
    const request = await respondOnce(old, ok({ DryRun: true, Created: false, Kind: 'Material', Path: 'Content/M.flax' }));
    assert.equal(request.method, 'asset.create');
    assert.equal((await material).isError, undefined);
  } finally { await old.cleanup(); }
});

test('both tools are registered and describe their v34 behaviour', () => {
  const tools = buildToolRegistry({ projectPath: process.cwd() } as ProjectMeta);
  const transition = tools.find(tool => tool.name === 'animgraph_set_transition');
  assert.ok(transition);
  assert.match(transition.description, /reflection/i);
  assert.match(transition.description, /bridge v34/i);
  assert.doesNotMatch(transition.description, /not implemented/i);
  const create = tools.find(tool => tool.name === 'asset_create');
  assert.ok(create);
  assert.match(create.description, /GameplayGlobals/);
  assert.match(JSON.stringify(create.inputSchema), /variables/);
});
