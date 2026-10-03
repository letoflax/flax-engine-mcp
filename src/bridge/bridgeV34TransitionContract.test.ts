import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Source-level contract for bridge v34 animgraph.set_transition and asset.create
// kind GameplayGlobals. Live evidence (WP-F probe report, verdicts 4 and 9):
// transitions are only reachable through Editor-internal members (user-approved
// reflection exception) and Editor.CreateAsset("GameplayGlobals") fails in
// Flax 1.12, so the Content Browser path (virtual asset + Save) is used.
const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

/** Returns the body of one C# method, from its signature to the next private member. */
function method(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `method not found: ${signature}`);
  const next = source.indexOf('\n        private ', start + signature.length);
  return source.slice(start, next < 0 ? undefined : next);
}

/** Drops whole-line // comments so assertions only see code. */
function code(text: string): string {
  return text.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
}

test('animgraph.set_transition is dispatched through the idempotent graph path and its flag is on', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "animgraph\.set_transition":.*ExecuteIdempotent\("animgraph\.set_transition", q == null \? null : q\.IdempotencyKey, q, \(\) => SetAnimgraphTransition\(q\)\)/);
  assert.doesNotMatch(source, /NotImplementedV34\("animgraph\.set_transition"\)/);
  assert.match(source, /^\s+status\.AnimgraphTransitionSettingsSupported = true;/m);
  assert.match(source, /^\s+status\.GameplayGlobalsCreateSupported = true;/m);
});

test('transition members are resolved by reflection and each one is checked, answering UNSUPPORTED_FLAX_VERSION with the member name', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const resolve = code(method(source, 'private static AnimTransitionMembers ResolveAnimTransitionMembers('));
  assert.match(resolve, /typeof\(FlaxEditor\.Surface\.Archetypes\.Animation\)/);
  for (const [accessor, member] of [
    ['GetNestedType\\("StateMachineStateBase"', 'Animation\\+StateMachineStateBase'],
    ['GetNestedType\\("StateMachineTransition"', 'Animation\\+StateMachineTransition'],
    ['GetField\\("Transitions"', 'Animation\\+StateMachineStateBase\\.Transitions'],
    ['GetField\\("DestinationState"', 'Animation\\+StateMachineTransition\\.DestinationState'],
  ]) {
    assert.match(resolve, new RegExp(accessor), accessor);
    assert.match(resolve, new RegExp(`AnimTransitionMissing\\("${member}"\\)`), member);
  }
  for (const property of ['BlendDuration', 'BlendMode', 'Enabled', 'Solo', 'UseDefaultRule', 'Interruption']) {
    assert.match(resolve, new RegExp(`RequireAnimTransitionProperty\\(transition, "${property}", [^\\n]*, false\\)`), property);
  }
  // Order is the single optional member; every InterruptionFlags name is verified.
  assert.match(resolve, /RequireAnimTransitionProperty\(transition, "Order", [^\n]*, true\)/);
  assert.match(resolve, /AnimTransitionMissing\("Animation\+StateMachineTransition\+InterruptionFlags\." \+ flagName\)/);
  for (const name of ['RuleRechecking', 'Instant', 'SourceState', 'DestinationState']) {
    assert.match(source, new RegExp(`AnimTransitionInterruptionNames = \\{[^}]*"${name}"`), name);
  }
  const missing = code(method(source, 'private static McpProtocolException AnimTransitionMissing('));
  assert.match(missing, /"UNSUPPORTED_FLAX_VERSION"/);
  assert.match(missing, /new \{ Member = member,/);
  const property = code(method(source, 'private static PropertyInfo RequireAnimTransitionProperty('));
  assert.match(property, /property\.GetMethod == null \|\| property\.SetMethod == null/);
  assert.match(property, /if \(optional\) return null;/);
  assert.match(property, /throw AnimTransitionMissing\("Animation\+StateMachineTransition\." \+ name\)/);
});

test('transition changes go through the Editor property setters, never through an encoded byte blob', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const body = code(method(source, 'private McpAnimgraphSetTransitionResult SetAnimgraphTransition('));
  const helper = code(method(source, 'private static void SetAnimTransitionProperty('));
  for (const property of ['BlendDuration', 'BlendMode', 'Enabled', 'Solo', 'UseDefaultRule', 'Interruption', 'Order']) {
    assert.match(body, new RegExp(`SetAnimTransitionProperty\\(applied, members\\.${property}, transition,`), property);
  }
  assert.match(helper, /property\.SetValue\(transition, value\);/);
  // The setters call SaveTransitions(withUndo:true) themselves: the bridge must not touch the blob.
  for (const text of [body, helper, code(method(source, 'private static AnimTransitionMembers ResolveAnimTransitionMembers('))]) {
    assert.doesNotMatch(text, /SaveTransitions|TransitionsDataIndex|RuleGraph|BinaryWriter|MemoryStream|\.Values\[|SetValue\(\s*\d/);
  }
  // The window save and the usual modified/edited marks follow the setters, like the other graph writes.
  assert.match(body, /saver\.Save\(\);/);
  assert.match(body, /machineCtx\.MarkAsModified\(true\)/);
  assert.match(body, /surface\.MarkAsEdited\(true\)/);
  assert.ok(body.indexOf('SetAnimTransitionProperty(applied, members.BlendDuration') < body.indexOf('saver.Save();'));
  // Same gates as animgraph.add_transition.
  assert.match(body, /EnsureGraphEditorReady\(true\);/);
  assert.match(body, /CheckGraphWrite\(record, request\.LeaseId\);/);
  assert.match(body, /EnsureAnimgraphAsset\(record\);/);
  assert.match(body, /AcquireGraphSurface\(record, out item, out window, out openedByBridge\)/);
  assert.match(body, /ReleaseGraphWindow\(item, openedByBridge, record\.Id\);/);
});

test('set_transition validates before writing: dry run first, confirm for a real write, NOT_FOUND for a missing transition, Order refused when absent', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const body = code(method(source, 'private McpAnimgraphSetTransitionResult SetAnimgraphTransition('));
  const dryRun = body.indexOf('if (request.DryRun || !wouldChange)');
  const confirm = body.indexOf('if (!request.Confirm)');
  const firstSetter = body.indexOf('SetAnimTransitionProperty(applied, members.BlendDuration');
  assert.ok(dryRun > 0 && confirm > dryRun && firstSetter > confirm, 'dry run, then confirm, then the setters');
  assert.match(body, /Transition changes require confirm:true alongside dryRun:false/);
  assert.match(body, /new McpProtocolException\("NOT_FOUND", "No transition connects the source state to the destination state\./);
  assert.match(body, /destination\.ID == toId/);
  assert.match(body, /members\.Transitions\.GetValue\(fromNode\)/);
  assert.match(body, /members\.Destination\.GetValue\(candidate\)/);
  assert.match(body, /request\.Order\.HasValue && members\.Order == null[\s\S]{0,120}"VALIDATION_FAILED", "This Flax Editor build has no transition 'Order' member/);
  // Enums are validated by name against the runtime types; numbers are never parsed into them.
  assert.match(body, /Enum\.GetNames\(members\.BlendMode\.PropertyType\)/);
  assert.doesNotMatch(body, /Enum\.TryParse|\(AlphaBlendMode\)/);
  // Failed setters are rolled back and nothing is saved.
  assert.match(body, /applied fields were reverted and nothing was saved/);
  // Before and after are read back from the live transition.
  assert.match(body, /var before = ReadAnimTransitionSettings\(members, transition\);/);
  assert.match(body, /var after = ReadAnimTransitionSettings\(members, transition\);/);
});

test('GameplayGlobals are created through the Editor path: virtual asset, Save(path), DefaultValues copied and assigned back, Save()', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /"BehaviorTree", "CollisionData", "GameplayGlobals",/);
  const create = code(method(source, 'private McpAssetCreateResult CreateAsset('));
  assert.match(create, /else if \(isGlobals\) failed = CreateGameplayGlobalsAsset\(EngineAssetPath\(normalized\), globalsVariables\);\s*else failed = FEditor\.CreateAsset\(tag, absolute\);/);
  assert.match(create, /Variables are only valid with Kind GameplayGlobals\./);
  assert.match(create, /var globalsVariables = isGlobals \? ValidateGlobalsVariables\(q\.Variables\) : null;/);
  assert.ok(create.indexOf('ValidateGlobalsVariables') < create.indexOf('if (q.DryRun)'), 'variables are validated before the dry-run answer');
  assert.match(create, /CreatedAssetMetadata\(absolute, normalized, isJson \? typeName : "FlaxEngine\." \+ tag\)/);
  assert.match(create, /RefreshContentDatabaseFrom\(Path\.GetDirectoryName\(absolute\)\)/);
  assert.match(create, /FILE_EXISTS/);

  const globals = code(method(source, 'private static bool CreateGameplayGlobalsAsset('));
  assert.match(globals, /Content\.CreateVirtualAsset<GameplayGlobals>\(\)/);
  assert.match(globals, /virtualAsset\.Save\(enginePath\)/);
  assert.match(globals, /FObject\.Destroy\(virtualAsset\)/);
  assert.match(globals, /Content\.Load<GameplayGlobals>\(enginePath, 10000\)/);
  assert.match(globals, /var defaults = asset\.DefaultValues \?\? new Dictionary<string, object>\(\);/);
  assert.match(globals, /defaults\[variable\.Name\] = variable\.Value;/);
  assert.match(globals, /asset\.DefaultValues = defaults;/);
  assert.match(globals, /if \(asset\.Save\(\)\)/);
  assert.ok(globals.indexOf('virtualAsset.Save(enginePath)') < globals.indexOf('asset.DefaultValues = defaults;'));
  assert.ok(globals.indexOf('asset.DefaultValues = defaults;') < globals.indexOf('asset.Save()'));
  // Path-spelling trap: only the engine spelling reaches path-based Content calls.
  assert.doesNotMatch(globals, /Path\.Combine|Path\.GetFullPath|Globals\.ProjectFolder/);
  assert.doesNotMatch(create, /CreateAsset\("GameplayGlobals"/);
});

test('GameplayGlobals variables: only the seven supported types, bounded, unique, invariant-culture parsing', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /MaxGlobalsVariables = 64;/);
  assert.match(source, /GlobalsVariableTypes = \{ "float", "int", "bool", "Float2", "Float3", "Float4", "Color" \};/);
  const validate = code(method(source, 'private static GlobalsVariablePlan[] ValidateGlobalsVariables('));
  assert.match(validate, /variables\.Length > MaxGlobalsVariables/);
  assert.match(validate, /seen\.Add\(name\)/);
  assert.match(validate, /Duplicate variable name/);
  assert.match(validate, /has an unsupported Type; use one of:/);
  assert.match(validate, /CultureInfo\.InvariantCulture/);
  for (const type of ['float', 'int', 'bool', 'Float2', 'Float3', 'Float4', 'Color']) {
    assert.match(validate, new RegExp(`case "${type}":`), type);
  }
  assert.doesNotMatch(validate, /CurrentCulture|float\.Parse\(|int\.Parse\(/);
  const floats = code(method(source, 'private static bool TryParseGlobalsFloats('));
  assert.match(floats, /NumberStyles\.Float, CultureInfo\.InvariantCulture/);
  assert.match(floats, /float\.IsFinite/);
});
