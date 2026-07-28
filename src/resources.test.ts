import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectMeta } from './projectContext.js';
import { listFlaxResources, readFlaxResource } from './resources.js';

async function fixture(): Promise<{ root: string; ctx: ProjectMeta }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-resource-'));
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
    assert.equal(listed.resources.length, 1);
    assert.equal(listed.resources[0].uri, `flax://capture/${id}`);
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
    await assert.rejects(readFlaxResource('flax://capture/../../secret', ctx), /Expected flax/);
    const id = 'fedcba9876543210fedcba9876543210';
    const directory = path.join(root, 'Cache', 'MCP', 'captures');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${id}.png`), 'not a png');
    await assert.rejects(readFlaxResource(`flax://capture/${id}`, ctx), /valid PNG/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
