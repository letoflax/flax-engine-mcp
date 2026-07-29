import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createProjectContext } from './projectContext.js';
import { buildToolRegistry } from './tools/index.js';
import { dispatchToolCall } from './index.js';
import { SERVER_VERSION } from './version.js';
import { allowedToolNames, isToolAllowed, parsePermissionPolicy } from './permissions.js';

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

test('release registry has a unique, version-aligned 86-tool contract', async () => {
  const names = tools.map(tool => tool.name);
  const packageMetadata = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
  assert.equal(tools.length, 86);
  assert.equal(new Set(names).size, tools.length);
  assert.equal(SERVER_VERSION, '1.3.0');
  assert.equal(packageMetadata.version, SERVER_VERSION);
});

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

test('actor and script patch tools reject unknown fields before any editor RPC', async () => {
  const actor = await dispatchToolCall(tools, 'actor_update', {
    actor_id: 'a'.repeat(32), layer: 4, arbitrary_property: true,
  }, ctx);
  const script = await dispatchToolCall(tools, 'script_instance_update', {
    script_id: 'a'.repeat(32), enabled: true, properties: { Speed: 1 },
  }, ctx);
  assert.equal((actor.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT');
  assert.equal((script.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT');
});

test('permission policy parses profiles and repeated overrides', () => {
  assert.deepEqual(parsePermissionPolicy(['node', 'server', '--permission-profile', 'code-edit', '--allow-tool', 'actor_create', '--deny-tool', 'write_script', '--allow-tool', 'read_doc']), {
    profile: 'code-edit', allowTools: ['actor_create', 'read_doc'], denyTools: ['write_script'], emergencyReadOnly: false,
  });
  assert.throws(() => parsePermissionPolicy(['node', 'server', '--permission-profile', 'unsafe']), /Invalid --permission-profile/);
  assert.throws(() => parsePermissionPolicy(['node', 'server', '--allow-tool']), /requires a tool name/);
});

test('permission profiles cover the registry and fail closed by default', () => {
  const names = tools.map(tool => tool.name);
  assert.equal(allowedToolNames(names, { profile: 'full', allowTools: [], denyTools: [], emergencyReadOnly: false }).length, 86);
  assert.equal(isToolAllowed('read_script', { profile: 'read-only', allowTools: [], denyTools: [], emergencyReadOnly: false }), true);
  assert.equal(isToolAllowed('write_script', { profile: 'read-only', allowTools: [], denyTools: [], emergencyReadOnly: false }), false);
  assert.equal(isToolAllowed('code_compile', { profile: 'code-edit', allowTools: [], denyTools: [], emergencyReadOnly: false }), true);
  assert.equal(isToolAllowed('actor_update', { profile: 'code-edit', allowTools: [], denyTools: [], emergencyReadOnly: false }), false);
  assert.equal(isToolAllowed('play_start_game', { profile: 'scene-edit', allowTools: [], denyTools: [], emergencyReadOnly: false }), true);
  assert.equal(isToolAllowed('reimport_asset', { profile: 'scene-edit', allowTools: [], denyTools: [], emergencyReadOnly: false }), false);
  assert.equal(isToolAllowed('future_mutation', { profile: 'full', allowTools: ['future_mutation'], denyTools: [], emergencyReadOnly: false }), false);
});

test('permission deny takes precedence and emergency mode blocks mutation and runtime', async () => {
  const policy = { profile: 'full' as const, allowTools: ['write_script'], denyTools: ['write_script'], emergencyReadOnly: false };
  assert.equal(isToolAllowed('write_script', policy), false);
  const emergency = { profile: 'full' as const, allowTools: ['play_start_game'], denyTools: [], emergencyReadOnly: true };
  assert.equal(isToolAllowed('read_script', emergency), true);
  assert.equal(isToolAllowed('write_script', emergency), false);
  assert.equal(isToolAllowed('play_start_game', emergency), false);
  const calls: string[] = [];
  const guarded = [{ ...tools.find(tool => tool.name === 'list_assets')!, handler: async () => { calls.push('called'); throw new Error('should not run'); } }];
  const guardedCtx = { ...ctx, permissionPolicy: { profile: 'read-only' as const, allowTools: [], denyTools: ['list_assets'], emergencyReadOnly: false } };
  const result = await dispatchToolCall(guarded, 'list_assets', {}, guardedCtx);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as Record<string, any>).error.code, 'PERMISSION_DENIED');
  assert.deepEqual(calls, []);
});

function startJsonRpcServer(extraArgs: string[] = []): {
  child: ReturnType<typeof spawn>;
  request: (id: number, method: string, params: unknown) => Promise<any>;
  notify: (method: string, params: unknown) => void;
  notifications: any[];
} {
  const child = spawn(process.execPath, ['dist/index.js', '--project-path', projectPath, ...extraArgs], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map<number, (message: any) => void>();
  const notifications: any[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id === undefined) { notifications.push(message); continue; }
      const resolve = pending.get(message.id);
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
    notifications,
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
  assert.equal(initialized.result.capabilities.resources.subscribe, true);
  assert.equal(initialized.result.capabilities.resources.listChanged, true);
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

  const resources = await server.request(5, 'resources/list', {});
  assert.ok(resources.result.resources.some((resource: { uri: string }) => resource.uri === 'flax://project/info'));
  const project = await server.request(6, 'resources/read', { uri: 'flax://project/info' });
  assert.equal(project.result.contents[0].mimeType, 'application/json');
  const templates = await server.request(7, 'resources/templates/list', {});
  assert.deepEqual(templates.result.resourceTemplates, []); // fixture has no live bridge capability
});

test('stdio resource subscriptions collect debounced updates and honour unsubscribe', async t => {
  const server = startJsonRpcServer();
  t.after(() => server.child.kill());
  await server.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: { resources: { subscribe: true } }, clientInfo: { name: 'resource-test', version: '1.0.0' } });
  server.notify('notifications/initialized', {});
  await server.request(2, 'resources/subscribe', { uri: 'flax://editor/status' });
  await server.request(3, 'resources/subscribe', { uri: 'flax://editor/status' });
  const write = await server.request(4, 'tools/call', { name: 'write_script', arguments: { name: 'ResourceSubscription.cs', content: 'public class ResourceSubscription {}' } });
  assert.equal(write.result.isError, undefined);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(server.notifications.filter(item => item.method === 'notifications/resources/updated' && item.params.uri === 'flax://editor/status').length, 1);
  await server.request(5, 'resources/unsubscribe', { uri: 'flax://editor/status' });
  await server.request(6, 'tools/call', { name: 'write_script', arguments: { name: 'SecondResourceSubscription.cs', content: 'public class SecondResourceSubscription {}' } });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(server.notifications.filter(item => item.method === 'notifications/resources/updated' && item.params.uri === 'flax://editor/status').length, 1);
});

test('stdio advertises pure MCP prompts with strict prompt argument handling', async t => {
  const server = startJsonRpcServer();
  t.after(() => server.child.kill());
  const before = await readFile(path.join(projectPath, 'Source', 'Game', 'Fixture.cs'), 'utf8');
  const initialized = await server.request(1, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prompt-contract-test', version: '1.0.0' },
  });
  assert.deepEqual(initialized.result.capabilities.prompts, {});
  server.notify('notifications/initialized', {});

  const listed = await server.request(2, 'prompts/list', {});
  assert.deepEqual(listed.result.prompts.map((prompt: { name: string }) => prompt.name), [
    'create_gameplay_feature', 'fix_compile_errors', 'create_scene_from_description', 'debug_runtime_exception', 'prepare_release_build',
  ]);
  const debug = listed.result.prompts.find((prompt: { name: string }) => prompt.name === 'debug_runtime_exception');
  assert.deepEqual(debug.arguments.map((argument: { name: string; required: boolean }) => [argument.name, argument.required]), [
    ['symptom', true], ['run_seconds', false], ['apply_fix', false],
  ]);

  const prompt = await server.request(3, 'prompts/get', {
    name: 'debug_runtime_exception', arguments: { symptom: 'null reference', run_seconds: '5', apply_fix: 'false' },
  });
  assert.equal(prompt.result.messages[0].role, 'user');
  assert.match(prompt.result.messages[0].content.text, /resources\/list/);
  const rejected = await server.request(4, 'prompts/get', {
    name: 'debug_runtime_exception', arguments: { symptom: 'null reference', run_seconds: 'five' },
  });
  assert.equal(rejected.error.code, -32602);
  assert.match(rejected.error.message, /base-10 integer/);
  assert.equal(await readFile(path.join(projectPath, 'Source', 'Game', 'Fixture.cs'), 'utf8'), before);
});

test('tools/list and capabilities reflect the active permission policy', async t => {
  const server = startJsonRpcServer(['--permission-profile', 'read-only', '--allow-tool', 'code_compile', '--deny-tool', 'list_assets']);
  t.after(() => server.child.kill());
  await server.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'permission-test', version: '1.0.0' } });
  server.notify('notifications/initialized', {});
  const listed = await server.request(2, 'tools/list', {});
  const names = listed.result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(names.includes('read_script'), true);
  assert.equal(names.includes('code_compile'), true);
  assert.equal(names.includes('list_assets'), false);
  assert.equal(names.includes('write_script'), false);
  const capabilities = await server.request(3, 'tools/call', { name: 'get_server_capabilities', arguments: {} });
  assert.equal(capabilities.result.structuredContent.data.permissions.profile, 'read-only');
  assert.equal(capabilities.result.structuredContent.data.permissions.availableTools.includes('code_compile'), true);
  assert.equal(capabilities.result.structuredContent.data.permissions.availableTools.includes('list_assets'), false);
});

test('emergency read-only is reflected in discovery and cannot be overridden', async t => {
  const server = startJsonRpcServer(['--permission-profile', 'full', '--allow-tool', 'write_script', '--emergency-read-only']);
  t.after(() => server.child.kill());
  await server.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'emergency-test', version: '1.0.0' } });
  server.notify('notifications/initialized', {});
  const listed = await server.request(2, 'tools/list', {});
  const names = listed.result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(names.includes('read_script'), true);
  assert.equal(names.includes('write_script'), false);
  assert.equal(names.includes('play_start_game'), false);
  const capabilities = await server.request(3, 'tools/call', { name: 'get_server_capabilities', arguments: {} });
  assert.equal(capabilities.result.structuredContent.data.permissions.emergencyReadOnly, true);
  assert.equal(capabilities.result.structuredContent.data.permissions.availableTools.includes('write_script'), false);
});
