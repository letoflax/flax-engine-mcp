import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { dispatchToolCall } from '../index.js';
import { buildToolRegistry } from './index.js';
import {
  BRIDGE_HEARTBEAT_MAX_AGE_MS, bridgeAtLeast, handleGetServerCapabilities, inspectEditorBridge, readProjectIdentity,
  type EditorBridgeStatus,
} from './serverStatus.js';

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

function bridgeStatus(overrides: Partial<EditorBridgeStatus>): EditorBridgeStatus {
  return {
    connected: true, reason: 'connected', pid: 1, heartbeatAgeMs: 0,
    editorVersion: '1.12', bridgeVersion: '33', protocolVersion: '1', endpoint: null, ...overrides,
  };
}

test('bridgeAtLeast needs a live protocol v1 bridge at or above the minimum', () => {
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: '33' }), 33), true);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: '34' }), 33), true);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: '32' }), 33), false);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: '33', connected: false, reason: 'heartbeat_stale' }), 5), false);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: '33', protocolVersion: '2' }), 5), false);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: '33', protocolVersion: null }), 5), false);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: null }), 5), false);
  assert.equal(bridgeAtLeast(bridgeStatus({ bridgeVersion: 'abc' }), 5), false);
});

/**
 * Lowest bridge version that turns each boolean capability on; null means no
 * bridge turns it on. Recorded from the server before the bridgeAtLeast
 * helper replaced the repeated version comparisons, so this table proves the
 * reported capability object did not change.
 */
const CAPABILITY_MINIMUM_BRIDGE: Record<string, number | null> = {
  fileTools: 0,
  liveEditor: 0,
  sceneFileWrite: 0,
  structuredOutput: 0,
  codeCompile: 6,
  playMode: 6,
  liveLogs: 6,
  viewportCapture: 6,
  editorViewportCapture: 22,
  playTimeScale: 23,
  editorSelection: 24,
  sceneOpen: 25,
  inputSimulation: 26,
  perfSnapshot: 27,
  runtimeInspection: 6,
  sceneRevisions: 7,
  editLeases: 7,
  idempotentEditorWrites: 7,
  safeActorSurface: 7,
  arbitraryActorProperties: null,
  scriptInstanceEnabledPatch: 5,
  scriptFieldWrite: 28,
  actorPropertyWrite: 28,
  actorPropertyRead: 33,
  editorVisibleActorProperties: 33,
  uiControls: 33,
  particleParameters: 33,
  runtimeScriptDrive: 33,
  settingsWrite: 33,
  sceneCreate: 33,
  sceneClose: 33,
  contentFolderCreate: 33,
  assetCreate: 33,
  progressNotifications: 0,
  arbitrarySerializedScriptProperties: null,
  assetSearch: 8,
  assetRegistryMetadata: 8,
  assetDependencyGraph: 8,
  assetReverseReferences: 8,
  assetImportSettings: 32,
  assetReferenceLocations: null,
  'assetImport.available': 9,
  // Enabled also needs a configured import root, which this fixture has none of.
  'assetImport.enabled': null,
  'assetImport.settings': 32,
  'assetOrganization.available': 10,
  'assetOrganization.move': 10,
  'assetOrganization.rename': 10,
  'assetOrganization.duplicate': 10,
  'assetOrganization.quarantineDelete': 13,
  'assetOrganization.permanentDelete': null,
  'assetOrganization.undo': null,
  'assetOrganization.editLeases': null,
  'assetOrganization.referenceImpact': 10,
  operationHandles: 11,
  operationProgress: 11,
  operationCancel: 11,
  mcpTasks: null,
  'prefab.available': 12,
  'prefab.create': 12,
  'prefab.instantiate': 12,
  'prefab.loadedSceneInstances': 12,
  'prefab.overrides': 30,
  'prefab.applyOverrides': 30,
  'prefab.revertOverrides': 30,
  'prefab.breakLink': 30,
  'buildCook.available': 13,
  'buildCook.targets': 13,
  'buildCook.preflightOnly': 13,
  'buildCook.cancel': 13,
  'material.available': 13,
  'material.parameters': 13,
  'material.setParameters': 29,
  'material.createInstance': 29,
  'material.assignToActor': 29,
  'animation.available': 13,
  'animation.listClips': 13,
  'animation.graphParameters': 13,
  'animation.setGraphParameter': null,
  'animation.validateBindings': 13,
  'domainTools.available': 14,
  'domainTools.physicsQueries': 14,
  'domainTools.navigationQueries': 14,
  'domainTools.navigationBuild': 31,
  'domainTools.lightingValidation': 14,
  'domainTools.lightingBake': 31,
  'domainTools.environmentProbeBake': 31,
  'domainTools.terrainFoliageRead': 14,
  'domainTools.terrainPaint': null,
  'domainTools.foliageInstanceWrite': 31,
};

function booleanFlags(value: unknown, prefix = ''): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  if (typeof value === 'boolean') flags.set(prefix, value);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      for (const [name, flag] of booleanFlags(child, prefix ? `${prefix}.${key}` : key)) flags.set(name, flag);
    }
  }
  return flags;
}

async function reportedFlags(root: string, heartbeat: Record<string, unknown> | null): Promise<Map<string, boolean>> {
  const bridgeFile = path.join(root, 'Cache', 'MCP', 'bridge.json');
  await fs.mkdir(path.dirname(bridgeFile), { recursive: true });
  if (heartbeat) {
    await fs.writeFile(bridgeFile, JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), ...heartbeat }));
  } else {
    await fs.rm(bridgeFile, { force: true });
  }
  const result = await handleGetServerCapabilities({}, await createProjectContext(root));
  return booleanFlags((result.structuredContent as Record<string, any>).data.features);
}

test('capability flags turn on at exactly the bridge version that added them', async () => {
  const f = await fixture();
  try {
    for (let version = 0; version <= 40; version++) {
      const flags = await reportedFlags(f.root, { BridgeVersion: version, ProtocolVersion: 1 });
      assert.deepEqual([...flags.keys()].sort(), Object.keys(CAPABILITY_MINIMUM_BRIDGE).sort(),
        'every boolean capability needs an entry in CAPABILITY_MINIMUM_BRIDGE');
      for (const [name, minimum] of Object.entries(CAPABILITY_MINIMUM_BRIDGE)) {
        assert.equal(flags.get(name), minimum !== null && version >= minimum, `${name} at bridge v${version}`);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test('gated capabilities stay off without a live protocol v1 bridge that reports a version', async () => {
  const f = await fixture();
  const alwaysOn = ['fileTools', 'sceneFileWrite', 'structuredOutput', 'progressNotifications'];
  try {
    const offline = await reportedFlags(f.root, null);
    assert.deepEqual([...offline].filter(([, on]) => on).map(([name]) => name).sort(), [...alwaysOn].sort());
    // liveEditor only asks whether a bridge is connected, not which version it is.
    for (const heartbeat of [{ BridgeVersion: 33, ProtocolVersion: 2 }, { ProtocolVersion: 1 }, { BridgeVersion: 'abc', ProtocolVersion: 1 }]) {
      const flags = await reportedFlags(f.root, heartbeat);
      assert.deepEqual([...flags].filter(([, on]) => on).map(([name]) => name).sort(), [...alwaysOn, 'liveEditor'].sort(), JSON.stringify(heartbeat));
    }
    // A stale heartbeat is not a connected bridge, whatever version it last reported.
    const stale = await reportedFlags(f.root, { BridgeVersion: 33, ProtocolVersion: 1, Timestamp: Date.now() - BRIDGE_HEARTBEAT_MAX_AGE_MS - 5_000 });
    assert.deepEqual([...stale].filter(([, on]) => on).map(([name]) => name).sort(), [...alwaysOn].sort());
    // The heartbeat file may carry the versions as strings.
    const asStrings = await reportedFlags(f.root, { BridgeVersion: '33', ProtocolVersion: '1' });
    assert.equal(asStrings.get('assetCreate'), true);
  } finally {
    await f.cleanup();
  }
});
