import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test('bridge v34 import success assigns ResultAssetId from the registry under EngineAssetPath, then the header', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const start = between(source, 'private McpAssetOperation StartAssetImport(', 'private McpAssetOperation StartAssetReimport(');
  assert.match(start, /RefreshContentDatabaseFrom\(Path\.GetDirectoryName\(output\)\);/);
  assert.match(start, /ResolveImportedAssetId\(output\)/);
  assert.match(start, /operation\.ResultAssetId = resultId\.Value\.ToString\("N"\);/);
  assert.match(start, /FinishAssetImportOperation\(operation, "succeeded", null, null\);/);
  const resolve = between(source, 'private static Guid? ResolveImportedAssetId(', 'private static string OnDiskCaseFullPath(');
  // The only safe spelling: any other makes Flax rewrite the asset with a new ID.
  assert.match(resolve, /Content\.GetAssetInfo\(EngineAssetPath\(relative\), out info\)/);
  assert.doesNotMatch(resolve, /Content\.GetAssetInfo\((?!EngineAssetPath)/);
  // Fallback: header bytes 28..43 through the shared reader; null only when both fail.
  assert.match(resolve, /ReadPersistedMaterialInstanceId\(absolute\)/);
  assert.match(source, /Array\.Copy\(header, 28, idBytes, 0, 16\);/);
  assert.match(source, /status\.AssetImportResultIdSupported = true;/);
  // The operation DTO carries the ID and the replace marker through copies and persistence.
  assert.match(source, /public class McpAssetOperation \{[^}]*string ResultAssetId;[^}]*bool Replaced;/);
  assert.match(source, /ResultAssetId = value\.ResultAssetId, Renamed = value\.Renamed, Replaced = value\.Replaced/);
});

test('bridge v34 import operation records persist across a script reload and compare keys case-insensitively', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /_assetImportOperations = new Dictionary<string, McpAssetOperation>\(StringComparer\.OrdinalIgnoreCase\);/);
  assert.match(source, /_assetImportOperationFingerprints = new Dictionary<string, string>\(StringComparer\.OrdinalIgnoreCase\);/);
  assert.match(source, /_pendingReimportsByOutputPath = new Dictionary<string, string>\(StringComparer\.OrdinalIgnoreCase\);/);
  assert.match(source, /_assetImportSettingsResults = new Dictionary<string, McpAssetImportSettingsSetResult>\(StringComparer\.OrdinalIgnoreCase\);/);
  assert.match(source, /public class McpPersistedAssetOperation \{ public McpAssetOperation Operation; public string Fingerprint; \}/);
  // Written when the record is created, finished and completed by ImportFileEnd, and flushed on deinit.
  const begin = between(source, 'private McpAssetOperation BeginAssetImportOperation(', 'private void FinishAssetImportOperation(');
  assert.match(begin, /PersistAssetImportOperationLocked\(created\);/);
  const finish = between(source, 'private void FinishAssetImportOperation(', 'private static McpAssetOperation CopyAssetImportOperation(');
  assert.match(finish, /PersistAssetImportOperationLocked\(stored\);/);
  const fileEnd = between(source, 'private void OnAssetImportFileEnd(', 'private void SubscribeEvents(');
  assert.match(fileEnd, /PersistAssetImportOperationLocked\(operation\);/);
  assert.match(source, /PersistOperations\(\);\s+PersistAssetImportOperations\(\);/);
  // Restored from RestorePersistentState; an unfinished record becomes failed (Node only treats succeeded/failed/dry_run as terminal).
  assert.match(between(source, 'private void RestorePersistentState()', 'private McpOperation BeginOperationLocked('), /RestoreAssetImportOperations\(\);/);
  const restore = between(source, 'private void RestoreAssetImportOperations()', 'private static void EnsureAssetImportEditorReady()');
  assert.match(restore, /operation\.Phase = "failed";/);
  assert.match(restore, /_assetImportOperationFingerprints\[operation\.OperationId\] = saved\.Fingerprint;/);
  // Both sides of the reimport completion match are normalised with Path.GetFullPath.
  assert.match(source, /_pendingReimportsByOutputPath\[output\] = operation\.OperationId;/);
  assert.match(fileEnd, /output = Path\.GetFullPath\(Path\.IsPathRooted\(entry\.ResultUrl\)/);
  assert.match(between(source, 'private void QueueAssetReimport(', 'private static object BuildModelReimportSettings('), /var output = Path\.GetFullPath\(itemPath\);/);
});

test('bridge v34 collisionPolicy replace requires Confirm, the same asset type, and verifies ID and siblings', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const start = between(source, 'private McpAssetOperation StartAssetImport(', 'private McpAssetOperation StartAssetReimport(');
  // Confirm first (INVALID_REQUEST) unless previewing.
  assert.match(start, /"replace"[^\n]*&& !request\.DryRun && !request\.Confirm\)\s+throw new McpProtocolException\("INVALID_REQUEST"/);
  // Only an existing file is replaced; it must be a registered asset of the importer's output type.
  assert.match(start, /replaceTarget = RequireReplaceableAsset\(source, output, request\.ModelImportType\);/);
  const target = between(source, 'private static McpAssetRecord RequireReplaceableAsset(', 'private static HashSet<string> ListImportSiblingFiles(');
  assert.match(target, /BuildAssetRegistry\(\)/);
  assert.match(target, /target\.Info\.TypeName/);
  assert.match(target, /ExpectedImportOutputTypes\(sourcePath, modelImportType\)/);
  assert.match(target, /"VALIDATION_FAILED", "The existing asset type /);
  assert.match(target, /"FILE_EXISTS"/);
  // Import goes through the registered asset's engine-spelled path, exactly like Reimport.
  assert.match(start, /var importOutput = replaceTarget == null \? output : EngineAssetPath\(replaceTarget\.Path\);/);
  assert.match(start, /FEditor\.Import\(source, importOutput\)/);
  assert.match(start, /FEditor\.Import\(source, importOutput, options\)/);
  // Verified afterwards: no new "<Name> (N).flax" sibling, same asset ID (file header and registry).
  assert.match(start, /VerifyAssetReplace\(replaceTarget, replaceAbsolute, siblingsBefore\);/);
  assert.match(start, /operation\.Replaced = true;/);
  assert.match(start, /operation\.ResultAssetId = replaceTarget\.Id\.ToString\("N"\);/);
  const verify = between(source, 'private static void VerifyAssetReplace(', 'private McpAssetOperation StartAssetReimport(');
  assert.match(verify, /ListImportSiblingFiles\(absolute\)/);
  assert.match(verify, /"ASSET_OPERATION_FAILED", "Flax Editor wrote a new sibling asset/);
  assert.match(verify, /ReadPersistedMaterialInstanceId\(absolute\)/);
  assert.match(verify, /Content\.GetAssetInfo\(EngineAssetPath\(target\.Path\), out info\)/);
  assert.match(verify, /"ASSET_OPERATION_FAILED", "The asset ID changed during the replace/);
  assert.match(source, /status\.AssetImportReplaceSupported = true;/);
  // error/rename keep their behaviour; the resolver only learned the third policy.
  const output = between(source, 'private static string ResolveAssetImportOutput(', 'private static void EnsureAssetImportOutputParent(');
  assert.match(output, /"FILE_EXISTS", "An asset already exists at the requested destination\."/);
  assert.match(output, /var candidate = stem \+ "-" \+ i \+ extension;/);
});

test('bridge v34 directory ownership: standby when another live Editor owns Cache/MCP, owner-only cleanup', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /status\.BridgeOwnershipSupported = true;/);
  // Ownership is decided from bridge.json: foreign PID, alive, heartbeat younger than 30 s.
  const owner = between(source, 'private static bool TryGetLiveForeignOwner(', 'private static bool IsProcessAlive(');
  assert.match(owner, /ReadPersistent<McpBridgeInfo>\(BridgePath\)/);
  assert.match(owner, /info\.Pid == Environment\.ProcessId\) return false;/);
  assert.match(owner, /info\.Timestamp >= BridgeOwnerStaleMs\) return false;/);
  assert.match(source, /private const long BridgeOwnerStaleMs = 30000;/);
  assert.match(source, /private const long BridgeOwnerCheckMs = 2000;/);
  assert.match(between(source, 'private static bool IsProcessAlive(', 'private static bool BridgeFilesOwnedByThisEditor('), /OpenProcess\([\s\S]*?GetExitCodeProcess\([\s\S]*?== StillActive/);
  // Runtime marshalling is disabled in Flax game assemblies (live: MarshalDirectiveException): no SetLastError, bool or out parameters.
  assert.doesNotMatch(source, /DllImport\([^\r\n]*SetLastError/);
  assert.doesNotMatch(source, /extern bool |GetExitCodeProcess\(IntPtr process, out /);
  // Flax's script compile has no System.Diagnostics.Process reference (CS1069 found live): the bridge must not name that type.
  assert.doesNotMatch(source, /System\.Diagnostics\.Process|Process\.GetProcessById/);
  // Init: standby writes no token/heartbeat and restores nothing; the warning is logged once on entering standby.
  const init = between(source, 'public override void InitializeEditor()', 'public override void DeinitializeEditor()');
  assert.match(init, /if \(TryGetLiveForeignOwner\(out ownerPid\)\)\s+EnterStandby\(ownerPid\);\s+else\s+\{\s+ActivateBridge\(\);/);
  const activate = between(source, 'private void ActivateBridge()', 'private void EnterStandby(');
  assert.match(activate, /RestorePersistentState\(\);[\s\S]*?_token = CreateSessionToken\(\);[\s\S]*?SubscribeEvents\(\);[\s\S]*?WriteToken\(_token\);[\s\S]*?WriteHeartbeat\(\);/);
  const standby = between(source, 'private void EnterStandby(', 'private void DemoteToStandby(');
  assert.match(standby, /another Flax Editor \(pid " \+ ownerPid \+ "\) owns Cache\/MCP; this Editor's MCP bridge is on standby/);
  assert.doesNotMatch(standby, /WriteToken|WriteHeartbeat/);
  // The update loop: standby re-checks every 2 s and never reaches the request poll; the owner demotes itself if displaced.
  const update = between(source, 'private void OnUpdate()', 'private void TryPickUp(');
  assert.match(update, /if \(_bridgeStandby\)\s+\{\s+TickStandby\(now\);\s+return;\s+\}/);
  assert.ok(update.indexOf('TickStandby(now)') < update.indexOf('Directory.GetFiles(Requests'), 'standby must return before polling requests/');
  const tick = between(source, 'private void TickStandby(', 'private static bool TryGetLiveForeignOwner(');
  assert.match(tick, /BridgeOwnerCheckMs/);
  assert.match(tick, /BridgeOwnerMissingGraceMs/);
  assert.match(tick, /ActivateBridge\(\);/);
  assert.match(between(source, 'private void TickOwnerHeartbeat()', 'private void OnUpdate()'), /DemoteToStandby\(ownerPid\);/);
  // Deinit (script reload teardown included): shared files are removed only when bridge.json names this PID; a standby Editor persists nothing.
  const deinit = between(source, 'public override void DeinitializeEditor()', 'private void ActivateBridge()');
  assert.match(deinit, /if \(_bridgeActive\)/);
  assert.match(deinit, /if \(BridgeFilesOwnedByThisEditor\(\)\)\s+\{\s+TryDelete\(BridgePath\);\s+TryDelete\(TokenPath\);\s+\}/);
  assert.equal((source.match(/TryDelete\(TokenPath\)/g) ?? []).length, 1, 'the token is deleted only from the ownership-checked branch');
  assert.equal((source.match(/TryDelete\(BridgePath\)/g) ?? []).length, 1, 'bridge.json is deleted only from the ownership-checked branch');
  assert.match(between(source, 'private static bool BridgeFilesOwnedByThisEditor(', 'private void TickOwnerHeartbeat()'), /info\.Pid == Environment\.ProcessId/);
});
