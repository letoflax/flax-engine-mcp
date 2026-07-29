import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor, DOCTOR_EXIT_OK, DOCTOR_EXIT_USAGE } from '../doctor.js';
import { resetServerObservabilityForTests, recordIpcFailure } from '../observability.js';
import { createProjectContext } from '../projectContext.js';
import { dispatchToolCall } from '../index.js';
import { buildToolRegistry } from './index.js';

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-observability-'));
  await fs.mkdir(path.join(root, 'Content', 'Settings'), { recursive: true });
  await fs.mkdir(path.join(root, 'Source', 'Game'), { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture', MinEngineVersion: '1.12' }));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('doctor reports only safe project metadata and has stable usage and success exits', async () => {
  const f = await fixture();
  try {
    const missing = await runDoctor(['node', 'flax-mcp', 'doctor', '--json']);
    assert.equal(missing.exitCode, DOCTOR_EXIT_USAGE);
    const result = await runDoctor(['node', 'flax-mcp', 'doctor', '--project-path', f.root, '--json']);
    assert.equal(result.exitCode, DOCTOR_EXIT_OK);
    assert.equal(result.data.ok, true);
    assert.equal(JSON.stringify(result.data).includes(f.root), false);
    assert.equal((result.data.privacy as Record<string, unknown>).tokenRead, false);
  } finally { await f.cleanup(); }
});

test('server observability tools expose bounded local metrics and redacted errors', async () => {
  const f = await fixture();
  try {
    resetServerObservabilityForTests();
    const ctx = await createProjectContext(f.root);
    const tools = buildToolRegistry(ctx);
    await dispatchToolCall(tools, 'get_project_info', {}, ctx);
    await dispatchToolCall(tools, 'not_a_tool', {}, ctx);
    recordIpcFailure(new Error(`token=abcdefghijklmnopqrstuvwxyz0123456789 path=${f.root} leaked`));
    const metrics = await dispatchToolCall(tools, 'server_get_metrics', {}, ctx);
    const metricData = (metrics.structuredContent as Record<string, any>).data;
    assert.equal(metricData.scope, 'process-local');
    assert.equal(metricData.toolCalls.total, 2);
    assert.equal(metricData.toolCalls.failed, 1);
    assert.equal(metricData.ipc.failures, 1);
    const recent = await dispatchToolCall(tools, 'server_get_recent_errors', { limit: 100 }, ctx);
    const entries = (recent.structuredContent as Record<string, any>).data.entries;
    assert.equal(entries.length, 2);
    assert.equal(JSON.stringify(entries).includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
    assert.equal(JSON.stringify(entries).includes(f.root), false);
    assert.equal((recent.structuredContent as Record<string, any>).data.maxEntries, 100);
  } finally { await f.cleanup(); }
});

test('observability tools remain readable under the read-only permission profile', async () => {
  const f = await fixture();
  try {
    const ctx = await createProjectContext(f.root);
    ctx.permissionPolicy = { profile: 'read-only', allowTools: [], denyTools: [], emergencyReadOnly: true };
    const result = await dispatchToolCall(buildToolRegistry(ctx), 'server_get_health', {}, ctx);
    assert.equal(result.isError, undefined);
  } finally { await f.cleanup(); }
});
