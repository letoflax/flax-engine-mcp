import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

test('bridge v7 contract exposes revisioned edit leases without claiming atomic transactions', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*7/);
  assert.match(source, /BridgeVersion\s*=\s*7/);
  assert.match(source, /ProtocolVersion\s*=\s*1/);
  assert.match(source, /TransactionsSupported\s*=\s*false/);
  assert.match(source, /EditLeaseSemantics\s*=\s*"visible-immediately-no-rollback"/);
  assert.match(source, /case "edit\.lease_begin"/);
  assert.match(source, /case "edit\.lease_get"/);
  assert.match(source, /case "edit\.lease_commit"/);
  assert.match(source, /case "edit\.lease_release"/);
  assert.doesNotMatch(source, /edit\.rollback_transaction/);
});

test('bridge v7 contains bounded revision, lease, and idempotency state guards', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /SCENE_REVISION_CONFLICT/);
  assert.match(source, /CurrentSceneRevision/);
  assert.match(source, /EDIT_LEASE_CONFLICT/);
  assert.match(source, /EDIT_LEASE_EXPIRED/);
  assert.match(source, /EDIT_LEASE_ACTIVE/);
  assert.match(source, /IdempotencyTtlMs\s*=\s*10 \* 60 \* 1000/);
  assert.match(source, /MaxIdempotencyEntries\s*=\s*512/);
  assert.match(source, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(source, /ExecuteIdempotent\("actor\.create"/);
  assert.match(source, /ExecuteIdempotent\("actor\.duplicate"/);
  assert.match(source, /ExecuteIdempotent\("script\.attach"/);
  assert.match(source, /errorDetails/);
});
