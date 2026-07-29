import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

test('bridge v13 preserves revisioned edit leases without claiming atomic transactions', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*13/);
  assert.match(source, /BridgeVersion\s*=\s*13/);
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

test('bridge v10 exposes safe editor Content move, rename, and duplicate operations', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "asset\.move"/);
  assert.match(source, /case "asset\.rename"/);
  assert.match(source, /case "asset\.duplicate"/);
  assert.match(source, /AssetOrganizationSupported = true/);
  assert.match(source, /AssetOrganizationUndoSupported = false/);
  assert.match(source, /AssetOrganizationLeaseSupported = false/);
  assert.match(source, /ContentDatabase\.Move\(contentItem, output\)/);
  assert.match(source, /Content\.RenameAsset\(sourceAbsolutePath, output\)/);
  assert.match(source, /ContentDatabase\.Copy\(contentItem, output\)/);
  assert.match(source, /ASSET_REVISION_CONFLICT/);
  assert.match(source, /MaxAssetReferenceImpactEntries = 50/);
  assert.match(source, /ExpectedIndexRevision/);
  const organizationSource = source.slice(source.indexOf('private McpAssetOrganizeResult OrganizeAsset'), source.indexOf('// v9 imports use only direct public managed APIs'));
  assert.doesNotMatch(organizationSource, /File\.Move\(/);
  assert.doesNotMatch(organizationSource, /File\.Copy\(/);
});

test('bridge v13 quarantines guarded asset deletion without a filesystem or permanent-delete fallback', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "asset\.delete"/);
  assert.match(source, /AssetQuarantineDeleteSupported = true/);
  assert.match(source, /AssetPermanentDeleteSupported = false/);
  assert.match(source, /ConfirmReferenceCount/);
  assert.match(source, /RequireUnreferenced/);
  assert.match(source, /ASSET_REFERENCE_CONFLICT/);
  const deleteSource = source.slice(source.indexOf('private McpAssetOrganizeResult QuarantineDeleteAsset'), source.indexOf('// v9 imports use only direct public managed APIs'));
  assert.match(deleteSource, /ContentDatabase\.Move\(contentItem, output\)/);
  assert.doesNotMatch(deleteSource, /ContentDatabase\.Delete\(/);
  assert.doesNotMatch(deleteSource, /File\.Delete\(/);
  assert.doesNotMatch(deleteSource, /Directory\.Delete\(/);
});

test('bridge v12 exposes only the verified bounded prefab surface and leaves unsafe override mutations unsupported', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "prefab\.create_from_actor"/);
  assert.match(source, /case "prefab\.instantiate"/);
  assert.match(source, /case "prefab\.get_instances"/);
  assert.match(source, /PrefabManager\.CreatePrefab\(actor, output, request\.AutoLink\)/);
  assert.match(source, /PrefabManager\.SpawnPrefab\(prefab, parent, transform\)/);
  assert.match(source, /actor\.IsPrefabRoot && actor\.HasPrefabLink && actor\.PrefabID == prefabId/);
  assert.match(source, /MaxPrefabPageSize = 200/);
  assert.match(source, /MaxPrefabInstanceScan = 10000/);
  assert.match(source, /PrefabOverridesSupported = false/);
  assert.match(source, /PrefabApplyOverridesSupported = false/);
  assert.match(source, /PrefabRevertOverridesSupported = false/);
  assert.match(source, /PrefabBreakLinkSupported = false/);
  assert.match(source, /UNSUPPORTED_FLAX_VERSION/);
  assert.doesNotMatch(source, /PrefabManager\.ApplyAll\(/);
  assert.doesNotMatch(source, /\.BreakPrefabLink\(/);
});

test('bridge v13 exposes only bounded public GameCooker build/cook workflows', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "build\.list_targets"/);
  assert.match(source, /case "build\.validate"/);
  assert.match(source, /case "build\.cook"/);
  assert.match(source, /case "build\.status"/);
  assert.match(source, /case "build\.result"/);
  assert.match(source, /case "build\.cancel"/);
  assert.match(source, /GameCooker\.Build\(platform, configuration, output, BuildOptions\.None/);
  assert.match(source, /GameCooker\.Cancel\(false\)/);
  assert.match(source, /GameCooker\.Event \+= OnGameCookerEvent/);
  assert.match(source, /GameCooker\.Progress \+= OnGameCookerProgress/);
  assert.match(source, /BuildOutputScope = "project-relative-Builds-only"/);
  assert.match(source, /ToolchainPreflightSupported = false/);
  assert.match(source, /BUILD_NOT_COMPLETE/);
  assert.doesNotMatch(source, /Process\.Start\(/);
});
