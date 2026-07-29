import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, type ProjectMeta } from '../projectContext.js';
import {
  BuildCookSchema,
  BuildOperationSchema,
  BuildValidateSchema,
  handleBuildCancel,
  handleBuildCook,
  handleBuildGetResult,
  handleBuildGetStatus,
  handleBuildListTargets,
  handleBuildValidate,
} from './buildLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const OPERATION_ID = 'a'.repeat(32);

interface Fixture { root: string; requests: string; responses: string; ctx: ProjectMeta; cleanup(): Promise<void>; }

async function fixture(bridgeVersion = 13): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-build-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([fs.mkdir(requests, { recursive: true }), fs.mkdir(responses, { recursive: true }), fs.mkdir(path.join(root, 'Builds'), { recursive: true })]);
  await Promise.all([
    fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' })),
    fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({ Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1 })),
    fs.writeFile(path.join(cache, 'token'), TOKEN),
  ]);
  return { root, requests, responses, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function respond(f: Fixture, body: Record<string, unknown>): Promise<{ body: Record<string, unknown>; params: Record<string, unknown> }> {
  const end = Date.now() + 1_000;
  let name: string | undefined;
  while (Date.now() <= end) {
    name = (await fs.readdir(f.requests)).find(value => value.endsWith('.json'));
    if (name) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!name) throw new Error('Timed out waiting for build bridge request.');
  const request = JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown>;
  const target = path.join(f.responses, `${request.id}.json`);
  await fs.writeFile(`${target}.tmp`, JSON.stringify({ id: request.id, token: TOKEN, timestamp: Date.now(), ...body }));
  await fs.rename(`${target}.tmp`, target);
  return { body: request, params: JSON.parse(String(request.paramsJson)) as Record<string, unknown> };
}

test('build schemas reject traversal, unknown target/configuration, unsafe defines, and unknown fields', () => {
  assert.equal(BuildValidateSchema.safeParse({ platform: 'windows64', output_path: 'Builds/../escape' }).success, false);
  assert.equal(BuildValidateSchema.safeParse({ platform: 'windows32', output_path: 'Builds/Win' }).success, false);
  assert.equal(BuildCookSchema.safeParse({ platform: 'windows64', output_path: 'Builds/Win', custom_defines: ['UNSAFE-DEFINE'] }).success, false);
  assert.equal(BuildCookSchema.safeParse({ platform: 'windows64', output_path: 'Builds/Win', unexpected: true }).success, false);
});

test('build target/preflight requests are strict PascalCase and disclose preflight limitation', async () => {
  const f = await fixture();
  try {
    const targets = handleBuildListTargets({}, f.ctx);
    const targetRequest = await respond(f, { ok: true, resultJson: JSON.stringify({ Entries: [{ Platform: 'windows64' }], Warnings: ['Toolchain preflight unavailable.'] }) });
    assert.equal(targetRequest.body.method, 'build.list_targets');
    assert.equal((await targets).isError, undefined);

    const validation = handleBuildValidate(BuildValidateSchema.parse({ platform: 'windows64', configuration: 'release', output_path: 'Builds/Release', custom_defines: ['CI'] }), f.ctx);
    const validationRequest = await respond(f, { ok: true, resultJson: JSON.stringify({ Valid: true, OutputEmpty: true, ToolchainPreflightSupported: false, Warnings: ['Preflight only.'] }) });
    assert.equal(validationRequest.body.method, 'build.validate');
    assert.deepEqual(validationRequest.params, { Platform: 'windows64', Configuration: 'release', OutputPath: 'Builds/Release', CustomDefines: ['CI'] });
    assert.equal((await validation).isError, undefined);
  } finally { await f.cleanup(); }
});

test('build cook/status/result/cancel use raw v13 operation handles and preserve truthful terminal gating', async () => {
  const f = await fixture();
  try {
    const cook = handleBuildCook(BuildCookSchema.parse({ platform: 'windows64', output_path: 'Builds/Win', operation_id: OPERATION_ID, dry_run: true }), f.ctx);
    const cookRequest = await respond(f, { ok: true, resultJson: JSON.stringify({ OperationId: OPERATION_ID, Kind: 'build_cook', Phase: 'dry_run', Progress: 1, CanCancel: false }) });
    assert.equal(cookRequest.body.method, 'build.cook');
    assert.deepEqual(cookRequest.params, { OperationId: OPERATION_ID, Platform: 'windows64', Configuration: 'development', OutputPath: 'Builds/Win', CustomDefines: [], DryRun: true });
    assert.equal((await cook).isError, undefined);

    const status = handleBuildGetStatus(BuildOperationSchema.parse({ operation_id: OPERATION_ID }), f.ctx);
    const statusRequest = await respond(f, { ok: true, resultJson: JSON.stringify({ OperationId: OPERATION_ID, Kind: 'build_cook', Phase: 'running', Progress: 0.5, CanCancel: true }) });
    assert.equal(statusRequest.body.method, 'build.status');
    assert.deepEqual(statusRequest.params, { OperationId: OPERATION_ID });
    assert.equal((await status).isError, undefined);

    const result = handleBuildGetResult(BuildOperationSchema.parse({ operation_id: OPERATION_ID }), f.ctx);
    const resultRequest = await respond(f, { ok: false, errorCode: 'BUILD_NOT_COMPLETE', error: 'Build still running.' });
    assert.equal(resultRequest.body.method, 'build.result');
    const resultResponse = await result;
    assert.equal(resultResponse.isError, true);
    assert.equal((resultResponse.structuredContent as any).error.code, 'BUILD_NOT_COMPLETE');

    const cancelled = handleBuildCancel(BuildOperationSchema.parse({ operation_id: OPERATION_ID }), f.ctx);
    const cancelRequest = await respond(f, { ok: true, resultJson: JSON.stringify({ OperationId: OPERATION_ID, Kind: 'build_cook', Phase: 'cancelling', CancelRequested: true }) });
    assert.equal(cancelRequest.body.method, 'build.cancel');
    assert.equal((await cancelled).isError, undefined);
  } finally { await f.cleanup(); }
});

test('build tools fail closed before an RPC when bridge is older than v13', async () => {
  const f = await fixture(12);
  try {
    const result = await handleBuildCook(BuildCookSchema.parse({ platform: 'windows64', output_path: 'Builds/Win' }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});
