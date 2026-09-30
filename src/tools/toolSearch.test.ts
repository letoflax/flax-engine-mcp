import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { dispatchToolCall } from '../index.js';
import { buildToolRegistry } from './index.js';

async function fixture(policy?: { profile: 'full' | 'read-only'; allowTools: string[]; denyTools: string[]; emergencyReadOnly: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-toolsearch-'));
  await fs.mkdir(path.join(root, 'Content'), { recursive: true });
  await fs.mkdir(path.join(root, 'Source', 'Game'), { recursive: true });
  await fs.mkdir(path.join(root, 'Logs'), { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  const ctx = await createProjectContext(root);
  if (policy) ctx.permissionPolicy = policy as typeof ctx.permissionPolicy;
  return { root, ctx, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function dataOf(result: Awaited<ReturnType<typeof dispatchToolCall>>): any {
  return result.structuredContent as any;
}

test('query capture finds viewport_capture and capture_compare offline', async () => {
  const f = await fixture();
  try {
    const tools = buildToolRegistry(f.ctx);
    const result = await dispatchToolCall(tools, 'search_tools', { query: 'capture' }, f.ctx);
    assert.equal(result.isError, undefined);
    const data = dataOf(result).data as { query: string; count: number; total_tools: number; tools: Array<{ name: string; description: string; read_only: boolean }> };
    assert.equal(data.query, 'capture');
    assert.ok(data.tools.some(t => t.name === 'viewport_capture'));
    assert.ok(data.tools.some(t => t.name === 'capture_compare'));
    assert.equal(data.count, data.tools.length);
    assert.ok(data.total_tools >= 143);
    for (const t of data.tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.read_only, 'boolean');
    }
  } finally { await f.cleanup(); }
});

test('read-only policy hides write_script but shows read_script', async () => {
  const f = await fixture({ profile: 'read-only', allowTools: [], denyTools: [], emergencyReadOnly: false });
  try {
    const tools = buildToolRegistry(f.ctx);
    const result = await dispatchToolCall(tools, 'search_tools', { query: 'script' }, f.ctx);
    assert.equal(result.isError, undefined);
    const names = ((dataOf(result).data as any).tools as Array<{ name: string }>).map(t => t.name);
    assert.ok(names.includes('read_script'));
    assert.equal(names.includes('write_script'), false);
    // Exact denied name must not leak even on an exact query.
    const exact = await dispatchToolCall(tools, 'search_tools', { query: 'write_script' }, f.ctx);
    const exactNames = ((dataOf(exact).data as any).tools as Array<{ name: string }>).map(t => t.name);
    assert.equal(exactNames.includes('write_script'), false);
  } finally { await f.cleanup(); }
});

test('deny-list hides the denied tool', async () => {
  const f = await fixture({ profile: 'full', allowTools: [], denyTools: ['read_script'], emergencyReadOnly: false });
  try {
    const tools = buildToolRegistry(f.ctx);
    const result = await dispatchToolCall(tools, 'search_tools', { query: 'read_script' }, f.ctx);
    assert.equal(result.isError, undefined);
    const names = ((dataOf(result).data as any).tools as Array<{ name: string }>).map(t => t.name);
    assert.equal(names.includes('read_script'), false);
  } finally { await f.cleanup(); }
});

test('empty query is rejected and limit is honored', async () => {
  const f = await fixture();
  try {
    const tools = buildToolRegistry(f.ctx);
    const rejected = await dispatchToolCall(tools, 'search_tools', { query: '' }, f.ctx);
    assert.equal(rejected.isError, true);
    assert.equal((rejected.structuredContent as any).error.code, 'INVALID_ARGUMENT');
    const limited = await dispatchToolCall(tools, 'search_tools', { query: 'asset', limit: 2 }, f.ctx);
    assert.equal(limited.isError, undefined);
    assert.equal(((dataOf(limited).data as any).tools as unknown[]).length, 2);
    assert.equal((dataOf(limited).data as any).count, 2);
  } finally { await f.cleanup(); }
});

test('ranking puts the exact name first', async () => {
  const f = await fixture();
  try {
    const tools = buildToolRegistry(f.ctx);
    const result = await dispatchToolCall(tools, 'search_tools', { query: 'read_script' }, f.ctx);
    assert.equal(result.isError, undefined);
    const names = ((dataOf(result).data as any).tools as Array<{ name: string }>).map(t => t.name);
    assert.ok(names.length > 0);
    assert.equal(names[0], 'read_script');
  } finally { await f.cleanup(); }
});

test('read_only flag mirrors the registry readOnlyHint annotation', async () => {
  const f = await fixture();
  try {
    const tools = buildToolRegistry(f.ctx);
    const byName = new Map(tools.map(t => [t.name, t]));
    const result = await dispatchToolCall(tools, 'search_tools', { query: 'read_script', limit: 50 }, f.ctx);
    const entries = ((dataOf(result).data as any).tools as Array<{ name: string; read_only: boolean }>);
    for (const entry of entries) {
      assert.equal(entry.read_only, byName.get(entry.name)!.annotations.readOnlyHint);
    }
  } finally { await f.cleanup(); }
});
