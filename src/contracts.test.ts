import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createProjectContext } from './projectContext.js';
import { buildToolRegistry } from './tools/index.js';
import { dispatchToolCall } from './index.js';

const projectPath = await mkdtemp(path.join(os.tmpdir(), 'flax-mcp-contract-'));
after(async () => rm(projectPath, { recursive: true, force: true }));

await mkdir(path.join(projectPath, 'Content'), { recursive: true });
await mkdir(path.join(projectPath, 'Source', 'Game'), { recursive: true });
await mkdir(path.join(projectPath, 'Logs'), { recursive: true });
await writeFile(path.join(projectPath, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
await writeFile(path.join(projectPath, 'Content', 'Fixture.scene'), JSON.stringify({ ID: 'a'.repeat(32), Data: [] }));
await writeFile(path.join(projectPath, 'Source', 'Game', 'Fixture.cs'), 'public class Fixture { }');

const ctx = await createProjectContext(projectPath);
const tools = buildToolRegistry(ctx);

test('dispatch applies Zod defaults and returns a structured envelope', async () => {
  const result = await dispatchToolCall(tools, 'list_assets', undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Fixture\.scene/);
  const envelope = result.structuredContent as Record<string, any>;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.mode, 'offline');
  assert.match(envelope.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof envelope.timing.durationMs, 'number');
});

test('dispatch rejects unknown arguments with a stable domain error', async () => {
  const result = await dispatchToolCall(tools, 'list_assets', { type: 'all', unexpected: true }, ctx);
  const envelope = result.structuredContent as Record<string, any>;
  assert.equal(result.isError, true);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
  assert.equal(result.content[0]?.type === 'text' && result.content[0].text.startsWith('INVALID_ARGUMENT:'), true);
});

function startJsonRpcServer(): {
  child: ReturnType<typeof spawn>;
  request: (id: number, method: string, params: unknown) => Promise<any>;
  notify: (method: string, params: unknown) => void;
} {
  const child = spawn(process.execPath, ['dist/index.js', '--project-path', projectPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map<number, (message: any) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      const resolve = message.id === undefined ? undefined : pending.get(message.id);
      if (resolve) {
        pending.delete(message.id!);
        resolve(message);
      }
    }
  });
  return {
    child,
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

test('stdio advertises contracts and enforces them at the MCP boundary', async t => {
  const server = startJsonRpcServer();
  t.after(() => server.child.kill());

  const initialized = await server.request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1.0.0' },
  });
  assert.equal(initialized.result.serverInfo.name, 'flax-engine-mcp');
  server.notify('notifications/initialized', {});

  const listed = await server.request(2, 'tools/list', {});
  const assets = listed.result.tools.find((tool: { name: string }) => tool.name === 'list_assets');
  assert.equal(assets.inputSchema.additionalProperties, false);
  assert.ok(assets.outputSchema);
  assert.deepEqual(assets.outputSchema.properties.mode.enum, ['offline', 'editor-connected']);
  assert.equal(assets.annotations.readOnlyHint, true);

  const valid = await server.request(3, 'tools/call', { name: 'list_assets', arguments: {} });
  assert.match(valid.result.content[0].text, /Fixture\.scene/);
  assert.equal(valid.result.structuredContent.ok, true);

  const invalid = await server.request(4, 'tools/call', {
    name: 'list_assets',
    arguments: { type: 'all', unexpected: true },
  });
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.error.code, 'INVALID_ARGUMENT');
});
