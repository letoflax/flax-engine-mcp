// MCP-BRIDGE-VERSION: 13
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
using FlaxEditor.Content;
using FlaxEditor.Content.Import;
using FEditor = FlaxEditor.Editor;
using FlaxEngine;
using FlaxEngine.Json;
using FObject = FlaxEngine.Object;

namespace Game.MCP
{
    // Wire DTOs. Public field names are the protocol keys (see bridge/PROTOCOL.md).
    public class McpBridgeInfo { public int BridgeVersion = 13; public int ProtocolVersion = 1; public int Pid; public string Project; public string EditorVersion; public long Timestamp; }
    // Request/response intentionally use lower camel case because the Node side
    // parses exact on-disk keys. Heartbeat remains PascalCase for compatibility.
    public class McpRequest { public string id; public string token; public string method; public string paramsJson; public long deadlineUnixMs; }
    public class McpResponse { public string id; public string token; public bool ok; public string errorCode; public string error; public string errorDetails; public string resultJson; public long timestamp; }
    public class McpStatus { public int BridgeVersion = 13; public int ProtocolVersion = 1; public int Pid; public string EditorVersion; public bool IsPlayMode; public bool IsHeadless; public bool TransactionsSupported = false; public bool EditLeasesSupported = true; public string EditLeaseSemantics = "visible-immediately-no-rollback"; public long ProjectRevision; public string RevisionScope = "bridge-session-known-mutations"; public string LogSessionId; public bool AssetRegistrySupported = true; public bool AssetReferenceGraphSupported = true; public bool AssetImportSupported = true; public bool AssetReimportSupported = true; public bool AssetImportSynchronous = true; public bool AssetReimportSynchronous = false; public bool AssetImportSettingsSupported = false; public bool AssetReferenceLocationsSupported = false; public bool AssetOrganizationSupported = true; public bool AssetOrganizationUndoSupported = false; public bool AssetOrganizationLeaseSupported = false; public string AssetOrganizationAtomicity = "single-content-api-call-not-transactional"; public bool AssetQuarantineDeleteSupported = true; public bool AssetPermanentDeleteSupported = false; public bool OperationStatusSupported = true; public bool OperationCancelSupported = true; public string OperationHandleSemantics = "raw-handles-no-mcp-tasks"; public bool PrefabWorkflowsSupported = true; public bool PrefabCreateSupported = true; public bool PrefabInstantiateSupported = true; public bool PrefabInstanceEnumerationSupported = true; public bool PrefabOverridesSupported = false; public bool PrefabApplyOverridesSupported = false; public bool PrefabRevertOverridesSupported = false; public bool PrefabBreakLinkSupported = false; public bool BuildWorkflowsSupported = true; public bool BuildCancelSupported = true; public bool BuildValidationIsPreflightOnly = true; public string BuildOutputScope = "project-relative-Builds-only"; }
    public class McpSceneRef { public string Id; public string Name; public string Path; public bool Edited; public long ProjectRevision; public long SceneRevision; }
    public class McpVector3 { public float X; public float Y; public float Z; }
    public class McpActorDto
    {
        public string Id; public string TypeName; public string Name; public bool Active; public string ParentId;
        public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles;
        // Position/Scale/EulerAngles are world-space values. The following fields
        // expose the corresponding bounded local-space and hierarchy metadata.
        public McpVector3 LocalPosition; public McpVector3 LocalScale; public McpVector3 LocalEulerAngles;
        public string[] Tags; public bool TagsTruncated; public int Layer; public string LayerName;
        public int ChildrenCount; public bool ActiveInHierarchy; public int StaticFlags; public int OrderInParent;
        public string[] ScriptIds; public McpActorDto[] Children; public long ProjectRevision; public long SceneRevision;
    }
    public class McpScriptDto { public string Id; public string TypeName; public string ActorId; public bool Enabled; public long ProjectRevision; public long SceneRevision; }
    public class McpDeletedDto { public string DeletedId; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpDetachedDto { public string DetachedId; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpDuplicatedDto { public string SourceId; public string NewActorId; public bool Verified; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    internal sealed class McpRevision { public long ProjectRevision; public long SceneRevision; }
    public class McpLeaseBegin { public string SceneId; public string Owner; public int TtlMs = 30000; }
    public class McpLeaseGet { public string SceneId; public string LeaseId; }
    public class McpLeaseRelease { public string LeaseId; }
    public class McpEditLease { public string LeaseId; public string SceneId; public string Owner; public long AcquiredUnixMs; public long ExpiresUnixMs; public string State; public string Semantics = "visible-immediately-no-rollback"; public long ProjectRevision; public long SceneRevision; }
    internal sealed class McpLeaseState { public string LeaseId; public string SceneId; public string Owner; public long AcquiredUnixMs; public long ExpiresUnixMs; }
    internal sealed class McpIdempotencyEntry { public string Method; public string Fingerprint; public object Result; public long ExpiresUnixMs; }
    internal sealed class McpTreeBudget { public int Count; }
    public class McpActorId { public string ActorId; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpActorFind { public string Name; public string TypeName; public string ParentId; public bool? Active; public int MaxResults = 50; }
    public class McpActorCreate { public string TypeName = "FlaxEngine.EmptyActor"; public string Name; public string ParentId; public bool Active = true; public McpVector3 Position; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpActorCreateValidation { public string TypeName; public string ParentId; }
    public class McpActorUpdate { public string ActorId; public string Name; public bool? Active; public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles; public McpVector3 LocalPosition; public McpVector3 LocalScale; public McpVector3 LocalEulerAngles; public int? Layer; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpActorReparent { public string ActorId; public string ParentId; public bool KeepWorldTransform = true; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptAttach { public string ActorId; public string ScriptType; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptId { public string ScriptId; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptUpdate { public string ScriptId; public bool? Enabled; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
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
    public class McpAssetSearch { public string Query; public string Path; public string Type; public string Extension; public string Guid; public string Folder; public bool? HasMissingDependency; public int Limit = 50; public string Cursor; }
    public class McpAssetGet { public string AssetId; public string Path; }
    public class McpAssetGraphRequest { public string AssetId; public string Path; public bool Transitive; public int MaxDepth = 1; public int Limit = 50; public string Cursor; }
    public class McpAssetMetadata { public string Id; public string Path; public string TypeName; public string Extension; public string Folder; }
    public class McpAssetDto { public string Id; public string Path; public string TypeName; public string Extension; public string Folder; public int DependencyCount; public int MissingDependencyCount; public int ReferenceCount; }
    public class McpAssetSearchResult { public McpAssetDto[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    public class McpAssetGetResult { public McpAssetMetadata Asset; public bool ImportSettingsAvailable = false; public string[] Warnings; }
    public class McpAssetDependency { public string FromId; public McpAssetDto Asset; public int Depth; public bool Cycle; }
    public class McpAssetDependenciesResult { public McpAssetDto Root; public McpAssetDependency[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    public class McpAssetReference { public McpAssetDto Asset; public string Kind; }
    public class McpAssetReferencesResult { public McpAssetDto Root; public McpAssetReference[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    // Import settings deliberately remain absent. Flax exposes typed options, but
    // accepting arbitrary serialized settings would require a larger reviewed
    // allowlist; v9 therefore uses the verified default importer settings only.
    public class McpAssetImportStart { public string OperationId; public string IdempotencyKey; public string SourcePath; public long SourceSizeBytes; public long SourceLastWriteUnixMs; public string DestinationPath; public string CollisionPolicy = "error"; public bool DryRun; public string[] AllowedImportRoots; public long MaxSourceBytes; }
    public class McpAssetReimportStart { public string OperationId; public string IdempotencyKey; public string AssetId; public string Path; public bool DryRun; public string[] AllowedImportRoots; public long MaxSourceBytes; }
    public class McpAssetOperationStatusRequest { public string OperationId; }
    public class McpAssetOperation { public string OperationId; public string Kind; public string Phase; public float Progress; public long StartedUnixMs; public long FinishedUnixMs; public string ResultPath; public string ResultAssetId; public bool Renamed; public bool DryRun; public string ErrorCode; public string Error; }
    // v10 asset organization stays intentionally narrow: each request selects a
    // registry asset, provides a Content-relative existing folder and/or a
    // filename-without-extension, and invokes one public Flax Content API.
    public class McpAssetOrganizeRequest { public string AssetId; public string Path; public string Destination; public string Name; public string CollisionPolicy = "error"; public bool DryRun; public string ExpectedPath; public string ExpectedIndexRevision; public int? ConfirmReferenceCount; public bool RequireUnreferenced; public bool Confirm; public string IdempotencyKey; }
    public class McpAssetReferenceImpact { public int DirectReferenceCount; public McpAssetReference[] Sample; public bool Truncated; public string Scope = "direct-public-asset-references"; }
    public class McpAssetOrganizeResult { public string Operation; public McpAssetMetadata Source; public McpAssetMetadata Result; public string IndexRevisionBefore; public string IndexRevisionAfter; public bool DryRun; public bool Renamed; public bool GuidPreserved; public bool ExistingReferencesPreserved; public bool ReferencesRemainBoundToSource; public bool UndoSupported = false; public string Atomicity = "single-content-api-call-not-transactional"; public McpAssetReferenceImpact ReferenceImpact; public string[] Warnings; }
    // Bridge v11's bounded operation record is deliberately generic. It keeps
    // only safe metadata below Cache/MCP/operations; caller input, source paths,
    // tokens, and arbitrary result payloads are never persisted here.
    public class McpOperationRequest { public string OperationId; }
    public class McpOperationCancelRequest { public string OperationId; }
    public class McpOperation
    {
        public string OperationId; public string Kind; public string Phase; public float Progress;
        public string Message; public int Step; public int TotalSteps;
        public long StartedUnixMs; public long UpdatedUnixMs; public long FinishedUnixMs;
        public bool CanCancel; public bool CancelRequested; public string ResultSummary;
        public string ErrorCode; public string Error; public string[] Diagnostics;
    }
    // v13 build requests are deliberately narrow. Output is project-relative
    // under Builds/, custom defines are bounded plain symbols, and the bridge
    // never accepts arbitrary command lines, packaging settings, or presets.
    public class McpBuildRequest { public string OperationId; public string Platform; public string Configuration; public string OutputPath; public bool DryRun; public string[] CustomDefines; }
    public class McpBuildOperationRequest { public string OperationId; }
    public class McpBuildTarget { public string Platform; public string DisplayName; public bool IsHostTarget; public string Availability = "not-preflighted"; }
    public class McpBuildTargetsResult { public McpBuildTarget[] Entries; public string[] Warnings; }
    public class McpBuildValidation { public bool Valid; public string Platform; public string Configuration; public string OutputPath; public bool OutputExists; public bool OutputEmpty; public bool ToolchainPreflightSupported = false; public string[] Warnings; }
    public class McpPrefabCreateFromActor { public string ActorId; public string DestinationPath; public bool AutoLink; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabInstantiate { public string AssetId; public string Path; public string ParentId; public string Name; public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabGetInstances { public string AssetId; public string Path; public string SceneId; public int Limit = 50; public string Cursor; }
    public class McpPrefabActorRequest { public string ActorId; public bool DryRun = true; public bool Confirm; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabCreateResult { public bool DryRun; public bool Created; public string PrefabPath; public string ActorId; public bool AutoLinked; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpPrefabInstantiateResult { public bool DryRun; public McpAssetMetadata Prefab; public McpActorDto Actor; public bool VerifiedLink; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpPrefabInstanceDto { public string ActorId; public string SceneId; public string ParentId; public string Name; public string PrefabId; public string PrefabObjectId; public bool IsPrefabRoot; }
    public class McpPrefabInstancesResult { public McpAssetMetadata Prefab; public McpPrefabInstanceDto[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    internal sealed class McpAssetRecord { public Guid Id; public AssetInfo Info; public string Path; public string Extension; public string Folder; }
    internal sealed class McpAssetGraphIndex { public Dictionary<Guid, McpAssetRecord> ById; public Dictionary<Guid, List<Guid>> Direct; public Dictionary<Guid, int> Missing; public Dictionary<Guid, int> Reverse; }
    internal sealed class McpAssetCursor { public string Method; public string Scope; public string IndexRevision; public int Offset; public long ExpiresUnixMs; }

    /// <summary>
    /// File-based RPC bridge. Requests are moved atomically from requests/ into
    /// processing/, executed on Flax's main thread, and responses are atomically
    /// renamed into responses/. Only the allowlisted methods in Dispatch exist.
    /// </summary>
    public sealed class FlaxMcpBridgePlugin : EditorPlugin
    {
        private const int BridgeVersion = 13;
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
        private const int MaxActorLayer = 31;
        private const int MaxResultBytes = 512 * 1024;
        private const int MaxLogEntries = 2000;
        private const int MaxLogMessageChars = 8192;
        private const int MaxDiagnostics = 200;
        private const int MaxCaptureAgeHours = 24;
        private const int MaxCaptures = 64;
        private const int CaptureCleanupIntervalMs = 60 * 1000;
        private const int MaxCompileLogReadBytes = 2 * 1024 * 1024;
        private const int StaleCompileOperationMs = 5 * 1000;
        private const int MinLeaseTtlMs = 1 * 1000;
        private const int MaxLeaseTtlMs = 5 * 60 * 1000;
        private const int IdempotencyTtlMs = 10 * 60 * 1000;
        private const int MaxIdempotencyEntries = 512;
        // Asset reads use the public Flax 1.12 Content registry. The result
        // pages are small, while registry/graph work has its own explicit cap
        // so an accidental request cannot monopolize the Editor thread.
        private const int MaxAssetPageSize = 200;
        private const int MaxAssetRegistryEntries = 10000;
        private const int MaxAssetGraphEdges = 10000;
        private const int MaxAssetGraphDepth = 16;
        private const int MaxAssetReferenceImpactEntries = 50;
        private const int AssetLoadTimeoutMs = 250;
        private const int AssetCursorTtlMs = 10 * 60 * 1000;
        private const int MaxAssetCursors = 512;
        private const int MaxAssetImportRoots = 32;
        private const int MaxAssetImportOperations = 512;
        private const long MaxAssetImportSourceBytes = 512L * 1024L * 1024L;
        private const int AssetImportOperationTtlMs = 10 * 60 * 1000;
        private const int OperationTtlMs = 10 * 60 * 1000;
        private const int MaxOperations = 512;
        private const int MaxOperationMessageChars = 512;
        private const int MaxOperationDiagnostics = 32;
        private const int MaxPrefabPageSize = 200;
        private const int MaxPrefabInstanceScan = 10000;

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
        // Revision counters are scoped to this bridge Editor session. They advance
        // only for mutations executed through this bridge; no verified Flax 1.12
        // editor event exists here for unsaved manual edits made outside the bridge.
        private long _projectRevision;
        private readonly Dictionary<string, long> _sceneRevisions = new Dictionary<string, long>();
        private readonly Dictionary<string, McpLeaseState> _sceneLeases = new Dictionary<string, McpLeaseState>();
        private readonly Dictionary<string, McpIdempotencyEntry> _idempotency = new Dictionary<string, McpIdempotencyEntry>();
        private readonly Dictionary<string, McpAssetCursor> _assetCursors = new Dictionary<string, McpAssetCursor>();
        private readonly Dictionary<string, McpAssetOperation> _assetImportOperations = new Dictionary<string, McpAssetOperation>();
        private readonly Dictionary<string, string> _assetImportOperationFingerprints = new Dictionary<string, string>();
        // Internal result-path to operation mapping for ContentImporting's worker
        // completion event. Full paths never leave the bridge response DTO.
        private readonly Dictionary<string, string> _pendingReimportsByOutputPath = new Dictionary<string, string>();
        private readonly Dictionary<string, McpOperation> _operations = new Dictionary<string, McpOperation>();
        // Only metadata necessary for a bounded result projection is retained.
        // The persisted generic operation remains the durable source of truth.
        private readonly Dictionary<string, McpBuildRequest> _buildRequests = new Dictionary<string, McpBuildRequest>();

        private static string Root { get { return Path.Combine(Globals.ProjectFolder, "Cache", "MCP"); } }
        private static string Requests { get { return Path.Combine(Root, "requests"); } }
        private static string Processing { get { return Path.Combine(Root, "processing"); } }
        private static string Responses { get { return Path.Combine(Root, "responses"); } }
        private static string BridgePath { get { return Path.Combine(Root, "bridge.json"); } }
        private static string TokenPath { get { return Path.Combine(Root, "token"); } }
        private static string CompileStatePath { get { return Path.Combine(Root, "compile-state.json"); } }
        private static string GenerateStatePath { get { return Path.Combine(Root, "generate-project-state.json"); } }
        private static string Operations { get { return Path.Combine(Root, "operations"); } }
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
                Directory.CreateDirectory(Operations);
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
                Debug.Log("[Flax MCP] Bridge v13 listening at " + Root);
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
            PersistOperations();
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
                case "actor.create": { var q = JsonSerializer.Deserialize<McpActorCreate>(p); result = OnMain(() => ExecuteIdempotent("actor.create", q == null ? null : q.IdempotencyKey, q, () => CreateActor(q)), request.deadlineUnixMs); break; }
                case "actor.update": { var q = JsonSerializer.Deserialize<McpActorUpdate>(p); result = OnMain(() => ExecuteIdempotent("actor.update", q == null ? null : q.IdempotencyKey, q, () => UpdateActor(q)), request.deadlineUnixMs); break; }
                case "actor.delete": { var q = JsonSerializer.Deserialize<McpActorId>(p); result = OnMain(() => ExecuteIdempotent("actor.delete", q == null ? null : q.IdempotencyKey, q, () => DeleteActor(q)), request.deadlineUnixMs); break; }
                case "actor.duplicate": { var q = JsonSerializer.Deserialize<McpActorId>(p); result = OnMain(() => ExecuteIdempotent("actor.duplicate", q == null ? null : q.IdempotencyKey, q, () => DuplicateActor(q)), request.deadlineUnixMs); break; }
                case "actor.reparent": { var q = JsonSerializer.Deserialize<McpActorReparent>(p); result = OnMain(() => ExecuteIdempotent("actor.reparent", q == null ? null : q.IdempotencyKey, q, () => ReparentActor(q)), request.deadlineUnixMs); break; }
                case "script.attach": { var q = JsonSerializer.Deserialize<McpScriptAttach>(p); result = OnMain(() => ExecuteIdempotent("script.attach", q == null ? null : q.IdempotencyKey, q, () => AttachScript(q)), request.deadlineUnixMs); break; }
                case "script.detach": { var q = JsonSerializer.Deserialize<McpScriptId>(p); result = OnMain(() => ExecuteIdempotent("script.detach", q == null ? null : q.IdempotencyKey, q, () => DetachScript(q)), request.deadlineUnixMs); break; }
                case "script.instance_get": result = OnMain(() => ScriptInfo(RequireScript(JsonSerializer.Deserialize<McpScriptId>(p).ScriptId)), request.deadlineUnixMs); break;
                case "script.instance_update": { var q = JsonSerializer.Deserialize<McpScriptUpdate>(p); result = OnMain(() => ExecuteIdempotent("script.instance_update", q == null ? null : q.IdempotencyKey, q, () => UpdateScript(q)), request.deadlineUnixMs); break; }
                case "edit.undo": result = OnMain(Undo, request.deadlineUnixMs); break;
                case "edit.redo": result = OnMain(Redo, request.deadlineUnixMs); break;
                case "edit.lease_begin": result = OnMain(() => BeginLease(JsonSerializer.Deserialize<McpLeaseBegin>(p)), request.deadlineUnixMs); break;
                case "edit.lease_get": result = OnMain(() => GetLease(JsonSerializer.Deserialize<McpLeaseGet>(p)), request.deadlineUnixMs); break;
                case "edit.lease_commit": result = OnMain(() => CommitLease(JsonSerializer.Deserialize<McpLeaseRelease>(p)), request.deadlineUnixMs); break;
                case "edit.lease_release": result = OnMain(() => ReleaseLease(JsonSerializer.Deserialize<McpLeaseRelease>(p)), request.deadlineUnixMs); break;
                // Phase 2: code operations intentionally acknowledge work quickly.
                // A compile can reload this plugin, so callers poll status instead of
                // keeping a request open across the reload boundary.
                case "code.status": result = OnMain(CodeStatus, request.deadlineUnixMs); break;
                case "code.compile_start": result = OnMain(() => StartCompile(JsonSerializer.Deserialize<McpCompileStart>(p)), request.deadlineUnixMs); break;
                case "code.diagnostics": result = GetDiagnostics(JsonSerializer.Deserialize<McpDiagnosticsRequest>(p)); break;
                case "code.generate_project_start": result = OnMain(StartGenerateProject, request.deadlineUnixMs); break;
                case "code.generate_project_status": result = GetGenerateProjectStatus(); break;
                case "operation.status": result = OnMain(() => GetOperation(JsonSerializer.Deserialize<McpOperationRequest>(p)), request.deadlineUnixMs); break;
                case "operation.cancel": result = OnMain(() => CancelOperation(JsonSerializer.Deserialize<McpOperationCancelRequest>(p)), request.deadlineUnixMs); break;
                case "build.list_targets": result = OnMain(BuildTargets, request.deadlineUnixMs); break;
                case "build.validate": result = OnMain(() => ValidateBuild(JsonSerializer.Deserialize<McpBuildRequest>(p)), request.deadlineUnixMs); break;
                case "build.cook": { var q = JsonSerializer.Deserialize<McpBuildRequest>(p); result = OnMain(() => ExecuteIdempotent("build.cook", q == null ? null : q.OperationId, q, () => StartBuild(q)), request.deadlineUnixMs); break; }
                case "build.status": result = OnMain(() => GetBuildStatus(JsonSerializer.Deserialize<McpBuildOperationRequest>(p), false), request.deadlineUnixMs); break;
                case "build.result": result = OnMain(() => GetBuildStatus(JsonSerializer.Deserialize<McpBuildOperationRequest>(p), true), request.deadlineUnixMs); break;
                case "build.cancel": result = OnMain(() => CancelBuild(JsonSerializer.Deserialize<McpBuildOperationRequest>(p)), request.deadlineUnixMs); break;
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
                case "asset.search": result = OnMain(() => AssetSearch(JsonSerializer.Deserialize<McpAssetSearch>(p)), request.deadlineUnixMs); break;
                case "asset.get": result = OnMain(() => AssetGet(JsonSerializer.Deserialize<McpAssetGet>(p)), request.deadlineUnixMs); break;
                case "asset.dependencies": result = OnMain(() => AssetDependencies(JsonSerializer.Deserialize<McpAssetGraphRequest>(p)), request.deadlineUnixMs); break;
                case "asset.find_references": result = OnMain(() => AssetFindReferences(JsonSerializer.Deserialize<McpAssetGraphRequest>(p)), request.deadlineUnixMs); break;
                case "asset.import_start": { var q = JsonSerializer.Deserialize<McpAssetImportStart>(p); result = OnMain(() => ExecuteIdempotent("asset.import_start", q == null ? null : q.IdempotencyKey, AssetImportFingerprintInput(q), () => StartAssetImport(q)), request.deadlineUnixMs); break; }
                case "asset.import_status": result = OnMain(() => GetAssetImportOperation(JsonSerializer.Deserialize<McpAssetOperationStatusRequest>(p), "import"), request.deadlineUnixMs); break;
                case "asset.reimport_start": { var q = JsonSerializer.Deserialize<McpAssetReimportStart>(p); result = OnMain(() => ExecuteIdempotent("asset.reimport_start", q == null ? null : q.IdempotencyKey, AssetReimportFingerprintInput(q), () => StartAssetReimport(q)), request.deadlineUnixMs); break; }
                case "asset.reimport_status": result = OnMain(() => GetAssetImportOperation(JsonSerializer.Deserialize<McpAssetOperationStatusRequest>(p), "reimport"), request.deadlineUnixMs); break;
                case "asset.move": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.move", q == null ? null : q.IdempotencyKey, q, () => MoveAsset(q)), request.deadlineUnixMs); break; }
                case "asset.rename": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.rename", q == null ? null : q.IdempotencyKey, q, () => RenameAsset(q)), request.deadlineUnixMs); break; }
                case "asset.duplicate": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.duplicate", q == null ? null : q.IdempotencyKey, q, () => DuplicateAsset(q)), request.deadlineUnixMs); break; }
                case "asset.delete": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.delete", q == null ? null : q.IdempotencyKey, q, () => QuarantineDeleteAsset(q)), request.deadlineUnixMs); break; }
                case "prefab.create_from_actor": { var q = JsonSerializer.Deserialize<McpPrefabCreateFromActor>(p); result = OnMain(() => ExecuteIdempotent("prefab.create_from_actor", q == null ? null : q.IdempotencyKey, q, () => CreatePrefabFromActor(q)), request.deadlineUnixMs); break; }
                case "prefab.instantiate": { var q = JsonSerializer.Deserialize<McpPrefabInstantiate>(p); result = OnMain(() => ExecuteIdempotent("prefab.instantiate", q == null ? null : q.IdempotencyKey, q, () => InstantiatePrefab(q)), request.deadlineUnixMs); break; }
                case "prefab.get_instances": result = OnMain(() => GetPrefabInstances(JsonSerializer.Deserialize<McpPrefabGetInstances>(p)), request.deadlineUnixMs); break;
                case "prefab.get_overrides": result = OnMain(() => UnsupportedPrefabOperation("prefab_get_overrides", JsonSerializer.Deserialize<McpPrefabActorRequest>(p)), request.deadlineUnixMs); break;
                case "prefab.revert_overrides": result = OnMain(() => UnsupportedPrefabOperation("prefab_revert_overrides", JsonSerializer.Deserialize<McpPrefabActorRequest>(p)), request.deadlineUnixMs); break;
                case "prefab.apply_overrides": result = OnMain(() => UnsupportedPrefabOperation("prefab_apply_overrides", JsonSerializer.Deserialize<McpPrefabActorRequest>(p)), request.deadlineUnixMs); break;
                case "prefab.break_link": result = OnMain(() => UnsupportedPrefabOperation("prefab_break_link", JsonSerializer.Deserialize<McpPrefabActorRequest>(p)), request.deadlineUnixMs); break;
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
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                return new McpStatus { Pid = Environment.ProcessId, EditorVersion = Globals.EngineVersion.ToString(), IsPlayMode = FEditor.IsPlayMode, IsHeadless = FEditor.Instance.IsHeadlessMode, LogSessionId = _logSessionId, ProjectRevision = _projectRevision };
            }
        }

        // Asset discovery deliberately uses only Flax 1.12's public managed
        // Content API: registry enumeration/metadata and Asset.GetReferences.
        // No Content Browser internals, binary scanning, reflection, import
        // settings, or serialized-property inspection is used here.
        private McpAssetSearchResult AssetSearch(McpAssetSearch request)
        {
            if (request == null) request = new McpAssetSearch();
            ValidateAssetSearch(request);
            var records = BuildAssetRegistry();
            var graph = BuildAssetGraphIndex(records);
            var scope = AssetSearchScope(request);
            var revision = AssetIndexRevision(records);
            var offset = GetAssetCursorOffset(request.Cursor, "asset.search", scope, revision);
            var filtered = new List<McpAssetRecord>();
            Guid guidFilter = Guid.Empty;
            var hasGuidFilter = !string.IsNullOrEmpty(request.Guid);
            if (hasGuidFilter) Guid.TryParseExact(request.Guid, "N", out guidFilter);
            foreach (var record in records)
            {
                if (hasGuidFilter && record.Id != guidFilter) continue;
                if (!MatchesAssetText(record.Path, request.Query) && !MatchesAssetText(record.Info.TypeName, request.Query)) continue;
                if (!MatchesAssetText(record.Path, request.Path)) continue;
                if (!MatchesAssetType(record.Info.TypeName, request.Type)) continue;
                if (!string.IsNullOrEmpty(request.Extension) && !string.Equals(record.Extension, request.Extension, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrEmpty(request.Folder) && !IsAssetInFolder(record.Folder, request.Folder)) continue;
                if (request.HasMissingDependency.HasValue && (graph.Missing[record.Id] > 0) != request.HasMissingDependency.Value) continue;
                filtered.Add(record);
            }
            var page = AssetPage(filtered, offset, request.Limit, record => AssetDto(record, graph));
            return new McpAssetSearchResult
            {
                Entries = page.Entries,
                HasMore = page.HasMore,
                NextCursor = page.HasMore ? CreateAssetCursor("asset.search", scope, revision, page.NextOffset) : null,
                IndexRevision = revision,
                Warnings = AssetMetadataWarnings(),
            };
        }

        private McpAssetGetResult AssetGet(McpAssetGet request)
        {
            var records = BuildAssetRegistry();
            var record = ResolveAssetRecord(request, records);
            return new McpAssetGetResult
            {
                Asset = AssetMetadata(record),
                Warnings = AssetMetadataWarnings(),
            };
        }

        private McpAssetDependenciesResult AssetDependencies(McpAssetGraphRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset dependency parameters are required.");
            ValidateAssetGraphRequest(request);
            var records = BuildAssetRegistry();
            var root = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, records);
            var graph = BuildAssetGraphIndex(records);
            var maxDepth = request.Transitive ? request.MaxDepth : 1;
            var entries = new List<McpAssetDependency>();
            var ancestors = new List<Guid> { root.Id };
            var expanded = new HashSet<Guid> { root.Id };
            CollectAssetDependencies(root.Id, 0, maxDepth, ancestors, expanded, graph, entries);
            entries.Sort((a, b) =>
            {
                var depth = a.Depth.CompareTo(b.Depth);
                if (depth != 0) return depth;
                var from = string.Compare(a.FromId, b.FromId, StringComparison.Ordinal);
                if (from != 0) return from;
                return string.Compare(a.Asset.Path, b.Asset.Path, StringComparison.OrdinalIgnoreCase);
            });
            var scope = "asset.dependencies|" + root.Id.ToString("N") + "|" + (request.Transitive ? "transitive" : "direct") + "|" + maxDepth;
            var revision = AssetIndexRevision(records);
            var offset = GetAssetCursorOffset(request.Cursor, "asset.dependencies", scope, revision);
            var page = DependencyPage(entries, offset, request.Limit);
            return new McpAssetDependenciesResult
            {
                Root = AssetDto(root, graph),
                Entries = page.Entries,
                HasMore = page.HasMore,
                NextCursor = page.HasMore ? CreateAssetCursor("asset.dependencies", scope, revision, page.NextOffset) : null,
                IndexRevision = revision,
                Warnings = AssetGraphWarnings(),
            };
        }

        private McpAssetReferencesResult AssetFindReferences(McpAssetGraphRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset reference parameters are required.");
            ValidateAssetReferenceRequest(request);
            var records = BuildAssetRegistry();
            var root = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, records);
            var graph = BuildAssetGraphIndex(records);
            var entries = new List<McpAssetReference>();
            foreach (var pair in graph.Direct)
            {
                if (!pair.Value.Contains(root.Id)) continue;
                McpAssetRecord source;
                if (!graph.ById.TryGetValue(pair.Key, out source)) continue;
                entries.Add(new McpAssetReference { Asset = AssetDto(source, graph), Kind = AssetReferenceKind(source) });
            }
            entries.Sort((a, b) =>
            {
                var path = string.Compare(a.Asset.Path, b.Asset.Path, StringComparison.OrdinalIgnoreCase);
                return path != 0 ? path : string.Compare(a.Asset.Id, b.Asset.Id, StringComparison.Ordinal);
            });
            var scope = "asset.find_references|" + root.Id.ToString("N");
            var revision = AssetIndexRevision(records);
            var offset = GetAssetCursorOffset(request.Cursor, "asset.find_references", scope, revision);
            var page = ReferencePage(entries, offset, request.Limit);
            return new McpAssetReferencesResult
            {
                Root = AssetDto(root, graph),
                Entries = page.Entries,
                HasMore = page.HasMore,
                NextCursor = page.HasMore ? CreateAssetCursor("asset.find_references", scope, revision, page.NextOffset) : null,
                IndexRevision = revision,
                Warnings = AssetGraphWarnings(),
            };
        }

        // Asset organization uses only the public managed Flax 1.12 APIs that
        // were compile-probed against the installed editor: Content.RenameAsset,
        // ContentDatabaseModule.Move, and ContentDatabaseModule.Copy. There is
        // no File.Move/File.Copy fallback and no reflection-based dispatch.
        private McpAssetOrganizeResult MoveAsset(McpAssetOrganizeRequest request)
        {
            return OrganizeAsset("move", request);
        }

        private McpAssetOrganizeResult RenameAsset(McpAssetOrganizeRequest request)
        {
            return OrganizeAsset("rename", request);
        }

        private McpAssetOrganizeResult DuplicateAsset(McpAssetOrganizeRequest request)
        {
            return OrganizeAsset("duplicate", request);
        }

        // Deletion is intentionally a guarded quarantine move. The bridge
        // never invokes ContentDatabase.Delete or a filesystem delete API:
        // recovery remains possible through the Content Browser.
        private McpAssetOrganizeResult QuarantineDeleteAsset(McpAssetOrganizeRequest request)
        {
            return OrganizeAsset("delete", request);
        }

        private McpAssetOrganizeResult OrganizeAsset(string operation, McpAssetOrganizeRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset organization parameters are required.");
            ValidateAssetOrganizeRequest(operation, request);
            EnsureAssetOrganizeEditorReady();

            var records = BuildAssetRegistry();
            var indexRevisionBefore = AssetIndexRevision(records);
            var source = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, records);
            ValidateAssetOrganizationExpectation(request, source, indexRevisionBefore);
            var graph = BuildAssetGraphIndex(records);
            var impact = AssetReferenceImpact(source.Id, graph);
            if (operation == "delete") ValidateAssetDeleteConfirmation(request, impact);
            var sourceMetadata = AssetMetadata(source);
            var sourceAbsolutePath = ResolveExistingContentAssetPath(source);
            var output = ResolveAssetOrganizationOutput(operation, request, source, records, sourceAbsolutePath, out var renamed, out var noChange);
            var outputRelativePath = ProjectContentRelativePath(output);
            var preview = AssetMetadataAtPath(source, outputRelativePath, operation == "duplicate" ? null : source.Id);
            var common = new McpAssetOrganizeResult
            {
                Operation = operation,
                Source = sourceMetadata,
                Result = preview,
                IndexRevisionBefore = indexRevisionBefore,
                DryRun = request.DryRun,
                Renamed = renamed,
                GuidPreserved = operation != "duplicate",
                ExistingReferencesPreserved = true,
                ReferencesRemainBoundToSource = operation == "duplicate",
                ReferenceImpact = impact,
                Warnings = AssetOrganizationWarnings(operation),
            };

            if (request.DryRun || noChange)
            {
                common.IndexRevisionAfter = indexRevisionBefore;
                if (noChange) common.Warnings = AppendWarning(common.Warnings, "The requested path already matches the selected asset; no Content mutation was made.");
                return common;
            }

            try
            {
                var contentItem = FEditor.Instance.ContentDatabase.FindAsset(source.Id);
                if (contentItem == null) throw new McpProtocolException("ASSET_OPERATION_FAILED", "The selected asset is unavailable in the Editor Content database.");
                if (operation == "move" || operation == "delete")
                {
                    // Public Editor Content Database API. It updates the Editor
                    // Content database rather than performing a raw file rename.
                    FEditor.Instance.ContentDatabase.Move(contentItem, output);
                }
                else if (operation == "rename")
                {
                    // Public Content API returns true on failure.
                    if (Content.RenameAsset(sourceAbsolutePath, output))
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not rename the selected Content asset.");
                }
                else
                {
                    // Public Editor Content Database API. It assigns a new asset
                    // identity; existing references intentionally remain pointed
                    // at the source asset.
                    FEditor.Instance.ContentDatabase.Copy(contentItem, output);
                }
            }
            catch (McpProtocolException)
            {
                throw;
            }
            catch (Exception)
            {
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not organize the selected Content asset.");
            }

            var afterRecords = BuildAssetRegistry();
            McpAssetRecord resultRecord = null;
            if (operation == "duplicate")
            {
                foreach (var record in afterRecords)
                {
                    if (record.Id != source.Id && string.Equals(record.Path, outputRelativePath, StringComparison.OrdinalIgnoreCase)) { resultRecord = record; break; }
                }
            }
            else
            {
                foreach (var record in afterRecords)
                {
                    if (record.Id == source.Id) { resultRecord = record; break; }
                }
            }
            if (resultRecord == null || !string.Equals(resultRecord.Path, outputRelativePath, StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor did not report the expected Content registry change.");

            common.Result = AssetMetadata(resultRecord);
            common.GuidPreserved = operation != "duplicate" && resultRecord.Id == source.Id;
            common.IndexRevisionAfter = AssetIndexRevision(afterRecords);
            return common;
        }

        private static void ValidateAssetOrganizeRequest(string operation, McpAssetOrganizeRequest request)
        {
            ValidateAssetSelector(request.AssetId, request.Path);
            if (operation == "move" || operation == "duplicate" || operation == "delete") ValidateProjectContentPath(request.Destination, true);
            if (operation == "rename" || operation == "duplicate") ValidateAssetOrganizationName(request.Name);
            if (!string.Equals(request.CollisionPolicy, "error", StringComparison.Ordinal) && !string.Equals(request.CollisionPolicy, "rename", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "CollisionPolicy must be error or rename.");
            if (!string.IsNullOrEmpty(request.ExpectedPath)) ValidateProjectContentPath(request.ExpectedPath, false);
            if (!string.IsNullOrEmpty(request.ExpectedIndexRevision) && !IsSha256(request.ExpectedIndexRevision))
                throw new McpProtocolException("VALIDATION_FAILED", "ExpectedIndexRevision must be a 64-character SHA-256 digest.");
            if (!string.IsNullOrEmpty(request.IdempotencyKey) && (request.IdempotencyKey.Length > 128 || !IsIdempotencyKey(request.IdempotencyKey)))
                throw new McpProtocolException("VALIDATION_FAILED", "IdempotencyKey must contain only letters, digits, dot, underscore, colon, or hyphen.");
            if (operation == "delete" && !request.DryRun && !request.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Confirm must be true before an asset can be moved into quarantine.");
        }

        private static void ValidateAssetDeleteConfirmation(McpAssetOrganizeRequest request, McpAssetReferenceImpact impact)
        {
            if (request.DryRun) return;
            if (!request.ConfirmReferenceCount.HasValue && !request.RequireUnreferenced)
                throw new McpProtocolException("VALIDATION_FAILED", "ConfirmReferenceCount or RequireUnreferenced:true is required before an asset can be moved into quarantine.");
            if (request.RequireUnreferenced && impact.DirectReferenceCount != 0)
                throw new McpProtocolException("ASSET_REFERENCE_CONFLICT", "The selected asset still has direct public references and cannot be quarantined as unreferenced.", new { RequireUnreferenced = true, CurrentReferenceCount = impact.DirectReferenceCount });
            if (request.ConfirmReferenceCount.HasValue && request.ConfirmReferenceCount.Value != impact.DirectReferenceCount)
                throw new McpProtocolException("ASSET_REFERENCE_CONFLICT", "The selected asset's direct reference count changed after confirmation.", new { ConfirmReferenceCount = request.ConfirmReferenceCount.Value, CurrentReferenceCount = impact.DirectReferenceCount });
        }

        private static void ValidateAssetOrganizationExpectation(McpAssetOrganizeRequest request, McpAssetRecord source, string currentIndexRevision)
        {
            if (!string.IsNullOrEmpty(request.ExpectedPath))
            {
                var expected = ValidateProjectContentPath(request.ExpectedPath, false);
                if (!string.Equals(source.Path, expected, StringComparison.OrdinalIgnoreCase))
                    throw new McpProtocolException("ASSET_REVISION_CONFLICT", "The selected asset path changed after it was read.", new { AssetId = source.Id.ToString("N"), ExpectedPath = expected, CurrentPath = source.Path, CurrentIndexRevision = currentIndexRevision });
            }
            if (!string.IsNullOrEmpty(request.ExpectedIndexRevision) && !string.Equals(request.ExpectedIndexRevision, currentIndexRevision, StringComparison.Ordinal))
                throw new McpProtocolException("ASSET_REVISION_CONFLICT", "The Content registry changed after it was read.", new { ExpectedIndexRevision = request.ExpectedIndexRevision, CurrentIndexRevision = currentIndexRevision });
        }

        private static string ResolveExistingContentAssetPath(McpAssetRecord source)
        {
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var relative = source.Path.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar);
            var candidate = CanonicalExistingPath(Path.Combine(content, relative), true);
            if (!PathIsWithin(content, candidate)) throw new McpProtocolException("ASSET_OPERATION_FAILED", "The selected asset is no longer contained by project Content.");
            return candidate;
        }

        private static string ResolveAssetOrganizationOutput(string operation, McpAssetOrganizeRequest request, McpAssetRecord source, List<McpAssetRecord> records, string sourceAbsolutePath, out bool renamed, out bool noChange)
        {
            var sourceExtension = Path.GetExtension(source.Path);
            var destination = operation == "rename" ? source.Folder : ValidateProjectContentPath(request.Destination, true);
            var destinationFolder = ResolveExistingContentFolder(destination);
            var name = operation == "move" || operation == "delete" ? Path.GetFileNameWithoutExtension(source.Path) : request.Name;
            var requested = Path.Combine(destinationFolder, name + sourceExtension);
            var output = Path.GetFullPath(requested);
            if (string.Equals(output, sourceAbsolutePath, PathComparison))
            {
                renamed = false;
                noChange = true;
                return output;
            }
            noChange = false;
            renamed = false;
            if (!AssetOutputExists(output, records, source.Id)) return output;
            if (string.Equals(request.CollisionPolicy, "error", StringComparison.Ordinal))
                throw new McpProtocolException("FILE_EXISTS", "An asset already exists at the requested destination.");
            for (var index = 1; index <= 999; index++)
            {
                var candidate = Path.Combine(destinationFolder, name + "-" + index + sourceExtension);
                if (!AssetOutputExists(candidate, records, source.Id))
                {
                    renamed = true;
                    return candidate;
                }
            }
            throw new McpProtocolException("FILE_EXISTS", "Could not find a collision-free asset destination.");
        }

        private static string ResolveExistingContentFolder(string destination)
        {
            var normalized = ValidateProjectContentPath(destination, true);
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var inside = normalized == "Content" ? "" : normalized.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar);
            var folder = Path.GetFullPath(Path.Combine(content, inside));
            if (!Directory.Exists(folder)) throw new McpProtocolException("VALIDATION_FAILED", "Asset destination folder does not exist in project Content.");
            var canonical = CanonicalExistingPath(folder, false);
            if (!PathIsWithin(content, canonical)) throw new McpProtocolException("VALIDATION_FAILED", "Asset destination folder resolves outside project Content.");
            return canonical;
        }

        private static bool AssetOutputExists(string absolutePath, List<McpAssetRecord> records, Guid sourceId)
        {
            if (File.Exists(absolutePath) || Directory.Exists(absolutePath)) return true;
            var relative = ProjectContentRelativePath(absolutePath);
            foreach (var record in records)
            {
                if (record.Id != sourceId && string.Equals(record.Path, relative, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static void ValidateAssetOrganizationName(string value)
        {
            ValidateAssetText(value, 128, "Name");
            if (string.IsNullOrEmpty(value) || value == "." || value == ".." || value.IndexOfAny(new[] { '<', '>', ':', '"', '/', '\\', '|', '?', '*' }) >= 0 || value.IndexOf('.') >= 0 || value.EndsWith(" ", StringComparison.Ordinal) || value.EndsWith(".", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Name must be a filename without an extension or path separators.");
        }

        private static bool IsSha256(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != 64) return false;
            foreach (var character in value) if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F'))) return false;
            return true;
        }

        private static bool IsIdempotencyKey(string value)
        {
            foreach (var character in value) if (!(char.IsLetterOrDigit(character) || character == '.' || character == '_' || character == ':' || character == '-')) return false;
            return true;
        }

        private static McpAssetReferenceImpact AssetReferenceImpact(Guid assetId, McpAssetGraphIndex graph)
        {
            var all = new List<McpAssetReference>();
            foreach (var pair in graph.Direct)
            {
                if (!pair.Value.Contains(assetId)) continue;
                McpAssetRecord source;
                if (!graph.ById.TryGetValue(pair.Key, out source)) continue;
                all.Add(new McpAssetReference { Asset = AssetDto(source, graph), Kind = AssetReferenceKind(source) });
            }
            all.Sort((a, b) =>
            {
                var path = string.Compare(a.Asset.Path, b.Asset.Path, StringComparison.OrdinalIgnoreCase);
                return path != 0 ? path : string.Compare(a.Asset.Id, b.Asset.Id, StringComparison.Ordinal);
            });
            var count = Math.Min(MaxAssetReferenceImpactEntries, all.Count);
            var sample = new McpAssetReference[count];
            for (var index = 0; index < count; index++) sample[index] = all[index];
            return new McpAssetReferenceImpact { DirectReferenceCount = all.Count, Sample = sample, Truncated = all.Count > count };
        }

        private static McpAssetMetadata AssetMetadataAtPath(McpAssetRecord source, string path, Guid? id)
        {
            var extension = Path.GetExtension(path);
            var folder = Path.GetDirectoryName(path);
            return new McpAssetMetadata { Id = id.HasValue ? id.Value.ToString("N") : null, Path = path, TypeName = source.Info.TypeName, Extension = extension == null ? "" : extension.ToLowerInvariant(), Folder = string.IsNullOrEmpty(folder) ? "Content" : folder.Replace('\\', '/') };
        }

        private static string[] AssetOrganizationWarnings(string operation)
        {
            var warnings = new List<string>
            {
                "Flax 1.12 public Content APIs do not expose a verified undo record for this asset operation; edit_undo is not guaranteed to reverse it.",
                "Asset organization is one Content API call, not an atomic multi-operation transaction; the bridge never falls back to filesystem rename or copy.",
                "Reference impact contains at most 50 direct public Asset.GetReferences sources and never actor or property locations.",
                "Asset organization is not covered by v7 scene edit leases because those leases are scene-scoped.",
                "The bridge does not save project content automatically.",
            };
            if (operation == "duplicate") warnings.Add("Duplicate creates a distinct asset identity; existing references remain bound to the source asset.");
            else if (operation == "delete") warnings.Add("asset.delete is a quarantine move, not a permanent deletion. The selected GUID and existing references are preserved; restore it with asset_move or the Content Browser.");
            else warnings.Add("Move/rename is expected to preserve the selected asset GUID and existing references; the bridge verifies the returned Content registry entry.");
            return warnings.ToArray();
        }

        private static string[] AppendWarning(string[] warnings, string warning)
        {
            var result = new List<string>(warnings ?? new string[0]) { warning };
            return result.ToArray();
        }

        // v9 imports use only direct public managed APIs: Editor.Import for new
        // assets and BinaryAsset.Reimport for existing assets. No dialog, shell
        // launch, filesystem-copy fallback, or reflection-based importer call is
        // used. Both operations finish synchronously in Flax 1.12; operation
        // records exist solely for safe retry adoption and uniform polling.
        private static object AssetImportFingerprintInput(McpAssetImportStart request)
        {
            if (request == null) return new { Missing = true };
            return new { request.SourcePath, request.SourceSizeBytes, request.SourceLastWriteUnixMs, request.DestinationPath, request.CollisionPolicy, request.DryRun, request.AllowedImportRoots, request.MaxSourceBytes };
        }

        private static object AssetReimportFingerprintInput(McpAssetReimportStart request)
        {
            if (request == null) return new { Missing = true };
            return new { request.AssetId, request.Path, request.DryRun, request.AllowedImportRoots, request.MaxSourceBytes };
        }

        private McpAssetOperation StartAssetImport(McpAssetImportStart request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset import parameters are required.");
            var fingerprint = Fingerprint(JsonSerializer.Serialize(AssetImportFingerprintInput(request), false));
            bool adopted;
            var operation = BeginAssetImportOperation(request.OperationId, "import", fingerprint, request.DryRun, out adopted);
            if (adopted) return operation;
            try
            {
                EnsureAssetImportEditorReady();
                var source = ValidateAssetImportSource(request.SourcePath, request.AllowedImportRoots, request.MaxSourceBytes, request.SourceSizeBytes, request.SourceLastWriteUnixMs);
                bool renamed;
                var output = ResolveAssetImportOutput(request.DestinationPath, request.CollisionPolicy, out renamed);
                operation.ResultPath = ProjectContentRelativePath(output);
                operation.Renamed = renamed;
                if (request.DryRun)
                {
                    FinishAssetImportOperation(operation, "dry_run", null, null);
                    return CopyAssetImportOperation(operation);
                }
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                // A destination directory may have appeared as a junction while
                // this request was queued. Re-check it immediately before import.
                EnsureAssetImportOutputParent(output);
                if (FEditor.Import(source, output))
                    throw new McpProtocolException("IMPORT_FAILED", "Flax Editor failed to import the allowlisted source.");
                FinishAssetImportOperation(operation, "succeeded", null, null);
                return CopyAssetImportOperation(operation);
            }
            catch (McpProtocolException ex)
            {
                FinishAssetImportOperation(operation, "failed", ex.Code, LimitForLog(ex.Message, 512));
                throw;
            }
            catch (Exception)
            {
                FinishAssetImportOperation(operation, "failed", "IMPORT_FAILED", "Flax Editor failed to import the allowlisted source.");
                throw new McpProtocolException("IMPORT_FAILED", "Flax Editor failed to import the allowlisted source.");
            }
        }

        private McpAssetOperation StartAssetReimport(McpAssetReimportStart request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset reimport parameters are required.");
            var fingerprint = Fingerprint(JsonSerializer.Serialize(AssetReimportFingerprintInput(request), false));
            bool adopted;
            var operation = BeginAssetImportOperation(request.OperationId, "reimport", fingerprint, request.DryRun, out adopted);
            if (adopted) return operation;
            try
            {
                EnsureAssetImportEditorReady();
                if (request.AllowedImportRoots == null || request.AllowedImportRoots.Length == 0)
                    throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Asset reimport requires at least one configured import root.");
                var record = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, BuildAssetRegistry());
                Asset loaded = null;
                try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
                var binary = loaded as BinaryAsset;
                if (binary == null || binary.LastLoadFailed)
                    throw new McpProtocolException("IMPORT_FAILED", "The selected Content asset is not a loadable binary asset.");
                var importPath = binary.ImportPath;
                if (string.IsNullOrEmpty(importPath))
                    throw new McpProtocolException("IMPORT_FAILED", "The selected asset has no Flax importer source metadata.");
                var sourcePath = Path.IsPathRooted(importPath) ? importPath : Path.Combine(Globals.ProjectFolder, importPath);
                ValidateAssetImportSource(sourcePath, request.AllowedImportRoots, request.MaxSourceBytes, 0, 0);
                operation.ResultPath = record.Path;
                operation.ResultAssetId = record.Id.ToString("N");
                if (request.DryRun)
                {
                    FinishAssetImportOperation(operation, "dry_run", null, null);
                    return CopyAssetImportOperation(operation);
                }
                // ContentImporting owns asynchronous reimport completion. It is a
                // public Editor API and reports the precise queue entry through
                // ImportFileEnd; avoid treating BinaryAsset.Reimport's void API
                // as a synchronous success signal.
                var item = FEditor.Instance.ContentDatabase.FindAsset(record.Id) as BinaryAssetItem;
                if (item == null) throw new McpProtocolException("IMPORT_FAILED", "The selected Content asset is not available to the Editor content database.");
                lock (_stateLock)
                {
                    var itemPath = Path.IsPathRooted(item.Path) ? item.Path : Path.Combine(Globals.ProjectFolder, item.Path);
                    _pendingReimportsByOutputPath[Path.GetFullPath(itemPath)] = operation.OperationId;
                    operation.Phase = "running";
                    operation.Progress = 0.0f;
                }
                FEditor.Instance.ContentImporting.Reimport(item, null, true);
                return CopyAssetImportOperation(operation);
            }
            catch (McpProtocolException ex)
            {
                FinishAssetImportOperation(operation, "failed", ex.Code, LimitForLog(ex.Message, 512));
                throw;
            }
            catch (Exception)
            {
                FinishAssetImportOperation(operation, "failed", "IMPORT_FAILED", "Flax Editor failed to reimport the selected asset.");
                throw new McpProtocolException("IMPORT_FAILED", "Flax Editor failed to reimport the selected asset.");
            }
        }

        private McpAssetOperation GetAssetImportOperation(McpAssetOperationStatusRequest request, string kind)
        {
            if (request == null || !IsGuidN(request.OperationId))
                throw new McpProtocolException("OPERATION_NOT_FOUND", "Asset operation ID was not found.");
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                McpAssetOperation operation;
                if (!_assetImportOperations.TryGetValue(request.OperationId, out operation) || !string.Equals(operation.Kind, kind, StringComparison.Ordinal))
                    throw new McpProtocolException("OPERATION_NOT_FOUND", "Asset operation ID was not found.");
                if (string.Equals(operation.Kind, "reimport", StringComparison.Ordinal) && string.Equals(operation.Phase, "running", StringComparison.Ordinal) && FEditor.Instance.ContentImporting.IsImporting)
                    operation.Progress = Math.Max(operation.Progress, Math.Min(0.99f, FEditor.Instance.ContentImporting.ImportingProgress));
                UpdateOperationLocked(operation.OperationId, operation.Phase, operation.Progress, operation.Phase == "running" ? "Importing content" : "Processing asset operation", operation.ErrorCode, operation.Error, operation.ResultPath);
                return CopyAssetImportOperation(operation);
            }
        }

        // Prefab v12 intentionally uses only the documented public Flax 1.12
        // API: PrefabManager.CreatePrefab, SpawnPrefab, Actor.IsPrefabRoot, and
        // SceneObject.PrefabID. It never reads or edits prefab serialization.
        private McpPrefabCreateResult CreatePrefabFromActor(McpPrefabCreateFromActor request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Prefab creation parameters are required.");
            var actor = RequireActor(request.ActorId);
            if (actor is Scene) throw new McpProtocolException("VALIDATION_FAILED", "A scene cannot be used as a prefab root actor.");
            EnsurePrefabEditorReady();
            CheckSceneWrite(actor.Scene, request.ExpectedSceneRevision, request.LeaseId);
            var output = ResolvePrefabOutput(request.DestinationPath);
            var result = new McpPrefabCreateResult
            {
                DryRun = request.DryRun,
                Created = false,
                PrefabPath = ProjectContentRelativePath(output),
                ActorId = actor.ID.ToString("N"),
                AutoLinked = request.AutoLink,
            };
            if (request.DryRun)
            {
                var current = CurrentRevision(actor.Scene);
                result.ProjectRevision = current.ProjectRevision;
                result.SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N");
                result.SceneRevision = current.SceneRevision;
                return result;
            }
            if (PrefabManager.CreatePrefab(actor, output, request.AutoLink))
                throw new McpProtocolException("VALIDATION_FAILED", "Flax failed to create the prefab from the selected actor.");
            result.Created = true;
            McpRevision revision;
            if (request.AutoLink)
            {
                MarkEdited(actor);
                revision = AdvanceSceneRevision(actor.Scene);
            }
            else
            {
                AdvanceProjectRevision();
                revision = CurrentRevision(actor.Scene);
            }
            result.ProjectRevision = revision.ProjectRevision;
            result.SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N");
            result.SceneRevision = revision.SceneRevision;
            return result;
        }

        private McpPrefabInstantiateResult InstantiatePrefab(McpPrefabInstantiate request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Prefab instantiation parameters are required.");
            if (string.IsNullOrEmpty(request.ParentId))
                throw new McpProtocolException("VALIDATION_FAILED", "ParentId is required so the target loaded scene can be guarded before instantiation.");
            var record = ResolvePrefabRecord(request.AssetId, request.Path);
            var parent = RequireActor(request.ParentId);
            EnsurePrefabEditorReady();
            CheckSceneWrite(parent.Scene, request.ExpectedSceneRevision, request.LeaseId);
            ValidateVector(request.Position, "Position");
            ValidateVector(request.Scale, "Scale");
            ValidateVector(request.EulerAngles, "EulerAngles");
            if (request.Name != null) Limit(request.Name, 128, "Prefab");
            var current = CurrentRevision(parent.Scene);
            var preview = new McpPrefabInstantiateResult
            {
                DryRun = request.DryRun,
                Prefab = AssetMetadata(record),
                VerifiedLink = false,
                ProjectRevision = current.ProjectRevision,
                SceneId = parent.Scene == null ? null : parent.Scene.ID.ToString("N"),
                SceneRevision = current.SceneRevision,
            };
            if (request.DryRun) return preview;
            Asset loaded = null;
            try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
            var prefab = loaded as Prefab;
            if (prefab == null || prefab.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected prefab asset could not be loaded by Flax Editor.");
            var position = request.Position == null ? new Float3(0.0f, 0.0f, 0.0f) : ToFloat3(request.Position);
            var euler = request.EulerAngles == null ? new Float3(0.0f, 0.0f, 0.0f) : ToFloat3(request.EulerAngles);
            var scale = request.Scale == null ? new Float3(1.0f, 1.0f, 1.0f) : ToFloat3(request.Scale);
            var transform = new Transform(new Vector3(position.X, position.Y, position.Z), Quaternion.Euler(euler), scale);
            var actor = PrefabManager.SpawnPrefab(prefab, parent, transform);
            if (actor == null) throw new McpProtocolException("VALIDATION_FAILED", "Flax failed to instantiate the selected prefab under the requested parent.");
            if (request.Name != null) actor.Name = Limit(request.Name, 128, "Prefab");
            MarkEdited(actor);
            var revision = AdvanceSceneRevision(actor.Scene);
            preview.DryRun = false;
            preview.Actor = ActorDto(actor, false);
            preview.VerifiedLink = actor.HasPrefabLink && actor.PrefabID == record.Id && actor.IsPrefabRoot;
            preview.ProjectRevision = revision.ProjectRevision;
            preview.SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N");
            preview.SceneRevision = revision.SceneRevision;
            return preview;
        }

        private McpPrefabInstancesResult GetPrefabInstances(McpPrefabGetInstances request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Prefab instance parameters are required.");
            ValidatePrefabPage(request.Limit, request.Cursor);
            var record = ResolvePrefabRecord(request.AssetId, request.Path);
            Scene scene = null;
            if (!string.IsNullOrEmpty(request.SceneId)) scene = RequireScene(request.SceneId);
            var instances = new List<Actor>();
            var scanned = 0;
            if (scene != null)
            {
                CollectPrefabInstances(scene, record.Id, instances, ref scanned);
            }
            else
            {
                for (var i = 0; i < Level.ScenesCount; i++)
                {
                    var loadedScene = Level.GetScene(i);
                    if (loadedScene != null) CollectPrefabInstances(loadedScene, record.Id, instances, ref scanned);
                }
            }
            instances.Sort((left, right) =>
            {
                var sceneCompare = string.Compare(left.Scene == null ? "" : left.Scene.ID.ToString("N"), right.Scene == null ? "" : right.Scene.ID.ToString("N"), StringComparison.Ordinal);
                return sceneCompare != 0 ? sceneCompare : string.Compare(left.ID.ToString("N"), right.ID.ToString("N"), StringComparison.Ordinal);
            });
            var scope = "prefab.get_instances|" + record.Id.ToString("N") + "|" + (scene == null ? "all-loaded" : scene.ID.ToString("N"));
            var revision = PrefabInstancesRevision(instances);
            var offset = GetAssetCursorOffset(request.Cursor, "prefab.get_instances", scope, revision);
            if (offset < 0 || offset > instances.Count) throw new McpProtocolException("CURSOR_INVALID", "Prefab instance cursor offset is invalid.");
            var count = Math.Min(request.Limit, instances.Count - offset);
            var entries = new McpPrefabInstanceDto[count];
            for (var i = 0; i < count; i++) entries[i] = PrefabInstanceDto(instances[offset + i]);
            var hasMore = offset + count < instances.Count;
            return new McpPrefabInstancesResult
            {
                Prefab = AssetMetadata(record),
                Entries = entries,
                HasMore = hasMore,
                NextCursor = hasMore ? CreateAssetCursor("prefab.get_instances", scope, revision, offset + count) : null,
                IndexRevision = revision,
                Warnings = new[] { "Only currently loaded scenes are scanned. Flax 1.12 exposes no verified global prefab-instance registry; external Editor changes require a refresh." },
            };
        }

        private object UnsupportedPrefabOperation(string capability, McpPrefabActorRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.ActorId)) throw new McpProtocolException("INVALID_REQUEST", "ActorId is required.");
            RequireActor(request.ActorId);
            throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", capability + " is intentionally unavailable: Flax 1.12 exposes no verified public override-diff/revert API, and apply or break-link lacks the reviewed undo, preview, and confirmation path required by this bridge.", new { Capability = capability, BridgeVersion = BridgeVersion, DryRun = request.DryRun });
        }

        private static void EnsurePrefabEditorReady()
        {
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested || ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", "Prefab workflows are unavailable while the editor is playing, compiling, or reloading scripts.");
        }

        private static McpAssetRecord ResolvePrefabRecord(string assetId, string path)
        {
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = assetId, Path = path }, BuildAssetRegistry());
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.Prefab", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "The selected Content asset is not a Flax prefab.");
            return record;
        }

        private static string ResolvePrefabOutput(string destinationPath)
        {
            var normalized = ValidateProjectContentPath(destinationPath, false);
            if (!normalized.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("VALIDATION_FAILED", "Prefab destination must use the .prefab extension.");
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var output = Path.GetFullPath(Path.Combine(content, normalized.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar)));
            if (!PathIsWithin(content, output)) throw new McpProtocolException("VALIDATION_FAILED", "Prefab destination escapes Content.");
            EnsurePrefabOutputParent(output);
            if (File.Exists(output) || Directory.Exists(output)) throw new McpProtocolException("FILE_EXISTS", "A prefab already exists at the requested destination.");
            return output;
        }

        private static void EnsurePrefabOutputParent(string output)
        {
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var parent = Path.GetDirectoryName(output);
            while (!Directory.Exists(parent))
            {
                var next = Path.GetDirectoryName(parent);
                if (string.IsNullOrEmpty(next) || string.Equals(next, parent, PathComparison))
                    throw new McpProtocolException("VALIDATION_FAILED", "Prefab destination parent is invalid.");
                parent = next;
            }
            if (!PathIsWithin(content, CanonicalExistingPath(parent, false)))
                throw new McpProtocolException("VALIDATION_FAILED", "Prefab destination parent resolves outside Content.");
        }

        private static void ValidatePrefabPage(int limit, string cursor)
        {
            if (limit < 1 || limit > MaxPrefabPageSize) throw new McpProtocolException("VALIDATION_FAILED", "Limit must be between 1 and 200.");
            if (!string.IsNullOrEmpty(cursor) && !IsGuidN(cursor)) throw new McpProtocolException("CURSOR_INVALID", "Prefab cursor is invalid.");
        }

        private static void CollectPrefabInstances(Actor actor, Guid prefabId, List<Actor> output, ref int scanned)
        {
            if (++scanned > MaxPrefabInstanceScan) throw new McpProtocolException("RESPONSE_TOO_LARGE", "Loaded-scene prefab scan exceeds the 10000-actor limit.");
            if (actor.IsPrefabRoot && actor.HasPrefabLink && actor.PrefabID == prefabId) output.Add(actor);
            for (var i = 0; i < actor.ChildrenCount; i++) CollectPrefabInstances(actor.GetChild(i), prefabId, output, ref scanned);
        }

        private static McpPrefabInstanceDto PrefabInstanceDto(Actor actor)
        {
            return new McpPrefabInstanceDto
            {
                ActorId = actor.ID.ToString("N"),
                SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"),
                ParentId = actor.Parent == null ? null : actor.Parent.ID.ToString("N"),
                Name = actor.Name,
                PrefabId = actor.PrefabID.ToString("N"),
                PrefabObjectId = actor.PrefabObjectID.ToString("N"),
                IsPrefabRoot = actor.IsPrefabRoot,
            };
        }

        private string PrefabInstancesRevision(List<Actor> instances)
        {
            var identity = new StringBuilder(instances.Count * 48);
            lock (_stateLock) identity.Append(_projectRevision).Append('|');
            foreach (var actor in instances) identity.Append(actor.Scene == null ? "" : actor.Scene.ID.ToString("N")).Append('|').Append(actor.ID.ToString("N")).Append('|').Append(actor.PrefabID.ToString("N")).Append('\n');
            return Fingerprint(identity.ToString());
        }

        private McpAssetOperation BeginAssetImportOperation(string operationId, string kind, string fingerprint, bool dryRun, out bool adopted)
        {
            if (!IsGuidN(operationId)) throw new McpProtocolException("INVALID_REQUEST", "OperationId must be a 32-character GUID without separators.");
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                McpAssetOperation existing;
                if (_assetImportOperations.TryGetValue(operationId, out existing))
                {
                    string existingFingerprint;
                    if (!_assetImportOperationFingerprints.TryGetValue(operationId, out existingFingerprint) || !string.Equals(existing.Kind, kind, StringComparison.Ordinal) || !string.Equals(existingFingerprint, fingerprint, StringComparison.Ordinal))
                        throw new McpProtocolException("IDEMPOTENCY_KEY_REUSED", "OperationId was already used for a different asset operation.");
                    adopted = true;
                    return CopyAssetImportOperation(existing);
                }
                while (_assetImportOperations.Count >= MaxAssetImportOperations)
                {
                    string oldest = null;
                    long oldestTime = long.MaxValue;
                    foreach (var pair in _assetImportOperations)
                    {
                        var time = pair.Value.FinishedUnixMs == 0 ? pair.Value.StartedUnixMs : pair.Value.FinishedUnixMs;
                        if (time < oldestTime) { oldest = pair.Key; oldestTime = time; }
                    }
                    if (oldest == null) break;
                    _assetImportOperations.Remove(oldest);
                    _assetImportOperationFingerprints.Remove(oldest);
                }
                var created = new McpAssetOperation { OperationId = operationId, Kind = kind, Phase = "requested", Progress = 0.0f, StartedUnixMs = now, DryRun = dryRun };
                _assetImportOperations[operationId] = created;
                _assetImportOperationFingerprints[operationId] = fingerprint;
                BeginOperationLocked(operationId, kind == "import" ? "asset_import" : "asset_reimport", false, "Asset operation requested", 1);
                adopted = false;
                return created;
            }
        }

        private void FinishAssetImportOperation(McpAssetOperation operation, string phase, string errorCode, string error)
        {
            if (operation == null) return;
            lock (_stateLock)
            {
                McpAssetOperation stored;
                if (!_assetImportOperations.TryGetValue(operation.OperationId, out stored)) return;
                stored.Phase = phase;
                stored.Progress = 1.0f;
                stored.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                stored.ResultPath = operation.ResultPath;
                stored.ResultAssetId = operation.ResultAssetId;
                stored.Renamed = operation.Renamed;
                stored.ErrorCode = errorCode;
                stored.Error = error;
                UpdateOperationLocked(stored.OperationId, phase, stored.Progress, phase == "succeeded" ? "Asset operation completed" : "Asset operation failed", errorCode, error, stored.ResultPath);
            }
        }

        private static McpAssetOperation CopyAssetImportOperation(McpAssetOperation value)
        {
            return new McpAssetOperation { OperationId = value.OperationId, Kind = value.Kind, Phase = value.Phase, Progress = value.Progress, StartedUnixMs = value.StartedUnixMs, FinishedUnixMs = value.FinishedUnixMs, ResultPath = value.ResultPath, ResultAssetId = value.ResultAssetId, Renamed = value.Renamed, DryRun = value.DryRun, ErrorCode = value.ErrorCode, Error = value.Error };
        }

        private static void EnsureAssetImportEditorReady()
        {
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested || ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady || FEditor.Instance.ContentImporting.IsImporting)
                throw new McpProtocolException("EDITOR_BUSY", "Asset import is unavailable while the editor is playing, compiling, reloading, or importing content.");
        }

        private static void EnsureAssetOrganizeEditorReady()
        {
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested || ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady || FEditor.Instance.ContentImporting.IsImporting)
                throw new McpProtocolException("EDITOR_BUSY", "Asset organization is unavailable while the editor is playing, compiling, reloading, or importing content.");
        }

        private static string ValidateAssetImportSource(string sourcePath, string[] roots, long requestedMaxBytes, long expectedSize, long expectedModifiedUnixMs)
        {
            if (string.IsNullOrEmpty(sourcePath) || sourcePath.Length > 1024)
                throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Import source is invalid.");
            if (roots == null || roots.Length == 0 || roots.Length > MaxAssetImportRoots)
                throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Asset import requires configured import roots.");
            var source = CanonicalExistingPath(sourcePath, true);
            var allowed = false;
            foreach (var rootValue in roots)
            {
                if (string.IsNullOrEmpty(rootValue) || rootValue.Length > 1024) continue;
                string root;
                try { root = CanonicalExistingPath(rootValue, false); } catch { continue; }
                if (PathIsWithin(root, source)) { allowed = true; break; }
            }
            if (!allowed) throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Import source is outside configured import roots.");
            var info = new FileInfo(source);
            if (!info.Exists || !IsSupportedAssetImportExtension(Path.GetExtension(source)))
                throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Import source extension is not allowlisted.");
            var maxBytes = requestedMaxBytes > 0 ? Math.Min(requestedMaxBytes, MaxAssetImportSourceBytes) : MaxAssetImportSourceBytes;
            if (info.Length < 1 || info.Length > maxBytes)
                throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Import source size exceeds the configured limit.");
            var modifiedUnixMs = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
            if ((expectedSize > 0 && info.Length != expectedSize) || (expectedModifiedUnixMs > 0 && modifiedUnixMs != expectedModifiedUnixMs))
                throw new McpProtocolException("IMPORT_FAILED", "Import source changed after validation.");
            // Final canonical lookup catches a source symlink/junction replacement.
            if (!string.Equals(source, CanonicalExistingPath(source, true), PathComparison))
                throw new McpProtocolException("IMPORT_FAILED", "Import source changed after validation.");
            return source;
        }

        private static string ResolveAssetImportOutput(string destinationPath, string collisionPolicy, out bool renamed)
        {
            var normalized = ValidateProjectContentPath(destinationPath, false);
            if (!normalized.EndsWith(".flax", StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("VALIDATION_FAILED", "Asset import destination must use the .flax extension.");
            if (!string.Equals(collisionPolicy, "error", StringComparison.Ordinal) && !string.Equals(collisionPolicy, "rename", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "CollisionPolicy must be error or rename.");
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var inside = normalized.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar);
            var output = Path.GetFullPath(Path.Combine(content, inside));
            if (!PathIsWithin(content, output)) throw new McpProtocolException("VALIDATION_FAILED", "Asset import destination escapes Content.");
            EnsureAssetImportOutputParent(output);
            renamed = false;
            if (!File.Exists(output) && !Directory.Exists(output)) return output;
            if (string.Equals(collisionPolicy, "error", StringComparison.Ordinal))
                throw new McpProtocolException("FILE_EXISTS", "An asset already exists at the requested destination.");
            var extension = Path.GetExtension(output);
            var stem = output.Substring(0, output.Length - extension.Length);
            for (var i = 1; i <= 999; i++)
            {
                var candidate = stem + "-" + i + extension;
                if (!File.Exists(candidate) && !Directory.Exists(candidate)) { renamed = true; return candidate; }
            }
            throw new McpProtocolException("FILE_EXISTS", "Could not find a collision-free asset destination.");
        }

        private static void EnsureAssetImportOutputParent(string output)
        {
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var parent = Path.GetDirectoryName(output);
            while (!Directory.Exists(parent))
            {
                var next = Path.GetDirectoryName(parent);
                if (string.IsNullOrEmpty(next) || string.Equals(next, parent, PathComparison))
                    throw new McpProtocolException("VALIDATION_FAILED", "Asset import destination parent is invalid.");
                parent = next;
            }
            if (!PathIsWithin(content, CanonicalExistingPath(parent, false)))
                throw new McpProtocolException("VALIDATION_FAILED", "Asset import destination parent resolves outside Content.");
        }

        private static string ProjectContentRelativePath(string absolutePath)
        {
            var relative = Path.GetRelativePath(Path.GetFullPath(Globals.ProjectFolder), absolutePath).Replace('\\', '/');
            if (!relative.StartsWith("Content/", StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("IMPORT_FAILED", "Imported asset result is outside project Content.");
            return relative;
        }

        private static readonly StringComparison PathComparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

        private static bool PathIsWithin(string root, string candidate)
        {
            var relative = Path.GetRelativePath(root, candidate);
            return string.IsNullOrEmpty(relative) || (!relative.Equals("..", PathComparison) && !relative.StartsWith(".." + Path.DirectorySeparatorChar, PathComparison) && !Path.IsPathRooted(relative));
        }

        private static string CanonicalExistingPath(string value, bool requireFile)
        {
            var full = Path.GetFullPath(value);
            var root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root)) throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Path cannot be resolved.");
            var current = root;
            var parts = full.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            for (var i = 0; i < parts.Length; i++)
            {
                current = Path.Combine(current, parts[i]);
                var last = i == parts.Length - 1;
                FileSystemInfo info = last && requireFile ? (FileSystemInfo)new FileInfo(current) : new DirectoryInfo(current);
                if (!info.Exists) throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Path does not exist.");
                var target = info.ResolveLinkTarget(true);
                if (target != null) current = target.FullName;
            }
            return Path.GetFullPath(current);
        }

        private static bool IsSupportedAssetImportExtension(string extension)
        {
            switch ((extension ?? "").ToLowerInvariant())
            {
                case ".png": case ".jpg": case ".jpeg": case ".tga": case ".bmp": case ".gif": case ".tif": case ".tiff": case ".dds": case ".hdr": case ".raw": case ".exr":
                case ".obj": case ".fbx": case ".x": case ".dae": case ".gltf": case ".glb": case ".blend": case ".bvh": case ".ase": case ".ply": case ".dxf": case ".ifc": case ".nff": case ".smd": case ".vta": case ".mdl": case ".md2": case ".md3": case ".md5mesh": case ".q3o": case ".q3s": case ".ac": case ".stl": case ".lwo": case ".lws": case ".lxo":
                case ".wav": case ".mp3": case ".ogg": return true;
                default: return false;
            }
        }

        private static void ValidateAssetSearch(McpAssetSearch request)
        {
            ValidateAssetLimit(request.Limit);
            ValidateAssetText(request.Query, 256, "Query");
            ValidateAssetText(request.Path, 512, "Path");
            ValidateAssetText(request.Type, 256, "Type");
            if (!string.IsNullOrEmpty(request.Extension) && (request.Extension.Length > 32 || request.Extension[0] != '.' || request.Extension.IndexOf('/') >= 0 || request.Extension.IndexOf('\\') >= 0))
                throw new McpProtocolException("VALIDATION_FAILED", "Extension must begin with a dot and be at most 32 characters.");
            if (!string.IsNullOrEmpty(request.Guid) && !IsGuidN(request.Guid)) throw new McpProtocolException("INVALID_REQUEST", "Guid must be a 32-character GUID.");
            if (!string.IsNullOrEmpty(request.Folder)) ValidateProjectContentPath(request.Folder, true);
            if (!string.IsNullOrEmpty(request.Cursor) && !IsGuidN(request.Cursor)) throw new McpProtocolException("CURSOR_INVALID", "Asset cursor is invalid.");
        }

        private static void ValidateAssetGraphRequest(McpAssetGraphRequest request)
        {
            ValidateAssetSelector(request.AssetId, request.Path);
            ValidateAssetLimit(request.Limit);
            if (request.MaxDepth < 1 || request.MaxDepth > MaxAssetGraphDepth) throw new McpProtocolException("VALIDATION_FAILED", "MaxDepth must be between 1 and 16.");
            if (!request.Transitive && request.MaxDepth != 1) throw new McpProtocolException("VALIDATION_FAILED", "Direct dependency queries require MaxDepth of 1.");
            if (!string.IsNullOrEmpty(request.Cursor) && !IsGuidN(request.Cursor)) throw new McpProtocolException("CURSOR_INVALID", "Asset cursor is invalid.");
        }

        private static void ValidateAssetReferenceRequest(McpAssetGraphRequest request)
        {
            ValidateAssetSelector(request.AssetId, request.Path);
            ValidateAssetLimit(request.Limit);
            if (request.Transitive || request.MaxDepth != 1) throw new McpProtocolException("VALIDATION_FAILED", "Reverse reference queries support direct references only.");
            if (!string.IsNullOrEmpty(request.Cursor) && !IsGuidN(request.Cursor)) throw new McpProtocolException("CURSOR_INVALID", "Asset cursor is invalid.");
        }

        private static void ValidateAssetSelector(string assetId, string assetPath)
        {
            if ((string.IsNullOrEmpty(assetId) && string.IsNullOrEmpty(assetPath)) || (!string.IsNullOrEmpty(assetId) && !string.IsNullOrEmpty(assetPath)))
                throw new McpProtocolException("INVALID_REQUEST", "Provide exactly one of AssetId or Path.");
            if (!string.IsNullOrEmpty(assetId) && !IsGuidN(assetId)) throw new McpProtocolException("INVALID_REQUEST", "AssetId must be a 32-character GUID.");
            if (!string.IsNullOrEmpty(assetPath)) ValidateProjectContentPath(assetPath, false);
        }

        private static void ValidateAssetLimit(int limit)
        {
            if (limit < 1 || limit > MaxAssetPageSize) throw new McpProtocolException("VALIDATION_FAILED", "Limit must be between 1 and 200.");
        }

        private static void ValidateAssetText(string value, int max, string name)
        {
            if (value == null) return;
            if (value.Length == 0 || value.Length > max || value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
                throw new McpProtocolException("VALIDATION_FAILED", name + " is invalid.");
        }

        private static string ValidateProjectContentPath(string value, bool folder)
        {
            ValidateAssetText(value, 512, folder ? "Folder" : "Path");
            var normalized = (value ?? "").Replace('\\', '/').Trim('/');
            if (string.IsNullOrEmpty(normalized) || Path.IsPathRooted(value) || !(normalized == "Content" || normalized.StartsWith("Content/", StringComparison.Ordinal)))
                throw new McpProtocolException("INVALID_REQUEST", "Asset paths must be project-relative under Content/.");
            var parts = normalized.Split('/');
            foreach (var part in parts) if (part == "." || part == ".." || string.IsNullOrEmpty(part)) throw new McpProtocolException("INVALID_REQUEST", "Asset path contains an invalid segment.");
            if (!folder && normalized == "Content") throw new McpProtocolException("INVALID_REQUEST", "Asset path must identify a file under Content/.");
            return normalized;
        }

        private static string AssetSearchScope(McpAssetSearch request)
        {
            return "q=" + (request.Query ?? "") + "|p=" + (request.Path ?? "") + "|t=" + (request.Type ?? "") + "|e=" + (request.Extension ?? "") + "|g=" + (request.Guid ?? "") + "|f=" + (request.Folder ?? "") + "|m=" + (request.HasMissingDependency.HasValue ? request.HasMissingDependency.Value.ToString() : "");
        }

        private static bool MatchesAssetText(string value, string filter)
        {
            return string.IsNullOrEmpty(filter) || (!string.IsNullOrEmpty(value) && value.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static bool MatchesAssetType(string typeName, string filter)
        {
            if (string.IsNullOrEmpty(filter)) return true;
            return string.Equals(typeName, filter, StringComparison.OrdinalIgnoreCase) || (typeName != null && typeName.EndsWith("." + filter, StringComparison.OrdinalIgnoreCase));
        }

        private static bool IsAssetInFolder(string folder, string requestedFolder)
        {
            var normalized = ValidateProjectContentPath(requestedFolder, true);
            return string.Equals(folder, normalized, StringComparison.OrdinalIgnoreCase) || folder.StartsWith(normalized + "/", StringComparison.OrdinalIgnoreCase);
        }

        private static List<McpAssetRecord> BuildAssetRegistry()
        {
            var records = new List<McpAssetRecord>();
            var seen = new HashSet<Guid>();
            var ids = Content.GetAllAssets() ?? new Guid[0];
            foreach (var id in ids)
            {
                if (id == Guid.Empty || !seen.Add(id)) continue;
                if (records.Count >= MaxAssetRegistryEntries) throw new McpProtocolException("RESPONSE_TOO_LARGE", "Asset registry exceeds the 10000-asset scan limit.");
                AssetInfo info;
                if (!Content.GetAssetInfo(id, out info)) continue;
                var assetPath = AssetProjectRelativePath(info.Path);
                if (assetPath == null) continue;
                var extension = Path.GetExtension(assetPath);
                var folder = Path.GetDirectoryName(assetPath);
                records.Add(new McpAssetRecord { Id = id, Info = info, Path = assetPath, Extension = extension == null ? "" : extension.ToLowerInvariant(), Folder = string.IsNullOrEmpty(folder) ? "Content" : folder.Replace('\\', '/') });
            }
            records.Sort((a, b) =>
            {
                var byPath = string.Compare(a.Path, b.Path, StringComparison.OrdinalIgnoreCase);
                return byPath != 0 ? byPath : a.Id.CompareTo(b.Id);
            });
            return records;
        }

        private static string AssetProjectRelativePath(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            const string marker = "<project>";
            var root = Path.GetFullPath(Globals.ProjectFolder);
            var full = value.StartsWith(marker, StringComparison.OrdinalIgnoreCase)
                ? Path.Combine(root, value.Substring(marker.Length).TrimStart('\\', '/'))
                : (Path.IsPathRooted(value) ? value : Path.Combine(root, value));
            string relative;
            try { relative = Path.GetRelativePath(root, Path.GetFullPath(full)).Replace('\\', '/'); }
            catch { return null; }
            if (!(relative.StartsWith("Content/", StringComparison.OrdinalIgnoreCase))) return null;
            return relative;
        }

        private static string AssetIndexRevision(List<McpAssetRecord> records)
        {
            var text = new StringBuilder(records.Count * 96);
            foreach (var record in records) text.Append(record.Id.ToString("N")).Append('|').Append(record.Path).Append('|').Append(record.Info.TypeName ?? "").Append('\n');
            return Fingerprint(text.ToString());
        }

        private static McpAssetGraphIndex BuildAssetGraphIndex(List<McpAssetRecord> records)
        {
            var graph = new McpAssetGraphIndex { ById = new Dictionary<Guid, McpAssetRecord>(), Direct = new Dictionary<Guid, List<Guid>>(), Missing = new Dictionary<Guid, int>(), Reverse = new Dictionary<Guid, int>() };
            foreach (var record in records) { graph.ById[record.Id] = record; graph.Direct[record.Id] = new List<Guid>(); graph.Missing[record.Id] = 0; graph.Reverse[record.Id] = 0; }
            foreach (var record in records)
            {
                var direct = graph.Direct[record.Id];
                Asset asset = null;
                try { asset = Content.Load(record.Id, AssetLoadTimeoutMs); }
                catch { }
                if (asset == null || asset.LastLoadFailed) continue;
                Guid[] references;
                try { references = asset.GetReferences(); }
                catch { continue; }
                if (references == null) continue;
                var unique = new HashSet<Guid>();
                foreach (var target in references)
                {
                    if (target == Guid.Empty || !unique.Add(target)) continue;
                    if (!graph.ById.ContainsKey(target)) { graph.Missing[record.Id]++; continue; }
                    direct.Add(target);
                    graph.Reverse[target] = graph.Reverse[target] + 1;
                }
                direct.Sort();
            }
            return graph;
        }

        private static McpAssetRecord ResolveAssetRecord(McpAssetGet request, List<McpAssetRecord> records)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset selector is required.");
            ValidateAssetSelector(request.AssetId, request.Path);
            if (!string.IsNullOrEmpty(request.AssetId))
            {
                Guid id;
                Guid.TryParseExact(request.AssetId, "N", out id);
                foreach (var record in records) if (record.Id == id) return record;
            }
            else
            {
                var normalized = ValidateProjectContentPath(request.Path, false);
                foreach (var record in records) if (string.Equals(record.Path, normalized, StringComparison.OrdinalIgnoreCase)) return record;
            }
            throw new McpProtocolException("ASSET_NOT_FOUND", "Asset was not found in the project Content registry.");
        }

        private static McpAssetMetadata AssetMetadata(McpAssetRecord record)
        {
            return new McpAssetMetadata { Id = record.Id.ToString("N"), Path = record.Path, TypeName = record.Info.TypeName, Extension = record.Extension, Folder = record.Folder };
        }

        private static McpAssetDto AssetDto(McpAssetRecord record, McpAssetGraphIndex graph)
        {
            return new McpAssetDto { Id = record.Id.ToString("N"), Path = record.Path, TypeName = record.Info.TypeName, Extension = record.Extension, Folder = record.Folder, DependencyCount = graph.Direct[record.Id].Count, MissingDependencyCount = graph.Missing[record.Id], ReferenceCount = graph.Reverse[record.Id] };
        }

        private static string[] AssetMetadataWarnings()
        {
            return new[] { "Flax 1.12 public Content metadata exposes only ID, path, type, extension, and folder. File size, modified time, import status, and importer settings are intentionally omitted." };
        }

        private static string[] AssetGraphWarnings()
        {
            return new[] { "Dependencies are direct public Asset.GetReferences results. Invalid and duplicate IDs are discarded after registry validation; reverse references expose source asset/scene/prefab kinds only and never actor or property locations." };
        }

        private static string AssetReferenceKind(McpAssetRecord record)
        {
            if (string.Equals(record.Info.TypeName, "FlaxEngine.Scene", StringComparison.Ordinal)) return "scene";
            if (string.Equals(record.Info.TypeName, "FlaxEngine.Prefab", StringComparison.Ordinal)) return "prefab";
            return "asset";
        }

        private static void CollectAssetDependencies(Guid current, int depth, int maxDepth, List<Guid> ancestors, HashSet<Guid> expanded, McpAssetGraphIndex graph, List<McpAssetDependency> output)
        {
            if (depth >= maxDepth) return;
            List<Guid> targets;
            if (!graph.Direct.TryGetValue(current, out targets)) return;
            foreach (var target in targets)
            {
                McpAssetRecord record;
                if (!graph.ById.TryGetValue(target, out record)) continue;
                var cycle = ancestors.Contains(target);
                output.Add(new McpAssetDependency { FromId = current.ToString("N"), Asset = AssetDto(record, graph), Depth = depth + 1, Cycle = cycle });
                if (output.Count > MaxAssetGraphEdges) throw new McpProtocolException("RESPONSE_TOO_LARGE", "Asset graph exceeds the 10000-edge traversal limit.");
                if (cycle || depth + 1 >= maxDepth || !expanded.Add(target)) continue;
                var nextAncestors = new List<Guid>(ancestors) { target };
                CollectAssetDependencies(target, depth + 1, maxDepth, nextAncestors, expanded, graph, output);
            }
        }

        private static AssetPageResult AssetPage(List<McpAssetRecord> records, int offset, int limit, Func<McpAssetRecord, McpAssetDto> map)
        {
            if (offset < 0 || offset > records.Count) throw new McpProtocolException("CURSOR_INVALID", "Asset cursor offset is invalid.");
            var count = Math.Min(limit, records.Count - offset);
            var entries = new McpAssetDto[count];
            for (var i = 0; i < count; i++) entries[i] = map(records[offset + i]);
            return new AssetPageResult { Entries = entries, NextOffset = offset + count, HasMore = offset + count < records.Count };
        }

        private static DependencyPageResult DependencyPage(List<McpAssetDependency> entries, int offset, int limit)
        {
            if (offset < 0 || offset > entries.Count) throw new McpProtocolException("CURSOR_INVALID", "Asset cursor offset is invalid.");
            var count = Math.Min(limit, entries.Count - offset);
            var page = new McpAssetDependency[count];
            for (var i = 0; i < count; i++) page[i] = entries[offset + i];
            return new DependencyPageResult { Entries = page, NextOffset = offset + count, HasMore = offset + count < entries.Count };
        }

        private static ReferencePageResult ReferencePage(List<McpAssetReference> entries, int offset, int limit)
        {
            if (offset < 0 || offset > entries.Count) throw new McpProtocolException("CURSOR_INVALID", "Asset cursor offset is invalid.");
            var count = Math.Min(limit, entries.Count - offset);
            var page = new McpAssetReference[count];
            for (var i = 0; i < count; i++) page[i] = entries[offset + i];
            return new ReferencePageResult { Entries = page, NextOffset = offset + count, HasMore = offset + count < entries.Count };
        }

        private sealed class AssetPageResult { public McpAssetDto[] Entries; public int NextOffset; public bool HasMore; }
        private sealed class DependencyPageResult { public McpAssetDependency[] Entries; public int NextOffset; public bool HasMore; }
        private sealed class ReferencePageResult { public McpAssetReference[] Entries; public int NextOffset; public bool HasMore; }

        private int GetAssetCursorOffset(string cursor, string method, string scope, string revision)
        {
            if (string.IsNullOrEmpty(cursor)) return 0;
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                McpAssetCursor stored;
                if (!_assetCursors.TryGetValue(cursor, out stored) || !string.Equals(stored.Method, method, StringComparison.Ordinal) || !string.Equals(stored.Scope, scope, StringComparison.Ordinal) || !string.Equals(stored.IndexRevision, revision, StringComparison.Ordinal))
                    throw new McpProtocolException("CURSOR_INVALID", "Asset cursor is expired, has a different filter scope, or the asset registry changed.");
                return stored.Offset;
            }
        }

        private string CreateAssetCursor(string method, string scope, string revision, int offset)
        {
            var cursor = Guid.NewGuid().ToString("N");
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                _assetCursors[cursor] = new McpAssetCursor { Method = method, Scope = scope, IndexRevision = revision, Offset = offset, ExpiresUnixMs = now + AssetCursorTtlMs };
                while (_assetCursors.Count > MaxAssetCursors)
                {
                    string oldest = null; long expires = long.MaxValue;
                    foreach (var pair in _assetCursors) if (pair.Value.ExpiresUnixMs < expires) { oldest = pair.Key; expires = pair.Value.ExpiresUnixMs; }
                    if (oldest == null) break;
                    _assetCursors.Remove(oldest);
                }
            }
            return cursor;
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
                if (!string.IsNullOrEmpty(_compile.OperationId))
                    UpdateOperationLocked(_compile.OperationId, _compile.Phase, IsTerminalOperationPhase(_compile.Phase) ? 1.0f : 0.5f,
                        _compile.Phase == "reloading" ? "Reloading scripts" : "Compiling scripts",
                        _compile.Phase == "failed" ? "COMPILATION_FAILED" : null,
                        _compile.Phase == "failed" ? "Flax script compilation failed." : null);
                return CopyCompileStatus(_compile);
            }
        }

        // Build/cook only exposes the public Flax 1.12 GameCooker API. There
        // is no public toolchain capability query, so list/validate are
        // explicitly preflight-only and a target is confirmed only by Build.
        private McpBuildTargetsResult BuildTargets()
        {
            return new McpBuildTargetsResult
            {
                Entries = new[]
                {
                    BuildTarget("windows64", "Windows 64-bit", false),
                    BuildTarget("linux_x64", "Linux 64-bit", false),
                    BuildTarget("macos_x64", "macOS Intel", false),
                    BuildTarget("macos_arm64", "macOS Apple Silicon", false),
                    BuildTarget("android_arm64", "Android ARM64", false),
                    BuildTarget("web", "Web", false),
                },
                Warnings = new[] { "Flax 1.12 exposes no reviewed public managed API to preflight installed platform toolchains. Availability is confirmed only when a build starts." },
            };
        }

        private static McpBuildTarget BuildTarget(string platform, string displayName, bool host)
        {
            return new McpBuildTarget { Platform = platform, DisplayName = displayName, IsHostTarget = host };
        }

        private McpBuildValidation ValidateBuild(McpBuildRequest request)
        {
            ValidateBuildRequest(request, false);
            var output = BuildOutputAbsolutePath(request.OutputPath);
            var exists = Directory.Exists(output);
            var empty = !exists || Directory.GetFileSystemEntries(output).Length == 0;
            return new McpBuildValidation
            {
                Valid = !GameCooker.IsRunning && !FEditor.IsPlayMode && !ScriptsBuilder.IsCompiling && empty,
                Platform = request.Platform, Configuration = request.Configuration, OutputPath = request.OutputPath,
                OutputExists = exists, OutputEmpty = empty,
                Warnings = BuildValidationWarnings(exists, empty),
            };
        }

        private string[] BuildValidationWarnings(bool outputExists, bool outputEmpty)
        {
            var warnings = new List<string>();
            warnings.Add("Validation is preflight-only; Flax toolchain availability is not known until GameCooker.Build starts.");
            if (GameCooker.IsRunning) warnings.Add("A game build is already running.");
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested) warnings.Add("Stop play mode before starting a build.");
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady) warnings.Add("Wait for script compilation/reload before starting a build.");
            if (outputExists && !outputEmpty) warnings.Add("Output directory is not empty. This bridge refuses to start a build there.");
            return warnings.ToArray();
        }

        private McpOperation StartBuild(McpBuildRequest request)
        {
            ValidateBuildRequest(request, true);
            var preflight = ValidateBuild(request);
            if (!preflight.Valid)
                throw new McpProtocolException("VALIDATION_FAILED", "Build preflight failed.", preflight);
            if (request.DryRun)
            {
                lock (_stateLock)
                {
                    var dry = BeginOperationLocked(request.OperationId, "build_cook", false, "Build dry-run completed", 1);
                    UpdateOperationLocked(dry.OperationId, "dry_run", 1.0f, "Build dry-run completed", null, null, "No GameCooker.Build call was made.");
                    _buildRequests[request.OperationId] = CopyBuildRequest(request);
                    return CopyOperation(_operations[request.OperationId]);
                }
            }
            var platform = ParseBuildPlatform(request.Platform);
            var configuration = ParseBuildConfiguration(request.Configuration);
            var output = BuildOutputAbsolutePath(request.OutputPath);
            lock (_stateLock)
            {
                if (_operations.ContainsKey(request.OperationId))
                    throw new McpProtocolException("IDEMPOTENCY_KEY_REUSED", "OperationId is already in use.");
                BeginOperationLocked(request.OperationId, "build_cook", true, "Starting Flax game cooker", 1);
                _buildRequests[request.OperationId] = CopyBuildRequest(request);
            }
            bool failed;
            try { failed = GameCooker.Build(platform, configuration, output, BuildOptions.None, request.CustomDefines ?? new string[0]); }
            catch (Exception ex)
            {
                lock (_stateLock) UpdateOperationLocked(request.OperationId, "failed", 1.0f, "Flax game cooker failed to start", "BUILD_START_FAILED", LimitForLog(ex.Message, 512));
                throw new McpProtocolException("BUILD_START_FAILED", "Flax game cooker threw while starting the build.");
            }
            if (failed)
            {
                lock (_stateLock) UpdateOperationLocked(request.OperationId, "failed", 1.0f, "Flax game cooker rejected the build", "BUILD_START_FAILED", "GameCooker.Build returned failure.");
            }
            else
            {
                lock (_stateLock) UpdateOperationLocked(request.OperationId, "running", 0.0f, "Flax game cooker started");
            }
            return GetOperation(new McpOperationRequest { OperationId = request.OperationId });
        }

        private McpOperation GetBuildStatus(McpBuildOperationRequest request, bool requireTerminal)
        {
            var operation = GetOperation(new McpOperationRequest { OperationId = request == null ? null : request.OperationId });
            if (!string.Equals(operation.Kind, "build_cook", StringComparison.Ordinal))
                throw new McpProtocolException("OPERATION_NOT_FOUND", "Operation ID does not identify a build/cook operation.");
            if (requireTerminal && !IsTerminalOperationPhase(operation.Phase))
                throw new McpProtocolException("BUILD_NOT_COMPLETE", "Build result is unavailable until the operation reaches a terminal phase.");
            return operation;
        }

        private McpOperation CancelBuild(McpBuildOperationRequest request)
        {
            var operation = GetBuildStatus(request, false);
            if (IsTerminalOperationPhase(operation.Phase)) return operation;
            if (!GameCooker.IsRunning)
                throw new McpProtocolException("CANCELLATION_UNSUPPORTED", "The Flax game cooker is no longer running; refresh build status instead.");
            GameCooker.Cancel(false);
            lock (_stateLock)
            {
                McpOperation stored;
                if (_operations.TryGetValue(operation.OperationId, out stored))
                {
                    stored.CancelRequested = true;
                    UpdateOperationLocked(stored.OperationId, "cancelling", stored.Progress, "Flax game cooker cancellation requested");
                    return CopyOperation(stored);
                }
            }
            return operation;
        }

        private static void ValidateBuildRequest(McpBuildRequest request, bool requireOperationId)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Build parameters are required.");
            if (requireOperationId && !IsGuidN(request.OperationId)) throw new McpProtocolException("INVALID_REQUEST", "OperationId must be a 32-character GUID without separators.");
            ParseBuildPlatform(request.Platform);
            ParseBuildConfiguration(request.Configuration);
            BuildOutputAbsolutePath(request.OutputPath);
            if (request.CustomDefines != null)
            {
                if (request.CustomDefines.Length > 32) throw new McpProtocolException("VALIDATION_FAILED", "At most 32 custom build defines are allowed.");
                foreach (var define in request.CustomDefines)
                    if (string.IsNullOrEmpty(define) || define.Length > 64 || !IsBuildDefine(define)) throw new McpProtocolException("VALIDATION_FAILED", "Custom build defines must be simple identifier-like values.");
            }
        }

        private static bool IsBuildDefine(string value)
        {
            for (var i = 0; i < value.Length; i++) if (!(char.IsLetterOrDigit(value[i]) || value[i] == '_')) return false;
            return true;
        }

        private static BuildPlatform ParseBuildPlatform(string value)
        {
            if (string.Equals(value, "windows64", StringComparison.Ordinal)) return BuildPlatform.Windows64;
            if (string.Equals(value, "linux_x64", StringComparison.Ordinal)) return BuildPlatform.LinuxX64;
            if (string.Equals(value, "macos_x64", StringComparison.Ordinal)) return BuildPlatform.MacOSx64;
            if (string.Equals(value, "macos_arm64", StringComparison.Ordinal)) return BuildPlatform.MacOSARM64;
            if (string.Equals(value, "android_arm64", StringComparison.Ordinal)) return BuildPlatform.AndroidARM64;
            if (string.Equals(value, "web", StringComparison.Ordinal)) return BuildPlatform.Web;
            throw new McpProtocolException("VALIDATION_FAILED", "Build platform is not in the reviewed bridge allowlist.");
        }

        private static BuildConfiguration ParseBuildConfiguration(string value)
        {
            if (string.Equals(value, "debug", StringComparison.Ordinal)) return BuildConfiguration.Debug;
            if (string.Equals(value, "development", StringComparison.Ordinal)) return BuildConfiguration.Development;
            if (string.Equals(value, "release", StringComparison.Ordinal)) return BuildConfiguration.Release;
            throw new McpProtocolException("VALIDATION_FAILED", "Build configuration must be debug, development, or release.");
        }

        private static string BuildOutputAbsolutePath(string outputPath)
        {
            if (string.IsNullOrEmpty(outputPath) || outputPath.Length > 512 || outputPath.Replace('\\', '/') != outputPath || !outputPath.StartsWith("Builds/", StringComparison.Ordinal) || outputPath.EndsWith("/", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "OutputPath must be a project-relative directory below Builds/.");
            var parts = outputPath.Split('/');
            foreach (var part in parts) if (string.IsNullOrEmpty(part) || part == "." || part == ".." || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new McpProtocolException("VALIDATION_FAILED", "OutputPath contains an invalid path segment.");
            var project = Path.GetFullPath(Globals.ProjectFolder).TrimEnd('\\', '/');
            var builds = Path.GetFullPath(Path.Combine(project, "Builds"));
            var candidate = Path.GetFullPath(Path.Combine(project, outputPath));
            if (!candidate.StartsWith(builds + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new McpProtocolException("VALIDATION_FAILED", "OutputPath must remain below project Builds/.");
            return candidate;
        }

        private static McpBuildRequest CopyBuildRequest(McpBuildRequest value)
        {
            return new McpBuildRequest { OperationId = value.OperationId, Platform = value.Platform, Configuration = value.Configuration, OutputPath = value.OutputPath, DryRun = value.DryRun, CustomDefines = value.CustomDefines == null ? new string[0] : (string[])value.CustomDefines.Clone() };
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
                BeginOperationLocked(operationId, "compile", false, "Compilation requested", 3);
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
                BeginOperationLocked(operationId, "project_generation", true, "Project generation queued", 1);
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
                    McpOperation operation;
                    if (_operations.TryGetValue(operationId, out operation) && operation.CancelRequested) return;
                }
                var failed = ScriptsBuilder.GenerateProject();
                lock (_stateLock)
                {
                    if (!string.Equals(_generate.OperationId, operationId, StringComparison.Ordinal)) return;
                    _generate.Failed = failed;
                    _generate.Phase = failed ? "failed" : "succeeded";
                    _generate.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    UpdateOperationLocked(operationId, _generate.Phase, 1.0f, "Project generation completed", _generate.Failed ? "GENERATION_FAILED" : null, _generate.Error);
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
                    UpdateOperationLocked(operationId, "failed", 1.0f, "Project generation failed", "GENERATION_FAILED", _generate.Error);
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
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (_sceneLeases.Count > 0) throw new McpProtocolException("EDIT_LEASE_ACTIVE", "Cannot start play while an edit lease is active. Commit or release the lease first.", ActiveLeasesDetailsLocked());
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

        private McpSceneRef[] ListLoadedScenes()
        {
            var items = new List<McpSceneRef>();
            for (var i = 0; i < Level.ScenesCount; i++)
            {
                var scene = Level.GetScene(i);
                if (scene != null) items.Add(SceneRef(scene));
            }
            return items.ToArray();
        }

        private object SceneTree(McpSceneSave p)
        {
            var scene = RequireScene(p == null ? null : p.SceneId);
            return ActorDto(scene, true);
        }

        private McpSceneRef SaveScene(McpSceneSave p)
        {
            var scene = RequireScene(p == null ? null : p.SceneId);
            FEditor.Instance.Scene.SaveScene(scene);
            return SceneRef(scene);
        }

        private string SaveAll() { FEditor.Instance.SaveAll(); return "save requested"; }

        // Undo/redo may apply a user-owned editor action, so only the project
        // counter is advanced; no scene revision is claimed unless the bridge can
        // identify the affected scene before the editor executes the action.
        private string Undo()
        {
            FEditor.Instance.PerformUndo();
            AdvanceProjectRevision();
            return "undo requested";
        }

        private string Redo()
        {
            FEditor.Instance.PerformRedo();
            AdvanceProjectRevision();
            return "redo requested";
        }

        private McpActorDto[] FindActors(McpActorFind p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor find parameters are required.");
            if (string.IsNullOrWhiteSpace(p.Name) && string.IsNullOrWhiteSpace(p.TypeName) && string.IsNullOrEmpty(p.ParentId) && !p.Active.HasValue)
                throw new McpProtocolException("INVALID_REQUEST", "Provide at least one actor find filter.");
            if (p.Name != null && (p.Name.Length == 0 || p.Name.Length > 128)) throw new McpProtocolException("VALIDATION_FAILED", "Name filter must be between 1 and 128 characters.");
            if (p.TypeName != null && (p.TypeName.Length == 0 || p.TypeName.Length > 256)) throw new McpProtocolException("VALIDATION_FAILED", "TypeName filter must be between 1 and 256 characters.");
            Guid parentId = Guid.Empty;
            if (!string.IsNullOrEmpty(p.ParentId) && !Guid.TryParseExact(p.ParentId, "N", out parentId)) throw new McpProtocolException("INVALID_REQUEST", "parentId must be a 32-character GUID.");
            var max = Math.Max(1, Math.Min(p.MaxResults, 100));
            var all = Level.GetActors(typeof(Actor), false);
            var result = new List<McpActorDto>();
            foreach (var actor in all)
            {
                if (actor == null) continue;
                if (!string.IsNullOrEmpty(p.Name) && actor.Name.IndexOf(p.Name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (!string.IsNullOrEmpty(p.TypeName) && !string.Equals(actor.TypeName, p.TypeName, StringComparison.Ordinal)) continue;
                if (parentId != Guid.Empty && (actor.Parent == null || actor.Parent.ID != parentId)) continue;
                if (p.Active.HasValue && actor.IsActive != p.Active.Value) continue;
                result.Add(ActorDto(actor, false));
                if (result.Count == max) break;
            }
            return result.ToArray();
        }

        private McpActorDto CreateActor(McpActorCreate p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor creation parameters are required.");
            var type = ResolveType(p.TypeName, typeof(Actor));
            var parent = string.IsNullOrEmpty(p.ParentId) ? null : RequireActor(p.ParentId);
            // Flax's public Spawn API selects an editor-default scene when ParentId
            // is null. That target cannot be verified before the write, so guarded
            // create operations must provide a parent in the intended loaded scene.
            CheckSceneWrite(parent == null ? null : parent.Scene, p.ExpectedSceneRevision, p.LeaseId);
            var actor = FObject.New(type) as Actor;
            if (actor == null) throw new McpProtocolException("VALIDATION_FAILED", "Type did not create an Actor.");
            actor.Name = Limit(p.Name, 128, "Actor");
            actor.IsActive = p.Active;
            if (p.Position != null) actor.Position = ToFloat3(p.Position);
            FEditor.Instance.SceneEditing.Spawn(actor, parent, -1, false);
            MarkEdited(actor);
            AdvanceSceneRevision(actor.Scene);
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

        private McpActorDto UpdateActor(McpActorUpdate p)
        {
            ValidateActorUpdate(p);
            var actor = RequireActor(p.ActorId);
            CheckSceneWrite(actor.Scene, p.ExpectedSceneRevision, p.LeaseId);
            FEditor.Instance.Undo.RecordAction(actor, "Update actor", () =>
            {
                // This is intentionally a narrow allowlist: no arbitrary reflected properties.
                if (p.Name != null) actor.Name = Limit(p.Name, 128, "");
                if (p.Active.HasValue) actor.IsActive = p.Active.Value;
                if (p.Position != null) actor.Position = ToFloat3(p.Position);
                if (p.Scale != null) actor.Scale = ToFloat3(p.Scale);
                if (p.EulerAngles != null) actor.EulerAngles = ToFloat3(p.EulerAngles);
                if (p.LocalPosition != null) actor.LocalPosition = ToFloat3(p.LocalPosition);
                if (p.LocalScale != null) actor.LocalScale = ToFloat3(p.LocalScale);
                if (p.LocalEulerAngles != null) actor.LocalEulerAngles = ToFloat3(p.LocalEulerAngles);
                if (p.Layer.HasValue) actor.Layer = p.Layer.Value;
                MarkEdited(actor);
            });
            AdvanceSceneRevision(actor.Scene);
            return ActorDto(actor, false);
        }

        private static void ValidateActorUpdate(McpActorUpdate p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor update parameters are required.");
            var hasWorldTransform = p.Position != null || p.Scale != null || p.EulerAngles != null;
            var hasLocalTransform = p.LocalPosition != null || p.LocalScale != null || p.LocalEulerAngles != null;
            if (p.Name == null && !p.Active.HasValue && !hasWorldTransform && !hasLocalTransform && !p.Layer.HasValue)
                throw new McpProtocolException("INVALID_REQUEST", "Provide at least one allowlisted actor field to update.");
            if (hasWorldTransform && hasLocalTransform)
                throw new McpProtocolException("VALIDATION_FAILED", "World-space and local-space transform patches cannot be combined in one actor update.");
            if (p.Name != null) Limit(p.Name, 128, "");
            ValidateVector(p.Position, "Position");
            ValidateVector(p.Scale, "Scale");
            ValidateVector(p.EulerAngles, "EulerAngles");
            ValidateVector(p.LocalPosition, "LocalPosition");
            ValidateVector(p.LocalScale, "LocalScale");
            ValidateVector(p.LocalEulerAngles, "LocalEulerAngles");
            if (p.Layer.HasValue && (p.Layer.Value < 0 || p.Layer.Value > MaxActorLayer))
                throw new McpProtocolException("VALIDATION_FAILED", "Layer must be between 0 and 31.");
        }

        private object DeleteActor(McpActorId p)
        {
            var actor = RequireActor(p == null ? null : p.ActorId);
            var scene = actor.Scene;
            CheckSceneWrite(scene, p == null ? null : p.ExpectedSceneRevision, p == null ? null : p.LeaseId);
            var sceneId = scene == null ? null : scene.ID.ToString("N");
            var deletedId = actor.ID.ToString("N");
            FEditor.Instance.SceneEditing.Deselect();
            FEditor.Instance.SceneEditing.Select(actor);
            FEditor.Instance.SceneEditing.Delete(); // Editor API records undo/redo.
            var revision = AdvanceSceneRevision(scene);
            return new McpDeletedDto { DeletedId = deletedId, ProjectRevision = revision.ProjectRevision, SceneId = sceneId, SceneRevision = revision.SceneRevision };
        }

        private object DuplicateActor(McpActorId p)
        {
            var actor = RequireActor(p == null ? null : p.ActorId);
            var scene = actor.Scene;
            CheckSceneWrite(scene, p == null ? null : p.ExpectedSceneRevision, p == null ? null : p.LeaseId);
            FEditor.Instance.SceneEditing.Deselect();
            FEditor.Instance.SceneEditing.Select(actor);
            FEditor.Instance.SceneEditing.Duplicate(); // Public API is undoable but returns no new Actor ID.
            var revision = AdvanceSceneRevision(scene);
            return new McpDuplicatedDto { SourceId = actor.ID.ToString("N"), NewActorId = null, Verified = false, ProjectRevision = revision.ProjectRevision, SceneId = scene == null ? null : scene.ID.ToString("N"), SceneRevision = revision.SceneRevision };
        }

        private McpActorDto ReparentActor(McpActorReparent p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor reparent parameters are required.");
            var actor = RequireActor(p.ActorId);
            var parent = string.IsNullOrEmpty(p.ParentId) ? null : RequireActor(p.ParentId);
            if (parent == actor) throw new McpProtocolException("VALIDATION_FAILED", "An actor cannot parent itself.");
            if (parent != null && parent.Scene != actor.Scene) throw new McpProtocolException("VALIDATION_FAILED", "Cross-scene reparenting is not supported by the v7 edit lease scope.");
            CheckSceneWrite(actor.Scene, p.ExpectedSceneRevision, p.LeaseId);
            FEditor.Instance.Undo.RecordAction(actor, "Reparent actor", () =>
            {
                actor.SetParent(parent, p.KeepWorldTransform, true);
                MarkEdited(actor);
            });
            AdvanceSceneRevision(actor.Scene);
            return ActorDto(actor, false);
        }

        // Script fields are intentionally limited to Enabled. Arbitrary C# member
        // editing is not safe or stable across reloads, so it is not exposed.
        private object AttachScript(McpScriptAttach p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Script attach parameters are required.");
            var actor = RequireActor(p.ActorId);
            CheckSceneWrite(actor.Scene, p.ExpectedSceneRevision, p.LeaseId);
            var type = ResolveType(p.ScriptType, typeof(Script));
            var script = actor.AddScript(type);
            if (script == null) throw new McpProtocolException("VALIDATION_FAILED", "Failed to attach script.");
            FEditor.Instance.Undo.AddAction(CreateInternalScriptAction("Added", script));
            MarkEdited(actor);
            AdvanceSceneRevision(actor.Scene);
            return ScriptInfo(script);
        }

        private object DetachScript(McpScriptId p)
        {
            var script = RequireScript(p == null ? null : p.ScriptId);
            var id = script.ID.ToString("N");
            var actor = script.Actor;
            var scene = actor == null ? null : actor.Scene;
            CheckSceneWrite(scene, p == null ? null : p.ExpectedSceneRevision, p == null ? null : p.LeaseId);
            var action = CreateInternalScriptAction("Remove", script);
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            if (actor != null) MarkEdited(actor);
            var revision = AdvanceSceneRevision(scene);
            return new McpDetachedDto { DetachedId = id, ProjectRevision = revision.ProjectRevision, SceneId = scene == null ? null : scene.ID.ToString("N"), SceneRevision = revision.SceneRevision };
        }

        private McpScriptDto ScriptInfo(Script script)
        {
            var scene = script.Actor == null ? null : script.Actor.Scene;
            var revision = CurrentRevision(scene);
            return new McpScriptDto
            {
                Id = script.ID.ToString("N"),
                TypeName = script.TypeName,
                ActorId = script.Actor == null ? null : script.Actor.ID.ToString("N"),
                Enabled = script.Enabled,
                ProjectRevision = revision.ProjectRevision,
                SceneRevision = revision.SceneRevision,
            };
        }

        private object UpdateScript(McpScriptUpdate p)
        {
            if (p == null || !p.Enabled.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Only the enabled field may be updated.");
            var script = RequireScript(p.ScriptId);
            var actor = script.Actor;
            CheckSceneWrite(actor == null ? null : actor.Scene, p.ExpectedSceneRevision, p.LeaseId);
            var action = new McpScriptEnabledUndo(script, script.Enabled, p.Enabled.Value);
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            if (actor != null) MarkEdited(actor);
            AdvanceSceneRevision(actor == null ? null : actor.Scene);
            return ScriptInfo(script);
        }

        private McpActorDto ActorDto(Actor actor, bool recursive)
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
                Scale = FromFloat3(actor.Scale), EulerAngles = FromFloat3(actor.EulerAngles),
                LocalPosition = FromFloat3(actor.LocalPosition), LocalScale = FromFloat3(actor.LocalScale), LocalEulerAngles = FromFloat3(actor.LocalEulerAngles),
                Tags = ActorTagNames(actor, out var tagsTruncated), TagsTruncated = tagsTruncated, Layer = actor.Layer, LayerName = LimitForLog(actor.LayerName, MaxLayerNameChars),
                ChildrenCount = actor.ChildrenCount, ActiveInHierarchy = actor.IsActiveInHierarchy, StaticFlags = (int)actor.StaticFlags, OrderInParent = actor.OrderInParent,
                ScriptIds = includeScripts ? scripts.ToArray() : null,
            };
            if (depth < requestedDepth)
            {
                var children = new List<McpActorDto>();
                for (var i = 0; i < actor.ChildrenCount; i++) children.Add(RuntimeActorDto(actor.GetChild(i), depth + 1, requestedDepth, includeScripts, budget));
                dto.Children = children.ToArray();
            }
            return dto;
        }

        private McpActorDto ActorDto(Actor actor, bool recursive, int depth, McpTreeBudget budget)
        {
            budget.Count++;
            if (budget.Count > MaxTreeActors)
                throw new McpProtocolException("RESPONSE_TOO_LARGE", "Actor tree exceeds the 2000 actor response limit.");
            var scripts = new List<string>();
            for (var i = 0; i < actor.ScriptsCount; i++) scripts.Add(actor.GetScript(i).ID.ToString("N"));
            var revision = CurrentRevision(actor.Scene);
            var dto = new McpActorDto
            {
                Id = actor.ID.ToString("N"), TypeName = actor.TypeName, Name = actor.Name, Active = actor.IsActive,
                ParentId = actor.Parent == null ? null : actor.Parent.ID.ToString("N"), Position = FromFloat3(actor.Position),
                Scale = FromFloat3(actor.Scale), EulerAngles = FromFloat3(actor.EulerAngles),
                LocalPosition = FromFloat3(actor.LocalPosition), LocalScale = FromFloat3(actor.LocalScale), LocalEulerAngles = FromFloat3(actor.LocalEulerAngles),
                Tags = ActorTagNames(actor, out var tagsTruncated), TagsTruncated = tagsTruncated, Layer = actor.Layer, LayerName = LimitForLog(actor.LayerName, MaxLayerNameChars),
                ChildrenCount = actor.ChildrenCount, ActiveInHierarchy = actor.IsActiveInHierarchy, StaticFlags = (int)actor.StaticFlags, OrderInParent = actor.OrderInParent,
                ScriptIds = scripts.ToArray(),
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
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

        private McpSceneRef SceneRef(Scene scene)
        {
            var revision = CurrentRevision(scene);
            return new McpSceneRef { Id = scene.ID.ToString("N"), Name = scene.Name, Path = ProjectRelativePath(scene.Path), Edited = FEditor.Instance.Scene.IsEdited(scene), ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision };
        }
        private static string ProjectRelativePath(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            var root = Path.GetFullPath(Globals.ProjectFolder);
            var full = Path.GetFullPath(value);
            var relative = Path.GetRelativePath(root, full).Replace('\\', '/');
            return relative == ".." || relative.StartsWith("../", StringComparison.Ordinal) ? null : relative;
        }
        private static void MarkEdited(Actor actor) { if (actor != null && actor.Scene != null) FEditor.Instance.Scene.MarkSceneEdited(actor.Scene); }

        private McpRevision CurrentRevision(Scene scene)
        {
            lock (_stateLock)
            {
                var sceneRevision = 0L;
                if (scene != null) _sceneRevisions.TryGetValue(scene.ID.ToString("N"), out sceneRevision);
                return new McpRevision { ProjectRevision = _projectRevision, SceneRevision = sceneRevision };
            }
        }

        private McpRevision AdvanceSceneRevision(Scene scene)
        {
            lock (_stateLock)
            {
                _projectRevision++;
                var sceneRevision = 0L;
                if (scene != null)
                {
                    var sceneId = scene.ID.ToString("N");
                    _sceneRevisions.TryGetValue(sceneId, out sceneRevision);
                    sceneRevision++;
                    _sceneRevisions[sceneId] = sceneRevision;
                }
                return new McpRevision { ProjectRevision = _projectRevision, SceneRevision = sceneRevision };
            }
        }

        private long AdvanceProjectRevision()
        {
            lock (_stateLock) return ++_projectRevision;
        }

        private void CheckSceneWrite(Scene scene, long? expectedSceneRevision, string leaseId)
        {
            if (scene == null && (expectedSceneRevision.HasValue || !string.IsNullOrEmpty(leaseId)))
                throw new McpProtocolException("VALIDATION_FAILED", "ExpectedSceneRevision or LeaseId requires a target scene that the bridge can identify before writing.");
            if (scene == null) return;
            var sceneId = scene.ID.ToString("N");
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                long current;
                _sceneRevisions.TryGetValue(sceneId, out current);
                if (expectedSceneRevision.HasValue && expectedSceneRevision.Value != current)
                    throw new McpProtocolException("SCENE_REVISION_CONFLICT", "ExpectedSceneRevision does not match the current bridge-known scene revision.", new { SceneId = sceneId, ExpectedSceneRevision = expectedSceneRevision.Value, CurrentSceneRevision = current, ProjectRevision = _projectRevision });
                McpLeaseState lease;
                if (_sceneLeases.TryGetValue(sceneId, out lease))
                {
                    if (!string.Equals(lease.LeaseId, leaseId, StringComparison.Ordinal))
                        throw new McpProtocolException("EDIT_LEASE_CONFLICT", "A different edit lease is active for this scene.", LeaseDetails(lease, "active"));
                }
                else if (!string.IsNullOrEmpty(leaseId))
                {
                    throw new McpProtocolException("EDIT_LEASE_EXPIRED", "The supplied edit lease is no longer active.", new { SceneId = sceneId, LeaseId = leaseId, ProjectRevision = _projectRevision, CurrentSceneRevision = current });
                }
            }
        }

        private McpEditLease BeginLease(McpLeaseBegin request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Edit lease parameters are required.");
            var scene = RequireScene(request.SceneId);
            if (string.IsNullOrWhiteSpace(request.Owner) || request.Owner.Length > 128) throw new McpProtocolException("VALIDATION_FAILED", "Owner must be between 1 and 128 characters.");
            if (request.TtlMs < MinLeaseTtlMs || request.TtlMs > MaxLeaseTtlMs) throw new McpProtocolException("VALIDATION_FAILED", "TtlMs must be between " + MinLeaseTtlMs + " and " + MaxLeaseTtlMs + ".");
            var sceneId = scene.ID.ToString("N");
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                McpLeaseState existing;
                if (_sceneLeases.TryGetValue(sceneId, out existing)) throw new McpProtocolException("EDIT_LEASE_CONFLICT", "An edit lease is already active for this scene.", LeaseDetails(existing, "active"));
                var lease = new McpLeaseState { LeaseId = Guid.NewGuid().ToString("N"), SceneId = sceneId, Owner = request.Owner, AcquiredUnixMs = now, ExpiresUnixMs = now + request.TtlMs };
                _sceneLeases[sceneId] = lease;
                return LeaseDetails(lease, "active");
            }
        }

        private McpEditLease GetLease(McpLeaseGet request)
        {
            if (request == null || (string.IsNullOrEmpty(request.SceneId) && string.IsNullOrEmpty(request.LeaseId))) throw new McpProtocolException("INVALID_REQUEST", "SceneId or LeaseId is required.");
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                McpLeaseState lease = null;
                if (!string.IsNullOrEmpty(request.SceneId)) _sceneLeases.TryGetValue(request.SceneId, out lease);
                if (lease == null && !string.IsNullOrEmpty(request.LeaseId))
                {
                    foreach (var item in _sceneLeases) if (string.Equals(item.Value.LeaseId, request.LeaseId, StringComparison.Ordinal)) { lease = item.Value; break; }
                }
                if (lease == null) throw new McpProtocolException("NOT_FOUND", "Edit lease was not found or has expired.");
                return LeaseDetails(lease, "active");
            }
        }

        private McpEditLease CommitLease(McpLeaseRelease request)
        {
            return EndLease(request, "committed");
        }

        private McpEditLease ReleaseLease(McpLeaseRelease request)
        {
            return EndLease(request, "released");
        }

        private McpEditLease EndLease(McpLeaseRelease request, string state)
        {
            if (request == null || string.IsNullOrEmpty(request.LeaseId)) throw new McpProtocolException("INVALID_REQUEST", "LeaseId is required.");
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                McpLeaseState lease = null;
                string sceneId = null;
                foreach (var item in _sceneLeases)
                {
                    if (string.Equals(item.Value.LeaseId, request.LeaseId, StringComparison.Ordinal)) { lease = item.Value; sceneId = item.Key; break; }
                }
                if (lease == null) throw new McpProtocolException("NOT_FOUND", "Edit lease was not found or has expired.");
                _sceneLeases.Remove(sceneId);
                return LeaseDetails(lease, state);
            }
        }

        private McpEditLease LeaseDetails(McpLeaseState lease, string state)
        {
            long sceneRevision;
            _sceneRevisions.TryGetValue(lease.SceneId, out sceneRevision);
            return new McpEditLease { LeaseId = lease.LeaseId, SceneId = lease.SceneId, Owner = lease.Owner, AcquiredUnixMs = lease.AcquiredUnixMs, ExpiresUnixMs = lease.ExpiresUnixMs, State = state, ProjectRevision = _projectRevision, SceneRevision = sceneRevision };
        }

        private object ActiveLeasesDetailsLocked()
        {
            var active = new List<McpEditLease>();
            foreach (var item in _sceneLeases) active.Add(LeaseDetails(item.Value, "active"));
            return new { ActiveLeases = active.ToArray(), ProjectRevision = _projectRevision };
        }

        private void CleanupExpiredStateLocked(long now)
        {
            var expiredLeases = new List<string>();
            foreach (var item in _sceneLeases) if (item.Value.ExpiresUnixMs <= now) expiredLeases.Add(item.Key);
            foreach (var sceneId in expiredLeases) _sceneLeases.Remove(sceneId);
            var expiredKeys = new List<string>();
            foreach (var item in _idempotency) if (item.Value.ExpiresUnixMs <= now) expiredKeys.Add(item.Key);
            foreach (var key in expiredKeys) _idempotency.Remove(key);
            var expiredCursors = new List<string>();
            foreach (var item in _assetCursors) if (item.Value.ExpiresUnixMs <= now) expiredCursors.Add(item.Key);
            foreach (var key in expiredCursors) _assetCursors.Remove(key);
            var expiredImportOperations = new List<string>();
            foreach (var item in _assetImportOperations)
            {
                var completed = item.Value.FinishedUnixMs == 0 ? item.Value.StartedUnixMs : item.Value.FinishedUnixMs;
                if (completed + AssetImportOperationTtlMs <= now) expiredImportOperations.Add(item.Key);
            }
            foreach (var key in expiredImportOperations)
            {
                _assetImportOperations.Remove(key);
                _assetImportOperationFingerprints.Remove(key);
                var pendingOutputs = new List<string>();
                foreach (var pending in _pendingReimportsByOutputPath) if (string.Equals(pending.Value, key, StringComparison.Ordinal)) pendingOutputs.Add(pending.Key);
                foreach (var output in pendingOutputs) _pendingReimportsByOutputPath.Remove(output);
            }
            var expiredOperations = new List<string>();
            foreach (var item in _operations)
            {
                var completed = item.Value.FinishedUnixMs == 0 ? item.Value.UpdatedUnixMs : item.Value.FinishedUnixMs;
                if (completed + OperationTtlMs <= now) expiredOperations.Add(item.Key);
            }
            foreach (var key in expiredOperations) { _operations.Remove(key); TryDelete(OperationPath(key)); }
        }

        private object ExecuteIdempotent(string method, string key, object request, Func<object> mutation)
        {
            if (string.IsNullOrEmpty(key)) return mutation();
            if (key.Length > 128) throw new McpProtocolException("VALIDATION_FAILED", "IdempotencyKey is limited to 128 characters.");
            var fingerprint = Fingerprint(method + "\n" + JsonSerializer.Serialize(request, false));
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                McpIdempotencyEntry existing;
                if (_idempotency.TryGetValue(key, out existing))
                {
                    if (!string.Equals(existing.Method, method, StringComparison.Ordinal) || !string.Equals(existing.Fingerprint, fingerprint, StringComparison.Ordinal))
                        throw new McpProtocolException("IDEMPOTENCY_KEY_REUSED", "IdempotencyKey was already used for a different mutation request.", new { Method = existing.Method, ProjectRevision = _projectRevision });
                    return existing.Result;
                }
            }
            var result = mutation();
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                if (_idempotency.Count >= MaxIdempotencyEntries)
                {
                    string oldest = null;
                    long oldestExpiry = long.MaxValue;
                    foreach (var item in _idempotency) if (item.Value.ExpiresUnixMs < oldestExpiry) { oldest = item.Key; oldestExpiry = item.Value.ExpiresUnixMs; }
                    if (oldest != null) _idempotency.Remove(oldest);
                }
                _idempotency[key] = new McpIdempotencyEntry { Method = method, Fingerprint = fingerprint, Result = result, ExpiresUnixMs = now + IdempotencyTtlMs };
            }
            return result;
        }

        private static string Fingerprint(string text)
        {
            using (var hash = SHA256.Create())
            {
                var bytes = hash.ComputeHash(Encoding.UTF8.GetBytes(text));
                var builder = new StringBuilder(bytes.Length * 2);
                foreach (var value in bytes) builder.Append(value.ToString("x2"));
                return builder.ToString();
            }
        }
        private static Scene RequireScene(string id) { Guid guid; if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "sceneId must be a 32-character GUID."); var scene = Level.FindScene(guid); if (scene == null) throw new McpProtocolException("NOT_FOUND", "Loaded scene was not found."); return scene; }
        private static Actor RequireActor(string id) { Guid guid; if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "actorId must be a 32-character GUID."); var actor = Level.FindActor(guid); if (actor == null) throw new McpProtocolException("NOT_FOUND", "Actor was not found."); return actor; }
        private static Script RequireScript(string id) { Guid guid; if (!Guid.TryParseExact(id ?? "", "N", out guid)) throw new McpProtocolException("INVALID_REQUEST", "scriptId must be a 32-character GUID."); var script = FObject.TryFind<Script>(ref guid); if (script == null) throw new McpProtocolException("NOT_FOUND", "Script was not found."); return script; }
        private static McpVector3 FromFloat3(Float3 v) { return new McpVector3 { X = v.X, Y = v.Y, Z = v.Z }; }
        private static Float3 ToFloat3(McpVector3 v) { return new Float3(v.X, v.Y, v.Z); }
        private static void ValidateVector(McpVector3 value, string name)
        {
            if (value == null) return;
            if (float.IsNaN(value.X) || float.IsInfinity(value.X) || float.IsNaN(value.Y) || float.IsInfinity(value.Y) || float.IsNaN(value.Z) || float.IsInfinity(value.Z))
                throw new McpProtocolException("VALIDATION_FAILED", name + " must contain only finite values.");
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

        // ContentImporting raises this from its worker thread. Only the opaque
        // operation ID and sanitized terminal state are retained; the source or
        // full output path is never placed in an MCP DTO.
        private void OnAssetImportFileEnd(IFileEntryAction entry, bool failed)
        {
            if (entry == null || string.IsNullOrEmpty(entry.ResultUrl)) return;
            string output;
            try { output = Path.GetFullPath(entry.ResultUrl); } catch { return; }
            lock (_stateLock)
            {
                string operationId;
                if (!_pendingReimportsByOutputPath.TryGetValue(output, out operationId)) return;
                _pendingReimportsByOutputPath.Remove(output);
                McpAssetOperation operation;
                if (!_assetImportOperations.TryGetValue(operationId, out operation)) return;
                operation.Phase = failed ? "failed" : "succeeded";
                operation.Progress = 1.0f;
                operation.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                operation.ErrorCode = failed ? "IMPORT_FAILED" : null;
                operation.Error = failed ? "Flax Editor failed to reimport the selected asset." : null;
            }
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
            FEditor.Instance.ContentImporting.ImportFileEnd += OnAssetImportFileEnd;
            GameCooker.Event += OnGameCookerEvent;
            GameCooker.Progress += OnGameCookerProgress;
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
            FEditor.Instance.ContentImporting.ImportFileEnd -= OnAssetImportFileEnd;
            }
            GameCooker.Event -= OnGameCookerEvent;
            GameCooker.Progress -= OnGameCookerProgress;
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

        private void OnGameCookerProgress(string info, float totalProgress)
        {
            lock (_stateLock)
            {
                foreach (var operation in _operations.Values)
                {
                    if (operation.Kind != "build_cook" || IsTerminalOperationPhase(operation.Phase)) continue;
                    UpdateOperationLocked(operation.OperationId, operation.CancelRequested ? "cancelling" : "running", totalProgress, string.IsNullOrEmpty(info) ? "Flax game cooker is running" : LimitForLog(info, MaxOperationMessageChars));
                    break;
                }
            }
        }

        private void OnGameCookerEvent(GameCooker.EventType type)
        {
            lock (_stateLock)
            {
                foreach (var operation in _operations.Values)
                {
                    if (operation.Kind != "build_cook" || IsTerminalOperationPhase(operation.Phase)) continue;
                    if (type == GameCooker.EventType.BuildStarted)
                        UpdateOperationLocked(operation.OperationId, "running", operation.Progress, "Flax game cooker started");
                    else if (type == GameCooker.EventType.BuildDone)
                        UpdateOperationLocked(operation.OperationId, "succeeded", 1.0f, "Flax game cooker completed", null, null, "Build output was produced below the requested Builds/ directory.");
                    else if (type == GameCooker.EventType.BuildFailed)
                    {
                        if (operation.CancelRequested)
                            UpdateOperationLocked(operation.OperationId, "cancelled", operation.Progress, "Flax game cooker cancelled", "OPERATION_CANCELLED", "Flax game cooker observed the requested cancellation.");
                        else
                            UpdateOperationLocked(operation.OperationId, "failed", 1.0f, "Flax game cooker failed", "BUILD_FAILED", "Flax game cooker reported build failure.");
                    }
                    break;
                }
            }
        }

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
                RestoreOperations();
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

        // Operation handles are persisted individually so a script reload can
        // adopt only the exact caller-selected ID. They are never inferred from
        // a later start request, which prevents blind retry of side effects.
        private McpOperation BeginOperationLocked(string operationId, string kind, bool canCancel, string message, int totalSteps)
        {
            if (!IsGuidN(operationId)) throw new McpProtocolException("INVALID_REQUEST", "OperationId must be a 32-character GUID without separators.");
            McpOperation existing;
            if (_operations.TryGetValue(operationId, out existing))
            {
                if (!string.Equals(existing.Kind, kind, StringComparison.Ordinal))
                    throw new McpProtocolException("IDEMPOTENCY_KEY_REUSED", "OperationId was already used for a different operation kind.");
                return CopyOperation(existing);
            }
            CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            while (_operations.Count >= MaxOperations)
            {
                string oldest = null; long oldestTime = long.MaxValue;
                foreach (var entry in _operations) { var t = entry.Value.FinishedUnixMs == 0 ? entry.Value.UpdatedUnixMs : entry.Value.FinishedUnixMs; if (t < oldestTime) { oldest = entry.Key; oldestTime = t; } }
                if (oldest == null) break;
                _operations.Remove(oldest); TryDelete(OperationPath(oldest));
            }
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var operation = new McpOperation { OperationId = operationId, Kind = kind, Phase = "requested", Progress = 0.0f, Message = LimitForLog(message, MaxOperationMessageChars), Step = 0, TotalSteps = Math.Max(0, totalSteps), StartedUnixMs = now, UpdatedUnixMs = now, CanCancel = canCancel, Diagnostics = new string[0] };
            _operations[operationId] = operation;
            PersistOperationLocked(operation);
            return CopyOperation(operation);
        }

        private void UpdateOperationLocked(string operationId, string phase, float progress, string message, string errorCode = null, string error = null, string resultSummary = null)
        {
            McpOperation operation;
            if (!_operations.TryGetValue(operationId, out operation)) return;
            if (operation.CancelRequested && phase == "succeeded") phase = "cancelled";
            operation.Phase = phase;
            operation.Progress = Math.Max(0.0f, Math.Min(1.0f, progress));
            operation.Message = LimitForLog(message, MaxOperationMessageChars);
            operation.ErrorCode = errorCode;
            operation.Error = LimitForLog(error, MaxOperationMessageChars);
            operation.ResultSummary = LimitForLog(resultSummary, MaxOperationMessageChars);
            operation.UpdatedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (IsTerminalOperationPhase(phase)) { operation.FinishedUnixMs = operation.UpdatedUnixMs; operation.CanCancel = false; }
            PersistOperationLocked(operation);
        }

        private McpOperation GetOperation(McpOperationRequest request)
        {
            if (request == null || !IsGuidN(request.OperationId)) throw new McpProtocolException("OPERATION_NOT_FOUND", "Operation ID was not found.");
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                McpOperation operation;
                if (!_operations.TryGetValue(request.OperationId, out operation)) throw new McpProtocolException("OPERATION_NOT_FOUND", "Operation ID was not found or has expired.");
                ReconcileOperationLocked(operation);
                return CopyOperation(operation);
            }
        }

        private McpOperation CancelOperation(McpOperationCancelRequest request)
        {
            if (request == null || !IsGuidN(request.OperationId)) throw new McpProtocolException("OPERATION_NOT_FOUND", "Operation ID was not found.");
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                McpOperation operation;
                if (!_operations.TryGetValue(request.OperationId, out operation)) throw new McpProtocolException("OPERATION_NOT_FOUND", "Operation ID was not found or has expired.");
                ReconcileOperationLocked(operation);
                if (IsTerminalOperationPhase(operation.Phase)) return CopyOperation(operation);
                // Flax 1.12 exposes no safe public cancellation for compilation
                // or ContentImporting. Never claim cancellation merely because a
                // client disconnected; only queued project generation is safe.
                if (!operation.CanCancel) throw new McpProtocolException("CANCELLATION_UNSUPPORTED", "The active backend does not expose safe cancellation for this operation.");
                if (string.Equals(operation.Kind, "project_generation", StringComparison.Ordinal))
                {
                    operation.CancelRequested = true;
                    UpdateOperationLocked(operation.OperationId, "cancelled", operation.Progress, "Project generation was cancelled before execution.", "OPERATION_CANCELLED", "Cancelled at a safe queue checkpoint.");
                    return CopyOperation(operation);
                }
                if (string.Equals(operation.Kind, "build_cook", StringComparison.Ordinal))
                {
                    if (!GameCooker.IsRunning) throw new McpProtocolException("CANCELLATION_UNSUPPORTED", "The Flax game cooker is no longer running; refresh operation status instead.");
                    GameCooker.Cancel(false);
                    operation.CancelRequested = true;
                    UpdateOperationLocked(operation.OperationId, "cancelling", operation.Progress, "Flax game cooker cancellation requested");
                    return CopyOperation(operation);
                }
                throw new McpProtocolException("CANCELLATION_UNSUPPORTED", "The active backend does not expose safe cancellation for this operation.");
            }
        }

        private void ReconcileOperationLocked(McpOperation operation)
        {
            if (operation == null || IsTerminalOperationPhase(operation.Phase)) return;
            if (operation.Kind == "compile" && string.Equals(_compile.OperationId, operation.OperationId, StringComparison.Ordinal))
            {
                _compile.IsCompiling = ScriptsBuilder.IsCompiling; _compile.IsReady = ScriptsBuilder.IsReady; _compile.LastCompilationFailed = ScriptsBuilder.LastCompilationFailed;
                var phase = _compile.Phase;
                if (phase == "reloading" && !_compile.IsCompiling && _compile.IsReady) phase = _compile.LastCompilationFailed ? "failed" : "succeeded";
                UpdateOperationLocked(operation.OperationId, phase, IsTerminalOperationPhase(phase) ? 1.0f : 0.5f, phase == "reloading" ? "Reloading scripts" : "Compiling scripts", phase == "failed" ? "COMPILATION_FAILED" : null, phase == "failed" ? "Flax script compilation failed." : null);
            }
            else if (operation.Kind == "project_generation" && string.Equals(_generate.OperationId, operation.OperationId, StringComparison.Ordinal))
                UpdateOperationLocked(operation.OperationId, _generate.Phase, IsTerminalOperationPhase(_generate.Phase) ? 1.0f : 0.5f, "Generating project files", _generate.Failed ? "GENERATION_FAILED" : null, _generate.Error);
            else if ((operation.Kind == "asset_import" || operation.Kind == "asset_reimport"))
            {
                McpAssetOperation asset;
                if (_assetImportOperations.TryGetValue(operation.OperationId, out asset))
                    UpdateOperationLocked(operation.OperationId, asset.Phase, asset.Progress, asset.Phase == "running" ? "Importing content" : "Processing asset operation", asset.ErrorCode, asset.Error, asset.ResultPath);
            }
            else if (operation.Kind == "build_cook" && !GameCooker.IsRunning && operation.Phase == "running")
                UpdateOperationLocked(operation.OperationId, "interrupted", operation.Progress, "Game cooker stopped without a terminal build event.", "BUILD_INTERRUPTED", "Flax did not report build completion.");
        }

        private static bool IsTerminalOperationPhase(string phase) { return phase == "succeeded" || phase == "failed" || phase == "cancelled" || phase == "interrupted" || phase == "dry_run"; }
        private static string OperationPath(string operationId) { return Path.Combine(Operations, operationId + ".json"); }
        private void PersistOperations() { lock (_stateLock) foreach (var operation in _operations.Values) PersistOperationLocked(operation); }
        private void PersistOperationLocked(McpOperation operation) { if (operation != null && IsGuidN(operation.OperationId)) TryWritePersistent(OperationPath(operation.OperationId), CopyOperation(operation)); }
        private static McpOperation CopyOperation(McpOperation value) { return new McpOperation { OperationId = value.OperationId, Kind = value.Kind, Phase = value.Phase, Progress = value.Progress, Message = value.Message, Step = value.Step, TotalSteps = value.TotalSteps, StartedUnixMs = value.StartedUnixMs, UpdatedUnixMs = value.UpdatedUnixMs, FinishedUnixMs = value.FinishedUnixMs, CanCancel = value.CanCancel, CancelRequested = value.CancelRequested, ResultSummary = value.ResultSummary, ErrorCode = value.ErrorCode, Error = value.Error, Diagnostics = value.Diagnostics == null ? new string[0] : (string[])value.Diagnostics.Clone() }; }

        private void RestoreOperations()
        {
            try
            {
                if (!Directory.Exists(Operations)) return;
                foreach (var file in Directory.GetFiles(Operations, "*.json"))
                {
                    var operation = ReadPersistent<McpOperation>(file);
                    if (operation == null || !IsGuidN(operation.OperationId) || string.IsNullOrEmpty(operation.Kind)) { TryDelete(file); continue; }
                    var completed = operation.FinishedUnixMs == 0 ? operation.UpdatedUnixMs : operation.FinishedUnixMs;
                    if (completed + OperationTtlMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) { TryDelete(file); continue; }
                    if (!IsTerminalOperationPhase(operation.Phase)) { operation.Phase = "interrupted"; operation.CanCancel = false; operation.FinishedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); operation.Message = "Bridge reloaded before operation completed."; }
                    if (_operations.Count < MaxOperations) _operations[operation.OperationId] = operation;
                }
            }
            catch { }
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
        private static McpResponse Failure(string id, string requestToken, string code, string message, object details = null)
        {
            // Never disclose the active session token to an unauthenticated
            // request. Authenticated failures naturally echo the valid token.
            return new McpResponse { id = id, token = requestToken, ok = false, errorCode = code, error = message, errorDetails = details == null ? null : JsonSerializer.Serialize(details, false), timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
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
        public readonly object Details;
        public McpProtocolException(string code, string message, object details = null) : base(message) { Code = code; Details = details; }
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
