import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

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
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /METHOD_NOT_ALLOWED", "Method '" \+ \(request == null \|\| request\.method == null/);
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
  assert.match(source, /FEditor\.Import\(source, output/);
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
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /Debug\.Log\("\[Flax MCP\] Bridge v29 listening/);
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
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
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
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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

test('bridge v25 opens canonical Content scenes through verified Level.LoadSceneAsync', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /Debug\.Log\("\[Flax MCP\] Bridge v29 listening/);
});

test('bridge v15 keeps domain mutations unsupported while exposing bounded public queries', async () => {
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
  assert.match(source, /UnsupportedDomainMutation\("navigation_build"/);
  assert.match(source, /UnsupportedDomainMutation\("lighting_bake"/);
  assert.match(source, /UnsupportedDomainMutation\("environment_probe_bake"/);
  assert.doesNotMatch(source, /Navigation\.BuildNavMesh\(/);
  assert.doesNotMatch(source, /Foliage\.AddInstance\(/);
});

test('bridge v26 gates play-mode input simulation to managed Flax APIs only', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /Debug\.Log\("\[Flax MCP\] Bridge v29 listening/);
  assert.doesNotMatch(source, /\[\s*DllImport/);
  assert.doesNotMatch(source, /user32\.dll/i);
  assert.doesNotMatch(source, /SendInput\s*\(/);
  assert.doesNotMatch(source, /Thread\.Sleep\s*\(/);
  assert.doesNotMatch(source, /Process\.Start\s*\(/);
});

test('bridge v27 reads one instantaneous engine performance snapshot without allocation storms', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  assert.match(source, /Debug\.Log\("\[Flax MCP\] Bridge v29 listening/);
  assert.doesNotMatch(source, /Thread\.Sleep\s*\(/);
});

test('bridge v29 keeps the v28 bounded script/component write surface', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MCP-BRIDGE-VERSION:\s*29/);
  assert.match(source, /BridgeVersion\s*=\s*29/);
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
  // The ONLY reflection-backed setter on game objects is the Editor
  // property-grid wrapper ScriptMemberInfo.SetValue; raw
  // PropertyInfo.SetValue is never used on game objects.
  assert.match(source, /ONLY reflection-backed setter/);
  assert.match(source, /new ScriptMemberInfo\(field\)/);
  assert.match(source, /\.SetValue\(script, value\)/);
  assert.match(source, /McpScriptFieldUndo/);
  assert.match(source, /FEditor\.Instance\.Undo\.AddAction\(action\)/);
  assert.match(source, /HasSet/);
  assert.match(source, /IsSupportedScriptFieldType/);
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
