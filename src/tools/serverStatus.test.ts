import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { dispatchToolCall } from '../index.js';
import { buildToolRegistry } from './index.js';
import { BRIDGE_HEARTBEAT_MAX_AGE_MS, inspectEditorBridge, readProjectIdentity } from './serverStatus.js';

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-status-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({
    Name: 'Fixture',
    Version: '2.5',
    ProjectId: 'fixture-guid',
    MinEngineVersion: '1.12',
  }));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('readProjectIdentity uses explicit project metadata without exposing its path', async () => {
  const f = await fixture();
  try {
    const identity = await readProjectIdentity(await createProjectContext(f.root));
    assert.equal(identity.id, 'fixture-guid');
    assert.equal(identity.version, '2.5');
    assert.equal(identity.minEngineVersion, '1.12');
    assert.match(identity.pathHash, /^[a-f0-9]{64}$/);
  } finally {
    await f.cleanup();
  }
});

test('bridge connects only for a matching, live, fresh heartbeat', async () => {
  const f = await fixture();
  const now = Date.now();
  try {
    await fs.mkdir(path.join(f.root, 'Cache', 'MCP'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'Cache', 'MCP', 'bridge.json'), JSON.stringify({
      projectPath: f.root,
      pid: 1234,
      heartbeatAt: now,
      editorVersion: '1.12',
    }));
    const status = await inspectEditorBridge(await createProjectContext(f.root), now, () => true);
    assert.equal(status.connected, true);
    assert.equal(status.reason, 'connected');
    assert.equal(status.editorVersion, '1.12');
  } finally {
    await f.cleanup();
  }
});

test('bridge accepts the PascalCase bridge heartbeat shape', async () => {
  const f = await fixture();
  const now = Date.now();
  try {
    await fs.mkdir(path.join(f.root, 'Cache', 'MCP'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'Cache', 'MCP', 'bridge.json'), JSON.stringify({
      Pid: 4321,
      Project: f.root,
      BridgeVersion: 5,
      ProtocolVersion: 1,
      EditorVersion: '1.12.0',
      Timestamp: new Date(now).toISOString(),
    }));
    const status = await inspectEditorBridge(await createProjectContext(f.root), now, () => true);
    assert.equal(status.connected, true);
    assert.equal(status.bridgeVersion, '5');
    assert.equal(status.protocolVersion, '1');
    assert.equal(status.editorVersion, '1.12.0');
    assert.equal(status.pid, 4321);
  } finally {
    await f.cleanup();
  }
});

test('bridge rejects project mismatch, dead process, and stale heartbeat', async () => {
  const f = await fixture();
  const now = Date.now();
  const heartbeatPath = path.join(f.root, 'Cache', 'MCP', 'bridge.json');
  try {
    await fs.mkdir(path.dirname(heartbeatPath), { recursive: true });
    await fs.writeFile(heartbeatPath, JSON.stringify({
      projectPath: path.join(f.root, 'other'),
      pid: 1234,
      heartbeatAt: now,
    }));
    let status = await inspectEditorBridge(await createProjectContext(f.root), now, () => true);
    assert.equal(status.reason, 'project_mismatch');

    await fs.writeFile(heartbeatPath, JSON.stringify({ projectId: 'fixture-guid', pid: 1234, heartbeatAt: now }));
    status = await inspectEditorBridge(await createProjectContext(f.root), now, () => false);
    assert.equal(status.reason, 'process_not_running');

    await fs.writeFile(heartbeatPath, JSON.stringify({
      projectId: 'fixture-guid',
      pid: 1234,
      heartbeatAt: now - BRIDGE_HEARTBEAT_MAX_AGE_MS - 1,
    }));
    status = await inspectEditorBridge(await createProjectContext(f.root), now, () => true);
    assert.equal(status.reason, 'heartbeat_stale');

    await fs.writeFile(heartbeatPath, JSON.stringify({
      projectId: 'FIXTURE-GUID',
      pid: 1234,
      heartbeatAt: now + 60_000,
    }));
    status = await inspectEditorBridge(await createProjectContext(f.root), now, () => true);
    assert.equal(status.reason, 'heartbeat_invalid');
  } finally {
    await f.cleanup();
  }
});

test('editor status dispatch preserves editor-connected mode and typed data', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'Cache', 'MCP'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'Cache', 'MCP', 'bridge.json'), JSON.stringify({
      projectPath: f.root,
      pid: process.pid,
      heartbeatAt: Date.now(),
      editorVersion: '1.12',
    }));
    const ctx = await createProjectContext(f.root);
    const result = await dispatchToolCall(buildToolRegistry(ctx), 'editor_get_status', {}, ctx);
    const envelope = result.structuredContent as Record<string, any>;

    assert.equal(result.isError, undefined);
    assert.equal(envelope.mode, 'editor-connected');
    assert.equal(envelope.data.mode, 'editor-connected');
    assert.equal(envelope.data.connected, true);
    assert.equal(envelope.data.editorVersion, '1.12');
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /editor-connected/);
  } finally {
    await f.cleanup();
  }
});
