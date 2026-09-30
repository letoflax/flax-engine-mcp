import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROGRESS_MIN_INTERVAL_MS,
  PROGRESS_REPEAT_INTERVAL_MS,
  createProgressReporter,
  reportProgress,
  runWithProgress,
  type ProgressNotificationParams,
} from './progress.js';

/** Lets the reporter's deferred sink call run. */
const flush = () => new Promise(resolve => setImmediate(resolve));

test('progress reporter emits strictly increasing elapsed-time progress', async () => {
  const sent: ProgressNotificationParams[] = [];
  let clock = 1_000;
  const report = createProgressReporter('token-1', params => { sent.push(params); }, () => clock);
  report('Compiling scripts (compiling)', 120_000);
  clock += 700;
  report('Compiling scripts (compiling)', 120_000);
  clock += 700;
  report('Compiling scripts (reloading)', 120_000);
  await flush();
  assert.deepEqual(sent, [
    { progressToken: 'token-1', progress: 1, total: 120_000, message: 'Compiling scripts (compiling)' },
    { progressToken: 'token-1', progress: 700, total: 120_000, message: 'Compiling scripts (compiling)' },
    { progressToken: 'token-1', progress: 1_400, total: 120_000, message: 'Compiling scripts (reloading)' },
  ]);
});

test('progress reporter collapses repeats, rate-limits bursts, and drops an outrun total', async () => {
  const sent: ProgressNotificationParams[] = [];
  let clock = 0;
  const report = createProgressReporter(7, params => { sent.push(params); }, () => clock);
  report('Waiting for play state running', 1_000);
  clock += PROGRESS_REPEAT_INTERVAL_MS - 1;
  report('Waiting for play state running', 1_000); // same message inside the repeat interval
  clock += 2;
  report('Waiting for play state running', 1_000);
  clock += PROGRESS_MIN_INTERVAL_MS - 1;
  report('A different message', 1_000); // inside the hard floor
  clock += 2_000;
  report('Still waiting', 1_000); // the call has outrun its total
  await flush();
  assert.deepEqual(sent.map(item => item.message), ['Waiting for play state running', 'Waiting for play state running', 'Still waiting']);
  assert.ok(sent.every((item, index) => index === 0 || item.progress > sent[index - 1].progress));
  assert.equal(sent[0].total, 1_000);
  assert.equal('total' in sent[2], false);
});

test('reportProgress is scoped to the running tool call and never fails it', async () => {
  const sent: string[] = [];
  reportProgress('outside any tool call'); // no store: a no-op
  const failing = createProgressReporter('t', () => { throw new Error('client went away'); });
  await runWithProgress(failing, async () => { reportProgress('sink throws'); });
  const result = await runWithProgress(createProgressReporter('t', params => { sent.push(params.message ?? ''); }), async () => {
    reportProgress('inside');
    await new Promise(resolve => setTimeout(resolve, 5));
    return 'done';
  });
  assert.equal(await runWithProgress(undefined, async () => 'plain'), 'plain');
  await flush();
  assert.equal(result, 'done');
  assert.deepEqual(sent, ['inside']);
});

test('stdio sends notifications/progress while a bridge call is pending', async t => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  // The heartbeat names this test process, so the server sees a live editor.
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: 33, ProtocolVersion: 1 }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);

  const child = spawn(process.execPath, ['dist/index.js', '--project-path', root], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const messages: any[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (predicate: (message: any) => boolean, timeoutMs: number): Promise<any> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for an MCP message.');
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'progress-test', version: '1.0.0' } } });
  await waitFor(message => message.id === 1, 5_000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scene_list_loaded', arguments: {}, _meta: { progressToken: 'scenes-1' } } });

  // Hold the bridge response back long enough for the client to start reporting.
  let requestName: string | undefined;
  const requestDeadline = Date.now() + 5_000;
  while (!requestName && Date.now() < requestDeadline) {
    requestName = (await fs.readdir(requests)).find(name => name.endsWith('.json'));
    if (!requestName) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(requestName, 'the server never wrote a bridge request');
  const request = JSON.parse(await fs.readFile(path.join(requests, requestName), 'utf8')) as { id: string };
  const progress = await waitFor(message => message.method === 'notifications/progress', 5_000);
  assert.equal(progress.params.progressToken, 'scenes-1');
  assert.ok(progress.params.progress >= 1_000);
  assert.match(progress.params.message, /Waiting for Flax Editor \(scene\.list_loaded\)/);

  await fs.writeFile(path.join(responses, `${request.id}.json`), JSON.stringify({ id: request.id, token: TOKEN, ok: true, resultJson: '[]', timestamp: Date.now() }));
  const result = await waitFor(message => message.id === 2, 5_000);
  assert.equal(result.result.structuredContent.ok, true);
  assert.equal(result.result.structuredContent.mode, 'editor-connected');

  // Without a progress token the same slow path stays silent.
  const before = messages.filter(message => message.method === 'notifications/progress').length;
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project_info', arguments: {} } });
  await waitFor(message => message.id === 3, 5_000);
  assert.equal(messages.filter(message => message.method === 'notifications/progress').length, before);
});
