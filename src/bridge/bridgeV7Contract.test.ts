import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

test('bridge v11 contract preserves revisioned edit leases without claiming atomic transactions', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*11/);
  assert.match(source, /BridgeVersion\s*=\s*11/);
  assert.match(source, /ProtocolVersion\s*=\s*1/);
  assert.match(source, /TransactionsSupported\s*=\s*false/);
  assert.match(source, /EditLeaseSemantics\s*=\s*"visible-immediately-no-rollback"/);
  assert.match(source, /case "edit\.lease_begin"/);
  assert.match(source, /case "edit\.lease_get"/);
  assert.match(source, /case "edit\.lease_commit"/);
  assert.match(source, /case "edit\.lease_release"/);
  assert.doesNotMatch(source, /edit\.rollback_transaction/);
});

test('bridge v9 contains bounded revision, lease, and idempotency state guards', async () => {
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

test('bridge v9 keeps actor/script editing allowlisted, validated before undo, and bounded', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /McpVector3 LocalPosition/);
  assert.match(source, /int\? Layer/);
  assert.match(source, /string\[\] Tags; public bool TagsTruncated/);
  assert.match(source, /MaxActorTags\s*=\s*64/);
  assert.match(source, /TypeName; public string ParentId; public bool\? Active/);
  assert.match(source, /ValidateActorUpdate\(p\);/);
  assert.match(source, /World-space and local-space transform patches cannot be combined/);
  assert.match(source, /Layer must be between 0 and 31/);
  assert.ok(source.indexOf('ValidateActorUpdate(p);') < source.indexOf('FEditor.Instance.Undo.RecordAction(actor, "Update actor"'));
  assert.match(source, /if \(p\.LocalPosition != null\) actor\.LocalPosition/);
  assert.match(source, /if \(p\.Layer\.HasValue\) actor\.Layer/);
  assert.match(source, /if \(p == null \|\| !p\.Enabled\.HasValue\) throw new McpProtocolException\("INVALID_REQUEST"/);
  assert.match(source, /McpScriptEnabledUndo/);
  assert.doesNotMatch(source, /PropertyInfo\.SetValue/);
});

test('bridge v9 exposes only verified, bounded public Content APIs for asset registry and graphs', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "asset\.search"/);
  assert.match(source, /case "asset\.get"/);
  assert.match(source, /case "asset\.dependencies"/);
  assert.match(source, /case "asset\.find_references"/);
  assert.match(source, /AssetRegistrySupported = true/);
  assert.match(source, /AssetReferenceGraphSupported = true/);
  assert.match(source, /AssetImportSettingsSupported = false/);
  assert.match(source, /case "asset\.import_start"/);
  assert.match(source, /case "asset\.reimport_start"/);
  assert.match(source, /AssetImportSupported = true/);
  assert.match(source, /FEditor\.Import\(source, output\)/);
  assert.match(source, /ContentImporting\.Reimport\(item, null, true\)/);
  assert.match(source, /ImportFileEnd \+= OnAssetImportFileEnd/);
  assert.doesNotMatch(source, /Process\.Start\(/);
  assert.match(source, /Content\.GetAllAssets\(\)/);
  assert.match(source, /Content\.GetAssetInfo\(id, out info\)/);
  assert.match(source, /Content\.Load\(record\.Id, AssetLoadTimeoutMs\)/);
  assert.match(source, /asset\.GetReferences\(\)/);
  assert.match(source, /MaxAssetPageSize = 200/);
  assert.match(source, /MaxAssetGraphDepth = 16/);
  assert.match(source, /CURSOR_INVALID/);
  assert.match(source, /ASSET_NOT_FOUND/);
  assert.match(source, /AssetImportSettingsSupported = false/);
});
