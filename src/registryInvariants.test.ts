import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolResponse } from './errors.js';
import { toolFamily } from './permissions.js';
import { ProjectMeta } from './projectContext.js';
import { auditOperationOf } from './audit.js';
import { readFlaxResource } from './resources.js';
import { ResourceSubscriptionManager } from './resourceSubscriptions.js';
import { buildToolRegistry } from './tools/index.js';

async function fixture(): Promise<{ root: string; ctx: ProjectMeta }> {
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
    },
  };
}

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

test('the registry offers no game-specific motion-matching tools', async () => {
  const { root, ctx } = await fixture();
  try {
    const names = buildToolRegistry(ctx).map(tool => tool.name);
    for (const name of ['mm_tuning', 'mm_apply_preset']) {
      assert.equal(names.includes(name), false);
      assert.equal(toolFamily(name), undefined);
    }
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
