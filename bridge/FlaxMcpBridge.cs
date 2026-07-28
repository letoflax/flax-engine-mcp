// MCP-BRIDGE-VERSION: 5
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
    public class McpBridgeInfo { public int BridgeVersion = 5; public int ProtocolVersion = 1; public int Pid; public string Project; public string EditorVersion; public long Timestamp; }
    // Request/response intentionally use lower camel case because the Node side
    // parses exact on-disk keys. Heartbeat remains PascalCase for compatibility.
    public class McpRequest { public string id; public string token; public string method; public string paramsJson; public long deadlineUnixMs; }
    public class McpResponse { public string id; public string token; public bool ok; public string errorCode; public string error; public string resultJson; public long timestamp; }
    public class McpStatus { public int BridgeVersion = 5; public int ProtocolVersion = 1; public int Pid; public string EditorVersion; public bool IsPlayMode; public bool IsHeadless; public bool TransactionsSupported = false; }
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

    /// <summary>
    /// File-based RPC bridge. Requests are moved atomically from requests/ into
    /// processing/, executed on Flax's main thread, and responses are atomically
    /// renamed into responses/. Only the allowlisted methods in Dispatch exist.
    /// </summary>
    public sealed class FlaxMcpBridgePlugin : EditorPlugin
    {
        private const int BridgeVersion = 5;
        private const int ProtocolVersion = 1;
        private const int MaxRequestBytes = 128 * 1024;
        private const int MaxParamsBytes = 64 * 1024;
        private const int MaxDeadlineMs = 60 * 1000;
        private const int MainThreadTimeoutMs = 60 * 1000;
        private const int MaxRequestsPerPoll = 4;
        private const int MaxTreeDepth = 64;
        private const int MaxTreeActors = 2000;

        private volatile bool _running;
        private volatile int _busy;
        private long _lastPoll;
        private long _lastHeartbeat;
        private string _token;

        private static string Root { get { return Path.Combine(Globals.ProjectFolder, "Cache", "MCP"); } }
        private static string Requests { get { return Path.Combine(Root, "requests"); } }
        private static string Processing { get { return Path.Combine(Root, "processing"); } }
        private static string Responses { get { return Path.Combine(Root, "responses"); } }
        private static string BridgePath { get { return Path.Combine(Root, "bridge.json"); } }
        private static string TokenPath { get { return Path.Combine(Root, "token"); } }

        public override void InitializeEditor()
        {
            base.InitializeEditor();
            try
            {
                Directory.CreateDirectory(Requests);
                Directory.CreateDirectory(Processing);
                Directory.CreateDirectory(Responses);
                CleanupOldProcessing();
                _token = CreateSessionToken();
                WriteToken(_token);
                WriteHeartbeat();
                _running = true;
                Scripting.Update += OnUpdate;
                Debug.Log("[Flax MCP] Bridge v5 listening at " + Root);
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
                default: throw new McpProtocolException("METHOD_NOT_ALLOWED", "Method is not in the bridge allowlist.");
            }
            return new McpResponse { id = request.id, token = _token, ok = true, resultJson = JsonSerializer.Serialize(result, true), timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }

        // All methods below are invoked on the Editor update thread.
        private static McpStatus Status()
        {
            return new McpStatus { Pid = Environment.ProcessId, EditorVersion = Globals.EngineVersion.ToString(), IsPlayMode = FEditor.IsPlayMode, IsHeadless = FEditor.Instance.IsHeadlessMode };
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
