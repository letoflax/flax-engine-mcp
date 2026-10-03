import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext } from '../projectContext.js';
import { sha256 } from '../writeSafety.js';
import {
  inspectEditorBridgeInstallation,
  installEditorBridge,
  InstallEditorBridgeSchema,
  locateBundledEditorBridge,
} from './bridgeInstaller.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-bridge-install-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  const bundled = path.join(root, 'bundle.cs');
  const content = 'public static class FlaxMcpBridge { public const int BridgeVersion = 4; }\n';
  await fs.writeFile(bundled, content);
  return {
    root,
    bundled,
    content,
    target: path.join(root, 'Source', 'Game', 'MCP', 'FlaxMcpBridge.cs'),
    ctx: await createProjectContext(root),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('dry-run previews a bridge install without creating files or directories', async () => {
  const f = await fixture();
  try {
    const result = await installEditorBridge(
      InstallEditorBridgeSchema.parse({ dry_run: true }),
      f.ctx,
      f.bundled,
    );
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as any).data.action, 'create');
    await assert.rejects(fs.access(f.target));
    await assert.rejects(fs.access(path.dirname(f.target)));
  } finally {
    await f.cleanup();
  }
});

test('install uses the bootstrap Game fallback and reports bundled/installed metadata', async () => {
  const f = await fixture();
  try {
    const result = await installEditorBridge(
      InstallEditorBridgeSchema.parse({}),
      f.ctx,
      f.bundled,
    );
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(f.target, 'utf8'), f.content);
    const info = await inspectEditorBridgeInstallation(f.ctx, f.bundled);
    assert.equal(info.target, 'Source/Game/MCP/FlaxMcpBridge.cs');
    assert.equal(info.bundled.version, '4');
    assert.equal(info.installed.hash, sha256(f.content));
    assert.equal(info.current, true);
    assert.doesNotMatch(JSON.stringify(info), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await f.cleanup();
  }
});

test('install detects the module referenced by the editor target', async () => {
  const f = await fixture();
  try {
    const moduleDir = path.join(f.root, 'Source', 'Sample');
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'Sample.Build.cs'), 'public class Sample { }\n');
    await fs.writeFile(path.join(f.root, 'Source', 'FixtureEditorTarget.Build.cs'),
      'public class FixtureEditorTarget { void Init() { Modules.Add(nameof(Sample)); } }\n');
    const result = await installEditorBridge(InstallEditorBridgeSchema.parse({}), f.ctx, f.bundled);
    assert.equal(result.isError, undefined);
    const target = path.join(moduleDir, 'MCP', 'FlaxMcpBridge.cs');
    assert.equal(await fs.readFile(target, 'utf8'), f.content);
    assert.equal((result.structuredContent as any).data.module, 'Sample');
    assert.equal((result.structuredContent as any).data.target, 'Source/Sample/MCP/FlaxMcpBridge.cs');
    await assert.rejects(fs.access(f.target));
  } finally { await f.cleanup(); }
});

test('ambiguous modules require an explicit module selection', async () => {
  const f = await fixture();
  try {
    for (const module of ['Client', 'Server']) {
      const directory = path.join(f.root, 'Source', module);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${module}.Build.cs`), `public class ${module} { }\n`);
    }
    let result = await installEditorBridge(InstallEditorBridgeSchema.parse({}), f.ctx, f.bundled);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
    result = await installEditorBridge(InstallEditorBridgeSchema.parse({ module: 'Client' }), f.ctx, f.bundled);
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as any).data.target, 'Source/Client/MCP/FlaxMcpBridge.cs');
  } finally { await f.cleanup(); }
});

test('replacement requires force or the matching installed hash', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.target), { recursive: true });
    await fs.writeFile(f.target, 'user-edited bridge\n');

    let result = await installEditorBridge(InstallEditorBridgeSchema.parse({}), f.ctx, f.bundled);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'FILE_EXISTS');
    assert.equal(await fs.readFile(f.target, 'utf8'), 'user-edited bridge\n');

    result = await installEditorBridge(
      InstallEditorBridgeSchema.parse({ expected_hash: '0'.repeat(64), force: true }),
      f.ctx,
      f.bundled,
    );
    assert.equal((result.structuredContent as any).error.code, 'FILE_CHANGED');

    result = await installEditorBridge(
      InstallEditorBridgeSchema.parse({ expected_hash: sha256('user-edited bridge\n') }),
      f.ctx,
      f.bundled,
    );
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(f.target, 'utf8'), f.content);
  } finally {
    await f.cleanup();
  }
});

test('the packaged bridge resolver finds the real bundled artifact and reports its version', async () => {
  const f = await fixture();
  try {
    const bundledPath = await locateBundledEditorBridge();
    assert.equal(path.basename(bundledPath), 'FlaxMcpBridge.cs');
    // The expected version comes from the artifact's own header marker, which the installer does not
    // parse, so this stays a cross-check without pinning a number that changes every bridge bump.
    // bridgeV7Contract.test.ts pins the current version once.
    const marker = (await fs.readFile(bundledPath, 'utf8')).match(/MCP-BRIDGE-VERSION:\s*(\d+)/);
    assert.ok(marker, 'the bundled bridge source must carry an MCP-BRIDGE-VERSION header');
    const info = await inspectEditorBridgeInstallation(f.ctx);
    assert.equal(info.bundled.available, true);
    assert.equal(info.bundled.version, marker[1]);
    assert.match(info.bundled.hash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(info.installed.present, false);
  } finally {
    await f.cleanup();
  }
});

const RUNTIME_CONTENT = '#if FLAX_GAME && !BUILD_RELEASE\nnamespace Game.MCP { public class McpRuntimeBridgeInfo { public int BridgeVersion = 35; } }\n#endif\n';

async function runtimeFixture() {
  const f = await fixture();
  const runtimeBundled = path.join(f.root, 'runtime-bundle.cs');
  await fs.writeFile(runtimeBundled, RUNTIME_CONTENT);
  return { ...f, runtimeBundled, runtimeTarget: path.join(path.dirname(f.target), 'FlaxMcpRuntimeBridge.cs') };
}

test('include_runtime installs the runtime bridge next to the editor bridge and reports both files', async () => {
  const f = await runtimeFixture();
  try {
    const preview = await installEditorBridge(InstallEditorBridgeSchema.parse({ include_runtime: true, dry_run: true }), f.ctx, f.bundled, f.runtimeBundled);
    assert.equal(preview.isError, undefined);
    assert.equal((preview.structuredContent as any).data.runtime.action, 'create');
    await assert.rejects(fs.access(path.dirname(f.runtimeTarget)));

    const result = await installEditorBridge(InstallEditorBridgeSchema.parse({ include_runtime: true }), f.ctx, f.bundled, f.runtimeBundled);
    assert.equal(result.isError, undefined);
    const data = (result.structuredContent as any).data;
    assert.equal(data.runtime.target, 'Source/Game/MCP/FlaxMcpRuntimeBridge.cs');
    assert.equal(data.runtime.bundled_version, '35');
    assert.equal(await fs.readFile(f.runtimeTarget, 'utf8'), RUNTIME_CONTENT);
    assert.equal(await fs.readFile(f.target, 'utf8'), f.content);

    const info = await inspectEditorBridgeInstallation(f.ctx, f.bundled, undefined, f.runtimeBundled);
    assert.equal(info.current, true);
    assert.equal(info.runtime.target, 'Source/Game/MCP/FlaxMcpRuntimeBridge.cs');
    assert.equal(info.runtime.bundled.version, '35');
    assert.equal(info.runtime.installed.version, '35');
    assert.equal(info.runtime.installed.hash, sha256(RUNTIME_CONTENT));
    assert.equal(info.runtime.current, true);
    assert.doesNotMatch(JSON.stringify(info), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const again = await installEditorBridge(InstallEditorBridgeSchema.parse({ include_runtime: true }), f.ctx, f.bundled, f.runtimeBundled);
    assert.equal((again.structuredContent as any).data.runtime.action, 'unchanged');
    assert.deepEqual((again.structuredContent as any).changes, []);
  } finally { await f.cleanup(); }
});

test('without include_runtime the runtime bridge is neither installed nor touched', async () => {
  const f = await runtimeFixture();
  try {
    await installEditorBridge(InstallEditorBridgeSchema.parse({}), f.ctx, f.bundled, f.runtimeBundled);
    await assert.rejects(fs.access(f.runtimeTarget));
    const info = await inspectEditorBridgeInstallation(f.ctx, f.bundled, undefined, f.runtimeBundled);
    assert.equal(info.runtime.installed.present, false);
    assert.equal(info.runtime.current, false);
    assert.equal(info.runtime.bundled.available, true);
  } finally { await f.cleanup(); }
});

test('a locally modified runtime bridge is not replaced silently and blocks the whole install', async () => {
  const f = await runtimeFixture();
  try {
    await fs.mkdir(path.dirname(f.runtimeTarget), { recursive: true });
    await fs.writeFile(f.runtimeTarget, 'user-edited runtime bridge\n');
    let result = await installEditorBridge(InstallEditorBridgeSchema.parse({ include_runtime: true }), f.ctx, f.bundled, f.runtimeBundled);
    assert.equal((result.structuredContent as any).error.code, 'FILE_EXISTS');
    assert.equal(await fs.readFile(f.runtimeTarget, 'utf8'), 'user-edited runtime bridge\n');
    await assert.rejects(fs.access(f.target), 'the editor file must not be written when the runtime file is refused');

    result = await installEditorBridge(InstallEditorBridgeSchema.parse({ include_runtime: true, runtime_expected_hash: '0'.repeat(64), force: true }), f.ctx, f.bundled, f.runtimeBundled);
    assert.equal((result.structuredContent as any).error.code, 'FILE_CHANGED');

    result = await installEditorBridge(
      InstallEditorBridgeSchema.parse({ include_runtime: true, runtime_expected_hash: sha256('user-edited runtime bridge\n') }),
      f.ctx, f.bundled, f.runtimeBundled,
    );
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(f.runtimeTarget, 'utf8'), RUNTIME_CONTENT);

    result = await installEditorBridge(InstallEditorBridgeSchema.parse({ runtime_expected_hash: 'a'.repeat(64) }), f.ctx, f.bundled, f.runtimeBundled);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
  } finally { await f.cleanup(); }
});

test('a missing bundled runtime bridge refuses include_runtime without installing anything', async () => {
  const f = await runtimeFixture();
  try {
    const missing = path.join(f.root, 'does-not-exist.cs');
    const result = await installEditorBridge(InstallEditorBridgeSchema.parse({ include_runtime: true }), f.ctx, f.bundled, missing);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'NOT_FOUND');
    await assert.rejects(fs.access(f.target), 'nothing is installed when the runtime bundle cannot be read');
  } finally { await f.cleanup(); }
});

test('the installation report works whether or not the runtime bridge is bundled', async () => {
  const f = await runtimeFixture();
  try {
    const info = await inspectEditorBridgeInstallation(f.ctx, f.bundled);
    assert.equal(typeof info.runtime.bundled.available, 'boolean');
    assert.equal(info.runtime.target, 'Source/Game/MCP/FlaxMcpRuntimeBridge.cs');
    assert.equal(info.runtime.installed.present, false);
    if (info.runtime.bundled.available) {
      assert.match(info.runtime.bundled.hash ?? '', /^[a-f0-9]{64}$/);
      assert.equal(info.runtime.bundled.version, '35');
    } else {
      assert.equal(info.runtime.bundled.version, null);
      assert.equal(info.runtime.bundled.hash, null);
    }
  } finally { await f.cleanup(); }
});
