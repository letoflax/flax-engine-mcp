import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { handleGetAuditEntries } from '../audit.js';
import { ToolDomainError } from '../errors.js';
import { atomicWriteConfined, withTargetLock } from '../writeSafety.js';
import { ApplyScriptPatchSchema, handleApplyScriptPatch, handleWriteScript, WriteScriptSchema } from './scripts.js';

function text(result: Awaited<ReturnType<typeof handleWriteScript>>): string {
  const block = result.content[0];
  assert.ok(block && block.type === 'text');
  return block.text;
}

function errorCode(result: Awaited<ReturnType<typeof handleWriteScript>>): string | undefined {
  return (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
}

async function fixture(): Promise<{ root: string; ctx: ProjectMeta; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-write-'));
  await fs.mkdir(path.join(root, 'Source', 'Game'), { recursive: true });
  await fs.mkdir(path.join(root, 'Content'), { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  return { root, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('write_script rejects lexical traversal outside Source', async () => {
  const f = await fixture();
  try {
    const result = await handleWriteScript(WriteScriptSchema.parse({ name: '../escape.cs', content: 'class Escape {}' }), f.ctx);
    assert.equal(result.isError, true);
    await assert.rejects(fs.access(path.join(f.root, 'escape.cs')));
  } finally { await f.cleanup(); }
});

test('write_script rejects a junction or symlink that escapes the project', async t => {
  const f = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-outside-'));
  try {
    const link = path.join(f.ctx.sourceDir, 'Game', 'outside-link');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('Creating directory symlinks/junctions is not permitted on this host.');
      return;
    }
    const result = await handleWriteScript(WriteScriptSchema.parse({ name: 'Game/outside-link/Escape.cs', content: 'class Escape {}' }), f.ctx);
    assert.equal(result.isError, true);
    await assert.rejects(fs.access(path.join(outside, 'Escape.cs')));
  } finally {
    await f.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('dry runs validate and return hashes without creating a script', async () => {
  const f = await fixture();
  try {
    const result = await handleWriteScript(WriteScriptSchema.parse({ name: 'Preview.cs', content: 'class Preview {}', dry_run: true }), f.ctx);
    assert.equal(result.isError, undefined);
    assert.match(text(result), /Dry run:/);
    assert.match(text(result), /after_hash/);
    await assert.rejects(fs.access(path.join(f.ctx.sourceDir, 'Game', 'Preview.cs')));
  } finally { await f.cleanup(); }
});

test('oversized dry runs are rejected without creating a script', async () => {
  const f = await fixture();
  try {
    // Deliberately bypass Zod parsing to verify the handler retains its runtime
    // limit even for direct callers and dry-run requests.
    const result = await handleWriteScript({
      name: 'TooLarge.cs', content: 'x'.repeat(1024 * 1024 + 1), dry_run: true, overwrite: false,
    }, f.ctx);
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'CONTENT_TOO_LARGE');
    await assert.rejects(fs.access(path.join(f.ctx.sourceDir, 'Game', 'TooLarge.cs')));
  } finally { await f.cleanup(); }
});

test('stale expected hashes leave the existing script intact', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.ctx.sourceDir, 'Game', 'Player.cs');
    await fs.writeFile(file, 'class Player {}');
    const result = await handleWriteScript(WriteScriptSchema.parse({
      name: 'Player.cs', content: 'class Changed {}', overwrite: true, expected_hash: '0'.repeat(64),
    }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'class Player {}');
  } finally { await f.cleanup(); }
});

test('a failed multi-hunk patch does not partially modify a script', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.ctx.sourceDir, 'Game', 'Patch.cs');
    await fs.writeFile(file, 'one\ntwo\nthree\n');
    const patch = [
      '--- a/Patch.cs', '+++ b/Patch.cs', '@@ -1,1 +1,1 @@', '-one', '+ONE',
      '@@ -3,1 +3,1 @@', '-not-three', '+THREE', '',
    ].join('\n');
    const result = await handleApplyScriptPatch(ApplyScriptPatchSchema.parse({ name: 'Patch.cs', patch }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\nthree\n');
  } finally { await f.cleanup(); }
});

test('a valid unified diff is applied atomically', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.ctx.sourceDir, 'Game', 'Patch.cs');
    await fs.writeFile(file, 'one\ntwo\n');
    const patch = ['--- a/Patch.cs', '+++ b/Patch.cs', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO', ''].join('\n');
    const result = await handleApplyScriptPatch(ApplyScriptPatchSchema.parse({ name: 'Patch.cs', patch }), f.ctx);
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(file, 'utf8'), 'one\nTWO\n');
  } finally { await f.cleanup(); }
});

test('pre-replace rehash detects an external change and preserves it', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.ctx.sourceDir, 'Game', 'Race.cs');
    await fs.writeFile(file, 'original');
    await assert.rejects(
      atomicWriteConfined(file, 'agent-change', f.root, 'original', async () => {
        await fs.writeFile(file, 'external-change');
      }),
      (error: unknown) => error instanceof ToolDomainError && error.code === 'FILE_CHANGED',
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'external-change');
  } finally { await f.cleanup(); }
});

test('per-target lock rejects a concurrent MCP mutation', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.ctx.sourceDir, 'Game', 'Locked.cs');
    let release!: () => void;
    let acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const acquiredLock = new Promise<void>(resolve => { acquired = resolve; });
    const lock = withTargetLock(file, f.root, async () => { acquired(); await hold; });
    await acquiredLock;
    const result = await handleWriteScript(WriteScriptSchema.parse({ name: 'Locked.cs', content: 'class Locked {}' }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'FILE_CHANGED');
    release();
    await lock;
  } finally { await f.cleanup(); }
});

test('audit entries redact source and patch bodies', async () => {
  const f = await fixture();
  try {
    const secret = 'DO_NOT_LOG_SOURCE_BODY';
    const write = await handleWriteScript(WriteScriptSchema.parse({ name: 'Audit.cs', content: `class Audit { string x = "${secret}"; }` }), f.ctx);
    assert.equal(write.isError, undefined);
    const audit = await handleGetAuditEntries({ limit: 10 }, f.ctx);
    const output = text(audit);
    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /write_script/);
    assert.match(output, /redacted_fields/);
    const raw = await fs.readFile(path.join(f.root, '.flax-mcp', 'audit.jsonl'), 'utf8');
    assert.doesNotMatch(raw, new RegExp(secret));
  } finally { await f.cleanup(); }
});

test('an audit failure does not turn a committed script write into an error', async () => {
  const f = await fixture();
  try {
    // A file where the audit directory must be created makes appendFile fail,
    // while leaving Source writes available.
    await fs.writeFile(path.join(f.root, '.flax-mcp'), 'not a directory');
    const result = await handleWriteScript(WriteScriptSchema.parse({ name: 'AuditFailure.cs', content: 'class AuditFailure {}' }), f.ctx);
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.ctx.sourceDir, 'Game', 'AuditFailure.cs'), 'utf8'), 'class AuditFailure {}');
    const warnings = (result.structuredContent as { warnings?: string[] } | undefined)?.warnings ?? [];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /operation succeeded/i);
  } finally { await f.cleanup(); }
});
