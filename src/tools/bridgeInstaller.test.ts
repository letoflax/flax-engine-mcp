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

test('the packaged bridge resolver finds the real version 6 artifact', async () => {
  const f = await fixture();
  try {
    const bundledPath = await locateBundledEditorBridge();
    assert.equal(path.basename(bundledPath), 'FlaxMcpBridge.cs');
    const info = await inspectEditorBridgeInstallation(f.ctx);
    assert.equal(info.bundled.available, true);
    assert.equal(info.bundled.version, '6');
    assert.match(info.bundled.hash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(info.installed.present, false);
  } finally {
    await f.cleanup();
  }
});
