import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

/**
 * The one place this suite pins the bridge version. A version bump edits this
 * constant only; the per-feature tests below assert their own feature and do
 * not repeat the version.
 */
const CURRENT_BRIDGE_VERSION = 34;

test('every place the bridge source states its version agrees with the current version', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const found = (pattern: RegExp) => [...source.matchAll(pattern)].map(match => Number(match[1]));
  // The header marker on the first line of the bridge source; it appears exactly once.
  assert.deepEqual(found(/MCP-BRIDGE-VERSION:\s*(\d+)/g), [CURRENT_BRIDGE_VERSION]);
  // The version constant and the two status DTOs the bridge reports it through.
  const declared = found(/\bint\s+BridgeVersion\s*=\s*(\d+)\s*;/g);
  assert.ok(declared.length >= 3, `expected the constant and both DTO defaults, found ${declared.length}`);
  assert.ok(declared.every(version => version === CURRENT_BRIDGE_VERSION), `BridgeVersion declarations: ${declared.join(', ')}`);
  // The startup log line.
  assert.deepEqual(found(/Debug\.Log\("\[Flax MCP\] Bridge v(\d+) listening/g), [CURRENT_BRIDGE_VERSION]);
});

test('bridge dispatch case labels equal KnownMethods and an unknown method fails with METHOD_NOT_FOUND', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const switchStart = source.indexOf('switch (request.method)');
  assert.notEqual(switchStart, -1, 'dispatch switch must exist');
  const defaultStart = source.indexOf('default:', switchStart);
  assert.notEqual(defaultStart, -1, 'dispatch switch must have a default case');
  const labels = [...source.slice(switchStart, defaultStart).matchAll(/^\s*case "([^"]+)":/gm)].map(match => match[1]);
  assert.equal(new Set(labels).size, labels.length, 'dispatch case labels must be unique');

  const arrayStart = source.indexOf('private static readonly string[] KnownMethods');
  assert.notEqual(arrayStart, -1, 'bridge must declare KnownMethods');
  const arrayBody = source.slice(source.indexOf('{', arrayStart), source.indexOf('};', arrayStart));
  const known = [...arrayBody.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(known).size, known.length, 'KnownMethods must not repeat a method');
  assert.deepEqual([...new Set(known)].sort(), [...new Set(labels)].sort());

  // The default case reports the method list and Status() publishes it.
  const defaultLine = source.slice(defaultStart, source.indexOf('\n', defaultStart));
  assert.match(defaultLine, /throw new McpProtocolException\("METHOD_NOT_FOUND"/);
  assert.match(defaultLine, /is not a bridge method\./);
  assert.match(defaultLine, /new \{ Method = .*Methods = KnownMethods \}/);
  assert.doesNotMatch(source, /"METHOD_NOT_ALLOWED"/);
  assert.match(source, /status\.Methods = KnownMethods;/);
  assert.match(source, /status\.MethodDiscoverySupported = true;/);
});

test('bridge v34 implements all six new methods and sets every v34 capability flag', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.doesNotMatch(source, /NotImplementedV34/);
  assert.doesNotMatch(source, /is declared in bridge v34 but not implemented yet/);
  const flags = ['MethodDiscoverySupported', 'AssetImportResultIdSupported', 'AssetImportReplaceSupported', 'BridgeOwnershipSupported', 'EditorReadinessSupported', 'EditorQuitSupported', 'EditorOptionsSupported', 'SceneReplaceSupported', 'SceneReloadSupported', 'NestedMemberPathSupported', 'ScriptAssetReferenceWriteSupported', 'GraphArchetypeListSupported', 'GraphEditSupported', 'AnimgraphTransitionSettingsSupported', 'GameplayGlobalsCreateSupported', 'MaterialFunctionGraphSupported'];
  for (const flag of flags) {
    assert.match(source, new RegExp(`public bool ${flag};`));
    assert.match(source, new RegExp(`^\\s+status\\.${flag} = true;`, 'm'));
  }
});

test('bridge v34 editor.quit defers RequestExit to the update loop, after the response is written', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "editor\.quit":.*OnMain\(\(\) => EditorQuit\(q\)/);
  // Engine.RequestExit is called exactly once, from the pending-quit tick that OnUpdate runs, never inside the request.
  assert.equal(source.match(/Engine\.RequestExit\(/g)?.length, 1);
  const tick = source.slice(source.indexOf('private void TickPendingQuit('), source.indexOf('private McpEditorOptions GetEditorOptions('));
  assert.match(tick, /Engine\.RequestExit\(\);/);
  assert.match(source, /private void OnUpdate\(\)[\s\S]*?TickPendingQuit\(now\);/);
  const request = source.slice(source.indexOf('private McpEditorQuitResult EditorQuit('), source.indexOf('private void TickPendingQuit('));
  assert.doesNotMatch(request, /RequestExit/);
  assert.match(request, /_pendingQuit = pending;/);
  // The exit waits for the response file (ProcessFile marks it), a later frame, async scene saves and the end of play mode.
  assert.match(source, /request\.method, "editor\.quit"[\s\S]{0,200}ResponseWritten = true/);
  assert.match(tick, /ResponseWritten/);
  assert.match(tick, /Engine\.FrameCount <= pending\.ArmedFrame/);
  assert.match(tick, /Level\.IsAnyActionPending/);
  assert.match(tick, /IsPlayModeRequested/);
  // Gates and unsaved detection use the Editor's own state.
  assert.match(request, /ScriptsBuilder\.IsCompiling[\s\S]*?"EDITOR_BUSY"/);
  assert.match(request, /ContentImporting\.IsImporting/);
  assert.match(request, /GameCooker\.IsRunning/);
  assert.match(request, /"INVALID_STATE", "Editor quit is refused: play mode active/);
  assert.match(request, /"DIRTY_SCENE"/);
  assert.match(request, /editor\.Scene\.SaveScenes\(\)/);
  assert.match(request, /RequestStopPlay\(\)/);
  assert.match(source, /AssetEditorWindow;?[\s\S]{0,40}\bwindow\.IsEdited|window != null && window\.IsEdited/);
  assert.match(source, /window\.Save\(\);/);
  // Exit never goes through the user-closing path that shows the save prompt.
  assert.doesNotMatch(source, /Windows\.MainWindow\.Close\(/);
});

test('bridge v34 editor.set_option writes through Options.Apply on a deep copy and refuses while the options window is open', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "editor\.get_options": result = OnMain\(GetEditorOptions/);
  assert.match(source, /case "editor\.set_option":.*OnMain\(\(\) => SetEditorOption\(q\)/);
  const body = source.slice(source.indexOf('private McpEditorSetOptionResult SetEditorOption('), source.indexOf('private McpPlayStatus PausePlay('));
  // Allow-list: exactly the two General options.
  assert.deepEqual([...new Set([...body.matchAll(/"(\w+)"/g)].map(match => match[1]).filter(name => /^[A-Z]/.test(name!) && !/^(INVALID_REQUEST|EDITOR_BUSY)$/.test(name!)))].sort(), ['AutoReloadScriptsOnMainWindowFocus', 'ForceScriptCompilationOnStartup']);
  assert.match(body, /DeepClone\(editor\.Options\.Options\)/);
  assert.match(body, /editor\.Options\.Apply\(copy\);/);
  assert.match(body, /Confirm/);
  assert.match(body, /if \(request\.DryRun\) return result;/);
  // Dry run returns before any write; the window gate and Apply come after Confirm.
  assert.ok(body.indexOf('request.DryRun') < body.indexOf('EditorOptionsWin'));
  assert.ok(body.indexOf('EditorOptionsWin') < body.indexOf('Options.Apply('));
  assert.match(body, /"EDITOR_BUSY", "The Editor Options window is open/);
  assert.match(body, /!optionsWindow\.IsHidden/);
  // Never reports a file path.
  assert.doesNotMatch(body, /EditorOptions\.json|OptionsFilePath|Path\.Combine/);
});

test('bridge v34 status assigns the readiness fields and never throws for them', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /FillEditorReadiness\(status\);/);
  const body = source.slice(source.indexOf('private static void FillEditorReadiness('), source.indexOf('private sealed class PendingQuit'));
  for (const assignment of [/status\.EditorState = .*StateMachine|status\.EditorState = state == null \? null : state\.GetType\(\)\.Name/, /status\.IsEditMode = /, /status\.IsCompiling = ScriptsBuilder\.IsCompiling/, /status\.ScriptsReady = ScriptsBuilder\.IsReady/, /status\.IsImporting = .*ContentImporting\.IsImporting/, /status\.LastCompileFailed = ScriptsBuilder\.LastCompilationFailed/, /status\.LoadedSceneCount = Level\.ScenesCount/]) {
    assert.match(body, assignment);
  }
  assert.ok((body.match(/catch/g) ?? []).length >= 3, 'every probe group is guarded');
  assert.match(source, /^\s+status\.EditorReadinessSupported = true;/m);
});

test('bridge v20 keeps read-only sub-context inspection with navigate-and-restore traversal', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /IncludeSubcontexts/);
  assert.match(source, /OpenContext\(new Span/);
  assert.match(source, /CloseContext\(\)/);
  assert.match(source, /GraphCurrentContextPath/);
  assert.match(source, /McpGraphContextDto/);
  assert.match(source, /OwnerNodeID/);
});

test('bridge v21 binds AnimationGraph BaseModel plus the v20 clip/value/move surface', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "graph\.set_model"/);
  assert.match(source, /McpGraphSetModelRequest/);
  assert.match(source, /SetGraphBaseModel/);
  assert.match(source, /SetBaseModel\(/);
  assert.match(source, /graph\.BaseModel/);
  assert.match(source, /case "graph\.set_node_values"/);
  assert.match(source, /case "graph\.move_node"/);
  assert.match(source, /case "animgraph\.set_state_clip"/);
  assert.match(source, /EditNodeValuesAction/);
  assert.match(source, /CreateConnection/);
  assert.match(source, /AnimGraphSamplerNode = 2/);
});

test('bridge v20 keeps the bounded P5ab removal pair without headless saves or hardcoded archetypes', async () => {
  const source = await readFile(bridgePath, 'utf8');
  // v34 note: this test only covers the removal pair. GraphAllowedArchetypes reads the AnimGraphSurface private lists by
  // reflection and keeps the ids (9,20), (9,34), (9,23) as a documented fallback only when those lists are missing.
  assert.match(source, /case "graph\.remove_node"/);
  assert.match(source, /case "graph\.disconnect"/);
  assert.match(source, /NodeFlags\.NoRemove/);
  assert.match(source, /BreakConnection/);
  assert.match(source, /McpGraphRemoveNodeRequest/);
  assert.match(source, /McpGraphDisconnectRequest/);
  assert.match(source, /withUndo/);
});

test('bridge refuses scene saves while scripts compile and keeps asset swaps inside undo', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /Scene saves are unavailable while game scripts are compiling or reloading/);
  assert.match(source, /ScriptsBuilder\.IsCompiling \|\| !ScriptsBuilder\.IsReady/);
  assert.match(source, /Post-save disk check/);
  assert.match(source, /SaveReport/);
  const recordIdx = source.indexOf('FEditor.Instance.Undo.RecordAction(actor, "Update actor"');
  const assignIdx = source.indexOf('ApplyActorComponentAssignments(actor, p);', recordIdx);
  const endIdx = source.indexOf('AdvanceSceneRevision(actor.Scene);', recordIdx);
  assert.ok(recordIdx >= 0 && assignIdx > recordIdx && endIdx > assignIdx, 'component assignments must run inside the undo action');
});

test('bridge v21 preserves revisioned edit leases without claiming atomic transactions', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /ProtocolVersion\s*=\s*1/);
  assert.match(source, /TransactionsSupported\s*=\s*false/);
  assert.match(source, /EditLeaseSemantics\s*=\s*"visible-immediately-no-rollback"/);
  assert.match(source, /case "edit\.lease_begin"/);
  assert.match(source, /case "edit\.lease_get"/);
  assert.match(source, /case "edit\.lease_commit"/);
  assert.match(source, /case "edit\.lease_release"/);
  assert.doesNotMatch(source, /edit\.rollback_transaction/);
  assert.match(source, /SkinnedModelPath/);
  assert.match(source, /LoadActorModelAsset/);
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
  assert.match(source, /METHOD_NOT_FOUND", "Method '" \+ \(request == null \|\| request\.method == null/);
});

test('bridge v9 exposes only verified, bounded public Content APIs for asset registry and graphs', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "asset\.search"/);
  assert.match(source, /case "asset\.get"/);
  assert.match(source, /case "asset\.dependencies"/);
  assert.match(source, /case "asset\.find_references"/);
  assert.match(source, /AssetRegistrySupported = true/);
  assert.match(source, /AssetReferenceGraphSupported = true/);
  assert.match(source, /AssetImportSettingsSupported = true/);
  assert.match(source, /case "asset\.import_start"/);
  assert.match(source, /case "asset\.reimport_start"/);
  assert.match(source, /AssetImportSupported = true/);
  assert.match(source, /FEditor\.Import\(source, importOutput/);
  assert.match(source, /ContentImporting\.Reimport\(item, BuildModelReimportSettings\(item/);
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
  assert.match(source, /AssetImportSettingsSupported = true/);
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
  assert.match(source, /Content\.RenameAsset\(EngineAssetPath\(source\.Path\), EngineAssetPathFromAbsolute\(output\)\)/); // v34 path-spelling trap
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

test('bridge v12 keeps the verified bounded prefab create/instantiate surface', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "prefab\.create_from_actor"/);
  assert.match(source, /case "prefab\.instantiate"/);
  assert.match(source, /case "prefab\.get_instances"/);
  assert.match(source, /PrefabManager\.CreatePrefab\(actor, output, request\.AutoLink\)/);
  assert.match(source, /PrefabManager\.SpawnPrefab\(prefab, parent, transform\)/);
  assert.match(source, /actor\.IsPrefabRoot && actor\.HasPrefabLink && actor\.PrefabID == prefabId/);
  assert.match(source, /MaxPrefabPageSize = 200/);
  assert.match(source, /MaxPrefabInstanceScan = 10000/);
});

test('bridge v30 exposes prefab override diff/revert/apply/break on verified public APIs only', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "prefab\.get_overrides"/);
  assert.match(source, /case "prefab\.revert_overrides"/);
  assert.match(source, /case "prefab\.apply_overrides"/);
  assert.match(source, /case "prefab\.break_link"/);
  assert.match(source, /PrefabOverridesSupported = true/);
  assert.match(source, /PrefabApplyOverridesSupported = true/);
  assert.match(source, /PrefabRevertOverridesSupported = true/);
  assert.match(source, /PrefabBreakLinkSupported = true/);
  assert.match(source, /PrefabManager\.ApplyAll\(actor\)/);
  assert.match(source, /GetDefaultInstance\(ref lookup\)/);
  assert.match(source, /GetNestedObject\(ref probe/);
  assert.match(source, /FlaxEditor\.Actions\.BreakPrefabLinkAction/);
  assert.match(source, /CreateBreakPrefabLinkAction/);
  assert.match(source, /Revert prefab overrides/);
  assert.match(source, /Synthesized bridge diff, not the engine prefab-diff window/);
  assert.match(source, /the asset save cannot be undone by edit_undo/);
  assert.match(source, /ExecuteIdempotent\("prefab\.revert_overrides"/);
  assert.match(source, /ExecuteIdempotent\("prefab\.apply_overrides"/);
  assert.match(source, /ExecuteIdempotent\("prefab\.break_link"/);
  assert.match(source, /ActorIds must contain between 1 and 32/);
  assert.match(source, /MaxPrefabDiffEntries = 200/);
  assert.match(source, /MaxPrefabDiffActors = 200/);
  assert.match(source, /All revert targets must belong to a single loaded scene/);
  assert.match(source, /Prefab revert requires confirm:true/);
  assert.match(source, /Prefab apply requires confirm:true/);
  assert.match(source, /Prefab break-link requires confirm:true/);
  assert.doesNotMatch(source, /UnsupportedPrefabOperation/);
  assert.doesNotMatch(source, /ApplySingle\s*\(/);
  assert.doesNotMatch(source, /GetPrefabObjectIds\s*\(/);
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

test('bridge v13 exposes only verified public material and animation reads and keeps animation writes unsupported', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "material\.get_parameters"/);
  assert.match(source, /case "material\.set_parameters"/);
  assert.match(source, /case "material\.create_instance"/);
  assert.match(source, /case "material\.assign_to_actor"/);
  assert.match(source, /case "animation\.list_clips"/);
  assert.match(source, /case "animation\.get_graph_parameters"/);
  assert.match(source, /case "animation\.set_graph_parameter"/);
  assert.match(source, /case "animation\.validate_bindings"/);
  assert.match(source, /MaterialParameterReadSupported = true/);
  assert.match(source, /MaterialParameterWriteSupported = true/);
  assert.match(source, /MaterialInstanceCreationSupported = true/);
  assert.match(source, /MaterialAssignmentSupported = true/);
  assert.match(source, /AnimationClipEnumerationSupported = true/);
  assert.match(source, /AnimationGraphParameterReadSupported = true/);
  assert.match(source, /AnimationGraphParameterWriteSupported = false/);
  assert.match(source, /material\.Parameters/);
  assert.match(source, /model\.Parameters/);
  assert.match(source, /animation\.Info/);
  assert.match(source, /UNSUPPORTED_FLAX_VERSION/);
  assert.doesNotMatch(source, /UnsupportedMaterialOperation/);
});

test('bridge v29 implements bounded material write, instance creation, and slot assignment', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /ExecuteIdempotent\("material\.set_parameters"/);
  assert.match(source, /ExecuteIdempotent\("material\.create_instance"/);
  assert.match(source, /ExecuteIdempotent\("material\.assign_to_actor"/);
  assert.match(source, /McpMaterialSetParametersRequest/);
  assert.match(source, /McpMaterialCreateInstanceRequest/);
  assert.match(source, /McpMaterialAssignRequest/);
  assert.match(source, /McpMaterialParametersUndo/);
  assert.match(source, /SetParameterValue\(defs\[applied\]\.Name, coerced\[applied\], true\)/);
  assert.match(source, /Content\.CreateVirtualAsset<MaterialInstance>\(\)/);
  assert.match(source, /instance\.BaseMaterial = baseMaterial/);
  assert.match(source, /instance\.Save\(absolute\)/);
  assert.match(source, /Content\.UnloadAsset\(material\)/);
  assert.match(source, /modelActor\.SetMaterial\(q\.Slot, newMaterial\)/);
  assert.match(source, /modelActor\.MaterialSlots\.Length/);
  assert.match(source, /as ModelInstanceActor/);
  assert.match(source, /RequireEditTime\("material\.set_parameters"\)/);
  assert.match(source, /RequireEditTime\("material\.create_instance"\)/);
  assert.match(source, /RequireEditTime\("material\.assign_to_actor"\)/);
  assert.match(source, /MaxMaterialParameters = 16/);
  assert.match(source, /Parameters must contain between 1 and/);
  assert.match(source, /Duplicate material parameter/);
  assert.match(source, /Material instances can only be created from a Flax Material/);
  assert.match(source, /A Content asset already exists at the requested destination/);
  assert.match(source, /Slot must be between 0 and 255/);
  assert.match(source, /is out of range;/);
  assert.match(source, /The scene was marked edited, not saved/);
  assert.match(source, /bridge-owned generic snapshot undo/);
  assert.match(source, /ReadPersistedMaterialInstanceId\(absolute\)/);
  assert.match(source, /does NOT preserve the virtual asset's in-memory ID/);
  assert.match(source, /the persisted ID is the durable reference/);
});

test('bridge v17 exposes the window-backed Visject graph surface with bounded AnimGraph topology macros', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "graph\.inspect"/);
  assert.match(source, /case "graph\.set_default_parameter"/);
  assert.match(source, /case "graph\.add_parameter"/);
  assert.match(source, /case "graph\.undo"/);
  assert.match(source, /case "animgraph\.add_state"/);
  assert.match(source, /case "animgraph\.add_transition"/);
  assert.match(source, /GraphInspectSupported = true/);
  assert.match(source, /GraphDefaultParameterWriteSupported = true/);
  assert.match(source, /GraphTopologyWriteSupported = true/);
  assert.match(source, /AnimgraphStateWriteSupported = true/);
  assert.match(source, /AnimgraphTransitionWriteSupported = true/);
  assert.match(source, /GraphUndoSupported = true/);
  assert.match(source, /AcquireGraphSurface/);
  assert.match(source, /NewParameterTypes/);
  assert.match(source, /AssetEditorWindow\.Save/);
  assert.match(source, /ExecuteIdempotent\("graph\.set_default_parameter"/);
  assert.match(source, /ExecuteIdempotent\("graph\.add_parameter"/);
  assert.match(source, /ExecuteIdempotent\("animgraph\.add_state"/);
  assert.match(source, /ExecuteIdempotent\("animgraph\.add_transition"/);
  assert.match(source, /AnimGraphStateMachineNode = 18/);
  assert.match(source, /AnimGraphStateNode = 20/);
  assert.match(source, /CanUseNodeType\(AnimGraphGroup/);
  assert.match(source, /IConnectionInstigator/);
  assert.doesNotMatch(source, /new VisjectSurface\(/);
  assert.doesNotMatch(source, /\.SaveSurface\(/);
});

test('bridge v22 captures game and editor viewports through verified Screenshot paths', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /EditorViewportCaptureSupported = true/);
  assert.match(source, /Viewport must be 'game' or 'editor'/);
  assert.match(source, /EditWin\.Viewport\.Task/);
  assert.match(source, /Screenshot\.Capture\(editorTask, path\)/);
  assert.match(source, /Screenshot\.Capture\(path\)/);
  assert.match(source, /Game viewport capture requires play mode/);
  assert.match(source, /Use viewport 'editor' to capture outside play mode/);
  assert.doesNotMatch(source, /Only the main game viewport is supported for capture/);
});

test('bridge v23 controls play time scale through verified Time.TimeScale', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /PlayTimeScaleSupported = true/);
  assert.match(source, /McpTimeScaleRequest/);
  assert.match(source, /case "play\.set_time_scale"/);
  assert.match(source, /SetPlayTimeScale/);
  assert.match(source, /Time\.TimeScale/);
  assert.match(source, /TimeScale must be between 0 and 10/);
  assert.match(source, /Editor must be in play mode to set time scale/);
});

test('bridge v24 reads and replaces editor selection through verified SceneEditing APIs', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /EditorSelectionSupported = true/);
  assert.match(source, /McpSelectionRequest/);
  assert.match(source, /McpSelectionEntry/);
  assert.match(source, /McpSelectionResult/);
  assert.match(source, /case "editor\.get_selection"/);
  assert.match(source, /case "editor\.set_selection"/);
  assert.match(source, /GetEditorSelection/);
  assert.match(source, /SetEditorSelection/);
  assert.match(source, /SceneEditing\.Selection/);
  assert.match(source, /GetActorNode\(actor\)/);
  assert.match(source, /editing\.Select\(nodes, false\)/);
  assert.match(source, /EditWin\.Viewport\.FocusSelection\(\)/);
  assert.match(source, /ActorIds must contain between 1 and 200 actor IDs/);
  assert.match(source, /Editor selection is unavailable in headless editor mode/);
});

test('bridge v25 opens canonical Content scenes through verified Level.LoadSceneAsync (v34: Replace/Reload through the scene state machine)', async () => {
  const source = await readFile(bridgePath, 'utf8');
  // The additive open and the not-loaded reload still use LoadSceneAsync; Replace and the
  // single-scene Reload go through ChangingScenesState.ChangeScenes (see bridgeV34SceneMemberContract.test.ts).
  assert.match(source, /editor\.StateMachine\.ChangingScenesState\.ChangeScenes\(/);
  assert.match(source, /SceneOpenSupported = true/);
  assert.match(source, /McpSceneOpen\b/);
  assert.match(source, /McpSceneOpenResult/);
  assert.match(source, /case "scene\.open"/);
  assert.match(source, /OpenScene\(JsonSerializer\.Deserialize<McpSceneOpen>/);
  assert.match(source, /Level\.LoadSceneAsync\(record\.Id\)/);
  assert.match(source, /FlaxEngine\.SceneAsset/);
  assert.match(source, /already_loaded/);
  assert.match(source, /Phase = "opening"/);
  assert.match(source, /DIRTY_SCENE/);
  assert.match(source, /DirtyLoadedSceneNames/);
  assert.match(source, /McpSceneOpenDirtyDetails/);
  assert.match(source, /McpSceneOpenTypeDetails/);
  assert.match(source, /ScriptsBuilder\.IsCompiling \|\| !ScriptsBuilder\.IsReady/);
  assert.match(source, /Scene open is unavailable while the editor is in play mode/);
});

test('bridge v31 keeps domain queries while backing navmesh/bake/probe/foliage writes with verified public APIs', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "physics\.raycast"/);
  assert.match(source, /case "physics\.find_overlaps"/);
  assert.match(source, /case "navigation\.query_path"/);
  assert.match(source, /case "lighting\.validate"/);
  assert.match(source, /case "terrain\.get_summary"/);
  assert.match(source, /case "foliage\.get_summary"/);
  assert.match(source, /Physics\.RayCast\(/);
  assert.match(source, /Physics\.OverlapSphere\(/);
  assert.match(source, /Navigation\.FindPath\(/);
  assert.match(source, /Navigation\.IsBuildingNavMesh/);
  assert.match(source, /Navigation\.BuildNavMesh\(/);
  assert.match(source, /AddInstance\(ref instance\)/);
  assert.match(source, /RemoveInstance\(index\)/);
  assert.match(source, /EditFoliageAction\(foliage\)/);
  assert.match(source, /BakeLightmapsOrCancel\(\);/);
  assert.match(source, /\.Bake\(timeoutSeconds\)/);
  assert.doesNotMatch(source, /UnsupportedDomainMutation\("navigation_build"/);
  assert.doesNotMatch(source, /UnsupportedDomainMutation\("lighting_bake"/);
  assert.doesNotMatch(source, /UnsupportedDomainMutation\("environment_probe_bake"/);
});

test('bridge v26 gates play-mode input simulation to managed Flax APIs only', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /InputSimulationSupported = true/);
  assert.match(source, /McpKeyPress/);
  assert.match(source, /McpMouseClick/);
  assert.match(source, /case "input\.key_press"/);
  assert.match(source, /case "input\.mouse_click"/);
  assert.match(source, /SimulateKeyPress\(JsonSerializer\.Deserialize<McpKeyPress>/);
  assert.match(source, /SimulateMouseClick\(JsonSerializer\.Deserialize<McpMouseClick>/);
  assert.match(source, /Editor must be running play \(not paused\) to simulate input/);
  assert.match(source, /Key must name a FlaxEngine\.KeyboardKeys member/);
  assert.match(source, /Button must be Left, Right, or Middle/);
  assert.match(source, /X and Y must be viewport-normalized coordinates in \[0,1\]/);
  assert.match(source, /HoldMs must be between 0 and 2000/);
  assert.match(source, /Capability = "input_key_press"/);
  assert.match(source, /Capability = "input_mouse_click"/);
  assert.match(source, /KeyboardKeys\.None/);
  assert.match(source, /KeyboardKeys\.MAX/);
  // The only native imports are the process-liveness calls of the v34 directory ownership check: three kernel32
  // calls on Windows (OpenProcess/GetExitCodeProcess/CloseHandle) and libc kill(pid, 0) on macOS
  // (System.Diagnostics.Process is not referenced by Flax's script build).
  assert.deepEqual(source.match(/\[\s*DllImport\("[^"]+"[^\]]*\]\s*private static extern \w+ \w+/g)?.map(entry => entry.replace(/\s+/g, ' ').replace(/^.*extern \w+ /, '')), ['OpenProcess', 'GetExitCodeProcess', 'CloseHandle', 'UnixKill']);
  assert.equal(source.match(/\[\s*DllImport\(/g)?.length, 4);
  assert.doesNotMatch(source, /DllImport\("(?!kernel32\.dll"|libc", EntryPoint = "kill")/);
  assert.match(source, /UnixKill\(pid, 0\)/);
  assert.doesNotMatch(source, /user32\.dll/i);
  assert.doesNotMatch(source, /SendInput\s*\(/);
  // Input simulation never sleeps: the only Thread.Sleep calls in the bridge
  // are the two v31 background poll cadences (asserted exactly in the v27
  // test), so scope this check to the input-simulation methods.
  const keyPress = source.slice(source.indexOf('private object SimulateKeyPress'), source.indexOf('private object SimulateMouseClick'));
  const mouseClick = source.slice(source.indexOf('private object SimulateMouseClick'), source.indexOf('private void PreparePlayStart'));
  assert.doesNotMatch(keyPress, /Thread\.Sleep\s*\(/);
  assert.doesNotMatch(mouseClick, /Thread\.Sleep\s*\(/);
  assert.doesNotMatch(source, /Process\.Start\s*\(/);
});

test('bridge v27 reads one instantaneous engine performance snapshot without allocation storms', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /PerfSnapshotSupported = true/);
  assert.match(source, /McpPerfSnapshot/);
  assert.match(source, /case "perf\.snapshot"/);
  assert.match(source, /OnMain\(PerfSnapshot, request\.deadlineUnixMs\)/);
  assert.match(source, /Engine\.FramesPerSecond/);
  assert.match(source, /Time\.UnscaledDeltaTime/);
  assert.match(source, /ProfilingTools\.Stats\.DrawStats/);
  assert.match(source, /main\.FPS > 0/);
  assert.match(source, /DrawStats\.DrawCalls > 0/);
  assert.match(source, /GC\.GetTotalMemory\(false\)/);
  assert.match(source, /Level\.GetActors\(typeof\(Actor\), false\)/);
  assert.match(source, /GPUDevice\.Instance/);
  assert.match(source, /device\.RendererType/);
  assert.match(source, /adapter\.Description/);
  assert.match(source, /FEditor\.Instance\.IsHeadlessMode/);
  // The only main-thread-external sleeps are the background poll cadences
  // (v34 navmesh 1 ms sampling after a 3 s spin, v31 probe 100 ms); PerfSnapshot itself never sleeps.
  assert.deepEqual(source.match(/Thread\.Sleep\s*\([^)]*\)/g) ?? [], ['Thread.Sleep(1)', 'Thread.Sleep(100)']);
});

test('bridge v29 keeps the v28 bounded script/component write surface', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /ScriptFieldWriteSupported = true/);
  assert.match(source, /ActorPropertyWriteSupported = true/);
  assert.match(source, /case "script\.instance_set_value"/);
  assert.match(source, /case "actor\.set_property"/);
  assert.match(source, /McpScriptFieldSet\b/);
  assert.match(source, /McpScriptFieldSetResult/);
  assert.match(source, /McpActorPropertySet\b/);
  assert.match(source, /McpActorPropertySetResult/);
  assert.match(source, /SetScriptField\(/);
  assert.match(source, /SetActorProperty\(/);
  assert.match(source, /RequireEditTime\(/);
  assert.match(source, /is an edit-time operation and is unavailable while the editor is in play mode/);
  assert.match(source, /is unavailable in headless editor mode/);
  // Bridge v34: script writes run the actor_set_property pipeline. The only
  // reflection-backed setter on game objects stays the Editor property-grid
  // wrapper ScriptMemberInfo.SetValue (never raw PropertyInfo.SetValue), the
  // value goes through CoerceMemberValue, and undo is one snapshot record on
  // the script instead of the old whitelist converter and McpScriptFieldUndo.
  const scriptWrite = source.slice(source.indexOf('private McpScriptFieldSetResult SetScriptField('), source.indexOf('private const string ActorPropertyAllowlist'));
  assert.match(scriptWrite, /PlanMemberWrite\(script, path, MemberTargetScript, true, nested/);
  assert.match(scriptWrite, /undo\.RecordBegin\(script, "Set script member"\)/);
  assert.match(scriptWrite, /finally \{ undo\.RecordEnd\(script\); \}/);
  assert.match(source, /Chain\.Slots\[last\]\.Info\.SetValue\(|chain\.Slots\[last\]\.Info\.SetValue\(/);
  assert.match(source, /HasSet/);
  assert.doesNotMatch(source, /McpScriptFieldUndo\b[^\n]*\{/);
  assert.doesNotMatch(source, /IsSupportedScriptFieldType\(/);
  assert.doesNotMatch(source, /ResolveScriptField\(/);
  assert.match(source, /Unknown actor property/);
  assert.match(source, /Light\.Color, Light\.Brightness, Camera\.FieldOfView, StaticModel\.Model, Script\.Enabled/);
  assert.match(source, /light\.Color = color/);
  assert.match(source, /light\.Brightness = brightness/);
  assert.match(source, /camera\.FieldOfView = fov/);
  assert.match(source, /staticModel\.Model = model/);
  assert.match(source, /WouldChange/);
  assert.match(source, /MarkSceneEdited/);
  assert.match(source, /ExecuteIdempotent\("script\.instance_set_value"/);
  assert.match(source, /ExecuteIdempotent\("actor\.set_property"/);
  assert.doesNotMatch(source, /PropertyInfo\.SetValue/);
  assert.doesNotMatch(source, /field\.SetValue\(/);
});

test('bridge v31 backs foliage/navmesh/bake/probe writes with verified public APIs and keeps terrain.paint an honest stub', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /NavigationBuildSupported = true/);
  assert.match(source, /LightingBakeSupported = true/);
  assert.match(source, /FoliageInstanceWriteSupported = true/);
  assert.match(source, /EnvironmentProbeBakeSupported = true/);
  assert.match(source, /TerrainPaintSupported = false/);
  assert.match(source, /case "terrain\.paint"/);
  assert.match(source, /case "foliage\.add_instances"/);
  assert.match(source, /case "foliage\.remove_instances"/);
  assert.match(source, /case "navigation\.build"/);
  assert.match(source, /case "lighting\.bake"/);
  assert.match(source, /case "environment_probe\.bake"/);
  assert.match(source, /McpFoliageAddRequest/);
  assert.match(source, /McpFoliageRemoveRequest/);
  assert.match(source, /McpNavigationBuildRequest/);
  assert.match(source, /McpLightingBakeRequest/);
  assert.match(source, /McpProbeBakeRequest/);
  assert.match(source, /RequireEditTime\("terrain\.paint"\)/);
  assert.match(source, /RequireEditTime\("foliage\.add_instances"\)/);
  assert.match(source, /RequireEditTime\("foliage\.remove_instances"\)/);
  assert.match(source, /RequireNotPlaying\("navigation\.build"\)/); // v34: headless allowed, play mode refused
  assert.match(source, /RequireEditTime\("lighting\.bake"\)/);
  assert.match(source, /RequireEditTime\("environment_probe\.bake"\)/);
  assert.match(source, /MaxFoliageBatch = 200/);
  assert.match(source, /Instances must contain between 1 and 200/);
  assert.match(source, /InstanceIndices must contain between 1 and 200/);
  assert.match(source, /new FlaxEditor\.Tools\.Foliage\.Undo\.EditFoliageAction\(foliage\)/);
  assert.match(source, /foliage\.RebuildClusters\(\);/);
  assert.match(source, /foliage\.UpdateCullDistance\(\);/);
  assert.match(source, /Array\.Reverse\(ordered\)/);
  assert.match(source, /Navigation\.BuildNavMesh\(bounds, sceneForCall, BuildDelayMs\)/);
  assert.match(source, /Navigation\.BuildNavMesh\(sceneForCall, BuildDelayMs\)/);
  assert.match(source, /Phase = completed \? "completed" : \(building \? "running" : "queued"\)/);
  assert.match(source, /no navmesh cancel API/);
  assert.match(source, /FEditor\.LightmapsBakeProgress \+= OnLightmapsBakeProgress;/);
  assert.match(source, /FEditor\.LightmapsBakeEnd \+= OnLightmapsBakeEnd;/);
  assert.match(source, /FEditor\.Instance\.BakeLightmapsOrCancel\(\);/);
  assert.match(source, /HasContentLoaded/);
  assert.match(source, /is not a FlaxEngine\.EnvironmentProbe or FlaxEngine\.SkyLight/);
  assert.match(source, /TerrainPaintBlocked/);
  assert.match(source, /terrain\.paint has no verified managed write path/);
  assert.match(source, /MarkEdited\(foliage\)/);
  assert.doesNotMatch(source, /new EditTerrain/);
  assert.doesNotMatch(source, /\.ModifyHeightMap\(/);
  assert.doesNotMatch(source, /\.ModifySplatMap\(/);
  assert.doesNotMatch(source, /\.ModifyHolesMask\(/);
  assert.doesNotMatch(source, /fixed\s*\(/);
  assert.doesNotMatch(source, /AllowUnsafeBlocks/);
});

test('bridge v32 exposes bounded texture/model/audio import-settings get/set on verified typed Options', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /AssetImportSettingsSupported = true/);
  assert.match(source, /case "asset\.get_import_settings"/);
  assert.match(source, /case "asset\.set_import_settings"/);
  assert.match(source, /ExecuteIdempotent\("asset\.set_import_settings"/);
  assert.match(source, /McpAssetImportSettingsGet/);
  assert.match(source, /McpAssetImportSettingsSet\b/);
  assert.match(source, /McpAssetImportSettingsSetResult/);
  assert.match(source, /McpAssetImportSettingsResult/);
  assert.match(source, /McpImportSettingsEntry/);
  assert.match(source, /GetAssetImportSettings\(JsonSerializer\.Deserialize<McpAssetImportSettingsGet>/);
  assert.match(source, /SetAssetImportSettings\(q\)/);
  assert.match(source, /ClassifyImportSettingsAsset/);
  assert.match(source, /TextureAssetItem/);
  assert.match(source, /SkinnedModeItem/);
  assert.match(source, /FlaxEngine\.AudioClip/);
  assert.match(source, /TryRestoreImportOptions\(ref/);
  assert.match(source, /TextureTool\.Options\.Default/);
  assert.match(source, /ModelTool\.Options\.Default/);
  assert.match(source, /AudioTool\.Options\.Default/);
  assert.match(source, /TextureImportSettings/);
  assert.match(source, /ModelImportSettings/);
  assert.match(source, /AudioImportSettings/);
  assert.match(source, /FEditor\.CanImport\(/);
  assert.match(source, /FEditor\.Instance\.ContentImporting\.Reimport\(item, settingsObject, true\)/);
  assert.match(source, /BeginAssetImportOperation\(request\.OperationId, "reimport"/);
  assert.match(source, /_pendingReimportsByOutputPath/);
  assert.match(source, /GetFullPath[(]itemPath[)]/);
  assert.match(source, /WouldChange/);
  assert.match(source, /Import settings are only supported for texture, model, and audio assets/);
  assert.match(source, /Unknown texture import setting/);
  assert.match(source, /Unknown model import setting/);
  assert.match(source, /Unknown audio import setting/);
  assert.match(source, /Format must be Raw or Vorbis/);
  assert.match(source, /BitDepth must be _8, _16, _24, or _32/);
  assert.match(source, /MaxSize must be between 1 and 16384/);
  assert.match(source, /SmoothingNormalsAngle must be between 0 and 175/);
  assert.match(source, /Quality must be between 0 and 1/);
  assert.match(source, /Settings must contain between 1 and 16 entries/);
  assert.match(source, /Asset import-settings changes require at least one configured import root/);
  assert.doesNotMatch(source, /AudioClipItem/);
});

test('bridge v33 reaches actor and control members only through the editor-visible selection', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /ActorPropertyReadSupported = true/);
  assert.match(source, /GenericActorPropertyWriteSupported = true/);
  assert.match(source, /UiControlWorkflowsSupported = true/);
  assert.match(source, /case "actor\.get_properties"/);
  assert.match(source, /case "ui\.create_control"/);
  assert.match(source, /case "ui\.get_control_properties"/);
  assert.match(source, /case "ui\.set_control_property"/);
  // The member selection is the property grid's own rule, not arbitrary reflection.
  assert.match(source, /GenericEditor\.GetItemsForType/);
  assert.match(source, /attribute is ShowInEditorAttribute/);
  assert.match(source, /attribute is HideInEditorAttribute/);
  assert.match(source, /attribute is ReadOnlyAttribute/);
  assert.match(source, /attribute is NoSerializeAttribute/);
  assert.match(source, /if \(hide && !layoutMember\) return;/);
  assert.match(source, /Actor base members \(name, active, transform, layer, tags\) are owned by actor_update/);
  assert.match(source, /Member is \[NoSerialize\]; an edit-time write would not persist/);
  assert.match(source, /Control hierarchy is owned by the UIControl actor/);
  // The only [HideInEditor] members reachable are the control layout members the
  // Editor's dedicated UIControl editor edits itself.
  assert.match(source, /UIControlControlEditor/);
  assert.match(source, /ControlLayoutMembers = \{ "AnchorPreset", "AnchorMin", "AnchorMax", "LocalX", "LocalY", "Width", "Height", "Offsets" \}/);
  assert.match(source, /var layout = target is FControl;/);
  // Numeric writes honor the [Limit]/[Range] bounds the property grid clamps to.
  assert.match(source, /attribute is LimitAttribute/);
  assert.match(source, /attribute is RangeAttribute/);
  assert.match(source, /RequireWithinEditorLimit\(slot, coerced\);/);
  assert.match(source, /the Editor limit for this member/);
  // Types resolve from the current scripting context only: a type from a game
  // assembly unloaded by an earlier script reload cannot be instantiated.
  assert.match(source, /FlaxEngine\.Utils\.GetAssemblies\(\)/);
  assert.doesNotMatch(source, /AppDomain\.CurrentDomain\.GetAssemblies\(\)/);
  // Writes go through the Editor wrapper inside a bridge undo action.
  assert.match(source, /class McpMemberUndo : IUndoAction/);
  assert.match(source, /member\.SetValue\(target, Unpack\(value\)\)/);
  assert.match(source, /FEditor\.Instance\.Undo\.AddAction\(action\)/);
  assert.match(source, /RequireEditTime\("actor\.set_property"\)/);
  assert.match(source, /RequireEditTime\("ui\.create_control"\)/);
  assert.match(source, /RequireEditTime\("ui\.set_control_property"\)/);
  assert.match(source, /ExecuteIdempotent\("ui\.create_control"/);
  assert.match(source, /ExecuteIdempotent\("ui\.set_control_property"/);
  // Dry-run previews bypass the idempotency cache.
  assert.match(source, /if \(q != null && q\.DryRun\) return SetActorProperty\(q\);/);
  // UI controls spawn the way the Editor scene tree does, and never from editor-only types.
  assert.match(source, /new UIControl \{ Control = control, Name = name, StaticFlags = parent\.StaticFlags \}/);
  assert.match(source, /FEditor\.Instance\.SceneEditing\.Spawn\(actor, parent, -1, false\)/);
  assert.match(source, /Editor-only controls \(FlaxEditor\.\*\) cannot be placed in a game scene/);
  assert.match(source, /typeof\(FRootControl\)\.IsAssignableFrom\(type\)/);
  assert.match(source, /Unknown actor property/);
  assert.doesNotMatch(source, /PropertyInfo\.SetValue/);
  assert.doesNotMatch(source, /FieldInfo\.SetValue/);
});

test('bridge v33 drives play mode through game scripts and keeps input injection an honest stub', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /RuntimeScriptDriveSupported = true/);
  assert.match(source, /case "runtime\.set_script_value"/);
  assert.match(source, /case "runtime\.invoke_script_method"/);
  assert.match(source, /RequirePlaySession\("runtime\.set_script_value"\)/);
  assert.match(source, /RequirePlaySession\("runtime\.invoke_script_method"\)/);
  assert.match(source, /requires play mode/);
  assert.match(source, /Engine-declared script members are not writable through this surface/);
  assert.match(source, /MaxRuntimeInvokeArgs = 4/);
  assert.match(source, /managed\.IsSpecialName/);
  assert.match(source, /candidate\.IsGeneric/);
  assert.match(source, /overload selection is not supported/);
  assert.match(source, /The game method threw; side effects before the exception may have been applied/);
  // The runtime paths never touch the editor undo stack or the scene edited flag.
  const runtime = source.slice(source.indexOf('private McpRuntimeScriptValueResult SetRuntimeScriptValue'), source.indexOf('private const int MaxInputMappings'));
  assert.ok(runtime.length > 0);
  assert.doesNotMatch(runtime, /Undo\.AddAction/);
  assert.doesNotMatch(runtime, /MarkEdited\(/);
  assert.doesNotMatch(runtime, /AdvanceSceneRevision/);
  // Flax 1.12 binds no managed input injection, so v26 stays a validated stub.
  assert.match(source, /Capability = "input_key_press"/);
  assert.match(source, /Capability = "input_mouse_click"/);
  assert.doesNotMatch(source, /GameRoot\.OnMouseDown/);
  assert.doesNotMatch(source, /GameRoot\.OnKeyDown/);
});

test('bridge v33 writes settings and creates content only through Editor APIs with explicit confirmation', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /SettingsWriteSupported = true/);
  assert.match(source, /SceneCreateSupported = true/);
  assert.match(source, /SceneCloseSupported = true/);
  assert.match(source, /ContentFolderCreateSupported = true/);
  assert.match(source, /AssetCreateSupported = true/);
  assert.match(source, /ParticleParameterWorkflowsSupported = true/);
  for (const method of ['settings.set_input_action', 'settings.set_input_axis', 'settings.remove_input_mapping', 'settings.set_layer_name', 'settings.add_tag', 'settings.set_first_scene', 'scene.create', 'scene.close', 'content.create_folder', 'asset.create', 'particle.get_parameters', 'particle.set_parameter']) {
    assert.ok(source.includes(`case "${method}"`), `missing dispatch for ${method}`);
  }
  assert.match(source, /FGameSettings\.Load<FInputSettings>\(\)/);
  assert.match(source, /FGameSettings\.Load<FLayersAndTagsSettings>\(\)/);
  assert.match(source, /FGameSettings\.Save\(settings\)/);
  assert.match(source, /FGameSettings\.Apply\(\);/);
  assert.match(source, /FEditor\.Instance\.Windows\.FindEditor\(item\)/);
  assert.match(source, /are open in an Editor window/);
  assert.match(source, /settings\.FirstScene = new SceneReference\(record\.Id\)/);
  assert.match(source, /Input settings writes require confirm:true alongside dryRun:false/);
  assert.match(source, /Layers and Tags writes require confirm:true alongside dryRun:false/);
  assert.match(source, /First scene writes require confirm:true alongside dryRun:false/);
  // DryRun defaults to true on every durable settings/creation request.
  assert.match(source, /class McpInputActionSet \{[^}]*public bool DryRun = true;/);
  assert.match(source, /class McpLayerNameSet \{[^}]*public bool DryRun = true;/);
  assert.match(source, /class McpSceneCreate \{[^}]*public bool DryRun = true;/);
  assert.match(source, /class McpAssetCreate \{[^}]*public bool DryRun = true;/);
  assert.match(source, /FEditor\.Instance\.Scene\.CreateSceneFile\(absolute\)/);
  assert.match(source, /editor\.StateMachine\.ChangingScenesState\.UnloadScene\(scene\)/);
  assert.match(source, /editor\.Scene\.ClearRefsToSceneObjects\(\)/);
  assert.match(source, /state\.CanChangeScene/);
  assert.match(source, /The scene has unsaved edits/);
  assert.match(source, /FEditor\.CreateAsset\(tag, absolute\)/);
  assert.match(source, /FEditor\.SaveJsonAsset\(absolute, instance\)/);
  assert.match(source, /typeof\(SpawnableJsonAssetProxy<>\)/);
  assert.match(source, /A file already exists at the requested destination/);
  assert.match(source, /destination parent resolves outside Content/);
  assert.match(source, /database\.RefreshFolder\(item, true\)/);
  assert.match(source, /effect\.SetParameterValue\(track, name, value\)/);
  assert.match(source, /RequireEditTime\("particle\.set_parameter"\)/);
  assert.match(source, /class McpLambdaUndo : IUndoAction/);
  // The binary header carries the durable ID before the registry lists the new asset.
  assert.match(source, /metadata\.Id = ReadPersistedMaterialInstanceId\(absolute\)\.ToString\("N"\)/);
  // A new file is looked up in the asset registry under the engine's own
  // path spelling (StringUtils.NormalizePath). An OS-spelled path misses the
  // registry key and makes the engine register the file a second time
  // ("Founded duplicated asset", live-observed after every binary asset.create).
  assert.match(source, /return StringUtils\.NormalizePath\(Path\.Combine\(Globals\.ProjectFolder, projectRelativePath\)\);/);
  assert.match(source, /Content\.GetAssetInfo\(EngineAssetPath\(normalized\), out clash\)/);
  assert.match(source, /Content\.GetAssetInfo\(EngineAssetPath\(normalized\), out info\)/);
  assert.doesNotMatch(source, /Content\.GetAssetInfo\((?:absolute|output), out/);
  // The modal "save before closing?" path is never taken (v34 scene.open Replace/Reload mention it in comments only).
  assert.doesNotMatch(source, /\.CheckSaveBeforeClose\(/);
  assert.doesNotMatch(source, /MessageBox\.Show/);
});

test('bridge v33 never lets an anonymous type reach FlaxEngine.Json as an empty object', async () => {
  const source = await readFile(bridgePath, 'utf8');
  // FlaxEngine.Json serializes an anonymous type as "{}". The v14 domain
  // queries returned anonymous types, so every one of them was empty in a
  // real Editor; their results are named field DTOs now.
  for (const dto of ['McpColliderValidationResult', 'McpLayerMatrixResult', 'McpRaycastResult', 'McpOverlapResult', 'McpNavigationStatusResult', 'McpNavigationAgentsResult', 'McpNavigationPathResult', 'McpLightingStatusResult', 'McpLightingValidateResult', 'McpTerrainSummaryResult', 'McpFoliageSummaryResult']) {
    assert.ok(source.includes(`public class ${dto} {`), `missing named DTO ${dto}`);
    assert.ok(source.includes(`return new ${dto} {`), `${dto} is not returned`);
  }
  assert.doesNotMatch(source, /return new \{ (Entries|Hit|Found|Layers|IsBuilding|Phase) =/);
  assert.doesNotMatch(source, /new List<object>\(\)/);
  // Error details and idempotency fingerprint inputs are still built from
  // anonymous types, so every serialization site projects them first.
  assert.match(source, /private static object PlainForJson\(object value, int depth\)/);
  assert.match(source, /JsonSerializer\.Serialize\(PlainForJson\(result\), true\)/);
  assert.match(source, /JsonSerializer\.Serialize\(PlainForJson\(details\), false\)/);
  assert.match(source, /JsonSerializer\.Serialize\(PlainForJson\(request\), false\)/);
  assert.match(source, /PlainForJson\(AssetImportFingerprintInput\(request\)\)/);
  assert.match(source, /PlainForJson\(AssetReimportFingerprintInput\(request\)\)/);
  assert.match(source, /PlainForJson\(AssetImportSettingsFingerprintInput\(request\)\)/);
  const serializations = source.match(/JsonSerializer\.Serialize\(([^;]*?), (?:true|false)\)/g) ?? [];
  const unprotected = serializations.filter(call => !call.includes('PlainForJson') && /\b(result|details|request)\b/.test(call) && !/McpBridgeInfo|response|value|before|after/.test(call));
  assert.deepEqual(unprotected, []);
});
