import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchToolCall } from '../index.js';
import { isToolAllowed, toolFamily } from '../permissions.js';
import type { ProjectMeta } from '../projectContext.js';
import { buildToolRegistry } from './index.js';

// A project root is never touched: the v34 skeleton handlers answer before any bridge call.
const ctx = { projectPath: process.cwd() } as ProjectMeta;

const V34_TOOLS: Array<[string, string]> = [
  ['editor_quit', 'runtime'], ['editor_launch', 'runtime'], ['editor_options', 'code'],
  ['graph_list_archetypes', 'read'], ['graph_edit', 'asset'], ['animgraph_set_transition', 'asset'],
];

test('the six v34 tools are registered in their permission families', () => {
  const tools = buildToolRegistry(ctx);
  for (const [name, family] of V34_TOOLS) {
    assert.equal(toolFamily(name), family, name);
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `${name} must be registered`);
    assert.match(tool.description, /bridge v34/i);
    assert.equal(tool.annotations.readOnlyHint, family === 'read', name);
  }
  assert.match(tools.find(tool => tool.name === 'editor_launch')!.description, /--flax-editor/);
  assert.equal(isToolAllowed('graph_edit', { profile: 'scene-edit', allowTools: [], denyTools: [], emergencyReadOnly: false }), false);
  assert.equal(isToolAllowed('editor_quit', { profile: 'scene-edit', allowTools: [], denyTools: [], emergencyReadOnly: false }), true);
});

test('v34 schemas stay strict and enforce their bounds and confirmations', async () => {
  const tools = buildToolRegistry(ctx);
  const code = async (name: string, args: Record<string, unknown>) =>
    ((await dispatchToolCall(tools, name, args, ctx)).structuredContent as { error?: { code: string } }).error?.code;
  assert.equal(await code('editor_quit', { unsaved: 'maybe' }), 'INVALID_ARGUMENT');
  assert.equal(await code('editor_quit', { timeout_ms: 120001 }), 'INVALID_ARGUMENT');
  assert.equal(await code('editor_launch', { timeout_ms: 300001 }), 'INVALID_ARGUMENT');
  assert.equal(await code('editor_options', { set: { name: 'Other', value: true } }), 'INVALID_ARGUMENT');
  assert.equal(await code('editor_options', { set: { name: 'ForceScriptCompilationOnStartup', value: true }, dry_run: false }), 'INVALID_ARGUMENT');
  assert.equal(await code('graph_edit', { asset_id: 'a'.repeat(32), ops: [] }), 'INVALID_ARGUMENT');
  assert.equal(await code('graph_edit', { asset_id: 'a'.repeat(32), ops: Array.from({ length: 65 }, () => ({ op: 'remove', node_id: 1 })) }), 'INVALID_ARGUMENT');
  assert.equal(await code('graph_edit', { asset_id: 'a'.repeat(32), ops: [{ op: 'remove', node_id: 1 }], dry_run: false }), 'INVALID_ARGUMENT');
  assert.equal(await code('graph_edit', { asset_id: 'a'.repeat(32), ops: [{ op: 'remove', node_id: 1, extra: true }] }), 'INVALID_ARGUMENT');
  assert.equal(await code('graph_edit', { ops: [{ op: 'remove', node_id: 1 }] }), 'INVALID_ARGUMENT');
  assert.equal(await code('animgraph_set_transition', { asset_id: 'a'.repeat(32), from_state_node_id: '4', to_state_node_id: '5', interruption: ['Nope'] }), 'INVALID_ARGUMENT');
});
