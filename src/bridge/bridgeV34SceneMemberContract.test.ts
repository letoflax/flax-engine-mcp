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

test('bridge v34 scene.open Replace goes through ChangingScenesState.ChangeScenes and never discards silently', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const open = between(source, 'private object OpenScene(McpSceneOpen request)', 'private McpSceneOpenResult ReplaceScenes(');
  assert.match(open, /Replace and Reload are mutually exclusive/);
  assert.match(open, /DiscardUnsaved applies only to Replace or Reload/);
  assert.match(open, /if \(request\.Replace\) return ReplaceScenes\(record, request\.DiscardUnsaved\);/);
  assert.match(open, /_pendingSceneReload != null[\s\S]{0,40}"EDITOR_BUSY"/);
  const replace = between(source, 'private McpSceneOpenResult ReplaceScenes(', 'private McpSceneOpenResult ReloadSceneFromDisk(');
  // Only the OTHER loaded scenes are unloaded: TryEnter drops a scene listed in both lists.
  assert.match(replace, /scene\.ID != record\.Id\) others\.Add\(scene\)/);
  assert.match(replace, /editor\.StateMachine\.ChangingScenesState\.ChangeScenes\(new\[\] \{ record\.Id \}, others\);/);
  assert.match(replace, /editor\.Scene\.ClearRefsToSceneObjects\(\);/);
  assert.match(replace, /editor\.Scene\.IsEdited\(others\[i\]\)/);
  assert.match(replace, /dirty\.Count > 0 && !discardUnsaved[\s\S]{0,200}"DIRTY_SCENE"/);
  assert.match(replace, /Phase = "replacing"/);
  assert.match(replace, /UnloadedSceneIds = unloaded/);
  assert.match(replace, /Phase = "already_loaded"/);
  assert.match(replace, /RequireSceneChangeStarted\(editor, record\);/);
  // The Editor's modal save prompt is never reached.
  assert.doesNotMatch(replace, /CheckSaveBeforeClose\(|MessageBox/);
  const state = between(source, 'private static void RequireSceneChangeState(', 'private static void RequireSceneChangeStarted(');
  assert.match(state, /CanChangeScene/);
  assert.match(state, /"EDITOR_BUSY"/);
});

test('bridge v34 scene.open Reload refreshes the cached SceneAsset by ID before reopening', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const reload = between(source, 'private McpSceneOpenResult ReloadSceneFromDisk(', 'private static void RequireSceneChangeState(');
  // Dirty scenes need DiscardUnsaved.
  assert.match(reload, /editor\.Scene\.IsEdited\(loaded\) && !discardUnsaved[\s\S]{0,400}"DIRTY_SCENE"/);
  // The SceneAsset stays cached after the scene unloads, so it is reloaded by ID (path lookups can re-register the file).
  const hash = reload.indexOf('SceneFileSha256(record)');
  const getAsset = reload.indexOf('Content.GetAsset(record.Id)');
  const assetReload = reload.indexOf('cached.Reload()');
  const change = reload.indexOf('ChangeScenes(');
  const unload = reload.indexOf('UnloadScene(loaded)');
  const loadAsync = reload.indexOf('Level.LoadSceneAsync(record.Id)');
  for (const index of [hash, getAsset, assetReload, change, unload, loadAsync]) assert.notEqual(index, -1);
  assert.ok(hash < getAsset && getAsset < assetReload && assetReload < change && assetReload < unload && assetReload < loadAsync, 'Asset.Reload() must run before the scene is unloaded or reopened');
  assert.doesNotMatch(reload, /Content\.GetAssetInfo\(|Content\.Load\(/);
  // One loaded scene: ChangeScenes([id], [scene]); several: UnloadScene then an additive LoadScene on a later frame.
  assert.match(reload, /var single = Level\.ScenesCount == 1;/);
  assert.match(reload, /ChangeScenes\(new\[\] \{ record\.Id \}, new\[\] \{ loaded \}\)/);
  assert.match(reload, /if \(!single\) ArmPendingSceneReload\(record\.Id\);/);
  assert.match(reload, /Phase = "reloading"/);
  assert.match(reload, /DiskSha256 = sha256/);
  const sha = between(source, 'private static string SceneFileSha256(', 'private sealed class PendingSceneReload');
  assert.match(sha, /SHA256\.Create\(\)/);
  assert.match(sha, /FileShare\.ReadWrite \| FileShare\.Delete/);
});

test('bridge v34 multi-scene reload loads the scene again from a main-thread poller', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const arm = between(source, 'private void ArmPendingSceneReload(', 'private void DrivePendingSceneReload(');
  assert.match(arm, /_pendingSceneReload = pending/);
  assert.match(arm, /Task\.Run\(\(\) => DrivePendingSceneReload\(pending\)\)/);
  const drive = between(source, 'private void DrivePendingSceneReload(', 'private static bool StepPendingSceneReload(');
  assert.match(drive, /Scripting\.RunOnUpdate\(\(\) => \{ finished = StepPendingSceneReload\(pending\); \}\)/);
  assert.match(drive, /finally[\s\S]*_pendingSceneReload = null/);
  const step = between(source, 'private static bool StepPendingSceneReload(', 'private static string[] DirtyLoadedSceneNames(');
  assert.match(step, /Level\.FindScene\(pending\.SceneId\) != null\) return false;/);
  assert.match(step, /state\.CanChangeScene\) return false;/);
  assert.match(step, /ChangingScenesState\.LoadScene\(pending\.SceneId, true\);/);
  assert.match(step, /IsPlayModeRequested/);
});

test('bridge v34 declares scene and member capability flags true', async () => {
  const source = await readFile(bridgePath, 'utf8');
  for (const flag of ['SceneReplaceSupported', 'SceneReloadSupported', 'NestedMemberPathSupported', 'ScriptAssetReferenceWriteSupported']) {
    assert.match(source, new RegExp(`^\\s+status\\.${flag} = true;`, 'm'));
  }
});

test('bridge v34 script writes use the member pipeline: CoerceMemberValue, block reasons, ScriptMemberInfo.SetValue, one snapshot undo', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const write = between(source, 'private McpScriptFieldSetResult SetScriptField(', 'private const string ActorPropertyAllowlist');
  assert.match(write, /RequireMemberPathRequest\(q\.Path, q\.Field, "Field"\)/);
  assert.match(write, /Field must match \^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$/);
  assert.match(write, /RequireEditTime\("script\.instance_set_value"\)/);
  assert.match(write, /PlanMemberWrite\(script, path, MemberTargetScript, true, nested, q\.Bool, q\.Number, q\.Text\)/);
  assert.match(write, /undo\.RecordBegin\(script, "Set script member"\)/);
  assert.match(write, /ApplyMemberWrite\(plan, display\)/);
  assert.match(write, /undo\.RecordEnd\(script\)/);
  assert.match(write, /if \(q\.DryRun\)/);
  assert.match(write, /WouldChange = plan\.WouldChange/);
  assert.match(write, /Path = resolved/);
  // The old whitelist converter, resolver, and undo action are gone; the shared coercion keeps its primitive fallback.
  assert.doesNotMatch(source, /IsSupportedScriptFieldType\(|ResolveScriptField\(|ScriptFieldValuesEqual\(/);
  assert.doesNotMatch(source, /class McpScriptFieldUndo/);
  const plan = between(source, 'private static McpMemberWritePlan PlanMemberWrite(', 'private static void ApplyMemberWrite(');
  assert.match(plan, /ResolveMemberChain\(root, path, targetKind, editTime, nested\)/);
  assert.match(plan, /CoerceMemberValue\(leaf\.ValueType, boolValue, number, text, leaf\.Info\.Name\)/);
  assert.match(plan, /RequireWithinEditorLimit\(leaf, coerced\)/);
  const chain = between(source, 'private static McpMemberChain ResolveMemberChain(', 'private static McpMemberWritePlan PlanMemberWrite(');
  assert.match(chain, /MemberWriteBlockReason\(slot, targetKind, count == 1\)/);
  // Asset references share the actor path: CoerceMemberValue resolves them with CoerceAssetReference.
  assert.match(source, /if \(typeof\(Asset\)\.IsAssignableFrom\(type\)\) return CoerceAssetReference\(type, text, need\);/);
  // The runtime script write keeps its plain path and shares the nested one.
  const runtime = between(source, 'private McpRuntimeScriptValueResult SetRuntimeScriptValue(', 'private McpRuntimeScriptInvokeResult InvokeRuntimeScriptMethod(');
  assert.match(runtime, /PlanMemberWrite\(script, nestedPath, MemberTargetScript, false, true,/);
  assert.doesNotMatch(runtime.slice(runtime.indexOf('nestedPath != null'), runtime.indexOf('var slot = ResolveMemberSlot')), /Undo\./);
});

test('bridge v34 nested Path follows the property grid: visibility per level, leaf coercion, parents written back', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const request = between(source, 'private static string[] RequireMemberPathRequest(', 'private static McpProtocolException MemberPathError(');
  assert.match(request, /path\.Length < 1 \|\| path\.Length > MaxMemberPathDepth/);
  assert.match(source, /private const int MaxMemberPathDepth = 4;/);
  assert.match(request, /IsScriptFieldName\(segment\)/);
  assert.match(request, /must be omitted when Path is given/);
  assert.match(source, /new McpMemberPathErrorDetails \{ Path = path, SegmentIndex = index, Segment = path\[index\] \}/);
  const refusal = between(source, 'private static string NestedContainerRefusal(', 'private static McpMemberChain ResolveMemberChain(');
  assert.match(refusal, /IsEngineTypeName\(type\.FullName\)/);
  assert.match(refusal, /value == null\) return "is null/);
  assert.match(refusal, /value is FObject/);
  assert.match(refusal, /System\.Collections\.IEnumerable/);
  const chain = between(source, 'private static McpMemberChain ResolveMemberChain(', 'private static McpMemberWritePlan PlanMemberWrite(');
  // Level 0 resolves like a plain member name (EditorVisibleMembers through ResolveMemberSlot); deeper levels use the same visibility list.
  assert.match(chain, /ResolveMemberSlot\(container, path\[0\], targetKind\)/);
  assert.match(chain, /foreach \(var candidate in EditorVisibleMembers\(container\)\)/);
  assert.match(chain, /slot\.ReadOnly/);
  assert.match(chain, /editTime && slot\.NoSerialize/);
  assert.match(chain, /editTime && string\.Equals\(targetKind, MemberTargetScript, StringComparison\.Ordinal\) && slot\.NoSerialize/);
  assert.match(chain, /NestedContainerRefusal\(slot\.ValueType, value\)/);
  assert.match(chain, /IsSupportedMemberType\(slot\.ValueType\)/);
  // Write: leaf on the innermost (boxed) value, then every parent back up to the root member, always.
  const apply = between(source, 'private static void ApplyMemberWrite(', 'private static object ReadMemberLeaf(');
  const leafSet = apply.indexOf('chain.Slots[last].Info.SetValue(chain.Containers[last], plan.Coerced);');
  const parents = apply.indexOf('for (step = last - 1; step >= 0; step--)');
  const parentSet = apply.indexOf('chain.Slots[step].Info.SetValue(chain.Containers[step], chain.Containers[step + 1]);');
  assert.ok(leafSet !== -1 && parents > leafSet && parentSet > parents, 'leaf is set first, then each parent is written back');
  assert.doesNotMatch(apply, /IsValueType/);
  // actor.set_property and the UI control path take the nested route; one snapshot undo on the owning actor.
  assert.match(source, /if \(q\.Path != null\) return SetActorMember\(q\);/);
  assert.match(source, /if \(q\.Path != null\) return WriteNestedMember\(target, owner, targetKind, q\);/);
  const nested = between(source, 'private McpActorPropertySetResult WriteNestedMember(', 'private object ExecuteSetActorProperty(');
  assert.match(nested, /undo\.RecordBegin\(owner, "Set property"\)/);
  assert.match(nested, /finally \{ undo\.RecordEnd\(owner\); \}/);
  assert.match(nested, /Path = plan\.Chain\.Names/);
  assert.match(nested, /DryRun = true/);
  assert.equal(nested.match(/RecordBegin\(/g)?.length, 1);
});

test('bridge v34 script_instance_get projects asset references and nested user values within bounds', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /public McpScriptFieldDto\[\] Fields;/);
  assert.match(source, /private const int MaxNestedProjectionDepth = 2;/);
  const fill = between(source, 'private static void FillScriptFieldValue(', 'private static void FillNestedScriptValue(');
  // An asset reference is a managed "N" GUID plus its type name, with no Reason.
  assert.match(fill, /Kind = "asset", AssetId = asset\.ID\.ToString\("N"\), TypeName = /);
  assert.match(fill, /NestedContainerRefusal\(rawType, raw\) == null/);
  const nested = between(source, 'private static void FillNestedScriptValue(', 'private object UpdateScript(');
  assert.match(nested, /type\.IsValueType \? "struct" : "object"/);
  assert.match(nested, /depth > MaxNestedProjectionDepth/);
  assert.match(nested, /EditorVisibleMembers\(raw\)/);
  assert.match(nested, /MaxNestedProjectionPerLevel/);
  assert.match(nested, /budget\[0\]/);
});
