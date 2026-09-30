import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { isToolAllowed } from '../permissions.js';
import { GetProjectPackagesSchema, handleGetProjectPackages, ProjectPackagesData } from './packages.js';

function envelopeData(result: Awaited<ReturnType<typeof handleGetProjectPackages>>): ProjectPackagesData {
  const envelope = result.structuredContent as Record<string, any>;
  assert.equal(envelope.ok, true);
  return envelope.data as ProjectPackagesData;
}

function serialized(result: Awaited<ReturnType<typeof handleGetProjectPackages>>): string {
  return JSON.stringify(result);
}

// Equivalent JSON modeled on flaxtest.flaxproj (engine + plugin refs). The
// fixture lives in a temp dir; the tool is never pointed at a real project.
function fixtureFlaxproj(): Record<string, unknown> {
  return {
    Name: 'FixturePackages',
    Version: '1.0',
    Company: 'Fixture Company',
    GameTarget: 'GameTarget',
    EditorTarget: 'GameEditorTarget',
    References: [
      { Name: '$(EnginePath)/Flax.flaxproj' },
      { Name: '$(ProjectPath)/Plugins/MotionMatching/MotionMatching.flaxproj' },
      { Name: '$(ProjectPath)/Plugins/MissingPlugin/MissingPlugin.flaxproj' },
      { Name: 'C:\\Engines\\Flax\\Flax.flaxproj' },
      { Name: '/home/builder/Extra/Extra.flaxproj' },
      { Name: 'SomeNativeLib' },
    ],
    MinEngineVersion: '1.12.6912',
  };
}

async function fixture(): Promise<{ root: string; ctx: ProjectMeta; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-packages-'));
  await fs.mkdir(path.join(root, 'Plugins', 'MotionMatching'), { recursive: true });
  await fs.mkdir(path.join(root, 'Plugins', 'ExtraPlugin'), { recursive: true });
  await fs.writeFile(path.join(root, 'FixturePackages.flaxproj'), JSON.stringify(fixtureFlaxproj()));
  await fs.writeFile(
    path.join(root, 'Plugins', 'MotionMatching', 'MotionMatching.flaxproj'),
    JSON.stringify({ Name: 'MotionMatching' }),
  );
  return {
    root,
    ctx: await createProjectContext(root),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('project_get_packages schema takes no arguments', () => {
  assert.deepEqual(GetProjectPackagesSchema.parse({}), {});
});

test('project_get_packages is a read-only offline tool', () => {
  const readOnly = { profile: 'read-only' as const, allowTools: [], denyTools: [], emergencyReadOnly: false };
  const emergency = { profile: 'full' as const, allowTools: [], denyTools: [], emergencyReadOnly: true };
  assert.equal(isToolAllowed('project_get_packages', readOnly), true);
  assert.equal(isToolAllowed('project_get_packages', emergency), true);
});

test('project_get_packages reports engine, plugin, and other references with existence flags', async () => {
  const f = await fixture();
  try {
    const data = envelopeData(await handleGetProjectPackages({}, f.ctx));
    assert.equal(data.name, 'FixturePackages');
    assert.equal(data.project_version, '1.0');
    assert.equal(data.min_engine_version, '1.12.6912');
    assert.equal(data.game_target, 'GameTarget');
    assert.equal(data.editor_target, 'GameEditorTarget');
    assert.equal(typeof data.id, 'string');
    assert.ok(data.id.length > 0);

    const byRaw = new Map(data.references.map(ref => [ref.raw, ref]));
    const engine = byRaw.get('$(EnginePath)/Flax.flaxproj');
    assert.ok(engine);
    assert.equal(engine.kind, 'engine');
    assert.equal(engine.name, 'Flax.flaxproj');
    assert.equal(engine.exists, false);

    const plugin = byRaw.get('$(ProjectPath)/Plugins/MotionMatching/MotionMatching.flaxproj');
    assert.ok(plugin);
    assert.equal(plugin.kind, 'plugin');
    assert.equal(plugin.name, 'MotionMatching.flaxproj');
    assert.equal(plugin.exists, true);

    const missing = byRaw.get('$(ProjectPath)/Plugins/MissingPlugin/MissingPlugin.flaxproj');
    assert.ok(missing);
    assert.equal(missing.kind, 'plugin');
    assert.equal(missing.exists, false);

    const other = byRaw.get('SomeNativeLib');
    assert.ok(other);
    assert.equal(other.kind, 'other');
    assert.equal(other.name, 'SomeNativeLib');
    assert.equal(other.exists, false);

    assert.deepEqual(data.plugins, ['ExtraPlugin', 'MotionMatching']);
  } finally {
    await f.cleanup();
  }
});

test('project_get_packages redacts absolute reference paths and never returns the project path', async () => {
  const f = await fixture();
  try {
    const result = await handleGetProjectPackages({}, f.ctx);
    const data = envelopeData(result);
    const redacted = data.references.filter(ref => ref.raw === '<redacted-path>');
    assert.equal(redacted.length, 2);
    assert.deepEqual(redacted.map(ref => ref.name).sort(), ['Extra.flaxproj', 'Flax.flaxproj']);
    assert.deepEqual(redacted.map(ref => ref.kind).sort(), ['engine', 'plugin']);

    const text = serialized(result);
    assert.doesNotMatch(text, /C:\\/);
    assert.doesNotMatch(text, /\/home\//);
    assert.equal(text.includes(f.root), false);
    assert.equal(text.includes(f.ctx.flaxprojPath), false);
  } finally {
    await f.cleanup();
  }
});

test('project_get_packages reports an empty plugin list when Plugins/ is absent', async () => {
  const f = await fixture();
  try {
    await fs.rm(path.join(f.root, 'Plugins'), { recursive: true, force: true });
    const data = envelopeData(await handleGetProjectPackages({}, f.ctx));
    assert.deepEqual(data.plugins, []);
  } finally {
    await f.cleanup();
  }
});

test('project_get_packages returns clean domain errors for missing and invalid project files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-packages-err-'));
  try {
    await fs.writeFile(path.join(root, 'Err.flaxproj'), JSON.stringify({ Name: 'Err' }));
    const ctx = await createProjectContext(root);

    await fs.rm(path.join(root, 'Err.flaxproj'));
    const missing = await handleGetProjectPackages({}, ctx);
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as Record<string, any>).error.code, 'NOT_FOUND');

    await fs.writeFile(path.join(root, 'Err.flaxproj'), 'not-json{{{');
    const invalid = await handleGetProjectPackages({}, ctx);
    assert.equal(invalid.isError, true);
    assert.equal((invalid.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED');

    await fs.writeFile(path.join(root, 'Err.flaxproj'), '[]');
    const nonObject = await handleGetProjectPackages({}, ctx);
    assert.equal(nonObject.isError, true);
    assert.equal((nonObject.structuredContent as Record<string, any>).error.code, 'VALIDATION_FAILED');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
