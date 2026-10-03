import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseProjectPath } from './index.js';

const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

async function project(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-cli-'));
  await fs.mkdir(path.join(root, 'Content'), { recursive: true });
  await fs.mkdir(path.join(root, 'Source'), { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'CliFixture', Version: '1.0', MinEngineVersion: '1.12.0' }));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function cli(args: string[], options: { input?: string; cwd?: string } = {}) {
  const run = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', input: options.input, cwd: options.cwd, timeout: 60_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('call and tools are commands, not project paths', () => {
  assert.throws(() => parseProjectPath(['node', 'flax-mcp', 'call', 'get_project_info']), /Usage: flax-mcp/);
  assert.throws(() => parseProjectPath(['node', 'flax-mcp', 'tools']), /Usage: flax-mcp/);
  assert.equal(parseProjectPath(['node', 'flax-mcp', 'call', 'x', '--project-path', 'P']), 'P');
  assert.equal(parseProjectPath(['node', 'flax-mcp', 'D:/Projects/Game']), 'D:/Projects/Game');
});

test('flax-mcp tools lists the permitted tools with their family', async () => {
  const f = await project();
  try {
    const all = cli(['tools', '--project-path', f.root]);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /^get_project_info\s+read$/m);
    assert.match(all.stdout, /^asset_import\s+asset$/m);
    assert.match(all.stdout, /^editor_launch\s+runtime$/m);

    const readOnly = JSON.parse(cli(['tools', '--json', '--project-path', f.root, '--permission-profile', 'read-only']).stdout) as Array<{ name: string; family: string }>;
    assert.ok(readOnly.length > 0 && readOnly.every(tool => tool.family === 'read'));
    assert.ok(readOnly.some(tool => tool.name === 'get_project_info'));

    const denied = JSON.parse(cli(['tools', '--json', '--project-path', f.root, '--deny-tool', 'get_project_info']).stdout) as Array<{ name: string }>;
    assert.equal(denied.some(tool => tool.name === 'get_project_info'), false);

    const emergency = JSON.parse(cli(['tools', '--json', '--project-path', f.root, '--emergency-read-only']).stdout) as Array<{ family: string }>;
    assert.ok(emergency.every(tool => tool.family === 'read'));
  } finally { await f.cleanup(); }
});

test('flax-mcp call runs an offline tool and prints the envelope', async () => {
  const f = await project();
  try {
    const ok = cli(['call', 'get_project_info', '--project-path', f.root]);
    assert.equal(ok.code, 0, ok.stderr);
    const envelope = JSON.parse(ok.stdout) as { ok: boolean; data: { text: string } };
    assert.equal(envelope.ok, true);
    assert.match(envelope.data.text, /CliFixture/);

    // The same call through the current directory fallback and with explicit JSON arguments.
    const cwd = cli(['call', 'get_project_info', '{}'], { cwd: f.root });
    assert.equal(cwd.code, 0, cwd.stderr);

    // JSON from a file and from stdin.
    await fs.writeFile(path.join(f.root, 'args.json'), '\uFEFF{"checks":["settings"]}');
    const fromFile = cli(['call', 'validate_project', `@${path.join(f.root, 'args.json')}`, '--project-path', f.root]);
    assert.equal(fromFile.code, 0, fromFile.stderr);
    const fromStdin = cli(['call', 'validate_project', '-', '--project-path', f.root], { input: '{"checks":["settings"]}' });
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
  } finally { await f.cleanup(); }
});

test('flax-mcp call exits 1 on tool errors and honours the permission policy', async () => {
  const f = await project();
  try {
    const invalid = cli(['call', 'validate_project', '{"checks":"nope"}', '--project-path', f.root]);
    assert.equal(invalid.code, 1);
    assert.equal((JSON.parse(invalid.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

    const denied = cli(['call', 'get_project_info', '--project-path', f.root, '--deny-tool', 'get_project_info']);
    assert.equal(denied.code, 1);
    assert.equal((JSON.parse(denied.stdout) as { error: { code: string } }).error.code, 'PERMISSION_DENIED');

    const writeDenied = cli(['call', 'asset_import', '{"source_path":"a.png","destination":"Content/A.flax"}', '--project-path', f.root, '--permission-profile', 'read-only']);
    assert.equal(writeDenied.code, 1);
    assert.equal((JSON.parse(writeDenied.stdout) as { error: { code: string } }).error.code, 'PERMISSION_DENIED');
  } finally { await f.cleanup(); }
});

test('flax-mcp call exits 2 on usage errors', async () => {
  const f = await project();
  try {
    for (const args of [
      ['call', '--project-path', f.root],
      ['call', 'no_such_tool', '--project-path', f.root],
      ['call', 'get_project_info', '{not json', '--project-path', f.root],
      ['call', 'get_project_info', '@missing.json', '--project-path', f.root],
      ['call', 'get_project_info', '--bogus', '--project-path', f.root],
      ['call', 'get_project_info', '--project-path', path.join(f.root, 'missing')],
      ['call', 'get_project_info', '--project-path', f.root, '--permission-profile', 'bogus'],
      ['call', 'get_project_info', '--project-path', f.root, '--flax-editor', path.join(f.root, 'NotAnEditor.exe')],
      ['call', 'get_project_info', '--project-path', f.root, '--asset-import-root', 'does-not-exist'],
      ['tools', 'extra', '--project-path', f.root],
    ]) {
      const result = cli(args);
      assert.equal(result.code, 2, `${args.join(' ')} -> ${result.code}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage:/);
    }
  } finally { await f.cleanup(); }
});

test('flax-mcp call resolves relative --asset-import-root against the project and validates --flax-editor', async () => {
  const f = await project();
  try {
    await fs.mkdir(path.join(f.root, 'Content', 'Raws'), { recursive: true });
    const ok = cli(['call', 'get_server_capabilities', '--project-path', f.root, '--asset-import-root', 'Content/Raws'], { cwd: os.tmpdir() });
    assert.equal(ok.code, 0, ok.stderr);
    const features = (JSON.parse(ok.stdout) as { data: { features: { assetImport: { configuredRootCount: number } } } }).data.features;
    assert.equal(features.assetImport.configuredRootCount, 1);

    const editor = path.join(f.root, 'FlaxEditor.exe');
    await fs.writeFile(editor, '');
    const withEditor = cli(['call', 'editor_launch', '{"wait_ready":false}', '--project-path', f.root, '--flax-editor', editor, '--deny-tool', 'editor_launch']);
    assert.equal(withEditor.code, 1);
    assert.equal((JSON.parse(withEditor.stdout) as { error: { code: string } }).error.code, 'PERMISSION_DENIED');

    const withoutEditor = cli(['call', 'editor_launch', '{}', '--project-path', f.root]);
    assert.equal(withoutEditor.code, 1);
    const error = (JSON.parse(withoutEditor.stdout) as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.match(error.message, /--flax-editor/);
  } finally { await f.cleanup(); }
});
