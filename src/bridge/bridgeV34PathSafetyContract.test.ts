import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Source-level contract for the bridge v34 path-spelling fix. In Flax 1.12 a
// path-based Content call (GetAssetInfo, LoadAsync, Load, GetAsset,
// RenameAsset) on an already-registered file under any spelling other than the
// engine's own makes Flax re-register that file under a NEW asset ID
// ("Founded duplicated asset ... Changing asset id"). The only safe path
// spelling is EngineAssetPath(rel); IDs are safer still. Live evidence: the
// WP-F probe report.
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

/** The text of every call `Content.<name>(...)` up to its first argument's end (comma or closing paren). */
function firstArguments(source: string, name: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(String.raw`Content\.${name}(?:<[^>(]*>)?\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const line = source.slice(source.lastIndexOf('\n', match.index) + 1, source.indexOf('\n', match.index));
    if (line.trimStart().startsWith('//')) continue;
    let depth = 0;
    let i = match.index + match[0].length;
    const begin = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
    out.push(source.slice(begin, i).trim());
  }
  return out;
}

const ID_ARGUMENT = /^(?:record\.Id|baseRecord\.Id|asset\.ID|prefabId|_assetId|guid|id|EngineAssetPath\(.+\)|EngineAssetPathFromAbsolute\(.+\)|enginePath)$/;

test('v34: path-bearing Content calls only receive IDs or the engine path spelling', async () => {
  const source = await readFile(bridgePath, 'utf8');
  for (const name of ['GetAssetInfo', 'LoadAsync', 'Load', 'GetAsset', 'RenameAsset']) {
    const args = firstArguments(source, name);
    assert.ok(args.length > 0 || name === 'GetAsset', `expected Content.${name} calls`);
    for (const arg of args) {
      assert.match(arg, ID_ARGUMENT, `Content.${name}(${arg}, ...) must use an asset ID or EngineAssetPath(...)`);
    }
  }
  // The only GetAssetInfo calls with a path are the two EngineAssetPath ones.
  const pathCalls = firstArguments(source, 'GetAssetInfo').filter(arg => arg.startsWith('EngineAssetPath('));
  assert.ok(pathCalls.length >= 2);
  assert.doesNotMatch(source, /Content\.GetAssetInfo\(destination\b/);
});

test('v34: material.create_instance clash check cannot re-register an existing asset', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const body = code(method(source, 'private McpMaterialCreateInstanceResult CreateMaterialInstance('));
  assert.doesNotMatch(body, /Content\.GetAssetInfo\(/);
  assert.match(body, /File\.Exists\(EngineAssetPath\(destination\)\)/);
  assert.match(body, /foreach \(var existing in records\)/);
  assert.match(body, /string\.Equals\(existing\.Path, destination, StringComparison\.OrdinalIgnoreCase\)/);
});

test('v34: model, skinned model, and generic asset load fallbacks use the engine path, not a Path.Combine absolute path', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.doesNotMatch(source, /Content\.LoadAsync<[^>]+>\(absolute\)/);
  assert.doesNotMatch(source, /var absolute = Path\.Combine\(Globals\.ProjectFolder, record\.Path\.Replace\('\/', Path\.DirectorySeparatorChar\)\)/);
  for (const signature of ['private static SkinnedModel LoadSkinnedModelFromRecord(', 'private static Model LoadActorModelAsset(', 'private static T LoadContentAsset<T>(']) {
    const body = method(source, signature);
    assert.match(body, /EngineAssetPathForRecord\(record\)/, signature);
    assert.match(body, /\.ID != record\.Id/, `${signature} keeps the ID-mismatch guard`);
    assert.doesNotMatch(body, /DirectorySeparatorChar/, signature);
  }
  assert.match(source, /private static string EngineAssetPathFromAbsolute\(string absolutePath\)/);
  assert.match(source, /private static string EngineAssetPathForRecord\(McpAssetRecord record\)/);
  // engine:<path> records have no project file, so they never get a path fallback.
  assert.match(method(source, 'private static string EngineAssetPathForRecord('), /EngineAssetPrefix/);
});

test('v34: asset rename passes the engine spelling to Content.RenameAsset', async () => {
  const source = await readFile(bridgePath, 'utf8');
  assert.match(source, /Content\.RenameAsset\(EngineAssetPath\(source\.Path\), EngineAssetPathFromAbsolute\(output\)\)/);
  assert.doesNotMatch(source, /Content\.RenameAsset\(sourceAbsolutePath/);
});

test('v34: navigation.build starts immediately, waits on its own budget, and is not headless-gated', async () => {
  const source = await readFile(bridgePath, 'utf8');
  const raw = method(source, 'private McpNavigationBuildResult BuildNavMesh(');
  const body = code(raw);
  // Navigation.BuildNavMesh's last argument is a start DELAY ("timeout to wait before building").
  assert.match(body, /const float BuildDelayMs = 0f;/);
  assert.match(body, /Navigation\.BuildNavMesh\(bounds, sceneForCall, BuildDelayMs\)/);
  assert.match(body, /Navigation\.BuildNavMesh\(sceneForCall, BuildDelayMs\)/);
  assert.doesNotMatch(body, /BuildNavMesh\([^;]*timeoutMs/i);
  assert.doesNotMatch(body, /BuildNavMesh\([^;]*timeoutForCall/);
  assert.match(raw, /start DELAY/);
  // Honest phases: completed only after an observed true->false (or new data).
  assert.match(body, /sawBuilding/);
  // Live (Flax 1.12): a small build keeps IsBuildingNavMesh true for 3-6 ms, so it is sampled on the request
  // thread (not through a 100 ms main-thread poll) and a processed request is recognised by Engine.UpdateCount.
  assert.doesNotMatch(body, /OnMain\(\(\) => new McpNavmeshPoll/);
  assert.match(body, /try \{ building = Navigation\.IsBuildingNavMesh;/);
  assert.match(body, /Engine\.UpdateCount >= updatesAtEnqueue \+ 2/);
  assert.match(body, /const long BuildQuietMs = 250;/);
  assert.match(body, /No tile build was observed/);
  assert.match(body, /Phase = completed \? "completed" : \(building \? "running" : "queued"\)/);
  assert.doesNotMatch(body, /Phase = building \? "timeout" : "completed"/);
  // Headless allowed; play mode and compile still refused.
  assert.doesNotMatch(body, /RequireEditTime\(/);
  assert.doesNotMatch(body, /IsHeadlessMode/);
  assert.match(body, /RequireNotPlaying\("navigation\.build"\)/);
  assert.match(body, /ScriptsBuilder\.IsCompiling/);
  const gate = code(method(source, 'private static void RequireNotPlaying('));
  assert.doesNotMatch(gate, /IsHeadlessMode/);
  assert.match(gate, /IsPlayMode/);
});
