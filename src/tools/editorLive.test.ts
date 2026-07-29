import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  ActorCreateSchema,
  ActorGetSchema,
  ActorUpdateSchema,
  EditLeaseBeginSchema,
  EditLeaseGetSchema,
  handleActorCreate,
  handleActorGet,
  handleActorUpdate,
  handleEditLeaseBegin,
  handleEditLeaseGet,
} from './editorLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const ACTOR_ID = 'a'.repeat(32);

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup: () => Promise<void>;
}

async function fixture(bridgeVersion = 5): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-editor-live-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await Promise.all([
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid,
    Project: root,
    Timestamp: Date.now(),
    BridgeVersion: bridgeVersion,
    ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return {
    root,
    ctx: await createProjectContext(root),
    requests,
    responses,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function waitForRequest(directory: string): Promise<{ name: string; body: Record<string, unknown> }> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    const name = (await fs.readdir(directory)).find(item => item.endsWith('.json'));
    if (name) {
      return {
        name,
        body: JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as Record<string, unknown>,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for live-tool request.');
}

async function respond(
  fixtureValue: Fixture,
  response: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const request = await waitForRequest(fixtureValue.requests);
  const body = { token: TOKEN, ...response(request.body) };
  const target = path.join(fixtureValue.responses, request.name);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(body));
  await fs.rename(temporary, target);
  return request.body;
}

test('actor_create maps parameters to bridge DTO and preserves editor-connected structured mode', async () => {
  const f = await fixture();
  try {
    const pending = handleActorCreate(ActorCreateSchema.parse({
      name: 'Spawned',
      type_name: 'FlaxEngine.PointLight',
      parent_id: 'b'.repeat(32),
      active: false,
      position: { x: 1, y: 2, z: 3 },
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, Name: 'Spawned' }),
      timestamp: Date.now(),
    }));
    const result = await pending;
    assert.equal(request.method, 'actor.create');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      TypeName: 'FlaxEngine.PointLight',
      Name: 'Spawned',
      ParentId: 'b'.repeat(32),
      Active: false,
      Position: { X: 1, Y: 2, Z: 3 },
    });
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.mode, 'editor-connected');
    assert.equal(envelope.data.result.Id, ACTOR_ID);
    assert.deepEqual(envelope.changes, [{ kind: 'actor.created', name: 'Spawned' }]);
  } finally {
    await f.cleanup();
  }
});

test('actor_update rejects an empty update without writing an RPC request', async () => {
  const f = await fixture();
  try {
    const result = await handleActorUpdate(ActorUpdateSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'VALIDATION_FAILED');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('remote NOT_FOUND maps to the stable tool-domain NOT_FOUND error', async () => {
  const f = await fixture();
  try {
    const pending = handleActorGet(ActorGetSchema.parse({ actor_id: ACTOR_ID }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: false,
      errorCode: 'NOT_FOUND',
      error: 'Actor was not found.',
      resultJson: null,
      timestamp: Date.now(),
    }));
    const result = await pending;
    assert.equal(request.method, 'actor.get');
    assert.equal(result.isError, true);
    const error = (result.structuredContent as any).error;
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'Actor was not found.');
  } finally {
    await f.cleanup();
  }
});

test('actor_create dry-run validates creation and never sends the mutation method', async () => {
  const f = await fixture();
  try {
    const pending = handleActorCreate(ActorCreateSchema.parse({
      name: 'Preview',
      dry_run: true,
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: true,
      resultJson: JSON.stringify({ TypeName: 'FlaxEngine.EmptyActor', ParentId: null }),
      timestamp: Date.now(),
    }));
    const result = await pending;
    assert.equal(request.method, 'actor.validate_create');
    assert.equal(JSON.parse(String(request.paramsJson)).Name, 'Preview');
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.mode, 'editor-connected');
    assert.equal(envelope.data.dryRun, true);
    assert.equal(envelope.data.preview.Name, 'Preview');
    assert.deepEqual(envelope.changes, []);
  } finally {
    await f.cleanup();
  }
});

test('v7 live writes marshal revision, lease, and idempotency fields in PascalCase', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorCreate(ActorCreateSchema.parse({
      name: 'Idempotent',
      parent_id: 'b'.repeat(32),
      expected_scene_revision: 4,
      lease_id: 'c'.repeat(32),
      idempotency_key: 'create-idempotent-1',
    }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id,
      ok: true,
      resultJson: JSON.stringify({ Id: ACTOR_ID, ProjectRevision: 5, SceneRevision: 5 }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.create');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), {
      TypeName: 'FlaxEngine.EmptyActor', Name: 'Idempotent', ParentId: 'b'.repeat(32), Active: true,
      ExpectedSceneRevision: 4, LeaseId: 'c'.repeat(32), IdempotencyKey: 'create-idempotent-1',
    });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.SceneRevision, 5);
  } finally {
    await f.cleanup();
  }
});

test('revision-aware live writes fail closed on a pre-v7 bridge before creating a request', async () => {
  const f = await fixture(6);
  try {
    const result = await handleActorUpdate(ActorUpdateSchema.parse({
      actor_id: ACTOR_ID, name: 'Blocked', expected_scene_revision: 0,
    }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as any).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally {
    await f.cleanup();
  }
});

test('stale revision bridge errors preserve the current revision in a stable domain error', async () => {
  const f = await fixture(7);
  try {
    const pending = handleActorUpdate(ActorUpdateSchema.parse({ actor_id: ACTOR_ID, name: 'Stale', expected_scene_revision: 2 }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: false, errorCode: 'SCENE_REVISION_CONFLICT',
      error: 'ExpectedSceneRevision does not match the current bridge-known scene revision.',
      errorDetails: JSON.stringify({ SceneId: 'b'.repeat(32), ExpectedSceneRevision: 2, CurrentSceneRevision: 3, ProjectRevision: 8 }),
      resultJson: null, timestamp: Date.now(),
    }));
    assert.equal(request.method, 'actor.update');
    const result = await pending;
    const error = (result.structuredContent as any).error;
    assert.equal(error.code, 'SCENE_REVISION_CONFLICT');
    assert.equal(error.details.CurrentSceneRevision, 3);
    assert.equal(error.details.ProjectRevision, 8);
  } finally {
    await f.cleanup();
  }
});

test('v7 edit leases use explicit lease RPC methods and preserve lease semantics', async () => {
  const f = await fixture(7);
  try {
    const pending = handleEditLeaseBegin(EditLeaseBeginSchema.parse({ scene_id: 'b'.repeat(32), owner: 'fixture', ttl_ms: 10_000 }), f.ctx);
    const request = await respond(f, body => ({
      id: body.id, ok: true,
      resultJson: JSON.stringify({ LeaseId: 'c'.repeat(32), SceneId: 'b'.repeat(32), State: 'active', Semantics: 'visible-immediately-no-rollback' }),
      timestamp: Date.now(),
    }));
    assert.equal(request.method, 'edit.lease_begin');
    assert.deepEqual(JSON.parse(String(request.paramsJson)), { SceneId: 'b'.repeat(32), Owner: 'fixture', TtlMs: 10_000 });
    const envelope = (await pending).structuredContent as Record<string, any>;
    assert.equal(envelope.data.result.Semantics, 'visible-immediately-no-rollback');

    const getPending = handleEditLeaseGet(EditLeaseGetSchema.parse({ lease_id: 'c'.repeat(32) }), f.ctx);
    const getRequest = await respond(f, body => ({ id: body.id, ok: false, errorCode: 'NOT_FOUND', error: 'Edit lease was not found or has expired.', resultJson: null, timestamp: Date.now() }));
    assert.equal(getRequest.method, 'edit.lease_get');
    const getResult = await getPending;
    assert.equal((getResult.structuredContent as any).error.code, 'NOT_FOUND');
  } finally {
    await f.cleanup();
  }
});
