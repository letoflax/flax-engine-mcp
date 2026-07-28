import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectMeta, createProjectContext } from '../projectContext.js';
import { handleGetCompilerErrors } from './intelligence.js';
import { handleGetLatestLog } from './logs.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
interface Fixture {
  root: string; ctx: ProjectMeta; requests: string; responses: string;
  cleanup(): Promise<void>;
}

async function fixture(live = true): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-legacy-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([
    fs.mkdir(path.join(root, 'Logs'), { recursive: true }),
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
    fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' })),
  ]);
  if (live) {
    await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
      Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 6, ProtocolVersion: 1,
    }));
    await fs.writeFile(path.join(cache, 'token'), TOKEN);
  }
  return { root, ctx: await createProjectContext(root), requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    const name = (await fs.readdir(f.requests)).find(item => item.endsWith('.json'));
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for legacy compatibility RPC request.');
}

async function reply(f: Fixture, request: { name: string; body: Record<string, unknown> }, result: unknown): Promise<void> {
  const response = { id: request.body.id, token: TOKEN, ok: true, resultJson: JSON.stringify(result), timestamp: Date.now() };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  assert.equal(block?.type, 'text');
  return block?.text ?? '';
}

test('get_compiler_errors delegates to code.diagnostics through a v6 heartbeat and preserves readable legacy output', async () => {
  const f = await fixture();
  try {
    const pending = handleGetCompilerErrors({ include_warnings: true }, f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'code.diagnostics');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { Severities: ['error', 'warning'], MaxResults: 200 });
    await reply(f, request, { Entries: [
      { Level: 'Error', Line: 12, Message: 'Expected ;' },
      { Level: 'Warning', Line: 18, Message: 'Unused field' },
    ] });
    const result = await pending;
    assert.match(text(result), /Log: live editor diagnostics/);
    assert.match(text(result), /## Errors \(1\)/);
    assert.match(text(result), /L12: Expected ;/);
    assert.match(text(result), /## Warnings \(1\)/);
    assert.equal((result.structuredContent as Record<string, any>).warnings[0], 'Deprecated legacy tool: delegated to live code diagnostics. Prefer code_get_diagnostics.');
  } finally { await f.cleanup(); }
});

test('get_latest_log delegates to live log.query through a v6 heartbeat and preserves tail-like output', async () => {
  const f = await fixture();
  try {
    const pending = handleGetLatestLog({ lines: 100, filter: 'ready', all_logs: false }, f.ctx);
    const request = await nextRequest(f);
    assert.equal(request.body.method, 'log.query');
    assert.deepEqual(JSON.parse(String(request.body.paramsJson)), { SinceSequence: 0, Limit: 100, Tail: true, Contains: 'ready' });
    await reply(f, request, { Entries: [
      { Level: 'Info', Message: 'Engine ready' },
      { Level: 'Warning', Message: 'Not shown' },
    ] });
    const result = await pending;
    assert.match(text(result), /Log: live editor session/);
    assert.match(text(result), /\[Info\] Engine ready/);
    assert.doesNotMatch(text(result), /Not shown/);
    assert.equal((result.structuredContent as Record<string, any>).warnings[0], 'Deprecated legacy tool: delegated to live editor logs. Prefer log_get_recent or log_search.');
  } finally { await f.cleanup(); }
});

test('legacy compiler and log handlers retain offline file fallbacks when no heartbeat exists', async () => {
  const f = await fixture(false);
  try {
    await fs.writeFile(path.join(f.root, 'Logs', 'Editor.txt'), 'warning CS0168: unused\nerror CS1002: expected ;\n');
    const compiler = await handleGetCompilerErrors({ include_warnings: true }, f.ctx);
    const log = await handleGetLatestLog({ lines: 10, all_logs: false }, f.ctx);
    assert.match(text(compiler), /Log: Editor\.txt/);
    assert.match(text(compiler), /error CS1002/);
    assert.match(text(log), /Log: Editor\.txt/);
    assert.equal((compiler.structuredContent as Record<string, any>).mode, 'offline');
    assert.equal((log.structuredContent as Record<string, any>).mode, 'offline');
  } finally { await f.cleanup(); }
});
