import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { decodeText } from '../textEncoding.js';
import { handleGetSceneActors, handleListAssets } from './assets.js';
import { handleGetScriptClasses } from './codeAnalysis.js';
import { handleSearchInFiles } from './files.js';
import { handleValidateProject } from './intelligence.js';
import { handleGetLatestLog } from './logs.js';

function resultText(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block && block.type === 'text');
  return block.text;
}

async function fixture(): Promise<{ root: string; ctx: ProjectMeta; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-read-'));
  await Promise.all([
    fs.mkdir(path.join(root, 'Content'), { recursive: true }),
    fs.mkdir(path.join(root, 'Source', 'Game'), { recursive: true }),
    fs.mkdir(path.join(root, 'Logs'), { recursive: true }),
    fs.mkdir(path.join(root, 'docs'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  return {
    root,
    ctx: await createProjectContext(root),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('UTF-16 LE/BE text and UTF-16 Flax logs decode without NUL characters', async () => {
  const f = await fixture();
  try {
    const message = 'Build FAILED: error CS1002';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(message, 'utf16le')]);
    const beBody = Buffer.from(message, 'utf16le');
    beBody.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    assert.equal(decodeText(le), message);
    assert.equal(decodeText(be), message);

    await fs.writeFile(path.join(f.ctx.logsDir, 'Editor.txt'), le);
    const output = resultText(await handleGetLatestLog(
      { lines: 10, all_logs: false },
      f.ctx
    ));
    assert.match(output, /error CS1002/);
    assert.doesNotMatch(output, /\0/);
  } finally {
    await f.cleanup();
  }
});

test('docs scope searches root README and nested project documentation', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'README.md'), 'root-doc-marker');
    await fs.writeFile(path.join(f.root, 'docs', 'guide.md'), 'nested-doc-marker');

    const rootResult = resultText(await handleSearchInFiles(
      { pattern: 'root-doc-marker', scope: 'docs', case_sensitive: false, max_results: 50 },
      f.ctx
    ));
    const nestedResult = resultText(await handleSearchInFiles(
      { pattern: 'nested-doc-marker', scope: 'docs', case_sensitive: false, max_results: 50 },
      f.ctx
    ));
    assert.match(rootResult, /README\.md/);
    assert.match(nestedResult, /docs[\\/]guide\.md/);
  } finally {
    await f.cleanup();
  }
});

test('scene actor listing terminates and labels cyclic parent references', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.ctx.contentDir, 'Cycle.scene'), JSON.stringify({
      ID: '11111111111111111111111111111111',
      Data: [
        { ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ParentID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', TypeName: 'FlaxEngine.EmptyActor', Name: 'A' },
        { ID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ParentID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', TypeName: 'FlaxEngine.EmptyActor', Name: 'B' },
      ],
    }));
    const output = resultText(await handleGetSceneActors(
      { scene: 'Cycle.scene', include_transforms: false },
      f.ctx
    ));
    assert.match(output, /cyclic parent reference/);
    assert.match(output, /A/);
    assert.match(output, /B/);
  } finally {
    await f.cleanup();
  }
});

test('binary Flax material header is classified and exposes its GUID', async () => {
  const f = await fixture();
  try {
    const guid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const typeName = Buffer.from('FlaxEngine.Material\0', 'utf16le');
    const asset = Buffer.alloc(0x2c + typeName.length);
    asset.write('CFWF', 0, 'ascii');
    guid.copy(asset, 0x1c);
    typeName.copy(asset, 0x2c);
    await fs.writeFile(path.join(f.ctx.contentDir, 'Test.flax'), asset);

    const output = resultText(await handleListAssets({ type: 'all' }, f.ctx));
    assert.match(output, /material\s+Test\.flax/);
    assert.match(output, /00112233445566778899aabbccddeeff/);
  } finally {
    await f.cleanup();
  }
});

test('asset validation excludes actor IDs used in scene-reference-shaped fields', async () => {
  const f = await fixture();
  try {
    const actorId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await fs.writeFile(path.join(f.ctx.contentDir, 'Actors.scene'), JSON.stringify({
      ID: '11111111111111111111111111111111',
      Data: [{ ID: actorId, TypeName: 'FlaxEngine.EmptyActor', SceneObject: actorId }],
    }));
    const output = resultText(await handleValidateProject({ checks: ['assets'] }, f.ctx));
    assert.equal(output, 'All checks passed. No issues found.');
  } finally {
    await f.cleanup();
  }
});

test('script class filtering can match class name when filename differs', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.ctx.sourceDir, 'Game', 'OddFilename.cs'), 'public class DesiredClass : Script {}');
    const output = resultText(await handleGetScriptClasses({ filter: 'desiredclass' }, f.ctx));
    assert.match(output, /DesiredClass/);
  } finally {
    await f.cleanup();
  }
});
