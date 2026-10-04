// MCP-BRIDGE-VERSION: 37
// Flax 1.12 runtime (cooked game) bridge for flax-engine-mcp.
//
// Install this file in a game module next to FlaxMcpBridge.cs, for example
// Source/Game/MCP/FlaxMcpRuntimeBridge.cs. It is deliberately file-RPC only: no
// listener is exposed on the network, and it stays completely inert unless the
// game was started with -mcpdir=<absolute instance directory> (the MCP server's
// game_launch tool passes it). It compiles to nothing in the Editor and in
// release builds.
#if FLAX_GAME && !BUILD_RELEASE
// Flax can define FLAX_GAME for a module that the Editor also compiles; the
// Editor bridge (FlaxMcpBridge.cs) owns that case, so never compile both.
#if !FLAX_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FlaxEngine;
using FlaxEngine.Json;
using FObject = FlaxEngine.Object;

namespace Game.MCP
{
    // Wire DTOs. Public field names are the protocol keys (see bridge/PROTOCOL.md).
    // They deliberately reuse the Editor bridge's names and shapes; the two files
    // never compile together.
    public class McpRuntimeBridgeInfo { public int BridgeVersion = 37; public int ProtocolVersion = 1; public string Kind = "game"; public int Pid; public string Instance; public string ProductName; public string EngineVersion; public long Timestamp; }
    public class McpRuntimeStatus { public int BridgeVersion = 37; public int ProtocolVersion = 1; public string Kind = "game"; public int Pid; public string Instance; public string ProductName; public string EngineVersion; public long FrameCount; public float TimeScale; public int LoadedSceneCount; public string[] Methods; }
    public class McpRequest { public string id; public string token; public string method; public string paramsJson; public long deadlineUnixMs; }
    public class McpResponse { public string id; public string token; public bool ok; public string errorCode; public string error; public string errorDetails; public string resultJson; public long timestamp; }
    public class McpVector2 { public float X; public float Y; }
    public class McpVector3 { public float X; public float Y; public float Z; }
    public class McpVector4 { public float X; public float Y; public float Z; public float W; }
    public class McpMaterialTypedValue { public string Kind; public bool? Boolean; public long? Integer; public double? Number; public string Text; public McpVector2 Vector2; public McpVector3 Vector3; public McpVector4 Vector4; public string AssetId; public string TypeName; }
    public class McpActorDto
    {
        public string Id; public string TypeName; public string Name; public bool Active; public string ParentId;
        public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles;
        public McpVector3 LocalPosition; public McpVector3 LocalScale; public McpVector3 LocalEulerAngles;
        public string[] Tags; public bool TagsTruncated; public int Layer; public string LayerName;
        public int ChildrenCount; public bool ActiveInHierarchy; public int StaticFlags; public int OrderInParent;
        public string[] ScriptIds; public McpActorDto[] Children; public long ProjectRevision; public long SceneRevision;
    }
    public class McpRuntimeActorInspect { public string ActorId; public int Depth; public bool IncludeScripts = true; }
    public class McpRuntimeActorInspection { public bool IsPlayMode; public bool IsPaused; public string SceneId; public McpActorDto Actor; }
    // Nested member path refusal: which Path segment failed (same as the Editor bridge).
    public class McpMemberPathErrorDetails { public string[] Path; public int SegmentIndex; public string Segment; }
    public class McpRuntimeScriptValueSet { public string ScriptId; public string Member; public string[] Path; public bool? Bool; public double? Number; public string Text; }
    public class McpRuntimeScriptValueResult { public string ScriptId; public string Member; public string Type; public McpMaterialTypedValue Before; public McpMaterialTypedValue After; public string PlaySessionId; public string[] Warnings; public string[] Path; }
    public class McpRuntimeArgument { public bool? Bool; public double? Number; public string Text; }
    public class McpRuntimeScriptInvoke { public string ScriptId; public string Method; public McpRuntimeArgument[] Args; }
    public class McpRuntimeScriptInvokeResult { public string ScriptId; public string Method; public string DeclaringType; public string ReturnType; public bool Invoked; public bool Threw; public string ExceptionType; public string ExceptionMessage; public McpMaterialTypedValue Result; public string PlaySessionId; public string[] Warnings; }
    public class McpLogQuery { public long SinceSequence; public int Limit = 100; public string[] Severities; public string Category; public string PlaySessionId; public string Contains; public bool IncludeStackTrace; public bool Tail; public long AfterSequence; public int MaxEntries; public int LevelMask = 15; }
    public class McpLogEntry { public long Sequence; public long TimestampUnixMs; public string Level; public string Category; public string CompilationId; public string PlaySessionId; public string Message; public string StackTrace; }
    public class McpLogQueryResult { public string SessionId; public long NextSequence; public bool HasMore; public long DroppedCount; public McpLogEntry[] Entries; }
    public class McpPerfSnapshot { public int? Fps; public float? FrameTimeMs; public long? DrawCalls; public long? Triangles; public long? ManagedMemoryBytes; public int? ActorCount; public string GpuAdapter; public string RendererType; public bool IsPlayMode; public long TimestampUnixMs; }
    public class McpPerfGpuEventsRequest { public bool Enable; public bool Restore; public int MaxEvents; }
    public class McpPerfGpuEvent { public string Name; public int Depth; public float TimeMs; public long DrawCalls; public long DispatchCalls; public long Triangles; public long Vertices; }
    public class McpPerfGpuEvents { public bool ProfilerAvailable; public string Reason; public bool ProfilerEnabled; public bool EnabledByBridge; public bool WasEnabled; public bool Restored; public long FrameCount; public bool HasData; public float? DrawGpuTimeMs; public float? DrawCpuTimeMs; public int EventCount; public bool Truncated; public McpPerfGpuEvent[] Events; public string GpuAdapter; public string RendererType; public bool IsPlayMode; public long TimestampUnixMs; }
    public class McpCaptureStart { public string Viewport; public int Width; public int Height; }
    public class McpCaptureStatusRequest { public string CaptureId; }
    public class McpCaptureStatus { public string CaptureId; public string Phase; public string Path; public long StartedUnixMs; public long CompletedUnixMs; public long SizeBytes; public string Error; }
    public class McpTimeScaleRequest { public float TimeScale; }
    // play.set_time_scale result. The Editor returns its play status; a cooked
    // game has no play session, so this carries the fields that still apply.
    public class McpRuntimePlayStatus { public string State = "running"; public bool IsPlayMode = true; public bool IsPaused; public ulong FrameCount; public float TimeScale; public float PreviousTimeScale; }
    public class McpRuntimeQuitResult { public bool Accepted; public string Phase; public int Pid; }

    internal sealed class McpProtocolException : Exception
    {
        public readonly string Code;
        public readonly object Details;
        public McpProtocolException(string code, string message, object details = null) : base(message) { Code = code; Details = details; }
    }

    // One public instance field or property that a member write or read may touch.
    internal sealed class McpRtMember
    {
        public string Name; public Type ValueType; public Type DeclaringType; public bool ReadOnly; public FieldInfo Field; public PropertyInfo Property;
        public object GetValue(object target) { return Field != null ? Field.GetValue(target) : Property.GetValue(target, null); }
        public void SetValue(object target, object value) { if (Field != null) Field.SetValue(target, value); else Property.SetValue(target, value, null); }
    }

    // Resolved Path chain: Containers[i] owns Slots[i]; Containers[i + 1] is the value of Slots[i].
    internal sealed class McpRtChain { public string[] Names; public McpRtMember[] Slots; public object[] Containers; }
    internal sealed class McpRtWritePlan { public McpRtChain Chain; public Type LeafType; public object Coerced; public object Before; }

    /// <summary>
    /// File-based RPC bridge for a cooked game. Requests are moved atomically from
    /// requests/ into processing/, executed on Flax's main thread, and responses are
    /// atomically renamed into responses/. Only the allowlisted methods in Dispatch exist.
    /// </summary>
    public sealed class FlaxMcpRuntimeBridgePlugin : GamePlugin
    {
        private const int BridgeVersion = 37;
        private const int ProtocolVersion = 1;
        private const int MaxRequestBytes = 128 * 1024;
        private const int MaxParamsBytes = 64 * 1024;
        private const int MaxDeadlineMs = 60 * 1000;
        private const int MainThreadTimeoutMs = 60 * 1000;
        private const int MaxRequestsPerPoll = 4;
        private const int MaxTreeDepth = 64;
        private const int MaxTreeActors = 2000;
        private const int MaxActorTags = 64;
        private const int MaxActorTagChars = 128;
        private const int MaxLayerNameChars = 128;
        private const int MaxResultBytes = 512 * 1024;
        private const int MaxScriptValueStringChars = 512;
        private const int MaxScriptValueWriteChars = 4096;
        private const int MaxLogEntries = 2000;
        private const int MaxLogMessageChars = 8192;
        private const int MaxCaptureAgeHours = 24;
        private const int MaxCaptures = 64;
        private const int MaxRuntimeInvokeArgs = 4;
        private const int MaxMemberPathDepth = 4;
        private const int MaxPlainJsonDepth = 6;
        private const int MaxDirectoryChars = 240;
        private const long HeartbeatMs = 2000;
        private const long ForeignHeartbeatStaleMs = 30000;

        private volatile bool _running;
        private volatile int _busy;
        private long _lastPoll;
        private long _lastHeartbeat;
        private string _token;
        private string _root;
        private string _instance;
        private string _productName;
        private string _engineVersion;
        private string _logSessionId;
        private ILogHandler _logHandler;
        private bool _eventsSubscribed;
        private readonly object _stateLock = new object();
        private readonly List<McpLogEntry> _logs = new List<McpLogEntry>(MaxLogEntries);
        private readonly Dictionary<string, McpCaptureStatus> _captures = new Dictionary<string, McpCaptureStatus>();
        private long _nextLogSequence;
        // game.quit: armed by the request, completed from OnUpdate on a later frame.
        private volatile PendingQuit _pendingQuit;

        private string Requests { get { return Path.Combine(_root, "requests"); } }
        private string Processing { get { return Path.Combine(_root, "processing"); } }
        private string Responses { get { return Path.Combine(_root, "responses"); } }
        private string Captures { get { return Path.Combine(_root, "captures"); } }
        private string BridgePath { get { return Path.Combine(_root, "bridge.json"); } }
        private string TokenPath { get { return Path.Combine(_root, "token"); } }

        public FlaxMcpRuntimeBridgePlugin()
        {
            _description = new PluginDescription
            {
                Name = "Flax MCP Runtime Bridge",
                Category = "Debug",
                Author = "flax-engine-mcp",
                Description = "File-RPC debug bridge for a running game. Inert unless the game is started with -mcpdir=<absolute path>.",
                Version = new Version(37, 0),
                IsBeta = true,
            };
        }

        public override void Initialize()
        {
            base.Initialize();
            try
            {
                string directory;
                string instance;
                if (!TryReadLaunchOptions(out directory, out instance)) return;
                _root = directory;
                _instance = instance;
                string ownerNote;
                if (TryGetLiveForeignOwner(out ownerNote))
                {
                    Debug.LogWarning("[Flax MCP] Runtime bridge stays inert: another live game process owns this instance directory (" + ownerNote + ").");
                    _root = null;
                    return;
                }
                Directory.CreateDirectory(Requests);
                Directory.CreateDirectory(Processing);
                Directory.CreateDirectory(Responses);
                Directory.CreateDirectory(Captures);
                CleanupOldProcessing();
                CleanupCaptures();
                _productName = SafeText(() => Globals.ProductName);
                _engineVersion = SafeText(() => Globals.EngineVersion.ToString());
                _token = CreateSessionToken();
                _logSessionId = Guid.NewGuid().ToString("N");
                SubscribeEvents();
                WriteToken(_token);
                WriteHeartbeat();
                _lastHeartbeat = Environment.TickCount64;
                _running = true;
                Scripting.Update += OnUpdate;
                Debug.Log("[Flax MCP] Runtime bridge v37 listening (instance " + _instance + ")");
            }
            catch (Exception ex)
            {
                _running = false;
                try { UnsubscribeEvents(); } catch { }
                Debug.LogError("[Flax MCP] Runtime bridge failed to initialize: " + ex.Message);
            }
        }

        public override void Deinitialize()
        {
            var wasRunning = _running;
            _running = false;
            try { RestoreGpuProfiler(); } catch { }
            if (wasRunning)
            {
                Scripting.Update -= OnUpdate;
                try { UnsubscribeEvents(); } catch { }
                try
                {
                    // Only remove the files this process owns.
                    var info = ReadHeartbeatFile();
                    if (info == null || info.Pid == Environment.ProcessId)
                    {
                        TryDelete(BridgePath);
                        TryDelete(TokenPath);
                    }
                }
                catch { }
            }
            base.Deinitialize();
        }

        // -mcpdir=<absolute path> (quoted or unquoted) switches the bridge on.
        // Returns false (inert) when the option is absent, and also when it is
        // present but not usable, in which case a warning explains why.
        private static bool TryReadLaunchOptions(out string directory, out string instance)
        {
            directory = null;
            instance = Environment.ProcessId.ToString(CultureInfo.InvariantCulture);
            string commandLine;
            try { commandLine = Engine.CommandLine; }
            catch { return false; }
            bool present;
            var raw = ReadCommandLineValue(commandLine, "mcpdir", out present);
            if (!present) return false;
            if (string.IsNullOrWhiteSpace(raw))
            {
                Debug.LogWarning("[Flax MCP] Runtime bridge stays inert: -mcpdir needs a value.");
                return false;
            }
            raw = raw.Trim();
            string full;
            try
            {
                if (!Path.IsPathFullyQualified(raw)) throw new ArgumentException("not absolute");
                full = Path.GetFullPath(raw).TrimEnd('\\', '/');
            }
            catch
            {
                Debug.LogWarning("[Flax MCP] Runtime bridge stays inert: -mcpdir must be an absolute path.");
                return false;
            }
            if (full.Length == 0 || full.Length > MaxDirectoryChars)
            {
                Debug.LogWarning("[Flax MCP] Runtime bridge stays inert: -mcpdir is empty or longer than " + MaxDirectoryChars + " characters.");
                return false;
            }
            directory = full;
            bool instancePresent;
            var name = ReadCommandLineValue(commandLine, "mcpinstance", out instancePresent);
            if (instancePresent)
            {
                if (IsValidInstanceName(name)) instance = name;
                else Debug.LogWarning("[Flax MCP] -mcpinstance must match [A-Za-z0-9_-]{1,64}; using the process id instead.");
            }
            return true;
        }

        private static bool IsValidInstanceName(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 64) return false;
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
            }
            return true;
        }

        // Finds "-name=value" as its own argument. The value may be wrapped in
        // quotes ("-name=C:\a b" or -name="C:\a b") or be unquoted (ends at whitespace).
        private static string ReadCommandLineValue(string commandLine, string name, out bool present)
        {
            present = false;
            if (string.IsNullOrEmpty(commandLine)) return null;
            var key = "-" + name + "=";
            var from = 0;
            while (from < commandLine.Length)
            {
                var index = commandLine.IndexOf(key, from, StringComparison.OrdinalIgnoreCase);
                if (index < 0) return null;
                from = index + key.Length;
                var before = index == 0 ? ' ' : commandLine[index - 1];
                if (!(char.IsWhiteSpace(before) || before == '"')) continue;
                present = true;
                var start = index + key.Length;
                if (start < commandLine.Length && commandLine[start] == '"')
                {
                    var close = commandLine.IndexOf('"', start + 1);
                    return close < 0 ? commandLine.Substring(start + 1) : commandLine.Substring(start + 1, close - start - 1);
                }
                var end = start;
                if (before == '"')
                {
                    var close = commandLine.IndexOf('"', start);
                    end = close < 0 ? commandLine.Length : close;
                }
                else
                {
                    while (end < commandLine.Length && !char.IsWhiteSpace(commandLine[end])) end++;
                }
                return commandLine.Substring(start, end - start);
            }
            return null;
        }

        private static string SafeText(Func<string> read)
        {
            try { return read(); }
            catch { return null; }
        }

        // Flax's script compile has no reference to the process-management assembly (CS1069 for the Process type), so liveness uses kernel32 on Windows, /proc on Linux and libc kill(pid, 0) on macOS.
        // Flax game assemblies disable runtime marshalling: only blittable parameters (no bool, no SetLastError, no out) work, which is why the exit code goes through an unmanaged buffer.
        // Where neither works the answer is "alive" and the 30 s heartbeat staleness decides ownership.
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint desiredAccess, int inheritHandle, int processId);
        [DllImport("kernel32.dll")] private static extern int GetExitCodeProcess(IntPtr process, IntPtr exitCode);
        [DllImport("kernel32.dll")] private static extern int CloseHandle(IntPtr handle);
        [DllImport("libc", EntryPoint = "kill")] private static extern int UnixKill(int pid, int signal);

        private static bool IsProcessAlive(int pid)
        {
            if (pid <= 0) return false;
            try
            {
                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    const uint ProcessQueryLimitedInformation = 0x1000;
                    const uint StillActive = 259;
                    var handle = OpenProcess(ProcessQueryLimitedInformation, 0, pid);
                    if (handle == IntPtr.Zero) return Marshal.GetLastSystemError() == 5; // ERROR_ACCESS_DENIED: exists but protected. Anything else (87): no such process.
                    var buffer = Marshal.AllocHGlobal(4);
                    try
                    {
                        Marshal.WriteInt32(buffer, 0);
                        return GetExitCodeProcess(handle, buffer) == 0 || (uint)Marshal.ReadInt32(buffer) == StillActive;
                    }
                    finally { Marshal.FreeHGlobal(buffer); CloseHandle(handle); }
                }
                if (Directory.Exists("/proc/self")) return Directory.Exists("/proc/" + pid);
                if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return UnixKill(pid, 0) == 0 || Marshal.GetLastSystemError() == 1; // EPERM: exists but owned by another user. ESRCH (3): no such process.
            }
            catch { }
            return true;
        }

        private McpRuntimeBridgeInfo ReadHeartbeatFile()
        {
            try
            {
                if (!File.Exists(BridgePath)) return null;
                return JsonSerializer.Deserialize<McpRuntimeBridgeInfo>(File.ReadAllText(BridgePath));
            }
            catch { return null; }
        }

        // The directory belongs to a different, live game process with a fresh heartbeat.
        private bool TryGetLiveForeignOwner(out string note)
        {
            note = null;
            var info = ReadHeartbeatFile();
            if (info == null || info.Pid <= 0 || info.Pid == Environment.ProcessId) return false;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - info.Timestamp >= ForeignHeartbeatStaleMs) return false;
            if (!IsProcessAlive(info.Pid)) return false;
            note = "pid " + info.Pid;
            return true;
        }

        private void OnUpdate()
        {
            if (!_running) return;
            var now = Environment.TickCount64;
            TickPendingQuit(now);
            TickGpuProfiler(now);
            if (now - _lastHeartbeat >= HeartbeatMs)
            {
                _lastHeartbeat = now;
                try { TickHeartbeat(); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Heartbeat failed: " + ex.Message); }
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

        private void TickHeartbeat()
        {
            // The directories and the token are re-ensured so a cleaned cache folder does not strand the bridge.
            Directory.CreateDirectory(Requests);
            Directory.CreateDirectory(Processing);
            Directory.CreateDirectory(Responses);
            Directory.CreateDirectory(Captures);
            WriteHeartbeat();
            string current = null;
            try { current = File.ReadAllText(TokenPath); } catch { }
            if (!string.Equals(current, _token, StringComparison.Ordinal)) WriteToken(_token);
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
            catch (IOException) { /* raced with the client */ }
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
                response = Failure(request == null ? null : request.id, request == null ? null : request.token, ex.Code, ex.Message, ex.Details);
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
                // game.quit exits only after its response is on disk.
                if (request != null && string.Equals(request.method, "game.quit", StringComparison.Ordinal))
                {
                    var pendingQuit = _pendingQuit;
                    if (pendingQuit != null) pendingQuit.ResponseWritten = true;
                }
                TryDelete(processingPath);
                Interlocked.Decrement(ref _busy);
            }
        }

        // Every dispatch case label, in switch order. A contract test keeps this in sync.
        private static readonly string[] KnownMethods =
        {
            "status",
            "runtime.invoke_script_method",
            "runtime.set_script_value",
            "runtime.inspect_actor",
            "capture.start",
            "capture.status",
            "log.query",
            "play.set_time_scale",
            "perf.snapshot",
            "perf.gpu_events",
            "game.quit",
        };

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
                case "runtime.invoke_script_method": result = OnMain(() => InvokeRuntimeScriptMethod(JsonSerializer.Deserialize<McpRuntimeScriptInvoke>(p)), request.deadlineUnixMs); break;
                case "runtime.set_script_value": result = OnMain(() => SetRuntimeScriptValue(JsonSerializer.Deserialize<McpRuntimeScriptValueSet>(p)), request.deadlineUnixMs); break;
                case "runtime.inspect_actor": result = OnMain(() => InspectRuntimeActor(JsonSerializer.Deserialize<McpRuntimeActorInspect>(p)), request.deadlineUnixMs); break;
                case "capture.start": result = OnMain(() => StartCapture(JsonSerializer.Deserialize<McpCaptureStart>(p)), request.deadlineUnixMs); break;
                case "capture.status": result = GetCaptureStatus(JsonSerializer.Deserialize<McpCaptureStatusRequest>(p)); break;
                case "log.query": result = QueryLogs(JsonSerializer.Deserialize<McpLogQuery>(p)); break;
                case "play.set_time_scale": result = OnMain(() => SetPlayTimeScale(JsonSerializer.Deserialize<McpTimeScaleRequest>(p)), request.deadlineUnixMs); break;
                case "perf.snapshot": result = OnMain(PerfSnapshot, request.deadlineUnixMs); break;
                case "perf.gpu_events": result = OnMain(() => PerfGpuEvents(JsonSerializer.Deserialize<McpPerfGpuEventsRequest>(p)), request.deadlineUnixMs); break;
                case "game.quit": result = OnMain(GameQuit, request.deadlineUnixMs); break;
                default: throw new McpProtocolException("METHOD_NOT_FOUND", "Method '" + (request.method ?? "unknown") + "' is not a runtime bridge method.", new { Method = request.method, Methods = KnownMethods });
            }
            var resultJson = JsonSerializer.Serialize(PlainForJson(result), true);
            if (Encoding.UTF8.GetByteCount(resultJson) > MaxResultBytes)
                throw new McpProtocolException("RESPONSE_TOO_LARGE", "Bridge response exceeds the 512 KiB limit.");
            return new McpResponse { id = request.id, token = _token, ok = true, resultJson = resultJson, timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }

        // All methods below that Dispatch wraps in OnMain run on the game's update thread.
        private McpRuntimeStatus Status()
        {
            var status = new McpRuntimeStatus { Pid = Environment.ProcessId, Instance = _instance, ProductName = _productName, EngineVersion = _engineVersion, Methods = KnownMethods };
            try { status.FrameCount = (long)Engine.FrameCount; } catch { }
            try { status.TimeScale = Time.TimeScale; } catch { status.TimeScale = 1.0f; }
            try { status.LoadedSceneCount = Level.ScenesCount; } catch { }
            return status;
        }

        // game.quit state. The request records the decision; OnUpdate finishes it
        // so the response is on disk before the process exits.
        private sealed class PendingQuit
        {
            public long ArmedTick;
            public ulong ArmedFrame;
            public volatile bool ResponseWritten;
        }

        // Quit the game the way the engine's own exit path does. The exit itself
        // is never started from this call: TickPendingQuit requests it on a later
        // frame, after the response was written.
        private McpRuntimeQuitResult GameQuit()
        {
            if (_pendingQuit == null)
                _pendingQuit = new PendingQuit { ArmedTick = Environment.TickCount64, ArmedFrame = Engine.FrameCount };
            return new McpRuntimeQuitResult { Accepted = true, Phase = "exiting", Pid = Environment.ProcessId };
        }

        // Runs from OnUpdate (game update thread).
        private void TickPendingQuit(long now)
        {
            var pending = _pendingQuit;
            if (pending == null) return;
            try
            {
                if (!pending.ResponseWritten && now - pending.ArmedTick < 5000) return;
                if (Engine.FrameCount <= pending.ArmedFrame) return;
                _pendingQuit = null;
                Debug.Log("[Flax MCP] game.quit: requesting engine exit.");
                Engine.RequestExit();
            }
            catch (Exception ex)
            {
                _pendingQuit = null;
                Debug.LogWarning("[Flax MCP] game.quit failed: " + ex.Message);
            }
        }

        // Time.TimeScale is engine-global; 0 (frozen) is legitimate for frame-step debugging.
        private McpRuntimePlayStatus SetPlayTimeScale(McpTimeScaleRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Time scale parameters are required.");
            if (float.IsNaN(request.TimeScale) || float.IsInfinity(request.TimeScale) || request.TimeScale < 0.0f || request.TimeScale > 10.0f)
                throw new McpProtocolException("VALIDATION_FAILED", "TimeScale must be between 0 and 10.");
            var previous = Time.TimeScale;
            Time.TimeScale = request.TimeScale;
            return new McpRuntimePlayStatus { FrameCount = Engine.FrameCount, IsPaused = Time.GamePaused, TimeScale = Time.TimeScale, PreviousTimeScale = previous };
        }

        // Single instantaneous sample, read-only: every field is a primitive or null, and null means the backing API had no data.
        private McpPerfSnapshot PerfSnapshot()
        {
            var snapshot = new McpPerfSnapshot { IsPlayMode = true, TimestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            try
            {
                var fps = Engine.FramesPerSecond;
                if (fps > 0 && fps < 100000) snapshot.Fps = fps;
            }
            catch { }
            try
            {
                var delta = Time.UnscaledDeltaTime;
                if (!float.IsNaN(delta) && !float.IsInfinity(delta) && delta > 0.0f && delta < 60.0f) snapshot.FrameTimeMs = delta * 1000.0f;
            }
            catch { }
            try
            {
                var main = ProfilingTools.Stats;
                if (main.FPS > 0 && (main.DrawStats.DrawCalls > 0 || main.DrawStats.Triangles > 0))
                {
                    if (main.DrawStats.DrawCalls >= 0) snapshot.DrawCalls = main.DrawStats.DrawCalls;
                    if (main.DrawStats.Triangles >= 0) snapshot.Triangles = main.DrawStats.Triangles;
                }
            }
            catch { }
            try { snapshot.ManagedMemoryBytes = GC.GetTotalMemory(false); }
            catch { }
            try
            {
                var actors = Level.GetActors(typeof(Actor), false);
                if (actors != null) snapshot.ActorCount = actors.Length;
            }
            catch { }
            try
            {
                var device = GPUDevice.Instance;
                if (device != null)
                {
                    try
                    {
                        var adapter = device.Adapter;
                        if (adapter != null)
                        {
                            var description = adapter.Description;
                            if (!string.IsNullOrEmpty(description)) snapshot.GpuAdapter = description.Length > 256 ? description.Substring(0, 256) : description;
                        }
                    }
                    catch { }
                    try { snapshot.RendererType = device.RendererType.ToString(); }
                    catch { }
                }
            }
            catch { }
            return snapshot;
        }

        // Bridge v36: per-pass GPU timings (perf.gpu_events).
        //
        // Mirrors the Editor Profiler window's GPU tab
        // (Source/Editor/Windows/Profiler/GPU.cs): it reads
        // FlaxEngine.ProfilingTools.EventsGPU (ProfilingTools.h API_FIELD
        // ReadOnly Array<ProfilerGPU::Event>), the events of the last
        // resolved GPU frame in pre-order with Depth, Time (ms) and Stats
        // (RenderStatsData); ProfilingTools.Stats.DrawGPUTimeMs is the root
        // event time. The profiler collects nothing until it is enabled. The
        // Profiler window flips ProfilingTools.Enabled (CPU + GPU + GPU
        // debug events) on its record button; this method only flips
        // FlaxEngine.ProfilerGPU.Enabled (ProfilerGPU.h: "Can be changed
        // during rendering"), the same single flag ProfilerGPU.Dump sets and
        // restores, so the CPU profiler stays off. The previous state is
        // remembered and put back on Restore, on deinitialize, or by a
        // 30 s lease from OnUpdate when the client never comes back. When
        // the profiler was already on (for example a recording Profiler
        // window), the bridge never touches it. ProfilerGPU.Event.Name is a
        // char*, so reading it needs an unsafe context; Flax.Build compiles
        // every C# module with /unsafe (Builder.DotNet.cs). Headless
        // editors have no GPU device: everything stays empty with a Reason.
        private const int GpuProfilerLeaseMs = 30000;
        private const int GpuEventsDefaultMax = 500;
        private const int GpuEventsHardMax = 2000;
        private bool _gpuProfilerByBridge;
        private bool _gpuProfilerPrevious;
        private long _gpuProfilerExpireTick;

        private bool RestoreGpuProfiler()
        {
            if (!_gpuProfilerByBridge) return false;
            _gpuProfilerByBridge = false;
            try { ProfilerGPU.Enabled = _gpuProfilerPrevious; }
            catch { }
            return true;
        }

        // Runs from OnUpdate (update thread), like every other profiler access here.
        private void TickGpuProfiler(long now)
        {
            if (_gpuProfilerByBridge && now >= _gpuProfilerExpireTick)
            {
                RestoreGpuProfiler();
                Debug.Log("[Flax MCP] GPU profiler lease expired; restored the previous state.");
            }
        }

        private static unsafe string GpuEventName(char* name)
        {
            if (name == null) return "";
            var length = 0;
            while (length < 128 && name[length] != 0) length++;
            return new string(name, 0, length);
        }

        private McpPerfGpuEvents PerfGpuEvents(McpPerfGpuEventsRequest request)
        {
            request = request ?? new McpPerfGpuEventsRequest();
            var maxEvents = request.MaxEvents <= 0 ? GpuEventsDefaultMax : Math.Min(request.MaxEvents, GpuEventsHardMax);
            var result = new McpPerfGpuEvents { IsPlayMode = true, TimestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Events = new McpPerfGpuEvent[0] };
            try { result.FrameCount = (long)Engine.FrameCount; }
            catch { }
            var headless = false;
            // A cooked game always renders; no headless editor gate applies.
            GPUDevice device = null;
            if (!headless)
            {
                try { device = GPUDevice.Instance; }
                catch { }
            }
            if (device != null)
            {
                try
                {
                    var adapter = device.Adapter;
                    if (adapter != null && !string.IsNullOrEmpty(adapter.Description)) result.GpuAdapter = adapter.Description.Length > 256 ? adapter.Description.Substring(0, 256) : adapter.Description;
                }
                catch { }
                try { result.RendererType = device.RendererType.ToString(); }
                catch { }
            }
            if (headless)
            {
                RestoreGpuProfiler();
                result.Reason = "headless";
                return result;
            }
            if (device == null)
            {
                RestoreGpuProfiler();
                result.Reason = "no_gpu_device";
                return result;
            }
            try
            {
                if (request.Restore) result.Restored = RestoreGpuProfiler();
                else if (request.Enable)
                {
                    if (!_gpuProfilerByBridge && !ProfilerGPU.Enabled)
                    {
                        _gpuProfilerPrevious = false;
                        ProfilerGPU.Enabled = true;
                        _gpuProfilerByBridge = true;
                    }
                    if (_gpuProfilerByBridge) _gpuProfilerExpireTick = Environment.TickCount64 + GpuProfilerLeaseMs;
                }
                result.ProfilerEnabled = ProfilerGPU.Enabled;
                result.EnabledByBridge = _gpuProfilerByBridge;
                result.WasEnabled = _gpuProfilerByBridge ? _gpuProfilerPrevious : ProfilerGPU.Enabled;
                result.ProfilerAvailable = true;
            }
            catch (Exception)
            {
                result.Reason = "profiler_api_unavailable";
                return result;
            }
            ProfilerGPU.Event[] events = null;
            try { events = ProfilingTools.EventsGPU; }
            catch { }
            if (events == null || events.Length == 0)
            {
                result.Reason = result.ProfilerEnabled ? "no_data_yet" : "profiler_disabled";
                return result;
            }
            try
            {
                var stats = ProfilingTools.Stats;
                if (!float.IsNaN(stats.DrawGPUTimeMs) && stats.DrawGPUTimeMs > 0.0f) result.DrawGpuTimeMs = stats.DrawGPUTimeMs;
                if (!float.IsNaN(stats.DrawCPUTimeMs) && stats.DrawCPUTimeMs > 0.0f) result.DrawCpuTimeMs = stats.DrawCPUTimeMs;
            }
            catch { }
            var count = Math.Min(events.Length, maxEvents);
            var list = new McpPerfGpuEvent[count];
            for (var i = 0; i < count; i++)
            {
                var e = events[i];
                string name;
                unsafe { name = GpuEventName(e.Name); }
                list[i] = new McpPerfGpuEvent
                {
                    Name = name,
                    Depth = e.Depth,
                    TimeMs = float.IsNaN(e.Time) || float.IsInfinity(e.Time) ? 0.0f : e.Time,
                    DrawCalls = e.Stats.DrawCalls,
                    DispatchCalls = e.Stats.DispatchCalls,
                    Triangles = e.Stats.Triangles,
                    Vertices = e.Stats.Vertices,
                };
            }
            result.HasData = true;
            result.EventCount = events.Length;
            result.Truncated = events.Length > count;
            result.Events = list;
            return result;
        }

        // ---- log ring ----

        private void SubscribeEvents()
        {
            if (_eventsSubscribed) return;
            _logHandler = Debug.Logger == null ? null : Debug.Logger.LogHandler;
            if (_logHandler != null)
            {
                _logHandler.SendLog += OnSendLog;
                _logHandler.SendExceptionLog += OnSendExceptionLog;
            }
            _eventsSubscribed = true;
        }

        private void UnsubscribeEvents()
        {
            if (_logHandler != null)
            {
                _logHandler.SendLog -= OnSendLog;
                _logHandler.SendExceptionLog -= OnSendExceptionLog;
                _logHandler = null;
            }
            _eventsSubscribed = false;
        }

        private void OnSendLog(LogType level, string message, FObject context, string stackTrace)
        {
            AddLog(level, message, stackTrace);
        }

        private void OnSendExceptionLog(Exception exception, FObject context)
        {
            AddLog(LogType.Error, exception == null ? "Unknown exception" : exception.Message, exception == null ? null : exception.StackTrace);
        }

        private void AddLog(LogType level, string message, string stackTrace)
        {
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var text = LimitForLog(RedactLogText(message), MaxLogMessageChars);
            var stack = LimitForLog(RedactLogText(stackTrace), MaxLogMessageChars);
            lock (_stateLock)
            {
                _logs.Add(new McpLogEntry
                {
                    Sequence = ++_nextLogSequence, TimestampUnixMs = timestamp, Level = level.ToString(),
                    Category = "engine", Message = text ?? "", StackTrace = stack,
                });
                if (_logs.Count > MaxLogEntries) _logs.RemoveAt(0);
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

        private static McpLogEntry CopyLogEntry(McpLogEntry value)
        {
            return new McpLogEntry { Sequence = value.Sequence, TimestampUnixMs = value.TimestampUnixMs, Level = value.Level, Category = value.Category, CompilationId = value.CompilationId, PlaySessionId = value.PlaySessionId, Message = value.Message, StackTrace = value.StackTrace };
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

        private static string LimitForLog(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return null;
            return value.Length <= max ? value : value.Substring(0, max) + " [truncated]";
        }

        // Absolute project and bridge paths never leave the process in a log row.
        private string RedactLogText(string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            value = RedactPath(value, SafeText(() => Globals.ProjectFolder), "<project>");
            value = RedactPath(value, _root, "<mcp>");
            return value;
        }

        private static string RedactPath(string value, string path, string replacement)
        {
            if (string.IsNullOrEmpty(path)) return value;
            try
            {
                var normalized = Path.GetFullPath(path).TrimEnd('\\', '/').Replace('\\', '/');
                if (normalized.Length == 0) return value;
                value = value.Replace('\\', '/');
                var index = value.IndexOf(normalized, StringComparison.OrdinalIgnoreCase);
                while (index >= 0)
                {
                    value = value.Substring(0, index) + replacement + value.Substring(index + normalized.Length);
                    index = value.IndexOf(normalized, index + replacement.Length, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch { }
            return value;
        }

        // ---- capture ----

        // Screenshot.Capture(path) finishes GPU readback one or more frames later; capture.status observes the fixed, bridge-owned file.
        private McpCaptureStatus StartCapture(McpCaptureStart request)
        {
            if (request == null) request = new McpCaptureStart();
            var viewport = (request.Viewport ?? "game").Trim().ToLowerInvariant();
            if (!(viewport.Length == 0 || viewport == "game" || viewport == "main"))
                throw new McpProtocolException("VALIDATION_FAILED", "A cooked game has only the 'game' viewport.");
            if (request.Width != 0 || request.Height != 0)
                throw new McpProtocolException("VALIDATION_FAILED", "Custom capture dimensions are not supported by Flax 1.12 main-render capture.");
            CleanupCaptures(MaxCaptures - 1);
            var id = Guid.NewGuid().ToString("N");
            var path = Path.Combine(Captures, id + ".png");
            var item = new McpCaptureStatus { CaptureId = id, Phase = "Pending", Path = "captures/" + id + ".png", StartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            lock (_stateLock) _captures[id] = item;
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

        private static McpCaptureStatus CopyCaptureStatus(McpCaptureStatus value)
        {
            return new McpCaptureStatus { CaptureId = value.CaptureId, Phase = value.Phase, Path = value.Path, StartedUnixMs = value.StartedUnixMs, CompletedUnixMs = value.CompletedUnixMs, SizeBytes = value.SizeBytes, Error = value.Error };
        }

        // Keeps both the status map and the captures folder bounded.
        private void CleanupCaptures(int maxFiles = MaxCaptures)
        {
            try
            {
                var cutoff = DateTime.UtcNow - TimeSpan.FromHours(MaxCaptureAgeHours);
                var files = new List<FileInfo>();
                foreach (var file in Directory.GetFiles(Captures, "*.png")) files.Add(new FileInfo(file));
                files.Sort((left, right) => left.LastWriteTimeUtc.CompareTo(right.LastWriteTimeUtc));
                var removed = new List<string>();
                for (var i = 0; i < files.Count; i++)
                {
                    var excess = files.Count - removed.Count > maxFiles;
                    if (files[i].LastWriteTimeUtc >= cutoff && !excess) continue;
                    try { files[i].Delete(); removed.Add(Path.GetFileNameWithoutExtension(files[i].Name)); } catch { }
                }
                if (removed.Count == 0) return;
                lock (_stateLock) foreach (var id in removed) _captures.Remove(id);
            }
            catch { }
        }

        // ---- actors and scripts ----

        private static McpRuntimeActorInspection InspectRuntimeActor(McpRuntimeActorInspect p)
        {
            if (p == null || p.Depth < 0 || p.Depth > 4) throw new McpProtocolException("VALIDATION_FAILED", "Runtime actor depth must be between 0 and 4.");
            var actor = RequireActor(p.ActorId);
            return new McpRuntimeActorInspection
            {
                IsPlayMode = true, IsPaused = Time.GamePaused,
                SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"), Actor = RuntimeActorDto(actor, 0, p.Depth, p.IncludeScripts, new McpTreeBudget()),
            };
        }

        private sealed class McpTreeBudget { public int Count; }

        private static McpActorDto RuntimeActorDto(Actor actor, int depth, int requestedDepth, bool includeScripts, McpTreeBudget budget)
        {
            budget.Count++;
            if (budget.Count > MaxTreeActors) throw new McpProtocolException("RESPONSE_TOO_LARGE", "Runtime actor inspection exceeds the 2000 actor response limit.");
            var scripts = includeScripts ? new List<string>() : null;
            if (includeScripts) for (var i = 0; i < actor.ScriptsCount; i++) scripts.Add(actor.GetScript(i).ID.ToString("N"));
            bool tagsTruncated;
            var dto = new McpActorDto
            {
                Id = actor.ID.ToString("N"), TypeName = actor.TypeName, Name = actor.Name, Active = actor.IsActive,
                ParentId = actor.Parent == null ? null : actor.Parent.ID.ToString("N"), Position = FromFloat3(actor.Position),
                Scale = FromFloat3(actor.Scale), EulerAngles = FromFloat3(actor.EulerAngles),
                LocalPosition = FromFloat3(actor.LocalPosition), LocalScale = FromFloat3(actor.LocalScale), LocalEulerAngles = FromFloat3(actor.LocalEulerAngles),
                Tags = ActorTagNames(actor, out tagsTruncated), TagsTruncated = tagsTruncated, Layer = actor.Layer, LayerName = LimitForLog(actor.LayerName, MaxLayerNameChars),
                ChildrenCount = actor.ChildrenCount, ActiveInHierarchy = actor.IsActiveInHierarchy, StaticFlags = (int)actor.StaticFlags, OrderInParent = actor.OrderInParent,
                ScriptIds = includeScripts ? scripts.ToArray() : null,
            };
            if (depth < requestedDepth)
            {
                if (depth >= MaxTreeDepth && actor.ChildrenCount > 0)
                    throw new McpProtocolException("RESPONSE_TOO_LARGE", "Actor tree exceeds the 64 level depth limit.");
                var children = new List<McpActorDto>();
                for (var i = 0; i < actor.ChildrenCount; i++) children.Add(RuntimeActorDto(actor.GetChild(i), depth + 1, requestedDepth, includeScripts, budget));
                dto.Children = children.ToArray();
            }
            return dto;
        }

        private static string[] ActorTagNames(Actor actor, out bool truncated)
        {
            var tags = actor.Tags ?? new Tag[0];
            var count = Math.Min(tags.Length, MaxActorTags);
            var result = new string[count];
            for (var i = 0; i < count; i++) result[i] = LimitForLog(tags[i].ToString(), MaxActorTagChars);
            truncated = tags.Length > count;
            return result;
        }

        private static McpVector3 FromFloat3(Float3 v) { return new McpVector3 { X = v.X, Y = v.Y, Z = v.Z }; }

        private static Actor RequireActor(string id)
        {
            Guid guid;
            if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "actorId must be a 32-character GUID.");
            var actor = Level.FindActor(guid);
            if (actor == null) throw new McpProtocolException("NOT_FOUND", "Actor was not found.");
            return actor;
        }

        private static Script RequireScript(string id)
        {
            Guid guid;
            if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "scriptId must be a 32-character GUID.");
            var script = FObject.TryFind<Script>(ref guid);
            if (script == null) throw new McpProtocolException("NOT_FOUND", "Script was not found.");
            return script;
        }

        // Writes a game script member. Same contract as the Editor bridge's play-mode write: game members only, no
        // undo, never an engine-declared member. Members are resolved with System.Reflection (no FlaxEditor types exist
        // in a game build): public instance fields and properties declared in game code.
        private McpRuntimeScriptValueResult SetRuntimeScriptValue(McpRuntimeScriptValueSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Runtime script value parameters are required.");
            var script = RequireScript(q.ScriptId);
            var nestedPath = RequireMemberPathRequest(q.Path, q.Member, "Member");
            var warnings = new[] { "Runtime write: no undo was recorded and the game may overwrite the value on its next update." };
            if (nestedPath != null)
            {
                var plan = PlanMemberWrite(script, nestedPath, true, q.Bool, q.Number, q.Text);
                var display = string.Join(".", plan.Chain.Names);
                ApplyMemberWrite(plan, display);
                return new McpRuntimeScriptValueResult
                {
                    ScriptId = script.ID.ToString("N"), Member = display, Type = FriendlyTypeName(plan.LeafType), Path = plan.Chain.Names,
                    Before = ProjectMemberValue(plan.Before, plan.LeafType), After = ProjectMemberValue(ReadMemberLeaf(script, plan.Chain, plan.Coerced), plan.LeafType), Warnings = warnings,
                };
            }
            var slot = ResolveMember(script, q.Member);
            var block = MemberWriteBlockReason(slot, true);
            if (block != null)
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + slot.Name + "' cannot be written: " + block);
            var coerced = CoerceMemberValue(slot.ValueType, q.Bool, q.Number, q.Text, slot.Name);
            object beforeRaw;
            try { beforeRaw = slot.GetValue(script); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Member '" + slot.Name + "' read failed: " + DescribeException(ex)); }
            try { slot.SetValue(script, coerced); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Member '" + slot.Name + "' write failed: " + DescribeException(ex)); }
            object afterRaw;
            try { afterRaw = slot.GetValue(script); }
            catch { afterRaw = coerced; }
            return new McpRuntimeScriptValueResult
            {
                ScriptId = script.ID.ToString("N"), Member = slot.Name, Type = FriendlyTypeName(slot.ValueType),
                Before = ProjectMemberValue(beforeRaw, slot.ValueType), After = ProjectMemberValue(afterRaw, slot.ValueType), Warnings = warnings,
            };
        }

        private McpRuntimeScriptInvokeResult InvokeRuntimeScriptMethod(McpRuntimeScriptInvoke q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Runtime script invoke parameters are required.");
            if (string.IsNullOrEmpty(q.Method) || q.Method.Length > 128 || !IsScriptFieldName(q.Method))
                throw new McpProtocolException("VALIDATION_FAILED", "Method must be a C# identifier of 1-128 characters.");
            var args = q.Args ?? new McpRuntimeArgument[0];
            if (args.Length > MaxRuntimeInvokeArgs)
                throw new McpProtocolException("VALIDATION_FAILED", "Args accepts at most " + MaxRuntimeInvokeArgs + " values.");
            var script = RequireScript(q.ScriptId);
            MethodInfo[] methods;
            try { methods = script.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public); }
            catch { methods = new MethodInfo[0]; }
            var named = new List<MethodInfo>();
            foreach (var candidate in methods)
            {
                if (candidate.IsStatic || candidate.IsGenericMethodDefinition || candidate.ContainsGenericParameters || candidate.IsSpecialName) continue;
                if (!string.Equals(candidate.Name, q.Method, StringComparison.Ordinal)) continue;
                // Only methods written in game code: never engine lifecycle or
                // framework members inherited from FlaxEngine.Script.
                if (candidate.DeclaringType == null || IsEngineTypeName(candidate.DeclaringType.FullName)) continue;
                named.Add(candidate);
            }
            if (named.Count == 0)
                throw new McpProtocolException("VALIDATION_FAILED", "Public instance method '" + q.Method + "' was not found on " + (script.GetType().FullName ?? "unknown") + " (only non-generic methods declared in game code are invocable).");
            var matches = new List<MethodInfo>();
            foreach (var candidate in named) if (candidate.GetParameters().Length == args.Length) matches.Add(candidate);
            if (matches.Count == 0)
                throw new McpProtocolException("VALIDATION_FAILED", "Method '" + q.Method + "' has no overload taking " + args.Length + " argument(s).");
            if (matches.Count > 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Method '" + q.Method + "' has " + matches.Count + " overloads taking " + args.Length + " argument(s); overload selection is not supported.");
            var method = matches[0];
            var parameters = method.GetParameters();
            var values = new object[args.Length];
            for (var i = 0; i < args.Length; i++)
            {
                var parameter = parameters[i];
                var parameterType = parameter.ParameterType;
                var label = string.IsNullOrEmpty(parameter.Name) ? "arg" + i : parameter.Name;
                if (parameter.IsOut || parameterType == null || parameterType.IsByRef || !IsSupportedMemberType(parameterType))
                    throw new McpProtocolException("VALIDATION_FAILED", "Parameter '" + label + "' of '" + q.Method + "' has an unsupported type (" + (FriendlyTypeName(parameterType) ?? "unknown") + ").");
                var arg = args[i] ?? new McpRuntimeArgument();
                values[i] = CoerceMemberValue(parameterType, arg.Bool, arg.Number, arg.Text, label);
            }
            var returnType = method.ReturnType;
            var result = new McpRuntimeScriptInvokeResult
            {
                ScriptId = script.ID.ToString("N"), Method = method.Name,
                DeclaringType = LimitForLog(method.DeclaringType.FullName, 256),
                ReturnType = FriendlyTypeName(returnType),
                Invoked = true,
            };
            object returned = null;
            try { returned = method.Invoke(script, values); }
            catch (Exception ex)
            {
                var inner = ex;
                while (inner is TargetInvocationException && inner.InnerException != null) inner = inner.InnerException;
                result.Threw = true;
                result.ExceptionType = LimitForLog(inner.GetType().FullName, 256);
                result.ExceptionMessage = LimitForLog(RedactLogText(inner.Message), 512);
                result.Warnings = new[] { "The game method threw; side effects before the exception may have been applied." };
                return result;
            }
            if (returnType == null || returnType == typeof(void)) result.Result = new McpMaterialTypedValue { Kind = "void" };
            else result.Result = ProjectMemberValue(returned, returnType);
            return result;
        }

        // ---- reflection member model ----

        // Types in these namespaces are engine or framework code, never "game code".
        private static bool IsEngineTypeName(string fullName)
        {
            if (string.IsNullOrEmpty(fullName)) return true;
            return fullName.StartsWith("FlaxEngine.", StringComparison.Ordinal)
                || fullName.StartsWith("FlaxEditor.", StringComparison.Ordinal)
                || fullName.StartsWith("System.", StringComparison.Ordinal)
                || fullName.StartsWith("Microsoft.", StringComparison.Ordinal);
        }

        private static bool IsScriptFieldName(string name)
        {
            for (var i = 0; i < name.Length; i++)
            {
                var c = name[i];
                var ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || (i > 0 && c >= '0' && c <= '9');
                if (!ok) return false;
            }
            return name.Length > 0;
        }

        // Public instance fields and properties declared by game types, walking up the base chain until the first engine/framework type.
        // [HideInEditor] members stay hidden; [ReadOnly] members are readable but not writable.
        private static List<McpRtMember> VisibleMembers(Type type)
        {
            var result = new List<McpRtMember>();
            if (type == null) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly;
            for (var current = type; current != null && !IsEngineTypeName(current.FullName); current = current.BaseType)
            {
                FieldInfo[] fields;
                try { fields = current.GetFields(flags); }
                catch { fields = new FieldInfo[0]; }
                foreach (var field in fields)
                {
                    if (field.IsStatic || field.IsSpecialName || IsDefinedSafe(field, typeof(HideInEditorAttribute)) || !seen.Add(field.Name)) continue;
                    result.Add(new McpRtMember
                    {
                        Name = field.Name, Field = field, ValueType = field.FieldType, DeclaringType = current,
                        ReadOnly = field.IsInitOnly || field.IsLiteral || IsDefinedSafe(field, typeof(FlaxEngine.ReadOnlyAttribute)),
                    });
                }
                PropertyInfo[] properties;
                try { properties = current.GetProperties(flags); }
                catch { properties = new PropertyInfo[0]; }
                foreach (var property in properties)
                {
                    if (property.GetIndexParameters().Length != 0 || property.GetGetMethod() == null || property.GetGetMethod().IsStatic) continue;
                    if (IsDefinedSafe(property, typeof(HideInEditorAttribute)) || !seen.Add(property.Name)) continue;
                    result.Add(new McpRtMember
                    {
                        Name = property.Name, Property = property, ValueType = property.PropertyType, DeclaringType = current,
                        ReadOnly = property.GetSetMethod() == null || IsDefinedSafe(property, typeof(FlaxEngine.ReadOnlyAttribute)),
                    });
                }
            }
            return result;
        }

        private static bool IsDefinedSafe(MemberInfo member, Type attribute)
        {
            try { return member.IsDefined(attribute, true); }
            catch { return false; }
        }

        private static bool TypeHierarchyHasName(Type type, string name)
        {
            for (var current = type; current != null; current = current.BaseType)
                if (string.Equals(current.Name, name, StringComparison.Ordinal) || string.Equals(current.FullName, name, StringComparison.Ordinal)) return true;
            return false;
        }

        // property is "Member" or "Type.Member".
        private static McpRtMember ResolveMember(object target, string property)
        {
            if (string.IsNullOrEmpty(property) || property.Length > 128)
                throw new McpProtocolException("VALIDATION_FAILED", "Member must be 1-128 characters: Member or Type.Member.");
            string prefix = null;
            var name = property;
            var dot = property.IndexOf('.');
            if (dot >= 0)
            {
                prefix = property.Substring(0, dot);
                name = property.Substring(dot + 1);
            }
            if (!IsScriptFieldName(name) || (prefix != null && !IsScriptFieldName(prefix)))
                throw new McpProtocolException("VALIDATION_FAILED", "Member must be Member or Type.Member using C# identifiers.");
            var typeName = target.GetType().FullName ?? "unknown";
            if (prefix != null && !TypeHierarchyHasName(target.GetType(), prefix))
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + property + "' requires a " + prefix + " target, got " + typeName + ".");
            foreach (var slot in VisibleMembers(target.GetType()))
                if (string.Equals(slot.Name, name, StringComparison.Ordinal)) return slot;
            throw new McpProtocolException("VALIDATION_FAILED", "Unknown script member '" + property + "' on " + typeName + ". Members must be public fields or properties declared in game code (engine-declared members are not available).");
        }

        private static string MemberWriteBlockReason(McpRtMember slot, bool requireSupportedType)
        {
            if (slot.ReadOnly) return "Member is read-only.";
            if (IsEngineTypeName(slot.DeclaringType == null ? null : slot.DeclaringType.FullName))
                return "Engine-declared script members are not writable through this surface.";
            if (requireSupportedType && !IsSupportedMemberType(slot.ValueType))
                return "Unsupported type " + (FriendlyTypeName(slot.ValueType) ?? "unknown") + ".";
            return null;
        }

        // The scalar set (bool, integers, float/double, string, enum, Guid, Vector2/3/4, Float2/3/4, Color, Quaternion), asset
        // references by GUID, and actor/script references by GUID.
        private static bool IsSupportedMemberType(Type type)
        {
            if (type == null || type.IsByRef || type.IsPointer) return false;
            if (type == typeof(bool) || type == typeof(string) || type == typeof(float) || type == typeof(double)) return true;
            if (type == typeof(sbyte) || type == typeof(byte) || type == typeof(short) || type == typeof(ushort)
                || type == typeof(int) || type == typeof(uint) || type == typeof(long) || type == typeof(ulong)) return true;
            if (type.IsEnum || type == typeof(Guid)) return true;
            if (type == typeof(Vector2) || type == typeof(Float2) || type == typeof(Vector3) || type == typeof(Float3)
                || type == typeof(Vector4) || type == typeof(Float4) || type == typeof(Color) || type == typeof(Quaternion)) return true;
            return typeof(Asset).IsAssignableFrom(type) || typeof(Actor).IsAssignableFrom(type) || typeof(Script).IsAssignableFrom(type);
        }

        private static string FriendlyTypeName(Type type)
        {
            if (type == null) return null;
            if (!type.IsGenericType) return LimitForLog(type.FullName ?? type.Name, 256);
            var definition = type.GetGenericTypeDefinition().FullName ?? type.Name;
            var tick = definition.IndexOf('`');
            if (tick >= 0) definition = definition.Substring(0, tick);
            var arguments = type.GetGenericArguments();
            var names = new string[arguments.Length];
            for (var i = 0; i < arguments.Length; i++) names[i] = FriendlyTypeName(arguments[i]);
            return LimitForLog(definition + "<" + string.Join(", ", names) + ">", 256);
        }

        private static string DescribeException(Exception ex)
        {
            var inner = ex;
            while (inner is TargetInvocationException && inner.InnerException != null) inner = inner.InnerException;
            var message = LimitForLog(inner.Message, 256);
            return (inner.GetType().FullName ?? "Exception") + (string.IsNullOrEmpty(message) ? "" : ": " + message);
        }

        // ---- nested member paths (Path of 1-4 names, like the Editor bridge's v34 runtime writes) ----

        private static string[] RequireMemberPathRequest(string[] path, string plainName, string plainLabel)
        {
            if (path == null) return null;
            if (path.Length < 1 || path.Length > MaxMemberPathDepth)
                throw new McpProtocolException("VALIDATION_FAILED", "Path must contain 1-" + MaxMemberPathDepth + " member names.");
            for (var i = 0; i < path.Length; i++)
            {
                var segment = path[i];
                if (string.IsNullOrEmpty(segment) || segment.Length > 128 || !IsScriptFieldName(segment))
                    throw new McpProtocolException("VALIDATION_FAILED", "Path segment " + i + " must match ^[A-Za-z_][A-Za-z0-9_]*$ and be 1-128 characters (the Type.Member form is not available in a Path).", new McpMemberPathErrorDetails { Path = path, SegmentIndex = i, Segment = segment });
            }
            if (!string.IsNullOrEmpty(plainName) && !string.Equals(plainName, path[0], StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", plainLabel + " must be omitted when Path is given (or equal Path[0]); Path names the whole member chain.");
            return path;
        }

        private static McpProtocolException MemberPathError(string[] path, int index, string message)
        {
            return new McpProtocolException("VALIDATION_FAILED", "Path segment " + index + " ('" + path[index] + "'): " + message, new McpMemberPathErrorDetails { Path = path, SegmentIndex = index, Segment = path[index] });
        }

        // Why a member value cannot be traversed, or null when it can.
        private static string NestedContainerRefusal(Type type, object value)
        {
            if (type == null) return "has no usable type.";
            if (IsSupportedMemberType(type) || type.IsPrimitive || type.IsEnum || type == typeof(string) || type.IsPointer || type.IsByRef)
                return "is a " + (FriendlyTypeName(type) ?? "leaf") + " value and has no nested members to address.";
            if (type.IsValueType)
                return IsEngineTypeName(type.FullName) ? "is the engine structure " + FriendlyTypeName(type) + "; only user-defined structures and classes are traversed." : null;
            if (value == null) return "is null, so it has no nested members to write (create the object first).";
            if (value is FObject) return "is an engine object; assign it as a whole instead of writing into it.";
            if (value is Delegate || value is System.Collections.IEnumerable)
                return "is a collection; arrays, lists and dictionaries are not supported by Path.";
            return null;
        }

        private static McpRtChain ResolveMemberChain(object root, string[] path)
        {
            var count = path.Length;
            var chain = new McpRtChain { Names = new string[count], Slots = new McpRtMember[count], Containers = new object[count] };
            chain.Containers[0] = root;
            for (var i = 0; i < count; i++)
            {
                var container = chain.Containers[i];
                McpRtMember slot = null;
                if (i == 0)
                {
                    try { slot = ResolveMember(container, path[0]); }
                    catch (McpProtocolException ex) { throw MemberPathError(path, 0, ex.Message); }
                    var block = MemberWriteBlockReason(slot, count == 1);
                    if (block != null) throw MemberPathError(path, 0, "cannot be written: " + block);
                }
                else
                {
                    var type = container.GetType();
                    foreach (var candidate in VisibleMembers(type))
                        if (string.Equals(candidate.Name, path[i], StringComparison.Ordinal)) { slot = candidate; break; }
                    if (slot == null)
                        throw MemberPathError(path, i, "is not a public member of " + (type.FullName ?? "unknown") + " (public fields and properties declared in game code, never [HideInEditor]).");
                    if (slot.ReadOnly)
                        throw MemberPathError(path, i, "cannot be written: Member is read-only (no setter or [ReadOnly]).");
                    if (i == count - 1 && !IsSupportedMemberType(slot.ValueType))
                        throw MemberPathError(path, i, "cannot be written: Unsupported type " + (FriendlyTypeName(slot.ValueType) ?? "unknown") + ". Extend Path to a member of it, or use a supported leaf type.");
                }
                chain.Slots[i] = slot;
                chain.Names[i] = slot.Name;
                if (i == count - 1) break;
                object value;
                try { value = slot.GetValue(container); }
                catch (Exception ex) { throw MemberPathError(path, i, "read failed: " + DescribeException(ex)); }
                var refusal = NestedContainerRefusal(slot.ValueType, value);
                if (refusal != null) throw MemberPathError(path, i, refusal);
                chain.Containers[i + 1] = value;
            }
            return chain;
        }

        private static McpRtWritePlan PlanMemberWrite(object root, string[] path, bool nested, bool? boolValue, double? number, string text)
        {
            var chain = ResolveMemberChain(root, path);
            var last = chain.Slots.Length - 1;
            var leaf = chain.Slots[last];
            var coerced = CoerceMemberValue(leaf.ValueType, boolValue, number, text, leaf.Name);
            object before;
            try { before = leaf.GetValue(chain.Containers[last]); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Member '" + leaf.Name + "' read failed: " + DescribeException(ex)); }
            return new McpRtWritePlan { Chain = chain, LeafType = leaf.ValueType, Coerced = coerced, Before = before };
        }

        // Sets the leaf, then writes each parent back up to the root member (a boxed struct is a copy).
        private static void ApplyMemberWrite(McpRtWritePlan plan, string display)
        {
            var chain = plan.Chain;
            var last = chain.Slots.Length - 1;
            var step = last;
            try
            {
                chain.Slots[last].SetValue(chain.Containers[last], plan.Coerced);
                for (step = last - 1; step >= 0; step--)
                    chain.Slots[step].SetValue(chain.Containers[step], chain.Containers[step + 1]);
            }
            catch (Exception ex)
            {
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + display + "' write failed at '" + chain.Names[Math.Max(step, 0)] + "': " + DescribeException(ex));
            }
        }

        // Fresh read of the written leaf through the root (never the plan's copies).
        private static object ReadMemberLeaf(object root, McpRtChain chain, object fallback)
        {
            try
            {
                var current = root;
                for (var i = 0; i < chain.Slots.Length; i++) current = chain.Slots[i].GetValue(current);
                return current;
            }
            catch { return fallback; }
        }

        // ---- value coercion and projection ----

        private static float ParseStrictFloat(string text, string what)
        {
            float value;
            if (!float.TryParse((text ?? "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out value) || float.IsNaN(value) || float.IsInfinity(value))
                throw new McpProtocolException("VALIDATION_FAILED", what + " must be a finite number.");
            return value;
        }

        private static float[] ParseStrictFloatList(string text, int count, string what, string example)
        {
            var parts = (text ?? "").Split(',');
            if (parts.Length != count)
                throw new McpProtocolException("VALIDATION_FAILED", what + " requires exactly " + count + " comma-separated numbers (for example \"" + example + "\").");
            var values = new float[count];
            for (var i = 0; i < count; i++) values[i] = ParseStrictFloat(parts[i], what);
            return values;
        }

        private static Color ParseStrictColor(string text, string what)
        {
            var t = (text ?? "").Trim();
            if (t.StartsWith("#", StringComparison.Ordinal))
            {
                var hex = t.Substring(1);
                if (hex.Length != 6 && hex.Length != 8)
                    throw new McpProtocolException("VALIDATION_FAILED", what + " hex colors must be \"#rrggbb\" or \"#rrggbbaa\".");
                try
                {
                    var r = Convert.ToByte(hex.Substring(0, 2), 16);
                    var g = Convert.ToByte(hex.Substring(2, 2), 16);
                    var b = Convert.ToByte(hex.Substring(4, 2), 16);
                    var a = hex.Length == 8 ? Convert.ToByte(hex.Substring(6, 2), 16) : (byte)255;
                    return new Color(r / 255.0f, g / 255.0f, b / 255.0f, a / 255.0f);
                }
                catch
                {
                    throw new McpProtocolException("VALIDATION_FAILED", what + " hex colors must be \"#rrggbb\" or \"#rrggbbaa\".");
                }
            }
            var parts = t.Split(',');
            if (parts.Length != 3 && parts.Length != 4)
                throw new McpProtocolException("VALIDATION_FAILED", what + " colors must be \"#rrggbb\" or \"r,g,b[,a]\" with finite 0-1 components.");
            var values = new float[parts.Length];
            for (var i = 0; i < parts.Length; i++) values[i] = ParseStrictFloat(parts[i], what);
            return new Color(values[0], values[1], values[2], values.Length == 4 ? values[3] : 1.0f);
        }

        private static ulong EnumBits(Type type, object value)
        {
            return Enum.GetUnderlyingType(type) == typeof(ulong) ? Convert.ToUInt64(value) : unchecked((ulong)Convert.ToInt64(value));
        }

        private static bool IsDefinedEnumMemberValue(Type type, object value)
        {
            if (Enum.IsDefined(type, value)) return true;
            if (!type.IsDefined(typeof(FlagsAttribute), false)) return false;
            try
            {
                ulong all = 0;
                foreach (var defined in Enum.GetValues(type)) all |= EnumBits(type, defined);
                return (EnumBits(type, value) & ~all) == 0;
            }
            catch { return false; }
        }

        private static object CoerceEnumMemberValue(Type type, double? number, string text, string need)
        {
            var shape = need + "an enum name (comma-separated names for flags) or a defined numeric value.";
            object value;
            if (number.HasValue)
            {
                var n = number.Value;
                if (double.IsNaN(n) || double.IsInfinity(n) || Math.Truncate(n) != n) throw new McpProtocolException("VALIDATION_FAILED", shape);
                try { value = Enum.ToObject(type, Convert.ToInt64(n)); }
                catch { throw new McpProtocolException("VALIDATION_FAILED", shape); }
            }
            else
            {
                var trimmed = text == null ? "" : text.Trim();
                // Enum.Parse also accepts raw numeric strings; names only here.
                if (trimmed.Length == 0 || trimmed.Length > 512 || !(char.IsLetter(trimmed[0]) || trimmed[0] == '_')) throw new McpProtocolException("VALIDATION_FAILED", shape);
                try { value = Enum.Parse(type, trimmed, true); }
                catch { throw new McpProtocolException("VALIDATION_FAILED", "Value '" + LimitForLog(trimmed, 128) + "' is not a defined " + (type.FullName ?? "enum") + " value."); }
            }
            if (!IsDefinedEnumMemberValue(type, value))
                throw new McpProtocolException("VALIDATION_FAILED", "Value is not a defined " + (type.FullName ?? "enum") + " value.");
            return value;
        }

        // Asset references are 32-character hex GUIDs only. A cooked game has no editor content database, so path-based lookups do not exist.
        private static Asset CoerceAssetReference(Type assetType, string text, string need)
        {
            const string shape = "a 32-character hex asset GUID (path-based asset lookups are not available in a cooked game), or an empty string to clear.";
            if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + shape);
            if (text.Length == 0) return null;
            Guid id;
            if (!Guid.TryParseExact(text, "N", out id) || id == Guid.Empty) throw new McpProtocolException("VALIDATION_FAILED", need + shape);
            AssetInfo info;
            var known = false;
            try { known = Content.GetAssetInfo(id, out info); }
            catch { known = false; }
            if (!known) throw new McpProtocolException("ASSET_NOT_FOUND", "No asset with GUID " + text + " is registered in this game build.");
            Asset asset = null;
            try { asset = Content.LoadAsync(id, assetType); }
            catch { asset = null; }
            // LoadAsync returns null for a type mismatch.
            if (asset == null)
                throw new McpProtocolException("VALIDATION_FAILED", need + "a " + (assetType.FullName ?? "asset") + " asset; " + text + " is not one.");
            if (asset.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Asset failed to load: " + text);
            return asset;
        }

        private static object CoerceMemberValue(Type type, bool? boolValue, double? number, string text, string memberName)
        {
            var setCount = (boolValue.HasValue ? 1 : 0) + (number.HasValue ? 1 : 0) + (text != null ? 1 : 0);
            if (setCount != 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + memberName + "' requires exactly one of Bool, Number, or Text.");
            var need = "Member '" + memberName + "' (" + (FriendlyTypeName(type) ?? "unknown") + ") requires ";
            if (type.IsEnum) return CoerceEnumMemberValue(type, number, text, need);
            if (typeof(Asset).IsAssignableFrom(type)) return CoerceAssetReference(type, text, need);
            if (typeof(Actor).IsAssignableFrom(type))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an actor GUID string, or an empty string to clear.");
                if (text.Length == 0) return null;
                var reference = RequireActor(text);
                if (!type.IsInstanceOfType(reference))
                    throw new McpProtocolException("VALIDATION_FAILED", need + "an actor of that type, got " + (reference.TypeName ?? "unknown") + ".");
                return reference;
            }
            if (typeof(Script).IsAssignableFrom(type))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a script GUID string, or an empty string to clear.");
                if (text.Length == 0) return null;
                var reference = RequireScript(text);
                if (!type.IsInstanceOfType(reference))
                    throw new McpProtocolException("VALIDATION_FAILED", need + "a script of that type, got " + (reference.TypeName ?? "unknown") + ".");
                return reference;
            }
            if (type == typeof(Quaternion))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z,w\" string.");
                var v = ParseStrictFloatList(text, 4, need + "an \"x,y,z,w\" string", "x,y,z,w");
                return new Quaternion(v[0], v[1], v[2], v[3]);
            }
            return CoerceScalarValue(type, boolValue, number, text, memberName, need);
        }

        private static object CoerceScalarValue(Type type, bool? boolValue, double? number, string text, string memberName, string need)
        {
            if (type == typeof(bool))
            {
                if (!boolValue.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "a boolean value.");
                return boolValue.Value;
            }
            if (type == typeof(string))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a string value.");
                if (text.Length > MaxScriptValueWriteChars)
                    throw new McpProtocolException("VALIDATION_FAILED", "Member '" + memberName + "' exceeds " + MaxScriptValueWriteChars + " characters.");
                return text;
            }
            if (type == typeof(float) || type == typeof(double))
            {
                if (!number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "a numeric value.");
                var n = number.Value;
                if (double.IsNaN(n) || double.IsInfinity(n)) throw new McpProtocolException("VALIDATION_FAILED", need + "a finite numeric value.");
                if (type == typeof(float))
                {
                    if (n < -(double)float.MaxValue || n > (double)float.MaxValue)
                        throw new McpProtocolException("VALIDATION_FAILED", need + "a value within float range.");
                    return (float)n;
                }
                return n;
            }
            if (type == typeof(sbyte) || type == typeof(byte) || type == typeof(short) || type == typeof(ushort)
                || type == typeof(int) || type == typeof(uint) || type == typeof(long) || type == typeof(ulong))
            {
                if (!number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value.");
                var n = number.Value;
                if (double.IsNaN(n) || double.IsInfinity(n) || Math.Truncate(n) != n)
                    throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value.");
                try
                {
                    if (type == typeof(ulong))
                    {
                        var u = Convert.ToUInt64(n);
                        if ((double)u != n) throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value without precision loss.");
                        return u;
                    }
                    double min, max;
                    if (type == typeof(sbyte)) { min = sbyte.MinValue; max = sbyte.MaxValue; }
                    else if (type == typeof(byte)) { min = byte.MinValue; max = byte.MaxValue; }
                    else if (type == typeof(short)) { min = short.MinValue; max = short.MaxValue; }
                    else if (type == typeof(ushort)) { min = ushort.MinValue; max = ushort.MaxValue; }
                    else if (type == typeof(int)) { min = int.MinValue; max = int.MaxValue; }
                    else if (type == typeof(uint)) { min = uint.MinValue; max = uint.MaxValue; }
                    else { min = long.MinValue; max = long.MaxValue; }
                    if (n < min || n > max) throw new McpProtocolException("VALIDATION_FAILED", need + "a value within " + type.Name + " range.");
                    return Convert.ChangeType(Convert.ToInt64(n), type, CultureInfo.InvariantCulture);
                }
                catch (McpProtocolException) { throw; }
                catch { throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value within " + type.Name + " range."); }
            }
            if (type == typeof(Guid))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a 32-character hex GUID string.");
                Guid guid;
                if (!Guid.TryParseExact(text, "N", out guid))
                    throw new McpProtocolException("VALIDATION_FAILED", need + "a 32-character hex GUID string.");
                return guid;
            }
            if (type == typeof(Vector2) || type == typeof(Float2))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y\" string.");
                var v = ParseStrictFloatList(text, 2, need + "an \"x,y\" string", "x,y");
                return type == typeof(Vector2) ? (object)new Vector2(v[0], v[1]) : new Float2(v[0], v[1]);
            }
            if (type == typeof(Vector3) || type == typeof(Float3))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z\" string.");
                var v = ParseStrictFloatList(text, 3, need + "an \"x,y,z\" string", "x,y,z");
                return type == typeof(Vector3) ? (object)new Vector3(v[0], v[1], v[2]) : new Float3(v[0], v[1], v[2]);
            }
            if (type == typeof(Vector4) || type == typeof(Float4))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z,w\" string.");
                var v = ParseStrictFloatList(text, 4, need + "an \"x,y,z,w\" string", "x,y,z,w");
                return type == typeof(Vector4) ? (object)new Vector4(v[0], v[1], v[2], v[3]) : new Float4(v[0], v[1], v[2], v[3]);
            }
            if (type == typeof(Color))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a \"#rrggbb\" or \"r,g,b[,a]\" string.");
                return ParseStrictColor(text, need + "a color");
            }
            throw new McpProtocolException("VALIDATION_FAILED", "Unsupported type " + (type.FullName ?? "unknown") + " for member '" + memberName + "'.");
        }

        private static McpMaterialTypedValue ProjectMemberValue(object raw, Type declaredType)
        {
            if (raw == null) return new McpMaterialTypedValue { Kind = "null", TypeName = declaredType == null ? null : LimitForLog(declaredType.FullName, 256) };
            var text = raw as string;
            if (text != null)
                return new McpMaterialTypedValue { Kind = "string", Text = text.Length <= MaxScriptValueStringChars ? text : text.Substring(0, MaxScriptValueStringChars) + " [truncated]" };
            var type = raw.GetType();
            if (type.IsEnum)
            {
                long numeric = 0;
                var hasNumeric = true;
                try { numeric = unchecked((long)EnumBits(type, raw)); }
                catch { hasNumeric = false; }
                return new McpMaterialTypedValue { Kind = "enum", Integer = hasNumeric ? (long?)numeric : null, Text = LimitForLog(raw.ToString(), MaxScriptValueStringChars), TypeName = LimitForLog(type.FullName, 256) };
            }
            if (raw is bool) return new McpMaterialTypedValue { Kind = "boolean", Boolean = (bool)raw };
            if (raw is sbyte) return new McpMaterialTypedValue { Kind = "integer", Integer = (sbyte)raw };
            if (raw is byte) return new McpMaterialTypedValue { Kind = "integer", Integer = (byte)raw };
            if (raw is short) return new McpMaterialTypedValue { Kind = "integer", Integer = (short)raw };
            if (raw is ushort) return new McpMaterialTypedValue { Kind = "integer", Integer = (ushort)raw };
            if (raw is int) return new McpMaterialTypedValue { Kind = "integer", Integer = (int)raw };
            if (raw is uint) return new McpMaterialTypedValue { Kind = "integer", Integer = (uint)raw };
            if (raw is long) return new McpMaterialTypedValue { Kind = "integer", Integer = (long)raw };
            if (raw is ulong) return new McpMaterialTypedValue { Kind = "integer", Integer = unchecked((long)(ulong)raw) };
            if (raw is float) return new McpMaterialTypedValue { Kind = "number", Number = (float)raw };
            if (raw is double) return new McpMaterialTypedValue { Kind = "number", Number = (double)raw };
            if (raw is Guid) return new McpMaterialTypedValue { Kind = "guid", Text = ((Guid)raw).ToString("N") };
            if (raw is Vector2) { var v = (Vector2)raw; return new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = (float)v.X, Y = (float)v.Y } }; }
            if (raw is Vector3) { var v = (Vector3)raw; return new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = (float)v.X, Y = (float)v.Y, Z = (float)v.Z } }; }
            if (raw is Vector4) { var v = (Vector4)raw; return new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = (float)v.X, Y = (float)v.Y, Z = (float)v.Z, W = (float)v.W } }; }
            if (raw is Float2) { var v = (Float2)raw; return new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = v.X, Y = v.Y } }; }
            if (raw is Float3) { var v = (Float3)raw; return new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = v.X, Y = v.Y, Z = v.Z } }; }
            if (raw is Float4) { var v = (Float4)raw; return new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = v.X, Y = v.Y, Z = v.Z, W = v.W } }; }
            if (raw is Color) { var c = (Color)raw; return new McpMaterialTypedValue { Kind = "color", Vector4 = new McpVector4 { X = c.R, Y = c.G, Z = c.B, W = c.A } }; }
            if (raw is Quaternion) { var v = (Quaternion)raw; return new McpMaterialTypedValue { Kind = "quaternion", Vector4 = new McpVector4 { X = v.X, Y = v.Y, Z = v.Z, W = v.W } }; }
            if (raw is Actor) return new McpMaterialTypedValue { Kind = "actor", Text = ((Actor)raw).ID.ToString("N"), TypeName = LimitForLog(type.FullName, 256) };
            if (raw is Script) return new McpMaterialTypedValue { Kind = "script", Text = ((Script)raw).ID.ToString("N"), TypeName = LimitForLog(type.FullName, 256) };
            // An asset is reported by GUID and type only, never by a path.
            var asset = raw as Asset;
            if (asset != null) return new McpMaterialTypedValue { Kind = "asset", AssetId = asset.ID.ToString("N"), TypeName = LimitForLog(type.FullName, 256) };
            return new McpMaterialTypedValue { Kind = "unavailable", TypeName = LimitForLog(type.FullName, 256) };
        }

        // ---- transport helpers ----

        private static bool IsAnonymousType(Type type)
        {
            return type.Name.StartsWith("<>", StringComparison.Ordinal) && type.IsDefined(typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute), false);
        }

        // FlaxEngine.Json does not serialize anonymous types (they come out as {}), so error details built from one are flattened first.
        private static object PlainForJson(object value)
        {
            return PlainForJson(value, 0);
        }

        private static object PlainForJson(object value, int depth)
        {
            if (value == null || depth > MaxPlainJsonDepth) return value;
            var type = value.GetType();
            var untyped = value as object[];
            if (untyped != null && type.GetElementType() == typeof(object))
            {
                var copy = new object[untyped.Length];
                for (var i = 0; i < untyped.Length; i++) copy[i] = PlainForJson(untyped[i], depth + 1);
                return copy;
            }
            if (!IsAnonymousType(type)) return value;
            var plain = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public))
                plain[property.Name] = PlainForJson(property.GetValue(value, null), depth + 1);
            return plain;
        }

        // Runs fn on the game's update thread and waits for it; the request deadline bounds the wait.
        private static T OnMain<T>(Func<T> fn, long deadlineUnixMs)
        {
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            Scripting.InvokeOnUpdate(() =>
            {
                try
                {
                    if (deadlineUnixMs != 0 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > deadlineUnixMs)
                        throw new McpProtocolException("DEADLINE_EXCEEDED", "Request expired before game execution.");
                    tcs.TrySetResult(fn());
                }
                catch (Exception ex) { tcs.TrySetException(ex); }
            });
            var waitMs = MainThreadTimeoutMs;
            if (deadlineUnixMs != 0)
                waitMs = (int)Math.Max(1, Math.Min(waitMs, deadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            // Task.Wait throws AggregateException when the callback fails, which
            // would erase a stable McpProtocolException code.
            if (!((IAsyncResult)tcs.Task).AsyncWaitHandle.WaitOne(waitMs))
                throw new McpProtocolException("DEADLINE_EXCEEDED", "Game main-thread call timed out.");
            return tcs.Task.GetAwaiter().GetResult();
        }

        private void WriteHeartbeat() { WriteAtomic(BridgePath, JsonSerializer.Serialize(new McpRuntimeBridgeInfo { Pid = Environment.ProcessId, Instance = _instance, ProductName = _productName, EngineVersion = _engineVersion, Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, true)); }

        private static McpResponse Failure(string id, string requestToken, string code, string message, object details = null)
        {
            // Never disclose the active session token to an unauthenticated
            // request. Authenticated failures naturally echo the valid token.
            return new McpResponse { id = id, token = requestToken, ok = false, errorCode = code, error = message, errorDetails = details == null ? null : JsonSerializer.Serialize(PlainForJson(details), false), timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }

        private static bool IsSafeRequestFile(string name) { if (string.IsNullOrEmpty(name) || name.Length > 133 || !name.EndsWith(".json")) return false; for (var i = 0; i < name.Length - 5; i++) { var c = name[i]; if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false; } return true; }
        private static bool IsGuidN(string value) { Guid ignored; return Guid.TryParseExact(value, "N", out ignored); }
        private static void WriteAtomic(string path, string text) { var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp"; File.WriteAllText(temp, text); if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path); }
        private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
        private static string CreateSessionToken() { var bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }

        private void WriteToken(string token)
        {
            // A forced shutdown can leave the previous hidden token behind.
            // Windows rejects overwriting that file until the hidden attribute is cleared.
            try { if (File.Exists(TokenPath)) File.SetAttributes(TokenPath, FileAttributes.Normal); } catch { }
            WriteAtomic(TokenPath, token);
            try { File.SetAttributes(TokenPath, FileAttributes.Hidden); } catch { }
        }

        private static bool ConstantTimeEquals(string a, string b) { if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b) || a.Length != b.Length) return false; var different = 0; for (var i = 0; i < a.Length; i++) different |= a[i] ^ b[i]; return different == 0; }

        private void CleanupOldProcessing()
        {
            foreach (var directory in new[] { Processing, Requests, Responses })
                foreach (var file in Directory.GetFiles(directory, "*.json"))
                    try { if (DateTime.UtcNow - File.GetLastWriteTimeUtc(file) > TimeSpan.FromMinutes(5)) File.Delete(file); } catch { }
        }
    }
}
#endif
#endif
