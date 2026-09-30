import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolResponse } from './errors.js';
import { isFamilyAllowed, PermissionPolicy, toolFamily } from './permissions.js';
import { ProjectMeta } from './projectContext.js';
import { auditOperationOf } from './audit.js';
import { readFlaxResource } from './resources.js';
import { ResourceSubscriptionManager } from './resourceSubscriptions.js';
import { buildToolRegistry } from './tools/index.js';
import { handleMMTuning, MMTuningSchema } from './tools/mmTuning.js';

async function fixture(policy?: PermissionPolicy): Promise<{ root: string; ctx: ProjectMeta }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-registry-'));
  await fs.writeFile(path.join(root, 'fixture.flaxproj'), JSON.stringify({ Name: 'fixture', Version: '1.0.0' }));
  return {
    root,
    ctx: {
      projectPath: root,
      projectName: 'fixture',
      flaxprojPath: path.join(root, 'fixture.flaxproj'),
      contentDir: path.join(root, 'Content'),
      sourceDir: path.join(root, 'Source'),
      logsDir: path.join(root, 'Logs'),
      settingsDir: path.join(root, 'Content', 'Settings'),
      ...(policy ? { permissionPolicy: policy } : {}),
    },
  };
}

const policy = (profile: PermissionPolicy['profile'], emergencyReadOnly = false): PermissionPolicy =>
  ({ profile, allowTools: [], denyTools: [], emergencyReadOnly });

// Tools outside the read family that only read: a play-session inspection.
const NonReadFamilyReaders = new Set(['runtime_inspect_actor']);

test('readOnlyHint agrees with the permission family of every tool', async () => {
  const { root, ctx } = await fixture();
  try {
    const mismatches: string[] = [];
    for (const tool of buildToolRegistry(ctx)) {
      const family = toolFamily(tool.name);
      const expectedReadOnly = family === 'read' || NonReadFamilyReaders.has(tool.name);
      if (tool.annotations.readOnlyHint !== expectedReadOnly) mismatches.push(`${tool.name} (${family})`);
    }
    assert.deepEqual(mismatches, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('family-level permission check follows the four profiles', () => {
  assert.equal(isFamilyAllowed('read', policy('read-only', true)), true);
  assert.equal(isFamilyAllowed('runtime', policy('full')), true);
  assert.equal(isFamilyAllowed('runtime', policy('full', true)), false);
  assert.equal(isFamilyAllowed('runtime', policy('read-only')), false);
  assert.equal(isFamilyAllowed('runtime', policy('code-edit')), false);
  assert.equal(isFamilyAllowed('code', policy('code-edit')), true);
  assert.equal(isFamilyAllowed('runtime', policy('scene-edit')), true);
  assert.equal(isFamilyAllowed('asset', policy('scene-edit')), false);
});

test('mm_tuning rebuild_start is refused before any RPC when the profile forbids runtime tools', async () => {
  const { root, ctx } = await fixture(policy('read-only'));
  try {
    const result = await handleMMTuning(MMTuningSchema.parse({ op: 'rebuild_start' }), ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error?: { code?: string } }).error?.code, 'PERMISSION_DENIED');
    // No request directory was created: the refusal happened in Node.
    await assert.rejects(fs.stat(path.join(root, 'Cache', 'MCP', 'requests')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('subscriptions fire for every mutation family and never for reads', async () => {
  const { root, ctx } = await fixture();
  const sceneTree = `flax://scene/${'a'.repeat(32)}/tree`;
  const notifications: string[] = [];
  let listChanged = 0;
  const manager = new ResourceSubscriptionManager(ctx, async (method, params) => {
    if (method === 'notifications/resources/updated') notifications.push((params as { uri: string }).uri);
    else listChanged += 1;
  });
  const success = { content: [{ type: 'text', text: 'ok' }] } as ToolResponse;
  const settle = () => new Promise(resolve => setTimeout(resolve, 450));
  try {
    for (const uri of [sceneTree, 'flax://logs/recent', 'flax://editor/status', 'flax://code/diagnostics/latest']) manager.subscribe(uri);

    for (const name of ['actor_get_properties', 'asset_search', 'capture_compare']) manager.afterTool(name, success);
    await settle();
    assert.deepEqual(notifications, []);

    manager.afterTool('actor_set_property', success);
    await settle();
    assert.deepEqual(notifications.sort(), ['flax://editor/status', sceneTree].sort());

    notifications.length = 0;
    manager.afterTool('settings_add_tag', success);
    manager.afterTool('editor_set_selection', success);
    await settle();
    assert.deepEqual(notifications, ['flax://editor/status']);

    notifications.length = 0;
    manager.afterTool('runtime_invoke_script_method', success);
    await settle();
    assert.deepEqual(notifications.sort(), ['flax://editor/status', 'flax://logs/recent']);

    notifications.length = 0;
    manager.afterTool('viewport_capture', success);
    manager.afterTool('ui_control_create', { ...success, isError: true });
    await settle();
    assert.deepEqual(notifications, []);
    assert.equal(listChanged, 1);
  } finally { manager.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('bridge request file names are ASCII-only, as PROTOCOL.md states', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'bridge', 'FlaxMcpBridge.cs'), 'utf8');
  const line = source.split('\n').find(candidate => candidate.includes('static bool IsSafeRequestFile('));
  assert.ok(line);
  // char.IsLetterOrDigit accepts every Unicode letter and digit.
  assert.doesNotMatch(line, /IsLetterOrDigit/);
  assert.match(line, /c >= 'a' && c <= 'z'/);
});

test('audit resource reports the recorded operation instead of relabelling it', async () => {
  const { root, ctx } = await fixture();
  try {
    await fs.mkdir(path.join(root, '.flax-mcp'), { recursive: true });
    const rows = [
      { timestamp: '2026-01-01T00:00:00.000Z', operation: 'write_script', target: 'Source/A.cs', dry_run: false, success: true },
      { timestamp: '2026-01-01T00:00:01.000Z', operation: 'asset_move', target: 'Content/A.flax', dry_run: false, success: true },
      { timestamp: '2026-01-01T00:00:02.000Z', operation: '<script>', target: 'x', dry_run: true, success: false },
    ];
    await fs.writeFile(path.join(root, '.flax-mcp', 'audit.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const read = await readFlaxResource('flax://audit/recent', ctx);
    const entries = (JSON.parse(read.contents[0].text) as { entries: Array<{ operation: string }> }).entries;
    assert.deepEqual(entries.map(entry => entry.operation), ['write_script', 'asset_move', 'write_script']);
    assert.equal(auditOperationOf('asset_delete'), 'asset_delete');
    assert.equal(auditOperationOf(undefined), 'write_script');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
