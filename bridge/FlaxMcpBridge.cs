// MCP-BRIDGE-VERSION: 6
// Flax 1.12 Editor-only bridge for flax-engine-mcp.
//
// Install this file in a game module, for example Source/Game/MCP/FlaxMcpBridge.cs.
// It is deliberately file-RPC only: no listener is exposed on the network.
#if FLAX_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FlaxEditor;
using FEditor = FlaxEditor.Editor;
using FlaxEngine;
using FlaxEngine.Json;
using FObject = FlaxEngine.Object;

namespace Game.MCP
{
    // Wire DTOs. Public field names are the protocol keys (see bridge/PROTOCOL.md).
    public class McpBridgeInfo { public int BridgeVersion = 6; public int ProtocolVersion = 1; public int Pid; public string Project; public string EditorVersion; public long Timestamp; }
    // Request/response intentionally use lower camel case because the Node side
    // parses exact on-disk keys. Heartbeat remains PascalCase for compatibility.
    public class McpRequest { public string id; public string token; public string method; public string paramsJson; public long deadlineUnixMs; }
    public class McpResponse { public string id; public string token; public bool ok; public string errorCode; public string error; public string resultJson; public long timestamp; }
    public class McpStatus { public int BridgeVersion = 6; public int ProtocolVersion = 1; public int Pid; public string EditorVersion; public bool IsPlayMode; public bool IsHeadless; public bool TransactionsSupported = false; public string LogSessionId; }
    public class McpSceneRef { public string Id; public string Name; public string Path; public bool Edited; }
    public class McpVector3 { public float X; public float Y; public float Z; }
    public class McpActorDto
    {
        public string Id; public string TypeName; public string Name; public bool Active; public string ParentId;
        public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles;
        public string[] ScriptIds; public McpActorDto[] Children;
    }
    public class McpScriptDto { public string Id; public string TypeName; public string ActorId; public bool Enabled; }
    public class McpDeletedDto { public string DeletedId; }
    public class McpDetachedDto { public string DetachedId; }
    public class McpDuplicatedDto { public string SourceId; public string NewActorId; public bool Verified; }
    internal sealed class McpTreeBudget { public int Count; }
    public class McpActorId { public string ActorId; }
    public class McpActorFind { public string Name; public int MaxResults = 50; }
    public class McpActorCreate { public string TypeName = "FlaxEngine.EmptyActor"; public string Name; public string ParentId; public bool Active = true; public McpVector3 Position; }
    public class McpActorCreateValidation { public string TypeName; public string ParentId; }
    public class McpActorUpdate { public string ActorId; public string Name; public bool? Active; public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles; }
    public class McpActorReparent { public string ActorId; public string ParentId; public bool KeepWorldTransform = true; }
    public class McpScriptAttach { public string ActorId; public string ScriptType; }
    public class McpScriptId { public string ScriptId; }
    public class McpScriptUpdate { public string ScriptId; public bool? Enabled; }
    public class McpSceneSave { public string SceneId; }
    public class McpCompileStart { public string OperationId; public bool GenerateProjectFirst; }
    public class McpCompileStatus
    {
        public string OperationId; public string Phase; public bool IsCompiling; public bool IsReady;
        public bool LastCompilationFailed; public int CompilationsCount; public long StartedUnixMs; public long FinishedUnixMs;
    }
    public class McpDiagnostic { public string Level; public string Message; public string File; public int Line; public int Column; public string Code; public long TimestampUnixMs; }
    public class McpDiagnosticsRequest { public string CompilationId; public string[] Severities; public string File; public int MaxResults = 100; public int Cursor; }
    public class McpDiagnostics { public string OperationId; public string Phase; public bool Current; public McpDiagnostic[] Entries; public bool Truncated; public int NextCursor; public bool HasMore; }
    public class McpPersistedCompileState { public McpCompileStatus State; public McpDiagnostic[] Diagnostics; }
    public class McpGenerateProjectState { public string OperationId; public string Phase; public bool Failed; public long StartedUnixMs; public long FinishedUnixMs; public string Error; }
    public class McpLogQuery { public long SinceSequence; public int Limit = 100; public string[] Severities; public string Category; public string PlaySessionId; public string Contains; public bool IncludeStackTrace; public bool Tail; public long AfterSequence; public int MaxEntries; public int LevelMask = 15; }
    public class McpLogEntry { public long Sequence; public long TimestampUnixMs; public string Level; public string Category; public string CompilationId; public string PlaySessionId; public string Message; public string StackTrace; }
    public class McpLogQueryResult { public string SessionId; public long NextSequence; public bool HasMore; public long DroppedCount; public McpLogEntry[] Entries; }
    public class McpPlayStart { public bool AllowCompileFailure; public bool AllowDirtyScenes; }
    public class McpPlayStatus { public string State; public string SessionId; public string Mode; public long StartedUnixMs; public long DurationMs; public ulong FrameCount; public bool HasDirtyScenes; public bool IsPlayMode; public bool IsPaused; public bool IsPlayModeRequested; public bool IsDuringBreakpointHang; }
    public class McpCaptureStart { public string Viewport; public int Width; public int Height; }
    public class McpCaptureStatusRequest { public string CaptureId; }
    public class McpCaptureStatus { public string CaptureId; public string Phase; public string Path; public long StartedUnixMs; public long CompletedUnixMs; public long SizeBytes; }
    public class McpRuntimeActorInspect { public string ActorId; public int Depth; public bool IncludeScripts = true; }
    public class McpRuntimeActorInspection { public bool IsPlayMode; public bool IsPaused; public string SceneId; public McpActorDto Actor; }

    /// <summary>
    /// File-based RPC bridge. Requests are moved atomically from requests/ into
    /// processing/, executed on Flax's main thread, and responses are atomically
    /// renamed into responses/. Only the allowlisted methods in Dispatch exist.
    /// </summary>
    public sealed class FlaxMcpBridgePlugin : EditorPlugin
    {
        private const int BridgeVersion = 6;
        private const int ProtocolVersion = 1;
        private const int MaxRequestBytes = 128 * 1024;
        private const int MaxParamsBytes = 64 * 1024;
        private const int MaxDeadlineMs = 60 * 1000;
        private const int MainThreadTimeoutMs = 60 * 1000;
        private const int MaxRequestsPerPoll = 4;
        private const int MaxTreeDepth = 64;
        private const int MaxTreeActors = 2000;
        private const int MaxResultBytes = 512 * 1024;
        private const int MaxLogEntries = 2000;
        private const int MaxLogMessageChars = 8192;
        private const int MaxDiagnostics = 200;
        private const int MaxCaptureAgeHours = 24;
        private const int MaxCaptures = 64;
        private const int CaptureCleanupIntervalMs = 60 * 1000;
        private const int MaxCompileLogReadBytes = 2 * 1024 * 1024;
        private const int StaleCompileOperationMs = 5 * 1000;

        private volatile bool _running;
        private volatile int _busy;
        private long _lastPoll;
        private long _lastHeartbeat;
        private long _lastCaptureCleanup;
        private string _token;
        private string _logSessionId;
        private readonly object _stateLock = new object();
        private readonly List<McpLogEntry> _logs = new List<McpLogEntry>(MaxLogEntries);
        private readonly List<McpDiagnostic> _diagnostics = new List<McpDiagnostic>(MaxDiagnostics);
        private long _nextLogSequence;
        private McpCompileStatus _compile = new McpCompileStatus { Phase = "idle" };
        private string _compileLogPath;
        private long _compileLogOffset;
        private McpGenerateProjectState _generate = new McpGenerateProjectState { Phase = "idle" };
        private readonly Dictionary<string, McpCaptureStatus> _captures = new Dictionary<string, McpCaptureStatus>();
        private ILogHandler _logHandler;
        private string _playState = "stopped";
        private string _playSessionId;
        private string _playMode;
        private long _playStartedUnixMs;
        private long _playEndedUnixMs;

        private static string Root { get { return Path.Combine(Globals.ProjectFolder, "Cache", "MCP"); } }
        private static string Requests { get { return Path.Combine(Root, "requests"); } }
        private static string Processing { get { return Path.Combine(Root, "processing"); } }
        private static string Responses { get { return Path.Combine(Root, "responses"); } }
        private static string BridgePath { get { return Path.Combine(Root, "bridge.json"); } }
        private static string TokenPath { get { return Path.Combine(Root, "token"); } }
        private static string CompileStatePath { get { return Path.Combine(Root, "compile-state.json"); } }
        private static string GenerateStatePath { get { return Path.Combine(Root, "generate-project-state.json"); } }
        private static string Captures { get { return Path.Combine(Root, "captures"); } }
        private static string ProjectLogs { get { return Path.Combine(Globals.ProjectFolder, "Logs"); } }

        public override void InitializeEditor()
        {
            base.InitializeEditor();
            try
            {
                Directory.CreateDirectory(Requests);
                Directory.CreateDirectory(Processing);
                Directory.CreateDirectory(Responses);
                Directory.CreateDirectory(Captures);
                CleanupOldProcessing();
                CleanupCaptures();
                RestorePersistentState();
                _token = CreateSessionToken();
                _logSessionId = Guid.NewGuid().ToString("N");
                SubscribeEvents();
                WriteToken(_token);
                WriteHeartbeat();
                _running = true;
                Scripting.Update += OnUpdate;
                Debug.Log("[Flax MCP] Bridge v6 listening at " + Root);
            }
            catch (Exception ex)
            {
                Debug.LogError("[Flax MCP] Failed to initialize: " + ex.Message);
            }
        }

        public override void DeinitializeEditor()
        {
            _running = false;
            Scripting.Update -= OnUpdate;
            UnsubscribeEvents();
            PersistCompileState();
            PersistGenerateState();
            TryDelete(BridgePath);
            TryDelete(TokenPath);
            base.DeinitializeEditor();
        }

        private void OnUpdate()
        {
            if (!_running)
                return;
            var now = Environment.TickCount64;
            if (now - _lastHeartbeat >= 2000)
            {
                _lastHeartbeat = now;
                try { WriteHeartbeat(); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Heartbeat failed: " + ex.Message); }
            }
            if (now - _lastCaptureCleanup >= CaptureCleanupIntervalMs)
            {
                _lastCaptureCleanup = now;
                CleanupCaptures();
            }
            if (now - _lastPoll < 100 || Interlocked.CompareExchange(ref _busy, 0, 0) >= MaxRequestsPerPoll)
                return;
            _lastPoll = now;
            string[] files;
            try { files = Directory.GetFiles(Requests, "*.json"); }
            catch { return; }
            Array.Sort(files, StringComparer.Ordinal);
            for (var i = 0; i < files.Length && i < MaxRequestsPerPoll; i++)
                TryPickUp(files[i]);
        }

        private void TryPickUp(string requestPath)
        {
            var name = Path.GetFileName(requestPath);
            if (!IsSafeRequestFile(name))
            {
                TryDelete(requestPath);
                return;
            }
            var processingPath = Path.Combine(Processing, name);
            try
            {
                // Same-volume move is an atomic claim: another bridge instance cannot
                // process the same request.
                File.Move(requestPath, processingPath);
                Interlocked.Increment(ref _busy);
                Task.Run(() => ProcessFile(processingPath, name));
            }
            catch (IOException) { /* raced with the client or another bridge */ }
            catch (Exception ex) { Debug.LogWarning("[Flax MCP] Request pickup failed: " + ex.Message); }
        }

        private void ProcessFile(string processingPath, string requestFileName)
        {
            McpRequest request = null;
            McpResponse response;
            try
            {
                var info = new FileInfo(processingPath);
                if (info.Length > MaxRequestBytes)
                    throw new McpProtocolException("REQUEST_TOO_LARGE", "Request exceeds 128 KiB.");
                request = JsonSerializer.Deserialize<McpRequest>(File.ReadAllText(processingPath));
                if (request == null || !string.Equals(request.id + ".json", requestFileName, StringComparison.Ordinal))
                    throw new McpProtocolException("INVALID_REQUEST", "Request id must match its request filename.");
                response = Dispatch(request);
            }
            catch (McpProtocolException ex)
            {
                response = Failure(request == null ? null : request.id, request == null ? null : request.token, ex.Code, ex.Message);
            }
            catch (Exception ex)
            {
                response = Failure(request == null ? null : request.id, request == null ? null : request.token, "INTERNAL_ERROR", ex.InnerException == null ? ex.Message : ex.InnerException.Message);
            }
            try
            {
                WriteAtomic(Path.Combine(Responses, requestFileName), JsonSerializer.Serialize(response, true));
            }
            catch (Exception ex) { Debug.LogError("[Flax MCP] Response write failed: " + ex.Message); }
            finally
            {
                TryDelete(processingPath);
                Interlocked.Decrement(ref _busy);
            }
        }

        private McpResponse Dispatch(McpRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.id) || !IsSafeRequestFile(request.id + ".json"))
                throw new McpProtocolException("INVALID_REQUEST", "Request id is invalid.");
            if (!ConstantTimeEquals(request.token, _token))
                throw new McpProtocolException("UNAUTHORIZED", "Missing or invalid bridge session token.");
            if (string.IsNullOrEmpty(request.method))
                throw new McpProtocolException("INVALID_REQUEST", "Method is required.");
            if (Encoding.UTF8.GetByteCount(request.paramsJson ?? "") > MaxParamsBytes)
                throw new McpProtocolException("REQUEST_TOO_LARGE", "paramsJson exceeds 64 KiB.");
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (request.deadlineUnixMs != 0 && (request.deadlineUnixMs < now || request.deadlineUnixMs > now + MaxDeadlineMs))
                throw new McpProtocolException("DEADLINE_EXCEEDED", "Request deadline is expired or exceeds 60 seconds.");

            object result;
            var p = request.paramsJson ?? "{}";
            switch (request.method)
            {
                case "status": result = OnMain(Status, request.deadlineUnixMs); break;
                case "scene.list_loaded": result = OnMain(ListLoadedScenes, request.deadlineUnixMs); break;
                case "scene.get_tree": result = OnMain(() => SceneTree(JsonSerializer.Deserialize<McpSceneSave>(p)), request.deadlineUnixMs); break;
                case "scene.save": result = OnMain(() => SaveScene(JsonSerializer.Deserialize<McpSceneSave>(p)), request.deadlineUnixMs); break;
                case "project.save_all": result = OnMain(SaveAll, request.deadlineUnixMs); break;
                case "actor.get": result = OnMain(() => ActorDto(RequireActor(JsonSerializer.Deserialize<McpActorId>(p).ActorId), true), request.deadlineUnixMs); break;
                case "actor.find": result = OnMain(() => FindActors(JsonSerializer.Deserialize<McpActorFind>(p)), request.deadlineUnixMs); break;
                case "actor.validate_create": result = OnMain(() => ValidateCreateActor(JsonSerializer.Deserialize<McpActorCreate>(p)), request.deadlineUnixMs); break;
                case "actor.create": result = OnMain(() => CreateActor(JsonSerializer.Deserialize<McpActorCreate>(p)), request.deadlineUnixMs); break;
                case "actor.update": result = OnMain(() => UpdateActor(JsonSerializer.Deserialize<McpActorUpdate>(p)), request.deadlineUnixMs); break;
                case "actor.delete": result = OnMain(() => DeleteActor(JsonSerializer.Deserialize<McpActorId>(p)), request.deadlineUnixMs); break;
                case "actor.duplicate": result = OnMain(() => DuplicateActor(JsonSerializer.Deserialize<McpActorId>(p)), request.deadlineUnixMs); break;
                case "actor.reparent": result = OnMain(() => ReparentActor(JsonSerializer.Deserialize<McpActorReparent>(p)), request.deadlineUnixMs); break;
                case "script.attach": result = OnMain(() => AttachScript(JsonSerializer.Deserialize<McpScriptAttach>(p)), request.deadlineUnixMs); break;
                case "script.detach": result = OnMain(() => DetachScript(JsonSerializer.Deserialize<McpScriptId>(p)), request.deadlineUnixMs); break;
                case "script.instance_get": result = OnMain(() => ScriptInfo(RequireScript(JsonSerializer.Deserialize<McpScriptId>(p).ScriptId)), request.deadlineUnixMs); break;
                case "script.instance_update": result = OnMain(() => UpdateScript(JsonSerializer.Deserialize<McpScriptUpdate>(p)), request.deadlineUnixMs); break;
                case "edit.undo": result = OnMain(Undo, request.deadlineUnixMs); break;
                case "edit.redo": result = OnMain(Redo, request.deadlineUnixMs); break;
                // Phase 2: code operations intentionally acknowledge work quickly.
                // A compile can reload this plugin, so callers poll status instead of
                // keeping a request open across the reload boundary.
                case "code.status": result = OnMain(CodeStatus, request.deadlineUnixMs); break;
                case "code.compile_start": result = OnMain(() => StartCompile(JsonSerializer.Deserialize<McpCompileStart>(p)), request.deadlineUnixMs); break;
                case "code.diagnostics": result = GetDiagnostics(JsonSerializer.Deserialize<McpDiagnosticsRequest>(p)); break;
                case "code.generate_project_start": result = OnMain(StartGenerateProject, request.deadlineUnixMs); break;
                case "code.generate_project_status": result = GetGenerateProjectStatus(); break;
                case "play.status": result = OnMain(PlayStatus, request.deadlineUnixMs); break;
                case "play.start_scenes": result = OnMain(() => StartPlayScenes(JsonSerializer.Deserialize<McpPlayStart>(p)), request.deadlineUnixMs); break;
                case "play.start_game": result = OnMain(() => StartPlayGame(JsonSerializer.Deserialize<McpPlayStart>(p)), request.deadlineUnixMs); break;
                case "play.stop": result = OnMain(StopPlay, request.deadlineUnixMs); break;
                case "play.pause": result = OnMain(PausePlay, request.deadlineUnixMs); break;
                case "play.resume": result = OnMain(ResumePlay, request.deadlineUnixMs); break;
                case "play.step": result = OnMain(StepPlay, request.deadlineUnixMs); break;
                case "log.query": result = QueryLogs(JsonSerializer.Deserialize<McpLogQuery>(p)); break;
                case "capture.start": result = OnMain(() => StartCapture(JsonSerializer.Deserialize<McpCaptureStart>(p)), request.deadlineUnixMs); break;
                case "capture.status": result = GetCaptureStatus(JsonSerializer.Deserialize<McpCaptureStatusRequest>(p)); break;
                case "runtime.inspect_actor": result = OnMain(() => InspectRuntimeActor(JsonSerializer.Deserialize<McpRuntimeActorInspect>(p)), request.deadlineUnixMs); break;
                default: throw new McpProtocolException("METHOD_NOT_ALLOWED", "Method is not in the bridge allowlist.");
            }
            var resultJson = JsonSerializer.Serialize(result, true);
            if (Encoding.UTF8.GetByteCount(resultJson) > MaxResultBytes)
                throw new McpProtocolException("RESPONSE_TOO_LARGE", "Bridge response exceeds the 512 KiB limit.");
            return new McpResponse { id = request.id, token = _token, ok = true, resultJson = resultJson, timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }

        // All methods below are invoked on the Editor update thread.
        private McpStatus Status()
        {
            return new McpStatus { Pid = Environment.ProcessId, EditorVersion = Globals.EngineVersion.ToString(), IsPlayMode = FEditor.IsPlayMode, IsHeadless = FEditor.Instance.IsHeadlessMode, LogSessionId = _logSessionId };
        }

        private McpCompileStatus CodeStatus()
        {
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                _compile.IsCompiling = ScriptsBuilder.IsCompiling;
                _compile.IsReady = ScriptsBuilder.IsReady;
                _compile.LastCompilationFailed = ScriptsBuilder.LastCompilationFailed;
                _compile.CompilationsCount = ScriptsBuilder.CompilationsCount;
                var changed = ReconcileStaleCompileLocked(now);
                if (_compile.Phase == "reloading" && !_compile.IsCompiling && _compile.IsReady)
                {
                    _compile.Phase = _compile.LastCompilationFailed ? "failed" : "succeeded";
                    if (_compile.FinishedUnixMs == 0) _compile.FinishedUnixMs = now;
                    changed = true;
                }
                if (changed) PersistCompileStateLocked();
                return CopyCompileStatus(_compile);
            }
        }

        private McpCompileStatus StartCompile(McpCompileStart request)
        {
            if (ScriptsBuilder.IsCompiling)
                throw new McpProtocolException("EDITOR_BUSY", "Scripts are already compiling or reloading.");
            var operationId = request != null ? request.OperationId : null;
            if (!string.IsNullOrEmpty(operationId) && !IsGuidN(operationId))
                throw new McpProtocolException("INVALID_REQUEST", "OperationId must be a 32-character GUID without separators.");
            if (string.IsNullOrEmpty(operationId)) operationId = Guid.NewGuid().ToString("N");
            lock (_stateLock)
            {
                _diagnostics.Clear();
                _compile = new McpCompileStatus
                {
                    OperationId = operationId, Phase = "requested", IsCompiling = false,
                    IsReady = ScriptsBuilder.IsReady, LastCompilationFailed = ScriptsBuilder.LastCompilationFailed,
                    CompilationsCount = ScriptsBuilder.CompilationsCount, StartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };
                _compileLogPath = null;
                _compileLogOffset = 0;
                PersistCompileStateLocked();
            }
            // This is an asynchronous editor request. Do not wait for CompilationEnd:
            // Flax may reload this plugin while compiling user scripts.
            ScriptsBuilder.Compile();
            return CodeStatus();
        }

        private McpDiagnostics GetDiagnostics(McpDiagnosticsRequest request)
        {
            if (request == null) request = new McpDiagnosticsRequest();
            var max = Math.Max(1, Math.Min(request.MaxResults, 100));
            var cursor = Math.Max(0, request.Cursor);
            if (request.File != null && request.File.Length > 512) throw new McpProtocolException("INVALID_REQUEST", "Diagnostics file filter is limited to 512 characters.");
            lock (_stateLock)
            {
                if (!string.IsNullOrEmpty(request.CompilationId) && !string.Equals(request.CompilationId, _compile.OperationId, StringComparison.Ordinal))
                    return new McpDiagnostics { OperationId = request.CompilationId, Phase = "not_found", Current = false, Entries = new McpDiagnostic[0] };
                var filtered = new List<McpDiagnostic>();
                foreach (var entry in _diagnostics)
                {
                    if (!MatchesSeverity(entry.Level, request.Severities)) continue;
                    if (!string.IsNullOrEmpty(request.File) && (entry.File == null || entry.File.IndexOf(request.File, StringComparison.OrdinalIgnoreCase) < 0)) continue;
                    filtered.Add(CopyDiagnostic(entry));
                }
                var page = new List<McpDiagnostic>(max);
                for (var i = cursor; i < filtered.Count && page.Count < max; i++) page.Add(filtered[i]);
                var next = cursor + page.Count;
                return new McpDiagnostics { OperationId = _compile.OperationId, Phase = _compile.Phase, Current = true, Entries = page.ToArray(), Truncated = filtered.Count >= MaxDiagnostics, NextCursor = next, HasMore = next < filtered.Count };
            }
        }

        private McpGenerateProjectState StartGenerateProject()
        {
            string operationId;
            lock (_stateLock)
            {
                if (_generate.Phase == "running")
                    throw new McpProtocolException("EDITOR_BUSY", "Project-file generation is already running.");
                _generate = new McpGenerateProjectState { OperationId = Guid.NewGuid().ToString("N"), Phase = "running", StartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                operationId = _generate.OperationId;
                PersistGenerateStateLocked();
            }
            // GenerateProject is an editor/build API and must remain on the main
            // thread. Queue it to a later update so this RPC only acknowledges the
            // operation; polling observes the persisted terminal state afterwards.
            Scripting.InvokeOnUpdate(() => RunGenerateProject(operationId));
            return GetGenerateProjectStatus();
        }

        private void RunGenerateProject(string operationId)
        {
            try
            {
                lock (_stateLock)
                {
                    // The operation may have been superseded while this callback was
                    // waiting in the editor queue.
                    if (!_running || !string.Equals(_generate.OperationId, operationId, StringComparison.Ordinal) || _generate.Phase != "running") return;
                }
                var failed = ScriptsBuilder.GenerateProject();
                lock (_stateLock)
                {
                    if (!string.Equals(_generate.OperationId, operationId, StringComparison.Ordinal)) return;
                    _generate.Failed = failed;
                    _generate.Phase = failed ? "failed" : "succeeded";
                    _generate.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    PersistGenerateStateLocked();
                }
            }
            catch (Exception ex)
            {
                lock (_stateLock)
                {
                    if (!string.Equals(_generate.OperationId, operationId, StringComparison.Ordinal)) return;
                    _generate.Failed = true; _generate.Phase = "failed";
                    _generate.Error = LimitForLog(ex.Message, 1024);
                    _generate.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    PersistGenerateStateLocked();
                }
            }
        }

        private McpGenerateProjectState GetGenerateProjectStatus()
        {
            lock (_stateLock) return CopyGenerateState(_generate);
        }

        private McpPlayStatus PlayStatus()
        {
            var editor = FEditor.Instance;
            lock (_stateLock)
            {
                ResolvePlayStateLocked(editor);
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var end = _playEndedUnixMs == 0 ? now : _playEndedUnixMs;
                return new McpPlayStatus
                {
                    State = _playState, SessionId = _playSessionId, Mode = _playMode, StartedUnixMs = _playStartedUnixMs,
                    DurationMs = _playStartedUnixMs == 0 ? 0 : Math.Max(0, end - _playStartedUnixMs), FrameCount = Engine.FrameCount, HasDirtyScenes = editor.Scene.IsEdited(),
                    IsPlayMode = editor.StateMachine.IsPlayMode, IsPaused = editor.StateMachine.IsPlayMode && editor.StateMachine.PlayingState.IsPaused,
                    IsPlayModeRequested = editor.Simulation.IsPlayModeRequested, IsDuringBreakpointHang = editor.Simulation.IsDuringBreakpointHang,
                };
            }
        }

        private McpPlayStatus StartPlayScenes(McpPlayStart request)
        {
            PreparePlayStart(request, "scenes");
            FEditor.Instance.Simulation.RequestStartPlayScenes();
            return PlayStatus();
        }

        private McpPlayStatus StartPlayGame(McpPlayStart request)
        {
            PreparePlayStart(request, "game");
            FEditor.Instance.Simulation.RequestStartPlayGame();
            return PlayStatus();
        }

        private McpPlayStatus StopPlay()
        {
            if (FEditor.Instance.StateMachine.IsPlayMode)
            {
                lock (_stateLock) _playState = "stopping";
                FEditor.Instance.Simulation.RequestStopPlay();
            }
            return PlayStatus();
        }

        private McpPlayStatus PausePlay()
        {
            if (!FEditor.Instance.StateMachine.IsPlayMode || FEditor.Instance.StateMachine.PlayingState.IsPaused) throw new McpProtocolException("INVALID_STATE", "Editor must be running to pause.");
            FEditor.Instance.Simulation.RequestPausePlay();
            return PlayStatus();
        }

        private McpPlayStatus ResumePlay()
        {
            if (!FEditor.Instance.StateMachine.IsPlayMode || !FEditor.Instance.StateMachine.PlayingState.IsPaused) throw new McpProtocolException("INVALID_STATE", "Editor must be paused to resume.");
            FEditor.Instance.Simulation.RequestResumePlay();
            return PlayStatus();
        }

        private McpPlayStatus StepPlay()
        {
            if (!FEditor.Instance.StateMachine.IsPlayMode || !FEditor.Instance.StateMachine.PlayingState.IsPaused) throw new McpProtocolException("INVALID_STATE", "Editor must be paused to step one frame.");
            FEditor.Instance.Simulation.RequestPlayOneFrame();
            return PlayStatus();
        }

        private void PreparePlayStart(McpPlayStart request, string mode)
        {
            if (request == null) request = new McpPlayStart();
            var editor = FEditor.Instance;
            if (editor.IsHeadlessMode) throw new McpProtocolException("INVALID_STATE", "Flax 1.12 headless play is unavailable because the editor cannot guarantee play cleanup.");
            if (!editor.StateMachine.IsEditMode) throw new McpProtocolException("INVALID_STATE", "Play can only start from edit mode.");
            if (ScriptsBuilder.IsCompiling) throw new McpProtocolException("EDITOR_BUSY", "Cannot start play while scripts are compiling or reloading.");
            if (ScriptsBuilder.LastCompilationFailed && !request.AllowCompileFailure) throw new McpProtocolException("VALIDATION_FAILED", "Last script compilation failed. Pass allowCompileFailure:true to explicitly override.");
            if (editor.Scene.IsEdited() && !request.AllowDirtyScenes) throw new McpProtocolException("VALIDATION_FAILED", "Edited scenes must be saved or allowDirtyScenes:true must be explicit before starting play.");
            lock (_stateLock)
            {
                _playSessionId = Guid.NewGuid().ToString("N");
                _playMode = mode;
                _playStartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                _playEndedUnixMs = 0;
                _playState = "starting";
            }
        }

        private void ResolvePlayStateLocked(FEditor editor)
        {
            if (editor.StateMachine.IsPlayMode)
            {
                if (string.IsNullOrEmpty(_playSessionId)) _playSessionId = Guid.NewGuid().ToString("N");
                if (string.IsNullOrEmpty(_playMode)) _playMode = "external";
                _playState = editor.StateMachine.PlayingState.IsPaused || editor.Simulation.IsDuringBreakpointHang ? "paused" : "running";
                if (_playStartedUnixMs == 0) _playStartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return;
            }
            if (editor.Simulation.IsPlayModeRequested) { _playState = "starting"; return; }
            if (_playState == "starting" || _playState == "stopping")
            {
                _playState = "stopped";
                if (_playStartedUnixMs != 0 && _playEndedUnixMs == 0) _playEndedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }

        private McpLogQueryResult QueryLogs(McpLogQuery query)
        {
            if (query == null) query = new McpLogQuery();
            var max = Math.Max(1, Math.Min(query.Limit > 0 ? query.Limit : query.MaxEntries, 200));
            var since = query.SinceSequence > 0 ? query.SinceSequence : query.AfterSequence;
            var needle = query.Contains ?? "";
            if (needle.Length > 256) throw new McpProtocolException("INVALID_REQUEST", "Log query contains is limited to 256 characters.");
            if (query.Category != null && query.Category.Length > 32) throw new McpProtocolException("INVALID_REQUEST", "Log category is limited to 32 characters.");
            if (query.PlaySessionId != null && !IsGuidN(query.PlaySessionId)) throw new McpProtocolException("INVALID_REQUEST", "playSessionId must be a 32-character GUID.");
            lock (_stateLock)
            {
                var first = _logs.Count == 0 ? _nextLogSequence : _logs[0].Sequence;
                var list = new List<McpLogEntry>(max);
                var hasMore = false;
                foreach (var entry in _logs)
                {
                    if (entry.Sequence <= since || !MatchesSeverity(entry.Level, query.Severities) || (((int)ParseLogLevel(entry.Level)) & query.LevelMask) == 0) continue;
                    if (!string.IsNullOrEmpty(query.Category) && !string.Equals(entry.Category, query.Category, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!string.IsNullOrEmpty(query.PlaySessionId) && !string.Equals(entry.PlaySessionId, query.PlaySessionId, StringComparison.Ordinal)) continue;
                    if (needle.Length > 0 && entry.Message.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (!query.Tail && list.Count == max) { hasMore = true; break; }
                    if (query.Tail && list.Count == max) list.RemoveAt(0);
                    var copy = CopyLogEntry(entry);
                    if (!query.IncludeStackTrace) copy.StackTrace = null;
                    list.Add(copy);
                }
                var next = list.Count == 0 ? since : list[list.Count - 1].Sequence;
                var dropped = since > 0 && since < first - 1 ? first - since - 1 : 0;
                return new McpLogQueryResult { SessionId = _logSessionId, NextSequence = next, HasMore = hasMore, DroppedCount = dropped, Entries = list.ToArray() };
            }
        }

        private McpCaptureStatus StartCapture(McpCaptureStart request)
        {
            if (request == null) request = new McpCaptureStart();
            if (FEditor.Instance.IsHeadlessMode) throw new McpProtocolException("INVALID_STATE", "Viewport capture is unavailable in headless editor mode.");
            if (!FEditor.IsPlayMode) throw new McpProtocolException("INVALID_STATE", "Viewport capture requires play mode.");
            if (!string.IsNullOrEmpty(request.Viewport) && !string.Equals(request.Viewport, "main", StringComparison.OrdinalIgnoreCase) && !string.Equals(request.Viewport, "game", StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("VALIDATION_FAILED", "Only the main game viewport is supported for capture.");
            if (request.Width != 0 || request.Height != 0)
                throw new McpProtocolException("VALIDATION_FAILED", "Custom capture dimensions are not supported by Flax 1.12 main-render capture.");
            // Keep both the bridge-session status map and the cache directory bounded
            // before allocating a new GPU readback target.
            CleanupCaptures(MaxCaptures - 1);
            var id = Guid.NewGuid().ToString("N");
            var path = Path.Combine(Captures, id + ".png");
            var item = new McpCaptureStatus { CaptureId = id, Phase = "Pending", Path = "Cache/MCP/captures/" + id + ".png", StartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            lock (_stateLock) _captures[id] = item;
            // Flax may finish GPU readback one or more frames later. The status call
            // observes the fixed, bridge-owned file instead of blocking this callback.
            Screenshot.Capture(path);
            CleanupCaptures();
            return CopyCaptureStatus(item);
        }

        private McpCaptureStatus GetCaptureStatus(McpCaptureStatusRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.CaptureId) || !IsGuidN(request.CaptureId)) throw new McpProtocolException("INVALID_REQUEST", "captureId must be a 32-character GUID.");
            McpCaptureStatus item;
            lock (_stateLock)
            {
                if (!_captures.TryGetValue(request.CaptureId, out item)) throw new McpProtocolException("NOT_FOUND", "Capture was not started in this bridge session.");
                var physicalPath = Path.Combine(Captures, item.CaptureId + ".png");
                if (item.Phase == "Pending" && File.Exists(physicalPath))
                {
                    var info = new FileInfo(physicalPath);
                    if (info.Length > 0) { item.Phase = "Completed"; item.SizeBytes = info.Length; item.CompletedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
                }
                return CopyCaptureStatus(item);
            }
        }

        private static McpRuntimeActorInspection InspectRuntimeActor(McpRuntimeActorInspect p)
        {
            if (!FEditor.IsPlayMode) throw new McpProtocolException("INVALID_STATE", "Runtime actor inspection requires play mode.");
            if (p == null || p.Depth < 0 || p.Depth > 4) throw new McpProtocolException("VALIDATION_FAILED", "Runtime actor depth must be between 0 and 4.");
            var actor = RequireActor(p.ActorId);
            return new McpRuntimeActorInspection
            {
                IsPlayMode = true, IsPaused = FEditor.Instance.StateMachine.PlayingState.IsPaused,
                SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"), Actor = RuntimeActorDto(actor, p.Depth, p.IncludeScripts),
            };
        }

        private static McpSceneRef[] ListLoadedScenes()
        {
            var items = new List<McpSceneRef>();
            for (var i = 0; i < Level.ScenesCount; i++)
            {
                var scene = Level.GetScene(i);
                if (scene != null) items.Add(SceneRef(scene));
            }
            return items.ToArray();
        }

        private static object SceneTree(McpSceneSave p)
        {
            var scene = RequireScene(p == null ? null : p.SceneId);
            return ActorDto(scene, true);
        }

        private static McpSceneRef SaveScene(McpSceneSave p)
        {
            var scene = RequireScene(p == null ? null : p.SceneId);
            FEditor.Instance.Scene.SaveScene(scene);
            return SceneRef(scene);
        }

        private static string SaveAll() { FEditor.Instance.SaveAll(); return "save requested"; }
        private static string Undo() { FEditor.Instance.PerformUndo(); return "undo requested"; }
        private static string Redo() { FEditor.Instance.PerformRedo(); return "redo requested"; }

        private static McpActorDto[] FindActors(McpActorFind p)
        {
            if (p == null || string.IsNullOrWhiteSpace(p.Name)) throw new McpProtocolException("INVALID_REQUEST", "name is required.");
            var max = Math.Max(1, Math.Min(p.MaxResults, 100));
            var all = Level.GetActors(typeof(Actor), false);
            var result = new List<McpActorDto>();
            foreach (var actor in all)
            {
                if (actor != null && actor.Name.IndexOf(p.Name, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    result.Add(ActorDto(actor, false));
                    if (result.Count == max) break;
                }
            }
            return result.ToArray();
        }

        private static McpActorDto CreateActor(McpActorCreate p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor creation parameters are required.");
            var type = ResolveType(p.TypeName, typeof(Actor));
            var actor = FObject.New(type) as Actor;
            if (actor == null) throw new McpProtocolException("VALIDATION_FAILED", "Type did not create an Actor.");
            actor.Name = Limit(p.Name, 128, "Actor");
            actor.IsActive = p.Active;
            if (p.Position != null) actor.Position = ToFloat3(p.Position);
            var parent = string.IsNullOrEmpty(p.ParentId) ? null : RequireActor(p.ParentId);
            FEditor.Instance.SceneEditing.Spawn(actor, parent, -1, false);
            MarkEdited(actor);
            return ActorDto(actor, false);
        }

        private static McpActorCreateValidation ValidateCreateActor(McpActorCreate p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor creation parameters are required.");
            var type = ResolveType(p.TypeName, typeof(Actor));
            Limit(p.Name, 128, "Actor");
            var parent = string.IsNullOrEmpty(p.ParentId) ? null : RequireActor(p.ParentId);
            return new McpActorCreateValidation { TypeName = type.FullName, ParentId = parent == null ? null : parent.ID.ToString("N") };
        }

        private static McpActorDto UpdateActor(McpActorUpdate p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor update parameters are required.");
            var actor = RequireActor(p.ActorId);
            FEditor.Instance.Undo.RecordAction(actor, "Update actor", () =>
            {
                // This is intentionally a narrow allowlist: no arbitrary reflected properties.
                if (p.Name != null) actor.Name = Limit(p.Name, 128, "");
                if (p.Active.HasValue) actor.IsActive = p.Active.Value;
                if (p.Position != null) actor.Position = ToFloat3(p.Position);
                if (p.Scale != null) actor.Scale = ToFloat3(p.Scale);
                if (p.EulerAngles != null) actor.EulerAngles = ToFloat3(p.EulerAngles);
                MarkEdited(actor);
            });
            return ActorDto(actor, false);
        }

        private static object DeleteActor(McpActorId p)
        {
            var actor = RequireActor(p == null ? null : p.ActorId);
            FEditor.Instance.SceneEditing.Deselect();
            FEditor.Instance.SceneEditing.Select(actor);
            FEditor.Instance.SceneEditing.Delete(); // Editor API records undo/redo.
            return new McpDeletedDto { DeletedId = actor.ID.ToString("N") };
        }

        private static object DuplicateActor(McpActorId p)
        {
            var actor = RequireActor(p == null ? null : p.ActorId);
            FEditor.Instance.SceneEditing.Deselect();
            FEditor.Instance.SceneEditing.Select(actor);
            FEditor.Instance.SceneEditing.Duplicate(); // Public API is undoable but returns no new Actor ID.
            return new McpDuplicatedDto { SourceId = actor.ID.ToString("N"), NewActorId = null, Verified = false };
        }

        private static McpActorDto ReparentActor(McpActorReparent p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor reparent parameters are required.");
            var actor = RequireActor(p.ActorId);
            var parent = string.IsNullOrEmpty(p.ParentId) ? null : RequireActor(p.ParentId);
            if (parent == actor) throw new McpProtocolException("VALIDATION_FAILED", "An actor cannot parent itself.");
            FEditor.Instance.Undo.RecordAction(actor, "Reparent actor", () =>
            {
                actor.SetParent(parent, p.KeepWorldTransform, true);
                MarkEdited(actor);
            });
            return ActorDto(actor, false);
        }

        // Script fields are intentionally limited to Enabled. Arbitrary C# member
        // editing is not safe or stable across reloads, so it is not exposed.
        private static object AttachScript(McpScriptAttach p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Script attach parameters are required.");
            var actor = RequireActor(p.ActorId);
            var type = ResolveType(p.ScriptType, typeof(Script));
            var script = actor.AddScript(type);
            if (script == null) throw new McpProtocolException("VALIDATION_FAILED", "Failed to attach script.");
            FEditor.Instance.Undo.AddAction(CreateInternalScriptAction("Added", script));
            MarkEdited(actor);
            return ScriptInfo(script);
        }

        private static object DetachScript(McpScriptId p)
        {
            var script = RequireScript(p == null ? null : p.ScriptId);
            var id = script.ID.ToString("N");
            var actor = script.Actor;
            var action = CreateInternalScriptAction("Remove", script);
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            if (actor != null) MarkEdited(actor);
            return new McpDetachedDto { DetachedId = id };
        }

        private static McpScriptDto ScriptInfo(Script script)
        {
            return new McpScriptDto
            {
                Id = script.ID.ToString("N"),
                TypeName = script.TypeName,
                ActorId = script.Actor == null ? null : script.Actor.ID.ToString("N"),
                Enabled = script.Enabled,
            };
        }

        private static object UpdateScript(McpScriptUpdate p)
        {
            if (p == null || !p.Enabled.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Only the enabled field may be updated.");
            var script = RequireScript(p.ScriptId);
            var actor = script.Actor;
            var action = new McpScriptEnabledUndo(script, script.Enabled, p.Enabled.Value);
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            if (actor != null) MarkEdited(actor);
            return ScriptInfo(script);
        }

        private static McpActorDto ActorDto(Actor actor, bool recursive)
        {
            return ActorDto(actor, recursive, 0, new McpTreeBudget());
        }

        private static McpActorDto RuntimeActorDto(Actor actor, int requestedDepth, bool includeScripts)
        {
            return RuntimeActorDto(actor, 0, requestedDepth, includeScripts, new McpTreeBudget());
        }

        private static McpActorDto RuntimeActorDto(Actor actor, int depth, int requestedDepth, bool includeScripts, McpTreeBudget budget)
        {
            budget.Count++;
            if (budget.Count > MaxTreeActors) throw new McpProtocolException("RESPONSE_TOO_LARGE", "Runtime actor inspection exceeds the 2000 actor response limit.");
            var scripts = includeScripts ? new List<string>() : null;
            if (includeScripts) for (var i = 0; i < actor.ScriptsCount; i++) scripts.Add(actor.GetScript(i).ID.ToString("N"));
            var dto = new McpActorDto
            {
                Id = actor.ID.ToString("N"), TypeName = actor.TypeName, Name = actor.Name, Active = actor.IsActive,
                ParentId = actor.Parent == null ? null : actor.Parent.ID.ToString("N"), Position = FromFloat3(actor.Position),
                Scale = FromFloat3(actor.Scale), EulerAngles = FromFloat3(actor.EulerAngles), ScriptIds = includeScripts ? scripts.ToArray() : null,
            };
            if (depth < requestedDepth)
            {
                var children = new List<McpActorDto>();
                for (var i = 0; i < actor.ChildrenCount; i++) children.Add(RuntimeActorDto(actor.GetChild(i), depth + 1, requestedDepth, includeScripts, budget));
                dto.Children = children.ToArray();
            }
            return dto;
        }

        private static McpActorDto ActorDto(Actor actor, bool recursive, int depth, McpTreeBudget budget)
        {
            budget.Count++;
            if (budget.Count > MaxTreeActors)
                throw new McpProtocolException("RESPONSE_TOO_LARGE", "Actor tree exceeds the 2000 actor response limit.");
            var scripts = new List<string>();
            for (var i = 0; i < actor.ScriptsCount; i++) scripts.Add(actor.GetScript(i).ID.ToString("N"));
            var dto = new McpActorDto
            {
                Id = actor.ID.ToString("N"), TypeName = actor.TypeName, Name = actor.Name, Active = actor.IsActive,
                ParentId = actor.Parent == null ? null : actor.Parent.ID.ToString("N"), Position = FromFloat3(actor.Position),
                Scale = FromFloat3(actor.Scale), EulerAngles = FromFloat3(actor.EulerAngles), ScriptIds = scripts.ToArray(),
            };
            if (recursive)
            {
                if (depth >= MaxTreeDepth && actor.ChildrenCount > 0)
                    throw new McpProtocolException("RESPONSE_TOO_LARGE", "Actor tree exceeds the 64 level depth limit.");
                var children = new List<McpActorDto>();
                for (var i = 0; i < actor.ChildrenCount; i++) children.Add(ActorDto(actor.GetChild(i), true, depth + 1, budget));
                dto.Children = children.ToArray();
            }
            return dto;
        }

        private static McpSceneRef SceneRef(Scene scene) { return new McpSceneRef { Id = scene.ID.ToString("N"), Name = scene.Name, Path = ProjectRelativePath(scene.Path), Edited = FEditor.Instance.Scene.IsEdited(scene) }; }
        private static string ProjectRelativePath(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            var root = Path.GetFullPath(Globals.ProjectFolder);
            var full = Path.GetFullPath(value);
            var relative = Path.GetRelativePath(root, full).Replace('\\', '/');
            return relative == ".." || relative.StartsWith("../", StringComparison.Ordinal) ? null : relative;
        }
        private static void MarkEdited(Actor actor) { if (actor != null && actor.Scene != null) FEditor.Instance.Scene.MarkSceneEdited(actor.Scene); }
        private static Scene RequireScene(string id) { Guid guid; if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "sceneId must be a 32-character GUID."); var scene = Level.FindScene(guid); if (scene == null) throw new McpProtocolException("NOT_FOUND", "Loaded scene was not found."); return scene; }
        private static Actor RequireActor(string id) { Guid guid; if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "actorId must be a 32-character GUID."); var actor = Level.FindActor(guid); if (actor == null) throw new McpProtocolException("NOT_FOUND", "Actor was not found."); return actor; }
        private static Script RequireScript(string id) { Guid guid; if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "scriptId must be a 32-character GUID."); var script = FObject.TryFind<Script>(ref guid); if (script == null) throw new McpProtocolException("NOT_FOUND", "Script was not found."); return script; }
        private static McpVector3 FromFloat3(Float3 v) { return new McpVector3 { X = v.X, Y = v.Y, Z = v.Z }; }
        private static Float3 ToFloat3(McpVector3 v) { return new Float3(v.X, v.Y, v.Z); }
        private static string Limit(string value, int max, string fallback) { value = value ?? fallback; if (value.Length > max) throw new McpProtocolException("VALIDATION_FAILED", "String exceeds " + max + " characters."); return value; }

        private static Type ResolveType(string typeName, Type requiredBase)
        {
            if (string.IsNullOrEmpty(typeName) || typeName.Length > 256) throw new McpProtocolException("VALIDATION_FAILED", "Type name is invalid.");
            Type type = null;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) { type = assembly.GetType(typeName, false); if (type != null) break; }
            if (type == null || !requiredBase.IsAssignableFrom(type)) throw new McpProtocolException("VALIDATION_FAILED", "Type is not an allowed " + requiredBase.Name + ".");
            return type;
        }

        private static IUndoAction CreateInternalScriptAction(string methodName, Script script)
        {
            // Flax 1.12 exposes AddRemoveScript in its editor assembly but keeps
            // the containing type internal. Invoke the documented public factory
            // method so script identity/state are preserved across undo/redo.
            var type = typeof(IUndoAction).Assembly.GetType("FlaxEditor.Actions.AddRemoveScript", false);
            var method = type == null ? null : type.GetMethod(methodName, BindingFlags.Static | BindingFlags.Public, null, new[] { typeof(Script) }, null);
            var action = method == null ? null : method.Invoke(null, new object[] { script }) as IUndoAction;
            if (action == null) throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "This Flax version does not expose compatible script undo actions.");
            return action;
        }

        private static T OnMain<T>(Func<T> fn, long deadlineUnixMs)
        {
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            Scripting.InvokeOnUpdate(() =>
            {
                try
                {
                    if (deadlineUnixMs != 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > deadlineUnixMs)
                        throw new McpProtocolException("DEADLINE_EXCEEDED", "Request expired before editor execution.");
                    tcs.TrySetResult(fn());
                }
                catch (Exception ex) { tcs.TrySetException(ex); }
            });
            var waitMs = MainThreadTimeoutMs;
            if (deadlineUnixMs != 0)
                waitMs = (int)Math.Max(1, Math.Min(waitMs, deadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            // Task.Wait throws AggregateException when the editor callback fails,
            // which would erase a stable McpProtocolException code.
            if (!((IAsyncResult)tcs.Task).AsyncWaitHandle.WaitOne(waitMs))
                throw new McpProtocolException("DEADLINE_EXCEEDED", "Editor main-thread call timed out.");
            // Preserve McpProtocolException so the wire keeps its stable error code
            // instead of wrapping it in AggregateException/INTERNAL_ERROR.
            return tcs.Task.GetAwaiter().GetResult();
        }

        private void SubscribeEvents()
        {
            ScriptsBuilder.CompilationBegin += OnCompilationBegin;
            ScriptsBuilder.CompilationStarted += OnCompilationStarted;
            ScriptsBuilder.CompilationEnd += OnCompilationEnd;
            ScriptsBuilder.ScriptsReloadBegin += OnScriptsReloadBegin;
            ScriptsBuilder.ScriptsReloadEnd += OnScriptsReloadEnd;
            FEditor.Instance.PlayModeBeginning += OnPlayModeBeginning;
            FEditor.Instance.PlayModeBegin += OnPlayModeBegin;
            FEditor.Instance.PlayModeEnding += OnPlayModeEnding;
            FEditor.Instance.PlayModeEnd += OnPlayModeEnd;
            FEditor.Instance.Simulation.BreakpointHangBegin += OnBreakpointHangBegin;
            FEditor.Instance.Simulation.BreakpointHangEnd += OnBreakpointHangEnd;
            _logHandler = Debug.Logger == null ? null : Debug.Logger.LogHandler;
            if (_logHandler != null)
            {
                _logHandler.SendLog += OnSendLog;
                _logHandler.SendExceptionLog += OnSendExceptionLog;
            }
        }

        private void UnsubscribeEvents()
        {
            ScriptsBuilder.CompilationBegin -= OnCompilationBegin;
            ScriptsBuilder.CompilationStarted -= OnCompilationStarted;
            ScriptsBuilder.CompilationEnd -= OnCompilationEnd;
            ScriptsBuilder.ScriptsReloadBegin -= OnScriptsReloadBegin;
            ScriptsBuilder.ScriptsReloadEnd -= OnScriptsReloadEnd;
            if (FEditor.Instance != null)
            {
                FEditor.Instance.PlayModeBeginning -= OnPlayModeBeginning;
                FEditor.Instance.PlayModeBegin -= OnPlayModeBegin;
                FEditor.Instance.PlayModeEnding -= OnPlayModeEnding;
                FEditor.Instance.PlayModeEnd -= OnPlayModeEnd;
                FEditor.Instance.Simulation.BreakpointHangBegin -= OnBreakpointHangBegin;
                FEditor.Instance.Simulation.BreakpointHangEnd -= OnBreakpointHangEnd;
            }
            if (_logHandler != null)
            {
                _logHandler.SendLog -= OnSendLog;
                _logHandler.SendExceptionLog -= OnSendExceptionLog;
                _logHandler = null;
            }
        }

        private void OnCompilationBegin()
        {
            lock (_stateLock)
            {
                if (_compile.Phase != "compiling") CaptureCompileLogCursorLocked();
                if (string.IsNullOrEmpty(_compile.OperationId)) _compile.OperationId = Guid.NewGuid().ToString("N");
                _compile.Phase = "compiling";
                if (_compile.StartedUnixMs == 0) _compile.StartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PersistCompileStateLocked();
            }
        }

        private void OnCompilationStarted() { OnCompilationBegin(); }

        private void OnCompilationEnd(bool success)
        {
            lock (_stateLock)
            {
                // Flax.Build may bypass Debug.Logger.LogHandler entirely. Read only
                // the new tail of the newest project log while this operation is still
                // marked compiling, so parsed diagnostics are persisted atomically with
                // its terminal state.
                CaptureCompileLogDiagnosticsLocked();
                _compile.Phase = success ? "succeeded" : "failed";
                _compile.IsCompiling = false;
                _compile.LastCompilationFailed = !success;
                _compile.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                PersistCompileStateLocked();
            }
        }

        private void OnScriptsReloadBegin()
        {
            lock (_stateLock) { _compile.Phase = "reloading"; PersistCompileStateLocked(); }
        }

        private void OnScriptsReloadEnd()
        {
            lock (_stateLock)
            {
                if (_compile.Phase == "reloading") _compile.Phase = _compile.LastCompilationFailed ? "failed" : "succeeded";
                PersistCompileStateLocked();
            }
        }

        private void OnPlayModeBeginning() { lock (_stateLock) { if (string.IsNullOrEmpty(_playSessionId)) _playSessionId = Guid.NewGuid().ToString("N"); if (string.IsNullOrEmpty(_playMode)) _playMode = "external"; if (_playStartedUnixMs == 0) _playStartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); _playState = "starting"; } }
        private void OnPlayModeBegin() { lock (_stateLock) { _playState = "running"; _playEndedUnixMs = 0; } }
        private void OnPlayModeEnding() { lock (_stateLock) _playState = "stopping"; }
        private void OnPlayModeEnd() { lock (_stateLock) { _playState = "stopped"; _playEndedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); } }
        private void OnBreakpointHangBegin() { lock (_stateLock) { if (_playState == "running") _playState = "paused"; } }
        private void OnBreakpointHangEnd() { lock (_stateLock) { if (FEditor.IsPlayMode && !FEditor.Instance.StateMachine.PlayingState.IsPaused) _playState = "running"; } }

        private void OnSendLog(LogType level, string message, FlaxEngine.Object context, string stackTrace)
        {
            AddLog(level, message, stackTrace);
        }

        private void OnSendExceptionLog(Exception exception, FlaxEngine.Object context)
        {
            AddLog(LogType.Error, exception == null ? "Unknown exception" : exception.Message, exception == null ? null : exception.StackTrace);
        }

        private void AddLog(LogType level, string message, string stackTrace)
        {
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (_stateLock)
            {
                var entry = new McpLogEntry
                {
                    Sequence = ++_nextLogSequence, TimestampUnixMs = timestamp, Level = level.ToString(),
                    Category = ActiveLogCategory(), CompilationId = IsCompileLogCategory() ? _compile.OperationId : null,
                    PlaySessionId = IsPlayLogCategory() ? _playSessionId : null,
                    Message = LimitForLog(RedactLogText(message), MaxLogMessageChars), StackTrace = LimitForLog(RedactLogText(stackTrace), MaxLogMessageChars),
                };
                _logs.Add(entry);
                if (_logs.Count > MaxLogEntries) _logs.RemoveAt(0);
                // Roslyn diagnostics are emitted by Flax as LogType.Info on some
                // editor paths. Admit only the structured location form at that level
                // so ordinary informational output never becomes a diagnostic.
                var structuredDiagnostic = IsStructuredCompilerDiagnostic(entry.Message);
                if ((_compile.Phase == "requested" || _compile.Phase == "compiling" || _compile.Phase == "reloading") && (structuredDiagnostic || level == LogType.Warning || level == LogType.Error || level == LogType.Fatal))
                    AddDiagnosticLocked(level, entry.Message, timestamp);
            }
        }

        private void AddDiagnosticLocked(LogType level, string message, long timestamp)
        {
            var diagnostic = new McpDiagnostic { Level = level.ToString(), Message = message, TimestampUnixMs = timestamp };
            ParseDiagnosticMessage(message, diagnostic);
            foreach (var existing in _diagnostics)
            {
                if (string.Equals(existing.Level, diagnostic.Level, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(existing.Message, diagnostic.Message, StringComparison.Ordinal)
                    && string.Equals(existing.File, diagnostic.File, StringComparison.OrdinalIgnoreCase)
                    && existing.Line == diagnostic.Line && existing.Column == diagnostic.Column
                    && string.Equals(existing.Code, diagnostic.Code, StringComparison.OrdinalIgnoreCase)) return;
            }
            if (_diagnostics.Count >= MaxDiagnostics) { _diagnostics.RemoveAt(0); }
            _diagnostics.Add(diagnostic);
            PersistCompileStateLocked();
        }

        private static bool IsStructuredCompilerDiagnostic(string message)
        {
            if (string.IsNullOrEmpty(message)) return false;
            var close = message.IndexOf("): ", StringComparison.Ordinal);
            if (close <= 1) return false;
            var open = message.LastIndexOf('(', close);
            if (open <= 0 || open + 1 >= close || !char.IsDigit(message[open + 1])) return false;
            var suffix = message.Substring(close + 3);
            return suffix.StartsWith("error ", StringComparison.OrdinalIgnoreCase) || suffix.StartsWith("warning ", StringComparison.OrdinalIgnoreCase);
        }

        private void CaptureCompileLogCursorLocked()
        {
            var newest = FindNewestProjectLog();
            _compileLogPath = newest == null ? null : newest.FullName;
            _compileLogOffset = newest == null ? 0 : newest.Length;
        }

        private void CaptureCompileLogDiagnosticsLocked()
        {
            var newest = FindNewestProjectLog();
            if (newest == null) return;
            var start = string.Equals(_compileLogPath, newest.FullName, StringComparison.OrdinalIgnoreCase) && newest.Length >= _compileLogOffset
                ? _compileLogOffset
                : Math.Max(0, newest.Length - MaxCompileLogReadBytes);
            _compileLogPath = newest.FullName;
            try
            {
                byte[] bytes;
                using (var stream = new FileStream(newest.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    var length = stream.Length;
                    if (length < start) start = Math.Max(0, length - MaxCompileLogReadBytes);
                    var count = (int)Math.Min(MaxCompileLogReadBytes, Math.Max(0, length - start));
                    _compileLogOffset = length;
                    if (count == 0) return;
                    bytes = new byte[count];
                    stream.Seek(start, SeekOrigin.Begin);
                    var read = 0;
                    while (read < bytes.Length)
                    {
                        var chunk = stream.Read(bytes, read, bytes.Length - read);
                        if (chunk <= 0) break;
                        read += chunk;
                    }
                    if (read != bytes.Length) Array.Resize(ref bytes, read);
                }
                var text = DecodeCompileLogBytes(bytes);
                var lines = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                foreach (var raw in lines)
                {
                    var line = NormalizeCompilerDiagnosticLine(raw.Trim());
                    if (IsStructuredCompilerDiagnostic(line)) AddDiagnosticLocked(LogType.Info, line, timestamp);
                }
            }
            catch { /* compiler logs are best-effort and must not disrupt compilation */ }
        }

        private static FileInfo FindNewestProjectLog()
        {
            try
            {
                if (!Directory.Exists(ProjectLogs)) return null;
                FileInfo newest = null;
                foreach (var file in Directory.GetFiles(ProjectLogs, "*.txt"))
                {
                    var info = new FileInfo(file);
                    if (newest == null || info.LastWriteTimeUtc > newest.LastWriteTimeUtc) newest = info;
                }
                return newest;
            }
            catch { return null; }
        }

        private static string DecodeCompileLogBytes(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) return "";
            if (bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2).Replace("\0", "");
            if (bytes.Length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2).Replace("\0", "");
            var sample = Math.Min(bytes.Length, 4096);
            var evenZeros = 0;
            var oddZeros = 0;
            for (var i = 0; i < sample; i++)
            {
                if (bytes[i] == 0) { if ((i & 1) == 0) evenZeros++; else oddZeros++; }
            }
            if (oddZeros > sample / 4) return Encoding.Unicode.GetString(bytes).Replace("\0", "");
            if (evenZeros > sample / 4) return Encoding.BigEndianUnicode.GetString(bytes).Replace("\0", "");
            return Encoding.UTF8.GetString(bytes).Replace("\0", "");
        }

        private static string NormalizeCompilerDiagnosticLine(string line)
        {
            if (string.IsNullOrEmpty(line)) return line;
            // Project logs prefix each emitted line with time/level metadata. Preserve
            // only the diagnostic path onward, including mixed slash project roots.
            try
            {
                var normalizedLine = line.Replace('/', '\\');
                var project = Globals.ProjectFolder == null ? null : Globals.ProjectFolder.Replace('/', '\\');
                if (!string.IsNullOrEmpty(project))
                {
                    var index = normalizedLine.IndexOf(project, StringComparison.OrdinalIgnoreCase);
                    if (index >= 0) return line.Substring(index);
                }
            }
            catch { }
            var redacted = line.IndexOf("<project>", StringComparison.OrdinalIgnoreCase);
            return redacted >= 0 ? line.Substring(redacted) : line;
        }

        private static void ParseDiagnosticMessage(string message, McpDiagnostic diagnostic)
        {
            // Flax compiler messages follow `path(line,column,...): error|warning text`.
            // Avoid Regex here: the stripped Flax game-project reference set does not
            // include System.Text.RegularExpressions.
            if (string.IsNullOrEmpty(message)) return;
            var open = message.IndexOf('(');
            var close = open < 0 ? -1 : message.IndexOf("):", open, StringComparison.Ordinal);
            if (open <= 0 || close <= open) return;
            var location = message.Substring(open + 1, close - open - 1);
            var comma = location.IndexOf(',');
            int line;
            if (!int.TryParse(comma < 0 ? location : location.Substring(0, comma), out line)) return;
            var column = 0;
            if (comma >= 0)
            {
                var afterComma = location.Substring(comma + 1);
                var nextComma = afterComma.IndexOf(',');
                int.TryParse(nextComma < 0 ? afterComma : afterComma.Substring(0, nextComma), out column);
            }
            var rest = message.Substring(close + 2).Trim();
            var lower = rest.ToLowerInvariant();
            var level = lower.StartsWith("error ") ? "error" : (lower.StartsWith("warning ") ? "warning" : null);
            if (level == null) return;
            diagnostic.File = ProjectRelativeDiagnosticPath(message.Substring(0, open));
            diagnostic.Line = line;
            diagnostic.Column = column;
            diagnostic.Level = level;
            var diagnosticText = rest.Substring(level.Length).Trim();
            var colon = diagnosticText.IndexOf(':');
            var possibleCode = colon > 0 ? diagnosticText.Substring(0, colon).Trim() : null;
            if (!string.IsNullOrEmpty(possibleCode) && possibleCode.Length <= 32 && possibleCode.IndexOf(' ') < 0)
            {
                diagnostic.Code = possibleCode;
                diagnosticText = diagnosticText.Substring(colon + 1).Trim();
            }
            diagnostic.Message = LimitForLog(diagnosticText, MaxLogMessageChars);
        }

        private void RestorePersistentState()
        {
            lock (_stateLock)
            {
                var savedCompile = ReadPersistent<McpPersistedCompileState>(CompileStatePath);
                if (savedCompile != null)
                {
                    if (savedCompile.State != null) _compile = savedCompile.State;
                    _compile.IsCompiling = ScriptsBuilder.IsCompiling;
                    _compile.IsReady = ScriptsBuilder.IsReady;
                    _compile.LastCompilationFailed = ScriptsBuilder.LastCompilationFailed;
                    _compile.CompilationsCount = ScriptsBuilder.CompilationsCount;
                    if (savedCompile.Diagnostics != null)
                    {
                        foreach (var diagnostic in savedCompile.Diagnostics)
                        {
                            if (diagnostic != null && _diagnostics.Count < MaxDiagnostics) _diagnostics.Add(diagnostic);
                        }
                    }
                    if (ReconcileStaleCompileLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) PersistCompileStateLocked();
                }
                var savedGenerate = ReadPersistent<McpGenerateProjectState>(GenerateStatePath);
                if (savedGenerate != null)
                {
                    // A queued editor operation cannot survive process/reload boundaries.
                    if (savedGenerate.Phase == "running") { savedGenerate.Phase = "interrupted"; savedGenerate.Failed = true; savedGenerate.Error = "Bridge reloaded before project generation completed."; savedGenerate.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
                    _generate = savedGenerate;
                }
            }
        }

        private void PersistCompileState() { lock (_stateLock) PersistCompileStateLocked(); }
        private void PersistGenerateState() { lock (_stateLock) PersistGenerateStateLocked(); }
        private void PersistCompileStateLocked() { TryWritePersistent(CompileStatePath, new McpPersistedCompileState { State = _compile, Diagnostics = _diagnostics.ToArray() }); }
        private void PersistGenerateStateLocked() { TryWritePersistent(GenerateStatePath, _generate); }

        private bool ReconcileStaleCompileLocked(long now)
        {
            if ((_compile.Phase != "requested" && _compile.Phase != "compiling") || _compile.IsCompiling || _compile.StartedUnixMs <= 0 || now - _compile.StartedUnixMs < StaleCompileOperationMs)
                return false;
            _compile.Phase = "interrupted";
            if (_compile.FinishedUnixMs == 0) _compile.FinishedUnixMs = now;
            return true;
        }

        private static T ReadPersistent<T>(string path) where T : class
        {
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists || info.Length > 256 * 1024) return null;
                return JsonSerializer.Deserialize<T>(File.ReadAllText(path));
            }
            catch { return null; }
        }

        private static void TryWritePersistent(string path, object value)
        {
            try { WriteAtomic(path, JsonSerializer.Serialize(value, true)); } catch { }
        }

        private static McpCompileStatus CopyCompileStatus(McpCompileStatus value)
        {
            return new McpCompileStatus { OperationId = value.OperationId, Phase = value.Phase, IsCompiling = value.IsCompiling, IsReady = value.IsReady, LastCompilationFailed = value.LastCompilationFailed, CompilationsCount = value.CompilationsCount, StartedUnixMs = value.StartedUnixMs, FinishedUnixMs = value.FinishedUnixMs };
        }

        private static McpGenerateProjectState CopyGenerateState(McpGenerateProjectState value)
        {
            return new McpGenerateProjectState { OperationId = value.OperationId, Phase = value.Phase, Failed = value.Failed, StartedUnixMs = value.StartedUnixMs, FinishedUnixMs = value.FinishedUnixMs, Error = value.Error };
        }

        private static McpLogEntry CopyLogEntry(McpLogEntry value)
        {
            return new McpLogEntry { Sequence = value.Sequence, TimestampUnixMs = value.TimestampUnixMs, Level = value.Level, Category = value.Category, CompilationId = value.CompilationId, PlaySessionId = value.PlaySessionId, Message = value.Message, StackTrace = value.StackTrace };
        }

        private static McpDiagnostic CopyDiagnostic(McpDiagnostic value)
        {
            return new McpDiagnostic { Level = value.Level, Message = value.Message, File = value.File, Line = value.Line, Column = value.Column, Code = value.Code, TimestampUnixMs = value.TimestampUnixMs };
        }

        private static McpCaptureStatus CopyCaptureStatus(McpCaptureStatus value)
        {
            return new McpCaptureStatus { CaptureId = value.CaptureId, Phase = value.Phase, Path = value.Path, StartedUnixMs = value.StartedUnixMs, CompletedUnixMs = value.CompletedUnixMs, SizeBytes = value.SizeBytes };
        }

        private static LogType ParseLogLevel(string value)
        {
            LogType result;
            return Enum.TryParse(value, true, out result) ? result : LogType.Info;
        }

        private static bool MatchesSeverity(string level, string[] severities)
        {
            if (severities == null || severities.Length == 0) return true;
            foreach (var severity in severities)
                if (!string.IsNullOrEmpty(severity) && string.Equals(level, severity, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private bool IsCompileLogCategory()
        {
            return _compile.Phase == "requested" || _compile.Phase == "compiling" || _compile.Phase == "reloading";
        }

        private bool IsPlayLogCategory()
        {
            return _playState == "starting" || _playState == "running" || _playState == "paused" || _playState == "stopping";
        }

        private string ActiveLogCategory()
        {
            if (IsCompileLogCategory()) return "compile";
            if (IsPlayLogCategory()) return "play";
            return "engine";
        }

        private static string LimitForLog(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return null;
            return value.Length <= max ? value : value.Substring(0, max) + " [truncated]";
        }

        private static string RedactLogText(string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            try
            {
                var project = Path.GetFullPath(Globals.ProjectFolder).TrimEnd('\\', '/').Replace('\\', '/');
                if (!string.IsNullOrEmpty(project))
                {
                    value = value.Replace('\\', '/');
                    var index = value.IndexOf(project, StringComparison.OrdinalIgnoreCase);
                    while (index >= 0)
                    {
                        value = value.Substring(0, index) + "<project>" + value.Substring(index + project.Length);
                        index = value.IndexOf(project, index + "<project>".Length, StringComparison.OrdinalIgnoreCase);
                    }
                }
            }
            catch { }
            return value;
        }

        private static string ProjectRelativeDiagnosticPath(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            const string marker = "<project>";
            if (value.StartsWith(marker, StringComparison.OrdinalIgnoreCase))
                return value.Substring(marker.Length).TrimStart('\\', '/').Replace('\\', '/');
            return ProjectRelativePath(value);
        }

        private static bool IsGuidN(string value)
        {
            Guid ignored;
            return Guid.TryParseExact(value, "N", out ignored);
        }

        private void WriteHeartbeat() { WriteAtomic(BridgePath, JsonSerializer.Serialize(new McpBridgeInfo { Pid = Environment.ProcessId, Project = Globals.ProjectFolder, EditorVersion = Globals.EngineVersion.ToString(), Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, true)); }
        private static McpResponse Failure(string id, string requestToken, string code, string message)
        {
            // Never disclose the active session token to an unauthenticated
            // request. Authenticated failures naturally echo the valid token.
            return new McpResponse { id = id, token = requestToken, ok = false, errorCode = code, error = message, timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }
        private static bool IsSafeRequestFile(string name) { if (string.IsNullOrEmpty(name) || name.Length > 133 || !name.EndsWith(".json")) return false; for (var i = 0; i < name.Length - 5; i++) if (!(char.IsLetterOrDigit(name[i]) || name[i] == '-' || name[i] == '_')) return false; return true; }
        private static void WriteAtomic(string path, string text) { var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp"; File.WriteAllText(temp, text); if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path); }
        private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
        private static string CreateSessionToken() { var bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
        private static void WriteToken(string token)
        {
            // A forced editor shutdown can leave the previous hidden token behind.
            // Windows rejects overwriting that file until the hidden attribute is cleared.
            try { if (File.Exists(TokenPath)) File.SetAttributes(TokenPath, FileAttributes.Normal); } catch { }
            WriteAtomic(TokenPath, token);
            try { File.SetAttributes(TokenPath, FileAttributes.Hidden); } catch { }
        }
        private static bool ConstantTimeEquals(string a, string b) { if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b) || a.Length != b.Length) return false; var different = 0; for (var i = 0; i < a.Length; i++) different |= a[i] ^ b[i]; return different == 0; }
        private static void CleanupOldProcessing() { foreach (var file in Directory.GetFiles(Processing, "*.json")) try { if (DateTime.UtcNow - File.GetLastWriteTimeUtc(file) > TimeSpan.FromMinutes(5)) File.Delete(file); } catch { } }
        private void CleanupCaptures(int maxStatuses = MaxCaptures)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var cutoff = now - (long)TimeSpan.FromHours(MaxCaptureAgeHours).TotalMilliseconds;
            var removed = new List<string>();
            lock (_stateLock)
            {
                var expired = new List<string>();
                foreach (var pair in _captures)
                {
                    var timestamp = pair.Value.CompletedUnixMs != 0 ? pair.Value.CompletedUnixMs : pair.Value.StartedUnixMs;
                    if (timestamp != 0 && timestamp < cutoff) expired.Add(pair.Key);
                }
                foreach (var id in expired) { _captures.Remove(id); removed.Add(id); }
                while (_captures.Count > maxStatuses)
                {
                    string oldestId = null;
                    long oldestTimestamp = long.MaxValue;
                    foreach (var pair in _captures)
                    {
                        var timestamp = pair.Value.StartedUnixMs == 0 ? long.MinValue : pair.Value.StartedUnixMs;
                        if (timestamp < oldestTimestamp) { oldestTimestamp = timestamp; oldestId = pair.Key; }
                    }
                    if (oldestId == null) break;
                    _captures.Remove(oldestId);
                    removed.Add(oldestId);
                }
            }
            foreach (var id in removed) TryDelete(Path.Combine(Captures, id + ".png"));
            try
            {
                var files = Directory.GetFiles(Captures, "*.png");
                var retained = new List<FileInfo>();
                foreach (var file in files)
                {
                    try
                    {
                        var info = new FileInfo(file);
                        if (DateTime.UtcNow - info.LastWriteTimeUtc > TimeSpan.FromHours(MaxCaptureAgeHours)) TryDelete(file);
                        else retained.Add(info);
                    }
                    catch { }
                }
                retained.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
                for (var i = 0; i < retained.Count - MaxCaptures; i++)
                {
                    var file = retained[i];
                    TryDelete(file.FullName);
                    var id = Path.GetFileNameWithoutExtension(file.Name);
                    lock (_stateLock) _captures.Remove(id);
                }
            }
            catch { }
        }
    }

    internal sealed class McpProtocolException : Exception
    {
        public readonly string Code;
        public McpProtocolException(string code, string message) : base(message) { Code = code; }
    }

    internal sealed class McpScriptEnabledUndo : IUndoAction
    {
        private Guid _scriptId;
        private readonly bool _before;
        private readonly bool _after;

        public string ActionString { get { return "Update script"; } }

        public McpScriptEnabledUndo(Script script, bool before, bool after)
        {
            _scriptId = script.ID;
            _before = before;
            _after = after;
        }

        public void Do() { Apply(_after); }
        public void Undo() { Apply(_before); }
        public void Dispose() { }

        private void Apply(bool enabled)
        {
            var id = _scriptId;
            var script = FObject.TryFind<Script>(ref id);
            if (script == null) return;
            script.Enabled = enabled;
            if (script.Actor != null && script.Actor.Scene != null)
                FEditor.Instance.Scene.MarkSceneEdited(script.Actor.Scene);
        }
    }
}
#endif
