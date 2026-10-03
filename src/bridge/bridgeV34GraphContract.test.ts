import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Source-level contract for the bridge v34 generic Visject graph core:
// graph.list_archetypes, graph.edit, nested/transition context resolution and
// MaterialFunction windows. Engine facts and live evidence: WP-F report
// (verdicts 4-7 and 9) and the Flax 1.12 decompile.
const bridgePath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));

/** Returns the body of one C# method, from its signature to the next member at the same indent. */
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

test('graph.list_archetypes and graph.edit are dispatched to real handlers and advertise their flags', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /case "graph\.list_archetypes":.*OnMain\(\(\) => GraphListArchetypes\(q\)/);
  assert.match(source, /case "graph\.edit":.*ExecuteIdempotent\("graph\.edit", q == null \? null : q\.IdempotencyKey, q, \(\) => GraphEdit\(q\)\)/);
  assert.doesNotMatch(source, /NotImplementedV34\("graph\.(list_archetypes|edit)"\)/);
  for (const flag of ['GraphArchetypeListSupported', 'GraphEditSupported', 'MaterialFunctionGraphSupported']) {
    assert.match(source, new RegExp(`^\\s+status\\.${flag} = true;`, 'm'));
  }
});

test('the archetype list is the Editor menu filter, with the state machine and transition lists read from AnimGraphSurface', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const allowed = code(method(source, 'private static List<GraphArchetypeEntry> GraphAllowedArchetypes('));
  assert.match(source, /private static void GraphAddAllowedFromGroup[\s\S]*?\(arch\.Flags & NodeFlags\.NoSpawnViaGUI\) != 0[\s\S]*?surface\.CanUseNodeType\(group, arch\)/);
  // The private static lists are read by reflection when present...
  assert.match(allowed, /typeof\(AnimGraphSurface\)\.GetField\("StateMachineGroupArchetypes", statics\)/);
  assert.match(allowed, /typeof\(AnimGraphSurface\)\.GetField\("StateMachineTransitionGroupArchetype", statics\)/);
  // ...with the documented ids as the fallback: (9,20) State, (9,34) Any, (9,23) transition source anim.
  assert.match(allowed, /new ushort\[\] \{ 20, 34 \}/);
  assert.match(allowed, /GraphFindGlobalArchetype\(surface, 9, 23,/);
  assert.match(allowed, /kind == "state_machine"/);
  assert.match(allowed, /kind == "transition"/);
  // Reflection reads only; the lists are never written.
  assert.doesNotMatch(allowed, /\.SetValue\(/);
  const list = code(method(source, 'private McpGraphArchetypeList GraphListArchetypes('));
  assert.match(list, /EnsureGraphEditorReady\(false\)/);
  assert.match(list, /ExistingNodes = existing\.ToArray\(\)/);
  assert.doesNotMatch(list, /\.Save\(\)|MarkAsModified|MarkAsEdited|SpawnNode/);
  const dto = code(method(source, 'private static McpGraphArchetype GraphArchetypeDto('));
  for (const field of ['Inputs = inputs.ToArray()', 'Outputs = outputs.ToArray()', 'DefaultValueKinds = kinds.ToArray()', 'GroupId = entry.Group.GroupID', 'TypeId = entry.Arch.TypeID']) {
    assert.ok(dto.includes(field), field);
  }
});

test('graph.edit validates every add_node against the context archetype list before SpawnNode', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const add = code(method(source, 'private static void GraphEditAddNode('));
  const allowedAt = add.indexOf('GraphAllowedArchetypes(surface, ctx, out kind');
  const rejectAt = add.indexOf('is not offered in this');
  const spawnAt = add.indexOf('ctx.SpawnNode(');
  assert.ok(allowedAt >= 0 && rejectAt > allowedAt && spawnAt > rejectAt, 'archetype check must run before the spawn');
  assert.match(add, /if \(entry == null\)\s+throw new McpProtocolException\("VALIDATION_FAILED"/);
  // Values are coerced before anything is spawned.
  assert.ok(add.indexOf('GraphEditBuildValues(') > 0 && add.indexOf('GraphEditBuildValues(') < spawnAt);
  // Refs: unique, pattern-checked, and only usable inside the context that created them.
  assert.match(add, /bound twice in this batch/);
  const resolve = code(method(source, 'private static GraphEditNode GraphEditResolveNode('));
  assert.match(resolve, /unknown node ref/);
  assert.match(resolve, /different context than this op's ContextPath/);
  assert.match(source, /private static bool IsValidGraphRef\(/);
});

test('graph.edit validates the whole batch first, needs confirm, saves once, and marks every context on the path modified', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const edit = code(method(source, 'private McpGraphEditResult GraphEdit('));
  assert.match(edit, /EnsureGraphEditorReady\(true\)/);
  assert.match(edit, /CheckGraphWrite\(record, request\.LeaseId\)/);
  const planAt = edit.indexOf('GraphEditExecute(surface, request.Ops, false)');
  const dryAt = edit.indexOf('if (request.DryRun)');
  const confirmAt = edit.indexOf('if (!request.Confirm)');
  const applyAt = edit.indexOf('GraphEditExecute(surface, request.Ops, true)');
  assert.ok(planAt >= 0 && dryAt > planAt && confirmAt > dryAt && applyAt > confirmAt, 'validate, then dry-run exit, then confirm, then apply');
  assert.equal(edit.match(/saver\.Save\(\)/g)?.length, 1, 'one Save() per batch');
  assert.ok(edit.indexOf('saver.Save()') > applyAt);
  assert.match(edit, /AdvanceProjectRevision\(\)/);
  // Every context on the path (leaf up to the root) is marked modified, because
  // VisjectSurfaceContext.Save only descends into children with IsModified.
  const mark = code(method(source, 'private static void GraphMarkContextChainModified('));
  assert.match(mark, /ctx\.MarkAsModified\(true\)/);
  assert.match(mark, /ctx = ctx\.Parent;/);
  const run = code(method(source, 'private static McpGraphEditOpResult GraphEditRunOp('));
  assert.match(run, /if \(apply\)\s*\{\s*GraphMarkContextChainModified\(ctx\);/);
  assert.match(run, /surface\.MarkAsEdited\(true\)/);
  // Mid-batch failure: flush the surface's batched undo actions, rewind the window undo stack, save nothing.
  assert.match(edit, /GraphFlushUndo\(surface\)/);
  assert.match(edit, /undo\.PerformUndo\(\)/);
  assert.match(edit, /Saved = false/);
  assert.match(edit, /OpIndex|ex\.Details/);
  assert.match(source, /private static void GraphFlushUndo\(VisjectSurface surface\)[\s\S]*?surface\.Update\(0\.0f\)/);
  const execute = code(method(source, 'private static GraphEditRunState GraphEditExecute('));
  assert.match(execute, /graph\.edit op " \+ i \+ " \(" \+ state\.FailedOp \+ "\) failed: /);
  assert.match(execute, /OpIndex = i/);
});

test('graph.edit reflection on state-machine internals checks every member and only reads', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const refl = code(method(source, 'private static GraphTransitionMembers GraphTransitionReflection('));
  for (const member of ['"StateMachineStateBase"', '"StateMachineTransition"', '"Transitions"', '"DestinationState"']) {
    assert.ok(refl.includes(member), member);
  }
  assert.match(refl, /typeof\(FlaxEditor\.Surface\.Archetypes\.Animation\)/);
  assert.match(refl, /typeof\(ISurfaceContext\)\.IsAssignableFrom\(transition\)/);
  assert.match(refl, /GetField\("Transitions", instance\)/);
  // A missing member answers UNSUPPORTED_FLAX_VERSION naming that member.
  assert.equal((refl.match(/throw GraphUnsupportedMember\(/g) ?? []).length, 5);
  const unsupported = code(method(source, 'private static McpProtocolException GraphUnsupportedMember('));
  assert.match(unsupported, /"UNSUPPORTED_FLAX_VERSION"/);
  assert.match(unsupported, /new \{ Member = member \}/);
  assert.doesNotMatch(refl, /\.SetValue\(|\.Invoke\(/);
  const find = code(method(source, 'private static object GraphFindTransition('));
  assert.match(find, /members\.Transitions\.GetValue\(fromNode\)/);
  assert.match(find, /members\.DestinationState\.GetValue\(transition\)/);
  // The rule graph is opened the way EditRule() does it: OpenContext(transition) from the state machine context.
  const open = code(method(source, 'private static VisjectSurfaceContext GraphOpenContext('));
  assert.match(open, /surface\.OpenContext\(root\.Context\)/);
  assert.match(open, /surface\.OpenContext\(found\)/);
  assert.match(open, /var sub = node as ISurfaceContext;/);
  assert.match(open, /GraphTransitionReflection\(\)/);
  // The context path grammar.
  const parse = code(method(source, 'private static GraphContextSegment[] ParseGraphContextPath('));
  assert.match(source, /GraphTransitionSegmentPrefix = "transition:"/);
  assert.match(parse, /parts\.Length != 3/);
  assert.match(parse, /MaxGraphEditContextDepth/);
});

test('graph windows keep the original context and restore it after every read and write', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const capture = code(method(source, 'private static List<ISurfaceContext> GraphCaptureContextChain('));
  assert.match(capture, /current = current\.Parent;/);
  assert.match(capture, /chain\.Reverse\(\)/);
  const restore = code(method(source, 'private static void GraphRestoreContextChain('));
  assert.match(restore, /surface\.OpenContext\(chain\[i\]\)/);
  for (const signature of ['private McpGraphEditResult GraphEdit(', 'private McpGraphArchetypeList GraphListArchetypes(']) {
    const body = code(method(source, signature));
    const captureAt = body.indexOf('GraphCaptureContextChain(surface)');
    const finallyAt = body.lastIndexOf('finally');
    assert.ok(captureAt >= 0, `${signature} captures the entry view`);
    assert.ok(finallyAt > captureAt, `${signature} restores in finally`);
    assert.ok(body.indexOf('GraphRestoreContextChain(surface, chain, null)', finallyAt) > finallyAt, `${signature} restores in finally`);
    assert.ok(body.indexOf('ReleaseGraphWindow(item, openedByBridge, record.Id)', finallyAt) > finallyAt);
  }
  const edit = code(method(source, 'private McpGraphEditResult GraphEdit('));
  // The view is also restored before the save, so the saved window shows what it showed before.
  assert.ok(edit.indexOf('GraphRestoreContextChain(surface, chain, warnings)') < edit.indexOf('saver.Save()'));
});

test('graph.edit ops use the Editor paths: undo-aware Box.Connect, Delete with undo, SetValues, bridge move undo', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const connect = code(method(source, 'private static void GraphEditConnect('));
  assert.match(connect, /fromBox\.CanConnectWith\(toBox\)/);
  assert.match(connect, /fromBox\.Connect\(toBox\)/);
  assert.match(connect, /if \(!GraphBoxesConnected\(fromBox, toBox\)\)\s+throw new McpProtocolException\("ASSET_OPERATION_FAILED"/);
  assert.match(connect, /already connected/);
  const states = code(method(source, 'private static void GraphEditConnectStates('));
  assert.match(states, /source\.CanConnectWith\(destination\)/);
  assert.match(states, /source\.Connect\(destination\)/);
  const remove = code(method(source, 'private static void GraphEditRemove('));
  assert.match(remove, /surface\.Delete\(new SurfaceControl\[\] \{ target\.Node \}, true\)/);
  assert.match(remove, /NodeFlags\.NoRemove/);
  const move = code(method(source, 'private static void GraphEditMove('));
  assert.match(move, /surface\.AddBatchedUndoAction\(new McpGraphMoveUndo\(/);
  const setValues = code(method(source, 'private static void GraphEditSetValues('));
  assert.match(setValues, /target\.Node\.SetValues\(values\)/);
  assert.match(setValues, /The editor did not keep value index/);
  // Each op runs with its own context open, so a cast node Box.Connect may insert lands in that context.
  const run = code(method(source, 'private static McpGraphEditOpResult GraphEditRunOp('));
  assert.ok(run.indexOf('GraphOpenContext(surface, path)') < run.indexOf('switch (op.Op)'));
  assert.doesNotMatch(source, /new VisjectSurface\(/);
  assert.doesNotMatch(source, /\.SaveSurface\(/);
});

test('graph value layouts: Float4 and Guid slots, Multi Blend growth in point pairs, parameter ids', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const build = code(method(source, 'private static object[] GraphEditBuildValues('));
  assert.match(build, /arch\.TypeID == 12 \|\| arch\.TypeID == 13/);
  assert.match(build, /NodeFlags\.VariableValuesSize/);
  assert.match(build, /new Float4\(0\.0f, 0\.0f, 0\.0f, 1\.0f\)/);
  assert.match(build, /Guid\.Empty/);
  assert.match(build, /\(newLength & 1\) != 0/);
  assert.match(build, /MaxGraphEditValuesLength/);
  assert.match(source, /MaxGraphEditValuesLength = 4 \+ 2 \* 255/);
  // The coercion is the graph.set_node_values one; Float4 comes from vector4, Guid from asset_id.
  const coerce = code(method(source, 'private static object GraphEditCoerceValue('));
  assert.match(coerce, /CoerceGraphNodeValue\(value, slotType, entry\.Index\)/);
  assert.match(coerce, /parsed == Guid\.Empty/);
  assert.match(coerce, /parameter\.ID == parsed/);
  // The wrong v33 comment about the Animation node defaults is fixed.
  assert.doesNotMatch(source, /DefaultValues=\[null\(asset\)/);
  assert.match(source, /DefaultValues=\[Guid\.Empty\(clip\)/);
});

test('MaterialFunction and ParticleEmitterFunction windows are reached through their public Surface, readiness is Enabled', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const resolve = code(method(source, 'private static McpAssetRecord ResolveGraphRecord('));
  assert.match(resolve, /"FlaxEngine\.MaterialFunction"/);
  assert.match(resolve, /"FlaxEngine\.ParticleEmitterFunction"/);
  const surface = code(method(source, 'private static VisjectSurface GraphWindowSurface('));
  assert.match(surface, /window as FlaxEditor\.Windows\.Assets\.MaterialFunctionWindow/);
  assert.match(surface, /materialFunction\.Surface/);
  assert.match(surface, /window as FlaxEditor\.Windows\.Assets\.ParticleEmitterFunctionWindow/);
  const asset = code(method(source, 'private static Asset GraphWindowAsset('));
  assert.match(asset, /materialFunction\.SurfaceAsset/);
  const validate = code(method(source, 'private static void ValidateGraphWindow('));
  assert.match(validate, /window is FlaxEditor\.Windows\.Assets\.MaterialFunctionWindow/);
  assert.match(validate, /!\(window is IVisjectSurfaceWindow\) && !isMatFunction && !isFxFunction/);
  const loaded = code(method(source, 'private static void EnsureGraphSurfaceLoaded('));
  assert.match(loaded, /surface\.Enabled/);
  assert.match(loaded, /GraphWindowAsset\(window\)/);
  const acquire = code(method(source, 'private static VisjectSurface AcquireGraphSurface('));
  assert.doesNotMatch(acquire, /\(\(IVisjectSurfaceWindow\)/);
  assert.match(acquire, /GraphWindowSurface\(window\)/);
  assert.match(acquire, /GraphWindowSurface\(opened\)/);
});

// Found in the live run: graph.edit refused every wire from a Get Parameter node created in the same batch,
// and could not add particle modules at all.
test('graph.edit accepts a wire from a Get Parameter node created in the same batch (its boxes only exist after spawn)', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const resolve = code(method(source, 'private static bool GraphEditResolveBox('));
  assert.match(resolve, /node\.Arch\.Title, "Get Parameter"/);
  assert.match(resolve, /boxId >= 0 && boxId <= 4/);
  assert.match(resolve, /isOutput = true;\s+return false;/);
  // The apply pass still resolves the real box and fails when it is missing.
  assert.match(resolve, /box = FindNodeBoxById\(node\.Node, boxId\);[\s\S]*?was not found on the node/);
});

test('graph.edit offers the particle modules (group 15, NoSpawnViaGUI) on a ParticleEmitter root, like the stage header "+" menu', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const allowed = code(method(source, 'private static List<GraphArchetypeEntry> GraphAllowedArchetypes('));
  assert.match(source, /private const int GraphParticleModulesGroup = 15;/);
  assert.match(allowed, /kind == "root" && surface is ParticleEmitterSurface/);
  assert.match(allowed, /group\.GroupID == GraphParticleModulesGroup\) GraphAddAllowedFromGroup\(surface, group, result, seen, true\)/);
  assert.match(source, /private static void GraphAddAllowedFromGroup\(VisjectSurface surface, GroupArchetype group, List<GraphArchetypeEntry> result, HashSet<int> seen, bool includeNoSpawnViaGui = false\)/);
  assert.match(source, /if \(!includeNoSpawnViaGui && \(arch\.Flags & NodeFlags\.NoSpawnViaGUI\) != 0\) continue;/);
});
