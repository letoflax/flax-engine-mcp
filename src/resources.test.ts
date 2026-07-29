import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectMeta } from './projectContext.js';
import { listFlaxResources, readFlaxResource } from './resources.js';
import { ResourceSubscriptionManager } from './resourceSubscriptions.js';
import { ToolResponse } from './errors.js';

async function fixture(): Promise<{ root: string; ctx: ProjectMeta }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-resource-'));
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

test('capture resources list and read bounded PNG blobs without exposing paths', async () => {
  const { root, ctx } = await fixture();
  try {
    const id = '0123456789abcdef0123456789abcdef';
    const directory = path.join(root, 'Cache', 'MCP', 'captures');
    await fs.mkdir(directory, { recursive: true });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await fs.writeFile(path.join(directory, `${id}.png`), png);
    const listed = await listFlaxResources(ctx);
    assert.ok(listed.resources.some(resource => resource.uri === `flax://capture/${id}`));
    assert.equal(JSON.stringify(listed).includes(root), false);
    const read = await readFlaxResource(`flax://capture/${id}`, ctx);
    assert.equal(read.contents[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(read.contents[0].blob, 'base64'), png);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('capture resource reader rejects traversal and non-PNG files', async () => {
  const { root, ctx } = await fixture();
  try {
    await assert.rejects(readFlaxResource('flax://capture/../../secret', ctx), /resource URI|canonical/);
    const id = 'fedcba9876543210fedcba9876543210';
    const directory = path.join(root, 'Cache', 'MCP', 'captures');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${id}.png`), 'not a png');
    await assert.rejects(readFlaxResource(`flax://capture/${id}`, ctx), /valid PNG/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fixed resources paginate with opaque cursors and reject forged or stale cursors', async () => {
  const { root, ctx } = await fixture();
  try {
    const directory = path.join(root, 'Cache', 'MCP', 'captures');
    await fs.mkdir(directory, { recursive: true });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    for (let i = 0; i < 12; i++) await fs.writeFile(path.join(directory, `${i.toString(16).padStart(32, '0')}.png`), png);
    const first = await listFlaxResources(ctx);
    assert.ok(first.resources.some(resource => resource.uri === 'flax://audit/recent'));
    assert.ok(first.nextCursor);
    await assert.rejects(listFlaxResources(ctx, 'forged-cursor'), /cursor is invalid/i);
    await fs.writeFile(path.join(directory, `${'f'.repeat(32)}.png`), png);
    await assert.rejects(listFlaxResources(ctx, first.nextCursor), /cursor is invalid/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('resource URI validation, JSON quota, and path redaction are bounded', async () => {
  const { root, ctx } = await fixture();
  try {
    await fs.mkdir(path.join(root, 'Content'), { recursive: true });
    await fs.writeFile(path.join(root, 'Content', 'GameSettings.json'), JSON.stringify({ root, huge: 'x'.repeat(300_000) }));
    await assert.rejects(readFlaxResource('flax://project/info?cursor=1', ctx), /must not contain/i);
    await assert.rejects(readFlaxResource('flax://project/%2e%2e/info', ctx), /must not contain/i);
    const read = await readFlaxResource('flax://project/settings', ctx);
    assert.ok(Buffer.byteLength(read.contents[0].text, 'utf8') <= 256 * 1024);
    assert.equal(read.contents[0].text.includes(root), false);
    assert.ok(read.contents[0].text.length < 20_000); // individual strings are bounded before JSON encoding
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('subscription manager is idempotent, debounced, and stops updates after unsubscribe', async () => {
  const { root, ctx } = await fixture();
  const notifications: string[] = [];
  const manager = new ResourceSubscriptionManager(ctx, async (method, params) => { if (method === 'notifications/resources/updated') notifications.push(params.uri); });
  const success = { content: [{ type: 'text', text: 'ok' }] } as ToolResponse;
  try {
    manager.subscribe('flax://editor/status');
    manager.subscribe('flax://editor/status');
    manager.afterTool('write_script', success);
    manager.afterTool('write_script', success);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(notifications, ['flax://editor/status']);
    manager.unsubscribe('flax://editor/status');
    manager.afterTool('write_script', success);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(notifications, ['flax://editor/status']);
    assert.throws(() => manager.subscribe('flax://project/info'), /not available/i);
  } finally { manager.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('capture resource reader rejects symlink files', async t => {
  const { root, ctx } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-resource-outside-'));
  try {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const outsideFile = path.join(outside, `${id}.png`);
    await fs.writeFile(outsideFile, png);
    const directory = path.join(root, 'Cache', 'MCP', 'captures');
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.symlink(outsideFile, path.join(directory, `${id}.png`), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Symlink creation is unavailable on this host.');
      throw error;
    }
    await assert.rejects(readFlaxResource(`flax://capture/${id}`, ctx), /regular project-local file/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('capture resource reader rejects an escaped capture-directory junction', async t => {
  const { root, ctx } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-resource-outside-'));
  try {
    const id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    await fs.writeFile(path.join(outside, `${id}.png`), png);
    await fs.mkdir(path.join(root, 'Cache', 'MCP'), { recursive: true });
    try {
      await fs.symlink(outside, path.join(root, 'Cache', 'MCP', 'captures'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Directory link creation is unavailable on this host.');
      throw error;
    }
    await assert.rejects(readFlaxResource(`flax://capture/${id}`, ctx), /real directory inside the project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
