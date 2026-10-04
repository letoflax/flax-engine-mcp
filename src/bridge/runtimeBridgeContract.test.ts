import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runtimePath = fileURLToPath(new URL('../../bridge/FlaxMcpRuntimeBridge.cs', import.meta.url));
const editorPath = fileURLToPath(new URL('../../bridge/FlaxMcpBridge.cs', import.meta.url));
const smokePath = fileURLToPath(new URL('../../test/flax-api-smoke/RuntimeBridgeCompileSmoke.csproj', import.meta.url));

/** The one place this suite pins the runtime bridge version (the editor bridge has its own, separate version). */
const RUNTIME_BRIDGE_VERSION = 37;

/** The methods the v36 contract gives the runtime bridge, in dispatch order. */
const CONTRACT_METHODS = [
  'status',
  'runtime.invoke_script_method',
  'runtime.set_script_value',
  'runtime.inspect_actor',
  'capture.start',
  'capture.status',
  'log.query',
  'play.set_time_scale',
  'perf.snapshot',
  'perf.gpu_events',
  'game.quit',
];

/** Removes // and block comments and the contents of string literals so token checks cannot be fooled by prose. */
function codeOnly(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"') {
      out += '""';
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '\'') {
      out += '\'\'';
      i++;
      while (i < source.length && source[i] !== '\'') i += source[i] === '\\' ? 2 : 1;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Public DTO classes as name -> sorted "type name" field list. Comments are stripped first. */
function dtoFields(source: string): Map<string, string[]> {
  const stripped = source.replace(/\/\/[^\n]*/g, '');
  const result = new Map<string, string[]>();
  for (const match of stripped.matchAll(/public class (\w+)\s*\{/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (index < stripped.length && depth > 0) {
      if (stripped[index] === '{') depth++;
      else if (stripped[index] === '}') depth--;
      index++;
    }
    const body = stripped.slice(start, index - 1);
    const fields: string[] = [];
    for (const statement of body.split(';')) {
      const field = statement.replace(/=[\s\S]*$/, '').trim();
      const pieces = field.replace(/^public\s+/, '').split(/\s+/);
      if (!field.startsWith('public ') || pieces.length < 2) continue;
      fields.push(`${pieces[pieces.length - 2]} ${pieces[pieces.length - 1]}`);
    }
    result.set(match[1]!, fields.sort());
  }
  return result;
}

test('runtime bridge is guarded to cooked non-release game builds and never compiles with the editor bridge', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const guard = lines.findIndex(line => line.startsWith('#if'));
  assert.equal(lines[guard], '#if FLAX_GAME && !BUILD_RELEASE', 'first preprocessor line is the contract guard');
  assert.ok(lines.slice(0, guard).every(line => line.startsWith('//') || line.trim() === ''), 'only comments precede the guard');
  // Nothing but the closing #endif lines follows the namespace, so the whole file is inside the guard.
  const closing = lines.filter(line => line.trim() !== '');
  assert.equal(closing[closing.length - 1], '#endif');
  assert.equal(lines.filter(line => line.startsWith('#if ')).length, 2);
  assert.equal(lines.filter(line => line.startsWith('#endif')).length, 2);
  // FLAX_GAME may also be defined for a module the Editor compiles; the Editor bridge owns that case.
  assert.match(source, /^#if !FLAX_EDITOR$/m);
  assert.doesNotMatch(source, /^#if FLAX_EDITOR\b/m);
  // The editor bridge stays Editor-only, so the two files can reuse DTO names.
  const editor = await readFile(editorPath, 'utf8');
  assert.match(editor, /^#if FLAX_EDITOR$/m);
  assert.doesNotMatch(editor, /FLAX_GAME/);
});

test('runtime bridge states version 37 and Kind "game" everywhere', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const found = (pattern: RegExp) => [...source.matchAll(pattern)].map(match => Number(match[1]));
  assert.deepEqual(found(/MCP-BRIDGE-VERSION:\s*(\d+)/g), [RUNTIME_BRIDGE_VERSION]);
  // The constant plus the heartbeat and status DTO defaults.
  const declared = found(/\bint\s+BridgeVersion\s*=\s*(\d+)\s*;/g);
  assert.equal(declared.length, 3);
  assert.ok(declared.every(version => version === RUNTIME_BRIDGE_VERSION), `BridgeVersion declarations: ${declared.join(', ')}`);
  assert.deepEqual(found(/Debug\.Log\("\[Flax MCP\] Runtime bridge v(\d+) listening/g), [RUNTIME_BRIDGE_VERSION]);
  assert.equal(source.match(/string Kind = "game";/g)?.length, 2, 'heartbeat and status both say Kind "game"');
  // Exact DTO shapes from the contract.
  const dtos = dtoFields(source);
  assert.deepEqual(dtos.get('McpRuntimeBridgeInfo'), ['int BridgeVersion', 'string EngineVersion', 'string Instance', 'string Kind', 'int Pid', 'string ProductName', 'int ProtocolVersion', 'long Timestamp'].sort());
  assert.deepEqual(dtos.get('McpRuntimeStatus'), ['int BridgeVersion', 'string EngineVersion', 'long FrameCount', 'string Instance', 'string Kind', 'int LoadedSceneCount', 'string[] Methods', 'int Pid', 'string ProductName', 'int ProtocolVersion', 'float TimeScale'].sort());
  assert.match(source, /ProtocolVersion = 1;/);
});

test('runtime bridge DTOs reuse the editor bridge names and fields exactly', async () => {
  const runtime = dtoFields(await readFile(runtimePath, 'utf8'));
  const editor = dtoFields(await readFile(editorPath, 'utf8'));
  const runtimeOnly = new Set(['McpRuntimeBridgeInfo', 'McpRuntimeStatus', 'McpRuntimePlayStatus', 'McpRuntimeQuitResult']);
  const shared = [...runtime.keys()].filter(name => !runtimeOnly.has(name));
  assert.ok(shared.length >= 20, `expected the shared DTO set, found ${shared.length}`);
  for (const name of shared) {
    assert.ok(editor.has(name), `${name} must also exist in the editor bridge`);
    assert.deepEqual(runtime.get(name), editor.get(name), `${name} fields differ from the editor bridge`);
  }
  for (const required of ['McpRequest', 'McpResponse', 'McpRuntimeScriptValueSet', 'McpRuntimeScriptValueResult', 'McpRuntimeScriptInvoke', 'McpRuntimeScriptInvokeResult', 'McpRuntimeActorInspect', 'McpRuntimeActorInspection', 'McpLogQuery', 'McpLogQueryResult', 'McpPerfSnapshot', 'McpCaptureStart', 'McpCaptureStatus', 'McpTimeScaleRequest', 'McpMemberPathErrorDetails'])
    assert.ok(shared.includes(required), `${required} is part of the runtime contract`);
});

test('runtime bridge stays inert without an absolute -mcpdir and only then creates files', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const code = codeOnly(source);
  const init = code.slice(code.indexOf('public override void Initialize()'), code.indexOf('public override void Deinitialize()'));
  assert.match(init, /if \(!TryReadLaunchOptions\(out directory, out instance\)\) return;/);
  // Nothing touches the disk, the log handler or the update loop before the option check.
  const gate = init.indexOf('TryReadLaunchOptions');
  for (const effect of ['Directory.CreateDirectory', 'WriteToken', 'WriteHeartbeat', 'SubscribeEvents', 'Scripting.Update +=', 'CreateSessionToken'])
    assert.ok(init.indexOf(effect) > gate, `${effect} must come after the -mcpdir gate`);
  const options = source.slice(source.indexOf('private static bool TryReadLaunchOptions('), source.indexOf('private static bool IsValidInstanceName('));
  assert.match(options, /Engine\.CommandLine/);
  assert.match(options, /ReadCommandLineValue\(commandLine, "mcpdir", out present\)/);
  assert.match(options, /if \(!present\) return false;/);
  assert.match(options, /Path\.IsPathFullyQualified\(raw\)/);
  assert.match(options, /Debug\.LogWarning\("\[Flax MCP\] Runtime bridge stays inert: -mcpdir must be an absolute path\."\)/);
  assert.match(options, /ReadCommandLineValue\(commandLine, "mcpinstance", out instancePresent\)/);
  assert.match(options, /instance = Environment\.ProcessId\.ToString/);
  assert.match(source, /IsValidInstanceName/);
  // Quoted and unquoted values.
  const reader = source.slice(source.indexOf('private static string ReadCommandLineValue('), source.indexOf('private static string SafeText('));
  assert.match(reader, /commandLine\[start\] == '"'/);
  assert.match(reader, /char\.IsWhiteSpace\(commandLine\[end\]\)/);
  // The directory layout and heartbeat cadence.
  for (const folder of ['requests', 'processing', 'responses', 'captures', 'bridge.json', 'token'])
    assert.match(source, new RegExp(`Path\\.Combine\\(_root, "${folder.replace('.', '\\.')}"\\)`));
  assert.match(source, /HeartbeatMs = 2000;/);
  assert.match(source, /MaxRequestsPerPoll = 4;/);
  // Deinitialize removes the token and the heartbeat, only when this process owns them.
  const deinit = source.slice(source.indexOf('public override void Deinitialize()'), source.indexOf('// -mcpdir=<absolute path>'));
  assert.match(deinit, /TryDelete\(BridgePath\);/);
  assert.match(deinit, /TryDelete\(TokenPath\);/);
  assert.match(deinit, /info\.Pid == Environment\.ProcessId/);
  assert.match(deinit, /Scripting\.Update -= OnUpdate;/);
});

test('runtime bridge plugin is a GamePlugin with a description', async () => {
  const source = await readFile(runtimePath, 'utf8');
  assert.match(source, /public sealed class FlaxMcpRuntimeBridgePlugin : GamePlugin/);
  assert.match(source, /_description = new PluginDescription/);
  assert.match(source, /public override void Initialize\(\)/);
  assert.match(source, /public override void Deinitialize\(\)/);
  assert.doesNotMatch(source, /EditorPlugin/);
});

test('runtime bridge transport matches the editor bridge', async () => {
  const source = await readFile(runtimePath, 'utf8');
  assert.match(source, /File\.Move\(requestPath, processingPath\);/);
  assert.match(source, /Task\.Run\(\(\) => ProcessFile\(processingPath, name\)\);/);
  assert.match(source, /WriteAtomic\(Path\.Combine\(Responses, requestFileName\)/);
  assert.match(source, /private static void WriteAtomic\(string path, string text\) \{ var temp = path \+ "\." \+ Guid\.NewGuid\(\)\.ToString\("N"\) \+ "\.tmp";[^}]*File\.Replace\(temp, path, null\); else File\.Move\(temp, path\); \}/);
  // 256-bit token, constant-time comparison, token echoed on authenticated failures only.
  assert.match(source, /var bytes = new byte\[32\]; using \(var rng = RandomNumberGenerator\.Create\(\)\) rng\.GetBytes\(bytes\);/);
  assert.match(source, /if \(!ConstantTimeEquals\(request\.token, _token\)\)/);
  assert.match(source, /"UNAUTHORIZED"/);
  assert.match(source, /private static McpResponse Failure\(string id, string requestToken, string code, string message, object details = null\)/);
  assert.match(source, /new McpResponse \{ id = id, token = requestToken, ok = false, errorCode = code/);
  // Same limits and error codes as the editor bridge.
  for (const code of ['INVALID_REQUEST', 'REQUEST_TOO_LARGE', 'DEADLINE_EXCEEDED', 'INTERNAL_ERROR', 'RESPONSE_TOO_LARGE', 'VALIDATION_FAILED', 'NOT_FOUND', 'METHOD_NOT_FOUND'])
    assert.match(source, new RegExp(`"${code}"`));
  assert.match(source, /MaxRequestBytes = 128 \* 1024;/);
  assert.match(source, /MaxParamsBytes = 64 \* 1024;/);
  assert.match(source, /MaxDeadlineMs = 60 \* 1000;/);
  assert.match(source, /MaxResultBytes = 512 \* 1024;/);
  // Main-thread work goes through the update queue and honours the request deadline.
  assert.match(source, /Scripting\.InvokeOnUpdate\(\(\) =>/);
  assert.match(source, /Request expired before game execution\./);
  assert.match(source, /AsyncWaitHandle\.WaitOne\(waitMs\)/);
  // Error details are flattened because FlaxEngine.Json drops anonymous-type properties.
  assert.match(source, /private static object PlainForJson\(object value\)/);
  assert.match(source, /JsonSerializer\.Serialize\(PlainForJson\(details\), false\)/);
  assert.match(source, /JsonSerializer\.Serialize\(PlainForJson\(result\), true\)/);
  // The heartbeat is rewritten on a timer from the update loop.
  assert.match(source, /private void WriteHeartbeat\(\) \{ WriteAtomic\(BridgePath, JsonSerializer\.Serialize\(new McpRuntimeBridgeInfo \{ Pid = Environment\.ProcessId, Instance = _instance/);
  assert.match(source, /private void OnUpdate\(\)[\s\S]*?now - _lastHeartbeat >= HeartbeatMs/);
});

test('runtime bridge dispatch cases equal KnownMethods and the v36 contract, and unknown methods fail with METHOD_NOT_FOUND', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const switchStart = source.indexOf('switch (request.method)');
  assert.notEqual(switchStart, -1);
  const defaultStart = source.indexOf('default:', switchStart);
  assert.notEqual(defaultStart, -1);
  const labels = [...source.slice(switchStart, defaultStart).matchAll(/^\s*case "([^"]+)":/gm)].map(match => match[1]);
  assert.deepEqual(labels, CONTRACT_METHODS);
  const arrayStart = source.indexOf('private static readonly string[] KnownMethods');
  const arrayBody = source.slice(source.indexOf('{', arrayStart), source.indexOf('};', arrayStart));
  assert.deepEqual([...arrayBody.matchAll(/"([^"]+)"/g)].map(match => match[1]), CONTRACT_METHODS);
  const defaultLine = source.slice(defaultStart, source.indexOf('\n', defaultStart));
  assert.match(defaultLine, /throw new McpProtocolException\("METHOD_NOT_FOUND"/);
  assert.match(defaultLine, /new \{ Method = request\.method, Methods = KnownMethods \}/);
  assert.match(source, /Methods = KnownMethods \};/, 'status publishes the method list');
  assert.doesNotMatch(source, /"METHOD_NOT_ALLOWED"/);
  // Editor-only methods are not accepted.
  for (const editorOnly of ['scene.', 'actor.', 'asset.', 'editor.', 'play.start', 'play.stop', 'input.'])
    assert.ok(!labels.some(label => label!.startsWith(editorOnly)), `${editorOnly} is not a runtime method`);
});

test('runtime bridge has no FlaxEditor, ScriptType or Process dependency', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const code = codeOnly(source);
  assert.doesNotMatch(source, /System\.Diagnostics\.Process/);
  assert.doesNotMatch(code, /\bProcess\./);
  assert.doesNotMatch(code, /\bProcess\s+\w+\s*[=;]/);
  assert.doesNotMatch(code, /using System\.Diagnostics/);
  assert.doesNotMatch(code, /\bFlaxEditor\b/);
  assert.doesNotMatch(code, /\bFEditor\b/);
  assert.doesNotMatch(code, /\b(ScriptType|ScriptMemberInfo|ScriptsBuilder|GameCooker|Editor\.Instance)\b/);
  // Process liveness uses blittable imports only (disabled runtime marshalling in game assemblies): kernel32 on Windows, libc kill on macOS.
  assert.match(source, /Environment\.ProcessId/);
  assert.match(source, /\[DllImport\("kernel32\.dll"\)\] private static extern IntPtr OpenProcess\(uint desiredAccess, int inheritHandle, int processId\);/);
  assert.match(source, /\[DllImport\("libc", EntryPoint = "kill"\)\] private static extern int UnixKill\(int pid, int signal\);/);
  assert.doesNotMatch(source, /DllImport\("(?!kernel32\.dll"|libc", EntryPoint = "kill")/);
  assert.doesNotMatch(source, /SetLastError\s*=/);
  // Members are resolved with System.Reflection.
  assert.match(source, /using System\.Reflection;/);
  assert.match(source, /FieldInfo/);
  assert.match(source, /PropertyInfo/);
  assert.match(source, /MethodInfo/);
});

test('runtime bridge writes and invokes only public game members and looks assets up by GUID only', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const code = codeOnly(source);
  // Engine/framework namespaces are never "game code".
  const engine = source.slice(source.indexOf('private static bool IsEngineTypeName('), source.indexOf('private static bool IsScriptFieldName('));
  for (const prefix of ['FlaxEngine.', 'FlaxEditor.', 'System.', 'Microsoft.']) assert.ok(engine.includes(`"${prefix}"`), `${prefix} is an engine namespace`);
  assert.match(source, /BindingFlags\.Instance \| BindingFlags\.Public \| BindingFlags\.DeclaredOnly/);
  assert.doesNotMatch(code, /BindingFlags\.NonPublic/);
  assert.match(source, /!IsEngineTypeName\(current\.FullName\)/);
  assert.match(source, /IsEngineTypeName\(candidate\.DeclaringType\.FullName\)/);
  assert.match(source, /Engine-declared script members are not writable through this surface\./);
  // set_script_value: nested Path (<= 4), runtime writes without undo, scalar set plus assets by GUID.
  assert.match(source, /MaxMemberPathDepth = 4;/);
  assert.match(source, /RequireMemberPathRequest\(q\.Path, q\.Member, "Member"\)/);
  assert.match(source, /new McpMemberPathErrorDetails \{ Path = path, SegmentIndex = index, Segment = path\[index\] \}/);
  assert.match(source, /Runtime write: no undo was recorded/);
  for (const type of ['bool', 'string', 'float', 'double', 'Guid', 'Vector2', 'Float2', 'Vector3', 'Float3', 'Vector4', 'Float4', 'Color', 'Quaternion'])
    assert.match(source, new RegExp(`type == typeof\\(${type}\\)`), `${type} is in the supported scalar set`);
  assert.match(source, /type\.IsEnum/);
  assert.match(source, /MaxRuntimeInvokeArgs = 4;/);
  assert.match(source, /result\.Threw = true;/);
  assert.match(source, /result\.ExceptionType = /);
  assert.match(source, /result\.ExceptionMessage = /);
  assert.match(source, /TargetInvocationException/);
  // Assets: 32-hex GUID through Content.LoadAsync(Guid, Type); no path-based lookup of any kind.
  assert.match(source, /Guid\.TryParseExact\(text, "N", out id\)/);
  assert.match(source, /Content\.LoadAsync\(id, assetType\)/);
  assert.match(source, /path-based asset lookups are not available in a cooked game/);
  assert.doesNotMatch(code, /Content\.(Load|LoadAsync|LoadAsyncInternal|Find|GetAssetInfo)\(\s*(path|text|name|asset|reference|raw|value|\w*Path\w*)\s*[,)]/);
  assert.doesNotMatch(code, /Content\.(Find|GetAllAssets|LoadAsyncInternal|CreateVirtualAsset|FindAsset|RenameAsset|DeleteAsset)\b/);
  assert.doesNotMatch(code, /ContentDatabase|ProjectContentFolder|EngineContentFolder/);
  assert.doesNotMatch(code, /MemberAssetReferencePath|ResolveMemberAssetRecord/);
  // Asset results report the GUID and type only.
  const projection = source.slice(source.indexOf('private static McpMaterialTypedValue ProjectMemberValue('), source.indexOf('// ---- transport helpers ----'));
  assert.match(projection, /Kind = "asset", AssetId = asset\.ID\.ToString\("N"\), TypeName/);
  assert.doesNotMatch(projection, /asset\.Path|\.Path\b/);
});

test('runtime bridge capture.start uses Screenshot.Capture into captures/ and reports instance-relative paths only', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const start = source.slice(source.indexOf('private McpCaptureStatus StartCapture('), source.indexOf('private McpCaptureStatus GetCaptureStatus('));
  assert.match(start, /request\.Width != 0 \|\| request\.Height != 0/);
  assert.match(start, /"VALIDATION_FAILED", "Custom capture dimensions are not supported/);
  assert.match(start, /Path\.Combine\(Captures, id \+ "\.png"\)/);
  assert.match(start, /Screenshot\.Capture\(path\);/);
  assert.match(start, /Path = "captures\/" \+ id \+ "\.png"/);
  assert.match(start, /Guid\.NewGuid\(\)\.ToString\("N"\)/);
  const status = source.slice(source.indexOf('private McpCaptureStatus GetCaptureStatus('), source.indexOf('private static McpCaptureStatus CopyCaptureStatus('));
  assert.match(status, /info\.Length > 0/);
  assert.match(status, /item\.Phase = "Completed"/);
  assert.match(status, /IsGuidN\(request\.CaptureId\)/);
  assert.match(status, /"NOT_FOUND"/);
  // The wire path never contains the instance directory.
  assert.doesNotMatch(start + status, /Path = [^;]*_root/);
  assert.doesNotMatch(start + status, /Path = Path\.Combine/);
});

test('runtime bridge keeps a 2000 entry log ring fed by the engine log handler', async () => {
  const source = await readFile(runtimePath, 'utf8');
  assert.match(source, /MaxLogEntries = 2000;/);
  assert.match(source, /_logHandler = Debug\.Logger == null \? null : Debug\.Logger\.LogHandler;/);
  assert.match(source, /_logHandler\.SendLog \+= OnSendLog;/);
  assert.match(source, /_logHandler\.SendLog -= OnSendLog;/);
  assert.match(source, /_logHandler\.SendExceptionLog \+= OnSendExceptionLog;/);
  assert.match(source, /if \(_logs\.Count > MaxLogEntries\) _logs\.RemoveAt\(0\);/);
  // Subscription happens at plugin init, after the gate.
  const init = source.slice(source.indexOf('public override void Initialize()'), source.indexOf('public override void Deinitialize()'));
  assert.match(init, /SubscribeEvents\(\);/);
  // Same query shape as the editor log.query, and absolute project paths are redacted.
  assert.match(source, /private McpLogQueryResult QueryLogs\(McpLogQuery query\)/);
  assert.match(source, /Math\.Min\(query\.Limit > 0 \? query\.Limit : query\.MaxEntries, 200\)/);
  assert.match(source, /"<project>"/);
});

test('runtime bridge play.set_time_scale and perf.snapshot follow the editor limits', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const scale = source.slice(source.indexOf('private McpRuntimePlayStatus SetPlayTimeScale('), source.indexOf('private McpPerfSnapshot PerfSnapshot('));
  assert.match(scale, /request\.TimeScale < 0\.0f \|\| request\.TimeScale > 10\.0f/);
  assert.match(scale, /"VALIDATION_FAILED", "TimeScale must be between 0 and 10\./);
  assert.match(scale, /Time\.TimeScale = request\.TimeScale;/);
  const perf = source.slice(source.indexOf('private McpPerfSnapshot PerfSnapshot('), source.indexOf('// ---- log ring ----'));
  for (const probe of ['Engine.FramesPerSecond', 'Time.UnscaledDeltaTime', 'GC.GetTotalMemory(false)', 'Level.GetActors(typeof(Actor), false)', 'GPUDevice.Instance', 'ProfilingTools.Stats'])
    assert.ok(perf.includes(probe), `perf.snapshot reads ${probe}`);
});

test('runtime bridge perf.gpu_events matches the editor method and restores the profiler state', async () => {
  const source = await readFile(runtimePath, 'utf8');
  assert.match(source, /case "perf\.gpu_events": result = OnMain\(\(\) => PerfGpuEvents\(JsonSerializer\.Deserialize<McpPerfGpuEventsRequest>\(p\)\), request\.deadlineUnixMs\); break;/);
  const body = source.slice(source.indexOf('private const int GpuProfilerLeaseMs'), source.indexOf('// ---- log ring ----'));
  for (const probe of ['ProfilingTools.EventsGPU', 'ProfilingTools.Stats', 'ProfilerGPU.Enabled = _gpuProfilerPrevious', 'GPUDevice.Instance'])
    assert.ok(body.includes(probe), `perf.gpu_events reads ${probe}`);
  assert.doesNotMatch(body, /ProfilingTools\.Enabled|ProfilerCPU|EventsEnabled|FlaxEditor|FEditor/);
  assert.match(source, /private void OnUpdate\(\)[\s\S]*?TickGpuProfiler\(now\);/);
  assert.match(source, /public override void Deinitialize\(\)[\s\S]*?RestoreGpuProfiler\(\);/);
});

test('runtime bridge game.quit responds first and calls RequestExit on a later frame from the update loop', async () => {
  const source = await readFile(runtimePath, 'utf8');
  assert.match(source, /case "game\.quit": result = OnMain\(GameQuit, request\.deadlineUnixMs\); break;/);
  // Engine.RequestExit appears exactly once, in the pending-quit tick that OnUpdate runs, never inside the request.
  assert.equal(source.match(/Engine\.RequestExit\(/g)?.length, 1);
  const request = source.slice(source.indexOf('private McpRuntimeQuitResult GameQuit('), source.indexOf('// Runs from OnUpdate (game update thread).'));
  assert.doesNotMatch(request, /RequestExit/);
  assert.match(request, /_pendingQuit = new PendingQuit \{ ArmedTick = Environment\.TickCount64, ArmedFrame = Engine\.FrameCount \};/);
  const tick = source.slice(source.indexOf('private void TickPendingQuit('), source.indexOf('// Time.TimeScale is engine-global'));
  assert.match(tick, /Engine\.RequestExit\(\);/);
  assert.match(tick, /Engine\.FrameCount <= pending\.ArmedFrame/);
  assert.match(tick, /ResponseWritten/);
  assert.match(source, /private void OnUpdate\(\)[\s\S]*?TickPendingQuit\(now\);/);
  // ProcessFile marks the response as written only after the response file is on disk.
  const process = source.slice(source.indexOf('private void ProcessFile('), source.indexOf('// Every dispatch case label'));
  assert.ok(process.indexOf('WriteAtomic(Path.Combine(Responses') < process.indexOf('ResponseWritten = true'));
  assert.match(process, /"game\.quit"/);
});

test('runtime compile smoke project builds only the runtime bridge with the game defines', async () => {
  const project = await readFile(smokePath, 'utf8');
  assert.match(project, /<Compile Include="\.\.\/\.\.\/bridge\/FlaxMcpRuntimeBridge\.cs"/);
  assert.doesNotMatch(project, /FlaxMcpBridge\.cs/);
  assert.match(project, /<EnableDefaultCompileItems>false<\/EnableDefaultCompileItems>/);
  assert.match(project, /<RuntimeBuildConfig Condition="'\$\(RuntimeBuildConfig\)' == ''">Development<\/RuntimeBuildConfig>/);
  assert.match(project, /<DefineConstants>FLAX_GAME;BUILD_/);
  // The game assembly path is built per host OS in Directory.Build.props: Source/Platforms/<OS>/Binaries/Game/<arch>/<config>.
  assert.match(project, /'Source', 'Platforms', '\$\(FlaxGamePlatformDir\)', 'Binaries', 'Game', '\$\(FlaxGameArch\)', '\$\(RuntimeBuildConfig\)', 'FlaxEngine\.CSharp\.dll'/);
  assert.doesNotMatch(project, /Binaries[\\/']+\s*,?\s*'?Editor|FlaxEditorCSharpPath/);
  // The editor smoke never globs the runtime file.
  const editorProject = await readFile(fileURLToPath(new URL('../../test/flax-api-smoke/BridgeCompileSmoke.csproj', import.meta.url)), 'utf8');
  assert.match(editorProject, /EnableDefaultCompileItems>false</);
  assert.doesNotMatch(editorProject, /FlaxMcpRuntimeBridge/);
});
