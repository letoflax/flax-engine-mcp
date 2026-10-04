// MCP-BRIDGE-VERSION: 36
// Flax 1.12 Editor-only bridge for flax-engine-mcp.
//
// Install this file in a game module, for example Source/Game/MCP/FlaxMcpBridge.cs.
// It is deliberately file-RPC only: no listener is exposed on the network.
#if FLAX_EDITOR
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
using FlaxEditor;
using FlaxEditor.Content;
using FlaxEditor.Content.Import;
using FlaxEditor.SceneGraph;
using FlaxEditor.Scripting;
using FlaxEditor.Surface;
using FlaxEngine.Tools;
using FEditor = FlaxEditor.Editor;
using FlaxEngine;
using FlaxEngine.Json;
using FObject = FlaxEngine.Object;
// Bridge v33: aliases instead of namespace imports so FlaxEngine.GUI and
// FlaxEditor.Content.Settings names cannot collide with existing bridge code.
using FControl = FlaxEngine.GUI.Control;
using FContainerControl = FlaxEngine.GUI.ContainerControl;
using FRootControl = FlaxEngine.GUI.RootControl;
using FMargin = FlaxEngine.GUI.Margin;
using FGameSettings = FlaxEditor.Content.Settings.GameSettings;
using FInputSettings = FlaxEditor.Content.Settings.InputSettings;
using FLayersAndTagsSettings = FlaxEditor.Content.Settings.LayersAndTagsSettings;

namespace Game.MCP
{
    // Wire DTOs. Public field names are the protocol keys (see bridge/PROTOCOL.md).
    public class McpBridgeInfo { public int BridgeVersion = 36; public int ProtocolVersion = 1; public int Pid; public string Project; public string EditorVersion; public long Timestamp; }
    // Request/response intentionally use lower camel case because the Node side
    // parses exact on-disk keys. Heartbeat remains PascalCase for compatibility.
    public class McpRequest { public string id; public string token; public string method; public string paramsJson; public long deadlineUnixMs; }
    public class McpResponse { public string id; public string token; public bool ok; public string errorCode; public string error; public string errorDetails; public string resultJson; public long timestamp; }
    public class McpStatus { public int BridgeVersion = 36; public int ProtocolVersion = 1; public int Pid; public string EditorVersion; public bool IsPlayMode; public bool IsHeadless; public bool TransactionsSupported = false; public bool EditLeasesSupported = true; public string EditLeaseSemantics = "visible-immediately-no-rollback"; public long ProjectRevision; public string RevisionScope = "bridge-session-known-mutations"; public string LogSessionId; public bool AssetRegistrySupported = true; public bool AssetReferenceGraphSupported = true; public bool AssetImportSupported = true; public bool AssetReimportSupported = true; public bool AssetImportSynchronous = true; public bool AssetReimportSynchronous = false; public bool AssetImportSettingsSupported = true; public bool AssetReferenceLocationsSupported = false; public bool AssetOrganizationSupported = true; public bool AssetOrganizationUndoSupported = false; public bool AssetOrganizationLeaseSupported = false; public string AssetOrganizationAtomicity = "single-content-api-call-not-transactional"; public bool AssetQuarantineDeleteSupported = true; public bool AssetPermanentDeleteSupported = false; public bool OperationStatusSupported = true; public bool OperationCancelSupported = true; public string OperationHandleSemantics = "raw-handles-no-mcp-tasks"; public bool PrefabWorkflowsSupported = true; public bool PrefabCreateSupported = true; public bool PrefabInstantiateSupported = true; public bool PrefabInstanceEnumerationSupported = true; public bool PrefabOverridesSupported = true; public bool PrefabApplyOverridesSupported = true; public bool PrefabRevertOverridesSupported = true; public bool PrefabBreakLinkSupported = true; public bool BuildWorkflowsSupported = true; public bool BuildCancelSupported = true; public bool BuildValidationIsPreflightOnly = true; public string BuildOutputScope = "project-relative-Builds-only"; public bool MaterialParameterReadSupported = true; public bool MaterialParameterWriteSupported = true; public bool MaterialInstanceCreationSupported = true; public bool MaterialAssignmentSupported = true; public bool AnimationClipEnumerationSupported = true; public bool AnimationGraphParameterReadSupported = true; public bool AnimationGraphParameterWriteSupported = false; public bool AnimationBindingValidationSupported = true; public bool PhysicsQueriesSupported = true; public bool NavigationQueriesSupported = true; public bool NavigationBuildSupported = true; public bool LightingBakeSupported = true; public bool TerrainFoliageReadSupported = true; public bool GraphInspectSupported = true; public bool GraphDefaultParameterWriteSupported = true; public bool GraphTopologyWriteSupported = true; public bool GraphUndoSupported = true; public bool GraphSetModelSupported = true; public bool ScriptFieldValuesReadSupported = true; public bool AnimgraphStateWriteSupported = true; public bool AnimgraphTransitionWriteSupported = true; public bool EditorViewportCaptureSupported = true; public bool PlayTimeScaleSupported = true; public bool EditorSelectionSupported = true; public bool SceneOpenSupported = true; public bool InputSimulationSupported = true; public bool PerfSnapshotSupported = true; public bool PerfGpuEventsSupported = true; public bool AssetModelStatsSupported = true; public bool ScriptFieldWriteSupported = true; public bool ActorPropertyWriteSupported = true; public bool TerrainPaintSupported = false; public bool FoliageInstanceWriteSupported = true; public bool EnvironmentProbeBakeSupported = true; public bool ActorPropertyReadSupported = true; public bool GenericActorPropertyWriteSupported = true; public bool UiControlWorkflowsSupported = true; public bool RuntimeScriptDriveSupported = true; public bool SettingsWriteSupported = true; public bool SceneCreateSupported = true; public bool SceneCloseSupported = true; public bool ContentFolderCreateSupported = true; public bool AssetCreateSupported = true; public bool ParticleParameterWorkflowsSupported = true; public string[] Methods; public string EditorState; public bool IsEditMode; public bool IsCompiling; public bool ScriptsReady; public bool IsImporting; public bool LastCompileFailed; public int LoadedSceneCount; public bool MethodDiscoverySupported; public bool AssetImportResultIdSupported; public bool AssetImportReplaceSupported; public bool BridgeOwnershipSupported; public bool EditorReadinessSupported; public bool EditorQuitSupported; public bool EditorOptionsSupported; public bool SceneReplaceSupported; public bool SceneReloadSupported; public bool NestedMemberPathSupported; public bool ScriptAssetReferenceWriteSupported; public bool GraphArchetypeListSupported; public bool GraphEditSupported; public bool AnimgraphTransitionSettingsSupported; public bool GameplayGlobalsCreateSupported; public bool MaterialFunctionGraphSupported; }
    public class McpSceneRef { public string Id; public string Name; public string Path; public bool Edited; public long ProjectRevision; public long SceneRevision; public string SaveReport; }
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
    public class McpScriptDto { public string Id; public string TypeName; public string ActorId; public bool Enabled; public long ProjectRevision; public long SceneRevision; public McpScriptFieldDto[] Values; public bool ValuesIncluded; public bool ValuesTruncated; public string[] Warnings; }
    // P7 read surface: one bounded, read-only script field projection.
    // Value is null with Reason set when the runtime type is outside the
    // whitelist (bool/int/float/string/enum/Guid/Vector2-4/Color) or unreadable.
    // Bridge v34: Fields lists the editor-visible members of a nested user
    // structure or class value (Value.Kind "struct" or "object"), bounded.
    public class McpScriptFieldDto { public string Name; public string Type; public McpMaterialTypedValue Value; public string Reason; public McpScriptFieldDto[] Fields; }
    public class McpDeletedDto { public string DeletedId; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpDetachedDto { public string DetachedId; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpDuplicatedDto { public string SourceId; public string NewActorId; public bool Verified; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    internal sealed class McpRevision { public long ProjectRevision; public long SceneRevision; }
    public class McpLeaseBegin { public string SceneId; public string AssetId; public string Path; public string Owner; public int TtlMs = 30000; }
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
    public class McpActorUpdate { public string ActorId; public string Name; public bool? Active; public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles; public McpVector3 LocalPosition; public McpVector3 LocalScale; public McpVector3 LocalEulerAngles; public int? Layer; public string SkinnedModelId; public string SkinnedModelPath; public string AnimationGraphId; public string AnimationGraphPath; public string StaticModelId; public string StaticModelPath; public bool? UpdateWhenOffscreen; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpActorReparent { public string ActorId; public string ParentId; public bool KeepWorldTransform = true; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptAttach { public string ActorId; public string ScriptType; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptId { public string ScriptId; public bool IncludeValues; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptUpdate { public string ScriptId; public bool? Enabled; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    // Bridge v28 bounded script-field write. Value is exactly one of
    // Bool/Number/Text (Node splits its bool|number|string union); the bridge
    // coerces it strictly to the field type and rejects anything else.
    public class McpScriptFieldSet { public string ScriptId; public string Field; public string[] Path; public bool? Bool; public double? Number; public string Text; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpScriptFieldSetResult { public string ScriptId; public string Field; public string Type; public bool DryRun; public bool WouldChange; public McpMaterialTypedValue Before; public McpMaterialTypedValue After; public long ProjectRevision; public long SceneRevision; public string[] Path; }
    // Bridge v28 bounded component-property write. Property is an exact
    // allowlist entry (never a parsed dotted path); value uses the same
    // exactly-one-of Bool/Number/Text shape. ActorId is an actor GUID for the
    // component properties and a script GUID for Script.Enabled.
    // Bridge v33 adds DryRun plus the generic editor-visible member path
    // (Property = "Member" or "Type.Member"); Type/DryRun/WouldChange are
    // additive result fields that older clients can ignore.
    public class McpActorPropertySet { public string ActorId; public string Property; public string[] Path; public bool? Bool; public double? Number; public string Text; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpActorPropertySetResult { public string ActorId; public string Property; public string Type; public bool DryRun; public bool WouldChange; public McpMaterialTypedValue Before; public McpMaterialTypedValue After; public McpActorDto Actor; public long ProjectRevision; public long SceneRevision; public string[] Warnings; public string[] Path; }
    public class McpSceneSave { public string SceneId; }
    // Bridge v25 canonical scene.open. Exactly one of AssetId/Path selects a
    // Content scene asset (FlaxEngine.SceneAsset only). AllowDirtyScenes
    // defaults to false, mirroring the play-start dirty gate convention.
    public class McpSceneOpen { public string AssetId; public string Path; public bool AllowDirtyScenes; public bool Replace; public bool Reload; public bool DiscardUnsaved; }
    public class McpSceneOpenResult { public string SceneId; public string Phase; public string[] UnloadedSceneIds; public string DiskSha256; }
    // Named field-based DTOs: FlaxEngine.Json drops anonymous-type
    // properties to {}, which would silently empty these error details
    // (same reason McpGraphReadinessDetails is a named class).
    public class McpSceneOpenDirtyDetails { public string[] DirtyScenes; }
    public class McpSceneOpenTypeDetails { public string TypeName; }
    // Bridge v24 editor selection. The result is a bounded snapshot of the
    // verified SceneEditingModule.Selection list (public List<SceneGraphNode>);
    // only ActorNode entries with a live Actor are reported.
    public class McpSelectionRequest { public string[] ActorIds; public bool FocusViewport; }
    public class McpSelectionEntry { public string ActorId; public string Name; public string SceneId; }
    public class McpSelectionResult { public McpSelectionEntry[] Selection; public int Count; }
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
    public class McpTimeScaleRequest { public float TimeScale; }
    // Bridge v26 play-mode input simulation surface. Exactly one input event
    // per call (single key press OR single click). Key/button injection has no
    // verified managed Flax API (see SimulateKeyPress/SimulateMouseClick), so
    // both calls validate + gate fully and then report a stable unsupported
    // capability — the same pattern as navigation.build/lighting.bake.
    public class McpKeyPress { public string Key; public int HoldMs = 50; }
    public class McpMouseClick { public string Button = "Left"; public double X; public double Y; public int HoldMs = 50; }
    public class McpPlayStatus { public string State; public string SessionId; public string Mode; public long StartedUnixMs; public long DurationMs; public ulong FrameCount; public bool HasDirtyScenes; public bool IsPlayMode; public bool IsPaused; public bool IsPlayModeRequested; public bool IsDuringBreakpointHang; }
    // Bridge v27 engine-side performance snapshot. Single instantaneous
    // sample, read-only: every field is a primitive or null, and null means
    // the backing API had no data (never an error). No history or averaging
    // lives here; callers average by making N calls.
    public class McpPerfSnapshot { public int? Fps; public float? FrameTimeMs; public long? DrawCalls; public long? Triangles; public long? ManagedMemoryBytes; public int? ActorCount; public string GpuAdapter; public string RendererType; public bool IsPlayMode; public long TimestampUnixMs; }
    public class McpPerfGpuEventsRequest { public bool Enable; public bool Restore; public int MaxEvents; }
    public class McpPerfGpuEvent { public string Name; public int Depth; public float TimeMs; public long DrawCalls; public long DispatchCalls; public long Triangles; public long Vertices; }
    public class McpPerfGpuEvents { public bool ProfilerAvailable; public string Reason; public bool ProfilerEnabled; public bool EnabledByBridge; public bool WasEnabled; public bool Restored; public long FrameCount; public bool HasData; public float? DrawGpuTimeMs; public float? DrawCpuTimeMs; public int EventCount; public bool Truncated; public McpPerfGpuEvent[] Events; public string GpuAdapter; public string RendererType; public bool IsPlayMode; public long TimestampUnixMs; }
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
    // ImportSettingsAvailable is true when the registry type is one that
    // asset.get_import_settings supports (texture, model, audio); the
    // settings themselves are only returned by that method.
    public class McpAssetGetResult { public McpAssetMetadata Asset; public bool ImportSettingsAvailable; public string[] Warnings; }
    public class McpModelLodStats { public int Lod; public bool Loaded; public int? MeshCount; public long? Triangles; public long? Vertices; public float? ScreenSize; }
    public class McpAssetModelStats { public string AssetId; public string Path; public string Kind; public int LodCount; public int LoadedLods; public int MaterialSlotCount; public int? BoneCount; public McpModelLodStats[] Lods; public string[] Warnings; }
    public class McpAssetDependency { public string FromId; public McpAssetDto Asset; public int Depth; public bool Cycle; }
    public class McpAssetDependenciesResult { public McpAssetDto Root; public McpAssetDependency[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    public class McpAssetReference { public McpAssetDto Asset; public string Kind; }
    public class McpAssetReferencesResult { public McpAssetDto Root; public McpAssetReference[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    // Import settings are exposed only through the bounded v32
    // asset.get_import_settings / asset.set_import_settings surface below:
    // texture/model/audio allowlists over the typed Options structs, restored
    // via Editor.TryRestoreImportOptions and applied via
    // ContentImporting.Reimport(item, settings, skipSettingsDialog:true).
    public class McpAssetImportStart { public string OperationId; public string IdempotencyKey; public string SourcePath; public long SourceSizeBytes; public long SourceLastWriteUnixMs; public string DestinationPath; public string CollisionPolicy = "error"; public bool DryRun; public string[] AllowedImportRoots; public long MaxSourceBytes; public string ModelImportType; public bool Confirm; }
    public class McpAssetReimportStart { public string OperationId; public string IdempotencyKey; public string AssetId; public string Path; public bool DryRun; public string[] AllowedImportRoots; public long MaxSourceBytes; public string ModelImportType; }
    public class McpAssetOperationStatusRequest { public string OperationId; }
    public class McpAssetOperation { public string OperationId; public string Kind; public string Phase; public float Progress; public long StartedUnixMs; public long FinishedUnixMs; public string ResultPath; public string ResultAssetId; public bool Renamed; public bool Replaced; public bool DryRun; public string ErrorCode; public string Error; }
    public class McpPersistedAssetOperation { public McpAssetOperation Operation; public string Fingerprint; }
    // Bridge v32 asset import-settings get/set. Settings travel as explicit
    // key/scalar entries with exact C# option field names (never anonymous
    // types: FlaxEngine.Json drops anonymous-type properties to "{}", so
    // every nested shape is an explicit named DTO). Only texture, model, and
    // audio binary assets are supported: exactly FlaxEngine.Texture,
    // FlaxEngine.Model, FlaxEngine.SkinnedModel, and FlaxEngine.AudioClip.
    // In a set result WouldChange/Before/After are null when no preview
    // exists (an adopted operation that failed before it was computed), and
    // Adopted marks a result replayed for an already-known OperationId.
    public class McpImportSettingsValue { public bool? Boolean; public long? Integer; public double? Number; public string Text; }
    public class McpImportSettingsEntry { public string Key; public McpImportSettingsValue Value; }
    public class McpAssetImportSettingsGet { public string AssetId; public string Path; }
    public class McpAssetImportSettingsResult { public McpAssetMetadata Asset; public string Type; public bool Restored; public McpImportSettingsEntry[] Settings; }
    public class McpAssetImportSettingsSet { public string OperationId; public string IdempotencyKey; public string AssetId; public string Path; public McpImportSettingsEntry[] Settings; public bool DryRun; public string[] AllowedImportRoots; public long MaxSourceBytes; }
    public class McpAssetImportSettingsSetResult { public McpAssetOperation Operation; public bool? WouldChange; public McpAssetImportSettingsResult Before; public McpAssetImportSettingsResult After; public bool Adopted; }
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
    // v14 domain DTOs are deliberately query-only except for no-op capability
    // reports. They never serialize raw physics/native objects back to clients.
    public class McpPhysicsRayRequest { public McpVector3 Origin; public McpVector3 Direction; public float Distance = 1000.0f; public uint LayerMask = UInt32.MaxValue; public bool IncludeTriggers = true; }
    public class McpPhysicsOverlapRequest { public McpVector3 Center; public float Radius = 1.0f; public uint LayerMask = UInt32.MaxValue; public bool IncludeTriggers = true; public int Limit = 50; }
    public class McpNavigationPathRequest { public McpVector3 Start; public McpVector3 End; public int MaxPoints = 128; }
    public class McpDomainListRequest { public int Limit = 100; }
    // v14 domain query results. Until bridge v33 these were anonymous types,
    // which FlaxEngine.Json serializes as "{}": in a real Editor every one of
    // these queries returned an empty object (live-verified on Flax 1.12).
    // The field names are the ones the anonymous types always declared.
    public class McpDomainFinding { public string Code; public string ActorId; public string Message; }
    public class McpColliderEntry { public string ActorId; public string SceneId; public string TypeName; public string Name; public bool IsTrigger; public bool Active; public int Layer; }
    public class McpColliderValidationResult { public McpColliderEntry[] Entries; public McpDomainFinding[] Findings; public int Scanned; public string Scope; }
    public class McpLayerEntry { public int Index; public string Name; }
    public class McpLayerMatrixResult { public McpLayerEntry[] Layers; public bool CollisionMatrixAvailable; public string Warning; }
    public class McpRaycastHit { public string ColliderId; public McpVector3 Point; public McpVector3 Normal; public float Distance; public uint FaceIndex; }
    public class McpRaycastResult { public bool Hit; public McpRaycastHit Result; }
    public class McpOverlapEntry { public string ActorId; public string SceneId; public string TypeName; public string Name; public bool IsTrigger; }
    public class McpOverlapResult { public McpOverlapEntry[] Entries; public bool Truncated; public string Scope; }
    public class McpNavigationStatusResult { public bool IsBuilding; public float Progress; public bool BuildSupported; public bool CancellationSupported; public string Scope; public string Warning; }
    public class McpNavMeshAgentEntry { public string ActorId; public string SceneId; public string Name; public float AgentRadius; public float AgentHeight; public float AgentStepHeight; public float AgentMaxSlopeAngle; public bool Active; }
    public class McpNavigationAgentsResult { public McpNavMeshAgentEntry[] Entries; public McpDomainFinding[] Findings; public string Scope; public string Warning; }
    public class McpNavigationPathResult { public bool Found; public McpVector3[] Points; public bool Truncated; public string Scope; }
    public class McpLightingStatusResult { public string Phase; public bool IsBaking; public bool BakeSupported; public bool CancellationSupported; public bool HasLastResult; public bool LastFailed; public string Warning; }
    public class McpLightmapEntry { public string ActorId; public string Type; public bool Active; public float ScaleInLightmap; public bool HasLightmap; }
    public class McpLightingValidateResult { public McpLightmapEntry[] Entries; public int StaticModelCount; public int EnvironmentProbeCount; public string Scope; public string Warning; }
    public class McpTerrainEntry { public string ActorId; public string SceneId; public string Name; public int LODCount; public int ChunkSize; public int HeightmapSize; public float PatchSize; public int PatchesCount; public int CollisionLOD; public bool Active; }
    public class McpTerrainSummaryResult { public McpTerrainEntry[] Entries; public bool Truncated; public string Scope; public bool MutationsSupported; public string Mutation; }
    public class McpFoliageEntry { public string ActorId; public string SceneId; public string Name; public int InstancesCount; public int FoliageTypesCount; public float GlobalDensityScale; public bool Active; }
    public class McpFoliageSummaryResult { public McpFoliageEntry[] Entries; public bool Truncated; public string Scope; public bool MutationsSupported; public string Mutation; public string Warning; }
    // Bridge v31 terrain/foliage/navmesh/bake/probe writes. Results use named
    // field DTOs (never anonymous types): FlaxEngine.Json drops
    // anonymous-type properties to "{}", so every nested shape is explicit.
    public class McpFoliageInstanceSpec { public McpVector3 Position; public McpVector3 Rotation; public double Scale = 1.0; }
    public class McpFoliageAddRequest { public string FoliageId; public int TypeIndex; public McpFoliageInstanceSpec[] Instances; }
    public class McpFoliageAddResult { public string FoliageId; public int TypeIndex; public int AddedCount; public int InstancesCount; public bool UndoRegistered; public bool SceneEdited; public long ProjectRevision; public long SceneRevision; public string[] Warnings; }
    public class McpFoliageRemoveRequest { public string FoliageId; public int[] InstanceIndices; }
    public class McpFoliageRemoveResult { public string FoliageId; public int[] RemovedIndices; public int RemovedCount; public int InstancesCount; public bool UndoRegistered; public bool SceneEdited; public long ProjectRevision; public long SceneRevision; public string[] Warnings; }
    public class McpNavigationBuildRequest { public string SceneId; public McpVector3 Min; public McpVector3 Max; public int TimeoutMs = 15000; }
    public class McpNavigationBuildResult { public string Phase; public float Progress; public bool WholeScene; public string SceneId; public bool ObservedBuilding; public bool DataChanged; public int WaitedMs; public string[] Warnings; }
    public class McpLightingBakeRequest { public string Action; }
    public class McpLightingBakeResult { public string Phase; public bool IsBaking; public string Step; public float StepProgress; public float TotalProgress; public bool HasLastResult; public bool LastFailed; public string[] Warnings; }
    public class McpProbeBakeRequest { public string ActorId; public int TimeoutMs = 10000; }
    public class McpProbeBakeResult { public string Phase; public string ActorId; public string Kind; public string[] Warnings; }
    public class McpPrefabCreateFromActor { public string ActorId; public string DestinationPath; public bool AutoLink; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabInstantiate { public string AssetId; public string Path; public string ParentId; public string Name; public McpVector3 Position; public McpVector3 Scale; public McpVector3 EulerAngles; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabGetInstances { public string AssetId; public string Path; public string SceneId; public int Limit = 50; public string Cursor; }
    public class McpPrefabActorRequest { public string ActorId; public bool DryRun = true; public bool Confirm; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabCreateResult { public bool DryRun; public bool Created; public string PrefabPath; public string ActorId; public bool AutoLinked; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpPrefabInstantiateResult { public bool DryRun; public McpAssetMetadata Prefab; public McpActorDto Actor; public bool VerifiedLink; public long ProjectRevision; public string SceneId; public long SceneRevision; }
    public class McpPrefabInstanceDto { public string ActorId; public string SceneId; public string ParentId; public string Name; public string PrefabId; public string PrefabObjectId; public bool IsPrefabRoot; }
    public class McpPrefabInstancesResult { public McpAssetMetadata Prefab; public McpPrefabInstanceDto[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    // Bridge v30 prefab override workflows. The diff is synthesized by the
    // bridge (live subtree vs Prefab.GetDefaultInstance defaults), not the
    // engine diff window: there is no public engine diff enumerator.
    public class McpPrefabRevertRequest { public string[] ActorIds; public bool DryRun = true; public bool Confirm; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpPrefabOverrideEntry { public string ActorId; public string Path; public string Property; public McpMaterialTypedValue InstanceValue; public McpMaterialTypedValue PrefabValue; public string NestedPrefabId; public string NestedObjectId; }
    public class McpPrefabOverridesResult { public bool DryRun; public string ActorId; public bool HasPrefabLink; public bool IsPrefabRoot; public string PrefabId; public string PrefabObjectId; public McpPrefabOverrideEntry[] Entries; public bool Truncated; public int ActorCount; public long ProjectRevision; public string SceneId; public long SceneRevision; public string[] Warnings; }
    public class McpPrefabRevertResult { public bool DryRun; public string[] ActorIds; public int RevertedActors; public int RevertedEntries; public bool Verified; public McpPrefabOverrideEntry[] Entries; public bool Truncated; public long ProjectRevision; public string SceneId; public long SceneRevision; public string[] Warnings; }
    public class McpPrefabApplyResult { public bool DryRun; public string ActorId; public bool HasPrefabLink; public bool IsPrefabRoot; public string PrefabId; public McpPrefabOverrideEntry[] BeforeSnapshot; public bool SnapshotTruncated; public int AppliedCount; public long ProjectRevision; public string SceneId; public long SceneRevision; public string[] Warnings; }
    public class McpPrefabBreakResult { public bool DryRun; public string ActorId; public bool HadLink; public string PrefabId; public bool UndoRegistered; public long ProjectRevision; public string SceneId; public long SceneRevision; public string[] Warnings; }
    public class McpMaterialAssetRequest { public string AssetId; public string Path; public bool IncludeNonPublic; }
    public class McpMaterialParameterSet { public string Name; public bool? Bool; public double? Number; public string Text; }
    // Bridge v29 bounded material writes. Values use the same exactly-one-of
    // Bool/Number/Text shape as the v28 script-field/component writes: Node
    // splits its bool|number|string union and the bridge coerces strictly to
    // the target MaterialParameterType (vectors/colors/textures arrive as
    // strict Text and are parsed, never blended).
    public class McpMaterialSetParametersRequest { public string AssetId; public string Path; public McpMaterialParameterSet[] Parameters; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; }
    public class McpMaterialSetParametersResult { public McpAssetMetadata Material; public bool IsInstance; public bool DryRun; public bool Saved; public bool Verified; public McpMaterialParameterDto[] Parameters; public long ProjectRevision; public string[] Warnings; }
    public class McpMaterialCreateInstanceRequest { public string AssetId; public string Path; public string DestinationPath; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; }
    public class McpMaterialCreateInstanceResult { public bool DryRun; public bool Created; public McpAssetMetadata Material; public McpAssetMetadata BaseMaterial; public string DestinationPath; public long ProjectRevision; public string[] Warnings; }
    public class McpMaterialAssignRequest { public string AssetId; public string Path; public string ActorId; public int Slot; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public long? ExpectedSceneRevision; public string LeaseId; }
    public class McpMaterialAssignResult { public bool DryRun; public string ActorId; public string ActorType; public int Slot; public int SlotCount; public McpAssetMetadata Material; public McpAssetMetadata Before; public McpAssetMetadata After; public bool SceneEdited; public long ProjectRevision; public long SceneRevision; public string[] Warnings; }
    public class McpMaterialTypedValue { public string Kind; public bool? Boolean; public long? Integer; public double? Number; public string Text; public McpVector2 Vector2; public McpVector3 Vector3; public McpVector4 Vector4; public string AssetId; public string TypeName; }
    public class McpVector2 { public float X; public float Y; }
    public class McpVector4 { public float X; public float Y; public float Z; public float W; }
    public class McpMaterialParameterDto { public string Id; public string Name; public string Type; public bool IsPublic; public bool IsOverride; public McpMaterialTypedValue Value; }
    public class McpMaterialParametersResult { public McpAssetMetadata Material; public bool IsInstance; public McpAssetMetadata BaseMaterial; public McpMaterialParameterDto[] Parameters; public bool NonPublicIncluded; public string[] Warnings; }
    public class McpAnimationListClips { public int Limit = 50; public string Cursor; public string Folder; }
    public class McpAnimationClipDto { public McpAssetMetadata Asset; public float Length; public float Duration; public float FramesPerSecond; public int FramesCount; public int ChannelsCount; public int KeyframesCount; public long MemoryUsage; }
    public class McpAnimationClipsResult { public McpAnimationClipDto[] Entries; public string NextCursor; public bool HasMore; public string IndexRevision; public string[] Warnings; }
    public class McpAnimationActorRequest { public string ActorId; }
    public class McpAnimationGraphParameterDto { public string Id; public string Name; public string Type; public string TypeName; public bool IsPublic; public McpMaterialTypedValue Value; }
    public class McpAnimationGraphParametersResult { public string ActorId; public McpAssetMetadata AnimationGraph; public McpAnimationGraphParameterDto[] Parameters; public string[] Warnings; }
    public class McpAnimationGraphMutationRequest { public string ActorId; public string ParameterId; public string ParameterName; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; }
    public class McpAnimationBindingValidationResult { public string ActorId; public McpAssetMetadata SkinnedModel; public McpAssetMetadata AnimationGraph; public McpAssetMetadata GraphBaseModel; public bool HasSkinnedModel; public bool HasAnimationGraph; public bool HasGraphBaseModel; public bool BaseModelMatchesActor; public bool Valid; public string[] Warnings; }
    // Bridge v16 Visject node-graph surface (see docs/VISJECT_GRAPH_EDIT_PLAN.md).
    // Scope is window-backed only: AnimationGraph / Material / ParticleEmitter.
    // VisualScript / BehaviorTree / Function assets are rejected here even
    // though they share IVisjectSurfaceWindow, because their windows do not
    // inherit VisjectSurfaceWindow`3 (verified by Cecil). All writes go via
    // Window.Surface + AssetEditorWindow.Save(); headless SaveSurface(byte[])
    // is never the write path and direct .flax byte edits are forbidden.
    public class McpGraphInspectRequest { public string AssetId; public string Path; public bool IncludeValues; public bool IncludeBoxes = true; public int Limit = 200; public bool IncludeSubcontexts; public int MaxDepth = 3; }
    public class McpGraphNodeDto { public uint Id; public ushort GroupID; public ushort TypeID; public string Title; public float X; public float Y; public int ValuesCount; public McpMaterialTypedValue[] Values; }
    public class McpGraphBoxDto { public uint NodeID; public int BoxID; public bool IsOutput; public string[] Connections; }
    public class McpGraphParameterDto { public string Id; public string Name; public string Type; public bool IsPublic; public McpMaterialTypedValue Value; }
    public class McpGraphInspectResult { public McpAssetMetadata Asset; public bool OpenedByBridge; public McpGraphNodeDto[] Nodes; public McpGraphBoxDto[] Boxes; public McpGraphParameterDto[] Parameters; public bool HasMore; public bool BoxesIncluded; public bool ValuesIncluded; public McpGraphContextDto[] Contexts; public bool SubcontextsIncluded; public string[] Warnings; }
    public class McpGraphContextDto { public uint OwnerNodeID; public uint[] Path; public int Depth; public McpGraphNodeDto[] Nodes; public McpGraphBoxDto[] Boxes; public McpGraphParameterDto[] Parameters; }
    public class McpGraphSetDefaultParameterRequest { public string AssetId; public string Path; public string ParameterId; public string ParameterName; public McpMaterialTypedValue Value; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
    public class McpGraphSetDefaultParameterResult { public McpAssetMetadata Asset; public McpGraphParameterDto Parameter; public McpMaterialTypedValue PreviousValue; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }
    public class McpGraphUndoRequest { public string AssetId; public string Path; }
    public class McpGraphUndoResult { public McpAssetMetadata Asset; public bool Undone; public bool CanUndo; public string FirstUndoName; public long ProjectRevision; public string[] Warnings; }
    // Bridge v16 Phase 3: bounded macro to append one surface parameter.
    // Topology node/wire edits stay forbidden; this is the only additive
    // mutation besides default-value writes.
    public class McpGraphAddParameterRequest { public string AssetId; public string Path; public string Name; public string Type; public McpMaterialTypedValue Value; public bool IsPublic = true; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
    // Not-ready/load-failed details MUST be a named field-based DTO:
    // FlaxEngine.Json serializes public fields (like McpResponse) but drops
    // anonymous-type properties to "{}". Node clients gate auto-retry on
    // details.NotReady, so an empty object would silently disable retries.
    public class McpGraphReadinessDetails { public bool NotReady; public int RetryAfterMs; public string AssetId; public string Path; }
    // Bridge v33 generic editor-visible member surface. A member is listed
    // only when the Editor property grid would show it (same selection rule
    // as FlaxEditor.CustomEditors.Editors.GenericEditor.GetItemsForType).
    // Results are named field DTOs: FlaxEngine.Json drops anonymous-type
    // properties to "{}".
    public class McpMemberListRequest { public string ActorId; public string Filter; public bool IncludeUnsupported; public int Limit = 128; }
    public class McpMemberDto { public string Name; public string DeclaringType; public string Type; public string Kind; public string Group; public bool Writable; public McpMaterialTypedValue Value; public string[] EnumValues; public double? Min; public double? Max; public string Reason; public string Tooltip; }
    public class McpMemberListResult { public string ActorId; public string Target; public string TypeName; public McpMemberDto[] Members; public int TotalCount; public int UnsupportedSkipped; public bool Truncated; public long ProjectRevision; public long SceneRevision; public string[] Warnings; }
    public class McpUiControlCreate { public string ParentId; public string ControlType = "FlaxEngine.GUI.Button"; public string Name; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpUiControlCreateResult { public bool DryRun; public string ControlType; public string ParentId; public McpActorDto Actor; public long ProjectRevision; public long SceneRevision; public string[] Warnings; }
    // Bridge v33 play-mode script drive. Writes and invocations target game
    // script members only (never engine-declared members) and never touch
    // the editor undo stack or the scene edited flag.
    public class McpRuntimeScriptValueSet { public string ScriptId; public string Member; public string[] Path; public bool? Bool; public double? Number; public string Text; }
    public class McpRuntimeScriptValueResult { public string ScriptId; public string Member; public string Type; public McpMaterialTypedValue Before; public McpMaterialTypedValue After; public string PlaySessionId; public string[] Warnings; public string[] Path; }
    // Bridge v34 nested member path refusal: which Path segment failed.
    public class McpMemberPathErrorDetails { public string[] Path; public int SegmentIndex; public string Segment; }
    public class McpRuntimeArgument { public bool? Bool; public double? Number; public string Text; }
    public class McpRuntimeScriptInvoke { public string ScriptId; public string Method; public McpRuntimeArgument[] Args; }
    public class McpRuntimeScriptInvokeResult { public string ScriptId; public string Method; public string DeclaringType; public string ReturnType; public bool Invoked; public bool Threw; public string ExceptionType; public string ExceptionMessage; public McpMaterialTypedValue Result; public string PlaySessionId; public string[] Warnings; }
    // Bridge v33 project-settings writes through GameSettings.Load/Save/Apply.
    // DryRun defaults to true and a real write needs Confirm: settings saves
    // persist to disk immediately and have no Editor undo record.
    public class McpInputActionSet { public string Name; public string Mode; public string Key; public string MouseButton; public string GamepadButton; public string Gamepad; public bool Replace; public bool DryRun = true; public bool Confirm; }
    public class McpInputAxisSet { public string Name; public string Axis; public string PositiveButton; public string NegativeButton; public string GamepadPositiveButton; public string GamepadNegativeButton; public string Gamepad; public double? DeadZone; public double? Sensitivity; public double? Gravity; public double? Scale; public bool? Snap; public bool Replace; public bool DryRun = true; public bool Confirm; }
    public class McpInputMappingRemove { public string Kind; public string Name; public bool DryRun = true; public bool Confirm; }
    public class McpInputMappingDto { public string Kind; public string Name; public string Mode; public string Key; public string MouseButton; public string GamepadButton; public string Gamepad; public string Axis; public string PositiveButton; public string NegativeButton; public string GamepadPositiveButton; public string GamepadNegativeButton; public float DeadZone; public float Sensitivity; public float Gravity; public float Scale; public bool Snap; }
    public class McpInputSettingsResult { public string Operation; public string Kind; public string Name; public bool DryRun; public bool Saved; public bool WouldChange; public int RemovedCount; public int ActionCount; public int AxisCount; public McpInputMappingDto[] Before; public McpInputMappingDto[] After; public long ProjectRevision; public string[] Warnings; }
    public class McpLayerNameSet { public int Index = -1; public string Name; public bool DryRun = true; public bool Confirm; }
    public class McpTagAdd { public string Tag; public bool DryRun = true; public bool Confirm; }
    public class McpLayersTagsResult { public string Operation; public bool DryRun; public bool Saved; public bool WouldChange; public int Index; public string Before; public string After; public string[] Layers; public string[] Tags; public long ProjectRevision; public string[] Warnings; }
    public class McpFirstSceneSet { public string AssetId; public string Path; public bool DryRun = true; public bool Confirm; }
    public class McpFirstSceneResult { public bool DryRun; public bool Saved; public bool WouldChange; public string BeforeSceneId; public McpAssetMetadata Scene; public long ProjectRevision; public string[] Warnings; }
    // Bridge v33 scene/content lifecycle. Creation never overwrites and has
    // no Editor undo record (like v10 asset organization); scene.close
    // mirrors SceneModule.CloseScene without its modal save dialog.
    public class McpSceneCreate { public string Path; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; }
    public class McpSceneCreateResult { public bool DryRun; public bool Created; public string Path; public string SceneId; public long ProjectRevision; public string[] Warnings; }
    public class McpSceneClose { public string SceneId; public bool AllowDirty; }
    public class McpSceneCloseResult { public string SceneId; public string Name; public string Phase; public bool WasEdited; public int LoadedScenesBefore; }
    public class McpContentFolderCreate { public string Path; public bool DryRun; }
    public class McpContentFolderResult { public bool DryRun; public bool Created; public bool AlreadyExists; public string Path; public long ProjectRevision; public string[] Warnings; }
    public class McpAssetCreate { public string Kind; public string Path; public string TypeName; public McpGlobalsVariable[] Variables; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; }
    public class McpGlobalsVariable { public string Name; public string Type; public string Value; }
    public class McpAssetCreateResult { public bool DryRun; public bool Created; public string Kind; public string TypeName; public string Path; public McpAssetMetadata Asset; public long ProjectRevision; public string[] Warnings; }
    // Bridge v33 ParticleEffect parameter overrides (ParticleEffect.Parameters
    // / SetParameterValue). Track is the emitter track name.
    public class McpParticleParametersRequest { public string ActorId; }
    public class McpParticleParameterDto { public string Track; public string Name; public string Type; public bool IsPublic; public bool Writable; public McpMaterialTypedValue Value; public McpMaterialTypedValue DefaultValue; }
    public class McpParticleParametersResult { public string ActorId; public McpAssetMetadata ParticleSystem; public McpParticleParameterDto[] Parameters; public bool Truncated; public string[] Warnings; }
    public class McpParticleParameterSet { public string ActorId; public string Track; public string Name; public bool? Bool; public double? Number; public string Text; public bool DryRun; public long? ExpectedSceneRevision; public string LeaseId; public string IdempotencyKey; }
    public class McpParticleParameterSetResult { public string ActorId; public string Track; public string Name; public string Type; public bool DryRun; public bool WouldChange; public McpMaterialTypedValue Before; public McpMaterialTypedValue After; public long ProjectRevision; public long SceneRevision; public string[] Warnings; }
    // Bridge v34 editor lifecycle and options. Declared by the v34 skeleton;
    // behaviour is filled in by the owning work package.
    public class McpEditorQuit { public string Unsaved = "refuse"; public bool StopPlay; }
    public class McpEditorQuitResult { public bool Accepted; public string Phase; public string[] SavedSceneIds; public string[] DiscardedSceneIds; public string[] DiscardedAssetWindows; public int Pid; }
    public class McpEditorOptions { public bool AutoReloadScriptsOnMainWindowFocus; public bool ForceScriptCompilationOnStartup; public string Scope = "user-global"; }
    public class McpEditorSetOption { public string Name; public bool Value; public bool DryRun = true; public bool Confirm; }
    public class McpEditorSetOptionResult { public string Name; public bool Previous; public bool Value; public bool Changed; public bool DryRun; public string Scope = "user-global"; }
    // Bridge v34 graph archetype listing, batched graph edits and AnimGraph
    // transition settings.
    public class McpGraphListArchetypes { public string AssetId; public string Path; public string[] ContextPath; }
    public class McpGraphArchetypeBox { public int Id; public string Name; public string Type; }
    public class McpGraphArchetype { public int GroupId; public int TypeId; public string Title; public string Description; public McpGraphArchetypeBox[] Inputs; public McpGraphArchetypeBox[] Outputs; public string[] DefaultValueKinds; }
    public class McpGraphArchetypeList { public string AssetId; public string ContextKind; public McpGraphArchetype[] Archetypes; public McpGraphNodeDto[] ExistingNodes; public string[] Warnings; }
    public class McpGraphEditOp { public string Op; public string[] ContextPath; public string Ref; public int GroupId; public int TypeId; public float X; public float Y; public FlaxMcpBridgePlugin.McpGraphNodeValueEntry[] Values; public string NodeId; public string FromNodeId; public int FromBoxId; public string ToNodeId; public int ToBoxId; }
    public class McpGraphEdit { public string AssetId; public string Path; public McpGraphEditOp[] Ops; public bool DryRun = true; public bool Confirm; public string LeaseId; public string IdempotencyKey; }
    public class McpGraphRefBinding { public string Ref; public string NodeId; }
    public class McpGraphEditOpResult { public int Index; public string Op; public string Ref; public string NodeId; public bool Applied; public string[] Warnings; }
    public class McpGraphEditResult { public string AssetId; public bool DryRun; public bool Saved; public McpGraphEditOpResult[] Ops; public McpGraphRefBinding[] Refs; public long ProjectRevision; public string[] Warnings; }
    public class McpAnimgraphSetTransition { public string AssetId; public string Path; public string StateMachineNodeId; public string FromStateNodeId; public string ToStateNodeId; public float? BlendDuration; public string BlendMode; public bool? Enabled; public bool? Solo; public bool? UseDefaultRule; public string[] Interruption; public int? Order; public bool DryRun = true; public bool Confirm; public string LeaseId; public string IdempotencyKey; }
    public class McpAnimgraphTransitionSettings { public float BlendDuration; public string BlendMode; public bool Enabled; public bool Solo; public bool UseDefaultRule; public string[] Interruption; public int Order; }
    public class McpAnimgraphSetTransitionResult { public string AssetId; public string StateMachineNodeId; public string FromStateNodeId; public string ToStateNodeId; public McpAnimgraphTransitionSettings Before; public McpAnimgraphTransitionSettings After; public bool DryRun; public bool WouldChange; public bool Saved; public long ProjectRevision; public string[] Warnings; }
    internal sealed class McpMemberSlot { public ScriptMemberInfo Info; public Type ValueType; public Type DeclaringType; public bool ReadOnly; public bool NoSerialize; public bool HasLimit; public float Min; public float Max; public string Group; public string Tooltip; }
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
        private const int BridgeVersion = 36;
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
        // P7 read surface: bounded script value projection. Field values reuse
        // the v13 McpMaterialTypedValue shapes plus an "enum" kind; asset
        // references are reported as null with a reason so the whitelist stays
        // bool/int/float/string/enum/Guid/Vector2-4/Color (+null). The global
        // MaxResultBytes cap still bounds the total response.
        private const int MaxScriptValueFields = 64;
        private const int MaxScriptValueStringChars = 512;
        private const int MaxScriptValueWriteChars = 4096;
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
        // Bridge directory ownership (several Editors may open one project). Only the owner
        // writes the token/heartbeat, polls requests/ and persists state; the others stand by.
        private bool _bridgeActive;
        private bool _bridgeStandby;
        private long _lastOwnerCheck;
        private long _ownerMissingSinceTicks;
        private const long BridgeOwnerStaleMs = 30000;
        private const long BridgeOwnerCheckMs = 2000;
        // The owner deletes bridge.json on a script reload; a standby Editor waits this long before treating a missing file as a released bridge.
        private const long BridgeOwnerMissingGraceMs = 15000;
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
        // Bridge v31 lightmap bake lifecycle. Editor.BakeLightmapsOrCancel is
        // a toggle (start when idle, cancel when running), so the bridge
        // tracks IsBaking through the LightmapsBakeStart/Progress/End events
        // and never toggles blindly: start while baking is a no-op report,
        // cancel while idle never starts a bake.
        private bool _lightBakeActive;
        private string _lightBakeStep;
        private float _lightBakeStepProgress;
        private float _lightBakeTotalProgress;
        private bool _lightBakeHasLastResult;
        private bool _lightBakeLastFailed;
        private string _playState = "stopped";
        private string _playSessionId;
        private string _playMode;
        private long _playStartedUnixMs;
        private long _playEndedUnixMs;
        // editor.quit: armed by the request, completed from OnUpdate on a later frame.
        private volatile PendingQuit _pendingQuit;
        // Revision counters are scoped to this bridge Editor session. They advance
        // only for mutations executed through this bridge; no verified Flax 1.12
        // editor event exists here for unsaved manual edits made outside the bridge.
        private long _projectRevision;
        private readonly Dictionary<string, long> _sceneRevisions = new Dictionary<string, long>();
        private readonly Dictionary<string, McpLeaseState> _sceneLeases = new Dictionary<string, McpLeaseState>();
        private readonly Dictionary<string, McpIdempotencyEntry> _idempotency = new Dictionary<string, McpIdempotencyEntry>();
        private readonly Dictionary<string, McpAssetCursor> _assetCursors = new Dictionary<string, McpAssetCursor>();
        // Operation IDs and output paths compare case-insensitively: Windows paths differ only by case for the same file, and a client may upper-case a GUID.
        private readonly Dictionary<string, McpAssetOperation> _assetImportOperations = new Dictionary<string, McpAssetOperation>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> _assetImportOperationFingerprints = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // Internal result-path to operation mapping for ContentImporting's worker
        // completion event. Full paths never leave the bridge response DTO.
        private readonly Dictionary<string, string> _pendingReimportsByOutputPath = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // The preview (WouldChange/Before/After) each asset.set_import_settings
        // operation returned, so a retry that adopts the OperationId replays
        // the real result. Entries live exactly as long as the operation record.
        private readonly Dictionary<string, McpAssetImportSettingsSetResult> _assetImportSettingsResults = new Dictionary<string, McpAssetImportSettingsSetResult>(StringComparer.OrdinalIgnoreCase);
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
        private static string AssetOperations { get { return Path.Combine(Root, "asset-operations"); } }
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
                Directory.CreateDirectory(AssetOperations);
                int ownerPid;
                if (TryGetLiveForeignOwner(out ownerPid))
                    EnterStandby(ownerPid);
                else
                {
                    ActivateBridge();
                    Debug.Log("[Flax MCP] Bridge v36 listening at " + Root);
                }
                _running = true;
                Scripting.Update += OnUpdate;
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
            try { RestoreGpuProfiler(); } catch { }
            if (_bridgeActive)
            {
                UnsubscribeEvents();
                PersistCompileState();
                PersistGenerateState();
                PersistOperations();
                PersistAssetImportOperations();
                // Only the owner removes the shared token/heartbeat; a standby or demoted Editor must leave the owner's files alone.
                if (BridgeFilesOwnedByThisEditor())
                {
                    TryDelete(BridgePath);
                    TryDelete(TokenPath);
                }
                _bridgeActive = false;
            }
            _bridgeStandby = false;
            base.DeinitializeEditor();
        }

        // Takes the bridge directory: restores persisted state, writes a NEW session token and the heartbeat.
        private void ActivateBridge()
        {
            try
            {
                CleanupOldProcessing();
                CleanupCaptures();
                RestorePersistentState();
                _token = CreateSessionToken();
                _logSessionId = Guid.NewGuid().ToString("N");
                SubscribeEvents();
                WriteToken(_token);
                WriteHeartbeat();
            }
            catch
            {
                try { UnsubscribeEvents(); } catch { }
                throw;
            }
            _bridgeActive = true;
            _bridgeStandby = false;
            _ownerMissingSinceTicks = 0;
            _lastHeartbeat = Environment.TickCount64;
        }

        private void EnterStandby(int ownerPid)
        {
            _bridgeStandby = true;
            _bridgeActive = false;
            _ownerMissingSinceTicks = 0;
            _lastOwnerCheck = Environment.TickCount64;
            Debug.LogWarning("[Flax MCP] another Flax Editor (pid " + ownerPid + ") owns Cache/MCP; this Editor's MCP bridge is on standby");
        }

        // The owner lost the directory (it was stalled past the heartbeat timeout and another Editor took over): stop touching shared files.
        private void DemoteToStandby(int ownerPid)
        {
            try { UnsubscribeEvents(); } catch { }
            EnterStandby(ownerPid);
        }

        private void TickStandby(long now)
        {
            if (now - _lastOwnerCheck < BridgeOwnerCheckMs) return;
            _lastOwnerCheck = now;
            int ownerPid;
            if (TryGetLiveForeignOwner(out ownerPid))
            {
                _ownerMissingSinceTicks = 0;
                return;
            }
            // bridge.json removed (clean exit or the owner's script reload): wait a grace period so a reloading owner can re-initialise first.
            if (!File.Exists(BridgePath))
            {
                if (_ownerMissingSinceTicks == 0) _ownerMissingSinceTicks = now == 0 ? 1 : now;
                if (now - _ownerMissingSinceTicks < BridgeOwnerMissingGraceMs) return;
            }
            try
            {
                ActivateBridge();
                Debug.Log("[Flax MCP] Previous bridge owner is gone; this Editor now owns Cache/MCP. Bridge v36 listening at " + Root);
            }
            catch (Exception ex)
            {
                Debug.LogError("[Flax MCP] Failed to take over the bridge directory: " + ex.Message);
            }
        }

        // The owner is a different live Editor whose heartbeat is fresh. Missing/unreadable bridge.json, our own PID, a dead PID or a stale heartbeat mean the directory is free.
        private static bool TryGetLiveForeignOwner(out int pid)
        {
            pid = 0;
            var info = ReadPersistent<McpBridgeInfo>(BridgePath);
            if (info == null || info.Pid <= 0 || info.Pid == Environment.ProcessId) return false;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - info.Timestamp >= BridgeOwnerStaleMs) return false;
            if (!IsProcessAlive(info.Pid)) return false;
            pid = info.Pid;
            return true;
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

        private static bool BridgeFilesOwnedByThisEditor()
        {
            var info = ReadPersistent<McpBridgeInfo>(BridgePath);
            return info != null && info.Pid == Environment.ProcessId;
        }

        // Owner heartbeat tick: yield if another live Editor took over, otherwise refresh the heartbeat and restore our token if a racing Editor overwrote it.
        private void TickOwnerHeartbeat()
        {
            int ownerPid;
            if (TryGetLiveForeignOwner(out ownerPid))
            {
                DemoteToStandby(ownerPid);
                return;
            }
            WriteHeartbeat();
            string current = null;
            try { current = File.ReadAllText(TokenPath); } catch { }
            if (!string.Equals(current, _token, StringComparison.Ordinal)) WriteToken(_token);
        }

        private void OnUpdate()
        {
            if (!_running)
                return;
            var now = Environment.TickCount64;
            if (_bridgeStandby)
            {
                TickStandby(now);
                return;
            }
            TickPendingQuit(now);
            TickGpuProfiler(now);
            if (now - _lastHeartbeat >= 2000)
            {
                _lastHeartbeat = now;
                try { TickOwnerHeartbeat(); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Heartbeat failed: " + ex.Message); }
                if (_bridgeStandby) return;
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
                // editor.quit exits only after its response is on disk.
                if (request != null && string.Equals(request.method, "editor.quit", StringComparison.Ordinal))
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
            "scene.list_loaded",
            "scene.get_tree",
            "scene.save",
            "scene.open",
            "project.save_all",
            "actor.get",
            "actor.find",
            "actor.validate_create",
            "actor.create",
            "actor.update",
            "actor.delete",
            "actor.duplicate",
            "actor.reparent",
            "script.attach",
            "script.detach",
            "script.instance_get",
            "script.instance_update",
            "script.instance_set_value",
            "actor.set_property",
            "edit.undo",
            "edit.redo",
            "edit.lease_begin",
            "edit.lease_get",
            "edit.lease_commit",
            "edit.lease_release",
            "editor.get_selection",
            "editor.set_selection",
            "code.status",
            "code.compile_start",
            "code.diagnostics",
            "code.generate_project_start",
            "code.generate_project_status",
            "operation.status",
            "operation.cancel",
            "build.list_targets",
            "build.validate",
            "build.cook",
            "build.status",
            "build.result",
            "build.cancel",
            "physics.validate_colliders",
            "physics.raycast",
            "physics.get_layer_matrix",
            "physics.find_overlaps",
            "navigation.build",
            "navigation.get_status",
            "navigation.validate_agents",
            "navigation.query_path",
            "lighting.bake",
            "lighting.get_status",
            "lighting.validate",
            "environment_probe.bake",
            "terrain.get_summary",
            "foliage.get_summary",
            "terrain.paint",
            "foliage.add_instances",
            "foliage.remove_instances",
            "play.status",
            "play.start_scenes",
            "play.start_game",
            "play.stop",
            "play.pause",
            "play.resume",
            "play.step",
            "play.set_time_scale",
            "perf.snapshot",
            "perf.gpu_events",
            "input.key_press",
            "input.mouse_click",
            "log.query",
            "capture.start",
            "capture.status",
            "runtime.inspect_actor",
            "asset.search",
            "asset.get",
            "asset.get_model_stats",
            "asset.dependencies",
            "asset.find_references",
            "asset.import_start",
            "asset.import_status",
            "asset.reimport_start",
            "asset.reimport_status",
            "asset.get_import_settings",
            "asset.set_import_settings",
            "asset.move",
            "asset.rename",
            "asset.duplicate",
            "asset.delete",
            "prefab.create_from_actor",
            "prefab.instantiate",
            "prefab.get_instances",
            "prefab.get_overrides",
            "prefab.revert_overrides",
            "prefab.apply_overrides",
            "prefab.break_link",
            "material.get_parameters",
            "material.set_parameters",
            "material.create_instance",
            "material.assign_to_actor",
            "animation.list_clips",
            "animation.get_graph_parameters",
            "animation.set_graph_parameter",
            "animation.validate_bindings",
            "graph.inspect",
            "graph.set_default_parameter",
            "graph.undo",
            "graph.add_parameter",
            "animgraph.add_state",
            "animgraph.add_transition",
            "graph.remove_node",
            "graph.disconnect",
            "graph.set_node_values",
            "graph.move_node",
            "graph.set_model",
            "animgraph.set_state_clip",
            "actor.get_properties",
            "ui.create_control",
            "ui.get_control_properties",
            "ui.set_control_property",
            "runtime.set_script_value",
            "runtime.invoke_script_method",
            "settings.set_input_action",
            "settings.set_input_axis",
            "settings.remove_input_mapping",
            "settings.set_layer_name",
            "settings.add_tag",
            "settings.set_first_scene",
            "scene.create",
            "scene.close",
            "content.create_folder",
            "asset.create",
            "particle.get_parameters",
            "particle.set_parameter",
            "editor.quit",
            "editor.get_options",
            "editor.set_option",
            "graph.list_archetypes",
            "graph.edit",
            "animgraph.set_transition",
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
                case "scene.list_loaded": result = OnMain(ListLoadedScenes, request.deadlineUnixMs); break;
                case "scene.get_tree": result = OnMain(() => SceneTree(JsonSerializer.Deserialize<McpSceneSave>(p)), request.deadlineUnixMs); break;
                case "scene.save": result = OnMain(() => SaveScene(JsonSerializer.Deserialize<McpSceneSave>(p)), request.deadlineUnixMs); break;
                case "scene.open": result = OnMain(() => OpenScene(JsonSerializer.Deserialize<McpSceneOpen>(p)), request.deadlineUnixMs); break;
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
                case "script.instance_get": { var q = JsonSerializer.Deserialize<McpScriptId>(p); result = OnMain(() => ScriptInfoWithValues(RequireScript(q == null ? null : q.ScriptId), q != null && q.IncludeValues), request.deadlineUnixMs); break; }
                case "script.instance_update": { var q = JsonSerializer.Deserialize<McpScriptUpdate>(p); result = OnMain(() => ExecuteIdempotent("script.instance_update", q == null ? null : q.IdempotencyKey, q, () => UpdateScript(q)), request.deadlineUnixMs); break; }
                case "script.instance_set_value": { var q = JsonSerializer.Deserialize<McpScriptFieldSet>(p); result = OnMain(() => ExecuteSetScriptField(q), request.deadlineUnixMs); break; }
                case "actor.set_property": { var q = JsonSerializer.Deserialize<McpActorPropertySet>(p); result = OnMain(() => ExecuteSetActorProperty(q), request.deadlineUnixMs); break; }
                case "edit.undo": result = OnMain(Undo, request.deadlineUnixMs); break;
                case "edit.redo": result = OnMain(Redo, request.deadlineUnixMs); break;
                case "edit.lease_begin": result = OnMain(() => BeginLease(JsonSerializer.Deserialize<McpLeaseBegin>(p)), request.deadlineUnixMs); break;
                case "edit.lease_get": result = OnMain(() => GetLease(JsonSerializer.Deserialize<McpLeaseGet>(p)), request.deadlineUnixMs); break;
                case "edit.lease_commit": result = OnMain(() => CommitLease(JsonSerializer.Deserialize<McpLeaseRelease>(p)), request.deadlineUnixMs); break;
                case "edit.lease_release": result = OnMain(() => ReleaseLease(JsonSerializer.Deserialize<McpLeaseRelease>(p)), request.deadlineUnixMs); break;
                case "editor.get_selection": result = OnMain(GetEditorSelection, request.deadlineUnixMs); break;
                case "editor.set_selection": result = OnMain(() => SetEditorSelection(JsonSerializer.Deserialize<McpSelectionRequest>(p)), request.deadlineUnixMs); break;
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
                case "physics.validate_colliders": result = OnMain(ValidateColliders, request.deadlineUnixMs); break;
                case "physics.raycast": result = OnMain(() => PhysicsRaycast(JsonSerializer.Deserialize<McpPhysicsRayRequest>(p)), request.deadlineUnixMs); break;
                case "physics.get_layer_matrix": result = OnMain(PhysicsLayerMatrix, request.deadlineUnixMs); break;
                case "physics.find_overlaps": result = OnMain(() => PhysicsFindOverlaps(JsonSerializer.Deserialize<McpPhysicsOverlapRequest>(p)), request.deadlineUnixMs); break;
                case "navigation.build": result = BuildNavMesh(JsonSerializer.Deserialize<McpNavigationBuildRequest>(p), request.deadlineUnixMs); break;
                case "navigation.get_status": result = OnMain(NavigationStatus, request.deadlineUnixMs); break;
                case "navigation.validate_agents": result = OnMain(ValidateNavigationAgents, request.deadlineUnixMs); break;
                case "navigation.query_path": result = OnMain(() => NavigationQueryPath(JsonSerializer.Deserialize<McpNavigationPathRequest>(p)), request.deadlineUnixMs); break;
                case "lighting.bake": result = BakeLightmaps(JsonSerializer.Deserialize<McpLightingBakeRequest>(p), request.deadlineUnixMs); break;
                case "lighting.get_status": result = OnMain(LightingStatus, request.deadlineUnixMs); break;
                case "lighting.validate": result = OnMain(LightingValidate, request.deadlineUnixMs); break;
                case "environment_probe.bake": result = BakeProbe(JsonSerializer.Deserialize<McpProbeBakeRequest>(p), request.deadlineUnixMs); break;
                case "terrain.get_summary": result = OnMain(() => TerrainSummary(JsonSerializer.Deserialize<McpDomainListRequest>(p)), request.deadlineUnixMs); break;
                case "foliage.get_summary": result = OnMain(() => FoliageSummary(JsonSerializer.Deserialize<McpDomainListRequest>(p)), request.deadlineUnixMs); break;
                case "terrain.paint": result = OnMain(() => TerrainPaintBlocked(), request.deadlineUnixMs); break;
                case "foliage.add_instances": result = OnMain(() => AddFoliageInstances(JsonSerializer.Deserialize<McpFoliageAddRequest>(p)), request.deadlineUnixMs); break;
                case "foliage.remove_instances": result = OnMain(() => RemoveFoliageInstances(JsonSerializer.Deserialize<McpFoliageRemoveRequest>(p)), request.deadlineUnixMs); break;
                case "play.status": result = OnMain(PlayStatus, request.deadlineUnixMs); break;
                case "play.start_scenes": result = OnMain(() => StartPlayScenes(JsonSerializer.Deserialize<McpPlayStart>(p)), request.deadlineUnixMs); break;
                case "play.start_game": result = OnMain(() => StartPlayGame(JsonSerializer.Deserialize<McpPlayStart>(p)), request.deadlineUnixMs); break;
                case "play.stop": result = OnMain(StopPlay, request.deadlineUnixMs); break;
                case "play.pause": result = OnMain(PausePlay, request.deadlineUnixMs); break;
                case "play.resume": result = OnMain(ResumePlay, request.deadlineUnixMs); break;
                case "play.step": result = OnMain(StepPlay, request.deadlineUnixMs); break;
                case "play.set_time_scale": result = OnMain(() => SetPlayTimeScale(JsonSerializer.Deserialize<McpTimeScaleRequest>(p)), request.deadlineUnixMs); break;
                case "perf.snapshot": result = OnMain(PerfSnapshot, request.deadlineUnixMs); break;
                case "perf.gpu_events": result = OnMain(() => PerfGpuEvents(JsonSerializer.Deserialize<McpPerfGpuEventsRequest>(p)), request.deadlineUnixMs); break;
                case "input.key_press": result = OnMain(() => SimulateKeyPress(JsonSerializer.Deserialize<McpKeyPress>(p)), request.deadlineUnixMs); break;
                case "input.mouse_click": result = OnMain(() => SimulateMouseClick(JsonSerializer.Deserialize<McpMouseClick>(p)), request.deadlineUnixMs); break;
                case "log.query": result = QueryLogs(JsonSerializer.Deserialize<McpLogQuery>(p)); break;
                case "capture.start": result = OnMain(() => StartCapture(JsonSerializer.Deserialize<McpCaptureStart>(p)), request.deadlineUnixMs); break;
                case "capture.status": result = GetCaptureStatus(JsonSerializer.Deserialize<McpCaptureStatusRequest>(p)); break;
                case "runtime.inspect_actor": result = OnMain(() => InspectRuntimeActor(JsonSerializer.Deserialize<McpRuntimeActorInspect>(p)), request.deadlineUnixMs); break;
                case "asset.search": result = OnMain(() => AssetSearch(JsonSerializer.Deserialize<McpAssetSearch>(p)), request.deadlineUnixMs); break;
                case "asset.get": result = OnMain(() => AssetGet(JsonSerializer.Deserialize<McpAssetGet>(p)), request.deadlineUnixMs); break;
                case "asset.get_model_stats": result = OnMain(() => AssetGetModelStats(JsonSerializer.Deserialize<McpAssetGet>(p)), request.deadlineUnixMs); break;
                case "asset.dependencies": result = OnMain(() => AssetDependencies(JsonSerializer.Deserialize<McpAssetGraphRequest>(p)), request.deadlineUnixMs); break;
                case "asset.find_references": result = OnMain(() => AssetFindReferences(JsonSerializer.Deserialize<McpAssetGraphRequest>(p)), request.deadlineUnixMs); break;
                case "asset.import_start": { var q = JsonSerializer.Deserialize<McpAssetImportStart>(p); result = OnMain(() => ExecuteIdempotent("asset.import_start", q == null ? null : q.IdempotencyKey, AssetImportFingerprintInput(q), () => StartAssetImport(q)), request.deadlineUnixMs); break; }
                case "asset.import_status": result = OnMain(() => GetAssetImportOperation(JsonSerializer.Deserialize<McpAssetOperationStatusRequest>(p), "import"), request.deadlineUnixMs); break;
                case "asset.reimport_start": { var q = JsonSerializer.Deserialize<McpAssetReimportStart>(p); result = OnMain(() => ExecuteIdempotent("asset.reimport_start", q == null ? null : q.IdempotencyKey, AssetReimportFingerprintInput(q), () => StartAssetReimport(q)), request.deadlineUnixMs); break; }
                case "asset.reimport_status": result = OnMain(() => GetAssetImportOperation(JsonSerializer.Deserialize<McpAssetOperationStatusRequest>(p), "reimport"), request.deadlineUnixMs); break;
                case "asset.get_import_settings": result = OnMain(() => GetAssetImportSettings(JsonSerializer.Deserialize<McpAssetImportSettingsGet>(p)), request.deadlineUnixMs); break;
                case "asset.set_import_settings": { var q = JsonSerializer.Deserialize<McpAssetImportSettingsSet>(p); result = OnMain(() => ExecuteIdempotent("asset.set_import_settings", q == null ? null : q.IdempotencyKey, AssetImportSettingsFingerprintInput(q), () => SetAssetImportSettings(q)), request.deadlineUnixMs); break; }
                case "asset.move": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.move", q == null ? null : q.IdempotencyKey, q, () => MoveAsset(q)), request.deadlineUnixMs); break; }
                case "asset.rename": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.rename", q == null ? null : q.IdempotencyKey, q, () => RenameAsset(q)), request.deadlineUnixMs); break; }
                case "asset.duplicate": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.duplicate", q == null ? null : q.IdempotencyKey, q, () => DuplicateAsset(q)), request.deadlineUnixMs); break; }
                case "asset.delete": { var q = JsonSerializer.Deserialize<McpAssetOrganizeRequest>(p); result = OnMain(() => ExecuteIdempotent("asset.delete", q == null ? null : q.IdempotencyKey, q, () => QuarantineDeleteAsset(q)), request.deadlineUnixMs); break; }
                case "prefab.create_from_actor": { var q = JsonSerializer.Deserialize<McpPrefabCreateFromActor>(p); result = OnMain(() => ExecuteIdempotent("prefab.create_from_actor", q == null ? null : q.IdempotencyKey, q, () => CreatePrefabFromActor(q)), request.deadlineUnixMs); break; }
                case "prefab.instantiate": { var q = JsonSerializer.Deserialize<McpPrefabInstantiate>(p); result = OnMain(() => ExecuteIdempotent("prefab.instantiate", q == null ? null : q.IdempotencyKey, q, () => InstantiatePrefab(q)), request.deadlineUnixMs); break; }
                case "prefab.get_instances": result = OnMain(() => GetPrefabInstances(JsonSerializer.Deserialize<McpPrefabGetInstances>(p)), request.deadlineUnixMs); break;
                case "prefab.get_overrides": result = OnMain(() => GetPrefabOverrides(JsonSerializer.Deserialize<McpPrefabActorRequest>(p)), request.deadlineUnixMs); break;
                case "prefab.revert_overrides": { var q = JsonSerializer.Deserialize<McpPrefabRevertRequest>(p); result = OnMain(() => ExecutePrefabRevert(q), request.deadlineUnixMs); break; }
                case "prefab.apply_overrides": { var q = JsonSerializer.Deserialize<McpPrefabActorRequest>(p); result = OnMain(() => ExecutePrefabApply(q), request.deadlineUnixMs); break; }
                case "prefab.break_link": { var q = JsonSerializer.Deserialize<McpPrefabActorRequest>(p); result = OnMain(() => ExecutePrefabBreak(q), request.deadlineUnixMs); break; }
                case "material.get_parameters": result = OnMain(() => GetMaterialParameters(JsonSerializer.Deserialize<McpMaterialAssetRequest>(p)), request.deadlineUnixMs); break;
                case "material.set_parameters": { var q = JsonSerializer.Deserialize<McpMaterialSetParametersRequest>(p); result = OnMain(() => ExecuteMaterialSetParameters(q), request.deadlineUnixMs); break; }
                case "material.create_instance": { var q = JsonSerializer.Deserialize<McpMaterialCreateInstanceRequest>(p); result = OnMain(() => ExecuteMaterialCreateInstance(q), request.deadlineUnixMs); break; }
                case "material.assign_to_actor": { var q = JsonSerializer.Deserialize<McpMaterialAssignRequest>(p); result = OnMain(() => ExecuteMaterialAssign(q), request.deadlineUnixMs); break; }
                case "animation.list_clips": result = OnMain(() => ListAnimationClips(JsonSerializer.Deserialize<McpAnimationListClips>(p)), request.deadlineUnixMs); break;
                case "animation.get_graph_parameters": result = OnMain(() => GetAnimationGraphParameters(JsonSerializer.Deserialize<McpAnimationActorRequest>(p)), request.deadlineUnixMs); break;
                case "animation.set_graph_parameter": result = OnMain(() => UnsupportedAnimationOperation("animation_set_graph_parameter", JsonSerializer.Deserialize<McpAnimationGraphMutationRequest>(p)), request.deadlineUnixMs); break;
                case "animation.validate_bindings": result = OnMain(() => ValidateAnimationBindings(JsonSerializer.Deserialize<McpAnimationActorRequest>(p)), request.deadlineUnixMs); break;
                case "graph.inspect": result = OnMain(() => GraphInspect(JsonSerializer.Deserialize<McpGraphInspectRequest>(p)), request.deadlineUnixMs); break;
                case "graph.set_default_parameter": { var q = JsonSerializer.Deserialize<McpGraphSetDefaultParameterRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.set_default_parameter", q == null ? null : q.IdempotencyKey, q, () => SetGraphDefaultParameter(q)), request.deadlineUnixMs); break; }
                case "graph.undo": result = OnMain(() => GraphUndo(JsonSerializer.Deserialize<McpGraphUndoRequest>(p)), request.deadlineUnixMs); break;
                case "graph.add_parameter": { var q = JsonSerializer.Deserialize<McpGraphAddParameterRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.add_parameter", q == null ? null : q.IdempotencyKey, q, () => AddGraphParameter(q)), request.deadlineUnixMs); break; }
                case "animgraph.add_state": { var q = JsonSerializer.Deserialize<McpGraphAddStateRequest>(p); result = OnMain(() => ExecuteIdempotent("animgraph.add_state", q == null ? null : q.IdempotencyKey, q, () => AddAnimgraphState(q)), request.deadlineUnixMs); break; }
                case "animgraph.add_transition": { var q = JsonSerializer.Deserialize<McpGraphAddTransitionRequest>(p); result = OnMain(() => ExecuteIdempotent("animgraph.add_transition", q == null ? null : q.IdempotencyKey, q, () => AddAnimgraphTransition(q)), request.deadlineUnixMs); break; }
                case "graph.remove_node": { var q = JsonSerializer.Deserialize<McpGraphRemoveNodeRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.remove_node", q == null ? null : q.IdempotencyKey, q, () => RemoveGraphNode(q)), request.deadlineUnixMs); break; }
                case "graph.disconnect": { var q = JsonSerializer.Deserialize<McpGraphDisconnectRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.disconnect", q == null ? null : q.IdempotencyKey, q, () => DisconnectGraphBoxes(q)), request.deadlineUnixMs); break; }
                case "graph.set_node_values": { var q = JsonSerializer.Deserialize<McpGraphSetNodeValuesRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.set_node_values", q == null ? null : q.IdempotencyKey, q, () => SetGraphNodeValues(q)), request.deadlineUnixMs); break; }
                case "graph.move_node": { var q = JsonSerializer.Deserialize<McpGraphMoveNodeRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.move_node", q == null ? null : q.IdempotencyKey, q, () => MoveGraphNode(q)), request.deadlineUnixMs); break; }
                case "graph.set_model": { var q = JsonSerializer.Deserialize<McpGraphSetModelRequest>(p); result = OnMain(() => ExecuteIdempotent("graph.set_model", q == null ? null : q.IdempotencyKey, q, () => SetGraphBaseModel(q)), request.deadlineUnixMs); break; }
                case "animgraph.set_state_clip": { var q = JsonSerializer.Deserialize<McpGraphSetStateClipRequest>(p); result = OnMain(() => ExecuteIdempotent("animgraph.set_state_clip", q == null ? null : q.IdempotencyKey, q, () => SetAnimgraphStateClip(q)), request.deadlineUnixMs); break; }
                // Bridge v33: generic editor-visible members, UI controls,
                // play-mode script drive, settings writes, scene/content
                // lifecycle, and particle parameter overrides.
                case "actor.get_properties": result = OnMain(() => GetActorProperties(JsonSerializer.Deserialize<McpMemberListRequest>(p)), request.deadlineUnixMs); break;
                case "ui.create_control": { var q = JsonSerializer.Deserialize<McpUiControlCreate>(p); result = OnMain(() => ExecuteCreateUiControl(q), request.deadlineUnixMs); break; }
                case "ui.get_control_properties": result = OnMain(() => GetUiControlProperties(JsonSerializer.Deserialize<McpMemberListRequest>(p)), request.deadlineUnixMs); break;
                case "ui.set_control_property": { var q = JsonSerializer.Deserialize<McpActorPropertySet>(p); result = OnMain(() => ExecuteSetUiControlProperty(q), request.deadlineUnixMs); break; }
                case "runtime.set_script_value": result = OnMain(() => SetRuntimeScriptValue(JsonSerializer.Deserialize<McpRuntimeScriptValueSet>(p)), request.deadlineUnixMs); break;
                case "runtime.invoke_script_method": result = OnMain(() => InvokeRuntimeScriptMethod(JsonSerializer.Deserialize<McpRuntimeScriptInvoke>(p)), request.deadlineUnixMs); break;
                case "settings.set_input_action": result = OnMain(() => SetInputAction(JsonSerializer.Deserialize<McpInputActionSet>(p)), request.deadlineUnixMs); break;
                case "settings.set_input_axis": result = OnMain(() => SetInputAxis(JsonSerializer.Deserialize<McpInputAxisSet>(p)), request.deadlineUnixMs); break;
                case "settings.remove_input_mapping": result = OnMain(() => RemoveInputMapping(JsonSerializer.Deserialize<McpInputMappingRemove>(p)), request.deadlineUnixMs); break;
                case "settings.set_layer_name": result = OnMain(() => SetLayerName(JsonSerializer.Deserialize<McpLayerNameSet>(p)), request.deadlineUnixMs); break;
                case "settings.add_tag": result = OnMain(() => AddProjectTag(JsonSerializer.Deserialize<McpTagAdd>(p)), request.deadlineUnixMs); break;
                case "settings.set_first_scene": result = OnMain(() => SetFirstScene(JsonSerializer.Deserialize<McpFirstSceneSet>(p)), request.deadlineUnixMs); break;
                case "scene.create": { var q = JsonSerializer.Deserialize<McpSceneCreate>(p); result = OnMain(() => ExecuteCreateScene(q), request.deadlineUnixMs); break; }
                case "scene.close": result = OnMain(() => CloseScene(JsonSerializer.Deserialize<McpSceneClose>(p)), request.deadlineUnixMs); break;
                case "content.create_folder": result = OnMain(() => CreateContentFolder(JsonSerializer.Deserialize<McpContentFolderCreate>(p)), request.deadlineUnixMs); break;
                case "asset.create": { var q = JsonSerializer.Deserialize<McpAssetCreate>(p); result = OnMain(() => ExecuteCreateAsset(q), request.deadlineUnixMs); break; }
                case "particle.get_parameters": result = OnMain(() => GetParticleParameters(JsonSerializer.Deserialize<McpParticleParametersRequest>(p)), request.deadlineUnixMs); break;
                case "particle.set_parameter": { var q = JsonSerializer.Deserialize<McpParticleParameterSet>(p); result = OnMain(() => ExecuteSetParticleParameter(q), request.deadlineUnixMs); break; }
                // Bridge v34: declared, not implemented yet. Each work package replaces
                // its stub with the real handler.
                case "editor.quit": { var q = JsonSerializer.Deserialize<McpEditorQuit>(p); result = OnMain(() => EditorQuit(q), request.deadlineUnixMs); break; }
                case "editor.get_options": result = OnMain(GetEditorOptions, request.deadlineUnixMs); break;
                case "editor.set_option": { var q = JsonSerializer.Deserialize<McpEditorSetOption>(p); result = OnMain(() => SetEditorOption(q), request.deadlineUnixMs); break; }
                case "graph.list_archetypes": { var q = JsonSerializer.Deserialize<McpGraphListArchetypes>(p); result = OnMain(() => GraphListArchetypes(q), request.deadlineUnixMs); break; }
                case "graph.edit": { var q = JsonSerializer.Deserialize<McpGraphEdit>(p); result = OnMain(() => ExecuteIdempotent("graph.edit", q == null ? null : q.IdempotencyKey, q, () => GraphEdit(q)), request.deadlineUnixMs); break; }
                case "animgraph.set_transition": { var q = JsonSerializer.Deserialize<McpAnimgraphSetTransition>(p); result = OnMain(() => ExecuteIdempotent("animgraph.set_transition", q == null ? null : q.IdempotencyKey, q, () => SetAnimgraphTransition(q)), request.deadlineUnixMs); break; }
                default: throw new McpProtocolException("METHOD_NOT_FOUND", "Method '" + (request == null || request.method == null ? "unknown" : request.method) + "' is not a bridge method.", new { Method = request == null ? null : request.method, Methods = KnownMethods });
            }
            var resultJson = JsonSerializer.Serialize(PlainForJson(result), true);
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
                var status = new McpStatus { Pid = Environment.ProcessId, EditorVersion = Globals.EngineVersion.ToString(), IsPlayMode = FEditor.IsPlayMode, IsHeadless = FEditor.Instance.IsHeadlessMode, LogSessionId = _logSessionId, ProjectRevision = _projectRevision };
                status.Methods = KnownMethods;
                status.MethodDiscoverySupported = true;
                status.AssetImportResultIdSupported = true;
                status.AssetImportReplaceSupported = true;
                status.BridgeOwnershipSupported = true;
                FillEditorReadiness(status);
                status.EditorReadinessSupported = true;
                status.EditorQuitSupported = true;
                status.EditorOptionsSupported = true;
                status.SceneReplaceSupported = true;
                status.SceneReloadSupported = true;
                status.NestedMemberPathSupported = true;
                status.ScriptAssetReferenceWriteSupported = true;
                status.GraphArchetypeListSupported = true;
                status.GraphEditSupported = true;
                status.AnimgraphTransitionSettingsSupported = true;
                status.GameplayGlobalsCreateSupported = true;
                status.MaterialFunctionGraphSupported = true;
                return status;
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
                ImportSettingsAvailable = ImportSettingsKindForType(record.Info.TypeName) != null,
                Warnings = AssetMetadataWarnings(),
            };
        }

        // Bridge v36: per-LOD triangle/vertex/mesh counts of a Model or SkinnedModel.
        //
        // Mirrors the Editor's model asset window (Source/Editor/Windows/Assets/
        // ModelBaseWindow.cs, the per-LOD "Triangles / Vertices" group): the
        // asset is loaded with Content.LoadAsync, then ModelBase.LODsCount,
        // LoadedLODs, MaterialSlotsCount, ModelBase.GetMeshes(out meshes,
        // lodIndex) and MeshBase.TriangleCount/VertexCount are summed per LOD
        // (ModelLODBase.ScreenSize is the LOD switch size). LODs that are not
        // streamed in yet report Loaded = false with null counts, as the
        // window shows "Loading LOD...". asset.get returns registry metadata
        // only, never geometry counts. Loading uses the same bounded
        // WaitForLoaded as the other model loaders here.
        private McpAssetModelStats AssetGetModelStats(McpAssetGet request)
        {
            var record = ResolveAssetRecord(request, BuildAssetRegistry());
            ModelBase model;
            string kind;
            int? boneCount = null;
            if (string.Equals(record.Info.TypeName, "FlaxEngine.Model", StringComparison.Ordinal))
            {
                model = LoadActorModelAsset(request.AssetId, request.Path);
                kind = "Model";
            }
            else if (string.Equals(record.Info.TypeName, "FlaxEngine.SkinnedModel", StringComparison.Ordinal))
            {
                var skinned = LoadSkinnedModelFromRecord(record);
                model = skinned;
                kind = "SkinnedModel";
                try { boneCount = skinned.Bones == null ? (int?)null : skinned.Bones.Length; }
                catch { }
            }
            else
                throw new McpProtocolException("VALIDATION_FAILED", "Model stats are only available for FlaxEngine.Model and FlaxEngine.SkinnedModel assets.", new { TypeName = record.Info.TypeName });
            var result = new McpAssetModelStats { AssetId = record.Id.ToString("N"), Path = record.Path, Kind = kind, BoneCount = boneCount };
            var warnings = new List<string>();
            var lodCount = Math.Max(0, Math.Min(model.LODsCount, 16));
            var loaded = Math.Max(0, Math.Min(model.LoadedLODs, lodCount));
            result.LodCount = lodCount;
            result.LoadedLods = loaded;
            result.MaterialSlotCount = model.MaterialSlotsCount;
            var lods = new McpModelLodStats[lodCount];
            for (var i = 0; i < lodCount; i++)
            {
                var entry = new McpModelLodStats { Lod = i };
                lods[i] = entry;
                // The streamed-in LODs are the last ones, exactly like ModelBaseWindow.
                if (i < lodCount - loaded) continue;
                try
                {
                    MeshBase[] meshes;
                    model.GetMeshes(out meshes, i);
                    long triangles = 0, vertices = 0;
                    if (meshes != null)
                        foreach (var mesh in meshes)
                        {
                            if (mesh == null) continue;
                            triangles += mesh.TriangleCount;
                            vertices += mesh.VertexCount;
                        }
                    entry.Loaded = true;
                    entry.MeshCount = meshes == null ? 0 : meshes.Length;
                    entry.Triangles = triangles;
                    entry.Vertices = vertices;
                    var lod = model.GetLOD(i);
                    if (lod != null) entry.ScreenSize = lod.ScreenSize;
                }
                catch (Exception ex) { warnings.Add("LOD " + i + " could not be read: " + ex.Message); }
            }
            if (loaded < lodCount) warnings.Add((lodCount - loaded) + " LOD(s) are still streaming in; their counts are null.");
            result.Lods = lods;
            result.Warnings = warnings.ToArray();
            return result;
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
                    // Path-spelling trap: Content.RenameAsset resolves both paths through the
                    // engine registry, so a non-engine spelling re-registers the file under a
                    // new asset ID. Pass the engine's own spelling (see EngineAssetPath).
                    if (Content.RenameAsset(EngineAssetPath(source.Path), EngineAssetPathFromAbsolute(output)))
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
            return new { request.SourcePath, request.SourceSizeBytes, request.SourceLastWriteUnixMs, request.DestinationPath, request.CollisionPolicy, request.DryRun, request.AllowedImportRoots, request.MaxSourceBytes, request.ModelImportType };
        }

        private static object AssetReimportFingerprintInput(McpAssetReimportStart request)
        {
            if (request == null) return new { Missing = true };
            return new { request.AssetId, request.Path, request.DryRun, request.AllowedImportRoots, request.MaxSourceBytes, request.ModelImportType };
        }

        private McpAssetOperation StartAssetImport(McpAssetImportStart request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset import parameters are required.");
            if (string.Equals(request.CollisionPolicy, "replace", StringComparison.Ordinal) && !request.DryRun && !request.Confirm)
                throw new McpProtocolException("INVALID_REQUEST", "collisionPolicy 'replace' overwrites an existing asset and requires Confirm:true (or DryRun:true to preview).");
            var fingerprint = Fingerprint(JsonSerializer.Serialize(PlainForJson(AssetImportFingerprintInput(request)), false));
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
                // replace onto an existing file: it must be a registered asset of the type this import would write (REPORT: a cross-type
                // Editor.Import silently writes a sibling "<Name> (N).flax" and still reports success).
                McpAssetRecord replaceTarget = null;
                if (string.Equals(request.CollisionPolicy, "replace", StringComparison.Ordinal) && File.Exists(output))
                {
                    replaceTarget = RequireReplaceableAsset(source, output, request.ModelImportType);
                    operation.ResultPath = replaceTarget.Path;
                }
                if (request.DryRun)
                {
                    if (replaceTarget != null) operation.ResultAssetId = replaceTarget.Id.ToString("N");
                    FinishAssetImportOperation(operation, "dry_run", null, null);
                    return CopyAssetImportOperation(operation);
                }
                // Replace imports into the registered asset's own path in the engine spelling, which is what ContentImporting.Reimport ends up calling.
                var importOutput = replaceTarget == null ? output : EngineAssetPath(replaceTarget.Path);
                var replaceAbsolute = replaceTarget == null ? null : Path.GetFullPath(Path.Combine(Globals.ProjectFolder, replaceTarget.Path));
                var siblingsBefore = replaceTarget == null ? null : ListImportSiblingFiles(replaceAbsolute);
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                // A destination directory may have appeared as a junction while
                // this request was queued. Re-check it immediately before import.
                EnsureAssetImportOutputParent(output);
                // FEditor.Import is synchronous in Flax 1.12 (it returns true on failure), so the result is final when it returns.
                if (!string.IsNullOrWhiteSpace(request.ModelImportType))
                {
                    // Options is a struct: `new` zero-initializes Scale/Rotation and imports a collapsed model. Start from the engine defaults.
                    var options = ModelTool.Options.Default;
                    options.Type = ParseModelImportType(request.ModelImportType);
                    if (FEditor.Import(source, importOutput, options))
                        throw new McpProtocolException("IMPORT_FAILED", "Flax Editor failed to import the allowlisted source.");
                }
                else if (FEditor.Import(source, importOutput))
                    throw new McpProtocolException("IMPORT_FAILED", "Flax Editor failed to import the allowlisted source.");
                if (replaceTarget != null)
                {
                    VerifyAssetReplace(replaceTarget, replaceAbsolute, siblingsBefore);
                    operation.Replaced = true;
                    operation.ResultAssetId = replaceTarget.Id.ToString("N");
                }
                else
                {
                    RefreshContentDatabaseFrom(Path.GetDirectoryName(output));
                    var resultId = ResolveImportedAssetId(output);
                    if (resultId.HasValue) operation.ResultAssetId = resultId.Value.ToString("N");
                    else Debug.LogWarning("[Flax MCP] Import succeeded but the asset ID could not be resolved for " + operation.ResultPath + ".");
                }
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

        // Result ID of a freshly imported asset: the registry under the single safe path spelling (any other spelling makes Flax
        // rewrite the asset with a new ID), else the binary header ID (bytes 28..43). Null only when both fail.
        private static Guid? ResolveImportedAssetId(string absolute)
        {
            try
            {
                AssetInfo info;
                var relative = ProjectContentRelativePath(OnDiskCaseFullPath(absolute));
                if (Content.GetAssetInfo(EngineAssetPath(relative), out info) && info.ID != Guid.Empty) return info.ID;
            }
            catch { }
            try { return ReadPersistedMaterialInstanceId(absolute); }
            catch { return null; }
        }

        // Windows paths ignore case but the Flax registry does not: restore the on-disk casing of every segment under the project folder.
        private static string OnDiskCaseFullPath(string absolute)
        {
            try
            {
                var root = Path.GetFullPath(Globals.ProjectFolder);
                var relative = Path.GetRelativePath(root, Path.GetFullPath(absolute));
                if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative)) return absolute;
                var current = root;
                foreach (var part in relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string actual = null;
                    foreach (var entry in Directory.EnumerateFileSystemEntries(current, part)) { actual = Path.GetFileName(entry); break; }
                    current = Path.Combine(current, actual ?? part);
                }
                return current;
            }
            catch { return absolute; }
        }

        // Type names the importer writes for a source extension (the Editor's ImportFileEntry.FileTypes: textures, models, audio).
        private static string[] ExpectedImportOutputTypes(string sourcePath, string modelImportType)
        {
            var extension = Path.GetExtension(sourcePath) ?? "";
            string outputExtension;
            if (!FEditor.CanImport(extension, out outputExtension))
                throw new McpProtocolException("VALIDATION_FAILED", "Flax reports the source extension is not importable, so the replacement asset type cannot be determined.");
            switch (extension.ToLowerInvariant())
            {
                case ".png": case ".jpg": case ".jpeg": case ".tga": case ".bmp": case ".gif": case ".tif": case ".tiff": case ".dds": case ".hdr": case ".raw": case ".exr":
                    return new[] { "FlaxEngine.Texture" };
                case ".wav": case ".mp3": case ".ogg":
                    return new[] { "FlaxEngine.AudioClip" };
                default:
                    if (string.IsNullOrWhiteSpace(modelImportType)) return new[] { "FlaxEngine.Model" };
                    switch (ParseModelImportType(modelImportType))
                    {
                        case ModelTool.ModelType.SkinnedModel: return new[] { "FlaxEngine.SkinnedModel" };
                        case ModelTool.ModelType.Animation: return new[] { "FlaxEngine.Animation" };
                        case ModelTool.ModelType.Prefab: return new[] { "FlaxEngine.Prefab" };
                        default: return new[] { "FlaxEngine.Model" };
                    }
            }
        }

        private static McpAssetRecord RequireReplaceableAsset(string sourcePath, string output, string modelImportType)
        {
            var relative = ProjectContentRelativePath(output);
            McpAssetRecord target = null;
            foreach (var record in BuildAssetRegistry())
            {
                if (string.Equals(record.Path, relative, StringComparison.OrdinalIgnoreCase)) { target = record; break; }
            }
            if (target == null)
                throw new McpProtocolException("FILE_EXISTS", "A file exists at the requested destination but it is not a registered Content asset; replace only reimports registered assets.");
            var expected = ExpectedImportOutputTypes(sourcePath, modelImportType);
            var existingType = target.Info.TypeName ?? "";
            var matches = false;
            foreach (var type in expected) if (string.Equals(type, existingType, StringComparison.OrdinalIgnoreCase)) matches = true;
            if (!matches)
                throw new McpProtocolException("VALIDATION_FAILED", "The existing asset type " + existingType + " differs from the type this import writes (" + string.Join(", ", expected) + "); replacing across types would create a sibling asset. Pass ModelImportType for models, or import under another name.", new { ExistingType = existingType, ExpectedTypes = expected, Path = target.Path });
            return target;
        }

        // "<stem> (N).flax" files next to the asset: what a cross-type or ID-clash import writes instead of replacing.
        private static HashSet<string> ListImportSiblingFiles(string assetAbsolute)
        {
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var folder = Path.GetDirectoryName(assetAbsolute);
                var stem = Path.GetFileNameWithoutExtension(assetAbsolute);
                if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return result;
                foreach (var file in Directory.GetFiles(folder, "*.flax"))
                {
                    var name = Path.GetFileNameWithoutExtension(file);
                    if (name.Length <= stem.Length + 3 || !name.StartsWith(stem + " (", StringComparison.OrdinalIgnoreCase) || !name.EndsWith(")", StringComparison.Ordinal)) continue;
                    var digits = name.Substring(stem.Length + 2, name.Length - stem.Length - 3);
                    var numeric = digits.Length > 0;
                    foreach (var c in digits) if (c < '0' || c > '9') numeric = false;
                    if (numeric) result.Add(Path.GetFileName(file));
                }
            }
            catch { }
            return result;
        }

        // The Editor.Import(source, existingPath) call must keep the asset ID and must not write a sibling; the Editor cannot tell us either way.
        private static void VerifyAssetReplace(McpAssetRecord target, string absolute, HashSet<string> siblingsBefore)
        {
            var created = new List<string>();
            var folder = Path.GetDirectoryName(ProjectContentRelativePath(absolute)).Replace('\\', '/');
            foreach (var name in ListImportSiblingFiles(absolute)) if (!siblingsBefore.Contains(name)) created.Add(folder + "/" + name);
            if (created.Count > 0)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor wrote a new sibling asset instead of replacing the existing asset; the existing asset was not replaced. Review and remove the sibling in the Content Browser.", new { Path = target.Path, AssetId = target.Id.ToString("N"), CreatedSiblings = created.ToArray() });
            Guid? headerId = null;
            try { headerId = ReadPersistedMaterialInstanceId(absolute); } catch { }
            Guid? registryId = null;
            try
            {
                AssetInfo info;
                if (Content.GetAssetInfo(EngineAssetPath(target.Path), out info)) registryId = info.ID;
            }
            catch { }
            if (!headerId.HasValue && !registryId.HasValue)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The asset ID could not be read back after the replace, so ID preservation was not verified.", new { Path = target.Path, AssetId = target.Id.ToString("N") });
            if ((headerId.HasValue && headerId.Value != target.Id) || (registryId.HasValue && registryId.Value != target.Id))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The asset ID changed during the replace; references to the previous ID are now dangling.", new { Path = target.Path, PreviousAssetId = target.Id.ToString("N"), FileAssetId = headerId.HasValue ? headerId.Value.ToString("N") : null, RegistryAssetId = registryId.HasValue ? registryId.Value.ToString("N") : null });
        }

        private McpAssetOperation StartAssetReimport(McpAssetReimportStart request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset reimport parameters are required.");
            var fingerprint = Fingerprint(JsonSerializer.Serialize(PlainForJson(AssetReimportFingerprintInput(request)), false));
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
                QueueAssetReimport(operation, item, () => FEditor.Instance.ContentImporting.Reimport(item, BuildModelReimportSettings(item, request.ModelImportType), true));
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

        // ContentImportingModule.Reimport(item, settings, skipSettingsDialog:true)
        // only adds a request, and returns without adding one when
        // item.GetImportPath fails (its own 100 ms Content.Load) or the import
        // path no longer exists; ImportFileEnd then never fires. So the same
        // two public checks run here first and the operation is marked
        // "running" only when they pass, and a Reimport that throws takes its
        // pending entry with it, so a later manual reimport of the same asset
        // cannot complete this operation.
        private void QueueAssetReimport(McpAssetOperation operation, BinaryAssetItem item, Action reimport)
        {
            bool queueable;
            try
            {
                string engineImportPath;
                queueable = !item.GetImportPath(out engineImportPath) && File.Exists(engineImportPath);
            }
            catch { queueable = false; }
            if (!queueable)
                throw new McpProtocolException("IMPORT_FAILED", "Flax Editor would not queue this reimport: the asset's import source metadata is not loadable or its source file no longer exists.");
            var itemPath = Path.IsPathRooted(item.Path) ? item.Path : Path.Combine(Globals.ProjectFolder, item.Path);
            var output = Path.GetFullPath(itemPath);
            lock (_stateLock)
            {
                _pendingReimportsByOutputPath[output] = operation.OperationId;
                operation.Phase = "running";
                operation.Progress = 0.0f;
            }
            try { reimport(); }
            catch
            {
                lock (_stateLock)
                {
                    string pendingOperationId;
                    if (_pendingReimportsByOutputPath.TryGetValue(output, out pendingOperationId) && string.Equals(pendingOperationId, operation.OperationId, StringComparison.Ordinal))
                        _pendingReimportsByOutputPath.Remove(output);
                }
                throw;
            }
        }

        private static object BuildModelReimportSettings(BinaryAssetItem item, string modelImportType)
        {
            if (string.IsNullOrWhiteSpace(modelImportType)) return null;
            var importSettings = new ModelImportSettings();
            // The settings object replaces the importer's options wholesale
            // (ModelImportEntry.TryOverrideSettings), so without the asset's
            // own restored options every other field would silently become
            // an engine default.
            if (!FEditor.TryRestoreImportOptions(ref importSettings.Settings, item.Path))
                throw new McpProtocolException("IMPORT_FAILED", "The asset's current model import options could not be restored (it has no model import metadata), so a ModelImportType override would reimport it with engine defaults for every other option. Nothing was reimported.");
            // Repair options persisted by an earlier zero-initialized import (Scale 0, clamped to 0.0001 by the importer / null rotation collapse the skeleton).
            if (!(importSettings.Settings.Scale >= 0.001f)) importSettings.Settings.Scale = 1.0f;
            if (importSettings.Settings.Rotation.LengthSquared < 0.5f) importSettings.Settings.Rotation = Quaternion.Identity;
            importSettings.Settings.Type = ParseModelImportType(modelImportType);
            return importSettings;
        }

        private static ModelTool.ModelType ParseModelImportType(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new McpProtocolException("VALIDATION_FAILED", "ModelImportType is required when provided.");
            switch (value.Trim().Replace(" ", string.Empty).Replace("_", string.Empty).ToLowerInvariant())
            {
                case "model": return ModelTool.ModelType.Model;
                case "skinnedmodel": return ModelTool.ModelType.SkinnedModel;
                case "animation": return ModelTool.ModelType.Animation;
                case "prefab": return ModelTool.ModelType.Prefab;
                default:
                    throw new McpProtocolException("VALIDATION_FAILED", "Unsupported ModelImportType. Use Model, SkinnedModel, Animation, or Prefab.");
            }
        }

        // Bridge v32 asset import-settings get/set. Reads restore the typed
        // Options via Editor.TryRestoreImportOptions and fall back to
        // Options.Default (Restored:false); writes clone the restored options,
        // mutate the reviewed allowlist only, and apply through
        // ContentImporting.Reimport(item, settings, skipSettingsDialog:true)
        // on the shared "reimport" operation records, so
        // asset.reimport_status polls settings writes. A write is refused when
        // the current options cannot be restored: the importer replaces its
        // options wholesale with the object passed to Reimport
        // (TextureImportEntry/ModelImportEntry/AudioImportEntry
        // .TryOverrideSettings), so defaults would overwrite every option the
        // caller did not name. There is no dry-run validate-only import, no
        // metadata write without reimport, and no direct conversion outside
        // (re)import in the Flax 1.12 managed API.
        private static object AssetImportSettingsFingerprintInput(McpAssetImportSettingsSet request)
        {
            if (request == null) return new { Missing = true };
            return new { request.AssetId, request.Path, request.Settings, request.DryRun, request.AllowedImportRoots, request.MaxSourceBytes };
        }

        // Exact registry type names only. BinaryAssetProxy.ConstructItem builds
        // a TextureAssetItem for every TextureBase (CubeTexture, SpriteAtlas,
        // IESProfile), whose importers carry state this allowlist does not
        // cover (atlas sprites, cube faces), so those types are refused.
        private static string ImportSettingsKindForType(string typeName)
        {
            if (string.Equals(typeName, "FlaxEngine.Texture", StringComparison.Ordinal)) return "texture";
            if (string.Equals(typeName, "FlaxEngine.Model", StringComparison.Ordinal) || string.Equals(typeName, "FlaxEngine.SkinnedModel", StringComparison.Ordinal)) return "model";
            if (string.Equals(typeName, "FlaxEngine.AudioClip", StringComparison.Ordinal)) return "audio";
            return null;
        }

        // Runs on the registry record alone, before the editor item lookup,
        // Content.Load, or any source check, so an unsupported asset always
        // fails VALIDATION_FAILED.
        private static string ClassifyImportSettingsAsset(McpAssetRecord record)
        {
            var typeName = record == null ? null : record.Info.TypeName;
            var kind = ImportSettingsKindForType(typeName);
            if (kind == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Import settings are only supported for texture, model, and audio assets (FlaxEngine.Texture, FlaxEngine.Model, FlaxEngine.SkinnedModel, FlaxEngine.AudioClip).", new { TypeName = typeName });
            return kind;
        }

        // The editor assembly's audio item subclass is internal (CS0122 if
        // named), so only texture/model are cross-checked against the public
        // BinaryAssetItem subclasses the editor built for the asset.
        private static BinaryAssetItem RequireImportSettingsItem(McpAssetRecord record, string kind)
        {
            var item = FEditor.Instance.ContentDatabase.FindAsset(record.Id) as BinaryAssetItem;
            if (item == null) throw new McpProtocolException("IMPORT_FAILED", "The selected Content asset is not available to the Editor content database.");
            var matches = string.Equals(kind, "texture", StringComparison.Ordinal) ? item is TextureAssetItem
                : string.Equals(kind, "model", StringComparison.Ordinal) ? (item is ModelItem || item is SkinnedModeItem)
                : true;
            if (!matches) throw new McpProtocolException("IMPORT_FAILED", "The Editor content database item does not match the asset's registry type.");
            return item;
        }

        private static bool TryRestoreTextureSettings(BinaryAssetItem item, out TextureTool.Options options)
        {
            var wrapper = new TextureImportSettings();
            bool restored;
            try { restored = FEditor.TryRestoreImportOptions(ref wrapper.Settings, item.Path); }
            catch { restored = false; }
            options = restored ? wrapper.Settings : TextureTool.Options.Default;
            return restored;
        }

        private static bool TryRestoreModelSettings(BinaryAssetItem item, out ModelTool.Options options)
        {
            var wrapper = new ModelImportSettings();
            bool restored;
            try { restored = FEditor.TryRestoreImportOptions(ref wrapper.Settings, item.Path); }
            catch { restored = false; }
            options = restored ? wrapper.Settings : ModelTool.Options.Default;
            return restored;
        }

        private static bool TryRestoreAudioSettings(BinaryAssetItem item, out AudioTool.Options options)
        {
            var wrapper = new AudioImportSettings();
            bool restored;
            try { restored = FEditor.TryRestoreImportOptions(ref wrapper.Settings, item.Path); }
            catch { restored = false; }
            options = restored ? wrapper.Settings : AudioTool.Options.Default;
            return restored;
        }

        private static McpImportSettingsEntry BoolEntry(string key, bool value)
        {
            return new McpImportSettingsEntry { Key = key, Value = new McpImportSettingsValue { Boolean = value } };
        }

        private static McpImportSettingsEntry IntEntry(string key, long value)
        {
            return new McpImportSettingsEntry { Key = key, Value = new McpImportSettingsValue { Integer = value } };
        }

        private static McpImportSettingsEntry NumEntry(string key, double value)
        {
            return new McpImportSettingsEntry { Key = key, Value = new McpImportSettingsValue { Number = value } };
        }

        private static McpImportSettingsEntry TextEntry(string key, string value)
        {
            return new McpImportSettingsEntry { Key = key, Value = new McpImportSettingsValue { Text = value } };
        }

        private static McpImportSettingsEntry[] ProjectTextureSettings(TextureTool.Options options)
        {
            return new[]
            {
                TextEntry("Type", options.Type.ToString()),
                BoolEntry("sRGB", options.sRGB),
                BoolEntry("Compress", options.Compress),
                IntEntry("MaxSize", options.MaxSize),
                NumEntry("Scale", options.Scale),
                BoolEntry("GenerateMipMaps", options.GenerateMipMaps),
                BoolEntry("NeverStream", options.NeverStream),
            };
        }

        private static McpImportSettingsEntry[] ProjectModelSettings(ModelTool.Options options)
        {
            return new[]
            {
                TextEntry("Type", options.Type.ToString()),
                NumEntry("Scale", options.Scale),
                BoolEntry("CalculateNormals", options.CalculateNormals),
                NumEntry("SmoothingNormalsAngle", options.SmoothingNormalsAngle),
                BoolEntry("FlipNormals", options.FlipNormals),
                BoolEntry("CalculateTangents", options.CalculateTangents),
                NumEntry("SmoothingTangentsAngle", options.SmoothingTangentsAngle),
                BoolEntry("ReverseWindingOrder", options.ReverseWindingOrder),
                BoolEntry("OptimizeMeshes", options.OptimizeMeshes),
                BoolEntry("MergeMeshes", options.MergeMeshes),
                BoolEntry("ImportLODs", options.ImportLODs),
                BoolEntry("ImportVertexColors", options.ImportVertexColors),
                IntEntry("BaseLOD", options.BaseLOD),
                IntEntry("LODCount", options.LODCount),
            };
        }

        private static McpImportSettingsEntry[] ProjectAudioSettings(AudioTool.Options options)
        {
            return new[]
            {
                TextEntry("Format", options.Format.ToString()),
                NumEntry("Quality", options.Quality),
                BoolEntry("DisableStreaming", options.DisableStreaming),
                BoolEntry("Is3D", options.Is3D),
                TextEntry("BitDepth", options.BitDepth.ToString()),
            };
        }

        // One restore per request. The read projection, the mutated projection,
        // and the settings object handed to Reimport all derive from the same
        // restored Options value, so before/after can never come from two
        // different restore outcomes. With changes == null this is the plain
        // read; afterEntries and settingsObject are then null.
        private static McpAssetImportSettingsResult BuildImportSettings(McpAssetRecord record, BinaryAssetItem item, string kind, McpImportSettingsEntry[] changes, out McpImportSettingsEntry[] afterEntries, out object settingsObject)
        {
            afterEntries = null;
            settingsObject = null;
            bool restored;
            McpImportSettingsEntry[] currentEntries;
            if (string.Equals(kind, "texture", StringComparison.Ordinal))
            {
                TextureTool.Options options;
                restored = TryRestoreTextureSettings(item, out options);
                currentEntries = ProjectTextureSettings(options);
                if (changes != null)
                {
                    var wrapper = new TextureImportSettings();
                    wrapper.Settings = MutateTextureSettings(options, changes);
                    afterEntries = ProjectTextureSettings(wrapper.Settings);
                    settingsObject = wrapper;
                }
            }
            else if (string.Equals(kind, "model", StringComparison.Ordinal))
            {
                ModelTool.Options options;
                restored = TryRestoreModelSettings(item, out options);
                currentEntries = ProjectModelSettings(options);
                if (changes != null)
                {
                    var wrapper = new ModelImportSettings();
                    wrapper.Settings = MutateModelSettings(options, changes);
                    afterEntries = ProjectModelSettings(wrapper.Settings);
                    settingsObject = wrapper;
                }
            }
            else if (string.Equals(kind, "audio", StringComparison.Ordinal))
            {
                AudioTool.Options options;
                restored = TryRestoreAudioSettings(item, out options);
                currentEntries = ProjectAudioSettings(options);
                if (changes != null)
                {
                    var wrapper = new AudioImportSettings();
                    wrapper.Settings = MutateAudioSettings(options, changes);
                    afterEntries = ProjectAudioSettings(wrapper.Settings);
                    settingsObject = wrapper;
                }
            }
            else throw new McpProtocolException("VALIDATION_FAILED", "Import settings are only supported for texture, model, and audio assets.");
            return new McpAssetImportSettingsResult { Asset = AssetMetadata(record), Type = kind, Restored = restored, Settings = currentEntries };
        }

        private McpAssetImportSettingsResult GetAssetImportSettings(McpAssetImportSettingsGet request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset import-settings parameters are required.");
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, BuildAssetRegistry());
            var kind = ClassifyImportSettingsAsset(record);
            var item = RequireImportSettingsItem(record, kind);
            McpImportSettingsEntry[] unusedEntries;
            object unusedSettings;
            return BuildImportSettings(record, item, kind, null, out unusedEntries, out unusedSettings);
        }

        // Every entry carries exactly one scalar. A float setting also
        // accepts an Integer-typed value (JSON clients send 1 for 1.0).
        private static int ImportSettingScalarCount(McpImportSettingsValue value)
        {
            if (value == null) return 0;
            return (value.Boolean.HasValue ? 1 : 0) + (value.Integer.HasValue ? 1 : 0) + (value.Number.HasValue ? 1 : 0) + (value.Text != null ? 1 : 0);
        }

        private static bool RequireSettingBool(McpImportSettingsEntry entry)
        {
            if (ImportSettingScalarCount(entry.Value) != 1 || !entry.Value.Boolean.HasValue)
                throw new McpProtocolException("VALIDATION_FAILED", "Import setting '" + entry.Key + "' must be a boolean.");
            return entry.Value.Boolean.Value;
        }

        private static int RequireSettingInt(McpImportSettingsEntry entry, int min, int max, string rangeMessage)
        {
            if (ImportSettingScalarCount(entry.Value) != 1 || !entry.Value.Integer.HasValue)
                throw new McpProtocolException("VALIDATION_FAILED", "Import setting '" + entry.Key + "' must be an integer.");
            var value = entry.Value.Integer.Value;
            if (value < min || value > max) throw new McpProtocolException("VALIDATION_FAILED", rangeMessage);
            return (int)value;
        }

        // The range test is a negated conjunction so NaN (which a plain
        // "value < min || value > max" lets through) and infinities fail it.
        private static float RequireSettingFloat(McpImportSettingsEntry entry, double min, double max, string rangeMessage)
        {
            if (ImportSettingScalarCount(entry.Value) != 1 || (!entry.Value.Number.HasValue && !entry.Value.Integer.HasValue))
                throw new McpProtocolException("VALIDATION_FAILED", "Import setting '" + entry.Key + "' must be a number.");
            var value = entry.Value.Number.HasValue ? entry.Value.Number.Value : (double)entry.Value.Integer.Value;
            if (!(value >= min && value <= max)) throw new McpProtocolException("VALIDATION_FAILED", rangeMessage);
            return (float)value;
        }

        private static string RequireSettingEnum(McpImportSettingsEntry entry)
        {
            if (ImportSettingScalarCount(entry.Value) != 1 || entry.Value.Text == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Import setting '" + entry.Key + "' must be a string.");
            return entry.Value.Text;
        }

        private static AudioFormat ParseAudioFormat(string value)
        {
            if (string.Equals(value, "Raw", StringComparison.Ordinal)) return AudioFormat.Raw;
            if (string.Equals(value, "Vorbis", StringComparison.Ordinal)) return AudioFormat.Vorbis;
            throw new McpProtocolException("VALIDATION_FAILED", "Format must be Raw or Vorbis.");
        }

        private static AudioTool.BitDepth ParseAudioBitDepth(string value)
        {
            if (string.Equals(value, "_8", StringComparison.Ordinal)) return AudioTool.BitDepth._8;
            if (string.Equals(value, "_16", StringComparison.Ordinal)) return AudioTool.BitDepth._16;
            if (string.Equals(value, "_24", StringComparison.Ordinal)) return AudioTool.BitDepth._24;
            if (string.Equals(value, "_32", StringComparison.Ordinal)) return AudioTool.BitDepth._32;
            throw new McpProtocolException("VALIDATION_FAILED", "BitDepth must be _8, _16, _24, or _32.");
        }

        private static void RequireUniqueSettingKey(McpImportSettingsEntry entry, HashSet<string> seen)
        {
            if (entry == null || string.IsNullOrEmpty(entry.Key) || !seen.Add(entry.Key))
                throw new McpProtocolException("VALIDATION_FAILED", "Duplicate or missing import setting key.");
        }

        // Numeric ranges are the engine's own Limit attributes
        // (TextureTool.h / ModelTool.h / AudioTool.h, Flax 1.12) except where
        // noted: texture Scale keeps the engine minimum 0.0001 but a tighter
        // bridge maximum of 8 (engine: 1000), and MaxSize/model Scale carry no
        // engine Limit, so their bounds are bridge policy.
        private static TextureTool.Options MutateTextureSettings(TextureTool.Options current, McpImportSettingsEntry[] entries)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in entries)
            {
                RequireUniqueSettingKey(entry, seen);
                switch (entry.Key)
                {
                    case "sRGB": current.sRGB = RequireSettingBool(entry); break;
                    case "Compress": current.Compress = RequireSettingBool(entry); break;
                    case "MaxSize": current.MaxSize = RequireSettingInt(entry, 1, 16384, "MaxSize must be between 1 and 16384."); break;
                    case "Scale": current.Scale = RequireSettingFloat(entry, 0.0001, 8.0, "Scale must be between 0.0001 and 8."); break;
                    case "GenerateMipMaps": current.GenerateMipMaps = RequireSettingBool(entry); break;
                    case "NeverStream": current.NeverStream = RequireSettingBool(entry); break;
                    default:
                        throw new McpProtocolException("VALIDATION_FAILED", "Unknown texture import setting '" + entry.Key + "'. Allowed: sRGB, Compress, MaxSize, Scale, GenerateMipMaps, NeverStream.");
                }
            }
            return current;
        }

        private static ModelTool.Options MutateModelSettings(ModelTool.Options current, McpImportSettingsEntry[] entries)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in entries)
            {
                RequireUniqueSettingKey(entry, seen);
                switch (entry.Key)
                {
                    case "Scale": current.Scale = RequireSettingFloat(entry, 0.001, 1000.0, "Scale must be between 0.001 and 1000."); break;
                    case "CalculateNormals": current.CalculateNormals = RequireSettingBool(entry); break;
                    // ModelTool.h: SmoothingNormalsAngle Limit(0, 175), SmoothingTangentsAngle Limit(0, 45).
                    case "SmoothingNormalsAngle": current.SmoothingNormalsAngle = RequireSettingFloat(entry, 0.0, 175.0, "SmoothingNormalsAngle must be between 0 and 175."); break;
                    case "FlipNormals": current.FlipNormals = RequireSettingBool(entry); break;
                    case "CalculateTangents": current.CalculateTangents = RequireSettingBool(entry); break;
                    case "SmoothingTangentsAngle": current.SmoothingTangentsAngle = RequireSettingFloat(entry, 0.0, 45.0, "SmoothingTangentsAngle must be between 0 and 45."); break;
                    case "ReverseWindingOrder": current.ReverseWindingOrder = RequireSettingBool(entry); break;
                    case "OptimizeMeshes": current.OptimizeMeshes = RequireSettingBool(entry); break;
                    case "MergeMeshes": current.MergeMeshes = RequireSettingBool(entry); break;
                    case "ImportLODs": current.ImportLODs = RequireSettingBool(entry); break;
                    case "ImportVertexColors": current.ImportVertexColors = RequireSettingBool(entry); break;
                    // ModelTool.h: BaseLOD Limit(0, 5), LODCount Limit(1, 6); MODEL_MAX_LODS is 6.
                    case "BaseLOD": current.BaseLOD = RequireSettingInt(entry, 0, 5, "BaseLOD must be between 0 and 5."); break;
                    case "LODCount": current.LODCount = RequireSettingInt(entry, 1, 6, "LODCount must be between 1 and 6."); break;
                    default:
                        throw new McpProtocolException("VALIDATION_FAILED", "Unknown model import setting '" + entry.Key + "'. Allowed: Scale, CalculateNormals, SmoothingNormalsAngle, FlipNormals, CalculateTangents, SmoothingTangentsAngle, ReverseWindingOrder, OptimizeMeshes, MergeMeshes, ImportLODs, ImportVertexColors, BaseLOD, LODCount.");
                }
            }
            // Repair restored options that would collapse the import the way
            // the model-type reimport path already guards (see
            // BuildModelReimportSettings). A caller-supplied Scale never
            // reaches this: it is range-checked above and NaN is rejected.
            if (!(current.Scale >= 0.001f)) current.Scale = 1.0f;
            if (current.Rotation.LengthSquared < 0.5f) current.Rotation = Quaternion.Identity;
            return current;
        }

        private static AudioTool.Options MutateAudioSettings(AudioTool.Options current, McpImportSettingsEntry[] entries)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in entries)
            {
                RequireUniqueSettingKey(entry, seen);
                switch (entry.Key)
                {
                    case "Format": current.Format = ParseAudioFormat(RequireSettingEnum(entry)); break;
                    case "Quality": current.Quality = RequireSettingFloat(entry, 0.0, 1.0, "Quality must be between 0 and 1."); break;
                    case "DisableStreaming": current.DisableStreaming = RequireSettingBool(entry); break;
                    case "Is3D": current.Is3D = RequireSettingBool(entry); break;
                    case "BitDepth": current.BitDepth = ParseAudioBitDepth(RequireSettingEnum(entry)); break;
                    default:
                        throw new McpProtocolException("VALIDATION_FAILED", "Unknown audio import setting '" + entry.Key + "'. Allowed: Format, Quality, DisableStreaming, Is3D, BitDepth.");
                }
            }
            return current;
        }

        private static bool ImportSettingsEntriesDiffer(McpImportSettingsEntry[] before, McpImportSettingsEntry[] after)
        {
            if (before == null || after == null || before.Length != after.Length) return true;
            for (var i = 0; i < before.Length; i++)
            {
                if (!string.Equals(before[i].Key, after[i].Key, StringComparison.Ordinal)) return true;
                var left = before[i].Value;
                var right = after[i].Value;
                if (left == null || right == null) return true;
                if (left.Boolean != right.Boolean || left.Integer != right.Integer || left.Text != right.Text) return true;
                if (left.Number.HasValue != right.Number.HasValue) return true;
                if (left.Number.HasValue && !left.Number.Value.Equals(right.Number.Value)) return true;
            }
            return false;
        }

        private McpAssetImportSettingsSetResult RememberImportSettingsResult(McpAssetOperation operation, bool wouldChange, McpAssetImportSettingsResult before, McpAssetImportSettingsResult after)
        {
            lock (_stateLock)
                _assetImportSettingsResults[operation.OperationId] = new McpAssetImportSettingsSetResult { WouldChange = wouldChange, Before = before, After = after };
            return new McpAssetImportSettingsSetResult { Operation = CopyAssetImportOperation(operation), WouldChange = wouldChange, Before = before, After = after };
        }

        // A retry that adopts a known OperationId replays what the first call
        // computed, together with the operation's current phase. When the
        // first call failed before it had a preview, WouldChange/Before/After
        // stay null (unknown), never a "no change" answer; the caller reads
        // the failure from Operation.Phase/ErrorCode.
        private McpAssetImportSettingsSetResult AdoptedImportSettingsResult(McpAssetOperation operation)
        {
            McpAssetImportSettingsSetResult first;
            lock (_stateLock) _assetImportSettingsResults.TryGetValue(operation.OperationId, out first);
            return new McpAssetImportSettingsSetResult
            {
                Operation = operation,
                Adopted = true,
                WouldChange = first == null ? null : first.WouldChange,
                Before = first == null ? null : first.Before,
                After = first == null ? null : first.After,
            };
        }

        private McpAssetImportSettingsSetResult SetAssetImportSettings(McpAssetImportSettingsSet request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Asset import-settings parameters are required.");
            if (request.Settings == null || request.Settings.Length < 1 || request.Settings.Length > 16)
                throw new McpProtocolException("VALIDATION_FAILED", "Settings must contain between 1 and 16 entries.");
            var fingerprint = Fingerprint(JsonSerializer.Serialize(PlainForJson(AssetImportSettingsFingerprintInput(request)), false));
            bool adopted;
            var operation = BeginAssetImportOperation(request.OperationId, "reimport", fingerprint, request.DryRun, out adopted);
            if (adopted) return AdoptedImportSettingsResult(operation);
            try
            {
                EnsureAssetImportEditorReady();
                if (request.AllowedImportRoots == null || request.AllowedImportRoots.Length == 0)
                    throw new McpProtocolException("IMPORT_SOURCE_NOT_ALLOWED", "Asset import-settings changes require at least one configured import root.");
                var record = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, BuildAssetRegistry());
                // Classify the asset and validate the requested values before
                // Content.Load or any source check, so an unsupported asset or
                // a bad value always fails VALIDATION_FAILED.
                var kind = ClassifyImportSettingsAsset(record);
                var item = RequireImportSettingsItem(record, kind);
                object settingsObject;
                McpImportSettingsEntry[] afterEntries;
                var before = BuildImportSettings(record, item, kind, request.Settings, out afterEntries, out settingsObject);
                if (!before.Restored)
                    throw new McpProtocolException("IMPORT_FAILED", "The asset's current import options could not be restored from its import metadata, so a settings write would replace every option that was not requested with an engine default. Nothing was changed; reimport the asset from the Flax Editor first.");
                Asset loaded = null;
                try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
                var binary = loaded as BinaryAsset;
                if (binary == null || binary.LastLoadFailed)
                    throw new McpProtocolException("IMPORT_FAILED", "The selected Content asset is not a loadable binary asset.");
                var importPath = binary.ImportPath;
                if (string.IsNullOrEmpty(importPath))
                    throw new McpProtocolException("IMPORT_FAILED", "The selected asset has no Flax importer source metadata.");
                var sourcePath = Path.IsPathRooted(importPath) ? importPath : Path.Combine(Globals.ProjectFolder, importPath);
                var canonicalSource = ValidateAssetImportSource(sourcePath, request.AllowedImportRoots, request.MaxSourceBytes, 0, 0);
                string outputExtension;
                if (!FEditor.CanImport(Path.GetExtension(canonicalSource), out outputExtension))
                    throw new McpProtocolException("IMPORT_FAILED", "Flax reports the asset source extension is not importable.");
                var after = new McpAssetImportSettingsResult { Asset = AssetMetadata(record), Type = kind, Restored = before.Restored, Settings = afterEntries };
                operation.ResultPath = record.Path;
                operation.ResultAssetId = record.Id.ToString("N");
                var wouldChange = ImportSettingsEntriesDiffer(before.Settings, after.Settings);
                if (request.DryRun)
                {
                    FinishAssetImportOperation(operation, "dry_run", null, null);
                    return RememberImportSettingsResult(operation, wouldChange, before, after);
                }
                if (!wouldChange)
                {
                    // Nothing to write: the operation finishes "succeeded"
                    // with WouldChange:false and no reimport is queued.
                    FinishAssetImportOperation(operation, "succeeded", null, null);
                    return RememberImportSettingsResult(operation, false, before, after);
                }
                // The write shares the "reimport" operation records and the
                // pending-reimport completion map, so asset.reimport_status
                // polls settings writes like ordinary reimports.
                QueueAssetReimport(operation, item, () => FEditor.Instance.ContentImporting.Reimport(item, settingsObject, true));
                return RememberImportSettingsResult(operation, true, before, after);
            }
            catch (McpProtocolException ex)
            {
                FinishAssetImportOperation(operation, "failed", ex.Code, LimitForLog(ex.Message, 512));
                throw;
            }
            catch (Exception)
            {
                FinishAssetImportOperation(operation, "failed", "IMPORT_FAILED", "Flax Editor failed to apply the requested import settings.");
                throw new McpProtocolException("IMPORT_FAILED", "Flax Editor failed to apply the requested import settings.");
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

        // Bridge v13 material/animation reads use public Flax 1.12 managed
        // APIs only. Bridge v29 adds the bounded write/create/assign surface
        // below (SetMaterialParameters, CreateMaterialInstance,
        // AssignMaterialToActor); animation graph writes stay unsupported.
        private McpMaterialParametersResult GetMaterialParameters(McpMaterialAssetRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Material parameters are required.");
            var records = BuildAssetRegistry();
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, records);
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.Material", StringComparison.Ordinal) && !string.Equals(record.Info.TypeName, "FlaxEngine.MaterialInstance", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "The selected Content asset is not a Flax material or material instance.");
            Asset loaded = null;
            try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
            var material = loaded as MaterialBase;
            if (material == null || material.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected material could not be loaded by Flax Editor.");
            var parameters = material.Parameters ?? new MaterialParameter[0];
            var entries = new List<McpMaterialParameterDto>(parameters.Length);
            foreach (var parameter in parameters)
            {
                if (parameter == null || (!request.IncludeNonPublic && !parameter.IsPublic)) continue;
                entries.Add(new McpMaterialParameterDto
                {
                    Id = parameter.ParameterID.ToString("N"),
                    Name = Limit(parameter.Name, 256, "Material parameter"),
                    Type = parameter.ParameterType.ToString(),
                    IsPublic = parameter.IsPublic,
                    IsOverride = parameter.IsOverride,
                    Value = SafeMaterialAnimationValue(parameter.Value),
                });
            }
            entries.Sort((left, right) => string.Compare(left.Name, right.Name, StringComparison.Ordinal));
            var instance = material as MaterialInstance;
            return new McpMaterialParametersResult
            {
                Material = AssetMetadata(record),
                IsInstance = instance != null,
                BaseMaterial = instance == null ? null : AssetMetadataForLoadedAsset(instance.BaseMaterial),
                Parameters = entries.ToArray(),
                NonPublicIncluded = request.IncludeNonPublic,
                Warnings = new[] { "Values are a bounded safe projection of public material parameters. Unsupported Variant shapes are reported by type only; bounded writes are available via material.set_parameters / material.create_instance / material.assign_to_actor (bridge v29)." },
            };
        }

        // Bridge v29 bounded material writes (see bridge/PROTOCOL.md "Bridge
        // v29"). All three are edit-time only (RequireEditTime: headless and
        // play mode fail INVALID_STATE), dry-run by default, confirm-gated,
        // and idempotent. Undo honesty: parameter edits use a bridge-owned
        // generic snapshot undo (McpMaterialParametersUndo: before/after
        // values re-applied plus Asset.Save), NOT the editor
        // MaterialInstanceWindow action, which requires an open material
        // window and is not bridge-usable. Slot assignment composes the
        // generic Undo.RecordAction path (no dedicated slot action exists in
        // Flax 1.12). Instance creation has no verified undo (like v10 asset
        // organization) and reports it.
        private const int MaxMaterialParameters = 16;
        private const int MaxMaterialTextChars = 512;

        private object ExecuteMaterialSetParameters(McpMaterialSetParametersRequest q)
        {
            // Dry-run previews never consume idempotency keys (same convention
            // as ExecuteSetScriptField): a preview filed under the same key as
            // a later real write would collide on the request fingerprint.
            if (q != null && q.DryRun) return SetMaterialParameters(q);
            return ExecuteIdempotent("material.set_parameters", q == null ? null : q.IdempotencyKey, q, () => SetMaterialParameters(q));
        }

        private object ExecuteMaterialCreateInstance(McpMaterialCreateInstanceRequest q)
        {
            if (q != null && q.DryRun) return CreateMaterialInstance(q);
            return ExecuteIdempotent("material.create_instance", q == null ? null : q.IdempotencyKey, q, () => CreateMaterialInstance(q));
        }

        private object ExecuteMaterialAssign(McpMaterialAssignRequest q)
        {
            if (q != null && q.DryRun) return AssignMaterialToActor(q);
            return ExecuteIdempotent("material.assign_to_actor", q == null ? null : q.IdempotencyKey, q, () => AssignMaterialToActor(q));
        }

        private McpMaterialSetParametersResult SetMaterialParameters(McpMaterialSetParametersRequest q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Material parameter mutation requires parameters.");
            if (q.Parameters == null || q.Parameters.Length < 1 || q.Parameters.Length > MaxMaterialParameters)
                throw new McpProtocolException("VALIDATION_FAILED", "Parameters must contain between 1 and " + MaxMaterialParameters + " entries.");
            ValidateAssetSelector(q.AssetId, q.Path);
            RequireEditTime("material.set_parameters");
            var records = BuildAssetRegistry();
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = q.AssetId, Path = q.Path }, records);
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.Material", StringComparison.Ordinal) && !string.Equals(record.Info.TypeName, "FlaxEngine.MaterialInstance", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "The selected Content asset is not a Flax material or material instance.");
            Asset loaded = null;
            try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
            var material = loaded as MaterialBase;
            if (material == null || material.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected material could not be loaded by Flax Editor.");

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var defs = new MaterialParameter[q.Parameters.Length];
            var coerced = new object[q.Parameters.Length];
            for (var i = 0; i < q.Parameters.Length; i++)
            {
                var entry = q.Parameters[i];
                if (entry == null) throw new McpProtocolException("INVALID_REQUEST", "Material parameter entry " + i + " is required.");
                ValidateAssetText(entry.Name, 256, "Material parameter name");
                if (!seen.Add(entry.Name))
                    throw new McpProtocolException("VALIDATION_FAILED", "Duplicate material parameter '" + entry.Name + "'.");
                MaterialParameter def = null;
                try { def = material.GetParameter(entry.Name); } catch { def = null; }
                if (def == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "Material parameter '" + entry.Name + "' does not exist on the selected material." + MaterialParameterNameHint(material));
                defs[i] = def;
                coerced[i] = CoerceMaterialParameterValue(entry, def);
            }

            var before = new object[defs.Length];
            for (var i = 0; i < defs.Length; i++)
            {
                try { before[i] = material.GetParameterValue(defs[i].Name); }
                catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Material parameter '" + defs[i].Name + "' read failed: " + ex.GetType().FullName + "."); }
            }

            if (q.DryRun)
            {
                var preview = new McpMaterialParameterDto[defs.Length];
                for (var i = 0; i < defs.Length; i++)
                    preview[i] = MaterialParameterPreview(defs[i], coerced[i]);
                return new McpMaterialSetParametersResult
                {
                    Material = AssetMetadata(record), IsInstance = material is MaterialInstance,
                    DryRun = true, Saved = false, Verified = false, Parameters = preview,
                    ProjectRevision = _projectRevision,
                    Warnings = new[] { "Dry-run preview only: parameters were validated and coerced but nothing was applied or saved. Reissue with dryRun:false + confirm:true to persist via Asset.Save with unload/reload verification." },
                };
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Material parameter writes require confirm:true alongside dryRun:false. Values persist via Asset.Save; undo is a bridge-owned snapshot action, not the editor material-window action.");

            var names = new string[defs.Length];
            for (var i = 0; i < defs.Length; i++) names[i] = defs[i].Name;
            var applied = 0;
            try
            {
                for (; applied < defs.Length; applied++)
                    material.SetParameterValue(defs[applied].Name, coerced[applied], true);
            }
            catch (Exception ex)
            {
                for (var r = applied - 1; r >= 0; r--)
                {
                    try { material.SetParameterValue(defs[r].Name, before[r], true); } catch { }
                }
                throw new McpProtocolException("VALIDATION_FAILED", "Material parameter '" + defs[applied].Name + "' write failed (" + ex.GetType().FullName + "); earlier entries were reverted in memory and nothing was saved.");
            }
            FEditor.Instance.Undo.AddAction(new McpMaterialParametersUndo(record.Id, names, before, coerced));
            if (material.Save())
            {
                for (var r = 0; r < defs.Length; r++)
                {
                    try { material.SetParameterValue(defs[r].Name, before[r], true); } catch { }
                }
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save the selected material to disk; in-memory values were reverted.");
            }
            // Durability verification (the byte-level save path is headers-only
            // in the SDK, so prove it): unload the asset and reload from disk,
            // then compare every written value.
            Content.UnloadAsset(material);
            MaterialBase reloaded = null;
            try { reloaded = Content.Load(record.Id, AssetLoadTimeoutMs) as MaterialBase; } catch { reloaded = null; }
            if (reloaded == null || reloaded.LastLoadFailed)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The material was saved but could not be reloaded from disk for verification.", new { Verified = false });
            var disk = new object[defs.Length];
            for (var i = 0; i < defs.Length; i++)
            {
                var diskOk = false;
                try { disk[i] = reloaded.GetParameterValue(defs[i].Name); diskOk = true; } catch { diskOk = false; }
                if (!diskOk || !MaterialVariantEquals(disk[i], coerced[i]))
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "The material was saved but the reloaded value of '" + defs[i].Name + "' differs; durability is not proven.", new { Verified = false, Parameter = defs[i].Name });
            }
            var revision = AdvanceProjectRevision();
            var after = new McpMaterialParameterDto[defs.Length];
            for (var i = 0; i < defs.Length; i++)
            {
                MaterialParameter fresh = null;
                try { fresh = reloaded.GetParameter(defs[i].Name); } catch { fresh = null; }
                after[i] = new McpMaterialParameterDto
                {
                    Id = (fresh == null ? defs[i].ParameterID : fresh.ParameterID).ToString("N"),
                    Name = defs[i].Name,
                    Type = defs[i].ParameterType.ToString(),
                    IsPublic = defs[i].IsPublic,
                    IsOverride = fresh == null ? defs[i].IsOverride : fresh.IsOverride,
                    Value = SafeMaterialAnimationValue(disk[i]),
                };
            }
            var warnings = new List<string>
            {
                "Parameter edits are recorded as a bridge-owned generic snapshot undo (before/after values re-applied plus Asset.Save), not the editor MaterialInstanceWindow action, which requires an open material window.",
                "Durability was verified by unloading the asset and reloading it from disk; every written value matched the reloaded value.",
            };
            for (var i = 0; i < defs.Length; i++)
            {
                if (!defs[i].IsPublic)
                {
                    warnings.Add("One or more written parameters are non-public; they were applied because the parameter exists on the asset.");
                    break;
                }
            }
            return new McpMaterialSetParametersResult
            {
                Material = AssetMetadata(record), IsInstance = reloaded is MaterialInstance,
                DryRun = false, Saved = true, Verified = true, Parameters = after,
                ProjectRevision = revision, Warnings = warnings.ToArray(),
            };
        }

        private static McpMaterialParameterDto MaterialParameterPreview(MaterialParameter def, object next)
        {
            return new McpMaterialParameterDto
            {
                Id = def.ParameterID.ToString("N"), Name = def.Name, Type = def.ParameterType.ToString(),
                IsPublic = def.IsPublic, IsOverride = def.IsOverride, Value = SafeMaterialAnimationValue(next),
            };
        }

        private static string MaterialParameterNameHint(MaterialBase material)
        {
            try
            {
                var list = new List<string>();
                var parameters = material.Parameters ?? new MaterialParameter[0];
                foreach (var parameter in parameters)
                {
                    if (parameter != null && !string.IsNullOrEmpty(parameter.Name)) list.Add(parameter.Name);
                }
                list.Sort(StringComparer.Ordinal);
                var shown = list.Count > 32 ? list.GetRange(0, 32) : list;
                return " Available: " + string.Join(", ", shown.ToArray()) + (list.Count > 32 ? "..." : "");
            }
            catch { return ""; }
        }

        private static string RequireMaterialText(McpMaterialParameterSet entry, MaterialParameter def, string shape)
        {
            if (entry.Text == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Parameter '" + def.Name + "' (" + def.ParameterType + ") requires " + shape + ".");
            if (entry.Text.Length > MaxMaterialTextChars)
                throw new McpProtocolException("VALIDATION_FAILED", "Parameter '" + def.Name + "' exceeds " + MaxMaterialTextChars + " characters.");
            return entry.Text;
        }

        private static object CoerceMaterialParameterValue(McpMaterialParameterSet entry, MaterialParameter def)
        {
            var setCount = (entry.Bool.HasValue ? 1 : 0) + (entry.Number.HasValue ? 1 : 0) + (entry.Text != null ? 1 : 0);
            if (setCount != 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Parameter '" + def.Name + "' requires exactly one of Bool, Number, or Text.");
            var need = "Parameter '" + def.Name + "' (" + def.ParameterType + ") requires ";
            switch (def.ParameterType)
            {
                case MaterialParameterType.Bool:
                    if (!entry.Bool.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "a boolean value.");
                    return entry.Bool.Value;
                case MaterialParameterType.Integer:
                    if (!entry.Number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value.");
                    var integer = entry.Number.Value;
                    if (double.IsNaN(integer) || double.IsInfinity(integer) || Math.Truncate(integer) != integer)
                        throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value.");
                    if (integer < int.MinValue || integer > int.MaxValue)
                        throw new McpProtocolException("VALIDATION_FAILED", need + "a value within Int32 range.");
                    return (int)integer;
                case MaterialParameterType.Float:
                    if (!entry.Number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "a numeric value.");
                    var number = entry.Number.Value;
                    if (double.IsNaN(number) || double.IsInfinity(number))
                        throw new McpProtocolException("VALIDATION_FAILED", need + "a finite numeric value.");
                    if (number < -(double)float.MaxValue || number > (double)float.MaxValue)
                        throw new McpProtocolException("VALIDATION_FAILED", need + "a value within float range.");
                    return (float)number;
                case MaterialParameterType.Vector2:
                {
                    var values = ParseStrictFloatList(RequireMaterialText(entry, def, "an \"x,y\" string"), 2, need + "an \"x,y\" string", "x,y");
                    return new Float2(values[0], values[1]);
                }
                case MaterialParameterType.Vector3:
                {
                    var values = ParseStrictFloatList(RequireMaterialText(entry, def, "an \"x,y,z\" string"), 3, need + "an \"x,y,z\" string", "x,y,z");
                    return new Float3(values[0], values[1], values[2]);
                }
                case MaterialParameterType.Vector4:
                {
                    var values = ParseStrictFloatList(RequireMaterialText(entry, def, "an \"x,y,z,w\" string"), 4, need + "an \"x,y,z,w\" string", "x,y,z,w");
                    return new Float4(values[0], values[1], values[2], values[3]);
                }
                case MaterialParameterType.Color:
                    return ParseStrictColor(RequireMaterialText(entry, def, "a \"#rrggbb\" or \"r,g,b[,a]\" string"), need + "a color");
                case MaterialParameterType.Texture:
                case MaterialParameterType.CubeTexture:
                case MaterialParameterType.NormalMap:
                {
                    var text = RequireMaterialText(entry, def, "a 32-character texture asset GUID string");
                    Guid guid;
                    if (!Guid.TryParseExact(text, "N", out guid))
                        throw new McpProtocolException("VALIDATION_FAILED", need + "a 32-character texture asset GUID string.");
                    AssetInfo info;
                    if (!Content.GetAssetInfo(guid, out info))
                        throw new McpProtocolException("VALIDATION_FAILED", "Parameter '" + def.Name + "' references an unknown asset " + text + ".");
                    return guid;
                }
                default:
                    throw new McpProtocolException("VALIDATION_FAILED", "Unsupported parameter type " + def.ParameterType + " for '" + def.Name + "'. Supported: Bool, Integer, Float, Vector2, Vector3, Vector4, Color, Texture, CubeTexture, NormalMap.");
            }
        }

        private static bool MaterialVariantEquals(object left, object right)
        {
            if (left == null || right == null) return left == null && right == null;
            if ((left is float || left is double) && (right is float || right is double))
            {
                try { return Math.Abs(Convert.ToDouble(left) - Convert.ToDouble(right)) < 1e-6; }
                catch { return left.Equals(right); }
            }
            if (left is Float2 && right is Float2)
            {
                var a = (Float2)left; var b = (Float2)right;
                return Math.Abs(a.X - b.X) < 1e-6f && Math.Abs(a.Y - b.Y) < 1e-6f;
            }
            if (left is Float3 && right is Float3)
            {
                var a = (Float3)left; var b = (Float3)right;
                return Math.Abs(a.X - b.X) < 1e-6f && Math.Abs(a.Y - b.Y) < 1e-6f && Math.Abs(a.Z - b.Z) < 1e-6f;
            }
            if (left is Float4 && right is Float4)
            {
                var a = (Float4)left; var b = (Float4)right;
                return Math.Abs(a.X - b.X) < 1e-6f && Math.Abs(a.Y - b.Y) < 1e-6f && Math.Abs(a.Z - b.Z) < 1e-6f && Math.Abs(a.W - b.W) < 1e-6f;
            }
            if (left is Color && right is Color)
            {
                var a = (Color)left; var b = (Color)right;
                return Math.Abs(a.R - b.R) < 1e-6f && Math.Abs(a.G - b.G) < 1e-6f && Math.Abs(a.B - b.B) < 1e-6f && Math.Abs(a.A - b.A) < 1e-6f;
            }
            if (left is Guid && right is Guid) return (Guid)left == (Guid)right;
            // Texture reads may project the loaded Asset while the write
            // carried its GUID (or vice versa); compare by asset identity.
            if (left is Asset && right is Guid) return ((Asset)left).ID == (Guid)right;
            if (left is Guid && right is Asset) return (Guid)left == ((Asset)right).ID;
            if (left is Asset && right is Asset) return ((Asset)left).ID == ((Asset)right).ID;
            if (left is bool && right is bool) return (bool)left == (bool)right;
            if (left is string && right is string) return string.Equals((string)left, (string)right, StringComparison.Ordinal);
            return left.Equals(right);
        }

        private McpMaterialCreateInstanceResult CreateMaterialInstance(McpMaterialCreateInstanceRequest q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Material instance creation requires parameters.");
            ValidateAssetSelector(q.AssetId, q.Path);
            var destination = ValidateProjectContentPath(q.DestinationPath, false);
            if (!destination.EndsWith(".flax", StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("VALIDATION_FAILED", "Material instance destination must use a .flax path under Content/.");
            RequireEditTime("material.create_instance");
            var records = BuildAssetRegistry();
            var baseRecord = ResolveAssetRecord(new McpAssetGet { AssetId = q.AssetId, Path = q.Path }, records);
            if (!string.Equals(baseRecord.Info.TypeName, "FlaxEngine.Material", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Material instances can only be created from a Flax Material; got " + (baseRecord.Info.TypeName ?? "unknown") + ".");
            // Never overwrite: both the registry identity and on-disk presence refuse.
            // Path-spelling trap: Content.GetAssetInfo(path) on a registered file under another
            // spelling re-registers it with a new asset ID (live-observed), so the clash check
            // never asks the engine by path: registry records already carry every known path and
            // File.Exists answers for unregistered files.
            foreach (var existing in records)
            {
                if (string.Equals(existing.Path, destination, StringComparison.OrdinalIgnoreCase))
                    throw new McpProtocolException("FILE_EXISTS", "A Content asset already exists at the requested destination.");
            }
            if (File.Exists(EngineAssetPath(destination)))
                throw new McpProtocolException("FILE_EXISTS", "A Content asset already exists at the requested destination.");
            var contentRoot = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var absolute = Path.GetFullPath(Path.Combine(contentRoot, destination.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar)));
            if (!PathIsWithin(contentRoot, absolute))
                throw new McpProtocolException("VALIDATION_FAILED", "Material instance destination escapes Content.");
            if (File.Exists(absolute) || Directory.Exists(absolute))
                throw new McpProtocolException("FILE_EXISTS", "A file already exists at the requested destination.");
            if (q.DryRun)
            {
                return new McpMaterialCreateInstanceResult
                {
                    DryRun = true, Created = false, Material = null, BaseMaterial = AssetMetadata(baseRecord),
                    DestinationPath = destination, ProjectRevision = _projectRevision,
                    Warnings = new[] { "Dry-run preview only: no asset was created. Reissue with dryRun:false + confirm:true to persist via virtual-asset save." },
                };
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Material instance creation requires confirm:true alongside dryRun:false. Creation has no verified Editor undo; remove the file with asset_delete (quarantine) if it is not needed.");
            Asset loadedBase = null;
            try { loadedBase = Content.Load(baseRecord.Id, AssetLoadTimeoutMs); } catch { }
            var baseMaterial = loadedBase as Material;
            if (baseMaterial == null || baseMaterial.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The base material could not be loaded by Flax Editor.");
            var instance = Content.CreateVirtualAsset<MaterialInstance>();
            if (instance == null)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not create a virtual material instance.");
            try { instance.BaseMaterial = baseMaterial; }
            catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not bind the base material: " + ex.GetType().FullName + "."); }
            try { Directory.CreateDirectory(Path.GetDirectoryName(absolute)); }
            catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not prepare the destination folder: " + ex.GetType().FullName + "."); }
            if (File.Exists(absolute) || Directory.Exists(absolute))
                throw new McpProtocolException("FILE_EXISTS", "A file already exists at the requested destination.");
            if (instance.Save(absolute))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save the material instance to the destination.");
            if (!File.Exists(absolute))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor reported success but the material instance file is missing.");
            // Live-verified (bridge v29 scratch save): Asset.Save to a new
            // path does NOT preserve the virtual asset's in-memory ID — the
            // persisted file carries a fresh identity in its binary header.
            // The header is the durable truth; read it back instead of
            // trusting instance.ID.
            var persistedId = ReadPersistedMaterialInstanceId(absolute);
            var newId = persistedId.ToString("N");
            var revision = AdvanceProjectRevision();
            // The Content database discovers the new file asynchronously; one
            // registry rebuild confirms the common case without stalling the
            // main-thread pump that drives the scan.
            McpAssetMetadata createdMeta = null;
            try
            {
                foreach (var candidate in BuildAssetRegistry())
                {
                    if (candidate.Id == persistedId && string.Equals(candidate.Path, destination, StringComparison.OrdinalIgnoreCase)) { createdMeta = AssetMetadata(candidate); break; }
                }
            }
            catch { }
            var warnings = new List<string>
            {
                "Instance creation has no verified Editor undo record (like v10 asset organization); remove the file with asset_delete (quarantine) if it is not needed.",
                "The bridge does not save the project automatically; unsaved scenes referencing the new file still need scene_save.",
            };
            if (persistedId != instance.ID)
                warnings.Add("Asset.Save assigned the persisted file a fresh identity (virtual " + instance.ID.ToString("N") + " vs persisted " + newId + "); the persisted ID is the durable reference.");
            if (createdMeta == null)
            {
                var folder = Path.GetDirectoryName(destination);
                createdMeta = new McpAssetMetadata { Id = newId, Path = destination, TypeName = "FlaxEngine.MaterialInstance", Extension = ".flax", Folder = string.IsNullOrEmpty(folder) ? "Content" : folder.Replace('\\', '/') };
                warnings.Add("The Content registry did not list the new file on the first rebuild (database scan is asynchronous); poll asset_get for the destination path before referencing it.");
            }
            return new McpMaterialCreateInstanceResult
            {
                DryRun = false, Created = true, Material = createdMeta, BaseMaterial = AssetMetadata(baseRecord),
                DestinationPath = destination, ProjectRevision = revision, Warnings = warnings.ToArray(),
            };
        }

        private static Guid ReadPersistedMaterialInstanceId(string absolute)
        {
            // Binary .flax assets start with the CFWF magic followed by the
            // asset ID in .NET Guid byte order (live-verified: magic at
            // offset 0, 16 ID bytes at offset 28, then the UTF-16 type name).
            // This is the durable identity of a saved material instance.
            byte[] header;
            try
            {
                using (var stream = File.OpenRead(absolute))
                {
                    header = new byte[44];
                    var read = 0;
                    while (read < header.Length)
                    {
                        var count = stream.Read(header, read, header.Length - read);
                        if (count <= 0) break;
                        read += count;
                    }
                    if (read < header.Length) throw new IOException("Short asset header.");
                }
            }
            catch (McpProtocolException) { throw; }
            catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "The material instance file could not be read back to confirm its persisted identity: " + ex.GetType().FullName + "."); }
            if (header[0] != (byte)'C' || header[1] != (byte)'F' || header[2] != (byte)'W' || header[3] != (byte)'F')
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The material instance file does not carry the expected binary asset header.");
            var idBytes = new byte[16];
            Array.Copy(header, 28, idBytes, 0, 16);
            Guid persisted;
            try { persisted = new Guid(idBytes); }
            catch { throw new McpProtocolException("ASSET_OPERATION_FAILED", "The material instance file carries an unreadable asset identity."); }
            if (persisted == Guid.Empty)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The material instance file carries an empty asset identity.");
            return persisted;
        }

        private McpMaterialAssignResult AssignMaterialToActor(McpMaterialAssignRequest q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Material slot assignment requires parameters.");
            if (string.IsNullOrEmpty(q.ActorId)) throw new McpProtocolException("INVALID_REQUEST", "ActorId is required.");
            if (q.Slot < 0 || q.Slot > 255)
                throw new McpProtocolException("VALIDATION_FAILED", "Slot must be between 0 and 255.");
            ValidateAssetSelector(q.AssetId, q.Path);
            RequireEditTime("material.assign_to_actor");
            var actor = RequireActor(q.ActorId);
            var modelActor = actor as ModelInstanceActor;
            if (modelActor == null)
                throw new McpProtocolException("VALIDATION_FAILED", "ActorId must identify a loaded FlaxEngine.ModelInstanceActor subtype (StaticModel, AnimatedModel, SkinnedModel, or another ModelInstanceActor); got " + (actor.TypeName ?? "unknown") + ".");
            int slotCount;
            try { slotCount = modelActor.MaterialSlots.Length; }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Material slot count is unavailable for '" + actor.Name + "': " + ex.GetType().FullName + "."); }
            if (q.Slot >= slotCount)
                throw new McpProtocolException("VALIDATION_FAILED", "Slot " + q.Slot + " is out of range; '" + actor.Name + "' exposes " + slotCount + " material slot(s) (0.." + (slotCount - 1) + ").");
            CheckSceneWrite(actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            var records = BuildAssetRegistry();
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = q.AssetId, Path = q.Path }, records);
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.Material", StringComparison.Ordinal) && !string.Equals(record.Info.TypeName, "FlaxEngine.MaterialInstance", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "The selected Content asset is not a Flax material or material instance.");
            Asset loaded = null;
            try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
            var newMaterial = loaded as MaterialBase;
            if (newMaterial == null || newMaterial.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected material could not be loaded by Flax Editor.");
            MaterialBase before = null;
            try { before = modelActor.GetMaterial(q.Slot); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Slot " + q.Slot + " read failed: " + ex.GetType().FullName + "."); }
            var beforeMeta = AssetMetadataForLoadedAsset(before);
            var targetMeta = AssetMetadata(record);
            if (q.DryRun)
            {
                var preview = CurrentRevision(actor.Scene);
                return new McpMaterialAssignResult
                {
                    DryRun = true, ActorId = actor.ID.ToString("N"), ActorType = actor.TypeName,
                    Slot = q.Slot, SlotCount = slotCount, Material = targetMeta, Before = beforeMeta, After = targetMeta,
                    SceneEdited = false, ProjectRevision = preview.ProjectRevision, SceneRevision = preview.SceneRevision,
                    Warnings = new[] { "Dry-run preview only: the slot was not assigned. Reissue with dryRun:false + confirm:true; the scene is marked edited, never saved." },
                };
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Material slot assignment requires confirm:true alongside dryRun:false. The scene is marked edited, never saved.");
            // No dedicated slot undo action exists in Flax 1.12, so compose the
            // generic path (same UpdateActor pattern as actor.set_property).
            FEditor.Instance.Undo.RecordAction(actor, "Assign material", () =>
            {
                modelActor.SetMaterial(q.Slot, newMaterial);
                MarkEdited(actor);
            });
            var revision = AdvanceSceneRevision(actor.Scene);
            MaterialBase after = null;
            try { after = modelActor.GetMaterial(q.Slot); } catch { after = null; }
            if (after == null || after.ID != newMaterial.ID)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor did not report the assigned material on the slot after SetMaterial.");
            return new McpMaterialAssignResult
            {
                DryRun = false, ActorId = actor.ID.ToString("N"), ActorType = actor.TypeName,
                Slot = q.Slot, SlotCount = slotCount, Material = targetMeta, Before = beforeMeta, After = AssetMetadataForLoadedAsset(after),
                SceneEdited = FEditor.Instance.Scene.IsEdited(actor.Scene),
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
                Warnings = new[] { "The scene was marked edited, not saved; persist with scene_save. Assignment undo is available via edit_undo (generic composed action)." },
            };
        }

        private McpAnimationClipsResult ListAnimationClips(McpAnimationListClips request)
        {
            if (request == null) request = new McpAnimationListClips();
            ValidateAssetLimit(request.Limit);
            if (!string.IsNullOrEmpty(request.Cursor) && !IsGuidN(request.Cursor)) throw new McpProtocolException("CURSOR_INVALID", "Animation cursor is invalid.");
            if (!string.IsNullOrEmpty(request.Folder)) ValidateProjectContentPath(request.Folder, true);
            var records = BuildAssetRegistry();
            var clips = new List<McpAssetRecord>();
            foreach (var record in records)
            {
                if (!string.Equals(record.Info.TypeName, "FlaxEngine.Animation", StringComparison.Ordinal)) continue;
                if (!string.IsNullOrEmpty(request.Folder) && !IsAssetInFolder(record.Folder, request.Folder)) continue;
                clips.Add(record);
            }
            var revision = AssetIndexRevision(records);
            var scope = "animation.list_clips|" + (request.Folder ?? "");
            var offset = GetAssetCursorOffset(request.Cursor, "animation.list_clips", scope, revision);
            if (offset < 0 || offset > clips.Count) throw new McpProtocolException("CURSOR_INVALID", "Animation cursor offset is invalid.");
            var count = Math.Min(request.Limit, clips.Count - offset);
            var entries = new McpAnimationClipDto[count];
            for (var i = 0; i < count; i++) entries[i] = AnimationClipDto(clips[offset + i]);
            var hasMore = offset + count < clips.Count;
            return new McpAnimationClipsResult
            {
                Entries = entries,
                HasMore = hasMore,
                NextCursor = hasMore ? CreateAssetCursor("animation.list_clips", scope, revision, offset + count) : null,
                IndexRevision = revision,
                Warnings = new[] { "Clip metadata is read from public Animation properties. The registry scan is capped at 10000 Content assets and cursors expire after ten minutes or when registry metadata changes." },
            };
        }

        private McpAnimationGraphParametersResult GetAnimationGraphParameters(McpAnimationActorRequest request)
        {
            var model = RequireAnimatedModel(request);
            var parameters = model.Parameters ?? new AnimGraphParameter[0];
            var entries = new List<McpAnimationGraphParameterDto>(parameters.Length);
            foreach (var parameter in parameters)
            {
                if (parameter == null) continue;
                object value = null;
                try { value = model.GetParameterValue(parameter.Identifier); } catch { value = parameter.Value; }
                entries.Add(new McpAnimationGraphParameterDto
                {
                    Id = parameter.Identifier.ToString("N"),
                    Name = Limit(parameter.Name, 256, "Animation graph parameter"),
                    Type = parameter.Type.ToString(),
                    TypeName = Limit(parameter.TypeTypeName, 256, "Animation graph parameter type"),
                    IsPublic = parameter.IsPublic,
                    Value = SafeMaterialAnimationValue(value),
                });
            }
            entries.Sort((left, right) => string.Compare(left.Name, right.Name, StringComparison.Ordinal));
            return new McpAnimationGraphParametersResult
            {
                ActorId = model.ID.ToString("N"),
                AnimationGraph = AssetMetadataForLoadedAsset(model.AnimationGraph),
                Parameters = entries.ToArray(),
                Warnings = new[] { "Parameters are the live instance values for one loaded AnimatedModel. Flax 1.12 does not expose a reviewed Editor-safe way to persist or undo graph-parameter writes, so mutation is unavailable." },
            };
        }

        private object UnsupportedAnimationOperation(string capability, McpAnimationGraphMutationRequest request)
        {
            var model = RequireAnimatedModel(new McpAnimationActorRequest { ActorId = request == null ? null : request.ActorId });
            if (request == null || (string.IsNullOrEmpty(request.ParameterId) && string.IsNullOrEmpty(request.ParameterName)) || (!string.IsNullOrEmpty(request.ParameterId) && !string.IsNullOrEmpty(request.ParameterName)))
                throw new McpProtocolException("INVALID_REQUEST", "Provide exactly one graph ParameterId or ParameterName.");
            throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", capability + " is intentionally unavailable: Flax 1.12 exposes AnimatedModel.SetParameterValue for runtime state, but this bridge has no reviewed Editor undo, persistence, and semantic preview path for it.", new { Capability = capability, BridgeVersion = BridgeVersion, ActorId = model.ID.ToString("N"), DryRun = request.DryRun });
        }

        private McpAnimationBindingValidationResult ValidateAnimationBindings(McpAnimationActorRequest request)
        {
            var model = RequireAnimatedModel(request);
            var skinnedModel = model.SkinnedModel;
            var graph = model.AnimationGraph;
            var graphBaseModel = graph == null || graph.LastLoadFailed ? null : graph.BaseModel;
            var hasSkinnedModel = skinnedModel != null && !skinnedModel.LastLoadFailed;
            var hasAnimationGraph = graph != null && !graph.LastLoadFailed;
            var hasGraphBaseModel = graphBaseModel != null && !graphBaseModel.LastLoadFailed;
            var modelsMatch = hasSkinnedModel && hasGraphBaseModel && skinnedModel.ID == graphBaseModel.ID;
            var warnings = new List<string>();
            if (!hasSkinnedModel) warnings.Add("The loaded AnimatedModel has no valid public SkinnedModel reference.");
            if (!hasAnimationGraph) warnings.Add("The loaded AnimatedModel has no valid public AnimationGraph reference.");
            else if (!hasGraphBaseModel) warnings.Add("The AnimationGraph has no valid public BaseModel reference to compare against the actor.");
            else if (!modelsMatch) warnings.Add("The AnimationGraph BaseModel does not match the AnimatedModel SkinnedModel.");
            return new McpAnimationBindingValidationResult
            {
                ActorId = model.ID.ToString("N"),
                SkinnedModel = AssetMetadataForLoadedAsset(skinnedModel),
                AnimationGraph = AssetMetadataForLoadedAsset(graph),
                GraphBaseModel = AssetMetadataForLoadedAsset(graphBaseModel),
                HasSkinnedModel = hasSkinnedModel,
                HasAnimationGraph = hasAnimationGraph,
                HasGraphBaseModel = hasGraphBaseModel,
                BaseModelMatchesActor = modelsMatch,
                Valid = hasSkinnedModel && hasAnimationGraph && hasGraphBaseModel && modelsMatch,
                Warnings = warnings.ToArray(),
            };
        }

        private static AnimatedModel RequireAnimatedModel(McpAnimationActorRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.ActorId)) throw new McpProtocolException("INVALID_REQUEST", "ActorId is required.");
            var model = RequireActor(request.ActorId) as AnimatedModel;
            if (model == null) throw new McpProtocolException("VALIDATION_FAILED", "ActorId must identify a loaded FlaxEngine.AnimatedModel.");
            return model;
        }

        // Bridge v16 Visject node-graph surface (docs/VISJECT_GRAPH_EDIT_PLAN.md).
        // Window-backed only: AnimationGraph / Material / ParticleEmitter via
        // ContentEditing.Open(shown) + Windows.FindEditor +
        // IVisjectSurfaceWindow.VisjectSurface + AssetEditorWindow.Save().
        // Headless SaveSurface(byte[]) is never the write path; direct .flax
        // byte edits are forbidden. VisualScript/BehaviorTree/AnimationGraphFunction
        // assets are rejected even though they share the interface, because their
        // windows do not inherit VisjectSurfaceWindow`3 (Cecil-verified).
        // Bridge v34 adds MaterialFunction and ParticleEmitterFunction: their
        // windows (VisjectFunctionSurfaceWindow) are AssetEditorWindows with a
        // public Surface property but are not IVisjectSurfaceWindow, so the
        // surface/asset accessors below dispatch on the concrete window type
        // (live-verified for MaterialFunction; ParticleEmitterFunction shares the
        // exact same base class).
        private const int MaxGraphNodes = 500;
        private const int MaxGraphBoxesPerNode = 64;
        // Asset IDs of graph windows the bridge opened. The window must be
        // opened SHOWN (disableAutoShow:false): hidden windows never link
        // their asset (no OnShow), so their surface stays blank forever.
        // Behavior-grounded: 7/7 hidden-open reads returned blank surfaces;
        // consistent with upstream source, unverified against this 1.12
        // binary build. A same-tick
        // read after Open() still sees a blank surface because
        // VisjectSurfaceWindow.LoadSurface() runs in a later Update() frame,
        // so not-ready retries reuse (and finally close) these windows
        // instead of leaking one window per attempt. User-opened windows are
        // never in this set and are left open.
        private static readonly Dictionary<Guid, long> _graphBridgeWindows = new Dictionary<Guid, long>();
        private const long GraphBridgeWindowStaleMs = 120000;

        private static void SweepStaleGraphWindows()
        {
            if (_graphBridgeWindows.Count == 0) return;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var stale = new List<Guid>();
            foreach (var pair in _graphBridgeWindows) if (now - pair.Value > GraphBridgeWindowStaleMs) stale.Add(pair.Key);
            foreach (var id in stale)
            {
                try
                {
                    var staleItem = FEditor.Instance.ContentDatabase.FindAsset(id);
                    if (staleItem != null) FEditor.Instance.Windows.CloseAllEditors(staleItem);
                }
                catch { }
                _graphBridgeWindows.Remove(id);
            }
        }

        private static McpGraphReadinessDetails GraphNotReadyDetails(McpAssetRecord record)
        {
            return new McpGraphReadinessDetails { NotReady = true, RetryAfterMs = 1500, AssetId = record.Id.ToString("N"), Path = record.Path };
        }

        // Fail-closed readiness gate: the window's (cloned) asset must be
        // loaded AND the surface must be enabled before the surface is
        // trustworthy (hidden windows never link: no OnShow, no asset —
        // behavior-grounded, see _graphBridgeWindows comment), and VisjectSurfaceWindow runs LoadSurface()
        // in a later Update() frame, enabling the surface only in
        // OnSurfaceEditingStart(). All three in-scope windows construct
        // their surface disabled, so Enabled is a true loaded signal.
        // Sleeping here would freeze the main-thread pump that drives the
        // load, so report not-ready and let the caller retry instead.
        private static VisjectSurface GraphWindowSurface(FlaxEditor.Windows.EditorWindow window)
        {
            var visject = window as IVisjectSurfaceWindow;
            if (visject != null) return visject.VisjectSurface;
            var materialFunction = window as FlaxEditor.Windows.Assets.MaterialFunctionWindow;
            if (materialFunction != null) return materialFunction.Surface;
            var particleFunction = window as FlaxEditor.Windows.Assets.ParticleEmitterFunctionWindow;
            if (particleFunction != null) return particleFunction.Surface;
            return null;
        }

        private static Asset GraphWindowAsset(FlaxEditor.Windows.EditorWindow window)
        {
            var visject = window as IVisjectSurfaceWindow;
            if (visject != null) return visject.VisjectAsset;
            var materialFunction = window as FlaxEditor.Windows.Assets.MaterialFunctionWindow;
            if (materialFunction != null) return materialFunction.SurfaceAsset;
            var particleFunction = window as FlaxEditor.Windows.Assets.ParticleEmitterFunctionWindow;
            if (particleFunction != null) return particleFunction.SurfaceAsset;
            return null;
        }

        private static void EnsureGraphSurfaceLoaded(FlaxEditor.Windows.EditorWindow window, VisjectSurface surface, McpAssetRecord record)
        {
            Asset asset = null;
            try { asset = GraphWindowAsset(window); } catch { asset = null; }
            if (asset == null)
                throw new McpProtocolException("INVALID_STATE", "The graph editor surface is not ready. Retry after the asset finishes loading.", GraphNotReadyDetails(record));
            bool failed = false;
            try { failed = asset.LastLoadFailed; } catch { failed = false; }
            if (failed)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The graph asset failed to load in the Editor; the surface cannot be read or edited.", new McpGraphReadinessDetails { NotReady = false, RetryAfterMs = 0, AssetId = record.Id.ToString("N"), Path = record.Path });
            bool loaded = false;
            try { loaded = asset.IsLoaded; } catch { loaded = false; }
            if (!loaded)
                throw new McpProtocolException("INVALID_STATE", "The graph asset is still loading in the editor window. Retry shortly; a bridge-opened window is kept open for the retry.", GraphNotReadyDetails(record));
            bool enabled = false;
            try { enabled = surface != null && surface.Enabled; } catch { enabled = false; }
            if (!enabled)
                throw new McpProtocolException("INVALID_STATE", "The graph surface is still loading in the editor window. Retry shortly; a bridge-opened window is kept open for the retry.", GraphNotReadyDetails(record));
        }

        private static void EnsureGraphEditorReady(bool forWrite)
        {
            if (FEditor.Instance.IsHeadlessMode)
                throw new McpProtocolException("INVALID_STATE", "Visject graph editing is unavailable in headless editor mode because the surface is a GUI control.");
            if (!forWrite) return;
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested || ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady || FEditor.Instance.ContentImporting.IsImporting)
                throw new McpProtocolException("EDITOR_BUSY", "Visject graph writes are unavailable while the editor is playing, compiling, reloading, or importing content.");
        }

        private static McpAssetRecord ResolveGraphRecord(string assetId, string path)
        {
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = assetId, Path = path }, BuildAssetRegistry());
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.AnimationGraph", StringComparison.Ordinal)
                && !string.Equals(record.Info.TypeName, "FlaxEngine.Material", StringComparison.Ordinal)
                && !string.Equals(record.Info.TypeName, "FlaxEngine.ParticleEmitter", StringComparison.Ordinal)
                && !string.Equals(record.Info.TypeName, "FlaxEngine.MaterialFunction", StringComparison.Ordinal)
                && !string.Equals(record.Info.TypeName, "FlaxEngine.ParticleEmitterFunction", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Graph operations support only FlaxEngine.AnimationGraph, FlaxEngine.Material, FlaxEngine.ParticleEmitter, FlaxEngine.MaterialFunction, and FlaxEngine.ParticleEmitterFunction. VisualScript, BehaviorTree, MaterialInstance, and AnimationGraphFunction assets are out of scope.", new { TypeName = record.Info.TypeName });
            return record;
        }

        private static void ValidateGraphWindow(FlaxEditor.Windows.EditorWindow window, McpAssetRecord record)
        {
            if (window == null)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected graph asset has no editor window.");
            var isAnim = window is FlaxEditor.Windows.Assets.AnimationGraphWindow;
            var isMat = window is FlaxEditor.Windows.Assets.MaterialWindow;
            var isFx = window is FlaxEditor.Windows.Assets.ParticleEmitterWindow;
            var isMatFunction = window is FlaxEditor.Windows.Assets.MaterialFunctionWindow;
            var isFxFunction = window is FlaxEditor.Windows.Assets.ParticleEmitterFunctionWindow;
            if (!isAnim && !isMat && !isFx && !isMatFunction && !isFxFunction)
                throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected asset window is not a supported Visject editor (VisualScript/BehaviorTree/AnimationGraphFunction windows are out of scope).", new { TypeName = record.Info.TypeName, Window = window.GetType().FullName });
            if (!(window is IVisjectSurfaceWindow) && !isMatFunction && !isFxFunction)
                throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose a Visject surface.", new { TypeName = record.Info.TypeName });
        }

        private static VisjectSurface AcquireGraphSurface(McpAssetRecord record, out ContentItem item, out FlaxEditor.Windows.EditorWindow window, out bool openedByBridge)
        {
            SweepStaleGraphWindows();
            item = FEditor.Instance.ContentDatabase.FindAsset(record.Id);
            if (item == null)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected graph asset is unavailable in the Editor Content database.");
            window = FEditor.Instance.Windows.FindEditor(item);
            openedByBridge = false;
            if (window != null)
            {
                ValidateGraphWindow(window, record);
                // Only windows the bridge opened are bridge-owned
                // (closed after the operation). User-opened windows are
                // reused and left open.
                openedByBridge = _graphBridgeWindows.ContainsKey(record.Id);
                var existing = GraphWindowSurface(window);
                if (existing == null)
                    throw new McpProtocolException("INVALID_STATE", "The graph editor surface is not ready. Retry after the asset finishes loading.", GraphNotReadyDetails(record));
                EnsureGraphSurfaceLoaded(window, existing, record);
                return existing;
            }
            FlaxEditor.Windows.EditorWindow opened = null;
            // disableAutoShow:false is mandatory (see _graphBridgeWindows
            // comment): hidden windows never link their asset.
            try { opened = FEditor.Instance.ContentEditing.Open(item, false); }
            catch (Exception) { opened = null; }
            if (opened == null)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not open the selected graph asset.");
            ValidateGraphWindow(opened, record);
            // Record ownership before the readiness check so a not-ready
            // retry reuses this window (FindEditor) instead of
            // leaking one window per attempt.
            _graphBridgeWindows[record.Id] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            try
            {
                var surface = GraphWindowSurface(opened);
                if (surface == null)
                    throw new McpProtocolException("INVALID_STATE", "The graph editor surface is not ready. Retry after the asset finishes loading.", GraphNotReadyDetails(record));
                EnsureGraphSurfaceLoaded(opened, surface, record);
                window = opened;
                openedByBridge = true;
                return surface;
            }
            catch (McpProtocolException ex)
            {
                if (!string.Equals(ex.Code, "INVALID_STATE", StringComparison.Ordinal))
                {
                    _graphBridgeWindows.Remove(record.Id);
                    try { FEditor.Instance.Windows.CloseAllEditors(item); } catch { }
                }
                throw;
            }
        }

        private static void ReleaseGraphWindow(ContentItem item, bool openedByBridge, Guid assetId)
        {
            _graphBridgeWindows.Remove(assetId);
            if (!openedByBridge || item == null) return;
            try { FEditor.Instance.Windows.CloseAllEditors(item); } catch { }
        }

        // Bridge v19 Phase 6a: shared read-only projection used by the root
        // context and every sub-context. Same bounds everywhere: Limit nodes
        // per context, 32 values per node, 64 boxes per node, safe-typed
        // values only. Pure reads — no MarkAsModified, no Save.
        private static McpGraphNodeDto ProjectGraphNodeDto(SurfaceNode node, bool includeValues)
        {
            ushort groupId = 0;
            ushort typeId = 0;
            string title = "";
            float x = 0.0f;
            float y = 0.0f;
            int valuesCount = 0;
            McpMaterialTypedValue[] values = null;
            try { title = TruncateGraphText(node.Title, 256); } catch { title = ""; }
            try { groupId = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { groupId = 0; }
            try { typeId = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { typeId = 0; }
            try { x = node.Location.X; y = node.Location.Y; } catch { x = 0.0f; y = 0.0f; }
            try
            {
                var raw = node.Values;
                valuesCount = raw == null ? 0 : raw.Length;
                if (includeValues && raw != null)
                {
                    var projected = new List<McpMaterialTypedValue>(Math.Min(raw.Length, 32));
                    for (var vi = 0; vi < raw.Length && vi < 32; vi++)
                    {
                        try { projected.Add(SafeMaterialAnimationValue(raw[vi])); }
                        catch { projected.Add(new McpMaterialTypedValue { Kind = "unavailable" }); }
                    }
                    values = projected.ToArray();
                }
            }
            catch { valuesCount = 0; values = null; }
            return new McpGraphNodeDto { Id = node.ID, GroupID = groupId, TypeID = typeId, Title = title, X = x, Y = y, ValuesCount = valuesCount, Values = values };
        }

        private static McpGraphBoxDto[] ProjectNodeBoxDtos(SurfaceNode node)
        {
            var boxDtos = new List<McpGraphBoxDto>();
            for (var bi = 0; bi < MaxGraphBoxesPerNode; bi++)
            {
                FlaxEditor.Surface.Elements.Box box = null;
                try
                {
                    FlaxEditor.Surface.Elements.Box found;
                    // Box IDs may be sparse: skip misses instead of
                    // stopping at the first gap, otherwise boxes
                    // after a hole would be silently dropped.
                    // MaxGraphBoxesPerNode still caps the scan.
                    if (!node.TryGetBox(bi, out found)) continue;
                    box = found;
                }
                catch { continue; }
                if (box == null) continue;
                var conns = new List<string>();
                try
                {
                    var list = box.Connections;
                    if (list != null)
                    {
                        foreach (var other in list)
                        {
                            if (other == null || other.ParentNode == null) continue;
                            conns.Add(other.ParentNode.ID + ":" + other.ID);
                            if (conns.Count >= MaxGraphBoxesPerNode) break;
                        }
                    }
                }
                catch { }
                bool isOutput = false;
                int boxId = 0;
                try { isOutput = box.IsOutput; } catch { isOutput = false; }
                try { boxId = box.ID; } catch { boxId = 0; }
                boxDtos.Add(new McpGraphBoxDto { NodeID = node.ID, BoxID = boxId, IsOutput = isOutput, Connections = conns.ToArray() });
            }
            return boxDtos.ToArray();
        }

        private static McpGraphParameterDto[] ProjectGraphParameterDtos(System.Collections.Generic.List<SurfaceParameter> parameters, bool includeValues)
        {
            var paramDtos = new List<McpGraphParameterDto>(parameters == null ? 0 : parameters.Count);
            if (parameters == null) return paramDtos.ToArray();
            foreach (var param in parameters)
            {
                if (param == null) continue;
                McpMaterialTypedValue projected;
                try { projected = SafeMaterialAnimationValue(param.Value); }
                catch { projected = new McpMaterialTypedValue { Kind = "unavailable" }; }
                string typeText;
                try { typeText = param.Type.ToString(); }
                catch { typeText = "unknown"; }
                string paramId;
                try { paramId = param.ID.ToString("N"); } catch { paramId = ""; }
                string paramName;
                try { paramName = TruncateGraphText(param.Name, 256); } catch { paramName = ""; }
                bool isPublic = false;
                try { isPublic = param.IsPublic; } catch { isPublic = false; }
                paramDtos.Add(new McpGraphParameterDto
                {
                    Id = paramId,
                    Name = paramName,
                    Type = TruncateGraphText(typeText, 256),
                    IsPublic = isPublic,
                    Value = includeValues ? projected : null,
                });
            }
            paramDtos.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.Ordinal));
            return paramDtos.ToArray();
        }

        // Bridge v19 Phase 6a (corrected): read-only sub-context walk.
        // IL-verified: FindContext(Span) only reads the surface context cache
        // and cannot see never-opened contexts, so discovery navigates with
        // OpenContext(path) which materializes (CreateContext + Load) without
        // touching asset data. Stack discipline is kept with before/after
        // reference checks (close only what this walk pushed), candidate paths
        // are every node ID (a failed open or OwnerNodeID mismatch means "not
        // a sub-context"), and the entry view is restored at the end. Never
        // MarkAsModified, never Save.
        private static uint[] GraphCurrentContextPath(VisjectSurface surface)
        {
            VisjectSurfaceContext ctx = null;
            try { ctx = surface.Context; } catch { ctx = null; }
            VisjectSurfaceContext root = null;
            try { root = surface.RootContext; } catch { root = null; }
            if (ctx == null || root == null || object.ReferenceEquals(ctx, root)) return new uint[0];
            var rev = new List<uint>();
            var guard = 0;
            while (ctx != null && !object.ReferenceEquals(ctx, root) && guard < 64)
            {
                guard++;
                uint owner = 0;
                try { owner = ctx.OwnerNodeID; } catch { break; }
                rev.Add(owner);
                try { ctx = ctx.Parent; } catch { break; }
            }
            rev.Reverse();
            return rev.ToArray();
        }

        private static void InspectGraphContextRecursive(VisjectSurface surface, uint[] path, int depth, int limit, bool includeValues, bool includeBoxes, int maxDepth, HashSet<string> visited, List<McpGraphContextDto> result, List<string> warnings)
        {
            var key = string.Join("/", path);
            if (!visited.Add(key)) return;
            VisjectSurfaceContext before = null;
            try { before = surface.Context; } catch { before = null; }
            VisjectSurfaceContext opened = null;
            try { opened = surface.OpenContext(new Span<uint>(path)); } catch { opened = null; }
            VisjectSurfaceContext after = null;
            try { after = surface.Context; } catch { after = null; }
            bool pushed = !object.ReferenceEquals(after, before);
            try
            {
                var ctx = opened != null ? opened : after;
                uint last = path[path.Length - 1];
                uint ownerId = 0xFFFFFFFF;
                try { ownerId = ctx == null ? 0xFFFFFFFF : ctx.OwnerNodeID; } catch { ownerId = 0xFFFFFFFF; }
                if (ctx == null || ownerId != last) return;
                var nodes = ctx.Nodes;
                var nodeDtos = new List<McpGraphNodeDto>();
                var boxDtos = new List<McpGraphBoxDto>();
                var childIds = new List<uint>();
                if (nodes != null)
                {
                    for (var i = 0; i < nodes.Count && i < limit; i++)
                    {
                        var node = nodes[i];
                        if (node == null) continue;
                        nodeDtos.Add(ProjectGraphNodeDto(node, includeValues));
                        if (includeBoxes)
                        {
                            foreach (var b in ProjectNodeBoxDtos(node)) boxDtos.Add(b);
                        }
                        uint nid = 0;
                        try { nid = node.ID; } catch { continue; }
                        childIds.Add(nid);
                    }
                }
                System.Collections.Generic.List<SurfaceParameter> ctxParams = null;
                try { ctxParams = ctx.Parameters; } catch { ctxParams = null; }
                result.Add(new McpGraphContextDto
                {
                    OwnerNodeID = ownerId,
                    Path = (uint[])path.Clone(),
                    Depth = depth,
                    Nodes = nodeDtos.ToArray(),
                    Boxes = includeBoxes ? boxDtos.ToArray() : new McpGraphBoxDto[0],
                    Parameters = ProjectGraphParameterDtos(ctxParams, includeValues),
                });
                if (depth >= maxDepth) return;
                foreach (var nid in childIds)
                {
                    var childPath = new uint[path.Length + 1];
                    Array.Copy(path, childPath, path.Length);
                    childPath[path.Length] = nid;
                    InspectGraphContextRecursive(surface, childPath, depth + 1, limit, includeValues, includeBoxes, maxDepth, visited, result, warnings);
                }
            }
            finally
            {
                if (pushed)
                {
                    try { surface.CloseContext(); } catch { warnings.Add("Could not pop the sub-context navigation stack; the entry view restore below will correct it."); }
                }
            }
        }

        private static McpGraphContextDto[] InspectGraphSubcontexts(VisjectSurface surface, bool includeValues, bool includeBoxes, int limit, int maxDepth, List<string> warnings, out uint[] entryPath)
        {
            entryPath = GraphCurrentContextPath(surface);
            var result = new List<McpGraphContextDto>();
            var visited = new HashSet<string>();
            var root = surface.RootContext;
            if (root == null || root.Nodes == null) return result.ToArray();
            var seedIds = new List<uint>();
            for (var i = 0; i < root.Nodes.Count && i < limit; i++)
            {
                var node = root.Nodes[i];
                if (node == null) continue;
                uint nid = 0;
                try { nid = node.ID; } catch { continue; }
                seedIds.Add(nid);
            }
            foreach (var nid in seedIds)
                InspectGraphContextRecursive(surface, new uint[] { nid }, 1, limit, includeValues, includeBoxes, maxDepth, visited, result, warnings);
            try { surface.OpenContext(new Span<uint>(entryPath)); }
            catch (Exception ex) { warnings.Add("Could not restore the entry graph view after sub-context inspection: " + ex.Message); }
            return result.ToArray();
        }

        private McpGraphInspectResult GraphInspect(McpGraphInspectRequest request)
        {
            if (request == null) request = new McpGraphInspectRequest();
            if (FEditor.Instance.IsHeadlessMode)
                throw new McpProtocolException("INVALID_STATE", "Graph inspection is unavailable in headless editor mode because the surface is a GUI control.");
            if (request.Limit < 1 || request.Limit > MaxGraphNodes)
                throw new McpProtocolException("VALIDATION_FAILED", "Limit must be between 1 and " + MaxGraphNodes + ".");
            if (request.IncludeSubcontexts && (request.MaxDepth < 1 || request.MaxDepth > 5))
                throw new McpProtocolException("VALIDATION_FAILED", "MaxDepth must be between 1 and 5 when IncludeSubcontexts is set.");
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            try
            {
                var nodes = surface.Nodes;
                var parameters = surface.Parameters;
                if (nodes == null || parameters == null)
                    throw new McpProtocolException("INVALID_STATE", "The graph editor surface is not ready. Retry after the asset finishes loading.");
                var limit = Math.Min(request.Limit, MaxGraphNodes);
                var hasMore = nodes.Count > limit;
                var nodeDtos = new List<McpGraphNodeDto>(Math.Min(nodes.Count, limit));
                var boxDtos = new List<McpGraphBoxDto>();
                for (var i = 0; i < nodes.Count && i < limit; i++)
                {
                    var node = nodes[i];
                    if (node == null) continue;
                    nodeDtos.Add(ProjectGraphNodeDto(node, request.IncludeValues));
                    if (request.IncludeBoxes)
                    {
                        foreach (var b in ProjectNodeBoxDtos(node)) boxDtos.Add(b);
                    }
                }
                var paramDtos = ProjectGraphParameterDtos(parameters, request.IncludeValues);
                var inspectWarnings = new List<string>();
                McpGraphContextDto[] contexts = new McpGraphContextDto[0];
                if (request.IncludeSubcontexts)
                {
                    uint[] entryPath;
                    contexts = InspectGraphSubcontexts(surface, request.IncludeValues, request.IncludeBoxes, limit, request.MaxDepth, inspectWarnings, out entryPath);
                }
                var allWarnings = new List<string>(inspectWarnings);
                allWarnings.Add("Graph inspection is read-only through the window-backed Visject surface (shown on demand, closed after the read). Node identity is UInt16 groupID + typeID; values are a bounded safe projection capped at 32 entries per node.");
                allWarnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after the read." : "A window already open for this asset was reused and left open.");
                if (request.IncludeSubcontexts)
                    allWarnings.Add("Sub-contexts were materialized by navigating OpenContext(path) and restored afterwards with stack balancing: the entry view is preserved, but reused windows may briefly flicker and fire ContextChanged. Nothing was marked edited and nothing was saved.");
                return new McpGraphInspectResult
                {
                    Asset = AssetMetadata(record),
                    OpenedByBridge = openedByBridge,
                    Nodes = nodeDtos.ToArray(),
                    Boxes = request.IncludeBoxes ? boxDtos.ToArray() : new McpGraphBoxDto[0],
                    Parameters = paramDtos,
                    HasMore = hasMore,
                    BoxesIncluded = request.IncludeBoxes,
                    ValuesIncluded = request.IncludeValues,
                    Contexts = contexts,
                    SubcontextsIncluded = request.IncludeSubcontexts,
                    Warnings = allWarnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        private McpGraphSetDefaultParameterResult SetGraphDefaultParameter(McpGraphSetDefaultParameterRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph parameter mutation parameters are required.");
            if ((string.IsNullOrEmpty(request.ParameterId) && string.IsNullOrEmpty(request.ParameterName)) || (!string.IsNullOrEmpty(request.ParameterId) && !string.IsNullOrEmpty(request.ParameterName)))
                throw new McpProtocolException("INVALID_REQUEST", "Provide exactly one graph ParameterId or ParameterName.");
            if (request.Value == null) throw new McpProtocolException("INVALID_REQUEST", "A typed Value is required.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            try
            {
                SurfaceParameter target = null;
                if (!string.IsNullOrEmpty(request.ParameterId))
                {
                    Guid id;
                    if (!Guid.TryParseExact(request.ParameterId, "N", out id))
                        throw new McpProtocolException("INVALID_REQUEST", "ParameterId must be a 32-character GUID.");
                    try { target = surface.GetParameter(id); } catch { target = null; }
                }
                else
                {
                    var list = surface.Parameters;
                    if (list != null)
                    {
                        foreach (var candidate in list)
                        {
                            if (candidate != null && string.Equals(candidate.Name, request.ParameterName, StringComparison.Ordinal)) { target = candidate; break; }
                        }
                    }
                }
                if (target == null)
                    throw new McpProtocolException("NOT_FOUND", "The requested graph parameter was not found on the Visject surface.");
                var previous = SafeMaterialAnimationValue(target.Value);
                var nextValue = FromGraphTypedValue(request.Value);
                var preview = new McpGraphParameterDto
                {
                    Id = target.ID.ToString("N"),
                    Name = TruncateGraphText(target.Name, 256),
                    Type = TruncateGraphText(SafeGraphTypeName(target), 256),
                    IsPublic = target.IsPublic,
                    Value = SafeMaterialAnimationValue(nextValue),
                };
                if (request.DryRun)
                {
                    return new McpGraphSetDefaultParameterResult
                    {
                        Asset = AssetMetadata(record),
                        Parameter = preview,
                        PreviousValue = previous,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: the surface was not mutated and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph parameter writes require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                target.Value = nextValue;
                try { surface.OnParamEdited(target); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface OnParamEdited notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                return new McpGraphSetDefaultParameterResult
                {
                    Asset = AssetMetadata(record),
                    Parameter = new McpGraphParameterDto
                    {
                        Id = target.ID.ToString("N"),
                        Name = TruncateGraphText(target.Name, 256),
                        Type = TruncateGraphText(SafeGraphTypeName(target), 256),
                        IsPublic = target.IsPublic,
                        Value = SafeMaterialAnimationValue(target.Value),
                    },
                    PreviousValue = previous,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = new[]
                    {
                        "Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone: per-window graph undo only covers edits made before saving.",
                        openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.",
                    },
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        // Bridge v16 Phase 3 bounded macro: append one surface parameter.
        // This is the only additive topology mutation in scope. Node spawn,
        // wire connect/remove, and state/transition macros stay forbidden
        // until their archetype allowlists are grounded in real inspect data.
        private McpGraphSetDefaultParameterResult AddGraphParameter(McpGraphAddParameterRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph add-parameter parameters are required.");
            if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 256)
                throw new McpProtocolException("INVALID_REQUEST", "Parameter name must be between 1 and 256 characters.");
            if (string.IsNullOrWhiteSpace(request.Type))
                throw new McpProtocolException("INVALID_REQUEST", "Parameter type is required (boolean, integer, number, string, vector2, vector3, vector4, or color).");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            try
            {
                var list = surface.Parameters;
                if (list == null)
                    throw new McpProtocolException("INVALID_STATE", "The graph editor surface is not ready. Retry after the asset finishes loading.");
                foreach (var existing in list)
                {
                    if (existing != null && string.Equals(existing.Name, request.Name, StringComparison.Ordinal))
                        throw new McpProtocolException("VALIDATION_FAILED", "A graph parameter with this name already exists.");
                }
                Type clrType;
                object defaultValue;
                GraphParameterTypeMapping(request.Type, out clrType, out defaultValue);
                var visjectWindow = window as IVisjectSurfaceWindow;
                if (visjectWindow == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose a Visject surface.");
                var allowed = false;
                try
                {
                    var offered = visjectWindow.NewParameterTypes;
                    if (offered != null)
                    {
                        foreach (var offeredType in offered)
                        {
                            if (offeredType != null && offeredType.Type == clrType) { allowed = true; break; }
                        }
                    }
                }
                catch { allowed = false; }
                if (!allowed)
                    throw new McpProtocolException("VALIDATION_FAILED", "Parameter type '" + request.Type + "' is not offered by this graph window.", new { TypeName = record.Info.TypeName });
                object value = defaultValue;
                if (request.Value != null)
                {
                    value = FromGraphTypedValue(request.Value);
                    value = CoerceGraphParameterValue(value, clrType, request.Type);
                }
                var preview = new McpGraphParameterDto
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Name = TruncateGraphText(request.Name, 256),
                    Type = TruncateGraphText(clrType.FullName, 256),
                    IsPublic = request.IsPublic,
                    Value = SafeMaterialAnimationValue(value),
                };
                if (request.DryRun)
                {
                    return new McpGraphSetDefaultParameterResult
                    {
                        Asset = AssetMetadata(record),
                        Parameter = preview,
                        PreviousValue = null,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: no parameter was added and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph parameter adds require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                var created = new SurfaceParameter
                {
                    ID = Guid.NewGuid(),
                    Name = request.Name,
                    Type = new FlaxEditor.Scripting.ScriptType(clrType),
                    IsPublic = request.IsPublic,
                    Value = value,
                };
                list.Add(created);
                try { surface.OnParamCreated(created); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface OnParamCreated notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                return new McpGraphSetDefaultParameterResult
                {
                    Asset = AssetMetadata(record),
                    Parameter = new McpGraphParameterDto
                    {
                        Id = created.ID.ToString("N"),
                        Name = TruncateGraphText(created.Name, 256),
                        Type = TruncateGraphText(SafeGraphTypeName(created), 256),
                        IsPublic = created.IsPublic,
                        Value = SafeMaterialAnimationValue(created.Value),
                    },
                    PreviousValue = null,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = new[]
                    {
                        "Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.",
                        openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.",
                    },
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        // Bridge v17 Phase 3: bounded AnimGraph state-machine macros.
        // Archetype IDs grounded by Cecil dump of FlaxEngine.CSharp.dll
        // 1.12.6912 (group 9 table) + live verify; runtime gates below
        // re-check everything, so a version drift fails closed instead of
        // corrupting the graph. State Machine=(9,18), Entry=(9,19) [engine
        // auto-ensures], State=(9,20), State Output=(9,21) [auto-ensured per
        // state], TransitionSrc=(9,23), Any=(9,34). Values are always cloned
        // from the resolved archetype defaults at runtime — no hardcoded
        // value arrays. clip_guid is intentionally NOT supported: a state
        // stores (title, ?, transitions), the clip lives in the state's
        // sub-context and is a separate follow-up.
        private const ushort AnimGraphGroup = 9;
        private const ushort AnimGraphStateMachineNode = 18;
        private const ushort AnimGraphStateNode = 20;
        private const ushort AnimGraphAnyStateNode = 34;

        public class McpGraphAddStateRequest { public string AssetId; public string Path; public string Name; public float? X; public float? Y; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphAddStateResult { public McpAssetMetadata Asset; public McpGraphNodeDto State; public McpGraphNodeDto Machine; public bool MachineCreated; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }
        public class McpGraphAddTransitionRequest { public string AssetId; public string Path; public string FromState; public string ToState; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphAddTransitionResult { public McpAssetMetadata Asset; public string FromState; public uint FromId; public string ToState; public uint ToId; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }

        private static void EnsureAnimgraphAsset(McpAssetRecord record)
        {
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.AnimationGraph", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "State-machine macros support only FlaxEngine.AnimationGraph assets in this phase.", new { TypeName = record.Info.TypeName });
        }

        private static void EnsureAnimgraphNodeUsable(VisjectSurface surface, ushort typeId)
        {
            GroupArchetype groupArch;
            NodeArchetype nodeArch;
            if (!NodeFactory.GetArchetype(NodeFactory.DefaultGroups, AnimGraphGroup, typeId, out groupArch, out nodeArch) || nodeArch == null)
                throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The editor does not offer the required AnimGraph node archetype in this version.", new { GroupID = AnimGraphGroup, TypeID = typeId });
            if (!surface.CanUseNodeType(AnimGraphGroup, typeId))
                throw new McpProtocolException("VALIDATION_FAILED", "The AnimGraph node archetype is not usable on this surface.", new { GroupID = AnimGraphGroup, TypeID = typeId });
        }

        private static SurfaceNode FindRootAnimgraphNode(VisjectSurface surface, ushort typeId)
        {
            var root = surface.RootContext;
            if (root == null || root.Nodes == null)
                throw new McpProtocolException("INVALID_STATE", "The graph root context is not ready. Retry shortly.", null);
            foreach (var node in root.Nodes)
            {
                if (node == null) continue;
                ushort g = 0;
                ushort t = 0;
                try { g = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { g = 0; }
                try { t = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { t = 0; }
                if (g == AnimGraphGroup && t == typeId) return node;
            }
            return null;
        }

        private static object[] CloneAnimgraphDefaults(ushort typeId)
        {
            GroupArchetype groupArch;
            NodeArchetype nodeArch;
            if (!NodeFactory.GetArchetype(NodeFactory.DefaultGroups, AnimGraphGroup, typeId, out groupArch, out nodeArch) || nodeArch == null || nodeArch.DefaultValues == null)
                throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The editor does not offer the required AnimGraph node archetype in this version.", new { GroupID = AnimGraphGroup, TypeID = typeId });
            var src = nodeArch.DefaultValues;
            var dst = new object[src.Length];
            for (var i = 0; i < src.Length; i++) dst[i] = src[i] is byte[] bytes ? (object)bytes.Clone() : src[i];
            return dst;
        }

        private static SurfaceNode FindAnimgraphState(VisjectSurfaceContext machineCtx, string name)
        {
            if (machineCtx == null || machineCtx.Nodes == null) return null;
            foreach (var node in machineCtx.Nodes)
            {
                if (node == null) continue;
                ushort g = 0;
                ushort t = 0;
                try { g = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { g = 0; }
                try { t = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { t = 0; }
                if (g != AnimGraphGroup || (t != AnimGraphStateNode && t != AnimGraphAnyStateNode)) continue;
                string title = null;
                try { title = node.Title; } catch { title = null; }
                if (string.Equals(title, name, StringComparison.Ordinal)) return node;
            }
            return null;
        }

        private static int CountAnimgraphStates(VisjectSurfaceContext machineCtx)
        {
            var count = 0;
            if (machineCtx == null || machineCtx.Nodes == null) return 0;
            foreach (var node in machineCtx.Nodes)
            {
                if (node == null) continue;
                ushort g = 0;
                ushort t = 0;
                try { g = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { g = 0; }
                try { t = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { t = 0; }
                if (g == AnimGraphGroup && (t == AnimGraphStateNode || t == AnimGraphAnyStateNode)) count++;
            }
            return count;
        }

        private static McpGraphNodeDto AnimgraphNodeDto(SurfaceNode node)
        {
            ushort g = 0;
            ushort t = 0;
            string title = "";
            float x = 0.0f;
            float y = 0.0f;
            try { g = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { g = 0; }
            try { t = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { t = 0; }
            try { title = TruncateGraphText(node.Title, 256); } catch { title = ""; }
            try { x = node.Location.X; y = node.Location.Y; } catch { x = 0.0f; y = 0.0f; }
            return new McpGraphNodeDto { Id = node.ID, GroupID = g, TypeID = t, Title = title, X = x, Y = y, ValuesCount = 0, Values = null };
        }

        private McpGraphAddStateResult AddAnimgraphState(McpGraphAddStateRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph add-state parameters are required.");
            if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 256)
                throw new McpProtocolException("INVALID_REQUEST", "State name must be between 1 and 256 characters.");
            if ((request.X.HasValue != request.Y.HasValue) || (request.X.HasValue && (!float.IsFinite(request.X.Value) || !float.IsFinite(request.Y.Value))))
                throw new McpProtocolException("INVALID_REQUEST", "State position requires both finite X and Y, or neither for auto-layout.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            EnsureAnimgraphAsset(record);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                EnsureAnimgraphNodeUsable(surface, AnimGraphStateMachineNode);
                EnsureAnimgraphNodeUsable(surface, AnimGraphStateNode);
                var machine = FindRootAnimgraphNode(surface, AnimGraphStateMachineNode);
                var machineCreated = false;
                if (machine == null)
                {
                    if (request.DryRun)
                    {
                        return new McpGraphAddStateResult
                        {
                            Asset = AssetMetadata(record),
                            State = new McpGraphNodeDto { Id = 0, GroupID = AnimGraphGroup, TypeID = AnimGraphStateNode, Title = TruncateGraphText(request.Name, 256), X = request.X ?? 300.0f, Y = request.Y ?? 140.0f },
                            Machine = null,
                            MachineCreated = true,
                            DryRun = true,
                            Saved = false,
                            OpenedByBridge = openedByBridge,
                            ProjectRevision = _projectRevision,
                            Warnings = new[] { "Dry-run preview only: no state machine and no state were created and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                        };
                    }
                    if (!request.Confirm)
                        throw new McpProtocolException("VALIDATION_FAILED", "Graph state adds require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                    var machineValues = CloneAnimgraphDefaults(AnimGraphStateMachineNode);
                    var rootCtx = surface.RootContext;
                    if (rootCtx == null)
                        throw new McpProtocolException("INVALID_STATE", "The graph root context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                    machine = rootCtx.SpawnNode(AnimGraphGroup, AnimGraphStateMachineNode, new Float2(140.0f, 80.0f), machineValues, null);
                    if (machine == null)
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not spawn the state machine node.");
                    machineCreated = true;
                    warnings.Add("Created the missing state machine container node with archetype defaults.");
                }
                var machineCtx = surface.OpenContext(new Span<uint>(new uint[] { machine.ID }));
                if (machineCtx == null)
                    throw new McpProtocolException("INVALID_STATE", "The state machine context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                if (FindAnimgraphState(machineCtx, request.Name) != null)
                    throw new McpProtocolException("VALIDATION_FAILED", "A state with this name already exists in the state machine.");
                var stateCount = CountAnimgraphStates(machineCtx);
                var pos = new Float2(request.X ?? (300.0f + stateCount * 200.0f), request.Y ?? 140.0f);
                if (request.DryRun)
                {
                    return new McpGraphAddStateResult
                    {
                        Asset = AssetMetadata(record),
                        State = new McpGraphNodeDto { Id = 0, GroupID = AnimGraphGroup, TypeID = AnimGraphStateNode, Title = TruncateGraphText(request.Name, 256), X = pos.X, Y = pos.Y },
                        Machine = AnimgraphNodeDto(machine),
                        MachineCreated = machineCreated,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: no state was created and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph state adds require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                var values = CloneAnimgraphDefaults(AnimGraphStateNode);
                if (values.Length == 0 || !(values[0] is string))
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The state node archetype does not carry a name value in this version.", new { GroupID = AnimGraphGroup, TypeID = AnimGraphStateNode });
                values[0] = request.Name;
                var state = machineCtx.SpawnNode(AnimGraphGroup, AnimGraphStateNode, pos, values, null);
                if (state == null)
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not spawn the state node.");
                try { machineCtx.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph context MarkAsModified notification failed: " + ex.Message); }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphAddStateResult
                {
                    Asset = AssetMetadata(record),
                    State = AnimgraphNodeDto(state),
                    Machine = AnimgraphNodeDto(machine),
                    MachineCreated = machineCreated,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        private McpGraphAddTransitionResult AddAnimgraphTransition(McpGraphAddTransitionRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph add-transition parameters are required.");
            if (string.IsNullOrWhiteSpace(request.FromState) || request.FromState.Length > 256)
                throw new McpProtocolException("INVALID_REQUEST", "FromState must be between 1 and 256 characters.");
            if (string.IsNullOrWhiteSpace(request.ToState) || request.ToState.Length > 256)
                throw new McpProtocolException("INVALID_REQUEST", "ToState must be between 1 and 256 characters.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            EnsureAnimgraphAsset(record);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                EnsureAnimgraphNodeUsable(surface, AnimGraphStateNode);
                var machine = FindRootAnimgraphNode(surface, AnimGraphStateMachineNode);
                if (machine == null)
                    throw new McpProtocolException("NOT_FOUND", "The graph has no state machine node. Add a state first (it creates the container).");
                var machineCtx = surface.OpenContext(new Span<uint>(new uint[] { machine.ID }));
                if (machineCtx == null)
                    throw new McpProtocolException("INVALID_STATE", "The state machine context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                var src = FindAnimgraphState(machineCtx, request.FromState);
                if (src == null)
                    throw new McpProtocolException("NOT_FOUND", "The source state was not found in the state machine.");
                var dst = FindAnimgraphState(machineCtx, request.ToState);
                if (dst == null)
                    throw new McpProtocolException("NOT_FOUND", "The destination state was not found in the state machine.");
                ushort dstType = 0;
                try { dstType = dst.Archetype == null ? (ushort)0 : dst.Archetype.TypeID; } catch { dstType = 0; }
                if (dstType != AnimGraphStateNode)
                    throw new McpProtocolException("VALIDATION_FAILED", "Transition destinations must be State nodes.", new { GroupID = AnimGraphGroup, TypeID = dstType });
                var srcInst = src as IConnectionInstigator;
                var dstInst = dst as IConnectionInstigator;
                if (srcInst == null || dstInst == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The state nodes do not expose the public transition path in this version.");
                if (request.DryRun)
                {
                    bool wouldConnect = false;
                    try { wouldConnect = srcInst.CanConnectWith(dstInst); } catch { wouldConnect = false; }
                    return new McpGraphAddTransitionResult
                    {
                        Asset = AssetMetadata(record),
                        FromState = request.FromState,
                        FromId = src.ID,
                        ToState = request.ToState,
                        ToId = dst.ID,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { wouldConnect ? "Dry-run preview only: the transition was not created and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." : "Dry-run preview: the states cannot be connected (already connected or incompatible). Confirm would fail closed." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph transition adds require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                bool canConnect = false;
                try { canConnect = srcInst.CanConnectWith(dstInst); } catch { canConnect = false; }
                if (!canConnect)
                    throw new McpProtocolException("VALIDATION_FAILED", "The states cannot be connected (already connected or incompatible).");
                srcInst.Connect(dstInst);
                try { machineCtx.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph context MarkAsModified notification failed: " + ex.Message); }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone. The transition uses default rule data (Enabled, no rule graph), same as an editor drop-connect.");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphAddTransitionResult
                {
                    Asset = AssetMetadata(record),
                    FromState = request.FromState,
                    FromId = src.ID,
                    ToState = request.ToState,
                    ToId = dst.ID,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        // Bridge v34: animgraph.set_transition.
        // USER-APPROVED EXCEPTION to the "public Editor API only" rule: state
        // machine transitions have no public surface, so they are reached by
        // reflection on the Editor's internal members (live-verified, WP-F):
        //   FlaxEditor.Surface.Archetypes.Animation+StateMachineStateBase.Transitions (field, List)
        //   FlaxEditor.Surface.Archetypes.Animation+StateMachineTransition.DestinationState (field)
        //   ...+StateMachineTransition properties BlendDuration, BlendMode, Enabled, Solo,
        //   UseDefaultRule, Interruption (+ Order when present) and the nested InterruptionFlags enum.
        // Every member is checked at runtime (UNSUPPORTED_FLAX_VERSION naming the
        // missing member). The bridge NEVER encodes the transition byte blob: the
        // property setters call SaveTransitions(withUndo:true) themselves, so one
        // write is one Editor undo entry, then AssetEditorWindow.Save() persists it.
        private const int AnimTransitionOrderLimit = 1000000;
        private static readonly string[] AnimTransitionInterruptionNames = { "RuleRechecking", "Instant", "SourceState", "DestinationState" };

        private sealed class AnimTransitionMembers
        {
            public FieldInfo Transitions;
            public FieldInfo Destination;
            public PropertyInfo BlendDuration;
            public PropertyInfo BlendMode;
            public PropertyInfo Enabled;
            public PropertyInfo Solo;
            public PropertyInfo UseDefaultRule;
            public PropertyInfo Interruption;
            public PropertyInfo Order;
            public Type StateBase;
        }

        private static McpProtocolException AnimTransitionMissing(string member)
        {
            return new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The Flax Editor does not expose the internal member '" + member + "' in this version, so animgraph.set_transition cannot reach state-machine transitions.", new { Member = member, BridgeVersion = BridgeVersion });
        }

        private static PropertyInfo RequireAnimTransitionProperty(Type transition, string name, Func<Type, bool> typeOk, bool optional)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            PropertyInfo property = null;
            try { property = transition.GetProperty(name, flags); } catch (AmbiguousMatchException) { property = null; }
            if (property == null || property.GetMethod == null || property.SetMethod == null || !typeOk(property.PropertyType))
            {
                if (optional) return null;
                throw AnimTransitionMissing("Animation+StateMachineTransition." + name);
            }
            return property;
        }

        private static AnimTransitionMembers ResolveAnimTransitionMembers()
        {
            const BindingFlags nested = BindingFlags.Public | BindingFlags.NonPublic;
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var anim = typeof(FlaxEditor.Surface.Archetypes.Animation);
            var members = new AnimTransitionMembers();
            members.StateBase = anim.GetNestedType("StateMachineStateBase", nested);
            if (members.StateBase == null) throw AnimTransitionMissing("Animation+StateMachineStateBase");
            var transition = anim.GetNestedType("StateMachineTransition", nested);
            if (transition == null) throw AnimTransitionMissing("Animation+StateMachineTransition");
            members.Transitions = members.StateBase.GetField("Transitions", flags);
            if (members.Transitions == null || !typeof(System.Collections.IList).IsAssignableFrom(members.Transitions.FieldType))
                throw AnimTransitionMissing("Animation+StateMachineStateBase.Transitions");
            members.Destination = transition.GetField("DestinationState", flags);
            if (members.Destination == null || !typeof(SurfaceNode).IsAssignableFrom(members.Destination.FieldType))
                throw AnimTransitionMissing("Animation+StateMachineTransition.DestinationState");
            members.BlendDuration = RequireAnimTransitionProperty(transition, "BlendDuration", t => t == typeof(float), false);
            members.BlendMode = RequireAnimTransitionProperty(transition, "BlendMode", t => t.IsEnum, false);
            members.Enabled = RequireAnimTransitionProperty(transition, "Enabled", t => t == typeof(bool), false);
            members.Solo = RequireAnimTransitionProperty(transition, "Solo", t => t == typeof(bool), false);
            members.UseDefaultRule = RequireAnimTransitionProperty(transition, "UseDefaultRule", t => t == typeof(bool), false);
            members.Interruption = RequireAnimTransitionProperty(transition, "Interruption", t => t.IsEnum, false);
            var flagNames = Enum.GetNames(members.Interruption.PropertyType);
            foreach (var flagName in AnimTransitionInterruptionNames)
                if (Array.IndexOf(flagNames, flagName) < 0) throw AnimTransitionMissing("Animation+StateMachineTransition+InterruptionFlags." + flagName);
            // Order is the one optional member: a build without it refuses the field only.
            members.Order = RequireAnimTransitionProperty(transition, "Order", t => t == typeof(int), true);
            return members;
        }

        private static string[] AnimTransitionInterruptionList(Type enumType, object value)
        {
            var bits = EnumBits(enumType, value);
            var names = new List<KeyValuePair<ulong, string>>();
            foreach (var name in AnimTransitionInterruptionNames)
                names.Add(new KeyValuePair<ulong, string>(EnumBits(enumType, Enum.Parse(enumType, name)), name));
            names.Sort((a, b) => a.Key.CompareTo(b.Key));
            var result = new List<string>();
            foreach (var pair in names) if (pair.Key != 0 && (bits & pair.Key) == pair.Key) result.Add(pair.Value);
            return result.ToArray();
        }

        private static McpAnimgraphTransitionSettings ReadAnimTransitionSettings(AnimTransitionMembers m, object transition)
        {
            return new McpAnimgraphTransitionSettings
            {
                BlendDuration = (float)m.BlendDuration.GetValue(transition),
                BlendMode = m.BlendMode.GetValue(transition).ToString(),
                Enabled = (bool)m.Enabled.GetValue(transition),
                Solo = (bool)m.Solo.GetValue(transition),
                UseDefaultRule = (bool)m.UseDefaultRule.GetValue(transition),
                Interruption = AnimTransitionInterruptionList(m.Interruption.PropertyType, m.Interruption.GetValue(transition)),
                Order = m.Order == null ? 0 : (int)m.Order.GetValue(transition),
            };
        }

        private static bool SameAnimTransitionSettings(McpAnimgraphTransitionSettings a, McpAnimgraphTransitionSettings b)
        {
            return a.BlendDuration.Equals(b.BlendDuration) && string.Equals(a.BlendMode, b.BlendMode, StringComparison.Ordinal)
                && a.Enabled == b.Enabled && a.Solo == b.Solo && a.UseDefaultRule == b.UseDefaultRule && a.Order == b.Order
                && string.Join(",", a.Interruption ?? new string[0]) == string.Join(",", b.Interruption ?? new string[0]);
        }

        private static uint ParseAnimgraphNodeId(string text, string field, bool required)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                if (required) throw new McpProtocolException("VALIDATION_FAILED", field + " is required (decimal graph node id).");
                return 0;
            }
            uint id;
            if (!uint.TryParse(text.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out id) || id == 0)
                throw new McpProtocolException("VALIDATION_FAILED", field + " must be a decimal graph node id.", new { Field = field });
            return id;
        }

        private static SurfaceNode FindAnimgraphNodeById(VisjectSurfaceContext context, uint id)
        {
            if (context == null || context.Nodes == null) return null;
            foreach (var node in context.Nodes)
            {
                if (node == null) continue;
                uint nodeId = 0;
                try { nodeId = node.ID; } catch { continue; }
                if (nodeId == id) return node;
            }
            return null;
        }

        private static void NavigateGraphToRoot(VisjectSurface surface, List<string> warnings)
        {
            try { surface.OpenContext(new Span<uint>(new uint[0])); }
            catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
        }

        private McpAnimgraphSetTransitionResult SetAnimgraphTransition(McpAnimgraphSetTransition request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Animgraph set-transition parameters are required.");
            var fromId = ParseAnimgraphNodeId(request.FromStateNodeId, "FromStateNodeId", true);
            var toId = ParseAnimgraphNodeId(request.ToStateNodeId, "ToStateNodeId", true);
            var machineId = ParseAnimgraphNodeId(request.StateMachineNodeId, "StateMachineNodeId", false);
            if (!request.BlendDuration.HasValue && string.IsNullOrWhiteSpace(request.BlendMode) && !request.Enabled.HasValue && !request.Solo.HasValue
                && !request.UseDefaultRule.HasValue && request.Interruption == null && !request.Order.HasValue)
                throw new McpProtocolException("VALIDATION_FAILED", "At least one transition setting is required: BlendDuration, BlendMode, Enabled, Solo, UseDefaultRule, Interruption, or Order.");
            if (request.BlendDuration.HasValue && (!float.IsFinite(request.BlendDuration.Value) || request.BlendDuration.Value < 0.0f || request.BlendDuration.Value > 20.0f))
                throw new McpProtocolException("VALIDATION_FAILED", "BlendDuration must be a finite number of seconds between 0 and 20.");
            if (request.Order.HasValue && (request.Order.Value < -AnimTransitionOrderLimit || request.Order.Value > AnimTransitionOrderLimit))
                throw new McpProtocolException("VALIDATION_FAILED", "Order must be between -" + AnimTransitionOrderLimit.ToString(CultureInfo.InvariantCulture) + " and " + AnimTransitionOrderLimit.ToString(CultureInfo.InvariantCulture) + ".");
            if (request.Interruption != null && request.Interruption.Length > 8)
                throw new McpProtocolException("VALIDATION_FAILED", "Interruption lists at most 8 flags.");
            EnsureGraphEditorReady(true);
            var members = ResolveAnimTransitionMembers();
            if (request.Order.HasValue && members.Order == null)
                throw new McpProtocolException("VALIDATION_FAILED", "This Flax Editor build has no transition 'Order' member; the Order field cannot be set.", new { Field = "Order" });
            // Requested values, validated against the runtime enums before any window is touched.
            object blendMode = null;
            if (!string.IsNullOrWhiteSpace(request.BlendMode))
            {
                var wanted = request.BlendMode.Trim();
                foreach (var name in Enum.GetNames(members.BlendMode.PropertyType))
                    if (string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase)) blendMode = Enum.Parse(members.BlendMode.PropertyType, name);
                if (blendMode == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "BlendMode must be one of: " + string.Join(", ", Enum.GetNames(members.BlendMode.PropertyType)) + ".", new { Field = "BlendMode" });
            }
            object interruption = null;
            if (request.Interruption != null)
            {
                ulong bits = 0;
                foreach (var entry in request.Interruption)
                {
                    var wanted = entry == null ? "" : entry.Trim();
                    string match = null;
                    foreach (var name in AnimTransitionInterruptionNames) if (string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase)) match = name;
                    if (match == null)
                        throw new McpProtocolException("VALIDATION_FAILED", "Interruption entries must be among: " + string.Join(", ", AnimTransitionInterruptionNames) + ".", new { Field = "Interruption" });
                    bits |= EnumBits(members.Interruption.PropertyType, Enum.Parse(members.Interruption.PropertyType, match));
                }
                interruption = Enum.ToObject(members.Interruption.PropertyType, bits);
            }
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            EnsureAnimgraphAsset(record);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            var navigatedBack = false;
            try
            {
                EnsureAnimgraphNodeUsable(surface, AnimGraphStateNode);
                SurfaceNode machine;
                if (machineId != 0)
                {
                    machine = FindRootGraphNodeById(surface, machineId);
                    if (machine != null)
                    {
                        ushort mg = 0;
                        ushort mt = 0;
                        try { mg = machine.GroupArchetype == null ? (ushort)0 : machine.GroupArchetype.GroupID; } catch { mg = 0; }
                        try { mt = machine.Archetype == null ? (ushort)0 : machine.Archetype.TypeID; } catch { mt = 0; }
                        if (mg != AnimGraphGroup || mt != AnimGraphStateMachineNode)
                            throw new McpProtocolException("VALIDATION_FAILED", "StateMachineNodeId does not name a State Machine node.", new { GroupID = mg, TypeID = mt });
                    }
                }
                else machine = FindRootAnimgraphNode(surface, AnimGraphStateMachineNode);
                if (machine == null)
                    throw new McpProtocolException("NOT_FOUND", "The graph has no such state machine node.");
                var machineCtx = surface.OpenContext(new Span<uint>(new uint[] { machine.ID }));
                if (machineCtx == null)
                    throw new McpProtocolException("INVALID_STATE", "The state machine context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                var fromNode = FindAnimgraphNodeById(machineCtx, fromId);
                if (fromNode == null)
                    throw new McpProtocolException("NOT_FOUND", "The source state node was not found in the state machine.");
                var toNode = FindAnimgraphNodeById(machineCtx, toId);
                if (toNode == null)
                    throw new McpProtocolException("NOT_FOUND", "The destination state node was not found in the state machine.");
                if (!members.StateBase.IsInstanceOfType(fromNode))
                    throw new McpProtocolException("VALIDATION_FAILED", "FromStateNodeId must name a State or Any State node.");
                object transition = null;
                var list = members.Transitions.GetValue(fromNode) as System.Collections.IList;
                if (list != null)
                {
                    foreach (var candidate in list)
                    {
                        if (candidate == null) continue;
                        var destination = members.Destination.GetValue(candidate) as SurfaceNode;
                        if (destination != null && destination.ID == toId) { transition = candidate; break; }
                    }
                }
                if (transition == null)
                    throw new McpProtocolException("NOT_FOUND", "No transition connects the source state to the destination state. Create it with animgraph_add_transition first.");
                var before = ReadAnimTransitionSettings(members, transition);
                var plan = new McpAnimgraphTransitionSettings
                {
                    BlendDuration = request.BlendDuration ?? before.BlendDuration,
                    BlendMode = blendMode == null ? before.BlendMode : blendMode.ToString(),
                    Enabled = request.Enabled ?? before.Enabled,
                    Solo = request.Solo ?? before.Solo,
                    UseDefaultRule = request.UseDefaultRule ?? before.UseDefaultRule,
                    Interruption = interruption == null ? before.Interruption : AnimTransitionInterruptionList(members.Interruption.PropertyType, interruption),
                    Order = request.Order ?? before.Order,
                };
                var wouldChange = !SameAnimTransitionSettings(before, plan);
                var machineText = machine.ID.ToString(CultureInfo.InvariantCulture);
                var fromText = fromNode.ID.ToString(CultureInfo.InvariantCulture);
                var toText = toNode.ID.ToString(CultureInfo.InvariantCulture);
                var assetText = record.Id.ToString("N");
                if (request.DryRun || !wouldChange)
                {
                    if (!openedByBridge) { NavigateGraphToRoot(surface, warnings); navigatedBack = true; }
                    warnings.Add(request.DryRun
                        ? "Dry-run preview only: the transition was not changed and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()."
                        : "The transition already has the requested settings; nothing was written or saved.");
                    return new McpAnimgraphSetTransitionResult
                    {
                        AssetId = assetText, StateMachineNodeId = machineText, FromStateNodeId = fromText, ToStateNodeId = toText,
                        Before = before, After = plan, DryRun = request.DryRun, WouldChange = wouldChange, Saved = false,
                        ProjectRevision = _projectRevision, Warnings = warnings.ToArray(),
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Transition changes require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                // Setters (not byte encoding): each calls SaveTransitions(withUndo:true).
                // Order last because its setter re-sorts the transition list.
                var applied = new List<KeyValuePair<PropertyInfo, object>>();
                try
                {
                    if (request.BlendDuration.HasValue && !before.BlendDuration.Equals(plan.BlendDuration)) SetAnimTransitionProperty(applied, members.BlendDuration, transition, plan.BlendDuration);
                    if (blendMode != null && !string.Equals(before.BlendMode, plan.BlendMode, StringComparison.Ordinal)) SetAnimTransitionProperty(applied, members.BlendMode, transition, blendMode);
                    if (request.Enabled.HasValue && before.Enabled != plan.Enabled) SetAnimTransitionProperty(applied, members.Enabled, transition, plan.Enabled);
                    if (request.Solo.HasValue && before.Solo != plan.Solo) SetAnimTransitionProperty(applied, members.Solo, transition, plan.Solo);
                    if (request.UseDefaultRule.HasValue && before.UseDefaultRule != plan.UseDefaultRule) SetAnimTransitionProperty(applied, members.UseDefaultRule, transition, plan.UseDefaultRule);
                    if (interruption != null && string.Join(",", before.Interruption) != string.Join(",", plan.Interruption)) SetAnimTransitionProperty(applied, members.Interruption, transition, interruption);
                    if (request.Order.HasValue && members.Order != null && before.Order != plan.Order) SetAnimTransitionProperty(applied, members.Order, transition, plan.Order);
                }
                catch (Exception ex)
                {
                    for (var i = applied.Count - 1; i >= 0; i--)
                    {
                        try { applied[i].Key.SetValue(transition, applied[i].Value); } catch { }
                    }
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor rejected the transition change; applied fields were reverted and nothing was saved: " + DescribeException(ex));
                }
                var after = ReadAnimTransitionSettings(members, transition);
                try { machineCtx.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph context MarkAsModified notification failed: " + ex.Message); }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge) { NavigateGraphToRoot(surface, warnings); navigatedBack = true; }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the Editor's own transition property setters (one undo entry) and AssetEditorWindow.Save(). SaveToOriginal cannot be undone. The setters are reached by reflection on internal Editor members (user-approved exception).");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpAnimgraphSetTransitionResult
                {
                    AssetId = assetText, StateMachineNodeId = machineText, FromStateNodeId = fromText, ToStateNodeId = toText,
                    Before = before, After = after, DryRun = false, WouldChange = true, Saved = true,
                    ProjectRevision = revision, Warnings = warnings.ToArray(),
                };
            }
            finally
            {
                if (!openedByBridge && !navigatedBack) { try { surface.OpenContext(new Span<uint>(new uint[0])); } catch { } }
                ReleaseGraphWindow(item, openedByBridge, record.Id);
            }
        }

        private static void SetAnimTransitionProperty(List<KeyValuePair<PropertyInfo, object>> applied, PropertyInfo property, object transition, object value)
        {
            var previous = property.GetValue(transition);
            property.SetValue(transition, value);
            applied.Add(new KeyValuePair<PropertyInfo, object>(property, previous));
        }

        // Bridge v18 Phase 5ab: bounded graph removal (remove_node + disconnect).
        // Cecil-verified on FlaxEngine.CSharp.dll 1.12 local, no new hardcoded
        // archetype IDs or layouts:
        // - VisjectSurface.Delete(IEnumerable<SurfaceControl>, bool withUndo) is
        //   public and undo-aware (reads NodeArchetype.Flags, pushes
        //   AddRemoveNodeAction + EditNodeConnections via AddBatchedUndoAction
        //   when withUndo:true), so remove_node IS undoable via graph.undo.
        //   The engine itself skips NoRemove nodes (e.g. the (9,1) Animation
        //   Output, Flags=613); the bridge still fails closed when the node
        //   survives Delete and pre-refuses runtime-read NoRemove flags, so no
        //   output node of any in-scope asset type can be deleted by ID guess.
        // - Box.BreakConnection(Box) / Box.RemoveConnections(int) are public
        //   but push NO undo action and do NOT mark edited (IL: List.Remove +
        //   OnNodesDisconnected only), so disconnect is NOT undoable — same
        //   warning class as SaveToOriginal. The bridge marks modified/edited
        //   itself before Window.Save().
        // - SurfaceNode.Type is a packed (GroupID << 16) | TypeID UInt32;
        //   decoded at runtime for DTOs only. Boxes resolve by scanning
        //   TryGetBox(0..64) matching Box.ID, mirroring graph.inspect.
        // Scope: root context only (sub-contexts are Phase 6a, untouched).
        public class McpGraphRemoveNodeRequest { public string AssetId; public string Path; public uint NodeId; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphRemoveNodeResult { public McpAssetMetadata Asset; public McpGraphNodeDto Node; public bool Protected; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }
        public class McpGraphDisconnectRequest { public string AssetId; public string Path; public uint FromNode; public int FromBox; public uint ToNode; public int ToBox; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphDisconnectResult { public McpAssetMetadata Asset; public uint FromNode; public int FromBox; public uint ToNode; public int ToBox; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }

        private static SurfaceNode FindRootGraphNodeById(VisjectSurface surface, uint id)
        {
            var root = surface.RootContext;
            if (root == null || root.Nodes == null)
                throw new McpProtocolException("INVALID_STATE", "The graph root context is not ready. Retry shortly.", null);
            foreach (var node in root.Nodes)
            {
                if (node == null) continue;
                uint nid = 0;
                try { nid = node.ID; } catch { continue; }
                if (nid == id) return node;
            }
            return null;
        }

        private static FlaxEditor.Surface.Elements.Box FindNodeBoxById(SurfaceNode node, int boxId)
        {
            for (var bi = 0; bi < MaxGraphBoxesPerNode; bi++)
            {
                FlaxEditor.Surface.Elements.Box found;
                bool has = false;
                try { has = node.TryGetBox(bi, out found); } catch { has = false; found = null; }
                if (!has || found == null) continue;
                int bid = -1;
                try { bid = found.ID; } catch { bid = -1; }
                if (bid == boxId) return found;
            }
            return null;
        }

        private static bool GraphBoxesConnected(FlaxEditor.Surface.Elements.Box a, FlaxEditor.Surface.Elements.Box b)
        {
            if (a == null || b == null) return false;
            try { if (a.Connections != null && a.Connections.Contains(b)) return true; } catch { }
            try { if (b.Connections != null && b.Connections.Contains(a)) return true; } catch { }
            return false;
        }

        private McpGraphRemoveNodeResult RemoveGraphNode(McpGraphRemoveNodeRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph remove-node parameters are required.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                var root = surface.RootContext;
                if (root == null || root.Nodes == null)
                    throw new McpProtocolException("INVALID_STATE", "The graph root context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                var node = FindRootGraphNodeById(surface, request.NodeId);
                if (node == null)
                    throw new McpProtocolException("NOT_FOUND", "No node with this ID exists in the graph root context.");
                bool noRemove = false;
                try { noRemove = node.Archetype != null && (node.Archetype.Flags & NodeFlags.NoRemove) != 0; } catch { noRemove = false; }
                var dto = AnimgraphNodeDto(node);
                if (noRemove)
                    throw new McpProtocolException("VALIDATION_FAILED", "The node is engine-protected (NoRemove), e.g. a graph output node, and cannot be deleted.");
                var rootCount = 0;
                foreach (var n in root.Nodes) if (n != null) rootCount++;
                if (rootCount <= 1)
                    throw new McpProtocolException("VALIDATION_FAILED", "Refusing to delete the only node of the graph root context (the asset would be left without an output).");
                if (request.DryRun)
                {
                    return new McpGraphRemoveNodeResult
                    {
                        Asset = AssetMetadata(record),
                        Node = dto,
                        Protected = false,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: the node was not deleted and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph node removals require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                try { surface.Delete(new SurfaceControl[] { node }, true); }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not delete the node: " + ex.Message); }
                if (FindRootGraphNodeById(surface, request.NodeId) != null)
                    throw new McpProtocolException("VALIDATION_FAILED", "The editor refused to delete the node (engine-protected). Nothing was saved.");
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("The removal pushed a window undo action: graph.undo restores the node while the window undo stack retains it (reused windows only; bridge-opened windows are closed after saving).");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphRemoveNodeResult
                {
                    Asset = AssetMetadata(record),
                    Node = dto,
                    Protected = false,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        private McpGraphDisconnectResult DisconnectGraphBoxes(McpGraphDisconnectRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph disconnect parameters are required.");
            if (request.FromBox < 0 || request.ToBox < 0)
                throw new McpProtocolException("INVALID_REQUEST", "Box IDs must be non-negative (use graph.inspect include_boxes to list them).");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                var fromNode = FindRootGraphNodeById(surface, request.FromNode);
                if (fromNode == null)
                    throw new McpProtocolException("NOT_FOUND", "The source node was not found in the graph root context.");
                var toNode = FindRootGraphNodeById(surface, request.ToNode);
                if (toNode == null)
                    throw new McpProtocolException("NOT_FOUND", "The destination node was not found in the graph root context.");
                var fromBox = FindNodeBoxById(fromNode, request.FromBox);
                if (fromBox == null)
                    throw new McpProtocolException("NOT_FOUND", "The source box was not found on the source node.");
                var toBox = FindNodeBoxById(toNode, request.ToBox);
                if (toBox == null)
                    throw new McpProtocolException("NOT_FOUND", "The destination box was not found on the destination node.");
                bool fromOut = false;
                bool toOut = false;
                try { fromOut = fromBox.IsOutput; } catch { fromOut = false; }
                try { toOut = toBox.IsOutput; } catch { toOut = false; }
                if (fromOut == toOut)
                    throw new McpProtocolException("VALIDATION_FAILED", "Wires run output-to-input: one endpoint must be an output box and the other an input box.");
                if (!GraphBoxesConnected(fromBox, toBox))
                    throw new McpProtocolException("VALIDATION_FAILED", "The boxes are not connected (idempotent no-op refused).");
                if (request.DryRun)
                {
                    return new McpGraphDisconnectResult
                    {
                        Asset = AssetMetadata(record),
                        FromNode = request.FromNode,
                        FromBox = request.FromBox,
                        ToNode = request.ToNode,
                        ToBox = request.ToBox,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: the wire was not broken and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph disconnects require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                Exception breakError = null;
                try { fromBox.BreakConnection(toBox); }
                catch (Exception ex) { breakError = ex; }
                if (GraphBoxesConnected(fromBox, toBox))
                {
                    try { toBox.BreakConnection(fromBox); }
                    catch (Exception ex) { if (breakError == null) breakError = ex; }
                }
                if (GraphBoxesConnected(fromBox, toBox))
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not break the wire." + (breakError == null ? "" : " Detail: " + breakError.Message));
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("Box.BreakConnection pushes no undo action (Cecil-verified): graph.undo cannot restore this wire. Re-wire it in the editor or re-run the matching add path.");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphDisconnectResult
                {
                    Asset = AssetMetadata(record),
                    FromNode = request.FromNode,
                    FromBox = request.FromBox,
                    ToNode = request.ToNode,
                    ToBox = request.ToBox,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        // Bridge v20 Phase 6: clip wiring + node values + move.
        // Cecil-verified on FlaxEngine.CSharp.dll 1.12 local + runtime-observed:
        // - Box.CreateConnection pushes NO undo action -> created wires are NOT
        //   undoable (same warning class as disconnect). Verified both
        //   directions before saving, fail-closed otherwise.
        // - SurfaceNode.SetValue/SetValues push EditNodeValuesAction ->
        //   set_node_values IS window-undoable (corrects the old plan note).
        // - Control.Location set pushes NO undo -> move warns.
        // - Sampler (9,2) "Animation": Flags=64, DefaultValues=[Guid.Empty(clip),
        //   float 1 (speed), bool true (loop), float 0 (start)] (live-verified on
        //   Flax 1.12, bridge v34; earlier notes said [null, float, int, float]);
        //   outputs Pose, Normalized Time, Time.
        //   Slot 0 is the clip (shape-inferred + runtime-verified: re-read
        //   must project asset_id == clip). Asset refs in Values are Guid.
        // - State Output (9,21) carries the Pose input; boxes resolve at
        //   runtime (sampler: box 0 preferred else first output; state-output:
        //   first input). No hardcoded box IDs, no hardcoded value arrays.
        private const ushort AnimGraphSamplerNode = 2;
        private const ushort AnimGraphStateOutputNode = 21;

        public class McpGraphNodeValueEntry { public int Index; public McpMaterialTypedValue Value; }
        public class McpGraphSetNodeValuesRequest { public string AssetId; public string Path; public uint NodeId; public McpGraphNodeValueEntry[] Values; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphSetNodeValuesResult { public McpAssetMetadata Asset; public McpGraphNodeDto Node; public int[] UpdatedIndexes; public McpMaterialTypedValue[] Previous; public McpMaterialTypedValue[] Updated; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }
        public class McpGraphMoveNodeRequest { public string AssetId; public string Path; public uint NodeId; public float X; public float Y; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphMoveNodeResult { public McpAssetMetadata Asset; public McpGraphNodeDto Node; public float PreviousX; public float PreviousY; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }
        public class McpGraphSetStateClipRequest { public string AssetId; public string Path; public string State; public string ClipAssetId; public string ClipPath; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphSetStateClipResult { public McpAssetMetadata Asset; public string State; public uint StateId; public McpGraphNodeDto Sampler; public bool SamplerCreated; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }

        private static Type GraphNodeSlotType(SurfaceNode node, int index)
        {
            object[] vals = null;
            try { vals = node.Values; } catch { vals = null; }
            if (vals != null && index >= 0 && index < vals.Length && vals[index] != null)
            {
                try { return vals[index].GetType(); } catch { }
            }
            GroupArchetype groupArch;
            NodeArchetype nodeArch;
            try
            {
                ushort g = 0;
                ushort t = 0;
                try { g = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { g = 0; }
                try { t = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { t = 0; }
                if (NodeFactory.GetArchetype(NodeFactory.DefaultGroups, g, t, out groupArch, out nodeArch) && nodeArch != null && nodeArch.DefaultValues != null && index >= 0 && index < nodeArch.DefaultValues.Length && nodeArch.DefaultValues[index] != null)
                {
                    try { return nodeArch.DefaultValues[index].GetType(); } catch { }
                }
            }
            catch { }
            return null;
        }

        private static object CoerceGraphNodeValue(McpMaterialTypedValue value, Type targetType, int index)
        {
            if (value == null || string.IsNullOrEmpty(value.Kind))
                throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " requires a Kind.");
            var kind = value.Kind;
            if (kind == "boolean")
            {
                if (!value.Boolean.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares boolean without a payload.");
                if (targetType != null && targetType != typeof(bool)) throw new McpProtocolException("VALIDATION_FAILED", "Value entry " + index + " is boolean but the slot is not.");
                return value.Boolean.Value;
            }
            if (kind == "integer")
            {
                if (!value.Integer.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares integer without a payload.");
                return CoerceGraphParameterValue((float)value.Integer.Value, targetType ?? typeof(int), "integer");
            }
            if (kind == "number")
            {
                if (!value.Number.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares number without a payload.");
                return CoerceGraphParameterValue((float)value.Number.Value, targetType ?? typeof(float), "number");
            }
            if (kind == "string")
            {
                if (value.Text == null) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares string without a payload.");
                if (targetType != null && targetType != typeof(string)) throw new McpProtocolException("VALIDATION_FAILED", "Value entry " + index + " is string but the slot is not.");
                return value.Text;
            }
            if (kind == "vector2" || kind == "vector3" || kind == "vector4")
            {
                Float4 v4 = new Float4(0, 0, 0, 0);
                if (kind == "vector2")
                {
                    if (value.Vector2 == null) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares vector2 without a payload.");
                    v4 = new Float4(value.Vector2.X, value.Vector2.Y, 0, 0);
                    if (targetType == null || targetType == typeof(Float2)) return new Float2(v4.X, v4.Y);
                }
                else if (kind == "vector3")
                {
                    if (value.Vector3 == null) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares vector3 without a payload.");
                    v4 = new Float4(value.Vector3.X, value.Vector3.Y, value.Vector3.Z, 0);
                    if (targetType == null || targetType == typeof(Float3)) return new Float3(v4.X, v4.Y, v4.Z);
                }
                else
                {
                    if (value.Vector4 == null) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares vector4 without a payload.");
                    v4 = new Float4(value.Vector4.X, value.Vector4.Y, value.Vector4.Z, value.Vector4.W);
                    if (targetType == null || targetType == typeof(Float4)) return v4;
                }
                if (targetType == typeof(Color) && kind == "vector4") return new Color(v4.X, v4.Y, v4.Z, v4.W);
                throw new McpProtocolException("VALIDATION_FAILED", "Value entry " + index + " shape does not match the slot type.");
            }
            if (kind == "color")
            {
                if (value.Vector4 == null) throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares color without a payload.");
                if (targetType != null && targetType != typeof(Color)) throw new McpProtocolException("VALIDATION_FAILED", "Value entry " + index + " is color but the slot is not.");
                return new Color(value.Vector4.X, value.Vector4.Y, value.Vector4.Z, value.Vector4.W);
            }
            if (kind == "asset_id")
            {
                if (string.IsNullOrEmpty(value.AssetId) || !IsGuidN(value.AssetId))
                    throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " declares asset_id without a valid 32-hex asset ID.");
                if (targetType != null && targetType != typeof(Guid) && targetType != typeof(Asset))
                    throw new McpProtocolException("VALIDATION_FAILED", "Value entry " + index + " is an asset reference but the slot is not.");
                Guid guid;
                try { guid = Guid.ParseExact(value.AssetId, "N"); }
                catch { throw new McpProtocolException("INVALID_REQUEST", "Value entry " + index + " has an unparsable asset ID."); }
                var exists = BuildAssetRegistry();
                var found = false;
                foreach (var r in exists) { if (r != null && r.Id == guid) { found = true; break; } }
                if (!found) throw new McpProtocolException("NOT_FOUND", "Value entry " + index + " references an asset that is not in the project registry.");
                return guid;
            }
            throw new McpProtocolException("VALIDATION_FAILED", "Value entry " + index + " uses unsupported kind '" + kind + "'.");
        }

        private static SurfaceNode FindAnimgraphTypedNode(VisjectSurfaceContext ctx, ushort typeId)
        {
            if (ctx == null || ctx.Nodes == null) return null;
            foreach (var node in ctx.Nodes)
            {
                if (node == null) continue;
                ushort g = 0;
                ushort t = 0;
                try { g = node.GroupArchetype == null ? (ushort)0 : node.GroupArchetype.GroupID; } catch { g = 0; }
                try { t = node.Archetype == null ? (ushort)0 : node.Archetype.TypeID; } catch { t = 0; }
                if (g == AnimGraphGroup && t == typeId) return node;
            }
            return null;
        }

        private static FlaxEditor.Surface.Elements.Box FindFirstBox(SurfaceNode node, bool output, int preferId)
        {
            FlaxEditor.Surface.Elements.Box fallback = null;
            for (var bi = 0; bi < MaxGraphBoxesPerNode; bi++)
            {
                FlaxEditor.Surface.Elements.Box found;
                bool has = false;
                try { has = node.TryGetBox(bi, out found); } catch { has = false; found = null; }
                if (!has || found == null) continue;
                bool isOut = false;
                int bid = -1;
                try { isOut = found.IsOutput; } catch { continue; }
                try { bid = found.ID; } catch { bid = -1; }
                if (isOut != output) continue;
                if (bid == preferId) return found;
                if (fallback == null) fallback = found;
            }
            return fallback;
        }

        private McpGraphSetNodeValuesResult SetGraphNodeValues(McpGraphSetNodeValuesRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph set-node-values parameters are required.");
            if (request.Values == null || request.Values.Length == 0 || request.Values.Length > 32)
                throw new McpProtocolException("INVALID_REQUEST", "Provide 1 to 32 value entries.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                var node = FindRootGraphNodeById(surface, request.NodeId);
                if (node == null)
                    throw new McpProtocolException("NOT_FOUND", "No node with this ID exists in the graph root context.");
                object[] current = null;
                try { current = node.Values; } catch { current = null; }
                if (current == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "The node exposes no value array in this version.");
                var seen = new HashSet<int>();
                var coerced = new List<object[]>();
                foreach (var entry in request.Values)
                {
                    if (entry == null || entry.Index < 0 || entry.Index >= current.Length)
                        throw new McpProtocolException("VALIDATION_FAILED", "Value index out of range (0.." + (current.Length - 1) + ").");
                    if (!seen.Add(entry.Index))
                        throw new McpProtocolException("VALIDATION_FAILED", "Duplicate value index " + entry.Index + ".");
                    var target = GraphNodeSlotType(node, entry.Index);
                    coerced.Add(new object[] { entry.Index, CoerceGraphNodeValue(entry.Value, target, entry.Index) });
                }
                var dto = AnimgraphNodeDto(node);
                if (request.DryRun)
                {
                    var prev = new List<McpMaterialTypedValue>();
                    var next = new List<McpMaterialTypedValue>();
                    foreach (var pair in coerced)
                    {
                        var idx = (int)pair[0];
                        McpMaterialTypedValue p;
                        McpMaterialTypedValue n;
                        try { p = SafeMaterialAnimationValue(current[idx]); } catch { p = new McpMaterialTypedValue { Kind = "unavailable" }; }
                        try { n = SafeMaterialAnimationValue(pair[1]); } catch { n = new McpMaterialTypedValue { Kind = "unavailable" }; }
                        prev.Add(p);
                        next.Add(n);
                    }
                    return new McpGraphSetNodeValuesResult
                    {
                        Asset = AssetMetadata(record),
                        Node = dto,
                        UpdatedIndexes = new int[0],
                        Previous = prev.ToArray(),
                        Updated = next.ToArray(),
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: Previous shows current slots, Updated shows coerced values. Nothing was written or saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph value writes require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                var done = new List<int>();
                foreach (var pair in coerced)
                {
                    var idx = (int)pair[0];
                    try { node.SetValue(idx, pair[1], true); }
                    catch (McpProtocolException) { throw; }
                    catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not set value index " + idx + ": " + ex.Message); }
                    done.Add(idx);
                }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("SetValue pushes a window undo action: graph.undo restores previous values while the window undo stack retains it (reused windows only; bridge-opened windows are closed after saving).");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphSetNodeValuesResult
                {
                    Asset = AssetMetadata(record),
                    Node = dto,
                    UpdatedIndexes = done.ToArray(),
                    Previous = new McpMaterialTypedValue[0],
                    Updated = new McpMaterialTypedValue[0],
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        private McpGraphMoveNodeResult MoveGraphNode(McpGraphMoveNodeRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph move-node parameters are required.");
            if (!float.IsFinite(request.X) || !float.IsFinite(request.Y))
                throw new McpProtocolException("INVALID_REQUEST", "Move coordinates must be finite numbers.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                var node = FindRootGraphNodeById(surface, request.NodeId);
                if (node == null)
                    throw new McpProtocolException("NOT_FOUND", "No node with this ID exists in the graph root context.");
                float ox = 0.0f;
                float oy = 0.0f;
                try { ox = node.Location.X; oy = node.Location.Y; } catch { ox = 0.0f; oy = 0.0f; }
                var dto = AnimgraphNodeDto(node);
                if (request.DryRun)
                {
                    return new McpGraphMoveNodeResult
                    {
                        Asset = AssetMetadata(record),
                        Node = dto,
                        PreviousX = ox,
                        PreviousY = oy,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { "Dry-run preview only: the node was not moved and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph node moves require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                try { node.Location = new Float2(request.X, request.Y); }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not move the node: " + ex.Message); }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("Control.Location pushes no undo action (Cecil-verified): graph.undo cannot restore the previous position. Move the node back in the editor if needed.");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphMoveNodeResult
                {
                    Asset = AssetMetadata(record),
                    Node = dto,
                    PreviousX = ox,
                    PreviousY = oy,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        public class McpGraphSetModelRequest { public string AssetId; public string Path; public string ModelAssetId; public string ModelPath; public bool DryRun = true; public bool Confirm; public string IdempotencyKey; public string LeaseId; }
        public class McpGraphSetModelResult { public McpAssetMetadata Asset; public McpAssetMetadata Model; public McpAssetMetadata PreviousModel; public bool AlreadyBound; public bool DryRun; public bool Saved; public bool OpenedByBridge; public long ProjectRevision; public string[] Warnings; }

        // Bridge v21 P7: AnimationGraph BaseModel binding.
        // Cecil-verified on FlaxEngine.CSharp.dll 1.12 (see
        // test/flax-api-smoke/GraphSetModelApiCompileProbe.cs):
        // AnimationGraphWindow.SetBaseModel stores _baseModel + assigns
        // PreviewActor.SkinnedModel and pushes NO undo action — non-undoable
        // like disconnect/move. The read path is the public
        // AnimationGraph.BaseModel. The model selector is validated through
        // the generic asset registry (NOT the graph scope): exactly one
        // ModelAssetId/ModelPath, FlaxEngine.SkinnedModel only, loaded with
        // the same WaitForLoaded + registry/file ID-guard path as actor
        // model binds. Verification is two-phase (behavior-grounded):
        // SetBaseModel stages the model on the window and flushes it to the
        // asset on Save, so the live preview actor (PreviewActor.SkinnedModel)
        // is checked BEFORE saving (refuse to save on mismatch) and
        // AnimationGraph.BaseModel AFTER saving (persistence proof).
        private McpGraphSetModelResult SetGraphBaseModel(McpGraphSetModelRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph set-model parameters are required.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            EnsureAnimgraphAsset(record);
            var modelRecord = ResolveAssetRecord(new McpAssetGet { AssetId = request.ModelAssetId, Path = request.ModelPath }, BuildAssetRegistry());
            if (!string.Equals(modelRecord.Info.TypeName, "FlaxEngine.SkinnedModel", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Set-model targets must be FlaxEngine.SkinnedModel assets.", new { TypeName = modelRecord.Info.TypeName });
            var model = LoadSkinnedModelFromRecord(modelRecord);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                var animWindow = window as FlaxEditor.Windows.Assets.AnimationGraphWindow;
                if (animWindow == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected graph window is not an AnimationGraph editor in this version.", new { Window = window.GetType().FullName });
                var visject = window as IVisjectSurfaceWindow;
                var graph = visject == null ? null : visject.VisjectAsset as AnimationGraph;
                if (graph == null)
                    throw new McpProtocolException("INVALID_STATE", "The AnimationGraph asset is not ready in the editor window. Retry shortly.", GraphNotReadyDetails(record));
                SkinnedModel current = null;
                try { current = graph.BaseModel; } catch { current = null; }
                var alreadyBound = current != null && current.ID == model.ID;
                if (request.DryRun)
                {
                    return new McpGraphSetModelResult
                    {
                        Asset = AssetMetadata(record),
                        Model = AssetMetadata(modelRecord),
                        PreviousModel = AssetMetadataForLoadedAsset(current),
                        AlreadyBound = alreadyBound,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { alreadyBound ? "Dry-run preview only: the graph already binds this model; a write would be refused as an idempotent no-op. Nothing was written or saved." : "Dry-run preview only: the BaseModel was not changed and nothing was saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph set-model requires confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                if (alreadyBound)
                    throw new McpProtocolException("VALIDATION_FAILED", "The graph already binds this model (idempotent no-op refused).");
                try { animWindow.SetBaseModel(model); }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not set the graph BaseModel: " + ex.Message); }
                try
                {
                    AnimatedModel preview = null;
                    try { preview = animWindow.PreviewActor; } catch { preview = null; }
                    // P7 review: distinguish "preview not initialized" (inconclusive —
                    // fail closed WITHOUT claiming the bind is wrong) from a genuine
                    // staged-model mismatch, so callers never read a false negative
                    // as proof the model is incompatible.
                    if (preview == null)
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "The graph preview actor is not initialized, so the BaseModel assignment cannot be verified before save; refusing to save. Open the graph in the editor and retry.", new { Stage = "preview-unavailable" });
                    SkinnedModel staged = null;
                    try { staged = preview.SkinnedModel; } catch { staged = null; }
                    if (staged == null || staged.ID != model.ID)
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "The BaseModel assignment did not apply to the graph preview actor; refusing to save.", new { Stage = "preview-mismatch" });
                }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not verify the BaseModel assignment: " + ex.Message); }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                try
                {
                    SkinnedModel saved = null;
                    try { saved = graph.BaseModel; } catch { saved = null; }
                    if (saved == null || saved.ID != model.ID)
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "The BaseModel assignment did not persist to the graph asset on save.");
                }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not verify the saved BaseModel: " + ex.Message); }
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (AnimationGraphWindow.SetBaseModel + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("AnimationGraphWindow.SetBaseModel pushes no undo action (Cecil-verified): graph.undo cannot restore the previous BaseModel. Re-run set_model with the prior model to revert.");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphSetModelResult
                {
                    Asset = AssetMetadata(record),
                    Model = AssetMetadata(modelRecord),
                    PreviousModel = AssetMetadataForLoadedAsset(current),
                    AlreadyBound = false,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        private McpGraphSetStateClipResult SetAnimgraphStateClip(McpGraphSetStateClipRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph set-state-clip parameters are required.");
            if (string.IsNullOrWhiteSpace(request.State) || request.State.Length > 256)
                throw new McpProtocolException("INVALID_REQUEST", "State must be between 1 and 256 characters.");
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            EnsureAnimgraphAsset(record);
            var clipRecord = ResolveAssetRecord(new McpAssetGet { AssetId = request.ClipAssetId, Path = request.ClipPath }, BuildAssetRegistry());
            if (!string.Equals(clipRecord.Info.TypeName, "FlaxEngine.Animation", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "State clips must be FlaxEngine.Animation assets.", new { TypeName = clipRecord.Info.TypeName });
            Guid clipGuid;
            try { clipGuid = Guid.ParseExact(clipRecord.Id.ToString("N"), "N"); }
            catch { throw new McpProtocolException("ASSET_OPERATION_FAILED", "The clip asset ID is not a usable asset reference."); }
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            try
            {
                EnsureAnimgraphNodeUsable(surface, AnimGraphSamplerNode);
                var machine = FindRootAnimgraphNode(surface, AnimGraphStateMachineNode);
                if (machine == null)
                    throw new McpProtocolException("NOT_FOUND", "The graph has no state machine node. Add a state first (it creates the container).");
                var machineCtx = surface.OpenContext(new Span<uint>(new uint[] { machine.ID }));
                if (machineCtx == null)
                    throw new McpProtocolException("INVALID_STATE", "The state machine context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                var state = FindAnimgraphState(machineCtx, request.State);
                if (state == null)
                    throw new McpProtocolException("NOT_FOUND", "The state was not found in the state machine.");
                var stateCtx = surface.OpenContext(new Span<uint>(new uint[] { machine.ID, state.ID }));
                if (stateCtx == null)
                    throw new McpProtocolException("INVALID_STATE", "The state sub-context is not ready. Retry shortly.", GraphNotReadyDetails(record));
                var sampler = FindAnimgraphTypedNode(stateCtx, AnimGraphSamplerNode);
                var output = FindAnimgraphTypedNode(stateCtx, AnimGraphStateOutputNode);
                if (output == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "The state sub-context has no State Output node; refusing to wire a clip into an unexpected layout.");
                var outBox = output == null ? null : FindFirstBox(output, false, 0);
                if (outBox == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "The State Output node exposes no input box in this version.");
                if (request.DryRun)
                {
                    McpGraphNodeDto samplerDto = null;
                    string currentClip = null;
                    if (sampler != null)
                    {
                        samplerDto = AnimgraphNodeDto(sampler);
                        try
                        {
                            var vals = sampler.Values;
                            if (vals != null && vals.Length >= 1 && vals[0] is Guid)
                                currentClip = ((Guid)vals[0]).ToString("N");
                        }
                        catch { currentClip = null; }
                    }
                    return new McpGraphSetStateClipResult
                    {
                        Asset = AssetMetadata(record),
                        State = request.State,
                        StateId = state.ID,
                        Sampler = samplerDto,
                        SamplerCreated = sampler == null,
                        DryRun = true,
                        Saved = false,
                        OpenedByBridge = openedByBridge,
                        ProjectRevision = _projectRevision,
                        Warnings = new[] { sampler == null ? "Dry-run preview only: a sampler node would be spawned from archetype defaults, slot 0 set to the clip, and Pose wired to State Output. Nothing was created or saved." : "Dry-run preview only: slot 0 currently references " + (currentClip ?? "nothing") + ". Nothing was written or saved. Reissue with dryRun:false + confirm:true to persist via Window.Save()." },
                    };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph clip writes require confirm:true alongside dryRun:false. Saving cannot be undone after Window.Save().");
                var samplerCreated = false;
                if (sampler == null)
                {
                    var values = CloneAnimgraphDefaults(AnimGraphSamplerNode);
                    sampler = stateCtx.SpawnNode(AnimGraphGroup, AnimGraphSamplerNode, new Float2(140.0f, 60.0f), values, null);
                    if (sampler == null)
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not spawn the sampler node.");
                    samplerCreated = true;
                }
                object[] slot = null;
                try { slot = sampler.Values; } catch { slot = null; }
                if (slot == null || slot.Length < 1)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The sampler node exposes no clip slot in this version.");
                var already = slot[0] is Guid && ((Guid)slot[0]).Equals(clipGuid);
                var poseBox = FindFirstBox(sampler, true, 0);
                if (poseBox == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "The sampler node exposes no output box in this version.");
                var wired = GraphBoxesConnected(poseBox, outBox);
                if (already && wired)
                    throw new McpProtocolException("VALIDATION_FAILED", "The state already plays this clip through a wired sampler (idempotent no-op refused).");
                try { sampler.SetValue(0, clipGuid, true); }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not assign the clip: " + ex.Message); }
                try
                {
                    var check = sampler.Values;
                    if (check == null || check.Length < 1 || !(check[0] is Guid) || !((Guid)check[0]).Equals(clipGuid))
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "The clip assignment did not persist on the sampler node; refusing to wire.");
                }
                catch (McpProtocolException) { throw; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not verify the clip assignment: " + ex.Message); }
                if (!GraphBoxesConnected(poseBox, outBox))
                {
                    Exception wireError = null;
                    try { poseBox.CreateConnection(outBox); }
                    catch (Exception ex) { wireError = ex; }
                    if (!GraphBoxesConnected(poseBox, outBox))
                    {
                        try { outBox.CreateConnection(poseBox); }
                        catch (Exception ex) { if (wireError == null) wireError = ex; }
                    }
                    if (!GraphBoxesConnected(poseBox, outBox))
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not wire the sampler to State Output." + (wireError == null ? "" : " Detail: " + wireError.Message));
                }
                try { stateCtx.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph state context MarkAsModified notification failed: " + ex.Message); }
                try { machineCtx.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph machine context MarkAsModified notification failed: " + ex.Message); }
                try { surface.RootContext.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph root MarkAsModified notification failed: " + ex.Message); }
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                if (!openedByBridge)
                {
                    try { surface.OpenContext(new Span<uint>(new uint[0])); }
                    catch (Exception ex) { warnings.Add("Could not navigate the reused window back to the graph root: " + ex.Message); }
                }
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved via the public window path (Window.Surface edit + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("Box.CreateConnection pushes no undo action (Cecil-verified): graph.undo cannot restore the Pose wire. Only the clip value assignment is window-undoable while the stack retains it.");
                if (samplerCreated) warnings.Add("Spawned the missing sampler node from archetype defaults (slot 0 = clip, remaining slots untouched).");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphSetStateClipResult
                {
                    Asset = AssetMetadata(record),
                    State = request.State,
                    StateId = state.ID,
                    Sampler = AnimgraphNodeDto(sampler),
                    SamplerCreated = samplerCreated,
                    DryRun = false,
                    Saved = true,
                    OpenedByBridge = openedByBridge,
                    ProjectRevision = revision,
                    Warnings = warnings.ToArray(),
                };
            }
            finally { ReleaseGraphWindow(item, openedByBridge, record.Id); }
        }

        private static object CoerceGraphParameterValue(object value, Type clrType, string kind)
        {
            if (value == null) return null;
            var actual = value.GetType();
            if (actual == clrType) return value;
            // The Node client sends every JSON number as Kind:number (float).
            // Coerce numerics instead of failing closed on float/int/double drift.
            if (clrType == typeof(int) && value is float) return (int)(float)value;
            if (clrType == typeof(int) && value is double) return (int)(double)value;
            if (clrType == typeof(float) && value is double) return (float)(double)value;
            if (clrType == typeof(float) && value is int) return (float)(int)value;
            if (clrType == typeof(double) && value is float) return (double)(float)value;
            if (clrType == typeof(double) && value is int) return (double)(int)value;
            // The Node client has no distinct color shape; accept a 4-vector.
            if (clrType == typeof(Color) && value is Float4)
            {
                var v = (Float4)value;
                return new Color(v.X, v.Y, v.Z, v.W);
            }
            throw new McpProtocolException("VALIDATION_FAILED", "Value kind does not match the requested parameter type '" + (kind ?? "unknown") + "'.");
        }

        private static void GraphParameterTypeMapping(string kind, out Type clrType, out object defaultValue)
        {
            var normalized = (kind ?? "").Trim().ToLowerInvariant();
            if (normalized == "boolean" || normalized == "bool") { clrType = typeof(bool); defaultValue = false; return; }
            if (normalized == "integer" || normalized == "int") { clrType = typeof(int); defaultValue = (int)0; return; }
            if (normalized == "number" || normalized == "float" || normalized == "double") { clrType = typeof(float); defaultValue = (float)0; return; }
            if (normalized == "string") { clrType = typeof(string); defaultValue = ""; return; }
            if (normalized == "vector2" || normalized == "float2") { clrType = typeof(Float2); defaultValue = new Float2(0.0f, 0.0f); return; }
            if (normalized == "vector3" || normalized == "float3") { clrType = typeof(Float3); defaultValue = new Float3(0.0f, 0.0f, 0.0f); return; }
            if (normalized == "vector4" || normalized == "float4") { clrType = typeof(Float4); defaultValue = new Float4(0.0f, 0.0f, 0.0f, 0.0f); return; }
            if (normalized == "color") { clrType = typeof(Color); defaultValue = new Color(0.0f, 0.0f, 0.0f, 1.0f); return; }
            throw new McpProtocolException("VALIDATION_FAILED", "Parameter type '" + (kind ?? "unknown") + "' is not supported. Use boolean, integer, number, string, vector2, vector3, vector4, or color.");
        }

        private static string TruncateGraphText(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return value ?? "";
            return value.Length <= max ? value : value.Substring(0, max);
        }

        private static string SafeGraphTypeName(SurfaceParameter target)
        {
            try
            {
                var text = target.Type.ToString();
                return string.IsNullOrEmpty(text) ? "unknown" : text;
            }
            catch { return "unknown"; }
        }

        private static object FromGraphTypedValue(McpMaterialTypedValue value)
        {
            if (value == null || string.Equals(value.Kind, "null", StringComparison.Ordinal)) return null;
            if (string.Equals(value.Kind, "boolean", StringComparison.Ordinal))
            {
                if (!value.Boolean.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Boolean value is missing.");
                return value.Boolean.Value;
            }
            if (string.Equals(value.Kind, "integer", StringComparison.Ordinal))
            {
                if (!value.Integer.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Integer value is missing.");
                return (int)value.Integer.Value;
            }
            if (string.Equals(value.Kind, "number", StringComparison.Ordinal))
            {
                if (!value.Number.HasValue) throw new McpProtocolException("INVALID_REQUEST", "Number value is missing.");
                return (float)value.Number.Value;
            }
            if (string.Equals(value.Kind, "string", StringComparison.Ordinal)) return Limit(value.Text ?? "", 512, "Parameter value");
            if (string.Equals(value.Kind, "vector2", StringComparison.Ordinal))
            {
                if (value.Vector2 == null) throw new McpProtocolException("INVALID_REQUEST", "Vector2 value is missing.");
                return new Float2(value.Vector2.X, value.Vector2.Y);
            }
            if (string.Equals(value.Kind, "vector3", StringComparison.Ordinal))
            {
                if (value.Vector3 == null) throw new McpProtocolException("INVALID_REQUEST", "Vector3 value is missing.");
                return new Float3(value.Vector3.X, value.Vector3.Y, value.Vector3.Z);
            }
            if (string.Equals(value.Kind, "vector4", StringComparison.Ordinal))
            {
                if (value.Vector4 == null) throw new McpProtocolException("INVALID_REQUEST", "Vector4 value is missing.");
                return new Float4(value.Vector4.X, value.Vector4.Y, value.Vector4.Z, value.Vector4.W);
            }
            if (string.Equals(value.Kind, "color", StringComparison.Ordinal))
            {
                if (value.Vector4 == null) throw new McpProtocolException("INVALID_REQUEST", "Color value is missing.");
                return new Color(value.Vector4.X, value.Vector4.Y, value.Vector4.Z, value.Vector4.W);
            }
            throw new McpProtocolException("VALIDATION_FAILED", "Value kind '" + (value.Kind ?? "unknown") + "' is not writable in this phase. Use boolean, integer, number, string, vector2/3/4, or color.");
        }

        // Per-window undo for Visject edits made before Window.Save().
        // This is intentionally separate from edit.undo (global
        // FEditor.Instance.PerformUndo): the global stack cannot undo a
        // window-local Visject stack, and nothing can undo SaveToOriginal.
        private McpGraphUndoResult GraphUndo(McpGraphUndoRequest request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph undo parameters are required.");
            if (FEditor.Instance.IsHeadlessMode)
                throw new McpProtocolException("INVALID_STATE", "Graph undo is unavailable in headless editor mode.");
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            var item = FEditor.Instance.ContentDatabase.FindAsset(record.Id);
            if (item == null)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected graph asset is unavailable in the Editor Content database.");
            var window = FEditor.Instance.Windows.FindEditor(item);
            if (window == null)
                throw new McpProtocolException("NOT_FOUND", "No open editor window holds this graph asset. Per-window undo only applies to unsaved edits in an open window.");
            ValidateGraphWindow(window, record);
            // IVisjectSurfaceOwner.Undo is public API (FlaxEngine.CSharp.xml,
            // compile-proven by VisjectGraphApiCompileProbe): direct cast
            // instead of GetProperty("Undo") reflection. Fewer fail-modes,
            // same fail-closed behavior when the window exposes no stack.
            var owner = window as IVisjectSurfaceOwner;
            var undo = owner == null ? null : owner.Undo;
            if (undo == null)
                throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose a public undo stack.");
            bool canUndo = false;
            string firstName = null;
            try { canUndo = undo.CanUndo; } catch { canUndo = false; }
            try { firstName = undo.FirstUndoName; } catch { firstName = null; }
            if (!canUndo)
            {
                return new McpGraphUndoResult
                {
                    Asset = AssetMetadata(record),
                    Undone = false,
                    CanUndo = false,
                    FirstUndoName = firstName,
                    ProjectRevision = _projectRevision,
                    Warnings = new[] { "Nothing to undo on this window stack. Edits already saved via Window.Save() cannot be undone." },
                };
            }
            undo.PerformUndo();
            var revision = AdvanceProjectRevision();
            string afterName = null;
            bool stillCan = false;
            try { stillCan = undo.CanUndo; } catch { stillCan = false; }
            try { afterName = undo.FirstUndoName; } catch { afterName = null; }
            return new McpGraphUndoResult
            {
                Asset = AssetMetadata(record),
                Undone = true,
                CanUndo = stillCan,
                FirstUndoName = afterName,
                ProjectRevision = revision,
                Warnings = new[] { "Undid one step on the window-local Visject stack. This never reverts an already-saved Window.Save()." },
            };
        }

        // ===== Bridge v34 P4: generic Visject graph editing core =====
        // graph.list_archetypes + graph.edit work on any context of an open
        // graph window: the root, nested ISurfaceContext nodes (the same walk
        // as graph.inspect sub-contexts: decimal surface node ids from the
        // root), and state-machine transition rule graphs ("transition:<from>:<to>").
        //
        // Engine truth (decompiled Flax 1.12, live-verified in WP-F):
        // - VisjectSurface.OpenContext(ISurfaceContext) pops back to an already
        //   open context or pushes a new one; EditRule() of a transition is
        //   SourceState.Surface.OpenContext(transition). Transitions are not
        //   SurfaceNodes, so no node id path reaches them: the bridge reads
        //   Animation+StateMachineStateBase.Transitions (internal field, the
        //   approved reflection exception) and checks every member at run time,
        //   answering UNSUPPORTED_FLAX_VERSION with the missing member's name.
        // - The Editor's own node menu is "!NoSpawnViaGUI && CanUseNodeType";
        //   SpawnNode itself enforces neither that nor the state-machine and
        //   transition menus (AnimGraphSurface.StateMachineGroupArchetypes /
        //   StateMachineTransitionGroupArchetype), so graph.edit validates
        //   every add_node against the same list graph.list_archetypes returns.
        // - Box.Connect(IConnectionInstigator) is the Editor's undo-aware wire
        //   toggle (it breaks an existing wire and may insert a cast node into
        //   the CURRENT context); the surface context is therefore set to the
        //   op's context before every op. Spawn/SetValues/Delete/Connect queue
        //   undo actions on the surface; a mid-batch failure flushes that queue
        //   with the public VisjectSurface.Update(0) and rewinds the window's
        //   undo stack to where the batch started. Moves queue a bridge-owned
        //   action (Control.Location itself pushes none).
        // - VisjectSurfaceContext.Save only descends into children with
        //   IsModified, so every context on an op's path is marked modified.
        private const int MaxGraphEditOps = 64;
        private const int MaxGraphEditContextDepth = 8;
        private const int MaxGraphEditValuesLength = 4 + 2 * 255;
        private const string GraphTransitionSegmentPrefix = "transition:";
        private const string GraphAnimNestedTypePrefix = "FlaxEditor.Surface.Archetypes.Animation+";

        private sealed class GraphContextSegment
        {
            public bool IsTransition;
            public uint NodeId;
            public uint FromStateId;
            public uint ToStateId;
        }

        private sealed class GraphTransitionMembers
        {
            public Type StateBase;
            public FieldInfo Transitions;
            public FieldInfo DestinationState;
        }

        private sealed class GraphArchetypeEntry
        {
            public GroupArchetype Group;
            public NodeArchetype Arch;
        }

        private sealed class GraphEditNode
        {
            public SurfaceNode Node;
            public GroupArchetype Group;
            public NodeArchetype Arch;
            public string CtxKey;
            public string Key;
            public bool Removed;
            public bool Touched;
            public object[] VirtualValues;
        }

        private sealed class GraphEditRunState
        {
            public readonly Dictionary<string, GraphEditNode> Refs = new Dictionary<string, GraphEditNode>(StringComparer.Ordinal);
            public readonly Dictionary<string, GraphEditNode> Existing = new Dictionary<string, GraphEditNode>(StringComparer.Ordinal);
            public readonly List<McpGraphRefBinding> RefBindings = new List<McpGraphRefBinding>();
            public readonly List<string> Warnings = new List<string>();
            public McpGraphEditOpResult[] Results;
            public int Applied;
            public int FailedIndex = -1;
            public string FailedOp;
        }

        // Bridge-owned undo action for node moves: Control.Location pushes no
        // undo of its own (MoveNodesAction is internal to the Editor).
        private sealed class McpGraphMoveUndo : IUndoAction
        {
            private readonly VisjectSurfaceContext _context;
            private readonly uint _nodeId;
            private readonly Float2 _before;
            private readonly Float2 _after;

            public string ActionString { get { return "Move nodes"; } }

            public McpGraphMoveUndo(VisjectSurfaceContext context, uint nodeId, Float2 before, Float2 after)
            {
                _context = context;
                _nodeId = nodeId;
                _before = before;
                _after = after;
            }

            public void Do() { Apply(_after); }
            public void Undo() { Apply(_before); }
            public void Dispose() { }

            private void Apply(Float2 location)
            {
                var node = _context == null ? null : _context.FindNode(_nodeId);
                if (node == null) return;
                node.Location = location;
                _context.MarkAsModified(false);
            }
        }

        private static McpProtocolException GraphUnsupportedMember(string member)
        {
            return new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "This Flax Editor does not expose the member '" + member + "' that state-machine transition rule graphs need.", new { Member = member });
        }

        private static bool TryParseGraphNodeId(string text, out uint id)
        {
            id = 0;
            if (string.IsNullOrEmpty(text) || text.Length > 10) return false;
            return uint.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out id);
        }

        private static string GraphContextKey(string[] path)
        {
            return path == null ? "" : string.Join("/", path);
        }

        // ContextPath grammar: decimal surface node id | "transition:<fromStateNodeId>:<toStateNodeId>".
        private static GraphContextSegment[] ParseGraphContextPath(string[] raw, string label)
        {
            if (raw == null || raw.Length == 0) return new GraphContextSegment[0];
            if (raw.Length > MaxGraphEditContextDepth)
                throw new McpProtocolException("VALIDATION_FAILED", label + ": ContextPath is limited to " + MaxGraphEditContextDepth + " segments.");
            var result = new GraphContextSegment[raw.Length];
            for (var i = 0; i < raw.Length; i++)
            {
                var text = raw[i] ?? "";
                var segment = new GraphContextSegment();
                if (text.StartsWith(GraphTransitionSegmentPrefix, StringComparison.Ordinal))
                {
                    var parts = text.Split(':');
                    uint from;
                    uint to;
                    if (parts.Length != 3 || !TryParseGraphNodeId(parts[1], out from) || !TryParseGraphNodeId(parts[2], out to))
                        throw new McpProtocolException("VALIDATION_FAILED", label + ": ContextPath[" + i + "] must be \"transition:<fromStateNodeId>:<toStateNodeId>\" with decimal ids.");
                    segment.IsTransition = true;
                    segment.FromStateId = from;
                    segment.ToStateId = to;
                }
                else
                {
                    uint id;
                    if (!TryParseGraphNodeId(text, out id))
                        throw new McpProtocolException("VALIDATION_FAILED", label + ": ContextPath[" + i + "] must be a decimal surface node id or \"transition:<from>:<to>\".");
                    segment.NodeId = id;
                }
                result[i] = segment;
            }
            return result;
        }

        // Checks every reflection target before it is used; nothing is cached on
        // failure, so a missing member is reported with its exact name each time.
        private static GraphTransitionMembers GraphTransitionReflection()
        {
            const BindingFlags instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            const BindingFlags nested = BindingFlags.Public | BindingFlags.NonPublic;
            var animation = typeof(FlaxEditor.Surface.Archetypes.Animation);
            var stateBase = animation.GetNestedType("StateMachineStateBase", nested);
            if (stateBase == null) throw GraphUnsupportedMember(GraphAnimNestedTypePrefix + "StateMachineStateBase");
            var transition = animation.GetNestedType("StateMachineTransition", nested);
            if (transition == null) throw GraphUnsupportedMember(GraphAnimNestedTypePrefix + "StateMachineTransition");
            if (!typeof(ISurfaceContext).IsAssignableFrom(transition)) throw GraphUnsupportedMember(GraphAnimNestedTypePrefix + "StateMachineTransition : ISurfaceContext");
            var transitions = stateBase.GetField("Transitions", instance);
            if (transitions == null || !typeof(System.Collections.IList).IsAssignableFrom(transitions.FieldType)) throw GraphUnsupportedMember(GraphAnimNestedTypePrefix + "StateMachineStateBase.Transitions");
            var destination = transition.GetField("DestinationState", instance);
            if (destination == null) throw GraphUnsupportedMember(GraphAnimNestedTypePrefix + "StateMachineTransition.DestinationState");
            return new GraphTransitionMembers { StateBase = stateBase, Transitions = transitions, DestinationState = destination };
        }

        private static object GraphFindTransition(SurfaceNode fromNode, uint toStateId, GraphTransitionMembers members)
        {
            if (fromNode == null || !members.StateBase.IsInstanceOfType(fromNode)) return null;
            var list = members.Transitions.GetValue(fromNode) as System.Collections.IList;
            if (list == null) return null;
            foreach (var transition in list)
            {
                if (transition == null) continue;
                SurfaceNode destination = null;
                try { destination = members.DestinationState.GetValue(transition) as SurfaceNode; } catch { destination = null; }
                if (destination != null && destination.ID == toStateId) return transition;
            }
            return null;
        }

        // Resolves a context path from the root and leaves the surface showing
        // that context. Callers capture GraphCaptureContextChain first and
        // restore it afterwards.
        private static VisjectSurfaceContext GraphOpenContext(VisjectSurface surface, GraphContextSegment[] path)
        {
            var root = surface.RootContext;
            if (root == null)
                throw new McpProtocolException("INVALID_STATE", "The graph root context is not ready. Retry shortly.");
            surface.OpenContext(root.Context);
            for (var i = 0; i < path.Length; i++)
            {
                var segment = path[i];
                var current = surface.Context;
                if (current == null)
                    throw new McpProtocolException("INVALID_STATE", "The graph surface has no current context. Retry shortly.");
                if (!segment.IsTransition)
                {
                    var node = current.FindNode(segment.NodeId);
                    if (node == null)
                        throw new McpProtocolException("NOT_FOUND", "ContextPath[" + i + "]: no node with id " + segment.NodeId + " exists in the current context.");
                    var sub = node as ISurfaceContext;
                    if (sub == null)
                        throw new McpProtocolException("VALIDATION_FAILED", "ContextPath[" + i + "]: node " + segment.NodeId + " does not own a sub-context.");
                    surface.OpenContext(sub);
                }
                else
                {
                    var members = GraphTransitionReflection();
                    var from = current.FindNode(segment.FromStateId);
                    if (from == null)
                        throw new McpProtocolException("NOT_FOUND", "ContextPath[" + i + "]: no state node with id " + segment.FromStateId + " exists in the current context.");
                    if (!members.StateBase.IsInstanceOfType(from))
                        throw new McpProtocolException("VALIDATION_FAILED", "ContextPath[" + i + "]: node " + segment.FromStateId + " is not a state-machine state (State or Any).");
                    var found = GraphFindTransition(from, segment.ToStateId, members) as ISurfaceContext;
                    if (found == null)
                        throw new McpProtocolException("NOT_FOUND", "ContextPath[" + i + "]: no transition from state " + segment.FromStateId + " to state " + segment.ToStateId + " exists. Create it first (animgraph_add_transition or a graph_edit connect between the two states).");
                    surface.OpenContext(found);
                }
            }
            var opened = surface.Context;
            if (opened == null)
                throw new McpProtocolException("INVALID_STATE", "The requested graph context could not be opened.");
            return opened;
        }

        private static List<ISurfaceContext> GraphCaptureContextChain(VisjectSurface surface)
        {
            var chain = new List<ISurfaceContext>();
            VisjectSurfaceContext current = null;
            try { current = surface.Context; } catch { current = null; }
            var guard = 0;
            while (current != null && guard++ < 64)
            {
                chain.Add(current.Context);
                current = current.Parent;
            }
            chain.Reverse();
            return chain;
        }

        private static void GraphRestoreContextChain(VisjectSurface surface, List<ISurfaceContext> chain, List<string> warnings)
        {
            if (chain == null || chain.Count == 0) return;
            try
            {
                for (var i = 0; i < chain.Count; i++) surface.OpenContext(chain[i]);
            }
            catch (Exception ex)
            {
                if (warnings != null) warnings.Add("Could not restore the original graph view (back at the root): " + ex.Message);
                try { surface.OpenContext(surface.RootContext.Context); } catch { }
            }
        }

        private static void GraphMarkContextChainModified(VisjectSurfaceContext ctx)
        {
            var guard = 0;
            while (ctx != null && guard++ < 64)
            {
                try { ctx.MarkAsModified(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph context MarkAsModified notification failed: " + ex.Message); }
                ctx = ctx.Parent;
            }
        }

        private const int GraphParticleModulesGroup = 15;

        private static string GraphContextKind(VisjectSurface surface, VisjectSurfaceContext ctx)
        {
            if (ctx == null || object.ReferenceEquals(ctx, surface.RootContext)) return "root";
            var name = ctx.Context == null ? null : ctx.Context.GetType().FullName;
            if (string.Equals(name, GraphAnimNestedTypePrefix + "StateMachineTransition", StringComparison.Ordinal)) return "transition";
            if (string.Equals(name, GraphAnimNestedTypePrefix + "StateMachine", StringComparison.Ordinal)) return "state_machine";
            if (string.Equals(name, GraphAnimNestedTypePrefix + "StateMachineState", StringComparison.Ordinal)) return "state";
            return "nested";
        }

        private static bool GraphFindGlobalArchetype(VisjectSurface surface, ushort groupId, ushort typeId, out GroupArchetype group, out NodeArchetype arch)
        {
            group = null;
            arch = null;
            var groups = surface.NodeArchetypes;
            if (groups == null) return false;
            foreach (var candidate in groups)
            {
                if (candidate == null || candidate.GroupID != groupId || candidate.Archetypes == null) continue;
                foreach (var archetype in candidate.Archetypes)
                {
                    if (archetype != null && archetype.TypeID == typeId) { group = candidate; arch = archetype; return true; }
                }
            }
            return false;
        }

        private static void GraphAddAllowedFromGroup(VisjectSurface surface, GroupArchetype group, List<GraphArchetypeEntry> result, HashSet<int> seen, bool includeNoSpawnViaGui = false)
        {
            if (group == null || group.Archetypes == null) return;
            foreach (var arch in group.Archetypes)
            {
                if (arch == null) continue;
                if (!includeNoSpawnViaGui && (arch.Flags & NodeFlags.NoSpawnViaGUI) != 0) continue;
                bool usable = false;
                try { usable = surface.CanUseNodeType(group, arch); } catch { usable = false; }
                if (!usable) continue;
                if (!seen.Add((group.GroupID << 16) | arch.TypeID)) continue;
                result.Add(new GraphArchetypeEntry { Group = group, Arch = arch });
            }
        }

        // The node set the Editor menu offers in the given context:
        // - state machine context: only (9,20) State and (9,34) Any;
        // - transition rule context: the normal menu plus (9,23) Transition Source State Anim;
        // - everything else: !NoSpawnViaGUI && CanUseNodeType over the surface groups.
        // The two special lists are private static members of AnimGraphSurface
        // (StateMachineGroupArchetypes, StateMachineTransitionGroupArchetype),
        // read by reflection when present; the ids below are the fallback and
        // match those lists in Flax 1.12.
        private static List<GraphArchetypeEntry> GraphAllowedArchetypes(VisjectSurface surface, VisjectSurfaceContext ctx, out string kind, List<string> warnings)
        {
            kind = GraphContextKind(surface, ctx);
            var result = new List<GraphArchetypeEntry>();
            var seen = new HashSet<int>();
            const BindingFlags statics = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            if (kind == "state_machine")
            {
                List<GroupArchetype> groups = null;
                try
                {
                    var field = typeof(AnimGraphSurface).GetField("StateMachineGroupArchetypes", statics);
                    groups = field == null ? null : field.GetValue(null) as List<GroupArchetype>;
                }
                catch { groups = null; }
                if (groups != null && groups.Count > 0)
                {
                    foreach (var group in groups) GraphAddAllowedFromGroup(surface, group, result, seen);
                }
                else
                {
                    GraphAddUniqueWarning(warnings, "AnimGraphSurface.StateMachineGroupArchetypes was not found; using the documented state-machine node ids (9,20) State and (9,34) Any.");
                    foreach (var typeId in new ushort[] { 20, 34 })
                    {
                        GroupArchetype group;
                        NodeArchetype arch;
                        if (GraphFindGlobalArchetype(surface, 9, typeId, out group, out arch) && seen.Add((9 << 16) | typeId))
                            result.Add(new GraphArchetypeEntry { Group = group, Arch = arch });
                    }
                }
            }
            else
            {
                var groups = surface.NodeArchetypes;
                if (groups != null)
                {
                    foreach (var group in groups) GraphAddAllowedFromGroup(surface, group, result, seen);
                    // Particle modules (group 15) are flagged NoSpawnViaGUI: the Editor adds them through the "+" menu of the
                    // emitter node's stage headers, which lists every module of the group and calls Context.SpawnNode(15, typeId, ...).
                    if (kind == "root" && surface is ParticleEmitterSurface)
                    {
                        foreach (var group in groups)
                        {
                            if (group != null && group.GroupID == GraphParticleModulesGroup) GraphAddAllowedFromGroup(surface, group, result, seen, true);
                        }
                    }
                }
                if (kind == "transition")
                {
                    GroupArchetype transitionGroup = null;
                    try
                    {
                        var field = typeof(AnimGraphSurface).GetField("StateMachineTransitionGroupArchetype", statics);
                        transitionGroup = field == null ? null : field.GetValue(null) as GroupArchetype;
                    }
                    catch { transitionGroup = null; }
                    var before = result.Count;
                    if (transitionGroup != null)
                    {
                        GraphAddAllowedFromGroup(surface, transitionGroup, result, seen);
                    }
                    if (result.Count == before && !seen.Contains((9 << 16) | 23))
                    {
                        GraphAddUniqueWarning(warnings, "AnimGraphSurface.StateMachineTransitionGroupArchetype was not found; using the documented transition rule node id (9,23).");
                        GroupArchetype group;
                        NodeArchetype arch;
                        if (GraphFindGlobalArchetype(surface, 9, 23, out group, out arch) && seen.Add((9 << 16) | 23))
                            result.Add(new GraphArchetypeEntry { Group = group, Arch = arch });
                    }
                }
            }
            result.Sort((a, b) =>
            {
                var byGroup = a.Group.GroupID.CompareTo(b.Group.GroupID);
                return byGroup != 0 ? byGroup : a.Arch.TypeID.CompareTo(b.Arch.TypeID);
            });
            return result;
        }

        private static string GraphValueKindName(object value)
        {
            if (value == null) return "null";
            if (value is byte[]) return "bytes";
            if (value is Enum) return "integer";
            return SafeMaterialAnimationValue(value).Kind;
        }

        private static string GraphBoxTypeName(NodeElementArchetype element)
        {
            try
            {
                var type = element.ConnectionsType.Type;
                if (type != null) return TruncateGraphText(type.Name, 64);
                return TruncateGraphText(element.ConnectionsType.Name ?? "", 64);
            }
            catch { return ""; }
        }

        private static McpGraphArchetype GraphArchetypeDto(GraphArchetypeEntry entry)
        {
            var inputs = new List<McpGraphArchetypeBox>();
            var outputs = new List<McpGraphArchetypeBox>();
            if (entry.Arch.Elements != null)
            {
                foreach (var element in entry.Arch.Elements)
                {
                    if (element == null) continue;
                    if (element.Type != NodeElementType.Input && element.Type != NodeElementType.Output) continue;
                    var box = new McpGraphArchetypeBox { Id = element.BoxID, Name = TruncateGraphText(element.Text ?? "", 128), Type = GraphBoxTypeName(element) };
                    if (element.Type == NodeElementType.Input) inputs.Add(box); else outputs.Add(box);
                }
            }
            var kinds = new List<string>();
            if (entry.Arch.DefaultValues != null)
            {
                foreach (var value in entry.Arch.DefaultValues) kinds.Add(GraphValueKindName(value));
            }
            return new McpGraphArchetype
            {
                GroupId = entry.Group.GroupID,
                TypeId = entry.Arch.TypeID,
                Title = TruncateGraphText(entry.Arch.Title ?? "", 128),
                Description = TruncateGraphText(entry.Arch.Description ?? "", 256),
                Inputs = inputs.ToArray(),
                Outputs = outputs.ToArray(),
                DefaultValueKinds = kinds.ToArray(),
            };
        }

        private McpGraphArchetypeList GraphListArchetypes(McpGraphListArchetypes request)
        {
            if (request == null) request = new McpGraphListArchetypes();
            EnsureGraphEditorReady(false);
            var path = ParseGraphContextPath(request.ContextPath, "ContextPath");
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            var chain = GraphCaptureContextChain(surface);
            try
            {
                var ctx = GraphOpenContext(surface, path);
                string kind;
                var allowed = GraphAllowedArchetypes(surface, ctx, out kind, warnings);
                var archetypes = new List<McpGraphArchetype>(allowed.Count);
                foreach (var entry in allowed) archetypes.Add(GraphArchetypeDto(entry));
                var existing = new List<McpGraphNodeDto>();
                if (ctx.Nodes != null)
                {
                    for (var i = 0; i < ctx.Nodes.Count && i < MaxGraphNodes; i++)
                    {
                        if (ctx.Nodes[i] != null) existing.Add(ProjectGraphNodeDto(ctx.Nodes[i], false));
                    }
                }
                warnings.Add("Read-only: the context was opened to enumerate it and the window view was restored. ExistingNodes lists the node ids already in this context (for example the Rule Output node of a transition).");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after the read." : "A window already open for this asset was reused and left open.");
                return new McpGraphArchetypeList { AssetId = record.Id.ToString("N"), ContextKind = kind, Archetypes = archetypes.ToArray(), ExistingNodes = existing.ToArray(), Warnings = warnings.ToArray() };
            }
            finally
            {
                try { GraphRestoreContextChain(surface, chain, null); } catch { }
                ReleaseGraphWindow(item, openedByBridge, record.Id);
            }
        }

        private static void GraphAddUniqueWarning(List<string> warnings, string text)
        {
            if (warnings != null && !warnings.Contains(text)) warnings.Add(text);
        }

        private static bool IsValidGraphRef(string text)
        {
            if (string.IsNullOrEmpty(text) || text.Length < 2 || text.Length > 33 || text[0] != '$') return false;
            for (var i = 1; i < text.Length; i++)
            {
                var c = text[i];
                var letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
                var digit = c >= '0' && c <= '9';
                if (!(letter || (digit && i > 1))) return false;
            }
            return true;
        }

        private static void GraphEditValidateShape(int index, McpGraphEditOp op)
        {
            var label = "ops[" + index + "]";
            if (op == null || string.IsNullOrEmpty(op.Op))
                throw new McpProtocolException("INVALID_REQUEST", label + ": Op is required (add_node, connect, disconnect, set_values, move, remove).");
            ParseGraphContextPath(op.ContextPath, label);
            switch (op.Op)
            {
                case "add_node":
                    if (op.GroupId < 0 || op.GroupId > ushort.MaxValue || op.TypeId < 0 || op.TypeId > ushort.MaxValue)
                        throw new McpProtocolException("INVALID_REQUEST", label + ": GroupId and TypeId must be 0..65535.");
                    if (!float.IsFinite(op.X) || !float.IsFinite(op.Y))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": X and Y must be finite.");
                    if (!string.IsNullOrEmpty(op.Ref) && !IsValidGraphRef(op.Ref))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": Ref must look like \"$name\" (letters, digits, underscore; at most 32 characters).");
                    break;
                case "connect":
                case "disconnect":
                    if (string.IsNullOrEmpty(op.FromNodeId) || string.IsNullOrEmpty(op.ToNodeId))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": FromNodeId and ToNodeId are required.");
                    if (op.FromBoxId < 0 || op.ToBoxId < 0)
                        throw new McpProtocolException("INVALID_REQUEST", label + ": box ids must be non-negative.");
                    break;
                case "set_values":
                    if (string.IsNullOrEmpty(op.NodeId))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": NodeId is required.");
                    if (op.Values == null || op.Values.Length == 0 || op.Values.Length > 32)
                        throw new McpProtocolException("INVALID_REQUEST", label + ": provide 1 to 32 value entries.");
                    break;
                case "move":
                    if (string.IsNullOrEmpty(op.NodeId))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": NodeId is required.");
                    if (!float.IsFinite(op.X) || !float.IsFinite(op.Y))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": X and Y must be finite.");
                    break;
                case "remove":
                    if (string.IsNullOrEmpty(op.NodeId))
                        throw new McpProtocolException("INVALID_REQUEST", label + ": NodeId is required.");
                    break;
                default:
                    throw new McpProtocolException("INVALID_REQUEST", label + ": unknown Op '" + op.Op + "'. Use add_node, connect, disconnect, set_values, move, or remove.");
            }
        }

        // Value coercion shared with graph.set_node_values, plus the two
        // graph.edit additions: an all-zero asset id clears a Guid slot, and a
        // Guid slot also accepts one of the graph's own parameter ids (the
        // Get Parameter node stores the parameter id in value 0).
        private static object GraphEditCoerceValue(McpGraphNodeValueEntry entry, Type slotType, VisjectSurface surface)
        {
            if (entry == null || entry.Value == null)
                throw new McpProtocolException("INVALID_REQUEST", "Every value entry needs an Index and a Value.");
            var value = entry.Value;
            if (string.Equals(value.Kind, "asset_id", StringComparison.Ordinal) && IsGuidN(value.AssetId) && (slotType == null || slotType == typeof(Guid)))
            {
                Guid parsed;
                if (Guid.TryParseExact(value.AssetId, "N", out parsed))
                {
                    if (parsed == Guid.Empty) return parsed;
                    List<SurfaceParameter> parameters = null;
                    try { parameters = surface.Parameters; } catch { parameters = null; }
                    if (parameters != null)
                    {
                        foreach (var parameter in parameters)
                        {
                            if (parameter != null && parameter.ID == parsed) return parsed;
                        }
                    }
                }
            }
            return CoerceGraphNodeValue(value, slotType, entry.Index);
        }

        // Builds the full value array for add_node / set_values. Layouts that
        // matter (Flax 1.12, live-verified): Animation (9,2) [Guid clip, float
        // speed, bool loop, float start]; Multi Blend 1D/2D (9,12)/(9,13)
        // [Float4 range, float speed, bool loop, float start] then per point i
        // [4+2i] Float4(x, y, 0, speed) and [5+2i] Guid clip. Only the Multi
        // Blend nodes (VariableValuesSize) may grow, in whole point pairs.
        private static object[] GraphEditBuildValues(VisjectSurface surface, GroupArchetype group, NodeArchetype arch, object[] current, McpGraphNodeValueEntry[] entries, out bool grew)
        {
            grew = false;
            if (current == null || current.Length == 0)
                throw new McpProtocolException("VALIDATION_FAILED", "The node archetype (" + group.GroupID + "," + arch.TypeID + ") has no value slots.");
            if (entries == null || entries.Length == 0 || entries.Length > 32)
                throw new McpProtocolException("VALIDATION_FAILED", "Provide 1 to 32 value entries.");
            var seen = new HashSet<int>();
            var maxIndex = -1;
            foreach (var entry in entries)
            {
                if (entry == null || entry.Index < 0 || entry.Index >= MaxGraphEditValuesLength)
                    throw new McpProtocolException("VALIDATION_FAILED", "Value index must be 0.." + (MaxGraphEditValuesLength - 1) + ".");
                if (!seen.Add(entry.Index))
                    throw new McpProtocolException("VALIDATION_FAILED", "Duplicate value index " + entry.Index + ".");
                if (entry.Index > maxIndex) maxIndex = entry.Index;
            }
            var values = current;
            if (maxIndex >= current.Length)
            {
                var multiBlend = group.GroupID == AnimGraphGroup && (arch.TypeID == 12 || arch.TypeID == 13);
                if (!multiBlend || (arch.Flags & NodeFlags.VariableValuesSize) == 0)
                    throw new McpProtocolException("VALIDATION_FAILED", "Value index " + maxIndex + " is out of range (0.." + (current.Length - 1) + "); only Multi Blend 1D/2D nodes (9,12)/(9,13) take more slots.");
                var newLength = maxIndex + 1;
                if ((newLength & 1) != 0) newLength++;
                if (newLength > MaxGraphEditValuesLength)
                    throw new McpProtocolException("VALIDATION_FAILED", "A Multi Blend node holds at most 255 blend points (value index up to " + (MaxGraphEditValuesLength - 1) + ").");
                var grown = new object[newLength];
                Array.Copy(current, grown, current.Length);
                for (var k = current.Length; k < newLength; k++) grown[k] = (k % 2 == 0) ? (object)new Float4(0.0f, 0.0f, 0.0f, 1.0f) : Guid.Empty;
                values = grown;
                grew = true;
            }
            var result = (object[])values.Clone();
            foreach (var entry in entries)
            {
                var slotType = result[entry.Index] == null ? null : result[entry.Index].GetType();
                result[entry.Index] = GraphEditCoerceValue(entry, slotType, surface);
            }
            return result;
        }

        private static GraphEditNode GraphEditResolveNode(string text, VisjectSurfaceContext ctx, string ctxKey, GraphEditRunState state, string role)
        {
            if (string.IsNullOrEmpty(text))
                throw new McpProtocolException("VALIDATION_FAILED", role + " is required.");
            if (text[0] == '$')
            {
                GraphEditNode bound;
                if (!state.Refs.TryGetValue(text, out bound))
                    throw new McpProtocolException("VALIDATION_FAILED", role + ": unknown node ref '" + text + "'. A ref must be bound by an add_node op earlier in the same batch.");
                if (!string.Equals(bound.CtxKey, ctxKey, StringComparison.Ordinal))
                    throw new McpProtocolException("VALIDATION_FAILED", role + ": node ref '" + text + "' was created in a different context than this op's ContextPath.");
                if (bound.Removed)
                    throw new McpProtocolException("NOT_FOUND", role + ": node ref '" + text + "' was removed earlier in the batch.");
                return bound;
            }
            uint id;
            if (!TryParseGraphNodeId(text, out id))
                throw new McpProtocolException("VALIDATION_FAILED", role + " must be a decimal node id or a \"$ref\".");
            var key = ctxKey + "#" + id;
            GraphEditNode existing;
            if (state.Existing.TryGetValue(key, out existing))
            {
                if (existing.Removed) throw new McpProtocolException("NOT_FOUND", role + ": node " + id + " was removed earlier in the batch.");
                return existing;
            }
            var node = ctx.FindNode(id);
            if (node == null)
                throw new McpProtocolException("NOT_FOUND", role + ": no node with id " + id + " exists in this context.");
            existing = new GraphEditNode { Node = node, Group = node.GroupArchetype, Arch = node.Archetype, CtxKey = ctxKey, Key = key };
            state.Existing[key] = existing;
            return existing;
        }

        private static string GraphEditNodeText(GraphEditNode node, string fallback)
        {
            return node != null && node.Node != null ? node.Node.ID.ToString(CultureInfo.InvariantCulture) : fallback;
        }

        // A box is resolved on the live node, or from the archetype elements
        // for a node that only exists in this dry-run.
        private static bool GraphEditResolveBox(GraphEditNode node, int boxId, string role, out FlaxEditor.Surface.Elements.Box box, out bool isOutput)
        {
            box = null;
            isOutput = false;
            if (node.Node != null)
            {
                box = FindNodeBoxById(node.Node, boxId);
                if (box == null)
                    throw new McpProtocolException("NOT_FOUND", role + ": box " + boxId + " was not found on the node (use graph_inspect include_boxes or graph_list_archetypes).");
                try { isOutput = box.IsOutput; } catch { isOutput = false; }
                return true;
            }
            if (node.Arch != null && node.Arch.Elements != null)
            {
                foreach (var element in node.Arch.Elements)
                {
                    if (element == null || element.BoxID != boxId) continue;
                    if (element.Type == NodeElementType.Input) { isOutput = false; return false; }
                    if (element.Type == NodeElementType.Output) { isOutput = true; return false; }
                }
            }
            // A Get Parameter node creates its value boxes from the selected parameter's type when it is spawned (Parameters.SurfaceNodeParamsGet),
            // so the archetype lists none and a node that only exists in this dry-run pass cannot be checked: it is output-only, and the apply pass
            // resolves the real box (box 0 is the value, and 1..4 the vector components) and fails there when it is missing.
            if (node.Arch != null && string.Equals(node.Arch.Title, "Get Parameter", StringComparison.Ordinal) && boxId >= 0 && boxId <= 4)
            {
                isOutput = true;
                return false;
            }
            throw new McpProtocolException("NOT_FOUND", role + ": box " + boxId + " does not exist on the node archetype (use graph_list_archetypes).");
        }

        private static bool GraphIsStateArchetype(GraphEditNode node, bool destinationOnly)
        {
            if (node == null || node.Group == null || node.Arch == null || node.Group.GroupID != AnimGraphGroup) return false;
            return node.Arch.TypeID == AnimGraphStateNode || (!destinationOnly && node.Arch.TypeID == AnimGraphAnyStateNode);
        }

        private static bool GraphStateLinkExists(GraphEditNode from, GraphEditNode to, IConnectionInstigator source, IConnectionInstigator destination)
        {
            try
            {
                var members = GraphTransitionReflection();
                return GraphFindTransition(from.Node, to.Node.ID, members) != null;
            }
            catch (McpProtocolException)
            {
                // Without the reflection members, a successful link shows up as "can no longer connect".
                bool canStill = true;
                try { canStill = source.CanConnectWith(destination); } catch { canStill = false; }
                return !canStill;
            }
        }

        private static McpGraphEditOpResult GraphEditRunOp(VisjectSurface surface, int index, McpGraphEditOp op, bool apply, GraphEditRunState state)
        {
            var path = ParseGraphContextPath(op.ContextPath, "ops[" + index + "]");
            var ctxKey = GraphContextKey(op.ContextPath);
            var ctx = GraphOpenContext(surface, path);
            var result = new McpGraphEditOpResult { Index = index, Op = op.Op, Ref = op.Ref, Applied = false };
            var warnings = new List<string>();
            switch (op.Op)
            {
                case "add_node": GraphEditAddNode(surface, ctx, ctxKey, op, apply, state, result, warnings); break;
                case "connect": GraphEditConnect(surface, ctx, ctxKey, op, apply, state, result, warnings, true); break;
                case "disconnect": GraphEditConnect(surface, ctx, ctxKey, op, apply, state, result, warnings, false); break;
                case "set_values": GraphEditSetValues(surface, ctx, ctxKey, op, apply, state, result, warnings); break;
                case "move": GraphEditMove(surface, ctx, ctxKey, op, apply, state, result, warnings); break;
                case "remove": GraphEditRemove(surface, ctx, ctxKey, op, apply, state, result, warnings); break;
                default: throw new McpProtocolException("VALIDATION_FAILED", "Unknown op '" + op.Op + "'.");
            }
            if (apply)
            {
                GraphMarkContextChainModified(ctx);
                try { surface.MarkAsEdited(true); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph surface MarkAsEdited notification failed: " + ex.Message); }
                result.Applied = true;
            }
            result.Warnings = warnings.ToArray();
            return result;
        }

        private static void GraphEditAddNode(VisjectSurface surface, VisjectSurfaceContext ctx, string ctxKey, McpGraphEditOp op, bool apply, GraphEditRunState state, McpGraphEditOpResult result, List<string> warnings)
        {
            if (!string.IsNullOrEmpty(op.Ref) && state.Refs.ContainsKey(op.Ref))
                throw new McpProtocolException("VALIDATION_FAILED", "Node ref '" + op.Ref + "' is bound twice in this batch.");
            string kind;
            var allowed = GraphAllowedArchetypes(surface, ctx, out kind, state.Warnings);
            GraphArchetypeEntry entry = null;
            foreach (var candidate in allowed)
            {
                if (candidate.Group.GroupID == op.GroupId && candidate.Arch.TypeID == op.TypeId) { entry = candidate; break; }
            }
            if (entry == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Node archetype (" + op.GroupId + "," + op.TypeId + ") is not offered in this " + kind + " context. List the allowed ones with graph_list_archetypes using the same context_path.", new { GroupID = op.GroupId, TypeID = op.TypeId, ContextKind = kind });
            GroupArchetype group;
            NodeArchetype arch;
            if (!GraphFindGlobalArchetype(surface, (ushort)op.GroupId, (ushort)op.TypeId, out group, out arch))
                throw new McpProtocolException("VALIDATION_FAILED", "Node archetype (" + op.GroupId + "," + op.TypeId + ") is not known to this surface.", new { GroupID = op.GroupId, TypeID = op.TypeId });
            object[] values = null;
            var grew = false;
            if (op.Values != null && op.Values.Length > 0)
                values = GraphEditBuildValues(surface, group, arch, arch.DefaultValues, op.Values, out grew);
            SurfaceNode node = null;
            if (apply)
            {
                node = ctx.SpawnNode(group, arch, new Float2(op.X, op.Y), (values != null && !grew) ? values : null, null);
                if (node == null)
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not spawn the node.");
                if (values != null && grew) node.SetValues(values);
                result.NodeId = node.ID.ToString(CultureInfo.InvariantCulture);
            }
            var created = new GraphEditNode { Node = node, Group = group, Arch = arch, CtxKey = ctxKey, Key = ctxKey + "$" + (op.Ref ?? ("#" + result.Index)), Touched = true, VirtualValues = values };
            if (!string.IsNullOrEmpty(op.Ref))
            {
                state.Refs[op.Ref] = created;
                state.RefBindings.Add(new McpGraphRefBinding { Ref = op.Ref, NodeId = node == null ? null : node.ID.ToString(CultureInfo.InvariantCulture) });
            }
            if (!apply) warnings.Add("Would add " + (arch.Title ?? "node") + " (" + group.GroupID + "," + arch.TypeID + "); the node id is assigned when the batch is applied.");
        }

        private static void GraphEditSetValues(VisjectSurface surface, VisjectSurfaceContext ctx, string ctxKey, McpGraphEditOp op, bool apply, GraphEditRunState state, McpGraphEditOpResult result, List<string> warnings)
        {
            var target = GraphEditResolveNode(op.NodeId, ctx, ctxKey, state, "NodeId");
            object[] current = null;
            if (target.Node != null)
            {
                if (!apply && target.VirtualValues != null) current = target.VirtualValues;
                else { try { current = target.Node.Values; } catch { current = null; } }
            }
            else
            {
                current = target.VirtualValues != null ? target.VirtualValues : target.Arch.DefaultValues;
            }
            bool grew;
            var values = GraphEditBuildValues(surface, target.Group, target.Arch, current, op.Values, out grew);
            result.NodeId = GraphEditNodeText(target, op.NodeId);
            if (apply)
            {
                try { target.Node.SetValues(values); }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not set the node values: " + ex.Message); }
                var check = target.Node.Values;
                foreach (var entry in op.Values)
                {
                    if (check == null || entry.Index >= check.Length || !object.Equals(check[entry.Index], values[entry.Index]))
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "The editor did not keep value index " + entry.Index + " on the node.");
                }
            }
            else
            {
                target.VirtualValues = values;
                warnings.Add("Would set " + op.Values.Length + " value slot(s)" + (grew ? " and grow the node to " + values.Length + " slots" : "") + ".");
            }
            target.Touched = true;
        }

        private static void GraphEditMove(VisjectSurface surface, VisjectSurfaceContext ctx, string ctxKey, McpGraphEditOp op, bool apply, GraphEditRunState state, McpGraphEditOpResult result, List<string> warnings)
        {
            var target = GraphEditResolveNode(op.NodeId, ctx, ctxKey, state, "NodeId");
            result.NodeId = GraphEditNodeText(target, op.NodeId);
            if (apply)
            {
                var before = target.Node.Location;
                var after = new Float2(op.X, op.Y);
                try { target.Node.Location = after; }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not move the node: " + ex.Message); }
                surface.AddBatchedUndoAction(new McpGraphMoveUndo(ctx, target.Node.ID, before, after));
            }
            else
            {
                warnings.Add("Would move the node to (" + op.X.ToString(CultureInfo.InvariantCulture) + ", " + op.Y.ToString(CultureInfo.InvariantCulture) + ").");
            }
            target.Touched = true;
        }

        private static void GraphEditRemove(VisjectSurface surface, VisjectSurfaceContext ctx, string ctxKey, McpGraphEditOp op, bool apply, GraphEditRunState state, McpGraphEditOpResult result, List<string> warnings)
        {
            var target = GraphEditResolveNode(op.NodeId, ctx, ctxKey, state, "NodeId");
            result.NodeId = GraphEditNodeText(target, op.NodeId);
            var noRemove = false;
            try { noRemove = target.Arch != null && (target.Arch.Flags & NodeFlags.NoRemove) != 0; } catch { noRemove = false; }
            if (noRemove)
                throw new McpProtocolException("VALIDATION_FAILED", "The node is engine-protected (NoRemove), for example an output node, and cannot be removed.");
            if (apply)
            {
                var id = target.Node.ID;
                try { surface.Delete(new SurfaceControl[] { target.Node }, true); }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not remove the node: " + ex.Message); }
                if (ctx.FindNode(id) != null)
                    throw new McpProtocolException("VALIDATION_FAILED", "The editor refused to remove the node (engine-protected).");
            }
            else
            {
                warnings.Add("Would remove the node and its wires.");
            }
            target.Removed = true;
            target.Touched = true;
        }

        private static void GraphEditConnect(VisjectSurface surface, VisjectSurfaceContext ctx, string ctxKey, McpGraphEditOp op, bool apply, GraphEditRunState state, McpGraphEditOpResult result, List<string> warnings, bool connect)
        {
            var from = GraphEditResolveNode(op.FromNodeId, ctx, ctxKey, state, "FromNodeId");
            var to = GraphEditResolveNode(op.ToNodeId, ctx, ctxKey, state, "ToNodeId");
            result.NodeId = GraphEditNodeText(from, op.FromNodeId);
            var kind = GraphContextKind(surface, ctx);
            // State machine states have no Boxes: a state-to-state wire is a
            // transition, made through the nodes' IConnectionInstigator exactly
            // like animgraph.add_transition and the Editor's drag-connect.
            if (kind == "state_machine" && GraphIsStateArchetype(from, false) && GraphIsStateArchetype(to, true))
            {
                if (!connect)
                    throw new McpProtocolException("VALIDATION_FAILED", "State transitions cannot be removed with graph.edit disconnect; delete the transition in the Editor.");
                GraphEditConnectStates(from, to, apply, result, warnings);
                from.Touched = true;
                to.Touched = true;
                return;
            }
            FlaxEditor.Surface.Elements.Box fromBox;
            FlaxEditor.Surface.Elements.Box toBox;
            bool fromOut;
            bool toOut;
            var fromLive = GraphEditResolveBox(from, op.FromBoxId, "FromBoxId", out fromBox, out fromOut);
            var toLive = GraphEditResolveBox(to, op.ToBoxId, "ToBoxId", out toBox, out toOut);
            if (fromOut == toOut)
                throw new McpProtocolException("VALIDATION_FAILED", "Wires run output-to-input: one endpoint must be an output box and the other an input box.");
            var touchedEarlier = from.Touched || to.Touched;
            if (apply)
            {
                var connected = GraphBoxesConnected(fromBox, toBox);
                if (connect)
                {
                    if (connected)
                        throw new McpProtocolException("VALIDATION_FAILED", "The boxes are already connected (idempotent no-op refused).");
                    var can = false;
                    try { can = fromBox.CanConnectWith(toBox); } catch { can = false; }
                    if (!can)
                        throw new McpProtocolException("VALIDATION_FAILED", "The boxes cannot be connected (type mismatch or a disabled box).");
                    fromBox.Connect(toBox);
                    if (!GraphBoxesConnected(fromBox, toBox))
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor did not create the wire.");
                }
                else
                {
                    if (!connected)
                        throw new McpProtocolException("VALIDATION_FAILED", "The boxes are not connected (idempotent no-op refused).");
                    // Box.Connect on connected boxes is the Editor's undo-aware wire break.
                    fromBox.Connect(toBox);
                    if (GraphBoxesConnected(fromBox, toBox))
                    {
                        fromBox.BreakConnection(toBox);
                        warnings.Add("The wire was broken with Box.BreakConnection, which records no undo step.");
                    }
                    if (GraphBoxesConnected(fromBox, toBox))
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not break the wire.");
                }
            }
            else if (fromLive && toLive)
            {
                var connected = GraphBoxesConnected(fromBox, toBox);
                if (connect)
                {
                    var can = false;
                    try { can = fromBox.CanConnectWith(toBox); } catch { can = false; }
                    if (connected && !touchedEarlier)
                        throw new McpProtocolException("VALIDATION_FAILED", "The boxes are already connected (idempotent no-op refused).");
                    if (!connected && !can)
                    {
                        if (!touchedEarlier) throw new McpProtocolException("VALIDATION_FAILED", "The boxes cannot be connected (type mismatch or a disabled box).");
                        warnings.Add("Box compatibility depends on earlier ops of this batch and is checked when applying.");
                    }
                }
                else if (!connected && !touchedEarlier)
                {
                    throw new McpProtocolException("VALIDATION_FAILED", "The boxes are not connected (idempotent no-op refused).");
                }
                warnings.Add(connect ? "Would connect the boxes." : "Would disconnect the boxes.");
            }
            else
            {
                warnings.Add("A node of this wire is created in this batch: box type compatibility is checked when applying.");
            }
            from.Touched = true;
            to.Touched = true;
        }

        private static void GraphEditConnectStates(GraphEditNode from, GraphEditNode to, bool apply, McpGraphEditOpResult result, List<string> warnings)
        {
            if (apply)
            {
                var source = from.Node as IConnectionInstigator;
                var destination = to.Node as IConnectionInstigator;
                if (source == null || destination == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The state nodes do not expose the public transition path in this version.");
                var can = false;
                try { can = source.CanConnectWith(destination); } catch { can = false; }
                if (!can)
                    throw new McpProtocolException("VALIDATION_FAILED", "The states cannot be connected (already connected or incompatible).");
                source.Connect(destination);
                if (!GraphStateLinkExists(from, to, source, destination))
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor did not create the transition.");
                warnings.Add("Created a transition with default settings and no rule graph; edit its rule with context_path [..., \"transition:<from>:<to>\"].");
                return;
            }
            if (from.Node != null && to.Node != null)
            {
                var source = from.Node as IConnectionInstigator;
                var destination = to.Node as IConnectionInstigator;
                var can = false;
                try { can = source != null && destination != null && source.CanConnectWith(destination); } catch { can = false; }
                if (!can && !from.Touched && !to.Touched)
                    throw new McpProtocolException("VALIDATION_FAILED", "The states cannot be connected (already connected or incompatible).");
            }
            warnings.Add("Would create a transition between the two states (box ids are ignored for state links).");
        }

        private static GraphEditRunState GraphEditExecute(VisjectSurface surface, McpGraphEditOp[] ops, bool apply)
        {
            var state = new GraphEditRunState { Results = new McpGraphEditOpResult[ops.Length] };
            for (var i = 0; i < ops.Length; i++)
            {
                try
                {
                    state.Results[i] = GraphEditRunOp(surface, i, ops[i], apply, state);
                    state.Applied++;
                }
                catch (McpProtocolException ex)
                {
                    state.FailedIndex = i;
                    state.FailedOp = ops[i] == null ? null : ops[i].Op;
                    throw new McpProtocolException(ex.Code, "graph.edit op " + i + " (" + state.FailedOp + ") failed: " + ex.Message, new { OpIndex = i, Op = state.FailedOp, ex.Details });
                }
                catch (Exception ex)
                {
                    state.FailedIndex = i;
                    state.FailedOp = ops[i] == null ? null : ops[i].Op;
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "graph.edit op " + i + " (" + state.FailedOp + ") failed: " + ex.Message, new { OpIndex = i, Op = state.FailedOp });
                }
            }
            return state;
        }

        // Surface undo actions are batched until the surface's next Update;
        // the public Update(0) pushes them to the window's undo stack now.
        private static void GraphFlushUndo(VisjectSurface surface)
        {
            try { surface.Update(0.0f); } catch (Exception ex) { Debug.LogWarning("[Flax MCP] Graph undo flush failed: " + ex.Message); }
        }

        private static int GraphUndoCount(FlaxEditor.Undo undo)
        {
            try { return undo == null ? -1 : undo.UndoOperationsStack.HistoryCount; } catch { return -1; }
        }

        private McpGraphEditResult GraphEdit(McpGraphEdit request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Graph edit parameters are required.");
            if (request.Ops == null || request.Ops.Length == 0 || request.Ops.Length > MaxGraphEditOps)
                throw new McpProtocolException("INVALID_REQUEST", "Provide 1 to " + MaxGraphEditOps + " ops.");
            for (var i = 0; i < request.Ops.Length; i++) GraphEditValidateShape(i, request.Ops[i]);
            EnsureGraphEditorReady(true);
            var record = ResolveGraphRecord(request.AssetId, request.Path);
            CheckGraphWrite(record, request.LeaseId);
            ContentItem item;
            FlaxEditor.Windows.EditorWindow window;
            bool openedByBridge;
            var surface = AcquireGraphSurface(record, out item, out window, out openedByBridge);
            var warnings = new List<string>();
            var chain = GraphCaptureContextChain(surface);
            try
            {
                // Pass 1 never changes the window: it validates the whole batch.
                var plan = GraphEditExecute(surface, request.Ops, false);
                warnings.AddRange(plan.Warnings);
                if (request.DryRun)
                {
                    warnings.Add("Dry-run preview only: the batch was validated against the live window; nothing was changed or saved. add_node ids are assigned when the batch is applied. Reissue with dry_run:false + confirm:true to apply and save once.");
                    warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after the preview." : "A window already open for this asset was reused and left open.");
                    return new McpGraphEditResult { AssetId = record.Id.ToString("N"), DryRun = true, Saved = false, Ops = plan.Results, Refs = plan.RefBindings.ToArray(), ProjectRevision = _projectRevision, Warnings = warnings.ToArray() };
                }
                if (!request.Confirm)
                    throw new McpProtocolException("VALIDATION_FAILED", "Graph edits require confirm:true alongside dry_run:false. Saving cannot be undone after Window.Save().");
                var saver = window as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (saver == null)
                    throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "The selected editor window does not expose the public save path.");
                var owner = window as IVisjectSurfaceOwner;
                var undo = owner == null ? null : owner.Undo;
                GraphFlushUndo(surface);
                var baseline = GraphUndoCount(undo);
                GraphEditRunState run = null;
                try
                {
                    run = GraphEditExecute(surface, request.Ops, true);
                }
                catch (McpProtocolException ex)
                {
                    var rolledBack = false;
                    try
                    {
                        GraphFlushUndo(surface);
                        if (undo != null && baseline >= 0)
                        {
                            var guard = 0;
                            while (GraphUndoCount(undo) > baseline && undo.CanUndo && guard++ < 256) undo.PerformUndo();
                            rolledBack = GraphUndoCount(undo) == baseline;
                        }
                    }
                    catch (Exception undoError) { Debug.LogWarning("[Flax MCP] graph.edit rollback failed: " + undoError.Message); }
                    var note = rolledBack
                        ? " Applied ops were rolled back through the window undo stack and nothing was saved."
                        : " The window undo stack could not rewind the applied ops: the edits stay in the window unsaved (use graph_undo or close the window without saving).";
                    throw new McpProtocolException(ex.Code, ex.Message + note, new { RolledBack = rolledBack, Saved = false, ex.Details });
                }
                GraphRestoreContextChain(surface, chain, warnings);
                GraphFlushUndo(surface);
                saver.Save();
                var revision = AdvanceProjectRevision();
                warnings.Add("Saved once via the public window path (Window.Surface edits + AssetEditorWindow.Save()). SaveToOriginal cannot be undone.");
                warnings.Add("The batch is recorded on the window undo stack (graph_undo steps back the whole batch while the stack retains it; reused windows only, bridge-opened windows are closed after saving).");
                warnings.Add(openedByBridge ? "The editor window was opened (shown) by the bridge and closed after saving." : "A window already open for this asset was reused and left open.");
                return new McpGraphEditResult { AssetId = record.Id.ToString("N"), DryRun = false, Saved = true, Ops = run.Results, Refs = run.RefBindings.ToArray(), ProjectRevision = revision, Warnings = warnings.ToArray() };
            }
            finally
            {
                try { GraphRestoreContextChain(surface, chain, null); } catch { }
                ReleaseGraphWindow(item, openedByBridge, record.Id);
            }
        }

        private static McpAnimationClipDto AnimationClipDto(McpAssetRecord record)
        {
            Asset loaded = null;
            try { loaded = Content.Load(record.Id, AssetLoadTimeoutMs); } catch { }
            var animation = loaded as Animation;
            if (animation == null || animation.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "A registered animation clip could not be loaded by Flax Editor.");
            var info = animation.Info;
            return new McpAnimationClipDto
            {
                Asset = AssetMetadata(record),
                Length = animation.Length,
                Duration = animation.Duration,
                FramesPerSecond = animation.FramesPerSecond,
                FramesCount = info.FramesCount,
                ChannelsCount = info.ChannelsCount,
                KeyframesCount = info.KeyframesCount,
                MemoryUsage = info.MemoryUsage,
            };
        }

        private static McpAssetMetadata AssetMetadataForLoadedAsset(Asset asset)
        {
            if (asset == null) return null;
            AssetInfo info;
            if (Content.GetAssetInfo(asset.ID, out info))
            {
                var path = AssetProjectRelativePath(info.Path);
                var extension = string.IsNullOrEmpty(path) ? null : Path.GetExtension(path).ToLowerInvariant();
                var folder = string.IsNullOrEmpty(path) ? null : (Path.GetDirectoryName(path) ?? "Content").Replace('\\', '/');
                return new McpAssetMetadata { Id = asset.ID.ToString("N"), Path = path, TypeName = info.TypeName, Extension = extension, Folder = folder };
            }
            return new McpAssetMetadata { Id = asset.ID.ToString("N"), TypeName = asset.GetType().FullName };
        }

        private static McpMaterialTypedValue SafeMaterialAnimationValue(object value)
        {
            if (value == null) return new McpMaterialTypedValue { Kind = "null" };
            if (value is bool) return new McpMaterialTypedValue { Kind = "boolean", Boolean = (bool)value };
            if (value is byte) return new McpMaterialTypedValue { Kind = "integer", Integer = (byte)value };
            if (value is short) return new McpMaterialTypedValue { Kind = "integer", Integer = (short)value };
            if (value is int) return new McpMaterialTypedValue { Kind = "integer", Integer = (int)value };
            if (value is long) return new McpMaterialTypedValue { Kind = "integer", Integer = (long)value };
            if (value is float) return new McpMaterialTypedValue { Kind = "number", Number = (float)value };
            if (value is double) return new McpMaterialTypedValue { Kind = "number", Number = (double)value };
            if (value is string) return new McpMaterialTypedValue { Kind = "string", Text = Limit((string)value, 512, "Parameter value") };
            if (value is Guid) return new McpMaterialTypedValue { Kind = "asset_id", AssetId = ((Guid)value).ToString("N") };
            if (value is Asset) return new McpMaterialTypedValue { Kind = "asset", AssetId = ((Asset)value).ID.ToString("N"), TypeName = ((Asset)value).GetType().FullName };
            if (value is Float2) { var v = (Float2)value; return new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = v.X, Y = v.Y } }; }
            if (value is Float3) { var v = (Float3)value; return new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = v.X, Y = v.Y, Z = v.Z } }; }
            if (value is Float4) { var v = (Float4)value; return new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = v.X, Y = v.Y, Z = v.Z, W = v.W } }; }
            if (value is Color) { var c = (Color)value; return new McpMaterialTypedValue { Kind = "color", Vector4 = new McpVector4 { X = c.R, Y = c.G, Z = c.B, W = c.A } }; }
            return new McpMaterialTypedValue { Kind = "unavailable", TypeName = Limit(value.GetType().FullName, 256, "Parameter value type") };
        }

        // Bridge v30 prefab override workflows (see bridge/PROTOCOL.md
        // "Bridge v30"). Verified public Flax 1.12 APIs only:
        // Actor.IsPrefabRoot/GetPrefabRoot,
        // SceneObject.HasPrefabLink/PrefabID/PrefabObjectID,
        // Prefab.GetDefaultInstance()/GetNestedObject(),
        // PrefabManager.ApplyAll, and BreakPrefabLinkAction.Break (Do/Undo
        // via Undo.AddAction, mirroring the McpScriptFieldUndo precedent
        // below; the raw SceneObject.BreakPrefabLink call is verified public
        // but intentionally unused so every break flows through the reviewed
        // undo action). Verified ABSENT from the
        // SDK (0 hits): ApplySingle, GetPrefabObjectIds, and any
        // per-property diff/revert enumerator — so the diff is
        // bridge-synthesized (live subtree vs prefab defaults with the same
        // value semantics as the read projections), revert copies defaults
        // for the fixed property set, and apply is whole-instance ApplyAll
        // only. PrefabWindow open/close/save (PrefabsModule.OpenPrefab) is
        // window-backed with no verified headless-safe stage API, so no
        // open-stage tool is exposed.
        private const int MaxPrefabDiffActors = 200;
        private const int MaxPrefabDiffEntries = 200;
        private const float PrefabDiffEpsilon = 1e-6f;

        private sealed class PrefabDiffAccumulator
        {
            public readonly List<McpPrefabOverrideEntry> Entries = new List<McpPrefabOverrideEntry>();
            public readonly Dictionary<Guid, Prefab> Prefabs = new Dictionary<Guid, Prefab>();
            public bool Truncated;
            public int ActorCount;
            public int SkippedActors;
        }

        private static bool PrefabFloatEqual(float left, float right)
        {
            return Math.Abs(left - right) <= PrefabDiffEpsilon;
        }

        private static bool PrefabFloat3Equal(Float3 left, Float3 right)
        {
            return PrefabFloatEqual(left.X, right.X) && PrefabFloatEqual(left.Y, right.Y) && PrefabFloatEqual(left.Z, right.Z);
        }

        private static Prefab LoadLinkedPrefab(Guid prefabId)
        {
            Asset loaded = null;
            try { loaded = Content.Load(prefabId, AssetLoadTimeoutMs); } catch { }
            var prefab = loaded as Prefab;
            if (prefab == null || prefab.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The linked prefab asset could not be loaded by Flax Editor.");
            return prefab;
        }

        private static Actor GetPrefabDefaultActor(Prefab prefab, Guid objectId)
        {
            try
            {
                var lookup = objectId;
                return prefab.GetDefaultInstance(ref lookup) as Actor;
            }
            catch { return null; }
        }

        private static void AnnotateNestedPrefab(Prefab prefab, Guid objectId, McpPrefabOverrideEntry entry)
        {
            try
            {
                var probe = objectId;
                Guid nestedPrefabId, nestedObjectId;
                if (prefab.GetNestedObject(ref probe, out nestedPrefabId, out nestedObjectId))
                {
                    entry.NestedPrefabId = nestedPrefabId == Guid.Empty ? null : nestedPrefabId.ToString("N");
                    entry.NestedObjectId = nestedObjectId == Guid.Empty ? null : nestedObjectId.ToString("N");
                }
            }
            catch { }
        }

        private static string PrefabActorPath(Actor root, Actor actor)
        {
            var names = new List<string>();
            for (var current = actor; current != null && names.Count <= 64; current = current.Parent)
            {
                names.Add(string.IsNullOrEmpty(current.Name) ? "<unnamed>" : current.Name);
                if (current == root) break;
            }
            names.Reverse();
            var path = string.Join("/", names.ToArray());
            return path.Length <= 512 ? path : path.Substring(0, 512);
        }

        private static void EmitPrefabEntry(PrefabDiffAccumulator acc, string actorId, string path, string property, McpMaterialTypedValue instanceValue, McpMaterialTypedValue prefabValue)
        {
            if (acc.Entries.Count >= MaxPrefabDiffEntries) { acc.Truncated = true; return; }
            acc.Entries.Add(new McpPrefabOverrideEntry { ActorId = actorId, Path = path, Property = property, InstanceValue = instanceValue, PrefabValue = prefabValue });
        }

        private void DiffPrefabActor(Actor live, Actor def, string path, Prefab prefab, PrefabDiffAccumulator acc)
        {
            var actorId = live.ID.ToString("N");
            if (!string.Equals(live.Name ?? "", def.Name ?? "", StringComparison.Ordinal))
                EmitPrefabEntry(acc, actorId, path, "Name", ProjectScriptWriteValue(live.Name, typeof(string)), ProjectScriptWriteValue(def.Name, typeof(string)));
            if (live.IsActive != def.IsActive)
                EmitPrefabEntry(acc, actorId, path, "IsActive", ProjectScriptWriteValue(live.IsActive, typeof(bool)), ProjectScriptWriteValue(def.IsActive, typeof(bool)));
            if (!PrefabFloat3Equal(live.LocalPosition, def.LocalPosition))
                EmitPrefabEntry(acc, actorId, path, "LocalPosition", ProjectScriptWriteValue(live.LocalPosition, typeof(Float3)), ProjectScriptWriteValue(def.LocalPosition, typeof(Float3)));
            if (!PrefabFloat3Equal(live.LocalScale, def.LocalScale))
                EmitPrefabEntry(acc, actorId, path, "LocalScale", ProjectScriptWriteValue(live.LocalScale, typeof(Float3)), ProjectScriptWriteValue(def.LocalScale, typeof(Float3)));
            if (!PrefabFloat3Equal(live.LocalEulerAngles, def.LocalEulerAngles))
                EmitPrefabEntry(acc, actorId, path, "LocalEulerAngles", ProjectScriptWriteValue(live.LocalEulerAngles, typeof(Float3)), ProjectScriptWriteValue(def.LocalEulerAngles, typeof(Float3)));
            if (live.Layer != def.Layer)
                EmitPrefabEntry(acc, actorId, path, "Layer", ProjectScriptWriteValue(live.Layer, typeof(int)), ProjectScriptWriteValue(def.Layer, typeof(int)));
            if (acc.Entries.Count > 0)
            {
                var latest = acc.Entries[acc.Entries.Count - 1];
                if (string.Equals(latest.ActorId, actorId, StringComparison.Ordinal) && latest.NestedPrefabId == null)
                    AnnotateNestedPrefab(prefab, live.PrefabObjectID, latest);
            }
        }

        private void CollectPrefabDiff(Actor root, Actor actor, PrefabDiffAccumulator acc)
        {
            if (acc.ActorCount >= MaxPrefabDiffActors) { acc.Truncated = true; return; }
            acc.ActorCount++;
            if (actor.HasPrefabLink && actor.PrefabObjectID != Guid.Empty)
            {
                Prefab prefab = null;
                if (!acc.Prefabs.TryGetValue(actor.PrefabID, out prefab) || prefab == null)
                {
                    try { prefab = LoadLinkedPrefab(actor.PrefabID); acc.Prefabs[actor.PrefabID] = prefab; }
                    catch { prefab = null; }
                }
                var def = prefab == null ? null : GetPrefabDefaultActor(prefab, actor.PrefabObjectID);
                if (def == null) acc.SkippedActors++;
                else DiffPrefabActor(actor, def, PrefabActorPath(root, actor), prefab, acc);
            }
            else if (actor.HasPrefabLink) acc.SkippedActors++;
            for (var i = 0; i < actor.ChildrenCount; i++)
            {
                if (acc.ActorCount >= MaxPrefabDiffActors) { acc.Truncated = true; return; }
                CollectPrefabDiff(root, actor.GetChild(i), acc);
            }
        }

        private static string[] PrefabDiffWarnings(PrefabDiffAccumulator acc)
        {
            var warnings = new List<string>
            {
                "Synthesized bridge diff, not the engine prefab-diff window: compares Name/IsActive/LocalPosition/LocalScale/LocalEulerAngles/Layer of linked actors against Prefab.GetDefaultInstance() defaults. Scripts and other properties are not compared; per-property revert is not exposed.",
            };
            if (acc.Truncated) warnings.Add("Capped at " + MaxPrefabDiffActors + " actors and " + MaxPrefabDiffEntries + " entries; additional overrides are truncated.");
            if (acc.SkippedActors > 0) warnings.Add(acc.SkippedActors + " linked actor(s) had no resolvable prefab default and were skipped.");
            return warnings.ToArray();
        }

        private McpPrefabOverridesResult GetPrefabOverrides(McpPrefabActorRequest request)
        {
            if (request == null || string.IsNullOrEmpty(request.ActorId)) throw new McpProtocolException("INVALID_REQUEST", "ActorId is required.");
            var actor = RequireActor(request.ActorId);
            var current = CurrentRevision(actor.Scene);
            var result = new McpPrefabOverridesResult
            {
                DryRun = false,
                ActorId = actor.ID.ToString("N"),
                HasPrefabLink = actor.HasPrefabLink,
                IsPrefabRoot = actor.IsPrefabRoot,
                PrefabId = actor.HasPrefabLink && actor.PrefabID != Guid.Empty ? actor.PrefabID.ToString("N") : null,
                PrefabObjectId = actor.HasPrefabLink && actor.PrefabObjectID != Guid.Empty ? actor.PrefabObjectID.ToString("N") : null,
                Entries = new McpPrefabOverrideEntry[0],
                ProjectRevision = current.ProjectRevision,
                SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"),
                SceneRevision = current.SceneRevision,
            };
            if (!actor.HasPrefabLink)
            {
                result.Warnings = new[] { "Actor has no prefab link; no overrides exist." };
                return result;
            }
            var acc = new PrefabDiffAccumulator();
            CollectPrefabDiff(actor, actor, acc);
            result.Entries = acc.Entries.ToArray();
            result.Truncated = acc.Truncated;
            result.ActorCount = acc.ActorCount;
            result.Warnings = PrefabDiffWarnings(acc);
            return result;
        }

        private static bool PrefabActorMatchesDefault(Actor live, Actor def)
        {
            return string.Equals(live.Name ?? "", def.Name ?? "", StringComparison.Ordinal)
                && live.IsActive == def.IsActive
                && PrefabFloat3Equal(live.LocalPosition, def.LocalPosition)
                && PrefabFloat3Equal(live.LocalScale, def.LocalScale)
                && PrefabFloat3Equal(live.LocalEulerAngles, def.LocalEulerAngles)
                && live.Layer == def.Layer;
        }

        private object ExecutePrefabRevert(McpPrefabRevertRequest q)
        {
            // Dry-run previews never consume idempotency keys (same convention
            // as ExecuteSetScriptField): a preview filed under the same key as
            // a later real write would collide on the request fingerprint.
            if (q != null && q.DryRun) return RevertPrefabOverrides(q);
            return ExecuteIdempotent("prefab.revert_overrides", q == null ? null : q.IdempotencyKey, q, () => RevertPrefabOverrides(q));
        }

        private McpPrefabRevertResult RevertPrefabOverrides(McpPrefabRevertRequest q)
        {
            if (q == null || q.ActorIds == null || q.ActorIds.Length < 1 || q.ActorIds.Length > 32)
                throw new McpProtocolException("VALIDATION_FAILED", "ActorIds must contain between 1 and 32 actor IDs.");
            var actors = new List<Actor>(q.ActorIds.Length);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var id in q.ActorIds)
            {
                if (string.IsNullOrEmpty(id) || !IsGuidN(id))
                    throw new McpProtocolException("INVALID_REQUEST", "ActorIds must be 32-character GUIDs.");
                if (!seen.Add(id)) throw new McpProtocolException("VALIDATION_FAILED", "Duplicate actor ID '" + id + "'.");
                actors.Add(RequireActor(id));
            }
            var scene = actors[0].Scene;
            foreach (var actor in actors)
            {
                if (!actor.HasPrefabLink)
                    throw new McpProtocolException("VALIDATION_FAILED", "Actor '" + actor.ID.ToString("N") + "' has no prefab link to revert.");
                if (actor.Scene != scene)
                    throw new McpProtocolException("VALIDATION_FAILED", "All revert targets must belong to a single loaded scene.");
            }
            EnsurePrefabEditorReady();
            CheckSceneWrite(scene, q.ExpectedSceneRevision, q.LeaseId);
            var acc = new PrefabDiffAccumulator();
            var defaults = new Dictionary<string, Actor>(StringComparer.OrdinalIgnoreCase);
            foreach (var actor in actors)
            {
                Prefab prefab = null;
                if (!acc.Prefabs.TryGetValue(actor.PrefabID, out prefab) || prefab == null)
                {
                    try { prefab = LoadLinkedPrefab(actor.PrefabID); acc.Prefabs[actor.PrefabID] = prefab; }
                    catch { prefab = null; }
                }
                var def = prefab == null || actor.PrefabObjectID == Guid.Empty ? null : GetPrefabDefaultActor(prefab, actor.PrefabObjectID);
                if (def == null) throw new McpProtocolException("ASSET_NOT_FOUND", "The prefab default for actor '" + actor.ID.ToString("N") + "' could not be resolved.");
                defaults[actor.ID.ToString("N")] = def;
                DiffPrefabActor(actor, def, string.IsNullOrEmpty(actor.Name) ? "<unnamed>" : actor.Name, prefab, acc);
            }
            var current = CurrentRevision(scene);
            var preview = new McpPrefabRevertResult
            {
                DryRun = q.DryRun,
                ActorIds = actors.ConvertAll(a => a.ID.ToString("N")).ToArray(),
                Entries = acc.Entries.ToArray(),
                Truncated = acc.Truncated,
                ProjectRevision = current.ProjectRevision,
                SceneId = scene == null ? null : scene.ID.ToString("N"),
                SceneRevision = current.SceneRevision,
            };
            if (q.DryRun)
            {
                preview.Warnings = PrefabDiffWarnings(acc);
                return preview;
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Prefab revert requires confirm:true alongside dryRun:false. Revert copies prefab defaults into the scene and registers editor undo per actor (revertible with edit_undo).");
            var touched = 0;
            foreach (var actor in actors)
            {
                var def = defaults[actor.ID.ToString("N")];
                if (PrefabActorMatchesDefault(actor, def)) continue;
                var name = def.Name;
                var active = def.IsActive;
                var position = def.LocalPosition;
                var scale = def.LocalScale;
                var euler = def.LocalEulerAngles;
                var layer = def.Layer;
                try
                {
                    // Direct typed setters inside editor undo (same pattern as
                    // UpdateActor); the fixed diff property set only.
                    FEditor.Instance.Undo.RecordAction(actor, "Revert prefab overrides", () =>
                    {
                        actor.Name = name;
                        actor.IsActive = active;
                        actor.LocalPosition = position;
                        actor.LocalScale = scale;
                        actor.LocalEulerAngles = euler;
                        actor.Layer = layer;
                        MarkEdited(actor);
                    });
                }
                catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Prefab revert failed for actor '" + actor.ID.ToString("N") + "': " + ex.GetType().FullName + "."); }
                touched++;
            }
            var verified = true;
            foreach (var actor in actors)
            {
                var def = defaults[actor.ID.ToString("N")];
                if (!PrefabActorMatchesDefault(actor, def)) { verified = false; break; }
            }
            McpRevision revision = touched > 0 ? AdvanceSceneRevision(scene) : CurrentRevision(scene);
            preview.DryRun = false;
            preview.RevertedActors = touched;
            preview.RevertedEntries = acc.Entries.Count;
            preview.Verified = verified;
            preview.ProjectRevision = revision.ProjectRevision;
            preview.SceneRevision = revision.SceneRevision;
            var warnings = new List<string>(PrefabDiffWarnings(acc));
            warnings.Add(touched == 0 ? "No overrides were found; nothing was written." : "Reverted overrides are undoable with edit_undo; per-property revert is not exposed, list only the actors to revert.");
            preview.Warnings = warnings.ToArray();
            return preview;
        }

        private object ExecutePrefabApply(McpPrefabActorRequest q)
        {
            if (q != null && q.DryRun) return ApplyPrefabOverrides(q);
            return ExecuteIdempotent("prefab.apply_overrides", q == null ? null : q.IdempotencyKey, q, () => ApplyPrefabOverrides(q));
        }

        private McpPrefabApplyResult ApplyPrefabOverrides(McpPrefabActorRequest q)
        {
            if (q == null || string.IsNullOrEmpty(q.ActorId)) throw new McpProtocolException("INVALID_REQUEST", "ActorId is required.");
            var actor = RequireActor(q.ActorId);
            if (!actor.HasPrefabLink)
                throw new McpProtocolException("VALIDATION_FAILED", "Actor '" + actor.ID.ToString("N") + "' has no prefab link to apply.");
            EnsurePrefabEditorReady();
            CheckSceneWrite(actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            var acc = new PrefabDiffAccumulator();
            CollectPrefabDiff(actor, actor, acc);
            var current = CurrentRevision(actor.Scene);
            var result = new McpPrefabApplyResult
            {
                DryRun = q.DryRun,
                ActorId = actor.ID.ToString("N"),
                HasPrefabLink = true,
                IsPrefabRoot = actor.IsPrefabRoot,
                PrefabId = actor.PrefabID == Guid.Empty ? null : actor.PrefabID.ToString("N"),
                BeforeSnapshot = acc.Entries.ToArray(),
                SnapshotTruncated = acc.Truncated,
                ProjectRevision = current.ProjectRevision,
                SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"),
                SceneRevision = current.SceneRevision,
            };
            if (q.DryRun)
            {
                var preview = new List<string>(PrefabDiffWarnings(acc));
                preview.Add("Dry-run preview only: nothing was applied. Reissue with dryRun:false + confirm:true to push the whole-instance diff via PrefabManager.ApplyAll.");
                result.Warnings = preview.ToArray();
                return result;
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Prefab apply requires confirm:true alongside dryRun:false. ApplyAll saves the prefab asset; the asset save cannot be undone by edit_undo.");
            // Whole-instance apply only: Flax 1.12 exposes no ApplySingle, so
            // BeforeSnapshot is the manual record of what was pushed.
            if (PrefabManager.ApplyAll(actor))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax failed to apply prefab overrides for actor '" + actor.ID.ToString("N") + "'.");
            MarkEdited(actor);
            var revision = AdvanceSceneRevision(actor.Scene);
            result.DryRun = false;
            result.AppliedCount = acc.Entries.Count;
            result.ProjectRevision = revision.ProjectRevision;
            result.SceneRevision = revision.SceneRevision;
            var warnings = new List<string>(PrefabDiffWarnings(acc));
            warnings.Add("PrefabManager.ApplyAll saved the prefab asset and synchronized active instances; the asset save cannot be undone by edit_undo. BeforeSnapshot lists the pushed values for manual inspection.");
            result.Warnings = warnings.ToArray();
            return result;
        }

        private object ExecutePrefabBreak(McpPrefabActorRequest q)
        {
            if (q != null && q.DryRun) return BreakPrefabLink(q);
            return ExecuteIdempotent("prefab.break_link", q == null ? null : q.IdempotencyKey, q, () => BreakPrefabLink(q));
        }

        private McpPrefabBreakResult BreakPrefabLink(McpPrefabActorRequest q)
        {
            if (q == null || string.IsNullOrEmpty(q.ActorId)) throw new McpProtocolException("INVALID_REQUEST", "ActorId is required.");
            var actor = RequireActor(q.ActorId);
            var hadLink = actor.HasPrefabLink;
            var prefabId = hadLink && actor.PrefabID != Guid.Empty ? actor.PrefabID.ToString("N") : null;
            EnsurePrefabEditorReady();
            CheckSceneWrite(actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            var current = CurrentRevision(actor.Scene);
            var result = new McpPrefabBreakResult
            {
                DryRun = q.DryRun,
                ActorId = actor.ID.ToString("N"),
                HadLink = hadLink,
                PrefabId = prefabId,
                ProjectRevision = current.ProjectRevision,
                SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"),
                SceneRevision = current.SceneRevision,
            };
            if (!hadLink)
            {
                if (!q.DryRun)
                    throw new McpProtocolException("VALIDATION_FAILED", "Actor '" + result.ActorId + "' has no prefab link to break.");
                result.Warnings = new[] { "Dry-run preview only: the actor has no prefab link, so a write would be refused as a no-op." };
                return result;
            }
            if (q.DryRun)
            {
                result.Warnings = new[] { "Dry-run preview only: the link was not broken. Reissue with dryRun:false + confirm:true to break it via the reviewed BreakPrefabLinkAction undo path." };
                return result;
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Prefab break-link requires confirm:true alongside dryRun:false. Breaking registers editor undo (revertible with edit_undo).");
            // Reviewed undo path: BreakPrefabLinkAction documents undo/redo
            // but the type is internal (same precedent as AddRemoveScript
            // above), so invoke its documented public Break(Actor) factory
            // and run Do/AddAction through IUndoAction, never the raw
            // SceneObject.BreakPrefabLink call.
            var action = CreateBreakPrefabLinkAction(actor);
            try { action.Do(); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Prefab break-link failed: " + ex.GetType().FullName + "."); }
            FEditor.Instance.Undo.AddAction(action);
            MarkEdited(actor);
            var revision = AdvanceSceneRevision(actor.Scene);
            result.DryRun = false;
            result.UndoRegistered = true;
            result.ProjectRevision = revision.ProjectRevision;
            result.SceneRevision = revision.SceneRevision;
            result.Warnings = new[] { "Prefab link broken via BreakPrefabLinkAction; revert with edit_undo." };
            return result;
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
                    TryDelete(AssetOperationPath(oldest));
                }
                // Stored import-settings previews are dropped together with
                // their operation record (TTL expiry above or eviction here).
                if (_assetImportSettingsResults.Count > 0)
                {
                    var orphaned = new List<string>();
                    foreach (var pair in _assetImportSettingsResults) if (!_assetImportOperations.ContainsKey(pair.Key)) orphaned.Add(pair.Key);
                    foreach (var key in orphaned) _assetImportSettingsResults.Remove(key);
                }
                var created = new McpAssetOperation { OperationId = operationId, Kind = kind, Phase = "requested", Progress = 0.0f, StartedUnixMs = now, DryRun = dryRun };
                _assetImportOperations[operationId] = created;
                _assetImportOperationFingerprints[operationId] = fingerprint;
                PersistAssetImportOperationLocked(created);
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
                stored.Replaced = operation.Replaced;
                stored.ErrorCode = errorCode;
                stored.Error = error;
                PersistAssetImportOperationLocked(stored);
                UpdateOperationLocked(stored.OperationId, phase, stored.Progress, phase == "succeeded" ? "Asset operation completed" : "Asset operation failed", errorCode, error, stored.ResultPath);
            }
        }

        private static McpAssetOperation CopyAssetImportOperation(McpAssetOperation value)
        {
            return new McpAssetOperation { OperationId = value.OperationId, Kind = value.Kind, Phase = value.Phase, Progress = value.Progress, StartedUnixMs = value.StartedUnixMs, FinishedUnixMs = value.FinishedUnixMs, ResultPath = value.ResultPath, ResultAssetId = value.ResultAssetId, Renamed = value.Renamed, Replaced = value.Replaced, DryRun = value.DryRun, ErrorCode = value.ErrorCode, Error = value.Error };
        }

        private static string AssetOperationPath(string operationId) { return Path.Combine(AssetOperations, operationId.ToLowerInvariant() + ".json"); }

        // Import/reimport records survive a script reload like the generic operations do, so a status poll or an OperationId retry
        // after the reload still finds the record (and its ResultAssetId) instead of OPERATION_NOT_FOUND.
        private void PersistAssetImportOperationLocked(McpAssetOperation operation)
        {
            if (operation == null || !IsGuidN(operation.OperationId)) return;
            string fingerprint;
            _assetImportOperationFingerprints.TryGetValue(operation.OperationId, out fingerprint);
            TryWritePersistent(AssetOperationPath(operation.OperationId), new McpPersistedAssetOperation { Operation = CopyAssetImportOperation(operation), Fingerprint = fingerprint });
        }

        private void PersistAssetImportOperations()
        {
            lock (_stateLock) foreach (var operation in _assetImportOperations.Values) PersistAssetImportOperationLocked(operation);
        }

        private void RestoreAssetImportOperations()
        {
            try
            {
                if (!Directory.Exists(AssetOperations)) return;
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                foreach (var file in Directory.GetFiles(AssetOperations, "*.json"))
                {
                    var saved = ReadPersistent<McpPersistedAssetOperation>(file);
                    var operation = saved == null ? null : saved.Operation;
                    if (operation == null || !IsGuidN(operation.OperationId) || string.IsNullOrEmpty(saved.Fingerprint) || (operation.Kind != "import" && operation.Kind != "reimport")) { TryDelete(file); continue; }
                    var completed = operation.FinishedUnixMs == 0 ? operation.StartedUnixMs : operation.FinishedUnixMs;
                    if (completed + AssetImportOperationTtlMs <= now) { TryDelete(file); continue; }
                    if (_assetImportOperations.ContainsKey(operation.OperationId) || _assetImportOperations.Count >= MaxAssetImportOperations) continue;
                    // An unfinished record cannot complete after the reload (the ContentImporting completion event is gone). Node
                    // treats only succeeded/failed/dry_run as terminal, so report it as failed instead of leaving it pending forever.
                    if (!IsTerminalOperationPhase(operation.Phase))
                    {
                        operation.Phase = "failed";
                        operation.Progress = 1.0f;
                        operation.FinishedUnixMs = now;
                        operation.ErrorCode = "IMPORT_FAILED";
                        operation.Error = "Bridge reloaded before the asset operation completed; the asset may or may not have been written. Check the Content registry before retrying.";
                    }
                    _assetImportOperations[operation.OperationId] = operation;
                    _assetImportOperationFingerprints[operation.OperationId] = saved.Fingerprint;
                    PersistAssetImportOperationLocked(operation);
                }
            }
            catch { }
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
            if (!string.Equals(collisionPolicy, "error", StringComparison.Ordinal) && !string.Equals(collisionPolicy, "rename", StringComparison.Ordinal) && !string.Equals(collisionPolicy, "replace", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "CollisionPolicy must be error, rename, or replace.");
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var inside = normalized.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar);
            var output = Path.GetFullPath(Path.Combine(content, inside));
            if (!PathIsWithin(content, output)) throw new McpProtocolException("VALIDATION_FAILED", "Asset import destination escapes Content.");
            EnsureAssetImportOutputParent(output);
            renamed = false;
            if (!File.Exists(output) && !Directory.Exists(output)) return output;
            if (string.Equals(collisionPolicy, "error", StringComparison.Ordinal))
                throw new McpProtocolException("FILE_EXISTS", "An asset already exists at the requested destination.");
            // replace: the caller (StartAssetImport) verifies the existing file is a registered asset of the importer's output type.
            if (string.Equals(collisionPolicy, "replace", StringComparison.Ordinal))
            {
                if (Directory.Exists(output)) throw new McpProtocolException("FILE_EXISTS", "The requested destination is a directory, not an asset.");
                return output;
            }
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
            return new[] { "Flax 1.12 public Content metadata exposes only ID, path, type, extension, and folder. File size, modified time, and import status are intentionally omitted. Importer settings are not part of this result: read them with asset.get_import_settings, which supports texture, model, and audio assets only." };
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

        // v14 physics/navigation/lighting/terrain domain tools intentionally
        // expose only public read/query APIs. Build/bake mutations report a
        // stable unsupported capability until a bounded completion/cancel model
        // can be verified against Flax Editor rather than inferred.
        private object UnsupportedDomainMutation(string capability, string reason)
        {
            throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", reason, new { Capability = capability, BridgeVersion = BridgeVersion, Reason = reason });
        }

        private object ValidateColliders()
        {
            var colliders = Level.GetActors(typeof(Collider), false);
            var entries = new List<McpColliderEntry>();
            var issues = new List<McpDomainFinding>();
            foreach (var actor in colliders)
            {
                var collider = actor as Collider;
                if (collider == null) continue;
                entries.Add(new McpColliderEntry { ActorId = collider.ID.ToString("N"), SceneId = collider.Scene == null ? null : collider.Scene.ID.ToString("N"), TypeName = collider.TypeName, Name = LimitForLog(collider.Name, 128), IsTrigger = collider.IsTrigger, Active = collider.IsActiveInHierarchy, Layer = collider.Layer });
                if (!collider.IsActiveInHierarchy) issues.Add(new McpDomainFinding { Code = "COLLIDER_INACTIVE", ActorId = collider.ID.ToString("N"), Message = "Collider is inactive in hierarchy." });
            }
            return new McpColliderValidationResult { Entries = entries.ToArray(), Findings = issues.ToArray(), Scanned = colliders.Length, Scope = "loaded-scenes-only" };
        }

        private object PhysicsLayerMatrix()
        {
            var layers = new List<McpLayerEntry>();
            for (var i = 0; i < 32; i++) layers.Add(new McpLayerEntry { Index = i, Name = LayersMask.GetLayerName(i) });
            return new McpLayerMatrixResult { Layers = layers.ToArray(), CollisionMatrixAvailable = false, Warning = "Flax 1.12 public managed API exposes layer names but not a reviewed runtime collision-matrix reader; use Physics Settings.json for offline matrix inspection." };
        }

        private object PhysicsRaycast(McpPhysicsRayRequest request)
        {
            if (request == null || request.Origin == null || request.Direction == null) throw new McpProtocolException("INVALID_REQUEST", "Origin and Direction are required.");
            ValidateDomainVector(request.Origin, "Origin"); ValidateDomainVector(request.Direction, "Direction");
            if (request.Distance <= 0 || request.Distance > 100000.0f) throw new McpProtocolException("VALIDATION_FAILED", "Distance must be between 0 and 100000.");
            RayCastHit hit;
            var didHit = Physics.RayCast(ToVector3(request.Origin), ToVector3(request.Direction), out hit, request.Distance, request.LayerMask, request.IncludeTriggers);
            return new McpRaycastResult { Hit = didHit, Result = didHit ? new McpRaycastHit { ColliderId = hit.Collider == null ? null : hit.Collider.ID.ToString("N"), Point = FromVector3(hit.Point), Normal = FromVector3(hit.Normal), Distance = hit.Distance, FaceIndex = hit.FaceIndex } : null };
        }

        private object PhysicsFindOverlaps(McpPhysicsOverlapRequest request)
        {
            if (request == null || request.Center == null) throw new McpProtocolException("INVALID_REQUEST", "Center is required.");
            ValidateDomainVector(request.Center, "Center");
            if (request.Radius <= 0 || request.Radius > 100000.0f || request.Limit < 1 || request.Limit > 100) throw new McpProtocolException("VALIDATION_FAILED", "Radius must be between 0 and 100000 and Limit between 1 and 100.");
            Collider[] hits;
            var any = Physics.OverlapSphere(ToVector3(request.Center), request.Radius, out hits, request.LayerMask, request.IncludeTriggers);
            var entries = new List<McpOverlapEntry>();
            if (any && hits != null) foreach (var hit in hits)
            {
                if (hit == null) continue;
                entries.Add(new McpOverlapEntry { ActorId = hit.ID.ToString("N"), SceneId = hit.Scene == null ? null : hit.Scene.ID.ToString("N"), TypeName = hit.TypeName, Name = LimitForLog(hit.Name, 128), IsTrigger = hit.IsTrigger });
                if (entries.Count == request.Limit) break;
            }
            return new McpOverlapResult { Entries = entries.ToArray(), Truncated = any && hits != null && hits.Length > entries.Count, Scope = "Physics.OverlapSphere" };
        }

        private object NavigationStatus()
        {
            return new McpNavigationStatusResult { IsBuilding = Navigation.IsBuildingNavMesh, Progress = Navigation.NavMeshBuildingProgress, BuildSupported = true, CancellationSupported = false, Scope = "global-navigation-runtime", Warning = "Flax 1.12 exposes no navmesh cancel API (verified 0 cancel hits in Source/Engine/Navigation/Navigation.h); a timed-out navigation.build keeps building in the background." };
        }

        private object ValidateNavigationAgents()
        {
            var meshes = Level.GetActors(typeof(NavMesh), false);
            var entries = new List<McpNavMeshAgentEntry>();
            foreach (var actor in meshes)
            {
                var mesh = actor as NavMesh;
                if (mesh == null) continue;
                var agent = mesh.Properties.Agent;
                entries.Add(new McpNavMeshAgentEntry { ActorId = mesh.ID.ToString("N"), SceneId = mesh.Scene == null ? null : mesh.Scene.ID.ToString("N"), Name = LimitForLog(mesh.Name, 128), AgentRadius = agent.Radius, AgentHeight = agent.Height, AgentStepHeight = agent.StepHeight, AgentMaxSlopeAngle = agent.MaxSlopeAngle, Active = mesh.IsActiveInHierarchy });
            }
            return new McpNavigationAgentsResult { Entries = entries.ToArray(), Findings = new McpDomainFinding[0], Scope = "loaded-navmesh-actors-only", Warning = "Flax 1.12 exposes navmesh agent settings on NavMesh actors; dynamic NavAgent actor validation is not exposed by this bounded surface." };
        }

        private object NavigationQueryPath(McpNavigationPathRequest request)
        {
            if (request == null || request.Start == null || request.End == null) throw new McpProtocolException("INVALID_REQUEST", "Start and End are required.");
            ValidateDomainVector(request.Start, "Start"); ValidateDomainVector(request.End, "End");
            if (request.MaxPoints < 1 || request.MaxPoints > 256) throw new McpProtocolException("VALIDATION_FAILED", "MaxPoints must be between 1 and 256.");
            Vector3[] points;
            var found = Navigation.FindPath(ToVector3(request.Start), ToVector3(request.End), out points);
            var entries = new List<McpVector3>();
            if (found && points != null) for (var i = 0; i < points.Length && i < request.MaxPoints; i++) entries.Add(FromVector3(points[i]));
            return new McpNavigationPathResult { Found = found, Points = entries.ToArray(), Truncated = found && points != null && points.Length > entries.Count, Scope = "active-global-navmesh" };
        }

        private object LightingStatus()
        {
            lock (_stateLock)
            {
                return new McpLightingStatusResult { Phase = _lightBakeActive ? "baking" : "idle", IsBaking = _lightBakeActive, BakeSupported = true, CancellationSupported = true, HasLastResult = _lightBakeHasLastResult, LastFailed = _lightBakeLastFailed, Warning = "LightmapsBakeEnd(failed:true) conflates bake failure and cancellation; poll lighting.bake status for step progress." };
            }
        }

        private object LightingValidate()
        {
            var staticModels = Level.GetActors(typeof(StaticModel), false);
            var probes = Level.GetActors(typeof(EnvironmentProbe), false);
            var entries = new List<McpLightmapEntry>();
            foreach (var actor in staticModels)
            {
                var model = actor as StaticModel;
                if (model != null) entries.Add(new McpLightmapEntry { ActorId = model.ID.ToString("N"), Type = "StaticModel", Active = model.IsActiveInHierarchy, ScaleInLightmap = model.ScaleInLightmap, HasLightmap = model.HasLightmap });
            }
            return new McpLightingValidateResult { Entries = entries.ToArray(), StaticModelCount = staticModels.Length, EnvironmentProbeCount = probes.Length, Scope = "loaded-scenes-only", Warning = "This validator reports public lightmap-related actor state only; it does not estimate lighting quality or invoke baking." };
        }

        private object TerrainSummary(McpDomainListRequest request)
        {
            var limit = request == null ? 100 : Math.Max(1, Math.Min(request.Limit, 100));
            var actors = Level.GetActors(typeof(Terrain), false); var entries = new List<McpTerrainEntry>();
            foreach (var actor in actors) { var terrain = actor as Terrain; if (terrain == null) continue; entries.Add(new McpTerrainEntry { ActorId = terrain.ID.ToString("N"), SceneId = terrain.Scene == null ? null : terrain.Scene.ID.ToString("N"), Name = LimitForLog(terrain.Name, 128), LODCount = terrain.LODCount, ChunkSize = terrain.ChunkSize, HeightmapSize = terrain.HeightmapSize, PatchSize = terrain.PatchSize, PatchesCount = terrain.PatchesCount, CollisionLOD = terrain.CollisionLOD, Active = terrain.IsActiveInHierarchy }); if (entries.Count == limit) break; }
            return new McpTerrainSummaryResult { Entries = entries.ToArray(), Truncated = actors.Length > entries.Count, Scope = "loaded-terrain-actors-only", MutationsSupported = false, Mutation = "terrain.paint is a stable UNSUPPORTED_FLAX_VERSION stub: Flax 1.12 terrain data accessors return raw pointers and the EditTerrain* undo actions are internal with no public factory." };
        }

        private object FoliageSummary(McpDomainListRequest request)
        {
            var limit = request == null ? 100 : Math.Max(1, Math.Min(request.Limit, 100));
            var actors = Level.GetActors(typeof(Foliage), false); var entries = new List<McpFoliageEntry>();
            foreach (var actor in actors) { var foliage = actor as Foliage; if (foliage == null) continue; entries.Add(new McpFoliageEntry { ActorId = foliage.ID.ToString("N"), SceneId = foliage.Scene == null ? null : foliage.Scene.ID.ToString("N"), Name = LimitForLog(foliage.Name, 128), InstancesCount = foliage.InstancesCount, FoliageTypesCount = foliage.FoliageTypesCount, GlobalDensityScale = Foliage.GlobalDensityScale, Active = foliage.IsActiveInHierarchy }); if (entries.Count == limit) break; }
            return new McpFoliageSummaryResult { Entries = entries.ToArray(), Truncated = actors.Length > entries.Count, Scope = "loaded-foliage-actors-only", MutationsSupported = true, Mutation = "foliage.add_instances / foliage.remove_instances (capped batches with editor undo plus one RebuildClusters; persists via scene save)", Warning = "RebuildClusters has no progress or cancel API; batches are capped at 200 instances per call." };
        }

        // Bridge v31 foliage/navmesh/bake/probe writes plus the honest
        // terrain.paint stub (see bridge/PROTOCOL.md "Bridge v31"). The four
        // real write/start ops are edit-time only (RequireEditTime: headless
        // INVALID_STATE because the paths are GPU/editor-ops dependent,
        // play-mode INVALID_STATE), mirroring the v28 actor_update gate.
        // Navmesh building is CPU work but keeps the same gate for
        // consistency. Scenes are marked edited, never saved: callers persist
        // with scene_save. Results use the named v31 field DTOs, never
        // anonymous types.
        private const int MaxFoliageBatch = 200;

        private static Foliage RequireFoliage(string id)
        {
            var actor = RequireActor(id);
            var foliage = actor as Foliage;
            if (foliage == null) throw new McpProtocolException("VALIDATION_FAILED", "Actor " + id + " is not a FlaxEngine.Foliage (actual: " + actor.TypeName + ").");
            return foliage;
        }

        // Bridge v31 terrain.paint is intentionally a stable unsupported stub.
        // Spot-verification against the Flax 1.12 SDK (compile-probed, no live
        // editor) showed the task's assumed write path is not callable from
        // safe managed bridge code: TerrainTools.GetHeightmapData/
        // GetHolesMaskData/GetSplatMapData return raw float*/byte*/Color32*
        // (CS0214 without an unsafe context, which Flax script compilation is
        // not verified to allow), and EditTerrainHeightMapAction/
        // EditTerrainHolesMapAction/EditTerrainSplatMapAction are internal
        // editor types with no public factory (CS0122; only non-public
        // reflection could reach them). Node still validates the full
        // terrain_paint contract and maps this to UNSUPPORTED_FLAX_VERSION.
        private object TerrainPaintBlocked()
        {
            RequireEditTime("terrain.paint");
            throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "terrain.paint has no verified managed write path in Flax 1.12: terrain data accessors return raw pointers (unsafe context required, not verified for Flax script compilation) and the EditTerrain* undo actions are internal editor types with no public factory. Rect validation still applies; live-editor verification is required before a real implementation.", new { Capability = "terrain_paint", BridgeVersion = BridgeVersion });
        }


        private McpFoliageAddResult AddFoliageInstances(McpFoliageAddRequest request)
        {
            RequireEditTime("foliage.add_instances");
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Foliage add parameters are required.");
            var foliage = RequireFoliage(request.FoliageId);
            CheckSceneWrite(foliage.Scene, null, null);
            if (request.TypeIndex < 0 || request.TypeIndex >= foliage.FoliageTypesCount)
                throw new McpProtocolException("VALIDATION_FAILED", "TypeIndex must be between 0 and " + (foliage.FoliageTypesCount - 1) + " (foliage has " + foliage.FoliageTypesCount + " types).");
            var specs = request.Instances ?? new McpFoliageInstanceSpec[0];
            if (specs.Length < 1 || specs.Length > MaxFoliageBatch)
                throw new McpProtocolException("VALIDATION_FAILED", "Instances must contain between 1 and 200 entries, got " + specs.Length + ".");
            // Validate and build every transform before touching undo or foliage.
            var transforms = new Transform[specs.Length];
            for (var i = 0; i < specs.Length; i++)
            {
                var spec = specs[i];
                if (spec == null || spec.Position == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "Instance " + i + " requires a position.");
                ValidateDomainVector(spec.Position, "Instance " + i + " position");
                var euler = spec.Rotation ?? new McpVector3();
                ValidateDomainVector(euler, "Instance " + i + " rotation");
                if (double.IsNaN(spec.Scale) || double.IsInfinity(spec.Scale) || spec.Scale <= 0 || spec.Scale > 10000)
                    throw new McpProtocolException("VALIDATION_FAILED", "Instance " + i + " scale must be a finite number in (0, 10000].");
                transforms[i] = new Transform(ToVector3(spec.Position), Quaternion.Euler(euler.X, euler.Y, euler.Z), new Float3((float)spec.Scale));
            }
            var action = new FlaxEditor.Tools.Foliage.Undo.EditFoliageAction(foliage);
            for (var i = 0; i < specs.Length; i++)
            {
                // FoliageInstance.Transform is local-space relative to the
                // foliage actor; bounds/random are recalculated by the engine.
                var instance = new FoliageInstance { Transform = transforms[i], Type = request.TypeIndex };
                foliage.AddInstance(ref instance);
            }
            action.RecordEnd();
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            foliage.RebuildClusters();
            foliage.UpdateCullDistance();
            MarkEdited(foliage);
            var revision = AdvanceSceneRevision(foliage.Scene);
            return new McpFoliageAddResult
            {
                FoliageId = request.FoliageId,
                TypeIndex = request.TypeIndex,
                AddedCount = specs.Length,
                InstancesCount = foliage.InstancesCount,
                UndoRegistered = true,
                SceneEdited = true,
                ProjectRevision = revision.ProjectRevision,
                SceneRevision = revision.SceneRevision,
                Warnings = new[]
                {
                    "Instance positions are local-space relative to the foliage actor (FoliageInstance.Transform); rotation is pitch/yaw/roll degrees via Quaternion.Euler and scale is uniform.",
                    "One RebuildClusters plus UpdateCullDistance ran after the batch; RebuildClusters has no progress or cancel API, so batches are capped at 200 instances per call.",
                    "The scene is marked edited, never saved (persist with scene_save).",
                },
            };
        }

        private McpFoliageRemoveResult RemoveFoliageInstances(McpFoliageRemoveRequest request)
        {
            RequireEditTime("foliage.remove_instances");
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Foliage remove parameters are required.");
            var foliage = RequireFoliage(request.FoliageId);
            CheckSceneWrite(foliage.Scene, null, null);
            var indices = request.InstanceIndices ?? new int[0];
            if (indices.Length < 1 || indices.Length > MaxFoliageBatch)
                throw new McpProtocolException("VALIDATION_FAILED", "InstanceIndices must contain between 1 and 200 entries, got " + indices.Length + ".");
            var live = foliage.InstancesCount;
            var seen = new HashSet<int>();
            for (var i = 0; i < indices.Length; i++)
            {
                if (indices[i] < 0 || indices[i] >= live)
                    throw new McpProtocolException("VALIDATION_FAILED", "Instance index " + indices[i] + " is out of range (0.." + (live - 1) + ", " + live + " live instances).");
                if (!seen.Add(indices[i]))
                    throw new McpProtocolException("VALIDATION_FAILED", "Duplicate instance index " + indices[i] + ".");
            }
            // Remove highest-first so earlier removals never shift later targets.
            var ordered = (int[])indices.Clone();
            Array.Sort(ordered);
            Array.Reverse(ordered);
            var action = new FlaxEditor.Tools.Foliage.Undo.EditFoliageAction(foliage);
            foreach (var index in ordered) foliage.RemoveInstance(index);
            action.RecordEnd();
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            foliage.RebuildClusters();
            foliage.UpdateCullDistance();
            MarkEdited(foliage);
            var revision = AdvanceSceneRevision(foliage.Scene);
            return new McpFoliageRemoveResult
            {
                FoliageId = request.FoliageId,
                RemovedIndices = ordered,
                RemovedCount = ordered.Length,
                InstancesCount = foliage.InstancesCount,
                UndoRegistered = true,
                SceneEdited = true,
                ProjectRevision = revision.ProjectRevision,
                SceneRevision = revision.SceneRevision,
                Warnings = new[]
                {
                    "Indices were removed highest-first against " + live + " live instances; one RebuildClusters plus UpdateCullDistance ran after the batch (no progress/cancel API; capped at 200 per call).",
                    "The scene is marked edited, never saved (persist with scene_save).",
                },
            };
        }

        private McpNavigationBuildResult BuildNavMesh(McpNavigationBuildRequest request, long deadlineUnixMs)
        {
            // Headless is allowed: the CPU navmesh build needs no window (live-probed on Flax 1.12:
            // tiles built and NavMeshDefault.flax saved in a headless Editor). Play mode and
            // script compilation/reload still refuse.
            RequireNotPlaying("navigation.build");
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("INVALID_STATE", "navigation.build is unavailable while scripts are compiling or reloading.");
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Navigation build parameters are required.");
            var timeoutMs = request.TimeoutMs <= 0 ? 15000 : request.TimeoutMs;
            if (timeoutMs < 500 || timeoutMs > 60000)
                throw new McpProtocolException("VALIDATION_FAILED", "TimeoutMs must be between 500 and 60000.");
            Scene scene = null;
            if (!string.IsNullOrEmpty(request.SceneId))
            {
                scene = RequireScene(request.SceneId);
                CheckSceneWrite(scene, null, null);
            }
            else
            {
                var scenes = Level.Scenes;
                if (scenes != null && scenes.Length > 0) scene = scenes[0];
            }
            var hasBounds = request.Min != null || request.Max != null;
            BoundingBox bounds = new BoundingBox();
            if (hasBounds)
            {
                if (request.Min == null || request.Max == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "Bounds requires both Min and Max.");
                ValidateDomainVector(request.Min, "Min");
                ValidateDomainVector(request.Max, "Max");
                if (request.Min.X > request.Max.X || request.Min.Y > request.Max.Y || request.Min.Z > request.Max.Z)
                    throw new McpProtocolException("VALIDATION_FAILED", "Bounds Min must not exceed Max on any axis.");
                bounds = new BoundingBox(ToVector3(request.Min), ToVector3(request.Max));
            }
            // Navigation.BuildNavMesh(..., float timeoutMs) names its last argument "The timeout to
            // wait before building Nav Mesh (in milliseconds)": it is a start DELAY, not a build
            // timeout (decompiled FlaxEngine/Navigation.cs, all three overloads). Pass 0 to build
            // now; request.TimeoutMs is only this bridge's own wait budget below. The request
            // still enqueues until the next game-scripts update. Live-probed (Flax 1.12): a small
            // build keeps IsBuildingNavMesh true for only 3-6 ms, far less than a frame or the old
            // 100 ms main-thread poll, so the flag is sampled here on the request thread without sleeping
            // for the first 3 s (it is an atomic read and was verified off the main thread).
            const float BuildDelayMs = 0f;
            const long NavBuildSpinMs = 3000;
            const long BuildQuietMs = 250; // a build can run as several consecutive batches; completed needs this long without one
            var sceneForCall = scene;
            var stampBefore = NavMeshDataStamp();
            // The engine drains its build queue once per update, so two updates after the call the request has been
            // processed; a repeat of an unchanged bounded build then often starts no tile build at all.
            var updatesAtEnqueue = OnMain(() =>
            {
                if (hasBounds) Navigation.BuildNavMesh(bounds, sceneForCall, BuildDelayMs);
                else Navigation.BuildNavMesh(sceneForCall, BuildDelayMs);
                return Engine.UpdateCount;
            }, deadlineUnixMs);
            var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var progress = 0.0f;
            var building = false;
            var sawBuilding = false;
            var dataChanged = false;
            var completed = false;
            var polls = 0;
            long quietSince = 0;
            while (true)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                try { building = Navigation.IsBuildingNavMesh; progress = Navigation.NavMeshBuildingProgress; }
                catch { building = false; }
                var processed = false;
                try { processed = Engine.UpdateCount >= updatesAtEnqueue + 2; } catch { }
                if (building) { sawBuilding = true; quietSince = 0; }
                else if (sawBuilding || processed)
                {
                    if (quietSince == 0) quietSince = now;
                    if (now - quietSince >= BuildQuietMs) { completed = true; break; }
                }
                // A build that finishes between two samples is only visible as new data (written when the scene is saved).
                else if (polls % 250 == 249 && NavMeshDataStamp() != stampBefore) { dataChanged = true; completed = true; break; }
                polls++;
                if (now - start >= timeoutMs)
                {
                    if (sawBuilding && !building) completed = true;
                    break;
                }
                // Spin while the build can still be queued behind the next frame, then ease off for long waits.
                if (now - start < NavBuildSpinMs) Thread.Yield(); else Thread.Sleep(1);
            }
            if (completed) progress = 1.0f;
            var waitedMs = (int)(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - start);
            var wholeScene = !hasBounds;
            var warnings = new List<string>();
            if (wholeScene) warnings.Add("Whole-scene build discards all tiles of the target scene(s) and may take a while; prefer bounds for iterative work.");
            if (!completed && building) warnings.Add("The wait budget elapsed while the navmesh is still building; it continues in the background (Flax 1.12 exposes no navmesh cancel API). Poll navigation.get_status for progress.");
            else if (!completed) warnings.Add("The wait budget elapsed before the engine started the build (requests enqueue until the next game-scripts update) and no new navmesh data was seen; it may still start. Poll navigation.get_status.");
            else warnings.Add("The engine writes the navmesh data asset itself when a build finishes; the bridge does not save the scene.");
            if (completed && !sawBuilding && !dataChanged) warnings.Add("No tile build was observed: the engine processed the request and nothing was building afterwards, so the build finished between samples or no tile needed rebuilding.");
            return new McpNavigationBuildResult
            {
                Phase = completed ? "completed" : (building ? "running" : "queued"),
                Progress = progress,
                WholeScene = wholeScene,
                SceneId = scene == null ? null : scene.ID.ToString("N"),
                ObservedBuilding = sawBuilding,
                DataChanged = dataChanged,
                WaitedMs = waitedMs,
                Warnings = warnings.ToArray(),
            };
        }

        // Cheap change signal for builds too short to observe through
        // IsBuildingNavMesh: the newest write time of the navmesh data assets
        // (NavMesh*.flax) under project Content.
        private static long NavMeshDataStamp()
        {
            try
            {
                var content = Path.Combine(Globals.ProjectFolder, "Content");
                if (!Directory.Exists(content)) return 0;
                long newest = 0;
                foreach (var file in Directory.EnumerateFiles(content, "NavMesh*.flax", SearchOption.AllDirectories))
                {
                    var ticks = File.GetLastWriteTimeUtc(file).Ticks;
                    if (ticks > newest) newest = ticks;
                }
                return newest;
            }
            catch { return 0; }
        }

        private void OnLightmapsBakeStart()
        {
            lock (_stateLock) { _lightBakeActive = true; _lightBakeStep = "started"; _lightBakeStepProgress = 0; _lightBakeTotalProgress = 0; }
        }

        private void OnLightmapsBakeProgress(FlaxEditor.Editor.LightmapsBakeSteps step, float stepProgress, float totalProgress)
        {
            lock (_stateLock) { _lightBakeActive = true; _lightBakeStep = step.ToString(); _lightBakeStepProgress = stepProgress; _lightBakeTotalProgress = totalProgress; }
        }

        private void OnLightmapsBakeEnd(bool failed)
        {
            lock (_stateLock) { _lightBakeActive = false; _lightBakeHasLastResult = true; _lightBakeLastFailed = failed; }
        }

        private McpLightingBakeResult LightBakeSnapshotLocked(string phase, string[] warnings)
        {
            return new McpLightingBakeResult
            {
                Phase = phase,
                IsBaking = _lightBakeActive,
                Step = _lightBakeStep,
                StepProgress = _lightBakeStepProgress,
                TotalProgress = _lightBakeTotalProgress,
                HasLastResult = _lightBakeHasLastResult,
                LastFailed = _lightBakeLastFailed,
                Warnings = warnings ?? new string[0],
            };
        }

        private McpLightingBakeResult BakeLightmaps(McpLightingBakeRequest request, long deadlineUnixMs)
        {
            if (request == null || string.IsNullOrEmpty(request.Action))
                throw new McpProtocolException("INVALID_REQUEST", "Action is required (start, cancel, or status).");
            var action = request.Action.Trim().ToLowerInvariant();
            if (action == "status")
            {
                lock (_stateLock)
                {
                    var warnings = new List<string>();
                    if (_lightBakeHasLastResult && !_lightBakeActive)
                        warnings.Add("Last bake ended with Failed=" + _lightBakeLastFailed + "; LightmapsBakeEnd(failed:true) conflates bake failure and cancellation.");
                    return LightBakeSnapshotLocked(_lightBakeActive ? "baking" : "idle", warnings.ToArray());
                }
            }
            RequireEditTime("lighting.bake");
            if (action == "start")
            {
                lock (_stateLock)
                {
                    if (_lightBakeActive)
                        return LightBakeSnapshotLocked("baking", new[] { "A lightmap bake is already running; start is a no-op report (the BakeLightmapsOrCancel toggle was not invoked, so the running bake was not cancelled)." });
                }
                OnMain(() => { FEditor.Instance.BakeLightmapsOrCancel(); return 0; }, deadlineUnixMs);
                lock (_stateLock)
                {
                    _lightBakeActive = true;
                    if (string.IsNullOrEmpty(_lightBakeStep)) _lightBakeStep = "started";
                    return LightBakeSnapshotLocked("baking", new[] { "Bake started; the caller polls lighting.bake status for step progress and the LightmapsBakeEnd event for completion." });
                }
            }
            if (action == "cancel")
            {
                lock (_stateLock)
                {
                    if (!_lightBakeActive)
                        return LightBakeSnapshotLocked("idle", new[] { "No lightmap bake is running; cancel did not invoke the BakeLightmapsOrCancel toggle, so no bake was started." });
                }
                OnMain(() => { FEditor.Instance.BakeLightmapsOrCancel(); return 0; }, deadlineUnixMs);
                lock (_stateLock)
                {
                    return LightBakeSnapshotLocked("cancel_requested", new[] { "Cancel was requested via BakeLightmapsOrCancel; LightmapsBakeEnd(failed:true) conflates failure and cancellation, so poll status until idle." });
                }
            }
            throw new McpProtocolException("VALIDATION_FAILED", "Action must be start, cancel, or status.");
        }

        private McpProbeBakeResult BakeProbe(McpProbeBakeRequest request, long deadlineUnixMs)
        {
            RequireEditTime("environment_probe.bake");
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Probe bake parameters are required.");
            var actor = RequireActor(request.ActorId);
            var probe = actor as EnvironmentProbe;
            var sky = actor as SkyLight;
            if (probe == null && sky == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Actor " + request.ActorId + " is not a FlaxEngine.EnvironmentProbe or FlaxEngine.SkyLight (actual: " + actor.TypeName + ").");
            CheckSceneWrite(actor.Scene, null, null);
            var timeoutMs = request.TimeoutMs <= 0 ? 10000 : request.TimeoutMs;
            if (timeoutMs < 1000 || timeoutMs > 60000)
                throw new McpProtocolException("VALIDATION_FAILED", "TimeoutMs must be between 1000 and 60000.");
            // Bake takes seconds ("startup time" allowance); the bridge poll
            // budget below is TimeoutMs milliseconds.
            var timeoutSeconds = (float)timeoutMs / 1000.0f;
            var kind = probe != null ? "EnvironmentProbe" : "SkyLight";
            var actorForCall = actor;
            OnMain(() => { if (probe != null) probe.Bake(timeoutSeconds); else sky.Bake(timeoutSeconds); return 0; }, deadlineUnixMs);
            var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var loaded = false;
            while (true)
            {
                loaded = OnMain(() => actorForCall.HasContentLoaded, deadlineUnixMs);
                if (loaded) break;
                if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - start >= timeoutMs) break;
                Thread.Sleep(100);
            }
            var warnings = new List<string>();
            warnings.Add("Probe baking runs as an async graphics task with no percent progress and no cancel API; completion is observed via Actor.HasContentLoaded, which cannot distinguish a fresh bake from previously baked content.");
            if (loaded) warnings.Add("Baked probes persist via scene save by the user; the bridge performs no save.");
            else warnings.Add("Timeout reached before content loaded; the bake may still complete in the background. Baked output persists via scene save by the user.");
            return new McpProbeBakeResult { Phase = loaded ? "completed" : "timeout", ActorId = request.ActorId, Kind = kind, Warnings = warnings.ToArray() };
        }

        private static Vector3 ToVector3(McpVector3 value) { return new Vector3(value.X, value.Y, value.Z); }
        private static McpVector3 FromVector3(Vector3 value) { return new McpVector3 { X = value.X, Y = value.Y, Z = value.Z }; }
        private static void ValidateDomainVector(McpVector3 value, string label) { if (value == null || float.IsNaN(value.X) || float.IsInfinity(value.X) || float.IsNaN(value.Y) || float.IsInfinity(value.Y) || float.IsNaN(value.Z) || float.IsInfinity(value.Z)) throw new McpProtocolException("VALIDATION_FAILED", label + " must contain finite coordinates."); }

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

        // Bridge v34 editor readiness. Read-only and cheap; every probe is
        // guarded so status never throws in any Editor state (loading,
        // compiling, reloading, play mode, shutdown).
        private static void FillEditorReadiness(McpStatus status)
        {
            try
            {
                var editor = FEditor.Instance;
                var machine = editor == null ? null : editor.StateMachine;
                var state = machine == null ? null : machine.CurrentState;
                status.EditorState = state == null ? null : state.GetType().Name;
                status.IsEditMode = machine != null && machine.IsEditMode;
                status.IsImporting = editor != null && editor.ContentImporting != null && editor.ContentImporting.IsImporting;
            }
            catch { /* partial readiness is still reported */ }
            try
            {
                status.IsCompiling = ScriptsBuilder.IsCompiling;
                status.ScriptsReady = ScriptsBuilder.IsReady && !ScriptsBuilder.IsCompiling;
                status.LastCompileFailed = ScriptsBuilder.LastCompilationFailed;
            }
            catch { }
            try { status.LoadedSceneCount = Level.ScenesCount; }
            catch { }
        }

        // editor.quit state. The request records what was decided; OnUpdate
        // finishes it so the response is on disk before the process exits.
        private sealed class PendingQuit
        {
            public string Unsaved;
            public bool WaitPlayEnd;
            public long ArmedTick;
            public ulong ArmedFrame;
            public volatile bool ResponseWritten;
        }

        private static List<Scene> EditedLoadedScenes()
        {
            var edited = new List<Scene>();
            for (var i = 0; i < Level.ScenesCount; i++)
            {
                var scene = Level.GetScene(i);
                if (scene == null) continue;
                try { if (FEditor.Instance.Scene.IsEdited(scene)) edited.Add(scene); }
                catch { /* scene graph not available (for example during play mode) */ }
            }
            return edited;
        }

        private static List<FlaxEditor.Windows.Assets.AssetEditorWindow> EditedAssetWindows()
        {
            var edited = new List<FlaxEditor.Windows.Assets.AssetEditorWindow>();
            var windows = FEditor.Instance.Windows == null ? null : FEditor.Instance.Windows.Windows;
            if (windows == null) return edited;
            for (var i = 0; i < windows.Count; i++)
            {
                var window = windows[i] as FlaxEditor.Windows.Assets.AssetEditorWindow;
                if (window != null && window.IsEdited) edited.Add(window);
            }
            return edited;
        }

        private static string AssetWindowLabel(FlaxEditor.Windows.Assets.AssetEditorWindow window)
        {
            var item = window.Item;
            if (item != null && !string.IsNullOrEmpty(item.Path)) return ProjectRelativePath(item.Path);
            return (window.Title ?? window.GetType().Name).TrimEnd('*');
        }

        // Quit the Editor the way the File menu does, minus its save prompt:
        // Engine.RequestExit closes the main window with ClosingReason.EngineExit
        // (WindowsModule.MainWindow_OnClosing only prompts for ClosingReason.User).
        private McpEditorQuitResult EditorQuit(McpEditorQuit request)
        {
            if (request == null) request = new McpEditorQuit();
            var unsaved = (request.Unsaved ?? "refuse").Trim().ToLowerInvariant();
            if (unsaved != "refuse" && unsaved != "save" && unsaved != "discard")
                throw new McpProtocolException("INVALID_REQUEST", "Unsaved must be refuse, save, or discard.");
            var editor = FEditor.Instance;
            var armed = _pendingQuit;
            if (armed != null)
                return new McpEditorQuitResult { Accepted = true, Phase = armed.WaitPlayEnd ? "stopping_play" : "exiting", Pid = Environment.ProcessId, SavedSceneIds = new string[0], DiscardedSceneIds = new string[0], DiscardedAssetWindows = new string[0] };
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", "Editor quit is unavailable while game scripts are compiling or reloading. Retry once compilation finishes.");
            if (editor.ContentImporting.IsImporting)
                throw new McpProtocolException("EDITOR_BUSY", "Editor quit is unavailable while content is importing.");
            if (GameCooker.IsRunning)
                throw new McpProtocolException("EDITOR_BUSY", "Editor quit is unavailable while a game build is running.");
            var playing = FEditor.IsPlayMode || editor.Simulation.IsPlayModeRequested;
            if (playing && !request.StopPlay)
                throw new McpProtocolException("INVALID_STATE", "Editor quit is refused: play mode active. Pass StopPlay:true to stop play first.");

            // In play mode the scene graph shows the play session, so scene edits are
            // evaluated after play ends (see TickPendingQuit); asset windows are not
            // affected by play mode and are evaluated now.
            var scenes = playing ? new List<Scene>() : EditedLoadedScenes();
            var windows = EditedAssetWindows();
            var sceneNames = new List<string>();
            var sceneIds = new List<string>();
            foreach (var scene in scenes) { sceneIds.Add(scene.ID.ToString("N")); sceneNames.Add(scene.Name ?? scene.ID.ToString("N")); }
            var windowLabels = new List<string>();
            foreach (var window in windows) windowLabels.Add(AssetWindowLabel(window));

            if (unsaved == "refuse" && (scenes.Count > 0 || windows.Count > 0))
                throw new McpProtocolException("DIRTY_SCENE", "Unsaved edits would be lost. Save them, or pass Unsaved:save or Unsaved:discard. Scenes: [" + string.Join(", ", sceneNames) + "]; asset windows: [" + string.Join(", ", windowLabels) + "]", new { DirtyScenes = sceneNames.ToArray(), DirtyAssetWindows = windowLabels.ToArray() });

            var result = new McpEditorQuitResult { Accepted = true, Phase = playing ? "stopping_play" : "exiting", Pid = Environment.ProcessId, SavedSceneIds = new string[0], DiscardedSceneIds = new string[0], DiscardedAssetWindows = new string[0] };
            if (unsaved == "save")
            {
                foreach (var window in windows)
                {
                    try { window.Save(); }
                    catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Saving asset window failed: " + AssetWindowLabel(window) + ": " + ex.Message); }
                    if (window.IsEdited)
                        throw new McpProtocolException("ASSET_OPERATION_FAILED", "Asset window still has unsaved edits after Save: " + AssetWindowLabel(window));
                }
                // Editor SceneModule.SaveScenes is asynchronous; the exit waits for it.
                if (scenes.Count > 0) editor.Scene.SaveScenes();
                result.SavedSceneIds = sceneIds.ToArray();
            }
            else if (unsaved == "discard")
            {
                result.DiscardedSceneIds = sceneIds.ToArray();
                result.DiscardedAssetWindows = windowLabels.ToArray();
            }

            var pending = new PendingQuit { Unsaved = unsaved, WaitPlayEnd = playing, ArmedTick = Environment.TickCount64, ArmedFrame = Engine.FrameCount };
            if (playing)
            {
                lock (_stateLock) _playState = "stopping";
                editor.Simulation.RequestStopPlay();
            }
            _pendingQuit = pending;
            return result;
        }

        // Runs from OnUpdate (Editor update thread). Exit happens on a frame after
        // the request finished and its response was written.
        private void TickPendingQuit(long now)
        {
            var pending = _pendingQuit;
            if (pending == null) return;
            try
            {
                var editor = FEditor.Instance;
                if (pending.WaitPlayEnd)
                {
                    if (now - pending.ArmedTick > 60000)
                    {
                        _pendingQuit = null;
                        Debug.LogWarning("[Flax MCP] editor.quit cancelled: play mode did not stop within 60 seconds.");
                        return;
                    }
                    if (FEditor.IsPlayMode || editor.Simulation.IsPlayModeRequested || !editor.StateMachine.IsEditMode) return;
                    pending.WaitPlayEnd = false;
                    var edited = EditedLoadedScenes();
                    if (edited.Count > 0)
                    {
                        if (pending.Unsaved == "refuse")
                        {
                            _pendingQuit = null;
                            Debug.LogWarning("[Flax MCP] editor.quit cancelled: " + edited.Count + " scene(s) have unsaved edits after play mode ended.");
                            return;
                        }
                        if (pending.Unsaved == "save") editor.Scene.SaveScenes();
                    }
                }
                if (Level.IsAnyActionPending) return;
                if (!pending.ResponseWritten && now - pending.ArmedTick < 5000) return;
                if (Engine.FrameCount <= pending.ArmedFrame) return;
                _pendingQuit = null;
                Debug.Log("[Flax MCP] editor.quit: requesting engine exit.");
                Engine.RequestExit();
            }
            catch (Exception ex)
            {
                _pendingQuit = null;
                Debug.LogWarning("[Flax MCP] editor.quit failed: " + ex.Message);
            }
        }

        private McpEditorOptions GetEditorOptions()
        {
            var general = FEditor.Instance.Options.Options.General;
            return new McpEditorOptions { AutoReloadScriptsOnMainWindowFocus = general.AutoReloadScriptsOnMainWindowFocus, ForceScriptCompilationOnStartup = general.ForceScriptCompilationOnStartup };
        }

        // Allow-listed General options only, written the way the Editor Options
        // window saves: deep-clone Options.Options, change the copy, Options.Apply(copy).
        // The file is user-global; no path is ever returned.
        private McpEditorSetOptionResult SetEditorOption(McpEditorSetOption request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Option parameters are required.");
            var name = request.Name;
            if (!string.Equals(name, "AutoReloadScriptsOnMainWindowFocus", StringComparison.Ordinal) && !string.Equals(name, "ForceScriptCompilationOnStartup", StringComparison.Ordinal))
                throw new McpProtocolException("INVALID_REQUEST", "Name must be AutoReloadScriptsOnMainWindowFocus or ForceScriptCompilationOnStartup.");
            var editor = FEditor.Instance;
            var general = editor.Options.Options.General;
            var previous = string.Equals(name, "AutoReloadScriptsOnMainWindowFocus", StringComparison.Ordinal) ? general.AutoReloadScriptsOnMainWindowFocus : general.ForceScriptCompilationOnStartup;
            var result = new McpEditorSetOptionResult { Name = name, Previous = previous, Value = request.Value, Changed = previous != request.Value, DryRun = request.DryRun };
            if (request.DryRun) return result;
            if (!request.Confirm)
                throw new McpProtocolException("INVALID_REQUEST", "Changing an Editor option is user-global and needs Confirm:true (or DryRun:true to preview).");
            var optionsWindow = editor.Windows == null ? null : editor.Windows.EditorOptionsWin;
            if (optionsWindow != null && !optionsWindow.IsHidden)
                throw new McpProtocolException("EDITOR_BUSY", "The Editor Options window is open. Close it first so it cannot overwrite the change.");
            if (!result.Changed) return result;
            var copy = FlaxEngine.Utilities.Extensions.DeepClone(editor.Options.Options);
            if (string.Equals(name, "AutoReloadScriptsOnMainWindowFocus", StringComparison.Ordinal)) copy.General.AutoReloadScriptsOnMainWindowFocus = request.Value;
            else copy.General.ForceScriptCompilationOnStartup = request.Value;
            editor.Options.Apply(copy);
            return result;
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

        // Bridge v23: play-mode time scale control via the public
        // FlaxEngine.Time.TimeScale property (float, get/set; default 1).
        // Requires play mode (INVALID_STATE otherwise, same as play.pause).
        // Range 0..10 (VALIDATION_FAILED outside); 0 = frozen is legitimate
        // for frame-step debugging. The bridge never resets TimeScale on
        // play_stop: the value is engine-global and persists until changed
        // or until play stops (Flax owns play lifecycle cleanup; always set
        // explicitly after play start rather than assuming it survived).
        private McpPlayStatus SetPlayTimeScale(McpTimeScaleRequest request)
        {
            if (!FEditor.Instance.StateMachine.IsPlayMode) throw new McpProtocolException("INVALID_STATE", "Editor must be in play mode to set time scale.");
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Time scale parameters are required.");
            if (float.IsNaN(request.TimeScale) || float.IsInfinity(request.TimeScale) || request.TimeScale < 0.0f || request.TimeScale > 10.0f) throw new McpProtocolException("VALIDATION_FAILED", "TimeScale must be between 0 and 10.");
            Time.TimeScale = request.TimeScale;
            return PlayStatus();
        }

        // Bridge v27: engine-side performance snapshot (read-only, single
        // instantaneous sample, no history or averaging). All fields are
        // primitive/nullable and null means the backing API had no data.
        //
        // SDK truth (Flax 1.12, verified against Source/Engine headers plus
        // the shipped FlaxEngine.CSharp.xml):
        // - Fps: FlaxEngine.Engine.FramesPerSecond (Source/Engine/Engine/
        //   Engine.h API_PROPERTY GetFramesPerSecond — frames rendered during
        //   the last second). Outside play mode this is the editor viewport
        //   rendering rate (editor-idle FPS), not game FPS.
        // - FrameTimeMs: FlaxEngine.Time.UnscaledDeltaTime * 1000
        //   (Source/Engine/Engine/Time.h API_PROPERTY — TimeScale-independent
        //   last-frame delta, so play_set_time_scale never distorts it).
        // - DrawCalls/Triangles: FlaxEngine.ProfilingTools.Stats.DrawStats
        //   (Source/Engine/Profiler/ProfilingTools.h API_FIELD ReadOnly
        //   MainStats Stats, updated every frame with the last rendered
        //   frame RenderStatsData). NOTE: ProfilerGPU.GetLastFrameData was
        //   evaluated and rejected: its C++ (float&, float&,
        //   RenderStatsData&) refs bind by value in C#
        //   (FlaxEngine.CSharp.xml
        //   M:FlaxEngine.ProfilerGPU.GetLastFrameData(Single,Single,
        //   RenderStatsData) — no byref markers, and both out and ref fail
        //   with CS1615), so managed code cannot receive its outputs.
        //   Stats.DrawStats is the only public managed path to
        //   RenderStatsData. MainStats is only populated while the profiler
        //   session counts frames, so Stats.FPS is its own freshness signal,
        //   and an all-zero DrawStats beside FPS > 0 is self-contradictory
        //   (every presented frame issues draw calls): it positively means
        //   "no valid sample right now", so both stay null. Headless editors
        //   render nothing, so both stay null there (same gate as the GPU
        //   device fields below).
        // - ManagedMemoryBytes: System.GC.GetTotalMemory(false) (BCL, no
        //   induced collection; always available, in and out of play).
        // - ActorCount: FlaxEngine.Level.GetActors(typeof(Actor), false)
        //   (the same public enumeration the bridge validation scans use;
        //   one call, includes inactive actors, works in and out of play).
        // - GpuAdapter: FlaxEngine.GPUDevice.Instance.Adapter.Description
        //   (Source/Engine/Graphics/GPUDevice.h API_PROPERTY GetAdapter plus
        //   GPUAdapter.h API_PROPERTY GetDescription, capped at 256 chars).
        // - RendererType: FlaxEngine.GPUDevice.Instance.RendererType
        //   (GPUDevice.h API_PROPERTY GetRendererType). Headless editors have
        //   no GPU device, so both GPU fields stay null without throwing.
        private McpPerfSnapshot PerfSnapshot()
        {
            var snapshot = new McpPerfSnapshot
            {
                IsPlayMode = FEditor.IsPlayMode,
                TimestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            var headless = false;
            try { headless = FEditor.Instance.IsHeadlessMode; }
            catch { }
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
            if (!headless)
            {
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
            }
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
                if (headless) return snapshot;
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
            var result = new McpPerfGpuEvents { IsPlayMode = FEditor.IsPlayMode, TimestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Events = new McpPerfGpuEvent[0] };
            try { result.FrameCount = (long)Engine.FrameCount; }
            catch { }
            var headless = false;
            try { headless = FEditor.Instance.IsHeadlessMode; }
            catch { }
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

        // Bridge v26: play-mode input simulation (managed-Flax-API-only scope).
        //
        // SDK truth (Flax 1.12, verified against Source/Engine/Input/Input.h,
        // Keyboard.h, Mouse.h, FlaxEngine.CSharp.xml, plus a compile probe
        // against the shipped FlaxEngine.CSharp.dll):
        // - FlaxEngine.Input exposes only READ state to C#: GetKey/GetKeyDown/
        //   GetKeyUp, GetMouseButton/GetMouseButtonDown/GetMouseButtonUp,
        //   GetAction/GetAxis, plus engine-raised events (KeyDown/KeyUp,
        //   MouseDown/MouseUp, ActionTriggered).
        // - Keyboard.OnKeyDown/OnKeyUp and Mouse.OnMouseDown/OnMouseUp exist in
        //   C++ but carry no API_FUNCTION(), so they are NOT bound to C#. The
        //   probe confirmed: 'Keyboard' has no 'OnKeyDown' (CS1061), 'Mouse'
        //   has no 'OnMouseDown' (CS1061), and 'Input.KeyDown' may only appear
        //   on the left of += or -= (CS0079) — managed code cannot raise the
        //   engine's input events either.
        // - No Simulate/Inject/Post input method exists anywhere under
        //   Source/Engine/Input or Source/Editor. The only managed-verified
        //   cursor primitive is the Input.MousePosition setter (native
        //   SetMousePosition API_PROPERTY), which moves the cursor but cannot
        //   press buttons; viewport-normalized mapping additionally has no
        //   verified managed game-viewport-rect API in play-in-editor.
        // Therefore key presses and mouse button clicks cannot be synthesized
        // from purely managed Flax API. OS-level input injection, native
        // P/Invoke, child processes, and every other unmanaged escape stay
        // FORBIDDEN: the
        // bridge never leaves managed Flax API for input.
        // Both methods below enforce the play gate + full parameter validation
        // so callers get actionable errors, then report a stable
        // UNSUPPORTED_FLAX_VERSION capability (same pattern as
        // navigation.build/lighting.bake). HoldMs is validated (0..2000,
        // default 50) so the contract is stable for a future managed
        // primitive; the intended release design is a Scripting.Update frame
        // countdown (OnUpdate is already subscribed) — never blocking the main
        // thread — with guaranteed key release even if the caller
        // disconnects.
        private const int MaxInputKeyChars = 64;
        private const int MaxInputHoldMs = 2000;

        private void RequireRunningPlayForInput()
        {
            // Key presses while paused do nothing in Flax, so running
            // (not paused) play is required. Headless needs no separate gate:
            // play cannot start headless, so the play check covers it.
            if (!FEditor.Instance.StateMachine.IsPlayMode || FEditor.Instance.StateMachine.PlayingState.IsPaused) throw new McpProtocolException("INVALID_STATE", "Editor must be running play (not paused) to simulate input.");
        }

        private static KeyboardKeys ParseInputKey(string key)
        {
            var name = key == null ? "" : key.Trim();
            if (name.Length == 0 || name.Length > MaxInputKeyChars || !char.IsLetter(name[0])) throw new McpProtocolException("VALIDATION_FAILED", "Key must name a FlaxEngine.KeyboardKeys member (1-64 characters, case-insensitive).");
            KeyboardKeys parsed;
            // Enum.TryParse also accepts raw numeric strings; game keys are names only.
            if (!Enum.TryParse<KeyboardKeys>(name, true, out parsed) || !Enum.IsDefined(typeof(KeyboardKeys), parsed) || parsed == KeyboardKeys.None || parsed == KeyboardKeys.MAX) throw new McpProtocolException("VALIDATION_FAILED", "Key must name a FlaxEngine.KeyboardKeys member (1-64 characters, case-insensitive).");
            return parsed;
        }

        private static MouseButton ParseInputButton(string button)
        {
            var name = string.IsNullOrEmpty(button) ? "Left" : button.Trim();
            MouseButton parsed;
            if (!Enum.TryParse<MouseButton>(name, true, out parsed) || !Enum.IsDefined(typeof(MouseButton), parsed) || (parsed != MouseButton.Left && parsed != MouseButton.Right && parsed != MouseButton.Middle)) throw new McpProtocolException("VALIDATION_FAILED", "Button must be Left, Right, or Middle.");
            return parsed;
        }

        private static void ValidateInputHoldMs(int holdMs)
        {
            if (holdMs < 0 || holdMs > MaxInputHoldMs) throw new McpProtocolException("VALIDATION_FAILED", "HoldMs must be between 0 and 2000 milliseconds.");
        }

        private static void ValidateInputViewport(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value) || value < 0.0 || value > 1.0) throw new McpProtocolException("VALIDATION_FAILED", "X and Y must be viewport-normalized coordinates in [0,1].");
        }

        private object SimulateKeyPress(McpKeyPress request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Key press parameters are required.");
            RequireRunningPlayForInput();
            ParseInputKey(request.Key);
            ValidateInputHoldMs(request.HoldMs);
            throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "Key press injection has no verified managed Flax 1.12 API: FlaxEngine.Input exposes only read state (GetKey/GetKeyDown/GetKeyUp) and engine-raised events that C# cannot raise, and Keyboard.OnKeyDown is not bound to C#. The bridge stays managed-Flax-API-only and never uses OS-level input injection.", new { Capability = "input_key_press", BridgeVersion = BridgeVersion });
        }

        private object SimulateMouseClick(McpMouseClick request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Mouse click parameters are required.");
            RequireRunningPlayForInput();
            ParseInputButton(request.Button);
            ValidateInputViewport(request.X);
            ValidateInputViewport(request.Y);
            ValidateInputHoldMs(request.HoldMs);
            throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "Mouse button injection has no verified managed Flax 1.12 API: Mouse.OnMouseDown/OnMouseUp are not bound to C#, engine input events cannot be raised from C#, and viewport-normalized mapping has no verified managed game-viewport-rect API. The bridge stays managed-Flax-API-only and never uses OS-level input injection.", new { Capability = "input_mouse_click", BridgeVersion = BridgeVersion });
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
            var viewportName = (request.Viewport ?? "game").Trim().ToLowerInvariant();
            bool isEditor;
            if (viewportName.Length == 0 || viewportName == "game" || viewportName == "main") isEditor = false;
            else if (viewportName == "editor" || viewportName == "edit") isEditor = true;
            else throw new McpProtocolException("VALIDATION_FAILED", "Viewport must be 'game' or 'editor'.");
            if (request.Width != 0 || request.Height != 0)
                throw new McpProtocolException("VALIDATION_FAILED", "Custom capture dimensions are not supported by Flax 1.12 main-render capture.");
            SceneRenderTask editorTask = null;
            if (isEditor)
            {
                // Editor viewport renders the level-editing view through its own
                // SceneRenderTask and works outside play mode (see
                // WindowsModule.TakeScreenshot which captures EditWin.Viewport.Task).
                var editWin = FEditor.Instance.Windows != null ? FEditor.Instance.Windows.EditWin : null;
                editorTask = editWin != null && editWin.Viewport != null ? editWin.Viewport.Task : null;
                if (editorTask == null)
                    throw new McpProtocolException("CAPTURE_UNAVAILABLE", "Editor viewport is unavailable. Show the editor window and retry.");
            }
            else if (!FEditor.IsPlayMode)
            {
                throw new McpProtocolException("INVALID_STATE", "Game viewport capture requires play mode. Use viewport 'editor' to capture outside play mode.");
            }
            // Keep both the bridge-session status map and the cache directory bounded
            // before allocating a new GPU readback target.
            CleanupCaptures(MaxCaptures - 1);
            var id = Guid.NewGuid().ToString("N");
            var path = Path.Combine(Captures, id + ".png");
            var item = new McpCaptureStatus { CaptureId = id, Phase = "Pending", Path = "Cache/MCP/captures/" + id + ".png", StartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            lock (_stateLock) _captures[id] = item;
            // Flax may finish GPU readback one or more frames later. The status call
            // observes the fixed, bridge-owned file instead of blocking this callback.
            if (isEditor) Screenshot.Capture(editorTask, path);
            else Screenshot.Capture(path);
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
            // Saving while game scripts are still compiling (or the scripting
            // domain is reloading after a compile) flushes unresolved script
            // values and dangling asset references as defaults/empty GUIDs,
            // silently corrupting the file. Refuse instead of flushing: the
            // caller retries once scripts are ready. Behavior-grounded:
            // a scene loaded during startup compilation held default script
            // values in memory, and the first save in that window dropped
            // tuned nested-struct fields and zeroed material slots on disk.
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", "Scene saves are unavailable while game scripts are compiling or reloading. Retry once compilation finishes; saving now could flush unresolved script values.");
            var beforeLines = ReadSceneDiskLines(scene);
            FEditor.Instance.Scene.SaveScene(scene);
            var result = SceneRef(scene);
            var report = DiffSceneDiskLines(scene, beforeLines);
            if (!string.IsNullOrEmpty(report))
                result.SaveReport = report;
            return result;
        }

        // Bridge v25 canonical scene.open. Loads one Content scene asset
        // (FlaxEngine.SceneAsset only, selected by exactly one AssetId/Path
        // like asset.get) through the verified public
        // FlaxEngine.Level.LoadSceneAsync(Guid) API (see
        // FlaxEngine.CSharp.xml M:FlaxEngine.Level.LoadSceneAsync(Guid):
        // loads the scene in the background, returns true only when loading
        // cannot be done). The load is async, so a started load returns
        // Phase "opening" immediately and the caller polls scene.list_loaded;
        // an already-loaded scene returns Phase "already_loaded" without
        // touching the editor. All safety gates hold unconditionally,
        // including for the already-loaded no-op: play mode or a requested
        // play start (INVALID_STATE), compiling/reloading scripts
        // (EDITOR_BUSY, same ScriptsBuilder check the scene-save path uses),
        // any active bridge edit lease (EDIT_LEASE_ACTIVE, same lease-table
        // check play start uses), and edited loaded scenes (DIRTY_SCENE
        // listing dirty scene names unless AllowDirtyScenes is explicit,
        // mirroring the play-start gate convention).
        //
        // Bridge v34 adds two non-additive modes that both run through the
        // Editor scene state machine (FlaxEditor.States.ChangingScenesState),
        // the path SceneModule.OpenScene/CloseScene take, minus their modal
        // "save before closing?" prompt (SceneModule.CheckSaveBeforeClose):
        // the bridge refuses edited scenes with DIRTY_SCENE instead and only
        // DiscardUnsaved drops their edits (AllowDirtyScenes never discards).
        // Replace = SceneModule.OpenScene(id, additive: false); Reload re-reads
        // the scene file (see ReloadSceneFromDisk).
        private object OpenScene(McpSceneOpen request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Scene open parameters are required.");
            ValidateAssetSelector(request.AssetId, request.Path);
            if (request.Replace && request.Reload)
                throw new McpProtocolException("VALIDATION_FAILED", "Replace and Reload are mutually exclusive.");
            if (request.DiscardUnsaved && !request.Replace && !request.Reload)
                throw new McpProtocolException("VALIDATION_FAILED", "DiscardUnsaved applies only to Replace or Reload; an additive open never unloads a scene.");
            var editor = FEditor.Instance;
            if (FEditor.IsPlayMode || editor.Simulation.IsPlayModeRequested)
                throw new McpProtocolException("INVALID_STATE", "Scene open is unavailable while the editor is in play mode or play was requested.");
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", "Scene open is unavailable while game scripts are compiling or reloading. Retry once compilation finishes.");
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = request.AssetId, Path = request.Path }, BuildAssetRegistry());
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.SceneAsset", StringComparison.Ordinal))
                throw new McpProtocolException("ASSET_NOT_FOUND", "The selected asset is not a scene asset: " + record.Path, new McpSceneOpenTypeDetails { TypeName = record.Info.TypeName });
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (_sceneLeases.Count > 0) throw new McpProtocolException("EDIT_LEASE_ACTIVE", "Cannot open a scene while an edit lease is active. Commit or release the lease first.", ActiveLeasesDetailsLocked());
                if (_pendingSceneReload != null) throw new McpProtocolException("EDITOR_BUSY", "A scene reload is still in progress. Poll scene_list_loaded and retry once it finished.");
            }
            if (request.Replace) return ReplaceScenes(record, request.DiscardUnsaved);
            var reloadLoaded = request.Reload ? Level.FindScene(record.Id) : null;
            if (reloadLoaded != null) return ReloadSceneFromDisk(record, reloadLoaded, request.DiscardUnsaved);
            if (!request.AllowDirtyScenes)
            {
                var dirty = DirtyLoadedSceneNames();
                if (dirty.Length > 0) throw new McpProtocolException("DIRTY_SCENE", "Edited scenes must be saved or AllowDirtyScenes:true must be explicit before opening a scene: " + string.Join(", ", dirty), new McpSceneOpenDirtyDetails { DirtyScenes = dirty });
            }
            if (request.Reload) return ReloadSceneFromDisk(record, null, request.DiscardUnsaved);
            var existing = Level.FindScene(record.Id);
            if (existing != null) return new McpSceneOpenResult { SceneId = existing.ID.ToString("N"), Phase = "already_loaded" };
            if (Level.LoadSceneAsync(record.Id))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not start loading the scene asset: " + record.Path);
            return new McpSceneOpenResult { SceneId = record.Id.ToString("N"), Phase = "opening" };
        }

        // scene.open Replace: SceneModule.OpenScene(sceneId, additive: false)
        // is ChangingScenesState.LoadScene(id, additive: false), which is
        // ChangeScenes([id], every loaded scene). The bridge passes the other
        // loaded scenes only: when the target is already loaded, TryEnter
        // drops it from the load list (and would cancel it if it were in both
        // lists), so only the others are closed. Scenes that would be unloaded
        // with unsaved edits are refused unless DiscardUnsaved is explicit.
        private McpSceneOpenResult ReplaceScenes(McpAssetRecord record, bool discardUnsaved)
        {
            var editor = FEditor.Instance;
            RequireSceneChangeState(editor);
            var target = Level.FindScene(record.Id);
            var others = new List<Scene>();
            foreach (var scene in Level.Scenes)
                if (scene != null && scene.ID != record.Id) others.Add(scene);
            var unloaded = new string[others.Count];
            var dirty = new List<string>();
            for (var i = 0; i < others.Count; i++)
            {
                unloaded[i] = others[i].ID.ToString("N");
                if (editor.Scene.IsEdited(others[i])) dirty.Add(others[i].Name ?? unloaded[i]);
            }
            if (dirty.Count > 0 && !discardUnsaved)
                throw new McpProtocolException("DIRTY_SCENE", "Replace would unload edited scenes. Save them with scene_save, or pass DiscardUnsaved:true to drop their edits (AllowDirtyScenes does not discard): " + string.Join(", ", dirty), new McpSceneOpenDirtyDetails { DirtyScenes = dirty.ToArray() });
            if (target != null && others.Count == 0)
                return new McpSceneOpenResult { SceneId = record.Id.ToString("N"), Phase = "already_loaded", UnloadedSceneIds = unloaded };
            // CheckSaveBeforeClose ends with this when the change goes ahead.
            editor.Scene.ClearRefsToSceneObjects();
            editor.StateMachine.ChangingScenesState.ChangeScenes(new[] { record.Id }, others);
            RequireSceneChangeStarted(editor, record);
            AdvanceProjectRevision();
            return new McpSceneOpenResult { SceneId = record.Id.ToString("N"), Phase = "replacing", UnloadedSceneIds = unloaded };
        }

        // scene.open Reload re-reads a scene from its file. Live-verified on
        // Flax 1.12: the SceneAsset stays cached in Content after the scene
        // unloads (any managed Content.GetAsset pins it), so a plain close and
        // open, Level.UnloadScene + LoadScene, the Editor "Reload scenes"
        // command, and a same-scene ChangeScenes all rebuild the scene from the
        // stale cached data. The cached asset is therefore reloaded first, by
        // ID only (Content.GetAsset(Guid) returns it only when it is loaded;
        // the path-based lookups can re-register a file under a new ID), which
        // is safe while the scene is still loaded. Then the scene itself is
        // reloaded through the state machine:
        // - the only loaded scene: ChangeScenes([id], [scene]) (TryEnter keeps
        //   a scene listed in both lists only when exactly one is loaded);
        // - several loaded scenes: UnloadScene(scene), and once that finished
        //   (a later frame), LoadScene(id, additive: true);
        // - a scene that is not loaded: the normal additive open.
        // DiskSha256 is the SHA-256 of the scene file as read for this request.
        private McpSceneOpenResult ReloadSceneFromDisk(McpAssetRecord record, Scene loaded, bool discardUnsaved)
        {
            var editor = FEditor.Instance;
            if (loaded != null)
            {
                RequireSceneChangeState(editor);
                if (editor.Scene.IsEdited(loaded) && !discardUnsaved)
                {
                    var name = loaded.Name ?? record.Id.ToString("N");
                    throw new McpProtocolException("DIRTY_SCENE", "Reload replaces the loaded scene with the file on disk and would drop its unsaved edits. Save it with scene_save, or pass DiscardUnsaved:true to drop them: " + name, new McpSceneOpenDirtyDetails { DirtyScenes = new[] { name } });
                }
            }
            var sha256 = SceneFileSha256(record);
            Asset cached = null;
            try { cached = Content.GetAsset(record.Id); }
            catch { cached = null; }
            if (cached != null)
            {
                try { cached.Reload(); }
                catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax could not reload the cached scene asset " + record.Path + ": " + DescribeException(ex)); }
            }
            var result = new McpSceneOpenResult { SceneId = record.Id.ToString("N"), Phase = "reloading", UnloadedSceneIds = new string[0], DiskSha256 = sha256 };
            if (loaded == null)
            {
                if (Level.LoadSceneAsync(record.Id))
                    throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not start loading the scene asset: " + record.Path);
                return result;
            }
            var single = Level.ScenesCount == 1;
            editor.Scene.ClearRefsToSceneObjects();
            if (single) editor.StateMachine.ChangingScenesState.ChangeScenes(new[] { record.Id }, new[] { loaded });
            else editor.StateMachine.ChangingScenesState.UnloadScene(loaded);
            RequireSceneChangeStarted(editor, record);
            if (!single) ArmPendingSceneReload(record.Id);
            AdvanceProjectRevision();
            return result;
        }

        private static void RequireSceneChangeState(FEditor editor)
        {
            var state = editor.StateMachine.CurrentState;
            if (state == null || !state.CanChangeScene)
                throw new McpProtocolException("EDITOR_BUSY", "The editor cannot change scenes in its current state" + (state == null ? "." : " (" + state.GetType().Name + ")."));
        }

        // ChangingScenesState.OnEnter falls straight back to the editing
        // state ("Cannot perform scene change") when no load or unload could
        // be started; the bridge reports that instead of a phase.
        private static void RequireSceneChangeStarted(FEditor editor, McpAssetRecord record)
        {
            if (!ReferenceEquals(editor.StateMachine.CurrentState, editor.StateMachine.ChangingScenesState))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor did not start the scene change for " + record.Path + " (see the Editor log).");
        }

        private static string SceneFileSha256(McpAssetRecord record)
        {
            try
            {
                var path = record.Info.Path;
                if (string.IsNullOrEmpty(path)) path = record.Path;
                if (!Path.IsPathRooted(path)) path = Path.Combine(Globals.ProjectFolder, path);
                byte[] bytes;
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var hash = SHA256.Create())
                    bytes = hash.ComputeHash(stream);
                var builder = new StringBuilder(bytes.Length * 2);
                foreach (var value in bytes) builder.Append(value.ToString("x2"));
                return builder.ToString();
            }
            catch (Exception ex)
            {
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "The scene file could not be read for a reload: " + record.Path + " (" + ex.GetType().Name + ").");
            }
        }

        // Second step of a multi-scene reload. ChangingScenesState finishes an
        // unload from Level.SceneUnloaded on a later frame, so the additive
        // load is issued from a short-lived poller that checks once per update
        // on the main thread (Scripting.RunOnUpdate). A scene.open arriving in
        // between is refused with EDITOR_BUSY.
        private sealed class PendingSceneReload { public Guid SceneId; public long DeadlineTick; }
        private PendingSceneReload _pendingSceneReload; // guarded by _stateLock
        private const int SceneReloadTimeoutMs = 60 * 1000;
        private const int SceneReloadPollMs = 50;

        private void ArmPendingSceneReload(Guid sceneId)
        {
            var pending = new PendingSceneReload { SceneId = sceneId, DeadlineTick = Environment.TickCount64 + SceneReloadTimeoutMs };
            lock (_stateLock) _pendingSceneReload = pending;
            Task.Run(() => DrivePendingSceneReload(pending));
        }

        private void DrivePendingSceneReload(PendingSceneReload pending)
        {
            try
            {
                while (_running && Environment.TickCount64 < pending.DeadlineTick)
                {
                    Task.Delay(SceneReloadPollMs).Wait();
                    var finished = false;
                    var step = Scripting.RunOnUpdate(() => { finished = StepPendingSceneReload(pending); });
                    if (step.Wait(MainThreadTimeoutMs) && finished) return;
                }
                Debug.LogWarning("[Flax MCP] scene.open Reload stopped waiting to load scene " + pending.SceneId.ToString("N") + " again; open it with scene_open.");
            }
            catch (Exception ex) { Debug.LogWarning("[Flax MCP] scene.open Reload failed to load the scene again: " + ex.Message); }
            finally
            {
                lock (_stateLock) { if (ReferenceEquals(_pendingSceneReload, pending)) _pendingSceneReload = null; }
            }
        }

        // Main thread. True when the reload is finished (loaded or abandoned).
        private static bool StepPendingSceneReload(PendingSceneReload pending)
        {
            try
            {
                var editor = FEditor.Instance;
                if (editor == null) return true;
                // The close has not finished yet (or someone else loaded the scene).
                if (Level.FindScene(pending.SceneId) != null) return false;
                var state = editor.StateMachine.CurrentState;
                if (state == null || !state.CanChangeScene) return false;
                if (FEditor.IsPlayMode || editor.Simulation.IsPlayModeRequested)
                {
                    Debug.LogWarning("[Flax MCP] scene.open Reload: play mode started before scene " + pending.SceneId.ToString("N") + " was loaded again; open it with scene_open.");
                    return true;
                }
                editor.StateMachine.ChangingScenesState.LoadScene(pending.SceneId, true);
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[Flax MCP] scene.open Reload failed to load the scene again: " + ex.Message);
                return true;
            }
        }

        private static string[] DirtyLoadedSceneNames()
        {
            var dirty = new List<string>();
            for (var i = 0; i < Level.ScenesCount; i++)
            {
                var scene = Level.GetScene(i);
                if (scene == null) continue;
                if (FEditor.Instance.Scene.IsEdited(scene))
                    dirty.Add(scene.Name ?? scene.ID.ToString("N"));
            }
            return dirty.ToArray();
        }

        // Best-effort post-save change report: compares the scene file on
        // disk before/after the save and summarizes removed lines, so a
        // caller can spot serializer-dropped fields (values equal to C#
        // defaults are omitted on write; dangling asset refs flush as empty)
        // instead of discovering the loss in a later diff. Never fails the
        // save: reporting errors are swallowed.
        private static string[] ReadSceneDiskLines(Scene scene)
        {
            try
            {
                var path = SceneAssetDiskPath(scene);
                if (path == null) return null;
                return File.ReadAllLines(path);
            }
            catch { return null; }
        }

        private static string SceneAssetDiskPath(Scene scene)
        {
            try
            {
                if (scene == null || string.IsNullOrEmpty(scene.Path)) return null;
                var full = Path.IsPathRooted(scene.Path) ? Path.GetFullPath(scene.Path) : Path.GetFullPath(Path.Combine(Globals.ProjectFolder, scene.Path));
                if (!File.Exists(full)) return null;
                return full;
            }
            catch { return null; }
        }

        private static string DiffSceneDiskLines(Scene scene, string[] beforeLines)
        {
            try
            {
                if (beforeLines == null) return null;
                var afterLines = ReadSceneDiskLines(scene);
                if (afterLines == null) return null;
                var after = new HashSet<string>();
                foreach (var line in afterLines) after.Add(line.Trim().TrimEnd(','));
                var removedKeys = new List<string>();
                foreach (var line in beforeLines)
                {
                    var t = line.Trim().TrimEnd(',');
                    if (after.Contains(t)) continue;
                    if (!t.StartsWith("\"")) continue;
                    var end = t.IndexOf('"', 1);
                    if (end <= 1) continue;
                    var key = t.Substring(1, end - 1);
                    if (key == "ID" || key == "ParentID" || key == "TypeName" || key == "Name") continue;
                    if (!removedKeys.Contains(key)) removedKeys.Add(key);
                    if (removedKeys.Count >= 12) break;
                }
                var delta = beforeLines.Length - afterLines.Length;
                if (removedKeys.Count == 0) return null;
                var msg = "Post-save disk check: " + removedKeys.Count + " keyed lines present before the save are gone after it (" + delta + " net fewer lines).";
                msg += " Removed keys sample: " + string.Join(", ", removedKeys.ToArray()) + ". Values equal to C# defaults are omitted by the scene serializer and dangling asset refs flush as empty: verify tuned fields if any listed key was intentional.";
                return msg;
            }
            catch { return null; }
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
                // Component asset assignments run INSIDE the undo action so a
                // model/graph swap is revertible with a single edit.undo.
                // (Previously they ran after RecordAction, so undo could not
                // restore the previous asset and multi-step recovery was needed.)
                if (HasActorComponentAssignments(p))
                    ApplyActorComponentAssignments(actor, p);
                MarkEdited(actor);
            });
            AdvanceSceneRevision(actor.Scene);
            return ActorDto(actor, false);
        }

        private static bool HasActorComponentAssignments(McpActorUpdate p)
        {
            return !string.IsNullOrEmpty(p.SkinnedModelId) || !string.IsNullOrEmpty(p.SkinnedModelPath)
                || !string.IsNullOrEmpty(p.AnimationGraphId) || !string.IsNullOrEmpty(p.AnimationGraphPath)
                || !string.IsNullOrEmpty(p.StaticModelId) || !string.IsNullOrEmpty(p.StaticModelPath)
                || p.UpdateWhenOffscreen.HasValue;
        }

        private static void ApplyActorComponentAssignments(Actor actor, McpActorUpdate p)
        {
            var animated = actor as AnimatedModel;
            if (animated != null)
            {
                if (!string.IsNullOrEmpty(p.SkinnedModelId) || !string.IsNullOrEmpty(p.SkinnedModelPath))
                    animated.SkinnedModel = LoadActorSkinnedModelAsset(p.SkinnedModelId, p.SkinnedModelPath);
                if (!string.IsNullOrEmpty(p.AnimationGraphId) || !string.IsNullOrEmpty(p.AnimationGraphPath))
                    animated.AnimationGraph = LoadContentAsset<AnimationGraph>(p.AnimationGraphId, p.AnimationGraphPath);
                if (p.UpdateWhenOffscreen.HasValue)
                    animated.UpdateWhenOffscreen = p.UpdateWhenOffscreen.Value;
            }

            var staticModel = actor as StaticModel;
            if (staticModel != null && (!string.IsNullOrEmpty(p.StaticModelId) || !string.IsNullOrEmpty(p.StaticModelPath)))
                staticModel.Model = LoadContentAsset<Model>(p.StaticModelId, p.StaticModelPath);

            if (animated == null && staticModel == null)
            {
                var hasAnimatedFields = !string.IsNullOrEmpty(p.SkinnedModelId) || !string.IsNullOrEmpty(p.SkinnedModelPath)
                    || !string.IsNullOrEmpty(p.AnimationGraphId) || !string.IsNullOrEmpty(p.AnimationGraphPath)
                    || p.UpdateWhenOffscreen.HasValue;
                var hasStaticFields = !string.IsNullOrEmpty(p.StaticModelId) || !string.IsNullOrEmpty(p.StaticModelPath);
                if (hasAnimatedFields || hasStaticFields)
                    throw new McpProtocolException("VALIDATION_FAILED", "Component asset assignments require FlaxEngine.AnimatedModel or FlaxEngine.StaticModel.");
            }
        }

        private static SkinnedModel LoadActorSkinnedModelAsset(string assetId, string assetPath)
        {
            ValidateAssetSelector(assetId, assetPath);
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = assetId, Path = assetPath }, BuildAssetRegistry());
            return LoadSkinnedModelFromRecord(record);
        }

        // Record-first overload: SetGraphBaseModel already resolved + type-checked
        // the model record, so reuse it instead of rebuilding the asset registry
        // and resolving a second time (P7 review: one BuildAssetRegistry per call).
        private static SkinnedModel LoadSkinnedModelFromRecord(McpAssetRecord record)
        {
            // Path fallbacks use the engine's own spelling only (EngineAssetPath): any other
            // spelling makes Flax re-register the file under a new asset ID.
            var enginePath = EngineAssetPathForRecord(record);

            SkinnedModel skinned = Content.LoadAsync<SkinnedModel>(record.Id);
            if (skinned == null && enginePath != null)
                skinned = Content.LoadAsync<SkinnedModel>(enginePath);
            if (skinned == null)
            {
                var model = Content.LoadAsync<Model>(record.Id) ?? (enginePath == null ? null : Content.LoadAsync<Model>(enginePath));
                if (model != null && !(model.WaitForLoaded(30000) || model.LastLoadFailed))
                    throw new McpProtocolException("VALIDATION_FAILED", "Asset is a static Model, not a SkinnedModel. Reimport the source FBX with model type Skinned Model: " + record.Path);
            }
            if (skinned == null)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Skinned model asset could not be loaded: " + record.Path);
            if (skinned.WaitForLoaded(30000) || skinned.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Skinned model asset failed to load: " + record.Path);
            // P1a audit: path-based load can resolve an inner asset whose file ID differs from the registry record (see docs/GUID_AUDIT_P7.md: native-vs-.NET Guid convention); reject the mismatch.
            if (skinned.ID != record.Id)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "registry/file ID mismatch: expected " + record.Id.ToString("N") + " got " + skinned.ID.ToString("N") + " (" + record.Path + ")");
            return skinned;
        }

        private static Model LoadActorModelAsset(string assetId, string assetPath)
        {
            ValidateAssetSelector(assetId, assetPath);
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = assetId, Path = assetPath }, BuildAssetRegistry());
            var model = Content.LoadAsync<Model>(record.Id);
            if (model == null)
            {
                var enginePath = EngineAssetPathForRecord(record);
                if (enginePath != null) model = Content.LoadAsync<Model>(enginePath);
            }
            if (model == null)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Model asset could not be loaded: " + record.Path);
            if (model.WaitForLoaded(30000) || model.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Model asset failed to load: " + record.Path);
            // P1a audit: path-based load can resolve an inner asset whose file ID differs from the registry record (see docs/GUID_AUDIT_P7.md: native-vs-.NET Guid convention); reject the mismatch.
            if (model.ID != record.Id)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "registry/file ID mismatch: expected " + record.Id.ToString("N") + " got " + model.ID.ToString("N") + " (" + record.Path + ")");
            return model;
        }

        private static T LoadContentAsset<T>(string assetId, string assetPath) where T : Asset
        {
            ValidateAssetSelector(assetId, assetPath);
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = assetId, Path = assetPath }, BuildAssetRegistry());
            var asset = Content.LoadAsync<T>(record.Id);
            if (asset == null)
            {
                var enginePath = EngineAssetPathForRecord(record);
                if (enginePath != null) asset = Content.LoadAsync<T>(enginePath);
            }
            if (asset == null)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Content asset could not be loaded: " + record.Path);
            if (asset.WaitForLoaded(30000) || asset.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Content asset failed to load: " + record.Path);
            // P1a audit: path-based load can resolve an inner asset whose file ID differs from the registry record (see docs/GUID_AUDIT_P7.md: native-vs-.NET Guid convention); reject the mismatch.
            if (asset.ID != record.Id)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "registry/file ID mismatch: expected " + record.Id.ToString("N") + " got " + asset.ID.ToString("N") + " (" + record.Path + ")");
            return asset;
        }

        private static void ValidateActorUpdate(McpActorUpdate p)
        {
            if (p == null) throw new McpProtocolException("INVALID_REQUEST", "Actor update parameters are required.");
            var hasWorldTransform = p.Position != null || p.Scale != null || p.EulerAngles != null;
            var hasLocalTransform = p.LocalPosition != null || p.LocalScale != null || p.LocalEulerAngles != null;
            var hasComponentFields = !string.IsNullOrEmpty(p.SkinnedModelId) || !string.IsNullOrEmpty(p.SkinnedModelPath)
                || !string.IsNullOrEmpty(p.AnimationGraphId) || !string.IsNullOrEmpty(p.AnimationGraphPath)
                || !string.IsNullOrEmpty(p.StaticModelId) || !string.IsNullOrEmpty(p.StaticModelPath)
                || p.UpdateWhenOffscreen.HasValue;
            if (p.Name == null && !p.Active.HasValue && !hasWorldTransform && !hasLocalTransform && !p.Layer.HasValue && !hasComponentFields)
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
            if (!string.IsNullOrEmpty(p.SkinnedModelId) || !string.IsNullOrEmpty(p.SkinnedModelPath))
                ValidateAssetSelector(p.SkinnedModelId, p.SkinnedModelPath);
            if (!string.IsNullOrEmpty(p.AnimationGraphId) || !string.IsNullOrEmpty(p.AnimationGraphPath))
                ValidateAssetSelector(p.AnimationGraphId, p.AnimationGraphPath);
            if (!string.IsNullOrEmpty(p.StaticModelId) || !string.IsNullOrEmpty(p.StaticModelPath))
                ValidateAssetSelector(p.StaticModelId, p.StaticModelPath);
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

        // Bridge v24 editor selection. Selection is an edit-time concept backed
        // by the verified SceneEditingModule surface: the public
        // List<SceneGraphNode> Selection field, Select/Deselect, and the main
        // editor viewport FocusSelection (framing the current selection).
        // Empty selection is valid and returns an empty list, not an error.
        private const int MaxSelectionEntries = 200;

        private static void RequireEditorSelectionAvailable()
        {
            if (FEditor.Instance.IsHeadlessMode)
                throw new McpProtocolException("INVALID_STATE", "Editor selection is unavailable in headless editor mode.");
        }

        private static McpSelectionResult GetEditorSelection()
        {
            RequireEditorSelectionAvailable();
            var selection = FEditor.Instance.SceneEditing.Selection;
            var nodes = selection == null ? new SceneGraphNode[0] : selection.ToArray();
            var entries = new List<McpSelectionEntry>(Math.Min(nodes.Length, MaxSelectionEntries));
            foreach (var node in nodes)
            {
                if (entries.Count >= MaxSelectionEntries) break;
                var actorNode = node as ActorNode;
                var actor = actorNode == null ? null : actorNode.Actor;
                if (actor == null) continue;
                entries.Add(new McpSelectionEntry
                {
                    ActorId = actor.ID.ToString("N"),
                    Name = actor.Name,
                    SceneId = actor.Scene == null ? null : actor.Scene.ID.ToString("N"),
                });
            }
            return new McpSelectionResult { Selection = entries.ToArray(), Count = entries.Count };
        }

        private static McpSelectionResult SetEditorSelection(McpSelectionRequest request)
        {
            RequireEditorSelectionAvailable();
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Editor selection parameters are required.");
            if (request.ActorIds == null || request.ActorIds.Length == 0 || request.ActorIds.Length > MaxSelectionEntries)
                throw new McpProtocolException("VALIDATION_FAILED", "ActorIds must contain between 1 and 200 actor IDs.");
            // Resolve every actor before mutating so unknown IDs fail without
            // changing the current selection. Duplicates are collapsed so one
            // actor is never added to the selection twice.
            var actors = new List<Actor>(request.ActorIds.Length);
            var seen = new HashSet<string>();
            foreach (var id in request.ActorIds)
            {
                if (!IsGuidN(id)) throw new McpProtocolException("INVALID_REQUEST", "actorId must be a 32-character GUID.");
                var actor = RequireActor(id);
                var key = actor.ID.ToString("N");
                if (seen.Add(key)) actors.Add(actor);
            }
            // Resolve graph nodes up front: Select(nodes, additive:false) is the
            // verified replace path, independent of per-actor Select accumulation.
            var nodes = new List<SceneGraphNode>(actors.Count);
            foreach (var actor in actors)
            {
                var node = FEditor.Instance.Scene.GetActorNode(actor);
                if (node == null) throw new McpProtocolException("NOT_FOUND", "Actor is not present in the editor scene graph.");
                nodes.Add(node);
            }
            if (request.FocusViewport)
            {
                // Verify the viewport before mutating so a missing editor window
                // fails without changing the current selection.
                var windows = FEditor.Instance.Windows;
                var viewport = windows != null && windows.EditWin != null ? windows.EditWin.Viewport : null;
                if (viewport == null)
                    throw new McpProtocolException("INVALID_STATE", "Editor viewport is unavailable. Show the editor window and retry.");
            }
            var editing = FEditor.Instance.SceneEditing;
            editing.Select(nodes, false);
            if (request.FocusViewport)
                FEditor.Instance.Windows.EditWin.Viewport.FocusSelection();
            return GetEditorSelection();
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
            return ScriptInfoWithValues(script, false);
        }

        private McpScriptDto ScriptInfoWithValues(Script script, bool includeValues)
        {
            var scene = script.Actor == null ? null : script.Actor.Scene;
            var revision = CurrentRevision(scene);
            var dto = new McpScriptDto
            {
                Id = script.ID.ToString("N"),
                TypeName = script.TypeName,
                ActorId = script.Actor == null ? null : script.Actor.ID.ToString("N"),
                Enabled = script.Enabled,
                ProjectRevision = revision.ProjectRevision,
                SceneRevision = revision.SceneRevision,
            };
            if (includeValues)
            {
                dto.Values = GetScriptFieldValues(script, out var truncated);
                dto.ValuesIncluded = true;
                dto.ValuesTruncated = truncated;
                dto.Warnings = truncated
                    ? new[] { "Script values are a bounded read-only projection of public script fields (max 64, alphabetical). Unsupported types are null with a reason; strings truncate at 512 characters. Script writes are limited to Enabled plus bounded script_instance_set_value field writes." }
                    : new[] { "Script values are a bounded read-only projection of public script fields. Unsupported types are null with a reason. Script writes are limited to Enabled plus bounded script_instance_set_value field writes." };
            }
            return dto;
        }

        // P7 read surface: bounded, read-only projection of a script's public
        // instance fields. This method never mutates the script; writes stay
        // limited to Enabled (see UpdateScript). Only whitelisted primitive
        // shapes are projected (bool/int/float/string/enum/Guid/Vector2-4/Color
        // plus the v13 material null shape; live Asset references are null with
        // a Reason); everything else is a null
        // Value with a Reason. At most MaxScriptValueFields entries
        // (alphabetical, remainder reported via ValuesTruncated) and the global
        // MaxResultBytes cap still bounds the total response.
        private McpScriptFieldDto[] GetScriptFieldValues(Script script, out bool truncated)
        {
            truncated = false;
            var collected = new List<McpScriptFieldDto>();
            try
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                for (var type = script.GetType(); type != null && type != typeof(Script); type = type.BaseType)
                {
                    if (type.FullName != null && type.FullName.StartsWith("FlaxEngine.", StringComparison.Ordinal)) break;
                    FieldInfo[] fields;
                    try { fields = type.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly); }
                    catch { continue; }
                    foreach (var field in fields)
                    {
                        if (field == null || string.IsNullOrEmpty(field.Name) || !seen.Add(field.Name)) continue;
                        collected.Add(ProjectScriptField(script, field));
                    }
                }
            }
            catch { }
            collected.Sort((left, right) => string.Compare(left.Name, right.Name, StringComparison.Ordinal));
            if (collected.Count > MaxScriptValueFields)
            {
                truncated = true;
                collected.RemoveRange(MaxScriptValueFields, collected.Count - MaxScriptValueFields);
            }
            return collected.ToArray();
        }

        private const int MaxNestedProjectionDepth = 2;
        private const int MaxNestedProjectionEntries = 128;
        private const int MaxNestedProjectionPerLevel = 32;

        private static McpScriptFieldDto ProjectScriptField(Script script, FieldInfo field)
        {
            var entry = new McpScriptFieldDto
            {
                Name = LimitForLog(field.Name, 256),
                Type = LimitForLog(field.FieldType.FullName, 256),
            };
            object raw;
            try { raw = field.GetValue(script); }
            catch (Exception ex)
            {
                entry.Reason = LimitForLog("Field read failed: " + ex.GetType().FullName, 256);
                return entry;
            }
            FillScriptFieldValue(entry, raw, field.FieldType, 1, new[] { MaxNestedProjectionEntries });
            return entry;
        }

        // Bridge v34: also projects asset references (managed "N" GUID plus type
        // name) and, up to MaxNestedProjectionDepth levels deep, the editor-visible
        // members of user structures and classes (Value.Kind "struct" or
        // "object" with Fields). Collections, engine objects and deeper levels
        // stay null with a Reason.
        private static void FillScriptFieldValue(McpScriptFieldDto entry, object raw, Type fieldType, int depth, int[] budget)
        {
            if (raw == null)
            {
                if (fieldType == typeof(string) || Nullable.GetUnderlyingType(fieldType) != null)
                {
                    entry.Value = new McpMaterialTypedValue { Kind = "null" };
                    return;
                }
                if (typeof(Asset).IsAssignableFrom(fieldType))
                {
                    entry.Value = new McpMaterialTypedValue { Kind = "null", TypeName = LimitForLog(fieldType.FullName, 256) };
                    return;
                }
                entry.Reason = "Unsupported type " + (fieldType.FullName ?? "unknown") + " (null value).";
                return;
            }
            if (raw is string text)
            {
                entry.Value = new McpMaterialTypedValue
                {
                    Kind = "string",
                    Text = text.Length <= MaxScriptValueStringChars ? text : text.Substring(0, MaxScriptValueStringChars) + " [truncated]",
                };
                return;
            }
            if (raw is Vector2)
            {
                var v = (Vector2)raw;
                entry.Value = new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = v.X, Y = v.Y } };
                return;
            }
            if (raw is Vector3)
            {
                var v = (Vector3)raw;
                entry.Value = new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = v.X, Y = v.Y, Z = v.Z } };
                return;
            }
            if (raw is Vector4)
            {
                var v = (Vector4)raw;
                entry.Value = new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = v.X, Y = v.Y, Z = v.Z, W = v.W } };
                return;
            }
            if (raw.GetType().IsEnum)
            {
                var enumType = raw.GetType();
                long numeric;
                try { numeric = Convert.ToInt64(raw); }
                catch
                {
                    entry.Reason = "Unsupported enum " + (enumType.FullName ?? "unknown") + ".";
                    return;
                }
                entry.Value = new McpMaterialTypedValue
                {
                    Kind = "enum",
                    Integer = numeric,
                    Text = LimitForLog(raw.ToString(), MaxScriptValueStringChars),
                    TypeName = LimitForLog(enumType.FullName, 256),
                };
                return;
            }
            var asset = raw as Asset;
            if (asset != null)
            {
                entry.Value = new McpMaterialTypedValue { Kind = "asset", AssetId = asset.ID.ToString("N"), TypeName = LimitForLog(asset.GetType().FullName, 256) };
                return;
            }
            var projected = SafeMaterialAnimationValue(raw);
            if (projected != null && string.Equals(projected.Kind, "unavailable", StringComparison.Ordinal))
            {
                var rawType = raw.GetType();
                if (NestedContainerRefusal(rawType, raw) == null)
                {
                    FillNestedScriptValue(entry, raw, rawType, depth, budget);
                    return;
                }
                if (IsSupportedMemberType(rawType))
                {
                    try { projected = ProjectMemberValue(raw, rawType); }
                    catch { projected = null; }
                    if (projected != null && !string.Equals(projected.Kind, "unavailable", StringComparison.Ordinal))
                    {
                        entry.Value = projected;
                        return;
                    }
                }
                entry.Reason = "Unsupported type " + (projected == null ? rawType.FullName : projected.TypeName ?? rawType.FullName ?? "unknown") + ".";
                return;
            }
            entry.Value = projected;
        }

        private static void FillNestedScriptValue(McpScriptFieldDto entry, object raw, Type type, int depth, int[] budget)
        {
            var kind = type.IsValueType ? "struct" : "object";
            entry.Value = new McpMaterialTypedValue { Kind = kind, TypeName = LimitForLog(type.FullName, 256) };
            if (depth > MaxNestedProjectionDepth)
            {
                entry.Reason = "Nested values are projected up to " + MaxNestedProjectionDepth + " levels deep; this " + kind + " is deeper.";
                return;
            }
            var slots = EditorVisibleMembers(raw);
            slots.Sort((left, right) => string.Compare(left.Info.Name, right.Info.Name, StringComparison.Ordinal));
            var fields = new List<McpScriptFieldDto>();
            foreach (var slot in slots)
            {
                if (fields.Count >= MaxNestedProjectionPerLevel || budget[0] <= 0)
                {
                    entry.Reason = "Nested members truncated (max " + MaxNestedProjectionPerLevel + " per level, " + MaxNestedProjectionEntries + " per field).";
                    break;
                }
                budget[0]--;
                var child = new McpScriptFieldDto { Name = LimitForLog(slot.Info.Name, 256), Type = LimitForLog(slot.ValueType == null ? null : slot.ValueType.FullName, 256) };
                object childRaw;
                try { childRaw = slot.Info.GetValue(raw); }
                catch (Exception ex)
                {
                    child.Reason = LimitForLog("Field read failed: " + ex.GetType().FullName, 256);
                    fields.Add(child);
                    continue;
                }
                FillScriptFieldValue(child, childRaw, slot.ValueType, depth + 1, budget);
                fields.Add(child);
            }
            entry.Fields = fields.ToArray();
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

        // Bridge v28 edit-time gate. Scene/component/script writes are
        // edit-time only: headless editors cannot apply them (editor ops) and
        // play mode owns live state, so both fail with INVALID_STATE.
        private static void RequireEditTime(string capability)
        {
            if (FEditor.Instance.IsHeadlessMode)
                throw new McpProtocolException("INVALID_STATE", capability + " is unavailable in headless editor mode.");
            RequireNotPlaying(capability);
        }

        // The play-mode half of RequireEditTime, for the few edit-time tools
        // that work in a headless Editor (navigation.build: the CPU navmesh
        // build needs no window).
        private static void RequireNotPlaying(string capability)
        {
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested)
                throw new McpProtocolException("INVALID_STATE", capability + " is an edit-time operation and is unavailable while the editor is in play mode or play was requested.");
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

        private static object CoerceScriptFieldValue(McpScriptFieldSet q, Type type, string fieldName)
        {
            var setCount = (q.Bool.HasValue ? 1 : 0) + (q.Number.HasValue ? 1 : 0) + (q.Text != null ? 1 : 0);
            if (setCount != 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Field '" + fieldName + "' requires exactly one of Bool, Number, or Text.");
            var need = "Field '" + fieldName + "' (" + (type.FullName ?? "unknown") + ") requires ";
            if (type == typeof(bool))
            {
                if (!q.Bool.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "a boolean value.");
                return q.Bool.Value;
            }
            if (type == typeof(string))
            {
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a string value.");
                if (q.Text.Length > MaxScriptValueWriteChars)
                    throw new McpProtocolException("VALIDATION_FAILED", "Field '" + fieldName + "' exceeds " + MaxScriptValueWriteChars + " characters.");
                return q.Text;
            }
            if (type == typeof(float) || type == typeof(double))
            {
                if (!q.Number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "a numeric value.");
                var n = q.Number.Value;
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
                if (!q.Number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "an integral numeric value.");
                var n = q.Number.Value;
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
            if (type.IsEnum)
            {
                if (q.Number.HasValue)
                {
                    var n = q.Number.Value;
                    if (double.IsNaN(n) || double.IsInfinity(n) || Math.Truncate(n) != n)
                        throw new McpProtocolException("VALIDATION_FAILED", need + "an enum name or a defined numeric value.");
                    try
                    {
                        var value = Enum.ToObject(type, Convert.ToInt64(n));
                        if (!Enum.IsDefined(type, value))
                            throw new McpProtocolException("VALIDATION_FAILED", "Value " + n + " is not a defined " + (type.FullName ?? "enum") + " value.");
                        return value;
                    }
                    catch (McpProtocolException) { throw; }
                    catch { throw new McpProtocolException("VALIDATION_FAILED", "Value " + n + " is not a defined " + (type.FullName ?? "enum") + " value."); }
                }
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an enum name or a defined numeric value.");
                try { return Enum.Parse(type, q.Text, true); }
                catch { throw new McpProtocolException("VALIDATION_FAILED", "Value '" + LimitForLog(q.Text, 128) + "' is not a defined " + (type.FullName ?? "enum") + " value."); }
            }
            if (type == typeof(Guid))
            {
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a 32-character hex GUID string.");
                Guid guid;
                if (!Guid.TryParseExact(q.Text, "N", out guid))
                    throw new McpProtocolException("VALIDATION_FAILED", need + "a 32-character hex GUID string.");
                return guid;
            }
            if (type == typeof(Vector2) || type == typeof(Float2))
            {
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y\" string.");
                var v = ParseStrictFloatList(q.Text, 2, need + "an \"x,y\" string", "x,y");
                return type == typeof(Vector2) ? (object)new Vector2(v[0], v[1]) : new Float2(v[0], v[1]);
            }
            if (type == typeof(Vector3) || type == typeof(Float3))
            {
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z\" string.");
                var v = ParseStrictFloatList(q.Text, 3, need + "an \"x,y,z\" string", "x,y,z");
                return type == typeof(Vector3) ? (object)new Vector3(v[0], v[1], v[2]) : new Float3(v[0], v[1], v[2]);
            }
            if (type == typeof(Vector4) || type == typeof(Float4))
            {
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z,w\" string.");
                var v = ParseStrictFloatList(q.Text, 4, need + "an \"x,y,z,w\" string", "x,y,z,w");
                return type == typeof(Vector4) ? (object)new Vector4(v[0], v[1], v[2], v[3]) : new Float4(v[0], v[1], v[2], v[3]);
            }
            if (type == typeof(Color))
            {
                if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a \"#rrggbb\" or \"r,g,b[,a]\" string.");
                return ParseStrictColor(q.Text, need + "a color");
            }
            throw new McpProtocolException("VALIDATION_FAILED", "Unsupported type " + (type.FullName ?? "unknown") + " for field '" + fieldName + "'.");
        }

        private static McpMaterialTypedValue ProjectScriptWriteValue(object raw, Type type)
        {
            if (raw == null) return new McpMaterialTypedValue { Kind = "null" };
            if (raw is string text)
                return new McpMaterialTypedValue
                {
                    Kind = "string",
                    Text = text.Length <= MaxScriptValueStringChars ? text : text.Substring(0, MaxScriptValueStringChars) + " [truncated]",
                };
            if (type != null && type.IsEnum)
            {
                long numeric = 0;
                var hasNumeric = true;
                try { numeric = Convert.ToInt64(raw); }
                catch { hasNumeric = false; }
                return new McpMaterialTypedValue
                {
                    Kind = "enum",
                    Integer = hasNumeric ? (long?)numeric : null,
                    Text = LimitForLog(raw.ToString(), MaxScriptValueStringChars),
                    TypeName = LimitForLog(type.FullName, 256),
                };
            }
            return SafeMaterialAnimationValue(raw);
        }

        private object ExecuteSetScriptField(McpScriptFieldSet q)
        {
            // Dry-run previews never consume idempotency keys: a preview filed
            // under the same key as a later real write would collide on the
            // request fingerprint (IDEMPOTENCY_KEY_REUSED).
            if (q != null && q.DryRun) return SetScriptField(q);
            return ExecuteIdempotent("script.instance_set_value", q == null ? null : q.IdempotencyKey, q, () => SetScriptField(q));
        }

        // Bridge v34: script writes take the same pipeline as actor.set_property
        // (WriteMember): the member must be one the Editor property grid shows
        // (EditorVisibleMembers), MemberWriteBlockReason and the edit-time
        // [NoSerialize] refusal apply, and the value is coerced by
        // CoerceMemberValue (asset references by GUID, Content/ path or
        // engine:<path>, Quaternion, and the other member kinds). The write goes
        // through ScriptMemberInfo.SetValue, the wrapper the property grid uses,
        // inside one snapshot undo record on the script
        // (Undo.RecordBegin/RecordEnd, as CustomEditor value changes do).
        // Path writes a nested member (see ResolveMemberChain).
        private McpScriptFieldSetResult SetScriptField(McpScriptFieldSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Script field parameters are required.");
            var path = RequireMemberPathRequest(q.Path, q.Field, "Field");
            if (path == null)
            {
                if (string.IsNullOrEmpty(q.Field) || q.Field.Length > 128 || !IsScriptFieldName(q.Field))
                    throw new McpProtocolException("VALIDATION_FAILED", "Field must match ^[A-Za-z_][A-Za-z0-9_]*$ and be 1-128 characters.");
                path = new[] { q.Field };
            }
            RequireEditTime("script.instance_set_value");
            var script = RequireScript(q.ScriptId);
            var actor = script.Actor;
            CheckSceneWrite(actor == null ? null : actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            var nested = q.Path != null;
            var plan = PlanMemberWrite(script, path, MemberTargetScript, true, nested, q.Bool, q.Number, q.Text);
            var display = nested ? string.Join(".", plan.Chain.Names) : plan.Chain.Names[0];
            var resolved = nested ? plan.Chain.Names : null;
            var typeName = FriendlyTypeName(plan.LeafType);
            var before = ProjectMemberValue(plan.Before, plan.LeafType);
            if (q.DryRun)
            {
                var preview = CurrentRevision(actor == null ? null : actor.Scene);
                return new McpScriptFieldSetResult
                {
                    ScriptId = script.ID.ToString("N"), Field = display, Type = typeName,
                    DryRun = true, WouldChange = plan.WouldChange,
                    Before = before, After = ProjectMemberValue(plan.Coerced, plan.LeafType), Path = resolved,
                    ProjectRevision = preview.ProjectRevision, SceneRevision = preview.SceneRevision,
                };
            }
            if (!plan.WouldChange)
            {
                // A write of the current value would only add an empty undo
                // step and mark the scene edited for nothing.
                var unchanged = CurrentRevision(actor == null ? null : actor.Scene);
                return new McpScriptFieldSetResult
                {
                    ScriptId = script.ID.ToString("N"), Field = display, Type = typeName, DryRun = false, WouldChange = false,
                    Before = before, After = before, Path = resolved,
                    ProjectRevision = unchanged.ProjectRevision, SceneRevision = unchanged.SceneRevision,
                };
            }
            var undo = FEditor.Instance.Undo;
            undo.RecordBegin(script, "Set script member");
            try { ApplyMemberWrite(plan, display); }
            finally { undo.RecordEnd(script); }
            MarkEdited(actor);
            var revision = AdvanceSceneRevision(actor == null ? null : actor.Scene);
            return new McpScriptFieldSetResult
            {
                ScriptId = script.ID.ToString("N"), Field = display, Type = typeName,
                DryRun = false, WouldChange = true,
                Before = before, After = ProjectMemberValue(ReadMemberLeaf(script, plan.Chain, plan.Coerced), plan.LeafType), Path = resolved,
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
            };
        }

        private const string ActorPropertyAllowlist = "Light.Color, Light.Brightness, Camera.FieldOfView, StaticModel.Model, Script.Enabled";

        private static bool IsAllowedActorProperty(string property)
        {
            return string.Equals(property, "Light.Color", StringComparison.Ordinal)
                || string.Equals(property, "Light.Brightness", StringComparison.Ordinal)
                || string.Equals(property, "Camera.FieldOfView", StringComparison.Ordinal)
                || string.Equals(property, "StaticModel.Model", StringComparison.Ordinal)
                || string.Equals(property, "Script.Enabled", StringComparison.Ordinal);
        }

        private static void RequireSinglePropertyValue(McpActorPropertySet q, string property)
        {
            var setCount = (q.Bool.HasValue ? 1 : 0) + (q.Number.HasValue ? 1 : 0) + (q.Text != null ? 1 : 0);
            if (setCount != 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Property '" + property + "' requires exactly one of Bool, Number, or Text.");
        }

        private static double RequirePropertyNumber(McpActorPropertySet q, string property)
        {
            RequireSinglePropertyValue(q, property);
            if (!q.Number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", "Property '" + property + "' requires a numeric value.");
            var n = q.Number.Value;
            if (double.IsNaN(n) || double.IsInfinity(n)) throw new McpProtocolException("VALIDATION_FAILED", "Property '" + property + "' requires a finite numeric value.");
            return n;
        }

        private static string RequirePropertyText(McpActorPropertySet q, string property, string shape)
        {
            RequireSinglePropertyValue(q, property);
            if (q.Text == null) throw new McpProtocolException("VALIDATION_FAILED", "Property '" + property + "' requires " + shape + ".");
            return q.Text;
        }

        private McpActorPropertySetResult SetActorProperty(McpActorPropertySet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Actor property parameters are required.");
            // Bridge v33: the five legacy aliases keep their dedicated typed
            // setters below. Every other name (and a dry-run preview of the
            // four actor aliases) goes through the generic editor-visible
            // member path.
            // The StaticModel.Model alias resolves project assets only, so
            // an engine-content reference takes the generic path as well.
            // Bridge v34: a Path always takes the generic nested member path.
            if (q.Path != null) return SetActorMember(q);
            var isScriptEnabled = string.Equals(q.Property, "Script.Enabled", StringComparison.Ordinal);
            var isEngineModel = string.Equals(q.Property, "StaticModel.Model", StringComparison.Ordinal) && IsEngineAssetReference(q.Text);
            if (!IsAllowedActorProperty(q.Property) || (q.DryRun && !isScriptEnabled) || isEngineModel)
                return SetActorMember(q);
            if (q.DryRun)
                throw new McpProtocolException("VALIDATION_FAILED", "Property 'Script.Enabled' has no dry-run preview; use script_instance_update with dry_run.");
            RequireEditTime("actor.set_property");
            // Script.Enabled addresses a script instance (script GUID), not an
            // actor; the write itself is the same direct typed setter the
            // script_instance_update path uses.
            if (string.Equals(q.Property, "Script.Enabled", StringComparison.Ordinal))
                return SetScriptEnabledProperty(q);
            var actor = RequireActor(q.ActorId);
            CheckSceneWrite(actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            if (string.Equals(q.Property, "Light.Color", StringComparison.Ordinal))
            {
                var light = actor as Light;
                if (light == null) throw new McpProtocolException("VALIDATION_FAILED", "Property 'Light.Color' requires a FlaxEngine.Light actor, got " + (actor.TypeName ?? "unknown") + ".");
                var color = ParseStrictColor(RequirePropertyText(q, q.Property, "a \"#rrggbb\" or \"r,g,b[,a]\" string"), "Property 'Light.Color'");
                var before = light.Color;
                // Direct typed setter inside editor undo (same pattern as
                // UpdateActor); no arbitrary dotted paths are accepted.
                FEditor.Instance.Undo.RecordAction(actor, "Set actor property", () =>
                {
                    light.Color = color;
                    MarkEdited(actor);
                });
                AdvanceSceneRevision(actor.Scene);
                return ActorPropertyResult(actor, q.Property, ProjectScriptWriteValue(before, typeof(Color)), ProjectScriptWriteValue(light.Color, typeof(Color)));
            }
            if (string.Equals(q.Property, "Light.Brightness", StringComparison.Ordinal))
            {
                var light = actor as Light;
                if (light == null) throw new McpProtocolException("VALIDATION_FAILED", "Property 'Light.Brightness' requires a FlaxEngine.Light actor, got " + (actor.TypeName ?? "unknown") + ".");
                var n = RequirePropertyNumber(q, q.Property);
                if (n < 0.0 || (float)n < 0.0f) throw new McpProtocolException("VALIDATION_FAILED", "Property 'Light.Brightness' must be >= 0.");
                var brightness = (float)n;
                var before = light.Brightness;
                FEditor.Instance.Undo.RecordAction(actor, "Set actor property", () =>
                {
                    light.Brightness = brightness;
                    MarkEdited(actor);
                });
                AdvanceSceneRevision(actor.Scene);
                return ActorPropertyResult(actor, q.Property, ProjectScriptWriteValue(before, typeof(float)), ProjectScriptWriteValue(light.Brightness, typeof(float)));
            }
            if (string.Equals(q.Property, "Camera.FieldOfView", StringComparison.Ordinal))
            {
                var camera = actor as Camera;
                if (camera == null) throw new McpProtocolException("VALIDATION_FAILED", "Property 'Camera.FieldOfView' requires a FlaxEngine.Camera actor, got " + (actor.TypeName ?? "unknown") + ".");
                var n = RequirePropertyNumber(q, q.Property);
                if (!(n > 0.0) || !(n < 180.0)) throw new McpProtocolException("VALIDATION_FAILED", "Property 'Camera.FieldOfView' must be between 0 and 180 degrees (exclusive).");
                var fov = (float)n;
                var before = camera.FieldOfView;
                FEditor.Instance.Undo.RecordAction(actor, "Set actor property", () =>
                {
                    camera.FieldOfView = fov;
                    MarkEdited(actor);
                });
                AdvanceSceneRevision(actor.Scene);
                return ActorPropertyResult(actor, q.Property, ProjectScriptWriteValue(before, typeof(float)), ProjectScriptWriteValue(camera.FieldOfView, typeof(float)));
            }
            // StaticModel.Model by asset GUID only (no path variant): the
            // loader verifies the registry/file ID match like actor.update.
            var staticModel = actor as StaticModel;
            if (staticModel == null) throw new McpProtocolException("VALIDATION_FAILED", "Property 'StaticModel.Model' requires a FlaxEngine.StaticModel actor, got " + (actor.TypeName ?? "unknown") + ".");
            var assetText = RequirePropertyText(q, q.Property, "a 32-character model asset GUID");
            if (!IsGuidN(assetText)) throw new McpProtocolException("VALIDATION_FAILED", "Property 'StaticModel.Model' requires a 32-character model asset GUID.");
            var model = LoadActorModelAsset(assetText, null);
            var beforeModel = staticModel.Model;
            FEditor.Instance.Undo.RecordAction(actor, "Set actor property", () =>
            {
                staticModel.Model = model;
                MarkEdited(actor);
            });
            AdvanceSceneRevision(actor.Scene);
            return ActorPropertyResult(actor, q.Property, ProjectScriptWriteValue(beforeModel, beforeModel == null ? null : beforeModel.GetType()), ProjectScriptWriteValue(staticModel.Model, typeof(Model)));
        }

        private McpActorPropertySetResult ActorPropertyResult(Actor actor, string property, McpMaterialTypedValue before, McpMaterialTypedValue after)
        {
            var revision = CurrentRevision(actor.Scene);
            return new McpActorPropertySetResult
            {
                ActorId = actor.ID.ToString("N"), Property = property,
                // v33 result field: the alias setters compare projected values.
                WouldChange = !string.Equals(JsonSerializer.Serialize(before, false), JsonSerializer.Serialize(after, false), StringComparison.Ordinal),
                Before = before, After = after, Actor = ActorDto(actor, false),
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
            };
        }

        private McpActorPropertySetResult SetScriptEnabledProperty(McpActorPropertySet q)
        {
            RequireSinglePropertyValue(q, q.Property);
            if (!q.Bool.HasValue) throw new McpProtocolException("VALIDATION_FAILED", "Property 'Script.Enabled' requires a boolean value.");
            var script = RequireScript(q.ActorId);
            var actor = script.Actor;
            CheckSceneWrite(actor == null ? null : actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            var before = script.Enabled;
            var action = new McpScriptEnabledUndo(script, before, q.Bool.Value);
            action.Do();
            FEditor.Instance.Undo.AddAction(action);
            if (actor != null) MarkEdited(actor);
            var revision = AdvanceSceneRevision(actor == null ? null : actor.Scene);
            return new McpActorPropertySetResult
            {
                ActorId = script.ID.ToString("N"), Property = "Script.Enabled", Type = "System.Boolean", WouldChange = before != script.Enabled,
                Before = ProjectScriptWriteValue(before, typeof(bool)), After = ProjectScriptWriteValue(script.Enabled, typeof(bool)),
                Actor = null,
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
            };
        }

        // ---------------------------------------------------------------
        // Bridge v33: generic editor-visible member surface.
        //
        // A member is reachable only when the Editor property grid would show
        // it. The selection rule below is the same one used by
        // FlaxEditor.CustomEditors.Editors.GenericEditor.GetItemsForType:
        // properties need a getter plus a setter or [ShowInEditor], public
        // visibility or [ShowInEditor], and no [HideInEditor]; fields need
        // public visibility or [ShowInEditor] and no [HideInEditor]. Writes
        // additionally refuse [ReadOnly] and (at edit time) [NoSerialize]
        // members, and the Actor base members that actor.update owns.
        // Values are written through ScriptMemberInfo.SetValue, the wrapper
        // the property grid itself uses.
        private const string MemberTargetActor = "actor";
        private const string MemberTargetControl = "control";
        private const string MemberTargetScript = "script";
        private const int DefaultMemberListEntries = 128;
        private const int MaxMemberListEntries = 256;
        private const int MaxMemberEnumValues = 64;
        private const int MaxMemberFilterChars = 128;
        private const int MaxMemberTooltipChars = 256;

        // GUI controls hide their layout members from the generic grid because
        // the Editor edits them through a dedicated editor instead
        // (FlaxEditor.CustomEditors.Dedicated.UIControlControlEditor builds its
        // Transform section from exactly these properties; Offsets is what its
        // Proxy_Offset_* members write). They are the only [HideInEditor]
        // members this surface reaches.
        private static readonly string[] ControlLayoutMembers = { "AnchorPreset", "AnchorMin", "AnchorMax", "LocalX", "LocalY", "Width", "Height", "Offsets" };

        private static bool IsControlLayoutMember(string name)
        {
            foreach (var candidate in ControlLayoutMembers)
                if (string.Equals(candidate, name, StringComparison.Ordinal)) return true;
            return false;
        }

        private static List<McpMemberSlot> EditorVisibleMembers(object target)
        {
            var result = new List<McpMemberSlot>();
            if (target == null) return result;
            var scriptType = new ScriptType(target.GetType());
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var layout = target is FControl;
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            ScriptMemberInfo[] properties;
            try { properties = scriptType.GetProperties(flags); }
            catch { properties = new ScriptMemberInfo[0]; }
            foreach (var info in properties) AddEditorVisibleMember(result, seen, info, true, layout);
            ScriptMemberInfo[] fields;
            try { fields = scriptType.GetFields(flags); }
            catch { fields = new ScriptMemberInfo[0]; }
            foreach (var info in fields) AddEditorVisibleMember(result, seen, info, false, false);
            return result;
        }

        private static void AddEditorVisibleMember(List<McpMemberSlot> result, HashSet<string> seen, ScriptMemberInfo info, bool isProperty, bool controlLayout)
        {
            if (!info) return;
            var name = info.Name;
            if (string.IsNullOrEmpty(name) || info.IsStatic) return;
            object[] attributes;
            try { attributes = info.GetAttributes(true); }
            catch { attributes = new object[0]; }
            var show = false; var hide = false; var readOnly = false; var noSerialize = false; var hasLimit = false;
            var min = float.MinValue; var max = float.MaxValue;
            string group = null; string tooltip = null;
            foreach (var attribute in attributes)
            {
                if (attribute is ShowInEditorAttribute) show = true;
                else if (attribute is HideInEditorAttribute) hide = true;
                else if (attribute is ReadOnlyAttribute) readOnly = true;
                else if (attribute is NoSerializeAttribute) noSerialize = true;
                else if (attribute is EditorDisplayAttribute) group = ((EditorDisplayAttribute)attribute).Group;
                else if (attribute is TooltipAttribute) tooltip = ((TooltipAttribute)attribute).Text;
                else if (attribute is LimitAttribute) { hasLimit = true; min = ((LimitAttribute)attribute).Min; max = ((LimitAttribute)attribute).Max; }
                else if (attribute is RangeAttribute) { hasLimit = true; min = ((RangeAttribute)attribute).Min; max = ((RangeAttribute)attribute).Max; }
            }
            var layoutMember = controlLayout && IsControlLayoutMember(name);
            if (hide && !layoutMember) return;
            if (layoutMember && string.IsNullOrEmpty(group)) group = "Transform";
            bool hasSet;
            try
            {
                hasSet = info.HasSet;
                if (isProperty)
                {
                    if (!info.HasGet || !(hasSet || show) || !(info.IsPublic || show)) return;
                    var managedProperty = info.Type as PropertyInfo;
                    if (managedProperty != null && managedProperty.GetIndexParameters().Length != 0) return;
                }
                else if (!(info.IsPublic || show)) return;
            }
            catch { return; }
            var valueType = info.ValueType;
            var type = valueType ? valueType.Type : null;
            if (type == null || !seen.Add(name)) return;
            var declaring = info.DeclaringType;
            result.Add(new McpMemberSlot
            {
                Info = info, ValueType = type, DeclaringType = declaring ? declaring.Type : null,
                ReadOnly = readOnly || !hasSet, NoSerialize = noSerialize, HasLimit = hasLimit, Min = min, Max = max, Group = group, Tooltip = tooltip,
            });
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

        private static bool IsNumericScalar(object value)
        {
            return value is float || value is double || value is sbyte || value is byte || value is short || value is ushort
                || value is int || value is uint || value is long || value is ulong;
        }

        // [Limit]/[Range] are the bounds the Editor property grid clamps a
        // numeric member to, so an edit-time write outside them is refused
        // instead of storing a value the Editor itself could never produce.
        private static void RequireWithinEditorLimit(McpMemberSlot slot, object value)
        {
            if (!slot.HasLimit || !IsNumericScalar(value)) return;
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (number < slot.Min || number > slot.Max)
                throw new McpProtocolException("VALIDATION_FAILED", "Property '" + slot.Info.Name + "' must be between " + slot.Min.ToString("R", CultureInfo.InvariantCulture) + " and " + slot.Max.ToString("R", CultureInfo.InvariantCulture) + " (the Editor limit for this member).");
        }

        internal static ScriptMemberInfo FindEditorMember(object target, string name)
        {
            foreach (var slot in EditorVisibleMembers(target))
                if (string.Equals(slot.Info.Name, name, StringComparison.Ordinal)) return slot.Info;
            return ScriptMemberInfo.Null;
        }

        private static bool IsJsonAssetReferenceType(Type type)
        {
            return type != null && type.IsGenericType && type.GetGenericTypeDefinition() == typeof(JsonAssetReference<>);
        }

        private static bool IsEngineTypeName(string fullName)
        {
            if (string.IsNullOrEmpty(fullName)) return true;
            return fullName.StartsWith("FlaxEngine.", StringComparison.Ordinal)
                || fullName.StartsWith("FlaxEditor.", StringComparison.Ordinal)
                || fullName.StartsWith("System.", StringComparison.Ordinal)
                || fullName.StartsWith("Microsoft.", StringComparison.Ordinal);
        }

        private static string MemberKindName(Type type)
        {
            if (type == null) return "unsupported";
            if (type == typeof(bool)) return "boolean";
            if (type == typeof(string)) return "string";
            if (type == typeof(float) || type == typeof(double)) return "number";
            if (type == typeof(sbyte) || type == typeof(byte) || type == typeof(short) || type == typeof(ushort)
                || type == typeof(int) || type == typeof(uint) || type == typeof(long) || type == typeof(ulong)) return "integer";
            if (type.IsEnum) return "enum";
            if (type == typeof(Guid)) return "guid";
            if (type == typeof(Vector2) || type == typeof(Float2) || type == typeof(Double2) || type == typeof(Int2)) return "vector2";
            if (type == typeof(Vector3) || type == typeof(Float3) || type == typeof(Double3) || type == typeof(Int3)) return "vector3";
            if (type == typeof(Vector4) || type == typeof(Float4) || type == typeof(Double4) || type == typeof(Int4)) return "vector4";
            if (type == typeof(Color)) return "color";
            if (type == typeof(Quaternion)) return "quaternion";
            if (type == typeof(Rectangle)) return "rectangle";
            if (type == typeof(FMargin)) return "margin";
            if (type == typeof(LocalizedString)) return "localized_string";
            if (type == typeof(LayersMask)) return "layers_mask";
            if (IsBrushType(type)) return "brush";
            if (type == typeof(FontReference)) return "font";
            if (IsJsonAssetReferenceType(type)) return "json_asset";
            if (typeof(Asset).IsAssignableFrom(type)) return "asset";
            if (typeof(Actor).IsAssignableFrom(type)) return "actor";
            if (typeof(Script).IsAssignableFrom(type)) return "script";
            return "unsupported";
        }

        private static bool IsSupportedMemberType(Type type)
        {
            return !string.Equals(MemberKindName(type), "unsupported", StringComparison.Ordinal);
        }

        private static string MemberWriteBlockReason(McpMemberSlot slot, string targetKind, bool requireSupportedType = true)
        {
            var name = slot.Info.Name;
            if (slot.ReadOnly) return "Member is read-only.";
            var declaring = slot.DeclaringType;
            if (string.Equals(targetKind, MemberTargetActor, StringComparison.Ordinal))
            {
                if (declaring == typeof(FObject) || declaring == typeof(SceneObject))
                    return "Engine object identity members are not writable.";
                if (declaring == typeof(Actor) && !string.Equals(name, "StaticFlags", StringComparison.Ordinal))
                    return "Actor base members (name, active, transform, layer, tags) are owned by actor_update.";
                if (slot.NoSerialize) return "Member is [NoSerialize]; an edit-time write would not persist.";
            }
            else if (string.Equals(targetKind, MemberTargetControl, StringComparison.Ordinal))
            {
                if (string.Equals(name, "Parent", StringComparison.Ordinal) || string.Equals(name, "IndexInParent", StringComparison.Ordinal))
                    return "Control hierarchy is owned by the UIControl actor (use actor_reparent).";
                // Layout members such as Width, LocalX, and AnchorPreset are
                // [NoSerialize] views over the serialized anchors and offsets,
                // so writing them does persist (live-verified on Flax 1.12).
                if (slot.NoSerialize && !IsControlLayoutMember(name)) return "Member is [NoSerialize]; an edit-time write would not persist.";
            }
            else if (IsEngineTypeName(declaring == null ? null : declaring.FullName))
            {
                return "Engine-declared script members are not writable through this surface.";
            }
            if (requireSupportedType && !IsSupportedMemberType(slot.ValueType))
                return "Unsupported type " + (FriendlyTypeName(slot.ValueType) ?? "unknown") + ".";
            return null;
        }

        private static bool TypeHierarchyHasName(Type type, string name)
        {
            for (var current = type; current != null; current = current.BaseType)
                if (string.Equals(current.Name, name, StringComparison.Ordinal) || string.Equals(current.FullName, name, StringComparison.Ordinal)) return true;
            return false;
        }

        private static McpMemberSlot ResolveMemberSlot(object target, string property, string targetKind)
        {
            if (string.IsNullOrEmpty(property) || property.Length > 128)
                throw new McpProtocolException("VALIDATION_FAILED", "Property must be 1-128 characters: Member or Type.Member.");
            string prefix = null;
            var name = property;
            var dot = property.IndexOf('.');
            if (dot >= 0)
            {
                prefix = property.Substring(0, dot);
                name = property.Substring(dot + 1);
            }
            if (!IsScriptFieldName(name) || (prefix != null && !IsScriptFieldName(prefix)))
                throw new McpProtocolException("VALIDATION_FAILED", "Property must be Member or Type.Member using C# identifiers.");
            var typeName = target.GetType().FullName ?? "unknown";
            if (prefix != null && !TypeHierarchyHasName(target.GetType(), prefix))
                throw new McpProtocolException("VALIDATION_FAILED", "Property '" + property + "' requires a " + prefix + " target, got " + typeName + ".");
            foreach (var slot in EditorVisibleMembers(target))
                if (string.Equals(slot.Info.Name, name, StringComparison.Ordinal)) return slot;
            if (string.Equals(targetKind, MemberTargetActor, StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Unknown actor property '" + property + "' on " + typeName + ". Use actor_get_properties to list editor-visible members. Legacy aliases: " + ActorPropertyAllowlist + ".");
            if (string.Equals(targetKind, MemberTargetControl, StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Unknown control property '" + property + "' on " + typeName + ". Use ui_control_get_properties to list editor-visible members.");
            throw new McpProtocolException("VALIDATION_FAILED", "Unknown script member '" + property + "' on " + typeName + ". Members must be editor-visible (public or [ShowInEditor], not [HideInEditor]).");
        }

        private static string DescribeException(Exception ex)
        {
            var inner = ex;
            while (inner is TargetInvocationException && inner.InnerException != null) inner = inner.InnerException;
            var message = LimitForLog(RedactLogText(inner.Message), 256);
            return (inner.GetType().FullName ?? "Exception") + (string.IsNullOrEmpty(message) ? "" : ": " + message);
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

        // Engine content references for the member path.
        //
        // A reference resolves against the project Content registry first and
        // then against engine content. Engine assets are addressed by GUID or
        // as "engine:<internal path>", where the internal path is what
        // Content.LoadAsyncInternal takes: relative to the engine Content
        // folder, without the .flax extension (engine:Editor/Primitives/Cube).
        // Either form must name an asset the engine asset registry lists under
        // Globals.EngineContentFolder: no file path is composed from caller
        // input, and results carry the engine: form, never an absolute path.
        // Assets of other referenced projects (plugins) are not resolvable.
        private const string EngineAssetPrefix = "engine:";
        private const int MaxEngineInternalPathChars = 260;
        private const string AssetReferenceShape = "an asset GUID, a Content/ path, an engine:<path> reference (for example engine:Editor/Primitives/Cube), or an empty string to clear.";

        private static string EngineContentRoot()
        {
            try { return Path.GetFullPath(Globals.EngineContentFolder); }
            catch { return null; }
        }

        private static string EngineInternalAssetPath(string absolutePath, string engineRoot)
        {
            if (string.IsNullOrEmpty(absolutePath) || string.IsNullOrEmpty(engineRoot) || !Path.IsPathRooted(absolutePath)) return null;
            string relative;
            try { relative = Path.GetRelativePath(engineRoot, Path.GetFullPath(absolutePath)).Replace('\\', '/'); }
            catch { return null; }
            if (relative.Length <= 5 || Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith("../", StringComparison.Ordinal)) return null;
            if (!relative.EndsWith(".flax", StringComparison.OrdinalIgnoreCase)) return null;
            return relative.Substring(0, relative.Length - 5);
        }

        private static McpAssetRecord EngineAssetRecord(Guid id, AssetInfo info, string engineRoot)
        {
            var internalPath = EngineInternalAssetPath(info.Path, engineRoot);
            // A project that is the engine project itself lists the same files
            // as project Content; those keep their Content/ form.
            if (internalPath == null || AssetProjectRelativePath(info.Path) != null) return null;
            return new McpAssetRecord { Id = id, Info = info, Path = EngineAssetPrefix + internalPath, Extension = ".flax", Folder = null };
        }

        private static McpAssetRecord FindEngineAssetRecord(Guid id)
        {
            AssetInfo info;
            try { if (id == Guid.Empty || !Content.GetAssetInfo(id, out info)) return null; }
            catch { return null; }
            return EngineAssetRecord(id, info, EngineContentRoot());
        }

        private static McpAssetRecord FindEngineAssetRecord(string internalPath)
        {
            var engineRoot = EngineContentRoot();
            if (engineRoot == null) return null;
            var wanted = EngineAssetPrefix + internalPath;
            var ids = Content.GetAllAssets() ?? new Guid[0];
            foreach (var id in ids)
            {
                AssetInfo info;
                if (id == Guid.Empty || !Content.GetAssetInfo(id, out info)) continue;
                var record = EngineAssetRecord(id, info, engineRoot);
                if (record != null && string.Equals(record.Path, wanted, StringComparison.OrdinalIgnoreCase)) return record;
            }
            return null;
        }

        private static string ValidateEngineInternalPath(string value)
        {
            const string shape = "Engine asset references must be \"engine:<path>\" with a '/'-separated path relative to the engine Content folder and no file extension (for example engine:Editor/Primitives/Cube).";
            if (string.IsNullOrEmpty(value) || value.Length > MaxEngineInternalPathChars || value.IndexOf('\\') >= 0 || value.IndexOf(':') >= 0
                || value.EndsWith(".flax", StringComparison.OrdinalIgnoreCase))
                throw new McpProtocolException("VALIDATION_FAILED", shape);
            foreach (var c in value)
                if (char.IsControl(c)) throw new McpProtocolException("VALIDATION_FAILED", shape);
            foreach (var part in value.Split('/'))
                if (part.Length == 0 || part == "." || part == "..") throw new McpProtocolException("VALIDATION_FAILED", shape);
            return value;
        }

        // The reference an agent can paste back for an asset: its Content/
        // path, its engine: path, or null when the asset is in neither place
        // (virtual assets, assets of other referenced projects).
        private static string MemberAssetReferencePath(Guid id)
        {
            AssetInfo info;
            try { if (id == Guid.Empty || !Content.GetAssetInfo(id, out info)) return null; }
            catch { return null; }
            var project = AssetProjectRelativePath(info.Path);
            if (project != null) return project;
            var internalPath = EngineInternalAssetPath(info.Path, EngineContentRoot());
            return internalPath == null ? null : EngineAssetPrefix + internalPath;
        }

        private static bool IsEngineAssetReference(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            if (text.StartsWith(EngineAssetPrefix, StringComparison.Ordinal)) return true;
            Guid id;
            return Guid.TryParseExact(text, "N", out id) && FindEngineAssetRecord(id) != null;
        }

        private static McpAssetRecord ResolveMemberAssetRecord(string text, string need)
        {
            if (text.StartsWith(EngineAssetPrefix, StringComparison.Ordinal))
            {
                var internalPath = ValidateEngineInternalPath(text.Substring(EngineAssetPrefix.Length));
                var engine = FindEngineAssetRecord(internalPath);
                if (engine == null)
                    throw new McpProtocolException("ASSET_NOT_FOUND", "Asset was not found in the engine content registry: " + EngineAssetPrefix + internalPath);
                return engine;
            }
            if (IsGuidN(text))
            {
                Guid id;
                Guid.TryParseExact(text, "N", out id);
                foreach (var record in BuildAssetRegistry()) if (record.Id == id) return record;
                var engine = FindEngineAssetRecord(id);
                if (engine == null)
                    throw new McpProtocolException("ASSET_NOT_FOUND", "Asset was not found in the project Content registry or the engine content registry.");
                return engine;
            }
            if (!text.Replace('\\', '/').StartsWith("Content/", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", need + AssetReferenceShape);
            return ResolveAssetRecord(new McpAssetGet { Path = text }, BuildAssetRegistry());
        }

        private static Asset CoerceAssetReference(Type assetType, string text, string need)
        {
            if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + AssetReferenceShape);
            if (text.Length == 0) return null;
            var record = ResolveMemberAssetRecord(text, need);
            Asset asset = null;
            try { asset = Content.LoadAsync(record.Id, assetType); }
            catch { asset = null; }
            if (asset == null)
                throw new McpProtocolException("VALIDATION_FAILED", need + "a " + (assetType.FullName ?? "asset") + " asset; " + record.Path + " is " + (record.Info.TypeName ?? "unknown") + ".");
            if (asset.WaitForLoaded(30000) || asset.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "Content asset failed to load: " + record.Path);
            if (!assetType.IsInstanceOfType(asset))
                throw new McpProtocolException("VALIDATION_FAILED", need + "a " + (assetType.FullName ?? "asset") + " asset; " + record.Path + " is " + (asset.GetType().FullName ?? "unknown") + ".");
            if (asset.ID != record.Id)
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "registry/file ID mismatch: expected " + record.Id.ToString("N") + " got " + asset.ID.ToString("N") + " (" + record.Path + ")");
            return asset;
        }

        // GUI brushes and font references.
        //
        // An IBrush member takes "<kind>:<value>[;option=value]". The kinds
        // are the entries of FlaxEditor.CustomEditors.Editors.IBrushEditor
        // that a scene serializes and an edit-time caller can fill in, built
        // from the same public constructors and fields the Editor's type
        // switch and field editors use:
        //   solid:<color>                          SolidColorBrush
        //   gradient:<start color>;end=<color>     LinearGradientBrush
        //   texture:<Texture>                      TextureBrush          [filter]
        //   texture9:<Texture>                     Texture9SlicingBrush  [filter, border_size, border]
        //   sprite:<SpriteAtlas>;sprite=<name>     SpriteBrush           [filter] (or index=<n>)
        //   sprite9:<SpriteAtlas>;sprite=<name>    Sprite9SlicingBrush   [filter, border_size, border]
        //   material:<MaterialBase>                MaterialBrush
        //   ui_brush:<JsonAsset of UIBrushAsset>   UIBrush
        //   video:<VideoPlayer actor GUID>         VideoBrush            [filter]
        // GPUTextureBrush is left out: its GPUTexture is a runtime GPU resource
        // (the field is [HideInEditor]), not an asset, so there is nothing to
        // assign at edit time. Omitted options take the brush constructor
        // defaults; the read-back spells every option out.
        //
        // A FontReference member takes "<FontAsset>;size=<points>", the two
        // properties FlaxEditor.CustomEditors.Dedicated.FontReferenceEditor
        // edits. The reference object itself is never null (Label.DrawSelf
        // dereferences it), so "" yields an empty reference: no font asset and
        // the default size.
        private const int MaxBrushTextChars = 1024;
        private const int MaxSpriteNamesInError = 16;
        private const string BrushKindList = "solid, gradient, texture, texture9, sprite, sprite9, material, ui_brush, video";
        private static readonly string[] BrushNoOptions = new string[0];
        private static readonly string[] BrushGradientOptions = { "end" };
        private static readonly string[] BrushFilterOptions = { "filter" };
        private static readonly string[] BrushSlicingOptions = { "filter", "border_size", "border" };
        private static readonly string[] BrushSpriteOptions = { "sprite", "index", "filter" };
        private static readonly string[] BrushSpriteSlicingOptions = { "sprite", "index", "filter", "border_size", "border" };
        private static readonly string[] FontOptions = { "size" };

        private static bool IsBrushType(Type type)
        {
            return type != null && typeof(FlaxEngine.GUI.IBrush).IsAssignableFrom(type);
        }

        private static string FloatText(float value)
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        private static string ColorText(Color color)
        {
            return FloatText(color.R) + "," + FloatText(color.G) + "," + FloatText(color.B) + "," + FloatText(color.A);
        }

        // Splits "<primary>;key=value;..." and rejects unknown or repeated keys.
        private static string SplitValueFields(string body, string label, string[] allowed, out Dictionary<string, string> options)
        {
            options = new Dictionary<string, string>(StringComparer.Ordinal);
            var parts = body.Split(';');
            for (var i = 1; i < parts.Length; i++)
            {
                var part = parts[i];
                var equals = part.IndexOf('=');
                var key = equals <= 0 ? null : part.Substring(0, equals);
                if (key == null || Array.IndexOf(allowed, key) < 0)
                    throw new McpProtocolException("VALIDATION_FAILED", label + " has an unknown option '" + LimitForLog(part, 64) + "' " + (allowed.Length == 0 ? "(it takes no options)." : "(options: " + string.Join(", ", allowed) + ")."));
                if (options.ContainsKey(key))
                    throw new McpProtocolException("VALIDATION_FAILED", label + " repeats the option '" + key + "'.");
                options[key] = part.Substring(equals + 1);
            }
            return parts[0];
        }

        private static FlaxEngine.GUI.BrushFilter BrushFilterOption(Dictionary<string, string> options, string label)
        {
            string text;
            if (!options.TryGetValue("filter", out text)) return FlaxEngine.GUI.BrushFilter.Linear;
            if (string.Equals(text, "linear", StringComparison.Ordinal)) return FlaxEngine.GUI.BrushFilter.Linear;
            if (string.Equals(text, "point", StringComparison.Ordinal)) return FlaxEngine.GUI.BrushFilter.Point;
            throw new McpProtocolException("VALIDATION_FAILED", label + " filter must be \"linear\" or \"point\".");
        }

        private static float BrushBorderSizeOption(Dictionary<string, string> options, string label)
        {
            string text;
            if (!options.TryGetValue("border_size", out text)) return 10f;
            var value = ParseStrictFloat(text, label + " border_size");
            if (value < 0f) throw new McpProtocolException("VALIDATION_FAILED", label + " border_size must be 0 or greater (the Editor limit for this field).");
            return value;
        }

        private static FMargin BrushBorderOption(Dictionary<string, string> options, string label)
        {
            string text;
            if (!options.TryGetValue("border", out text)) return new FMargin(0.1f);
            var v = ParseStrictFloatList(text, 4, label + " border", "left,right,top,bottom");
            foreach (var component in v)
                if (component < 0f || component > 1f)
                    throw new McpProtocolException("VALIDATION_FAILED", label + " border components are texture-space fractions between 0 and 1 (the Editor limit for this field).");
            return new FMargin(v[0], v[1], v[2], v[3]);
        }

        // Atlas plus sprite index, which is what
        // FlaxEditor.CustomEditors.Editors.SpriteHandleEditor stores.
        private static SpriteHandle CoerceSpriteHandle(string atlasText, Dictionary<string, string> options, string label)
        {
            var atlas = CoerceAssetReference(typeof(SpriteAtlas), atlasText, label + " requires ") as SpriteAtlas;
            string name;
            string indexText;
            var hasName = options.TryGetValue("sprite", out name);
            var hasIndex = options.TryGetValue("index", out indexText);
            if (atlas == null)
            {
                if (hasName || hasIndex)
                    throw new McpProtocolException("VALIDATION_FAILED", label + " needs a SpriteAtlas asset before sprite= or index=.");
                return default(SpriteHandle);
            }
            if (hasName == hasIndex)
                throw new McpProtocolException("VALIDATION_FAILED", label + " requires exactly one of sprite=<name> or index=<n> after the atlas.");
            var count = atlas.SpritesCount;
            if (hasIndex)
            {
                int index;
                if (!int.TryParse(indexText, NumberStyles.None, CultureInfo.InvariantCulture, out index) || index >= count)
                    throw new McpProtocolException("VALIDATION_FAILED", label + " index must be an integer between 0 and " + (count - 1) + " (the atlas has " + count + " sprites).");
                return new SpriteHandle(atlas, index);
            }
            var names = new List<string>();
            for (var i = 0; i < count; i++)
            {
                var spriteName = atlas.GetSprite(i).Name ?? "";
                if (name.Length != 0 && string.Equals(spriteName, name, StringComparison.Ordinal)) return new SpriteHandle(atlas, i);
                if (names.Count < MaxSpriteNamesInError) names.Add(spriteName);
            }
            throw new McpProtocolException("VALIDATION_FAILED", label + " sprite '" + LimitForLog(name, 128) + "' was not found in the atlas (" + count + " sprites" + (names.Count == 0 ? "" : ": " + LimitForLog(string.Join(", ", names.ToArray()), 512) + (count > names.Count ? ", ..." : "")) + ").");
        }

        private static object CoerceBrushValue(Type type, string text, string need, string memberName)
        {
            if (text == null)
                throw new McpProtocolException("VALIDATION_FAILED", need + "a brush string \"<kind>:<value>[;option=value]\" (kinds: " + BrushKindList + "), or an empty string to clear.");
            if (text.Length == 0) return null;
            if (text.Length > MaxBrushTextChars)
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + memberName + "' brush string exceeds " + MaxBrushTextChars + " characters.");
            var colon = text.IndexOf(':');
            var kind = colon <= 0 ? "" : text.Substring(0, colon);
            var body = colon <= 0 ? "" : text.Substring(colon + 1);
            var label = "Member '" + memberName + "' " + kind + " brush";
            Dictionary<string, string> options;
            FlaxEngine.GUI.IBrush brush;
            if (string.Equals(kind, "solid", StringComparison.Ordinal))
            {
                var color = SplitValueFields(body, label, BrushNoOptions, out options);
                brush = new FlaxEngine.GUI.SolidColorBrush(ParseStrictColor(color, label));
            }
            else if (string.Equals(kind, "gradient", StringComparison.Ordinal))
            {
                var start = SplitValueFields(body, label, BrushGradientOptions, out options);
                string end;
                if (!options.TryGetValue("end", out end))
                    throw new McpProtocolException("VALIDATION_FAILED", label + " requires \"gradient:<start color>;end=<end color>\".");
                brush = new FlaxEngine.GUI.LinearGradientBrush(ParseStrictColor(start, label), ParseStrictColor(end, label + " end"));
            }
            else if (string.Equals(kind, "texture", StringComparison.Ordinal))
            {
                var asset = SplitValueFields(body, label, BrushFilterOptions, out options);
                var filter = BrushFilterOption(options, label);
                brush = new FlaxEngine.GUI.TextureBrush(CoerceAssetReference(typeof(Texture), asset, label + " requires ") as Texture) { Filter = filter };
            }
            else if (string.Equals(kind, "texture9", StringComparison.Ordinal))
            {
                var asset = SplitValueFields(body, label, BrushSlicingOptions, out options);
                var filter = BrushFilterOption(options, label);
                var borderSize = BrushBorderSizeOption(options, label);
                var border = BrushBorderOption(options, label);
                brush = new FlaxEngine.GUI.Texture9SlicingBrush(CoerceAssetReference(typeof(Texture), asset, label + " requires ") as Texture) { Filter = filter, BorderSize = borderSize, Border = border };
            }
            else if (string.Equals(kind, "sprite", StringComparison.Ordinal))
            {
                var atlas = SplitValueFields(body, label, BrushSpriteOptions, out options);
                var filter = BrushFilterOption(options, label);
                brush = new FlaxEngine.GUI.SpriteBrush(CoerceSpriteHandle(atlas, options, label)) { Filter = filter };
            }
            else if (string.Equals(kind, "sprite9", StringComparison.Ordinal))
            {
                var atlas = SplitValueFields(body, label, BrushSpriteSlicingOptions, out options);
                var filter = BrushFilterOption(options, label);
                var borderSize = BrushBorderSizeOption(options, label);
                var border = BrushBorderOption(options, label);
                brush = new FlaxEngine.GUI.Sprite9SlicingBrush { Sprite = CoerceSpriteHandle(atlas, options, label), Filter = filter, BorderSize = borderSize, Border = border };
            }
            else if (string.Equals(kind, "material", StringComparison.Ordinal))
            {
                var asset = SplitValueFields(body, label, BrushNoOptions, out options);
                brush = new FlaxEngine.GUI.MaterialBrush(CoerceAssetReference(typeof(MaterialBase), asset, label + " requires ") as MaterialBase);
            }
            else if (string.Equals(kind, "ui_brush", StringComparison.Ordinal))
            {
                var asset = SplitValueFields(body, label, BrushNoOptions, out options);
                var json = CoerceAssetReference(typeof(JsonAsset), asset, label + " requires ") as JsonAsset;
                var dataType = typeof(FlaxEngine.GUI.UIBrushAsset).FullName;
                if (json != null && !string.Equals(json.DataTypeName, dataType, StringComparison.Ordinal))
                    throw new McpProtocolException("VALIDATION_FAILED", label + " requires a JSON asset of " + dataType + ", got " + (json.DataTypeName ?? "unknown") + ".");
                brush = json == null ? new FlaxEngine.GUI.UIBrush() : new FlaxEngine.GUI.UIBrush(json);
            }
            else if (string.Equals(kind, "video", StringComparison.Ordinal))
            {
                var actorId = SplitValueFields(body, label, BrushFilterOptions, out options);
                var filter = BrushFilterOption(options, label);
                VideoPlayer player = null;
                if (actorId.Length != 0)
                {
                    if (!IsGuidN(actorId))
                        throw new McpProtocolException("VALIDATION_FAILED", label + " requires a FlaxEngine.VideoPlayer actor GUID, or nothing for no player.");
                    var actor = RequireActor(actorId);
                    player = actor as VideoPlayer;
                    if (player == null)
                        throw new McpProtocolException("VALIDATION_FAILED", label + " requires a FlaxEngine.VideoPlayer actor, got " + (actor.TypeName ?? "unknown") + ".");
                }
                brush = new FlaxEngine.GUI.VideoBrush(player) { Filter = filter };
            }
            else
            {
                throw new McpProtocolException("VALIDATION_FAILED", need + "a brush string \"<kind>:<value>[;option=value]\" with one of the kinds " + BrushKindList
                    + ", or an empty string to clear. GPUTextureBrush is not available: it holds a runtime GPU texture, not an asset.");
            }
            if (!type.IsInstanceOfType(brush))
                throw new McpProtocolException("VALIDATION_FAILED", need + "a " + (FriendlyTypeName(type) ?? "brush") + ", got " + brush.GetType().FullName + ".");
            return brush;
        }

        private static void FontSizeLimits(out float min, out float max)
        {
            min = 1f;
            max = 500f;
            try
            {
                var property = typeof(FontReference).GetProperty("Size");
                var limits = property == null ? null : property.GetCustomAttributes(typeof(LimitAttribute), false);
                if (limits != null && limits.Length == 1)
                {
                    min = ((LimitAttribute)limits[0]).Min;
                    max = ((LimitAttribute)limits[0]).Max;
                }
            }
            catch { }
        }

        private static object CoerceFontValue(string text, string need, string memberName)
        {
            var shape = need + "a font string \"<font asset>;size=<points>\" (for example \"engine:Editor/Fonts/Roboto-Regular;size=24\"; the asset is a GUID, a Content/ path, an engine:<path>, or empty for no font asset), or an empty string for an empty font reference.";
            if (text == null) throw new McpProtocolException("VALIDATION_FAILED", shape);
            if (text.Length == 0) return new FontReference();
            if (text.Length > MaxBrushTextChars)
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + memberName + "' font string exceeds " + MaxBrushTextChars + " characters.");
            var label = "Member '" + memberName + "' font";
            Dictionary<string, string> options;
            var assetText = SplitValueFields(text, label, FontOptions, out options);
            string sizeText;
            if (!options.TryGetValue("size", out sizeText)) throw new McpProtocolException("VALIDATION_FAILED", shape);
            var size = ParseStrictFloat(sizeText, label + " size");
            float min;
            float max;
            FontSizeLimits(out min, out max);
            if (size < min || size > max)
                throw new McpProtocolException("VALIDATION_FAILED", label + " size must be between " + FloatText(min) + " and " + FloatText(max) + " (the Editor limit for FontReference.Size).");
            return new FontReference(CoerceAssetReference(typeof(FontAsset), assetText, label + " requires ") as FontAsset, size);
        }

        private static string AssetReferenceText(Asset asset, bool byId, out string assetId)
        {
            assetId = null;
            if (asset == null) return "";
            assetId = asset.ID.ToString("N");
            if (byId) return assetId;
            var path = MemberAssetReferencePath(asset.ID);
            // ';' separates options, so a path containing one is given by GUID.
            return path == null || path.IndexOf(';') >= 0 ? assetId : path;
        }

        private static string SpriteReferenceText(SpriteHandle sprite, bool byId, out string assetId)
        {
            var atlas = sprite.Atlas;
            var atlasText = AssetReferenceText(atlas, byId, out assetId);
            if (atlasText.Length == 0) return "";
            if (!byId)
            {
                try
                {
                    var count = atlas.IsLoaded ? atlas.SpritesCount : 0;
                    if (sprite.Index >= 0 && sprite.Index < count)
                    {
                        var name = atlas.GetSprite(sprite.Index).Name;
                        var first = -1;
                        for (var i = 0; i < count && first < 0; i++)
                            if (string.Equals(atlas.GetSprite(i).Name, name, StringComparison.Ordinal)) first = i;
                        // The name form is used only when it selects this very sprite.
                        if (!string.IsNullOrEmpty(name) && name.IndexOf(';') < 0 && first == sprite.Index)
                            return atlasText + ";sprite=" + name;
                    }
                }
                catch { }
            }
            return atlasText + ";index=" + sprite.Index.ToString(CultureInfo.InvariantCulture);
        }

        private static string BrushFilterText(FlaxEngine.GUI.BrushFilter filter)
        {
            return filter == FlaxEngine.GUI.BrushFilter.Point ? "point" : "linear";
        }

        private static string BrushSlicingText(float borderSize, FMargin border)
        {
            return ";border_size=" + FloatText(borderSize) + ";border=" + FloatText(border.Left) + "," + FloatText(border.Right) + "," + FloatText(border.Top) + "," + FloatText(border.Bottom);
        }

        // The string CoerceBrushValue accepts for this brush, or null when the
        // brush type has no string form. byId spells references as GUIDs and
        // sprites as indices, which gives a stable form for comparisons.
        private static string DescribeBrush(object raw, bool byId, out string assetId)
        {
            assetId = null;
            var solid = raw as FlaxEngine.GUI.SolidColorBrush;
            if (solid != null) return "solid:" + ColorText(solid.Color);
            var gradient = raw as FlaxEngine.GUI.LinearGradientBrush;
            if (gradient != null) return "gradient:" + ColorText(gradient.StartColor) + ";end=" + ColorText(gradient.EndColor);
            var texture = raw as FlaxEngine.GUI.TextureBrush;
            if (texture != null) return "texture:" + AssetReferenceText(texture.Texture, byId, out assetId) + ";filter=" + BrushFilterText(texture.Filter);
            var texture9 = raw as FlaxEngine.GUI.Texture9SlicingBrush;
            if (texture9 != null)
                return "texture9:" + AssetReferenceText(texture9.Texture, byId, out assetId) + ";filter=" + BrushFilterText(texture9.Filter) + BrushSlicingText(texture9.BorderSize, texture9.Border);
            var sprite = raw as FlaxEngine.GUI.SpriteBrush;
            if (sprite != null) return "sprite:" + SpriteReferenceText(sprite.Sprite, byId, out assetId) + ";filter=" + BrushFilterText(sprite.Filter);
            var sprite9 = raw as FlaxEngine.GUI.Sprite9SlicingBrush;
            if (sprite9 != null)
                return "sprite9:" + SpriteReferenceText(sprite9.Sprite, byId, out assetId) + ";filter=" + BrushFilterText(sprite9.Filter) + BrushSlicingText(sprite9.BorderSize, sprite9.Border);
            var material = raw as FlaxEngine.GUI.MaterialBrush;
            if (material != null) return "material:" + AssetReferenceText(material.Material, byId, out assetId);
            var ui = raw as FlaxEngine.GUI.UIBrush;
            if (ui != null) return "ui_brush:" + AssetReferenceText(ui.Asset.Asset, byId, out assetId);
            var video = raw as FlaxEngine.GUI.VideoBrush;
            if (video != null) return "video:" + (video.Player == null ? "" : video.Player.ID.ToString("N")) + ";filter=" + BrushFilterText(video.Filter);
            return null;
        }

        private static string DescribeFont(FontReference font, bool byId, out string assetId)
        {
            return AssetReferenceText(font.Font, byId, out assetId) + ";size=" + FloatText(font.Size);
        }

        // Value snapshots for McpMemberUndo. Brushes and font references are
        // mutable objects the property grid edits in place, so the undo stack
        // keeps its own copy and hands a fresh copy to every apply. A video
        // brush is kept as the player's ID, like any scene-object reference.
        private sealed class VideoBrushSnapshot { public Guid PlayerId; public FlaxEngine.GUI.BrushFilter Filter; }

        internal static object SnapshotMemberValue(object value)
        {
            var video = value as FlaxEngine.GUI.VideoBrush;
            if (video != null) return new VideoBrushSnapshot { PlayerId = video.Player == null ? Guid.Empty : video.Player.ID, Filter = video.Filter };
            return CopyMemberValue(value);
        }

        internal static object RestoreMemberValue(object value)
        {
            var video = value as VideoBrushSnapshot;
            if (video == null) return CopyMemberValue(value);
            var id = video.PlayerId;
            return new FlaxEngine.GUI.VideoBrush(id == Guid.Empty ? null : FObject.TryFind<VideoPlayer>(ref id)) { Filter = video.Filter };
        }

        private static object CopyMemberValue(object value)
        {
            var font = value as FontReference;
            if (font != null) return new FontReference(font.Font, font.Size);
            var solid = value as FlaxEngine.GUI.SolidColorBrush;
            if (solid != null) return new FlaxEngine.GUI.SolidColorBrush(solid.Color);
            var gradient = value as FlaxEngine.GUI.LinearGradientBrush;
            if (gradient != null) return new FlaxEngine.GUI.LinearGradientBrush(gradient.StartColor, gradient.EndColor);
            var texture = value as FlaxEngine.GUI.TextureBrush;
            if (texture != null) return new FlaxEngine.GUI.TextureBrush(texture.Texture) { Filter = texture.Filter };
            var texture9 = value as FlaxEngine.GUI.Texture9SlicingBrush;
            if (texture9 != null)
                return new FlaxEngine.GUI.Texture9SlicingBrush(texture9.Texture) { Filter = texture9.Filter, BorderSize = texture9.BorderSize, Border = texture9.Border, ShowBorders = texture9.ShowBorders };
            var sprite = value as FlaxEngine.GUI.SpriteBrush;
            if (sprite != null) return new FlaxEngine.GUI.SpriteBrush(sprite.Sprite) { Filter = sprite.Filter };
            var sprite9 = value as FlaxEngine.GUI.Sprite9SlicingBrush;
            if (sprite9 != null)
                return new FlaxEngine.GUI.Sprite9SlicingBrush { Sprite = sprite9.Sprite, Filter = sprite9.Filter, BorderSize = sprite9.BorderSize, Border = sprite9.Border, ShowBorders = sprite9.ShowBorders };
            var material = value as FlaxEngine.GUI.MaterialBrush;
            if (material != null) return new FlaxEngine.GUI.MaterialBrush(material.Material);
            var ui = value as FlaxEngine.GUI.UIBrush;
            if (ui != null) return new FlaxEngine.GUI.UIBrush(ui.Asset);
            return value;
        }

        // Edit-time hints for values the engine accepts but would not draw.
        private static string[] MemberWriteWarnings(object target, McpMemberSlot slot, object coerced)
        {
            var warnings = new List<string>();
            var control = target as FControl;
            if (control != null && coerced is FlaxEngine.GUI.IBrush && string.Equals(slot.Info.Name, "BackgroundBrush", StringComparison.Ordinal) && control.BackgroundColor.A <= 0f)
                warnings.Add("BackgroundBrush is drawn tinted by BackgroundColor, whose alpha is 0, so the brush stays invisible until BackgroundColor is set (the Editor property grid switches it to white when a brush is picked).");
            var material = coerced as FlaxEngine.GUI.MaterialBrush;
            if (material != null && material.Material != null && !material.Material.IsGUI)
                warnings.Add("The material is not a GUI-domain material; the engine requires one for a MaterialBrush (\"It must be GUI domain\").");
            var font = coerced as FontReference;
            if (font != null && font.Font == null)
                warnings.Add("The font reference has no font asset, so it resolves to no font until one is assigned.");
            return warnings.Count == 0 ? null : warnings.ToArray();
        }

        private static object CoerceMemberValue(Type type, bool? boolValue, double? number, string text, string memberName)
        {
            var setCount = (boolValue.HasValue ? 1 : 0) + (number.HasValue ? 1 : 0) + (text != null ? 1 : 0);
            if (setCount != 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + memberName + "' requires exactly one of Bool, Number, or Text.");
            var need = "Member '" + memberName + "' (" + (FriendlyTypeName(type) ?? "unknown") + ") requires ";
            if (type.IsEnum) return CoerceEnumMemberValue(type, number, text, need);
            if (type == typeof(LocalizedString))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a string value.");
                if (text.Length > MaxScriptValueWriteChars) throw new McpProtocolException("VALIDATION_FAILED", "Member '" + memberName + "' exceeds " + MaxScriptValueWriteChars + " characters.");
                return new LocalizedString(text);
            }
            if (type == typeof(LayersMask))
            {
                if (!number.HasValue) throw new McpProtocolException("VALIDATION_FAILED", need + "an integral layer bit mask (0-4294967295).");
                var n = number.Value;
                if (double.IsNaN(n) || double.IsInfinity(n) || Math.Truncate(n) != n || n < 0.0 || n > uint.MaxValue)
                    throw new McpProtocolException("VALIDATION_FAILED", need + "an integral layer bit mask (0-4294967295).");
                return new LayersMask((uint)n);
            }
            if (type == typeof(Quaternion))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z,w\" string.");
                var v = ParseStrictFloatList(text, 4, need + "an \"x,y,z,w\" string", "x,y,z,w");
                return new Quaternion(v[0], v[1], v[2], v[3]);
            }
            if (type == typeof(Rectangle))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,width,height\" string.");
                var v = ParseStrictFloatList(text, 4, need + "an \"x,y,width,height\" string", "x,y,width,height");
                return new Rectangle(v[0], v[1], v[2], v[3]);
            }
            if (type == typeof(FMargin))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "a \"left,right,top,bottom\" string.");
                var v = ParseStrictFloatList(text, 4, need + "a \"left,right,top,bottom\" string", "left,right,top,bottom");
                return new FMargin(v[0], v[1], v[2], v[3]);
            }
            if (type == typeof(Double2) || type == typeof(Int2))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y\" string.");
                var v = ParseStrictFloatList(text, 2, need + "an \"x,y\" string", "x,y");
                if (type == typeof(Double2)) return new Double2(v[0], v[1]);
                RequireIntegralComponents(v, need);
                return new Int2((int)v[0], (int)v[1]);
            }
            if (type == typeof(Double3) || type == typeof(Int3))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z\" string.");
                var v = ParseStrictFloatList(text, 3, need + "an \"x,y,z\" string", "x,y,z");
                if (type == typeof(Double3)) return new Double3(v[0], v[1], v[2]);
                RequireIntegralComponents(v, need);
                return new Int3((int)v[0], (int)v[1], (int)v[2]);
            }
            if (type == typeof(Double4) || type == typeof(Int4))
            {
                if (text == null) throw new McpProtocolException("VALIDATION_FAILED", need + "an \"x,y,z,w\" string.");
                var v = ParseStrictFloatList(text, 4, need + "an \"x,y,z,w\" string", "x,y,z,w");
                if (type == typeof(Double4)) return new Double4(v[0], v[1], v[2], v[3]);
                RequireIntegralComponents(v, need);
                return new Int4((int)v[0], (int)v[1], (int)v[2], (int)v[3]);
            }
            if (IsBrushType(type)) return CoerceBrushValue(type, text, need, memberName);
            if (type == typeof(FontReference)) return CoerceFontValue(text, need, memberName);
            if (IsJsonAssetReferenceType(type))
            {
                var json = CoerceAssetReference(typeof(JsonAsset), text, need) as JsonAsset;
                if (json == null) return Activator.CreateInstance(type);
                var dataType = type.GetGenericArguments()[0];
                if (!string.Equals(json.DataTypeName, dataType.FullName, StringComparison.Ordinal))
                    throw new McpProtocolException("VALIDATION_FAILED", need + "a JSON asset of " + (dataType.FullName ?? "unknown") + ", got " + (json.DataTypeName ?? "unknown") + ".");
                return Activator.CreateInstance(type, new object[] { json });
            }
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
            return CoerceScriptFieldValue(new McpScriptFieldSet { Bool = boolValue, Number = number, Text = text }, type, memberName);
        }

        private static void RequireIntegralComponents(float[] values, string need)
        {
            foreach (var value in values)
                if (Math.Truncate(value) != value || value < int.MinValue || value > int.MaxValue)
                    throw new McpProtocolException("VALIDATION_FAILED", need + "integral components.");
        }

        private static bool MemberValuesEqual(object before, object after)
        {
            if (before == null || after == null) return before == null && after == null;
            var beforeObject = before as FObject;
            var afterObject = after as FObject;
            if (beforeObject != null && afterObject != null) return ReferenceEquals(before, after) || beforeObject.ID == afterObject.ID;
            if (before is FlaxEngine.GUI.IBrush && after is FlaxEngine.GUI.IBrush)
            {
                // Compared through the string form: Sprite9SlicingBrush.Equals
                // ignores its border fields.
                string ignored;
                var left = DescribeBrush(before, true, out ignored);
                var right = DescribeBrush(after, true, out ignored);
                if (left != null && right != null) return string.Equals(left, right, StringComparison.Ordinal);
            }
            return before.Equals(after);
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
            if (raw is sbyte) return new McpMaterialTypedValue { Kind = "integer", Integer = (sbyte)raw };
            if (raw is ushort) return new McpMaterialTypedValue { Kind = "integer", Integer = (ushort)raw };
            if (raw is uint) return new McpMaterialTypedValue { Kind = "integer", Integer = (uint)raw };
            if (raw is ulong) return new McpMaterialTypedValue { Kind = "integer", Integer = unchecked((long)(ulong)raw) };
            if (raw is Vector2) { var v = (Vector2)raw; return new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = (float)v.X, Y = (float)v.Y } }; }
            if (raw is Vector3) { var v = (Vector3)raw; return new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = (float)v.X, Y = (float)v.Y, Z = (float)v.Z } }; }
            if (raw is Vector4) { var v = (Vector4)raw; return new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = (float)v.X, Y = (float)v.Y, Z = (float)v.Z, W = (float)v.W } }; }
            if (raw is Double2) { var v = (Double2)raw; return new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = (float)v.X, Y = (float)v.Y } }; }
            if (raw is Double3) { var v = (Double3)raw; return new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = (float)v.X, Y = (float)v.Y, Z = (float)v.Z } }; }
            if (raw is Double4) { var v = (Double4)raw; return new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = (float)v.X, Y = (float)v.Y, Z = (float)v.Z, W = (float)v.W } }; }
            if (raw is Int2) { var v = (Int2)raw; return new McpMaterialTypedValue { Kind = "vector2", Vector2 = new McpVector2 { X = v.X, Y = v.Y } }; }
            if (raw is Int3) { var v = (Int3)raw; return new McpMaterialTypedValue { Kind = "vector3", Vector3 = new McpVector3 { X = v.X, Y = v.Y, Z = v.Z } }; }
            if (raw is Int4) { var v = (Int4)raw; return new McpMaterialTypedValue { Kind = "vector4", Vector4 = new McpVector4 { X = v.X, Y = v.Y, Z = v.Z, W = v.W } }; }
            if (raw is Quaternion) { var v = (Quaternion)raw; return new McpMaterialTypedValue { Kind = "quaternion", Vector4 = new McpVector4 { X = v.X, Y = v.Y, Z = v.Z, W = v.W } }; }
            if (raw is Rectangle) { var v = (Rectangle)raw; return new McpMaterialTypedValue { Kind = "rectangle", Vector4 = new McpVector4 { X = v.Location.X, Y = v.Location.Y, Z = v.Size.X, W = v.Size.Y } }; }
            if (raw is FMargin) { var v = (FMargin)raw; return new McpMaterialTypedValue { Kind = "margin", Vector4 = new McpVector4 { X = v.Left, Y = v.Right, Z = v.Top, W = v.Bottom } }; }
            if (raw is LocalizedString) { var v = raw.ToString() ?? ""; return new McpMaterialTypedValue { Kind = "string", Text = v.Length <= MaxScriptValueStringChars ? v : v.Substring(0, MaxScriptValueStringChars) + " [truncated]" }; }
            if (raw is LayersMask) return new McpMaterialTypedValue { Kind = "integer", Integer = ((LayersMask)raw).Mask, TypeName = "FlaxEngine.LayersMask" };
            if (raw is Actor) return new McpMaterialTypedValue { Kind = "actor", Text = ((Actor)raw).ID.ToString("N"), TypeName = LimitForLog(type.FullName, 256) };
            if (raw is Script) return new McpMaterialTypedValue { Kind = "script", Text = ((Script)raw).ID.ToString("N"), TypeName = LimitForLog(type.FullName, 256) };
            if (IsJsonAssetReferenceType(type))
            {
                JsonAsset json = null;
                try
                {
                    var assetField = type.GetField("Asset");
                    json = assetField == null ? null : assetField.GetValue(raw) as JsonAsset;
                }
                catch { json = null; }
                if (json == null) return new McpMaterialTypedValue { Kind = "null", TypeName = LimitForLog(type.FullName, 256) };
                return new McpMaterialTypedValue { Kind = "asset", AssetId = json.ID.ToString("N"), Text = MemberAssetReferencePath(json.ID), TypeName = LimitForLog(json.DataTypeName, 256) };
            }
            // Text is the string the write path accepts, so a value can be
            // read, edited, and written back. A brush type without a string
            // form reports its type only.
            if (raw is FlaxEngine.GUI.IBrush)
            {
                string brushAssetId = null;
                string brushText;
                try { brushText = DescribeBrush(raw, false, out brushAssetId); }
                catch { brushText = null; }
                return new McpMaterialTypedValue { Kind = "brush", Text = LimitForLog(brushText, MaxBrushTextChars), AssetId = brushAssetId, TypeName = LimitForLog(type.FullName, 256) };
            }
            var fontReference = raw as FontReference;
            if (fontReference != null)
            {
                string fontAssetId = null;
                string fontText;
                try { fontText = DescribeFont(fontReference, false, out fontAssetId); }
                catch { fontText = null; }
                return new McpMaterialTypedValue { Kind = "font", Text = LimitForLog(fontText, MaxBrushTextChars), AssetId = fontAssetId, Number = fontReference.Size, TypeName = LimitForLog(type.FullName, 256) };
            }
            var assetReference = raw as Asset;
            if (assetReference != null)
                return new McpMaterialTypedValue { Kind = "asset", AssetId = assetReference.ID.ToString("N"), Text = MemberAssetReferencePath(assetReference.ID), TypeName = LimitForLog(type.FullName, 256) };
            return SafeMaterialAnimationValue(raw);
        }

        private McpMemberDto MemberDto(object target, McpMemberSlot slot, string targetKind)
        {
            var type = slot.ValueType;
            var dto = new McpMemberDto
            {
                Name = LimitForLog(slot.Info.Name, 256),
                DeclaringType = slot.DeclaringType == null ? null : LimitForLog(slot.DeclaringType.FullName, 256),
                Type = FriendlyTypeName(type),
                Kind = MemberKindName(type),
                Group = LimitForLog(slot.Group, 128),
                Tooltip = LimitForLog(slot.Tooltip, MaxMemberTooltipChars),
            };
            var block = MemberWriteBlockReason(slot, targetKind);
            dto.Writable = block == null;
            if (slot.HasLimit)
            {
                if (slot.Min > float.MinValue) dto.Min = slot.Min;
                if (slot.Max < float.MaxValue) dto.Max = slot.Max;
            }
            if (IsSupportedMemberType(type))
            {
                try { dto.Value = ProjectMemberValue(slot.Info.GetValue(target), type); }
                catch (Exception ex) { dto.Reason = LimitForLog("Read failed: " + DescribeException(ex), 256); }
                if (type.IsEnum)
                {
                    try
                    {
                        var names = Enum.GetNames(type);
                        if (names.Length > MaxMemberEnumValues) Array.Resize(ref names, MaxMemberEnumValues);
                        dto.EnumValues = names;
                    }
                    catch { }
                }
            }
            if (dto.Reason == null) dto.Reason = block;
            if (dto.Reason == null && dto.Value != null && string.Equals(dto.Value.Kind, "brush", StringComparison.Ordinal) && dto.Value.Text == null)
                dto.Reason = "The current brush is a " + (dto.Value.TypeName ?? "brush") + ", which has no string form; it can be replaced or cleared but not read back.";
            return dto;
        }

        private McpMemberListResult ListMembers(object target, Actor owner, string targetKind, McpMemberListRequest q)
        {
            var limit = q.Limit == 0 ? DefaultMemberListEntries : q.Limit;
            if (limit < 1 || limit > MaxMemberListEntries)
                throw new McpProtocolException("VALIDATION_FAILED", "Limit must be between 1 and " + MaxMemberListEntries + ".");
            var filter = q.Filter;
            if (filter != null && (filter.Length == 0 || filter.Length > MaxMemberFilterChars))
                throw new McpProtocolException("VALIDATION_FAILED", "Filter must be between 1 and " + MaxMemberFilterChars + " characters.");
            var slots = EditorVisibleMembers(target);
            slots.Sort((left, right) => string.Compare(left.Info.Name, right.Info.Name, StringComparison.Ordinal));
            var members = new List<McpMemberDto>();
            var total = 0;
            var skipped = 0;
            foreach (var slot in slots)
            {
                if (filter != null && slot.Info.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (!q.IncludeUnsupported && !IsSupportedMemberType(slot.ValueType)) { skipped++; continue; }
                total++;
                if (members.Count < limit) members.Add(MemberDto(target, slot, targetKind));
            }
            var revision = CurrentRevision(owner == null ? null : owner.Scene);
            var warnings = new List<string> { "Members mirror the Editor property grid selection (public or [ShowInEditor], never [HideInEditor]). Writable is false for read-only, [NoSerialize], hierarchy-owned, and unsupported-type members." };
            if (skipped > 0) warnings.Add(skipped + " member(s) with unsupported value types were omitted; pass IncludeUnsupported to list them without values.");
            return new McpMemberListResult
            {
                ActorId = owner == null ? null : owner.ID.ToString("N"), Target = targetKind, TypeName = LimitForLog(target.GetType().FullName, 256),
                Members = members.ToArray(), TotalCount = total, UnsupportedSkipped = skipped, Truncated = total > members.Count,
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision, Warnings = warnings.ToArray(),
            };
        }

        private McpMemberListResult GetActorProperties(McpMemberListRequest q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Actor property list parameters are required.");
            var actor = RequireActor(q.ActorId);
            return ListMembers(actor, actor, MemberTargetActor, q);
        }

        // Shared edit-time write for actor and UI-control members: coerce,
        // preview (dry-run), then apply through McpMemberUndo so the change
        // lands on the Editor undo stack.
        private McpActorPropertySetResult WriteMember(object target, Actor owner, string targetKind, McpActorPropertySet q)
        {
            if (q.Path != null) return WriteNestedMember(target, owner, targetKind, q);
            var slot = ResolveMemberSlot(target, q.Property, targetKind);
            var block = MemberWriteBlockReason(slot, targetKind);
            if (block != null)
                throw new McpProtocolException("VALIDATION_FAILED", "Property '" + slot.Info.Name + "' cannot be written: " + block);
            var coerced = CoerceMemberValue(slot.ValueType, q.Bool, q.Number, q.Text, slot.Info.Name);
            RequireWithinEditorLimit(slot, coerced);
            object beforeRaw;
            try { beforeRaw = slot.Info.GetValue(target); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Property '" + slot.Info.Name + "' read failed: " + DescribeException(ex)); }
            var wouldChange = !MemberValuesEqual(beforeRaw, coerced);
            var before = ProjectMemberValue(beforeRaw, slot.ValueType);
            var typeName = FriendlyTypeName(slot.ValueType);
            var warnings = MemberWriteWarnings(target, slot, coerced);
            if (q.DryRun)
            {
                var preview = CurrentRevision(owner.Scene);
                return new McpActorPropertySetResult
                {
                    ActorId = owner.ID.ToString("N"), Property = slot.Info.Name, Type = typeName, DryRun = true, WouldChange = wouldChange,
                    Before = before, After = ProjectMemberValue(coerced, slot.ValueType), Actor = null,
                    ProjectRevision = preview.ProjectRevision, SceneRevision = preview.SceneRevision, Warnings = warnings,
                };
            }
            if (!wouldChange)
            {
                // A write of the current value would only add an empty undo
                // step and mark the scene edited for nothing.
                var unchanged = CurrentRevision(owner.Scene);
                return new McpActorPropertySetResult
                {
                    ActorId = owner.ID.ToString("N"), Property = slot.Info.Name, Type = typeName, DryRun = false, WouldChange = false,
                    Before = before, After = before, Actor = ActorDto(owner, false),
                    ProjectRevision = unchanged.ProjectRevision, SceneRevision = unchanged.SceneRevision, Warnings = warnings,
                };
            }
            var action = new McpMemberUndo(owner, string.Equals(targetKind, MemberTargetControl, StringComparison.Ordinal), slot.Info.Name, beforeRaw, coerced);
            try { action.Do(); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Property '" + slot.Info.Name + "' write failed: " + DescribeException(ex)); }
            FEditor.Instance.Undo.AddAction(action);
            MarkEdited(owner);
            var revision = AdvanceSceneRevision(owner.Scene);
            object afterRaw;
            try { afterRaw = slot.Info.GetValue(target); }
            catch { afterRaw = coerced; }
            return new McpActorPropertySetResult
            {
                ActorId = owner.ID.ToString("N"), Property = slot.Info.Name, Type = typeName, DryRun = false, WouldChange = wouldChange,
                Before = before, After = ProjectMemberValue(afterRaw, slot.ValueType), Actor = ActorDto(owner, false),
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision, Warnings = warnings,
            };
        }

        // ---------------------------------------------------------------
        // Bridge v34: nested member paths (Path: 1-4 identifiers) and the
        // script write pipeline shared with actor members.
        //
        // The write mirrors the Editor property grid
        // (FlaxEditor.CustomEditors.CustomEditor.SetValue/RefreshInternal): the
        // chain of values is read from the root member down, the leaf is set
        // on the innermost value (a boxed copy for a structure), and then every
        // parent is written back with its own setter, always, for structures
        // and classes alike (CustomEditor.SyncParent walks up the same way).
        // Every level passes the property-grid visibility rules
        // (GenericEditor.GetItemsForType, see EditorVisibleMembers): hidden
        // ([HideInEditor]) members are not reachable, read-only members and, at
        // edit time, [NoSerialize] members are refused. Intermediate levels are
        // non-engine structures or non-null classes that are not engine
        // objects or collections (arrays, lists and dictionaries are out of
        // scope), the leaf goes through CoerceMemberValue.
        private sealed class McpMemberChain
        {
            public string[] Names;
            public McpMemberSlot[] Slots;
            public object[] Containers; // [0] = the root target; [i] = the value of Slots[i - 1] (boxed copy for structures)
        }

        private sealed class McpMemberWritePlan
        {
            public McpMemberChain Chain;
            public Type LeafType;
            public object Coerced;
            public object Before;
            public bool WouldChange;
        }

        private const int MaxMemberPathDepth = 4;

        // Null when the request carries no Path. A Path replaces the plain
        // member name; naming both is accepted only when they agree.
        private static string[] RequireMemberPathRequest(string[] path, string plainName, string plainLabel)
        {
            if (path == null) return null;
            if (path.Length < 1 || path.Length > MaxMemberPathDepth)
                throw new McpProtocolException("VALIDATION_FAILED", "Path must contain 1-" + MaxMemberPathDepth + " member names.");
            for (var i = 0; i < path.Length; i++)
            {
                var segment = path[i];
                if (string.IsNullOrEmpty(segment) || segment.Length > 128 || !IsScriptFieldName(segment))
                    throw new McpProtocolException("VALIDATION_FAILED", "Path segment " + i + " must match ^[A-Za-z_][A-Za-z0-9_]*$ and be 1-128 characters (the Type.Member form is not available in a Path).", new McpMemberPathErrorDetails { Path = path, SegmentIndex = i, Segment = LimitForLog(segment, 128) });
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

        private static McpMemberChain ResolveMemberChain(object root, string[] path, string targetKind, bool editTime, bool nested)
        {
            var count = path.Length;
            var chain = new McpMemberChain { Names = new string[count], Slots = new McpMemberSlot[count], Containers = new object[count] };
            chain.Containers[0] = root;
            var label = string.Equals(targetKind, MemberTargetScript, StringComparison.Ordinal) ? "Member" : "Property";
            for (var i = 0; i < count; i++)
            {
                var container = chain.Containers[i];
                McpMemberSlot slot = null;
                if (i == 0)
                {
                    try { slot = ResolveMemberSlot(container, path[0], targetKind); }
                    catch (McpProtocolException ex) when (nested) { throw MemberPathError(path, 0, ex.Message); }
                    var block = MemberWriteBlockReason(slot, targetKind, count == 1);
                    if (block == null && editTime && string.Equals(targetKind, MemberTargetScript, StringComparison.Ordinal) && slot.NoSerialize)
                        block = "Member is [NoSerialize]; an edit-time write would not persist.";
                    if (block != null)
                    {
                        if (nested) throw MemberPathError(path, 0, "cannot be written: " + block);
                        throw new McpProtocolException("VALIDATION_FAILED", label + " '" + slot.Info.Name + "' cannot be written: " + block);
                    }
                }
                else
                {
                    var type = container.GetType();
                    foreach (var candidate in EditorVisibleMembers(container))
                        if (string.Equals(candidate.Info.Name, path[i], StringComparison.Ordinal)) { slot = candidate; break; }
                    if (slot == null)
                        throw MemberPathError(path, i, "is not an editor-visible member of " + (type.FullName ?? "unknown") + " (public or [ShowInEditor], never [HideInEditor]).");
                    if (slot.ReadOnly)
                        throw MemberPathError(path, i, "cannot be written: Member is read-only (no setter or [ReadOnly]).");
                    if (editTime && slot.NoSerialize)
                        throw MemberPathError(path, i, "cannot be written: Member is [NoSerialize]; an edit-time write would not persist.");
                    if (i == count - 1 && !IsSupportedMemberType(slot.ValueType))
                        throw MemberPathError(path, i, "cannot be written: Unsupported type " + (FriendlyTypeName(slot.ValueType) ?? "unknown") + ". Extend Path to a member of it, or use a supported leaf type.");
                }
                chain.Slots[i] = slot;
                chain.Names[i] = slot.Info.Name;
                if (i == count - 1) break;
                object value;
                try { value = slot.Info.GetValue(container); }
                catch (Exception ex) { throw MemberPathError(path, i, "read failed: " + DescribeException(ex)); }
                var refusal = NestedContainerRefusal(slot.ValueType, value);
                if (refusal != null) throw MemberPathError(path, i, refusal);
                chain.Containers[i + 1] = value;
            }
            return chain;
        }

        private static McpMemberWritePlan PlanMemberWrite(object root, string[] path, string targetKind, bool editTime, bool nested, bool? boolValue, double? number, string text)
        {
            var chain = ResolveMemberChain(root, path, targetKind, editTime, nested);
            var last = chain.Slots.Length - 1;
            var leaf = chain.Slots[last];
            var coerced = CoerceMemberValue(leaf.ValueType, boolValue, number, text, leaf.Info.Name);
            RequireWithinEditorLimit(leaf, coerced);
            object before;
            try { before = leaf.Info.GetValue(chain.Containers[last]); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Member '" + leaf.Info.Name + "' read failed: " + DescribeException(ex)); }
            return new McpMemberWritePlan { Chain = chain, LeafType = leaf.ValueType, Coerced = coerced, Before = before, WouldChange = !MemberValuesEqual(before, coerced) };
        }

        // Sets the leaf, then writes each parent back up to the root member.
        private static void ApplyMemberWrite(McpMemberWritePlan plan, string display)
        {
            var chain = plan.Chain;
            var last = chain.Slots.Length - 1;
            var step = last;
            try
            {
                chain.Slots[last].Info.SetValue(chain.Containers[last], plan.Coerced);
                for (step = last - 1; step >= 0; step--)
                    chain.Slots[step].Info.SetValue(chain.Containers[step], chain.Containers[step + 1]);
            }
            catch (Exception ex)
            {
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + display + "' write failed at '" + chain.Names[Math.Max(step, 0)] + "': " + DescribeException(ex));
            }
        }

        // Fresh read of the written leaf through the root (never the plan's copies).
        private static object ReadMemberLeaf(object root, McpMemberChain chain, object fallback)
        {
            try
            {
                var current = root;
                for (var i = 0; i < chain.Slots.Length; i++) current = chain.Slots[i].Info.GetValue(current);
                return current;
            }
            catch { return fallback; }
        }

        // Edit-time nested write on an actor (or UI control) member.
        private McpActorPropertySetResult WriteNestedMember(object target, Actor owner, string targetKind, McpActorPropertySet q)
        {
            var path = RequireMemberPathRequest(q.Path, q.Property, "Property");
            var plan = PlanMemberWrite(target, path, targetKind, true, true, q.Bool, q.Number, q.Text);
            var display = string.Join(".", plan.Chain.Names);
            var typeName = FriendlyTypeName(plan.LeafType);
            var before = ProjectMemberValue(plan.Before, plan.LeafType);
            if (q.DryRun)
            {
                var preview = CurrentRevision(owner.Scene);
                return new McpActorPropertySetResult
                {
                    ActorId = owner.ID.ToString("N"), Property = display, Type = typeName, DryRun = true, WouldChange = plan.WouldChange,
                    Before = before, After = ProjectMemberValue(plan.Coerced, plan.LeafType), Actor = null, Path = plan.Chain.Names,
                    ProjectRevision = preview.ProjectRevision, SceneRevision = preview.SceneRevision,
                };
            }
            if (!plan.WouldChange)
            {
                var unchanged = CurrentRevision(owner.Scene);
                return new McpActorPropertySetResult
                {
                    ActorId = owner.ID.ToString("N"), Property = display, Type = typeName, DryRun = false, WouldChange = false,
                    Before = before, After = before, Actor = ActorDto(owner, false), Path = plan.Chain.Names,
                    ProjectRevision = unchanged.ProjectRevision, SceneRevision = unchanged.SceneRevision,
                };
            }
            // One snapshot undo record on the owning actor, like a property
            // grid edit; RecordEnd also runs when the write throws midway.
            var undo = FEditor.Instance.Undo;
            undo.RecordBegin(owner, "Set property");
            try { ApplyMemberWrite(plan, display); }
            finally { undo.RecordEnd(owner); }
            MarkEdited(owner);
            var revision = AdvanceSceneRevision(owner.Scene);
            return new McpActorPropertySetResult
            {
                ActorId = owner.ID.ToString("N"), Property = display, Type = typeName, DryRun = false, WouldChange = true,
                Before = before, After = ProjectMemberValue(ReadMemberLeaf(target, plan.Chain, plan.Coerced), plan.LeafType), Actor = ActorDto(owner, false), Path = plan.Chain.Names,
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
            };
        }

        private object ExecuteSetActorProperty(McpActorPropertySet q)
        {
            // Dry-run previews never consume idempotency keys (same rule as
            // script.instance_set_value).
            if (q != null && q.DryRun) return SetActorProperty(q);
            return ExecuteIdempotent("actor.set_property", q == null ? null : q.IdempotencyKey, q, () => SetActorProperty(q));
        }

        private McpActorPropertySetResult SetActorMember(McpActorPropertySet q)
        {
            RequireEditTime("actor.set_property");
            var actor = RequireActor(q.ActorId);
            CheckSceneWrite(actor.Scene, q.ExpectedSceneRevision, q.LeaseId);
            return WriteMember(actor, actor, MemberTargetActor, q);
        }

        // Bridge v33 UI workflows. Controls are created the way the Editor
        // scene tree does it: a UIControl actor owning a fresh Control, spawned
        // through SceneEditing.Spawn. Control members use the same
        // editor-visible member surface as actors.
        private static UIControl RequireUiControl(string id, out FControl control)
        {
            var actor = RequireActor(id);
            var ui = actor as UIControl;
            if (ui == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Actor is not a FlaxEngine.UIControl (got " + (actor.TypeName ?? "unknown") + ").");
            control = ui.Control;
            if (control == null)
                throw new McpProtocolException("VALIDATION_FAILED", "The UIControl actor has no Control assigned.");
            return ui;
        }

        private McpMemberListResult GetUiControlProperties(McpMemberListRequest q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Control property list parameters are required.");
            FControl control;
            var ui = RequireUiControl(q.ActorId, out control);
            return ListMembers(control, ui, MemberTargetControl, q);
        }

        private object ExecuteSetUiControlProperty(McpActorPropertySet q)
        {
            if (q != null && q.DryRun) return SetUiControlProperty(q);
            return ExecuteIdempotent("ui.set_control_property", q == null ? null : q.IdempotencyKey, q, () => SetUiControlProperty(q));
        }

        private McpActorPropertySetResult SetUiControlProperty(McpActorPropertySet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Control property parameters are required.");
            RequireEditTime("ui.set_control_property");
            FControl control;
            var ui = RequireUiControl(q.ActorId, out control);
            CheckSceneWrite(ui.Scene, q.ExpectedSceneRevision, q.LeaseId);
            return WriteMember(control, ui, MemberTargetControl, q);
        }

        private static Type ResolveUiControlType(string typeName)
        {
            var type = ResolveType(typeName, typeof(FControl));
            var fullName = type.FullName ?? "";
            // Editor-only controls do not exist in a cooked game, so a scene
            // referencing one would fail to load outside the Editor.
            if (fullName.StartsWith("FlaxEditor.", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Editor-only controls (FlaxEditor.*) cannot be placed in a game scene.");
            if (type.IsAbstract || type.IsGenericTypeDefinition || !type.IsVisible || type.GetConstructor(Type.EmptyTypes) == null || typeof(FRootControl).IsAssignableFrom(type))
                throw new McpProtocolException("VALIDATION_FAILED", "Control type must be a public, non-abstract FlaxEngine.GUI.Control with a parameterless constructor (root controls are not spawnable).");
            return type;
        }

        private object ExecuteCreateUiControl(McpUiControlCreate q)
        {
            if (q != null && q.DryRun) return CreateUiControl(q);
            return ExecuteIdempotent("ui.create_control", q == null ? null : q.IdempotencyKey, q, () => CreateUiControl(q));
        }

        private McpUiControlCreateResult CreateUiControl(McpUiControlCreate q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Control creation parameters are required.");
            var type = ResolveUiControlType(q.ControlType);
            var name = Limit(q.Name, 128, type.Name);
            if (name.Length == 0) throw new McpProtocolException("VALIDATION_FAILED", "Name must not be empty.");
            RequireEditTime("ui.create_control");
            var parent = RequireActor(q.ParentId);
            var parentControl = parent as UIControl;
            if (!(parent is UICanvas) && parentControl == null)
                throw new McpProtocolException("VALIDATION_FAILED", "UI controls must be parented to a FlaxEngine.UICanvas or a FlaxEngine.UIControl actor (got " + (parent.TypeName ?? "unknown") + ").");
            if (parentControl != null && !(parentControl.Control is FContainerControl))
                throw new McpProtocolException("VALIDATION_FAILED", "The parent UIControl's control cannot contain children (it is not a ContainerControl).");
            CheckSceneWrite(parent.Scene, q.ExpectedSceneRevision, q.LeaseId);
            if (q.DryRun)
            {
                var preview = CurrentRevision(parent.Scene);
                return new McpUiControlCreateResult
                {
                    DryRun = true, ControlType = type.FullName, ParentId = parent.ID.ToString("N"), Actor = null,
                    ProjectRevision = preview.ProjectRevision, SceneRevision = preview.SceneRevision,
                    Warnings = new[] { "Dry-run preview only: no actor was created." },
                };
            }
            var control = new ScriptType(type).CreateInstance() as FControl;
            if (control == null) throw new McpProtocolException("VALIDATION_FAILED", "Control type did not create a FlaxEngine.GUI.Control.");
            var actor = new UIControl { Control = control, Name = name, StaticFlags = parent.StaticFlags };
            FEditor.Instance.SceneEditing.Spawn(actor, parent, -1, false);
            MarkEdited(actor);
            var revision = AdvanceSceneRevision(actor.Scene);
            return new McpUiControlCreateResult
            {
                DryRun = false, ControlType = type.FullName, ParentId = parent.ID.ToString("N"), Actor = ActorDto(actor, false),
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
                Warnings = new[] { "The scene was marked edited, not saved. Undo with edit_undo (SceneEditing.Spawn records the spawn)." },
            };
        }

        // Bridge v33 play-mode script drive. Play mode owns engine state, so
        // these two operations touch game script members only: an
        // editor-visible field/property write, and a bounded public method
        // invocation. Neither records undo nor marks a scene edited (Flax
        // restores the edit-time scene when play stops).
        private const int MaxRuntimeInvokeArgs = 4;

        private string RequirePlaySession(string capability)
        {
            if (!FEditor.IsPlayMode)
                throw new McpProtocolException("INVALID_STATE", capability + " requires play mode.");
            lock (_stateLock) return _playSessionId;
        }

        private McpRuntimeScriptValueResult SetRuntimeScriptValue(McpRuntimeScriptValueSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Runtime script value parameters are required.");
            var session = RequirePlaySession("runtime.set_script_value");
            var script = RequireScript(q.ScriptId);
            var nestedPath = RequireMemberPathRequest(q.Path, q.Member, "Member");
            if (nestedPath != null)
            {
                // Bridge v34 nested write (runtime rules: no [NoSerialize] refusal,
                // no undo; every level still follows the property-grid visibility).
                var plan = PlanMemberWrite(script, nestedPath, MemberTargetScript, false, true, q.Bool, q.Number, q.Text);
                var display = string.Join(".", plan.Chain.Names);
                ApplyMemberWrite(plan, display);
                var leafType = plan.LeafType;
                return new McpRuntimeScriptValueResult
                {
                    ScriptId = script.ID.ToString("N"), Member = display, Type = FriendlyTypeName(leafType), Path = plan.Chain.Names,
                    Before = ProjectMemberValue(plan.Before, leafType), After = ProjectMemberValue(ReadMemberLeaf(script, plan.Chain, plan.Coerced), leafType), PlaySessionId = session,
                    Warnings = new[] { "Runtime write: no undo was recorded and the value is discarded when play stops." },
                };
            }
            var slot = ResolveMemberSlot(script, q.Member, MemberTargetScript);
            var block = MemberWriteBlockReason(slot, MemberTargetScript);
            if (block != null)
                throw new McpProtocolException("VALIDATION_FAILED", "Member '" + slot.Info.Name + "' cannot be written: " + block);
            var coerced = CoerceMemberValue(slot.ValueType, q.Bool, q.Number, q.Text, slot.Info.Name);
            object beforeRaw;
            try { beforeRaw = slot.Info.GetValue(script); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Member '" + slot.Info.Name + "' read failed: " + DescribeException(ex)); }
            try { slot.Info.SetValue(script, coerced); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Member '" + slot.Info.Name + "' write failed: " + DescribeException(ex)); }
            object afterRaw;
            try { afterRaw = slot.Info.GetValue(script); }
            catch { afterRaw = coerced; }
            return new McpRuntimeScriptValueResult
            {
                ScriptId = script.ID.ToString("N"), Member = slot.Info.Name, Type = FriendlyTypeName(slot.ValueType),
                Before = ProjectMemberValue(beforeRaw, slot.ValueType), After = ProjectMemberValue(afterRaw, slot.ValueType), PlaySessionId = session,
                Warnings = new[] { "Runtime write: no undo was recorded and the value is discarded when play stops." },
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
            var session = RequirePlaySession("runtime.invoke_script_method");
            var script = RequireScript(q.ScriptId);
            ScriptMemberInfo[] methods;
            try { methods = new ScriptType(script.GetType()).GetMethods(BindingFlags.Instance | BindingFlags.Public); }
            catch { methods = new ScriptMemberInfo[0]; }
            var named = new List<ScriptMemberInfo>();
            foreach (var candidate in methods)
            {
                if (!candidate || !candidate.IsMethod || candidate.IsStatic || candidate.IsGeneric) continue;
                if (!string.Equals(candidate.Name, q.Method, StringComparison.Ordinal)) continue;
                var managed = candidate.Type as MethodInfo;
                if (managed != null && managed.IsSpecialName) continue;
                var declaring = candidate.DeclaringType;
                // Only methods written in game code: never engine lifecycle or
                // framework members inherited from FlaxEngine.Script.
                if (IsEngineTypeName(declaring ? declaring.TypeName : null)) continue;
                named.Add(candidate);
            }
            if (named.Count == 0)
                throw new McpProtocolException("VALIDATION_FAILED", "Public instance method '" + q.Method + "' was not found on " + (script.GetType().FullName ?? "unknown") + " (only non-generic methods declared in game code are invocable).");
            var matches = new List<ScriptMemberInfo>();
            foreach (var candidate in named) if (candidate.ParametersCount == args.Length) matches.Add(candidate);
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
                var parameterType = parameter.Type ? parameter.Type.Type : null;
                var label = string.IsNullOrEmpty(parameter.Name) ? "arg" + i : parameter.Name;
                if (parameter.IsOut || parameterType == null || parameterType.IsByRef || !IsSupportedMemberType(parameterType))
                    throw new McpProtocolException("VALIDATION_FAILED", "Parameter '" + label + "' of '" + q.Method + "' has an unsupported type (" + (FriendlyTypeName(parameterType) ?? "unknown") + ").");
                var arg = args[i] ?? new McpRuntimeArgument();
                values[i] = CoerceMemberValue(parameterType, arg.Bool, arg.Number, arg.Text, label);
            }
            var returnType = method.ValueType ? method.ValueType.Type : null;
            var result = new McpRuntimeScriptInvokeResult
            {
                ScriptId = script.ID.ToString("N"), Method = method.Name,
                DeclaringType = method.DeclaringType ? LimitForLog(method.DeclaringType.TypeName, 256) : null,
                ReturnType = FriendlyTypeName(returnType),
                Invoked = true, PlaySessionId = session,
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

        // Bridge v33 project-settings writes. Everything goes through the
        // Editor's own GameSettings.Load/Save (Editor.SaveJsonAsset) followed
        // by GameSettings.Apply, the same call the Editor makes when play mode
        // ends. Writes are refused in play mode (play owns the applied runtime
        // mappings) and while the settings asset is open in an Editor window
        // (the window keeps its own copy and would overwrite the change).
        private const int MaxInputMappings = 512;
        private const int MaxSettingsNameChars = 64;
        private const int MaxProjectTags = 1024;

        private static void RequireSettingsWritable(string capability)
        {
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested)
                throw new McpProtocolException("INVALID_STATE", capability + " is unavailable while the editor is in play mode or play was requested.");
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", capability + " is unavailable while game scripts are compiling or reloading.");
        }

        private static void RequireSettingsAssetClosed(JsonAsset asset, string what)
        {
            if (asset == null) return;
            FlaxEditor.Windows.EditorWindow window = null;
            try
            {
                var item = FEditor.Instance.ContentDatabase == null ? null : FEditor.Instance.ContentDatabase.Find(asset.ID);
                if (item != null && FEditor.Instance.Windows != null) window = FEditor.Instance.Windows.FindEditor(item);
            }
            catch { window = null; }
            if (window != null)
                throw new McpProtocolException("EDITOR_BUSY", what + " are open in an Editor window. Close that window (saving or discarding its edits) first so it cannot overwrite the change.");
        }

        private static string ValidateSettingsName(string value, string what, int max)
        {
            var name = value == null ? "" : value.Trim();
            if (name.Length == 0 || name.Length > max)
                throw new McpProtocolException("VALIDATION_FAILED", what + " must be between 1 and " + max + " characters.");
            foreach (var c in name)
                if (char.IsControl(c)) throw new McpProtocolException("VALIDATION_FAILED", what + " must not contain control characters.");
            return name;
        }

        private static T ParseSettingsEnum<T>(string value, string what) where T : struct
        {
            var name = value == null ? "" : value.Trim();
            T parsed;
            // Enum.TryParse also accepts raw numeric strings; names only here.
            if (name.Length == 0 || name.Length > 64 || !char.IsLetter(name[0]) || !Enum.TryParse<T>(name, true, out parsed) || !Enum.IsDefined(typeof(T), parsed) || string.Equals(parsed.ToString(), "MAX", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", what + " must name a " + typeof(T).FullName + " member.");
            return parsed;
        }

        private static float SettingsNumber(double? value, double fallback, double min, double max, string what)
        {
            var n = value.HasValue ? value.Value : fallback;
            if (double.IsNaN(n) || double.IsInfinity(n) || !(n >= min) || !(n <= max))
                throw new McpProtocolException("VALIDATION_FAILED", what + " must be between " + min.ToString(CultureInfo.InvariantCulture) + " and " + max.ToString(CultureInfo.InvariantCulture) + ".");
            return (float)n;
        }

        private static McpInputMappingDto InputActionDto(ActionConfig c)
        {
            return new McpInputMappingDto { Kind = "action", Name = c.Name, Mode = c.Mode.ToString(), Key = c.Key.ToString(), MouseButton = c.MouseButton.ToString(), GamepadButton = c.GamepadButton.ToString(), Gamepad = c.Gamepad.ToString(), DeadZone = c.DeadZone };
        }

        private static McpInputMappingDto InputAxisDto(AxisConfig c)
        {
            return new McpInputMappingDto { Kind = "axis", Name = c.Name, Axis = c.Axis.ToString(), Gamepad = c.Gamepad.ToString(), PositiveButton = c.PositiveButton.ToString(), NegativeButton = c.NegativeButton.ToString(), GamepadPositiveButton = c.GamepadPositiveButton.ToString(), GamepadNegativeButton = c.GamepadNegativeButton.ToString(), DeadZone = c.DeadZone, Sensitivity = c.Sensitivity, Gravity = c.Gravity, Scale = c.Scale, Snap = c.Snap };
        }

        private static bool InputActionsEqual(ActionConfig a, ActionConfig b)
        {
            return string.Equals(a.Name, b.Name, StringComparison.Ordinal) && a.Mode == b.Mode && a.Key == b.Key && a.MouseButton == b.MouseButton && a.GamepadButton == b.GamepadButton && a.Gamepad == b.Gamepad && a.DeadZone == b.DeadZone;
        }

        private static bool InputAxesEqual(AxisConfig a, AxisConfig b)
        {
            return string.Equals(a.Name, b.Name, StringComparison.Ordinal) && a.Axis == b.Axis && a.Gamepad == b.Gamepad && a.PositiveButton == b.PositiveButton && a.NegativeButton == b.NegativeButton
                && a.GamepadPositiveButton == b.GamepadPositiveButton && a.GamepadNegativeButton == b.GamepadNegativeButton && a.DeadZone == b.DeadZone && a.Sensitivity == b.Sensitivity && a.Gravity == b.Gravity && a.Scale == b.Scale && a.Snap == b.Snap;
        }

        private static FInputSettings LoadInputSettingsForWrite(string capability)
        {
            RequireSettingsWritable(capability);
            RequireSettingsAssetClosed(FGameSettings.LoadAsset<FInputSettings>(), "Input settings");
            var settings = FGameSettings.Load<FInputSettings>();
            if (settings == null) throw new McpProtocolException("ASSET_OPERATION_FAILED", "Input settings could not be loaded by Flax Editor.");
            return settings;
        }

        private McpInputSettingsResult SaveInputSettings(FInputSettings settings, ActionConfig[] actions, AxisConfig[] axes, McpInputSettingsResult result, bool dryRun, bool confirm)
        {
            result.ActionCount = actions.Length;
            result.AxisCount = axes.Length;
            result.DryRun = dryRun;
            result.ProjectRevision = _projectRevision;
            if (dryRun)
            {
                result.Warnings = new[] { "Dry-run preview only: Input settings were not saved. Reissue with dryRun:false + confirm:true to persist." };
                return result;
            }
            if (!confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Input settings writes require confirm:true alongside dryRun:false. The save persists to disk immediately and has no Editor undo record.");
            if (!result.WouldChange)
            {
                result.Warnings = new[] { "Input settings already match the request; nothing was saved." };
                return result;
            }
            if (actions.Length > MaxInputMappings || axes.Length > MaxInputMappings)
                throw new McpProtocolException("VALIDATION_FAILED", "Input settings are limited to " + MaxInputMappings + " action and " + MaxInputMappings + " axis mappings.");
            var previousActions = settings.ActionMappings;
            var previousAxes = settings.AxisMappings;
            settings.ActionMappings = actions;
            settings.AxisMappings = axes;
            bool failed;
            try { failed = FGameSettings.Save(settings); }
            catch (Exception ex)
            {
                settings.ActionMappings = previousActions;
                settings.AxisMappings = previousAxes;
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save Input settings: " + DescribeException(ex));
            }
            if (failed)
            {
                settings.ActionMappings = previousActions;
                settings.AxisMappings = previousAxes;
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save Input settings.");
            }
            FGameSettings.Apply();
            result.Saved = true;
            result.ProjectRevision = AdvanceProjectRevision();
            result.Warnings = new[] { "Input settings were saved to disk and applied through GameSettings.Apply. There is no Editor undo record for settings saves." };
            return result;
        }

        private McpInputSettingsResult SetInputAction(McpInputActionSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Input action parameters are required.");
            var name = ValidateSettingsName(q.Name, "Name", MaxSettingsNameChars);
            var config = ActionConfig.Default;
            config.Name = name;
            config.Mode = string.IsNullOrEmpty(q.Mode) ? InputActionMode.Pressing : ParseSettingsEnum<InputActionMode>(q.Mode, "Mode");
            config.Key = string.IsNullOrEmpty(q.Key) ? KeyboardKeys.None : ParseSettingsEnum<KeyboardKeys>(q.Key, "Key");
            config.MouseButton = string.IsNullOrEmpty(q.MouseButton) ? MouseButton.None : ParseSettingsEnum<MouseButton>(q.MouseButton, "MouseButton");
            config.GamepadButton = string.IsNullOrEmpty(q.GamepadButton) ? GamepadButton.None : ParseSettingsEnum<GamepadButton>(q.GamepadButton, "GamepadButton");
            config.Gamepad = string.IsNullOrEmpty(q.Gamepad) ? InputGamepadIndex.All : ParseSettingsEnum<InputGamepadIndex>(q.Gamepad, "Gamepad");
            if (config.Key == KeyboardKeys.None && config.MouseButton == MouseButton.None && config.GamepadButton == GamepadButton.None)
                throw new McpProtocolException("VALIDATION_FAILED", "Provide at least one of Key, MouseButton, or GamepadButton.");
            var settings = LoadInputSettingsForWrite("settings.set_input_action");
            var current = settings.ActionMappings ?? new ActionConfig[0];
            var axes = settings.AxisMappings ?? new AxisConfig[0];
            // Without Replace the binding is appended unless an identical one
            // exists. With Replace every same-name binding is dropped first;
            // replacing a single identical binding is a no-op.
            var before = new List<McpInputMappingDto>();
            var next = new List<ActionConfig>();
            var removed = 0;
            var identical = false;
            var sameNameIdentical = false;
            foreach (var existing in current)
            {
                var sameName = string.Equals(existing.Name, name, StringComparison.Ordinal);
                if (sameName)
                {
                    before.Add(InputActionDto(existing));
                    if (InputActionsEqual(existing, config)) sameNameIdentical = true;
                }
                if (sameName && q.Replace) { removed++; continue; }
                if (InputActionsEqual(existing, config)) identical = true;
                next.Add(existing);
            }
            var noop = q.Replace ? (before.Count == 1 && sameNameIdentical) : identical;
            if (noop)
            {
                next = new List<ActionConfig>(current);
                removed = 0;
            }
            else next.Add(config);
            var after = new List<McpInputMappingDto>();
            foreach (var entry in next) if (string.Equals(entry.Name, name, StringComparison.Ordinal)) after.Add(InputActionDto(entry));
            var result = new McpInputSettingsResult { Operation = "set_input_action", Kind = "action", Name = name, WouldChange = !noop, RemovedCount = removed, Before = before.ToArray(), After = after.ToArray() };
            return SaveInputSettings(settings, next.ToArray(), axes, result, q.DryRun, q.Confirm);
        }

        private McpInputSettingsResult SetInputAxis(McpInputAxisSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Input axis parameters are required.");
            var name = ValidateSettingsName(q.Name, "Name", MaxSettingsNameChars);
            var config = new AxisConfig();
            config.Name = name;
            config.Axis = string.IsNullOrEmpty(q.Axis) ? InputAxisType.KeyboardOnly : ParseSettingsEnum<InputAxisType>(q.Axis, "Axis");
            config.Gamepad = string.IsNullOrEmpty(q.Gamepad) ? InputGamepadIndex.All : ParseSettingsEnum<InputGamepadIndex>(q.Gamepad, "Gamepad");
            config.PositiveButton = string.IsNullOrEmpty(q.PositiveButton) ? KeyboardKeys.None : ParseSettingsEnum<KeyboardKeys>(q.PositiveButton, "PositiveButton");
            config.NegativeButton = string.IsNullOrEmpty(q.NegativeButton) ? KeyboardKeys.None : ParseSettingsEnum<KeyboardKeys>(q.NegativeButton, "NegativeButton");
            config.GamepadPositiveButton = string.IsNullOrEmpty(q.GamepadPositiveButton) ? GamepadButton.None : ParseSettingsEnum<GamepadButton>(q.GamepadPositiveButton, "GamepadPositiveButton");
            config.GamepadNegativeButton = string.IsNullOrEmpty(q.GamepadNegativeButton) ? GamepadButton.None : ParseSettingsEnum<GamepadButton>(q.GamepadNegativeButton, "GamepadNegativeButton");
            config.DeadZone = SettingsNumber(q.DeadZone, 0.1, 0.0, 1.0, "DeadZone");
            config.Sensitivity = SettingsNumber(q.Sensitivity, 1.0, 0.0, 1000.0, "Sensitivity");
            config.Gravity = SettingsNumber(q.Gravity, 1.0, 0.0, 1000.0, "Gravity");
            config.Scale = SettingsNumber(q.Scale, 1.0, -1000.0, 1000.0, "Scale");
            config.Snap = q.Snap.HasValue && q.Snap.Value;
            if (config.Axis == InputAxisType.KeyboardOnly && config.PositiveButton == KeyboardKeys.None && config.NegativeButton == KeyboardKeys.None
                && config.GamepadPositiveButton == GamepadButton.None && config.GamepadNegativeButton == GamepadButton.None)
                throw new McpProtocolException("VALIDATION_FAILED", "A KeyboardOnly axis needs at least one positive or negative button.");
            var settings = LoadInputSettingsForWrite("settings.set_input_axis");
            var actions = settings.ActionMappings ?? new ActionConfig[0];
            var current = settings.AxisMappings ?? new AxisConfig[0];
            var before = new List<McpInputMappingDto>();
            var next = new List<AxisConfig>();
            var removed = 0;
            var identical = false;
            var sameNameIdentical = false;
            foreach (var existing in current)
            {
                var sameName = string.Equals(existing.Name, name, StringComparison.Ordinal);
                if (sameName)
                {
                    before.Add(InputAxisDto(existing));
                    if (InputAxesEqual(existing, config)) sameNameIdentical = true;
                }
                if (sameName && q.Replace) { removed++; continue; }
                if (InputAxesEqual(existing, config)) identical = true;
                next.Add(existing);
            }
            var noop = q.Replace ? (before.Count == 1 && sameNameIdentical) : identical;
            if (noop)
            {
                next = new List<AxisConfig>(current);
                removed = 0;
            }
            else next.Add(config);
            var after = new List<McpInputMappingDto>();
            foreach (var entry in next) if (string.Equals(entry.Name, name, StringComparison.Ordinal)) after.Add(InputAxisDto(entry));
            var result = new McpInputSettingsResult { Operation = "set_input_axis", Kind = "axis", Name = name, WouldChange = !noop, RemovedCount = removed, Before = before.ToArray(), After = after.ToArray() };
            return SaveInputSettings(settings, actions, next.ToArray(), result, q.DryRun, q.Confirm);
        }

        private McpInputSettingsResult RemoveInputMapping(McpInputMappingRemove q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Input mapping removal parameters are required.");
            var name = ValidateSettingsName(q.Name, "Name", MaxSettingsNameChars);
            var isAction = string.Equals(q.Kind, "action", StringComparison.Ordinal);
            if (!isAction && !string.Equals(q.Kind, "axis", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Kind must be action or axis.");
            var settings = LoadInputSettingsForWrite("settings.remove_input_mapping");
            var actions = settings.ActionMappings ?? new ActionConfig[0];
            var axes = settings.AxisMappings ?? new AxisConfig[0];
            var before = new List<McpInputMappingDto>();
            if (isAction)
            {
                var next = new List<ActionConfig>();
                foreach (var existing in actions)
                {
                    if (string.Equals(existing.Name, name, StringComparison.Ordinal)) before.Add(InputActionDto(existing));
                    else next.Add(existing);
                }
                actions = next.ToArray();
            }
            else
            {
                var next = new List<AxisConfig>();
                foreach (var existing in axes)
                {
                    if (string.Equals(existing.Name, name, StringComparison.Ordinal)) before.Add(InputAxisDto(existing));
                    else next.Add(existing);
                }
                axes = next.ToArray();
            }
            if (before.Count == 0)
                throw new McpProtocolException("NOT_FOUND", "No input " + (isAction ? "action" : "axis") + " mapping named '" + name + "' exists.");
            var result = new McpInputSettingsResult { Operation = "remove_input_mapping", Kind = isAction ? "action" : "axis", Name = name, WouldChange = true, RemovedCount = before.Count, Before = before.ToArray(), After = new McpInputMappingDto[0] };
            return SaveInputSettings(settings, actions, axes, result, q.DryRun, q.Confirm);
        }

        private static FLayersAndTagsSettings LoadLayersAndTagsForWrite(string capability)
        {
            RequireSettingsWritable(capability);
            RequireSettingsAssetClosed(FGameSettings.LoadAsset<FLayersAndTagsSettings>(), "Layers and Tags settings");
            var settings = FGameSettings.Load<FLayersAndTagsSettings>();
            if (settings == null) throw new McpProtocolException("ASSET_OPERATION_FAILED", "Layers and Tags settings could not be loaded by Flax Editor.");
            if (settings.Layers == null || settings.Layers.Length != 32) settings.Layers = ResizeLayerNames(settings.Layers);
            if (settings.Tags == null) settings.Tags = new List<string>();
            return settings;
        }

        private static string[] ResizeLayerNames(string[] layers)
        {
            var result = new string[32];
            if (layers != null) Array.Copy(layers, result, Math.Min(layers.Length, 32));
            return result;
        }

        private McpLayersTagsResult FinishLayersAndTags(FLayersAndTagsSettings settings, McpLayersTagsResult result, bool dryRun, bool confirm, Action apply, Action revert)
        {
            result.DryRun = dryRun;
            result.ProjectRevision = _projectRevision;
            if (dryRun)
            {
                result.Layers = (string[])settings.Layers.Clone();
                result.Tags = settings.Tags.ToArray();
                result.Warnings = new[] { "Dry-run preview only: Layers and Tags settings were not saved. Reissue with dryRun:false + confirm:true to persist." };
                return result;
            }
            if (!confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Layers and Tags writes require confirm:true alongside dryRun:false. The save persists to disk immediately and has no Editor undo record.");
            if (!result.WouldChange)
            {
                result.Layers = (string[])settings.Layers.Clone();
                result.Tags = settings.Tags.ToArray();
                result.Warnings = new[] { "Layers and Tags settings already match the request; nothing was saved." };
                return result;
            }
            apply();
            bool failed;
            try { failed = FGameSettings.Save(settings); }
            catch (Exception ex)
            {
                revert();
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save Layers and Tags settings: " + DescribeException(ex));
            }
            if (failed)
            {
                revert();
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save Layers and Tags settings.");
            }
            FGameSettings.Apply();
            result.Saved = true;
            result.Layers = (string[])settings.Layers.Clone();
            result.Tags = settings.Tags.ToArray();
            result.ProjectRevision = AdvanceProjectRevision();
            result.Warnings = new[] { "Layers and Tags settings were saved to disk and applied through GameSettings.Apply. There is no Editor undo record for settings saves." };
            return result;
        }

        private McpLayersTagsResult SetLayerName(McpLayerNameSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Layer name parameters are required.");
            if (q.Index < 0 || q.Index > MaxActorLayer)
                throw new McpProtocolException("VALIDATION_FAILED", "Index must be between 0 and 31.");
            // An empty name clears the slot; layer 0 keeps a name so the
            // default layer always stays addressable.
            var name = q.Name == null ? "" : q.Name.Trim();
            if (name.Length > MaxSettingsNameChars) throw new McpProtocolException("VALIDATION_FAILED", "Name must be at most " + MaxSettingsNameChars + " characters.");
            foreach (var c in name) if (char.IsControl(c)) throw new McpProtocolException("VALIDATION_FAILED", "Name must not contain control characters.");
            if (q.Index == 0 && name.Length == 0) throw new McpProtocolException("VALIDATION_FAILED", "Layer 0 must keep a name.");
            var settings = LoadLayersAndTagsForWrite("settings.set_layer_name");
            var index = q.Index;
            var previous = settings.Layers[index] ?? "";
            if (name.Length > 0)
                for (var i = 0; i < settings.Layers.Length; i++)
                    if (i != index && string.Equals(settings.Layers[i], name, StringComparison.Ordinal))
                        throw new McpProtocolException("VALIDATION_FAILED", "Layer name '" + name + "' is already used by layer " + i + ".");
            var result = new McpLayersTagsResult { Operation = "set_layer_name", Index = index, Before = previous, After = name, WouldChange = !string.Equals(previous, name, StringComparison.Ordinal) };
            return FinishLayersAndTags(settings, result, q.DryRun, q.Confirm, () => settings.Layers[index] = name, () => settings.Layers[index] = previous);
        }

        private McpLayersTagsResult AddProjectTag(McpTagAdd q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Tag parameters are required.");
            var tag = ValidateSettingsName(q.Tag, "Tag", MaxActorTagChars);
            var settings = LoadLayersAndTagsForWrite("settings.add_tag");
            var exists = false;
            foreach (var existing in settings.Tags) if (string.Equals(existing, tag, StringComparison.Ordinal)) { exists = true; break; }
            if (!exists && settings.Tags.Count >= MaxProjectTags)
                throw new McpProtocolException("VALIDATION_FAILED", "The project already has " + MaxProjectTags + " tags.");
            var result = new McpLayersTagsResult { Operation = "add_tag", Index = -1, Before = null, After = tag, WouldChange = !exists };
            return FinishLayersAndTags(settings, result, q.DryRun, q.Confirm, () => settings.Tags.Add(tag), () => settings.Tags.Remove(tag));
        }

        private McpFirstSceneResult SetFirstScene(McpFirstSceneSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "First scene parameters are required.");
            ValidateAssetSelector(q.AssetId, q.Path);
            RequireSettingsWritable("settings.set_first_scene");
            var record = ResolveAssetRecord(new McpAssetGet { AssetId = q.AssetId, Path = q.Path }, BuildAssetRegistry());
            if (!string.Equals(record.Info.TypeName, "FlaxEngine.SceneAsset", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "The selected asset is not a scene asset: " + record.Path, new McpSceneOpenTypeDetails { TypeName = record.Info.TypeName });
            RequireSettingsAssetClosed(FGameSettings.LoadAsset(), "Game settings");
            var settings = FGameSettings.Load();
            if (settings == null) throw new McpProtocolException("ASSET_OPERATION_FAILED", "Game settings could not be loaded by Flax Editor.");
            var previous = settings.FirstScene;
            var result = new McpFirstSceneResult
            {
                DryRun = q.DryRun, BeforeSceneId = previous.ID == Guid.Empty ? null : previous.ID.ToString("N"), Scene = AssetMetadata(record),
                WouldChange = previous.ID != record.Id, ProjectRevision = _projectRevision,
            };
            if (q.DryRun)
            {
                result.Warnings = new[] { "Dry-run preview only: Game settings were not saved. Reissue with dryRun:false + confirm:true to persist." };
                return result;
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "First scene writes require confirm:true alongside dryRun:false. The save persists to disk immediately and has no Editor undo record.");
            if (!result.WouldChange)
            {
                result.Warnings = new[] { "The first scene already matches the request; nothing was saved." };
                return result;
            }
            settings.FirstScene = new SceneReference(record.Id);
            bool failed;
            try { failed = FGameSettings.Save(settings); }
            catch (Exception ex)
            {
                settings.FirstScene = previous;
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save Game settings: " + DescribeException(ex));
            }
            if (failed)
            {
                settings.FirstScene = previous;
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not save Game settings.");
            }
            FGameSettings.Apply();
            result.Saved = true;
            result.ProjectRevision = AdvanceProjectRevision();
            result.Warnings = new[] { "Game settings were saved to disk and applied through GameSettings.Apply. There is no Editor undo record for settings saves." };
            return result;
        }

        // Bridge v33 scene/content lifecycle.
        private static readonly string[] AssetCreateKinds =
        {
            "Material", "MaterialInstance", "MaterialFunction", "ParticleEmitter", "ParticleEmitterFunction", "ParticleSystem",
            "AnimationGraph", "AnimationGraphFunction", "Animation", "SceneAnimation", "SkeletonMask", "BehaviorTree", "CollisionData", "GameplayGlobals",
        };

        private static void RequireContentWritable(string capability)
        {
            if (FEditor.IsPlayMode || FEditor.Instance.Simulation.IsPlayModeRequested)
                throw new McpProtocolException("INVALID_STATE", capability + " is unavailable while the editor is in play mode or play was requested.");
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", capability + " is unavailable while game scripts are compiling or reloading.");
        }

        private static void ValidateContentSegments(string normalized)
        {
            var invalid = Path.GetInvalidFileNameChars();
            foreach (var part in normalized.Split('/'))
            {
                if (part.Length > 128 || part.IndexOfAny(invalid) >= 0 || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || part.StartsWith(" ", StringComparison.Ordinal))
                    throw new McpProtocolException("VALIDATION_FAILED", "Path segment '" + LimitForLog(part, 64) + "' is not a valid file or folder name.");
            }
        }

        private static void EnsureContentOutputParent(string content, string output, string what)
        {
            var parent = Path.GetDirectoryName(output);
            while (!Directory.Exists(parent))
            {
                var next = Path.GetDirectoryName(parent);
                if (string.IsNullOrEmpty(next) || string.Equals(next, parent, PathComparison))
                    throw new McpProtocolException("VALIDATION_FAILED", what + " destination parent is invalid.");
                parent = next;
            }
            // The nearest existing ancestor is canonicalized so a symlink or
            // junction cannot redirect the write outside Content.
            if (!PathIsWithin(content, CanonicalExistingPath(parent, false)))
                throw new McpProtocolException("VALIDATION_FAILED", what + " destination parent resolves outside Content.");
        }

        private static string ResolveNewContentFile(string destinationPath, string extension, string what, out string normalized)
        {
            normalized = ValidateProjectContentPath(destinationPath, false);
            if (!normalized.EndsWith(extension, StringComparison.OrdinalIgnoreCase) || Path.GetFileNameWithoutExtension(normalized).Trim().Length == 0)
                throw new McpProtocolException("VALIDATION_FAILED", what + " destination must be a Content/ path with a file name and the " + extension + " extension.");
            ValidateContentSegments(normalized);
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var output = Path.GetFullPath(Path.Combine(content, normalized.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar)));
            if (!PathIsWithin(content, output))
                throw new McpProtocolException("VALIDATION_FAILED", what + " destination escapes Content.");
            EnsureContentOutputParent(content, output, what);
            if (File.Exists(output) || Directory.Exists(output))
                throw new McpProtocolException("FILE_EXISTS", "A file already exists at the requested destination.");
            AssetInfo clash;
            if (Content.GetAssetInfo(EngineAssetPath(normalized), out clash))
                throw new McpProtocolException("FILE_EXISTS", "A Content asset already exists at the requested destination.");
            return output;
        }

        // Flax keys its asset registry by one path spelling: the project
        // folder as the engine reports it, '/' separators, and the drive root
        // kept as "C:\" (StringUtils.NormalizePath, the form the Editor
        // Content database passes to Content.GetAssetInfo). A path in the OS
        // spelling names the same file but misses that key, so
        // Content.GetAssetInfo registers the file a second time: the engine
        // logs "Founded duplicated asset" and tries to rewrite the new file
        // under a fresh ID (live-observed after every binary asset.create;
        // the rewrite failed only because the file was still open).
        private static string EngineAssetPath(string projectRelativePath)
        {
            return StringUtils.NormalizePath(Path.Combine(Globals.ProjectFolder, projectRelativePath));
        }

        // Same engine spelling for a path that is already absolute (for example a
        // freshly composed Content output). Never hand the engine a raw
        // Path.GetFullPath/Path.Combine result.
        private static string EngineAssetPathFromAbsolute(string absolutePath)
        {
            return StringUtils.NormalizePath(absolutePath);
        }

        // Engine spelling of a registry record's file, or null for engine-content
        // records (engine:<path>), which have no project-relative file; those
        // are only ever loaded by ID.
        private static string EngineAssetPathForRecord(McpAssetRecord record)
        {
            if (record == null || string.IsNullOrEmpty(record.Path) || record.Path.StartsWith(EngineAssetPrefix, StringComparison.OrdinalIgnoreCase)) return null;
            return EngineAssetPath(record.Path);
        }

        // The Content database normally notices new files through its file
        // watcher; refreshing the nearest known folder makes the result
        // visible to the registry without waiting for that event.
        private static void RefreshContentDatabaseFrom(string folder)
        {
            try
            {
                var database = FEditor.Instance.ContentDatabase;
                if (database == null) return;
                var content = Path.GetFullPath(Path.Combine(Globals.ProjectFolder, "Content"));
                while (!string.IsNullOrEmpty(folder) && PathIsWithin(content, folder))
                {
                    var item = database.Find(folder);
                    if (item != null)
                    {
                        database.RefreshFolder(item, true);
                        return;
                    }
                    folder = Path.GetDirectoryName(folder);
                }
            }
            catch (Exception ex) { Debug.LogWarning("[Flax MCP] Content database refresh failed: " + ex.Message); }
        }

        private static McpAssetMetadata CreatedAssetMetadata(string absolute, string normalized, string fallbackTypeName)
        {
            var folder = Path.GetDirectoryName(normalized);
            var metadata = new McpAssetMetadata
            {
                Path = normalized, TypeName = fallbackTypeName, Extension = (Path.GetExtension(normalized) ?? "").ToLowerInvariant(),
                Folder = string.IsNullOrEmpty(folder) ? "Content" : folder.Replace('\\', '/'),
            };
            try
            {
                AssetInfo info;
                if (Content.GetAssetInfo(EngineAssetPath(normalized), out info))
                {
                    metadata.Id = info.ID.ToString("N");
                    if (!string.IsNullOrEmpty(info.TypeName)) metadata.TypeName = info.TypeName;
                }
            }
            catch { }
            if (metadata.Id == null && string.Equals(metadata.Extension, ".flax", StringComparison.Ordinal))
            {
                // Live-verified: the registry lists a new binary asset a moment
                // after the file is written, but the header already carries its
                // durable ID (same layout ReadPersistedMaterialInstanceId reads).
                try { metadata.Id = ReadPersistedMaterialInstanceId(absolute).ToString("N"); }
                catch { }
            }
            return metadata;
        }

        private object ExecuteCreateScene(McpSceneCreate q)
        {
            if (q != null && q.DryRun) return CreateScene(q);
            return ExecuteIdempotent("scene.create", q == null ? null : q.IdempotencyKey, q, () => CreateScene(q));
        }

        private McpSceneCreateResult CreateScene(McpSceneCreate q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Scene creation parameters are required.");
            RequireContentWritable("scene.create");
            string normalized;
            var absolute = ResolveNewContentFile(q.Path, ".scene", "Scene", out normalized);
            if (q.DryRun)
            {
                return new McpSceneCreateResult
                {
                    DryRun = true, Created = false, Path = normalized, ProjectRevision = _projectRevision,
                    Warnings = new[] { "Dry-run preview only: no scene file was created. Reissue with dryRun:false + confirm:true to create it." },
                };
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Scene creation requires confirm:true alongside dryRun:false. Creation has no Editor undo record; remove the file with asset_delete (quarantine) if it is not needed.");
            try { Directory.CreateDirectory(Path.GetDirectoryName(absolute)); }
            catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not prepare the destination folder: " + ex.GetType().FullName + "."); }
            if (File.Exists(absolute) || Directory.Exists(absolute))
                throw new McpProtocolException("FILE_EXISTS", "A file already exists at the requested destination.");
            try { FEditor.Instance.Scene.CreateSceneFile(absolute); }
            catch (Exception ex)
            {
                // Only a file this call created can exist here (absence was
                // verified above), so removing a partial write is safe.
                TryDelete(absolute);
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not create the scene file: " + DescribeException(ex));
            }
            if (!File.Exists(absolute))
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor reported success but the scene file is missing.");
            RefreshContentDatabaseFrom(Path.GetDirectoryName(absolute));
            var metadata = CreatedAssetMetadata(absolute, normalized, "FlaxEngine.SceneAsset");
            var warnings = new List<string>
            {
                "The scene was created with the Editor default template (Sun, Sky, SkyLight, Floor, Camera) and is not opened; use scene_open to load it.",
                "Scene creation has no Editor undo record; remove the file with asset_delete (quarantine) if it is not needed.",
            };
            if (metadata.Id == null) warnings.Add("The Content registry did not list the new scene yet (database scan is asynchronous); poll asset_get for the path before opening it.");
            return new McpSceneCreateResult { DryRun = false, Created = true, Path = normalized, SceneId = metadata.Id, ProjectRevision = AdvanceProjectRevision(), Warnings = warnings.ToArray() };
        }

        // Mirrors SceneModule.CloseScene for edit mode, minus its modal
        // "save before closing?" dialog: an edited scene is refused unless
        // AllowDirty is explicit, in which case its unsaved edits are dropped.
        private McpSceneCloseResult CloseScene(McpSceneClose q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Scene close parameters are required.");
            var editor = FEditor.Instance;
            if (FEditor.IsPlayMode || editor.Simulation.IsPlayModeRequested)
                throw new McpProtocolException("INVALID_STATE", "Scene close is unavailable while the editor is in play mode or play was requested.");
            if (ScriptsBuilder.IsCompiling || !ScriptsBuilder.IsReady)
                throw new McpProtocolException("EDITOR_BUSY", "Scene close is unavailable while game scripts are compiling or reloading. Retry once compilation finishes.");
            var state = editor.StateMachine.CurrentState;
            if (state == null || !state.CanChangeScene)
                throw new McpProtocolException("EDITOR_BUSY", "The editor cannot change scenes in its current state.");
            var scene = RequireScene(q.SceneId);
            var sceneId = scene.ID.ToString("N");
            var sceneName = scene.Name;
            lock (_stateLock)
            {
                CleanupExpiredStateLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (_sceneLeases.Count > 0) throw new McpProtocolException("EDIT_LEASE_ACTIVE", "Cannot close a scene while an edit lease is active. Commit or release the lease first.", ActiveLeasesDetailsLocked());
            }
            var edited = editor.Scene.IsEdited(scene);
            if (edited && !q.AllowDirty)
                throw new McpProtocolException("DIRTY_SCENE", "The scene has unsaved edits. Save it with scene_save or pass AllowDirty:true to discard them: " + (sceneName ?? sceneId), new McpSceneOpenDirtyDetails { DirtyScenes = new[] { sceneName ?? sceneId } });
            var loadedBefore = Level.ScenesCount;
            editor.Scene.ClearRefsToSceneObjects();
            editor.StateMachine.ChangingScenesState.UnloadScene(scene);
            AdvanceProjectRevision();
            return new McpSceneCloseResult { SceneId = sceneId, Name = sceneName, Phase = "closing", WasEdited = edited, LoadedScenesBefore = loadedBefore };
        }

        private McpContentFolderResult CreateContentFolder(McpContentFolderCreate q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Content folder parameters are required.");
            var normalized = ValidateProjectContentPath(q.Path, true);
            if (string.Equals(normalized, "Content", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Path must name a folder below Content/.");
            ValidateContentSegments(normalized);
            RequireContentWritable("content.create_folder");
            var content = CanonicalExistingPath(Path.Combine(Globals.ProjectFolder, "Content"), false);
            var output = Path.GetFullPath(Path.Combine(content, normalized.Substring("Content/".Length).Replace('/', Path.DirectorySeparatorChar)));
            if (!PathIsWithin(content, output))
                throw new McpProtocolException("VALIDATION_FAILED", "Folder destination escapes Content.");
            EnsureContentOutputParent(content, output, "Folder");
            if (File.Exists(output))
                throw new McpProtocolException("FILE_EXISTS", "A file already exists at the requested folder path.");
            var exists = Directory.Exists(output);
            if (q.DryRun || exists)
            {
                return new McpContentFolderResult
                {
                    DryRun = q.DryRun, Created = false, AlreadyExists = exists, Path = normalized, ProjectRevision = _projectRevision,
                    Warnings = exists ? new[] { "The folder already exists; nothing was created." } : new[] { "Dry-run preview only: no folder was created." },
                };
            }
            try { Directory.CreateDirectory(output); }
            catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not create the folder: " + ex.GetType().FullName + "."); }
            RefreshContentDatabaseFrom(Path.GetDirectoryName(output));
            return new McpContentFolderResult { DryRun = false, Created = true, AlreadyExists = false, Path = normalized, ProjectRevision = AdvanceProjectRevision(), Warnings = new string[0] };
        }

        // JSON data assets accept exactly what the Editor's "Json Asset"
        // creation dialog accepts (GenericJsonCreateEntry: visible,
        // non-abstract, non-generic classes with a parameterless constructor
        // that are not Attribute/FlaxEngine.Object/Control), plus types that
        // have a registered SpawnableJsonAssetProxy (for example
        // FlaxEngine.PhysicalMaterial).
        private static Type ResolveJsonAssetType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName) || typeName.Length > 256)
                throw new McpProtocolException("VALIDATION_FAILED", "TypeName is required for Kind JsonAsset (1-256 characters).");
            Type type = null;
            // Current scripting context only (see ResolveType): never a type
            // from a game assembly unloaded by an earlier script reload.
            foreach (var assembly in FlaxEngine.Utils.GetAssemblies())
            {
                if (assembly == null) continue;
                type = assembly.GetType(typeName, false);
                if (type != null) break;
            }
            if (type == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Type '" + LimitForLog(typeName, 128) + "' was not found in the loaded assemblies.");
            if (!type.IsClass || type.IsAbstract || type.IsGenericType || !type.IsVisible || type.GetConstructor(Type.EmptyTypes) == null)
                throw new McpProtocolException("VALIDATION_FAILED", "JSON asset types must be visible, non-abstract, non-generic classes with a parameterless constructor.");
            var fullName = type.FullName ?? "";
            if (fullName.StartsWith("Game.MCP.", StringComparison.Ordinal))
                throw new McpProtocolException("VALIDATION_FAILED", "Bridge protocol types cannot be stored as JSON assets.");
            if (HasSpawnableJsonProxy(type)) return type;
            if (typeof(Attribute).IsAssignableFrom(type) || typeof(FObject).IsAssignableFrom(type) || typeof(FControl).IsAssignableFrom(type))
                throw new McpProtocolException("VALIDATION_FAILED", "Type " + fullName + " cannot be stored as a JSON asset (Attribute, FlaxEngine.Object, and Control types are excluded unless the Editor registers a spawnable JSON asset proxy for them).");
            return type;
        }

        private static bool HasSpawnableJsonProxy(Type type)
        {
            try
            {
                var database = FEditor.Instance.ContentDatabase;
                if (database == null || database.Proxy == null) return false;
                foreach (var proxy in database.Proxy)
                {
                    for (var proxyType = proxy == null ? null : proxy.GetType(); proxyType != null; proxyType = proxyType.BaseType)
                    {
                        if (proxyType.IsGenericType && proxyType.GetGenericTypeDefinition() == typeof(SpawnableJsonAssetProxy<>) && proxyType.GetGenericArguments()[0] == type) return true;
                    }
                }
            }
            catch { }
            return false;
        }

        // Bridge v34: asset.create kind GameplayGlobals with Variables.
        // Editor.CreateAsset("GameplayGlobals") fails in Flax 1.12 (live-verified); the
        // Content Browser path is GameplayGlobalsProxy.Create, which is
        // Content.CreateVirtualAsset<GameplayGlobals>() + Save(outputPath). Variables
        // are then applied the way GameplayGlobalsWindow.Save does: copy
        // DefaultValues, edit, assign back, Save().
        private const int MaxGlobalsVariables = 64;
        private static readonly string[] GlobalsVariableTypes = { "float", "int", "bool", "Float2", "Float3", "Float4", "Color" };

        private sealed class GlobalsVariablePlan
        {
            public string Name;
            public string Type;
            public object Value;
        }

        private static bool TryParseGlobalsFloats(string text, int minCount, int maxCount, out float[] values)
        {
            values = null;
            var trimmed = text.Trim();
            if (trimmed.Length >= 2 && ((trimmed[0] == '(' && trimmed[trimmed.Length - 1] == ')') || (trimmed[0] == '[' && trimmed[trimmed.Length - 1] == ']')))
                trimmed = trimmed.Substring(1, trimmed.Length - 2);
            var parts = trimmed.Split(',');
            if (parts.Length < minCount || parts.Length > maxCount) return false;
            var parsed = new float[parts.Length];
            for (var i = 0; i < parts.Length; i++)
            {
                if (!float.TryParse(parts[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out parsed[i]) || !float.IsFinite(parsed[i])) return false;
            }
            values = parsed;
            return true;
        }

        private static GlobalsVariablePlan[] ValidateGlobalsVariables(McpGlobalsVariable[] variables)
        {
            if (variables == null || variables.Length == 0) return new GlobalsVariablePlan[0];
            if (variables.Length > MaxGlobalsVariables)
                throw new McpProtocolException("VALIDATION_FAILED", "Variables lists at most " + MaxGlobalsVariables.ToString(CultureInfo.InvariantCulture) + " entries.");
            var plans = new List<GlobalsVariablePlan>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var variable in variables)
            {
                if (variable == null) throw new McpProtocolException("VALIDATION_FAILED", "Variables entries must be objects with Name, Type and Value.");
                var name = variable.Name == null ? "" : variable.Name.Trim();
                if (name.Length == 0 || name.Length > 128)
                    throw new McpProtocolException("VALIDATION_FAILED", "A variable Name must be between 1 and 128 characters.");
                foreach (var ch in name)
                    if (char.IsControl(ch)) throw new McpProtocolException("VALIDATION_FAILED", "Variable name '" + LimitForLog(name, 64) + "' contains control characters.");
                if (!seen.Add(name))
                    throw new McpProtocolException("VALIDATION_FAILED", "Duplicate variable name '" + LimitForLog(name, 64) + "'.");
                string type = null;
                var wantedType = variable.Type == null ? "" : variable.Type.Trim();
                foreach (var candidate in GlobalsVariableTypes) if (string.Equals(candidate, wantedType, StringComparison.OrdinalIgnoreCase)) type = candidate;
                if (type == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "Variable '" + LimitForLog(name, 64) + "' has an unsupported Type; use one of: " + string.Join(", ", GlobalsVariableTypes) + ".");
                var text = variable.Value;
                if (string.IsNullOrWhiteSpace(text))
                    throw new McpProtocolException("VALIDATION_FAILED", "Variable '" + LimitForLog(name, 64) + "' needs a Value string.");
                object value = null;
                float[] f;
                var ok = false;
                switch (type)
                {
                    case "float": { float v; ok = float.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v) && float.IsFinite(v); value = v; break; }
                    case "int": { int v; ok = int.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out v); value = v; break; }
                    case "bool":
                    {
                        var t = text.Trim();
                        if (string.Equals(t, "true", StringComparison.OrdinalIgnoreCase)) { ok = true; value = true; }
                        else if (string.Equals(t, "false", StringComparison.OrdinalIgnoreCase)) { ok = true; value = false; }
                        break;
                    }
                    case "Float2": ok = TryParseGlobalsFloats(text, 2, 2, out f); if (ok) value = new Float2(f[0], f[1]); break;
                    case "Float3": ok = TryParseGlobalsFloats(text, 3, 3, out f); if (ok) value = new Float3(f[0], f[1], f[2]); break;
                    case "Float4": ok = TryParseGlobalsFloats(text, 4, 4, out f); if (ok) value = new Float4(f[0], f[1], f[2], f[3]); break;
                    case "Color": ok = TryParseGlobalsFloats(text, 3, 4, out f); if (ok) value = new Color(f[0], f[1], f[2], f.Length > 3 ? f[3] : 1.0f); break;
                }
                if (!ok)
                    throw new McpProtocolException("VALIDATION_FAILED", "Variable '" + LimitForLog(name, 64) + "' Value is not a valid " + type + " (invariant culture; vectors are comma-separated, Color is r,g,b[,a]).");
                plans.Add(new GlobalsVariablePlan { Name = name, Type = type, Value = value });
            }
            return plans.ToArray();
        }

        // Returns true on failure (same convention as Editor.CreateAsset).
        private static bool CreateGameplayGlobalsAsset(string enginePath, GlobalsVariablePlan[] variables)
        {
            var virtualAsset = Content.CreateVirtualAsset<GameplayGlobals>();
            if (virtualAsset == null) return true;
            try
            {
                if (virtualAsset.Save(enginePath)) return true;
            }
            finally { FObject.Destroy(virtualAsset); }
            if (variables == null || variables.Length == 0) return false;
            var asset = Content.Load<GameplayGlobals>(enginePath, 10000);
            if (asset == null) throw new InvalidOperationException("The new GameplayGlobals asset could not be loaded to set its variables.");
            // The getter returns a copy: edit it and assign it back (GameplayGlobalsWindow.Save does the same).
            var defaults = asset.DefaultValues ?? new Dictionary<string, object>();
            foreach (var variable in variables) defaults[variable.Name] = variable.Value;
            asset.DefaultValues = defaults;
            if (asset.Save()) throw new InvalidOperationException("Saving the GameplayGlobals variables failed.");
            return false;
        }

        private object ExecuteCreateAsset(McpAssetCreate q)
        {
            if (q != null && q.DryRun) return CreateAsset(q);
            return ExecuteIdempotent("asset.create", q == null ? null : q.IdempotencyKey, q, () => CreateAsset(q));
        }

        private McpAssetCreateResult CreateAsset(McpAssetCreate q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Asset creation parameters are required.");
            var kind = q.Kind == null ? "" : q.Kind.Trim();
            var isJson = string.Equals(kind, "JsonAsset", StringComparison.Ordinal);
            string tag = null;
            if (!isJson)
            {
                foreach (var candidate in AssetCreateKinds) if (string.Equals(candidate, kind, StringComparison.Ordinal)) tag = candidate;
                if (tag == null)
                    throw new McpProtocolException("VALIDATION_FAILED", "Kind must be JsonAsset or one of: " + string.Join(", ", AssetCreateKinds) + ".");
                if (!string.IsNullOrEmpty(q.TypeName))
                    throw new McpProtocolException("VALIDATION_FAILED", "TypeName is only valid with Kind JsonAsset.");
            }
            var isGlobals = string.Equals(tag, "GameplayGlobals", StringComparison.Ordinal);
            if (q.Variables != null && !isGlobals)
                throw new McpProtocolException("VALIDATION_FAILED", "Variables are only valid with Kind GameplayGlobals.");
            var globalsVariables = isGlobals ? ValidateGlobalsVariables(q.Variables) : null;
            RequireContentWritable("asset.create");
            var jsonType = isJson ? ResolveJsonAssetType(q.TypeName) : null;
            string normalized;
            var absolute = ResolveNewContentFile(q.Path, isJson ? ".json" : ".flax", "Asset", out normalized);
            var typeName = jsonType == null ? null : jsonType.FullName;
            if (q.DryRun)
            {
                return new McpAssetCreateResult
                {
                    DryRun = true, Created = false, Kind = isJson ? "JsonAsset" : tag, TypeName = typeName, Path = normalized, ProjectRevision = _projectRevision,
                    Warnings = new[] { "Dry-run preview only: no asset was created." + (isGlobals && globalsVariables.Length > 0 ? " It would be created with " + globalsVariables.Length.ToString(CultureInfo.InvariantCulture) + " variable(s)." : "") + " Reissue with dryRun:false + confirm:true to create it." },
                };
            }
            if (!q.Confirm)
                throw new McpProtocolException("VALIDATION_FAILED", "Asset creation requires confirm:true alongside dryRun:false. Creation has no Editor undo record; remove the file with asset_delete (quarantine) if it is not needed.");
            try { Directory.CreateDirectory(Path.GetDirectoryName(absolute)); }
            catch (Exception ex) { throw new McpProtocolException("ASSET_OPERATION_FAILED", "Could not prepare the destination folder: " + ex.GetType().FullName + "."); }
            if (File.Exists(absolute) || Directory.Exists(absolute))
                throw new McpProtocolException("FILE_EXISTS", "A file already exists at the requested destination.");
            bool failed;
            try
            {
                if (isJson)
                {
                    var instance = Activator.CreateInstance(jsonType);
                    try { failed = FEditor.SaveJsonAsset(absolute, instance); }
                    finally
                    {
                        var flaxObject = instance as FObject;
                        if (flaxObject != null) FObject.Destroy(flaxObject);
                    }
                }
                else if (isGlobals) failed = CreateGameplayGlobalsAsset(EngineAssetPath(normalized), globalsVariables);
                else failed = FEditor.CreateAsset(tag, absolute);
            }
            catch (Exception ex)
            {
                TryDelete(absolute);
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not create the asset: " + DescribeException(ex));
            }
            if (failed || !File.Exists(absolute))
            {
                TryDelete(absolute);
                throw new McpProtocolException("ASSET_OPERATION_FAILED", "Flax Editor could not create the asset.");
            }
            RefreshContentDatabaseFrom(Path.GetDirectoryName(absolute));
            // Every binary kind is the FlaxEngine asset class of the same name.
            var metadata = CreatedAssetMetadata(absolute, normalized, isJson ? typeName : "FlaxEngine." + tag);
            var warnings = new List<string> { "Asset creation has no Editor undo record; remove the file with asset_delete (quarantine) if it is not needed." };
            if (isGlobals && globalsVariables.Length > 0) warnings.Add("Created via the Editor's GameplayGlobals path (virtual asset + Save) with " + globalsVariables.Length.ToString(CultureInfo.InvariantCulture) + " default variable(s).");
            if (metadata.Id == null) warnings.Add("The Content registry did not list the new asset yet (database scan is asynchronous); poll asset_get for the path before referencing it.");
            return new McpAssetCreateResult
            {
                DryRun = false, Created = true, Kind = isJson ? "JsonAsset" : tag, TypeName = typeName, Path = normalized, Asset = metadata,
                ProjectRevision = AdvanceProjectRevision(), Warnings = warnings.ToArray(),
            };
        }

        // Bridge v33 ParticleEffect parameter overrides.
        private const int MaxParticleParameters = 256;

        private static ParticleEffect RequireParticleEffect(string id)
        {
            var actor = RequireActor(id);
            var effect = actor as ParticleEffect;
            if (effect == null)
                throw new McpProtocolException("VALIDATION_FAILED", "Actor is not a FlaxEngine.ParticleEffect (got " + (actor.TypeName ?? "unknown") + ").");
            return effect;
        }

        private static ParticleEffectParameter[] LoadParticleParameters(ParticleEffect effect)
        {
            var system = effect.ParticleSystem;
            if (system == null) return new ParticleEffectParameter[0];
            if (system.WaitForLoaded(30000) || system.LastLoadFailed)
                throw new McpProtocolException("ASSET_NOT_FOUND", "The ParticleSystem assigned to the effect failed to load.");
            ParticleEffectParameter[] parameters;
            try { parameters = effect.Parameters; }
            catch { parameters = null; }
            return parameters ?? new ParticleEffectParameter[0];
        }

        private McpParticleParametersResult GetParticleParameters(McpParticleParametersRequest q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Particle parameter parameters are required.");
            var effect = RequireParticleEffect(q.ActorId);
            var parameters = LoadParticleParameters(effect);
            var entries = new List<McpParticleParameterDto>();
            foreach (var parameter in parameters)
            {
                if (parameter == null) continue;
                if (entries.Count >= MaxParticleParameters) break;
                var type = parameter.ParamType;
                var dto = new McpParticleParameterDto
                {
                    Track = LimitForLog(parameter.TrackName, 256), Name = LimitForLog(parameter.Name, 256),
                    Type = FriendlyTypeName(type), IsPublic = parameter.IsPublic,
                    Writable = parameter.IsPublic && IsSupportedMemberType(type),
                };
                try { dto.Value = ProjectMemberValue(parameter.Value, type); }
                catch { dto.Value = new McpMaterialTypedValue { Kind = "unavailable" }; }
                try { dto.DefaultValue = ProjectMemberValue(parameter.DefaultValue, type); }
                catch { dto.DefaultValue = new McpMaterialTypedValue { Kind = "unavailable" }; }
                entries.Add(dto);
            }
            var warnings = new List<string>();
            if (effect.ParticleSystem == null) warnings.Add("The effect has no ParticleSystem assigned, so it exposes no parameters.");
            return new McpParticleParametersResult
            {
                ActorId = effect.ID.ToString("N"), ParticleSystem = AssetMetadataForLoadedAsset(effect.ParticleSystem),
                Parameters = entries.ToArray(), Truncated = parameters.Length > entries.Count, Warnings = warnings.ToArray(),
            };
        }

        internal static void ApplyParticleParameter(Guid actorId, string track, string name, object value)
        {
            var effect = Level.FindActor(actorId) as ParticleEffect;
            if (effect == null) return;
            effect.SetParameterValue(track, name, value);
            if (effect.Scene != null) FEditor.Instance.Scene.MarkSceneEdited(effect.Scene);
        }

        private object ExecuteSetParticleParameter(McpParticleParameterSet q)
        {
            if (q != null && q.DryRun) return SetParticleParameter(q);
            return ExecuteIdempotent("particle.set_parameter", q == null ? null : q.IdempotencyKey, q, () => SetParticleParameter(q));
        }

        private McpParticleParameterSetResult SetParticleParameter(McpParticleParameterSet q)
        {
            if (q == null) throw new McpProtocolException("INVALID_REQUEST", "Particle parameter parameters are required.");
            if (string.IsNullOrEmpty(q.Name) || q.Name.Length > 256)
                throw new McpProtocolException("VALIDATION_FAILED", "Name must be between 1 and 256 characters.");
            if (q.Track != null && q.Track.Length > 256)
                throw new McpProtocolException("VALIDATION_FAILED", "Track must be at most 256 characters.");
            RequireEditTime("particle.set_parameter");
            var effect = RequireParticleEffect(q.ActorId);
            CheckSceneWrite(effect.Scene, q.ExpectedSceneRevision, q.LeaseId);
            ParticleEffectParameter match = null;
            var matches = 0;
            foreach (var parameter in LoadParticleParameters(effect))
            {
                if (parameter == null || !string.Equals(parameter.Name, q.Name, StringComparison.Ordinal)) continue;
                if (!string.IsNullOrEmpty(q.Track) && !string.Equals(parameter.TrackName, q.Track, StringComparison.Ordinal)) continue;
                match = parameter;
                matches++;
            }
            if (matches == 0)
                throw new McpProtocolException("NOT_FOUND", "Particle parameter '" + LimitForLog(q.Name, 128) + "' was not found on the effect. Use particle_get_parameters to list tracks and names.");
            if (matches > 1)
                throw new McpProtocolException("VALIDATION_FAILED", "Particle parameter '" + LimitForLog(q.Name, 128) + "' exists on " + matches + " emitter tracks; pass Track to select one.");
            var type = match.ParamType;
            if (!match.IsPublic)
                throw new McpProtocolException("VALIDATION_FAILED", "Particle parameter '" + match.Name + "' is not public and cannot be overridden on the effect.");
            if (type == null || !IsSupportedMemberType(type))
                throw new McpProtocolException("VALIDATION_FAILED", "Particle parameter '" + match.Name + "' has an unsupported type (" + (FriendlyTypeName(type) ?? "unknown") + ").");
            var coerced = CoerceMemberValue(type, q.Bool, q.Number, q.Text, match.Name);
            var beforeRaw = match.Value;
            var wouldChange = !MemberValuesEqual(beforeRaw, coerced);
            var track = match.TrackName;
            var name = match.Name;
            var typeName = FriendlyTypeName(type);
            if (q.DryRun)
            {
                var preview = CurrentRevision(effect.Scene);
                return new McpParticleParameterSetResult
                {
                    ActorId = effect.ID.ToString("N"), Track = track, Name = name, Type = typeName, DryRun = true, WouldChange = wouldChange,
                    Before = ProjectMemberValue(beforeRaw, type), After = ProjectMemberValue(coerced, type),
                    ProjectRevision = preview.ProjectRevision, SceneRevision = preview.SceneRevision,
                    Warnings = new[] { "Dry-run preview only: the parameter override was not written." },
                };
            }
            if (!wouldChange)
            {
                var unchanged = CurrentRevision(effect.Scene);
                return new McpParticleParameterSetResult
                {
                    ActorId = effect.ID.ToString("N"), Track = track, Name = name, Type = typeName, DryRun = false, WouldChange = false,
                    Before = ProjectMemberValue(beforeRaw, type), After = ProjectMemberValue(beforeRaw, type),
                    ProjectRevision = unchanged.ProjectRevision, SceneRevision = unchanged.SceneRevision,
                    Warnings = new[] { "The parameter already has this value; nothing was written." },
                };
            }
            var actorId = effect.ID;
            var action = new McpLambdaUndo("Set particle parameter",
                () => ApplyParticleParameter(actorId, track, name, coerced),
                () => ApplyParticleParameter(actorId, track, name, beforeRaw));
            try { action.Do(); }
            catch (Exception ex) { throw new McpProtocolException("VALIDATION_FAILED", "Particle parameter write failed: " + DescribeException(ex)); }
            FEditor.Instance.Undo.AddAction(action);
            MarkEdited(effect);
            var revision = AdvanceSceneRevision(effect.Scene);
            object afterRaw;
            try { afterRaw = effect.GetParameterValue(track, name); }
            catch { afterRaw = coerced; }
            return new McpParticleParameterSetResult
            {
                ActorId = effect.ID.ToString("N"), Track = track, Name = name, Type = typeName, DryRun = false, WouldChange = wouldChange,
                Before = ProjectMemberValue(beforeRaw, type), After = ProjectMemberValue(afterRaw, type),
                ProjectRevision = revision.ProjectRevision, SceneRevision = revision.SceneRevision,
                Warnings = new[] { "The override is stored on the ParticleEffect actor; the scene was marked edited, not saved. Undo restores the previous value as an explicit override." },
            };
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

        // Bridge v16 B3: per-asset edit lease for scene-less graph writes.
        // Same fail-closed semantics as CheckSceneWrite, keyed by
        // "graph:<assetId>". Enforced on dry-run previews too: while a
        // foreign lease is active, even a preview is refused.
        private void CheckGraphWrite(McpAssetRecord record, string leaseId)
        {
            var scopeKey = "graph:" + record.Id.ToString("N");
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                McpLeaseState lease;
                if (_sceneLeases.TryGetValue(scopeKey, out lease))
                {
                    if (!string.Equals(lease.LeaseId, leaseId, StringComparison.Ordinal))
                        throw new McpProtocolException("EDIT_LEASE_CONFLICT", "A different edit lease is active for this graph asset.", LeaseDetails(lease, "active"));
                }
                else if (!string.IsNullOrEmpty(leaseId))
                {
                    throw new McpProtocolException("EDIT_LEASE_EXPIRED", "The supplied edit lease is no longer active.", new { Scope = scopeKey, LeaseId = leaseId, ProjectRevision = _projectRevision });
                }
            }
        }

        private McpEditLease BeginLease(McpLeaseBegin request)
        {
            if (request == null) throw new McpProtocolException("INVALID_REQUEST", "Edit lease parameters are required.");
            // Scene-less graph scope (bridge v16 B3): per-asset lease key.
            // SceneId and a graph asset selector are mutually exclusive.
            string scopeKey;
            string scopeKind;
            if (!string.IsNullOrEmpty(request.SceneId))
            {
                if (!string.IsNullOrEmpty(request.AssetId) || !string.IsNullOrEmpty(request.Path))
                    throw new McpProtocolException("INVALID_REQUEST", "Edit lease takes exactly one scope: SceneId or a graph AssetId/Path.");
                var scene = RequireScene(request.SceneId);
                scopeKey = scene.ID.ToString("N");
                scopeKind = "scene";
            }
            else
            {
                var record = ResolveGraphRecord(request.AssetId, request.Path);
                scopeKey = "graph:" + record.Id.ToString("N");
                scopeKind = "graph asset";
            }
            if (string.IsNullOrWhiteSpace(request.Owner) || request.Owner.Length > 128) throw new McpProtocolException("VALIDATION_FAILED", "Owner must be between 1 and 128 characters.");
            if (request.TtlMs < MinLeaseTtlMs || request.TtlMs > MaxLeaseTtlMs) throw new McpProtocolException("VALIDATION_FAILED", "TtlMs must be between " + MinLeaseTtlMs + " and " + MaxLeaseTtlMs + ".");
            lock (_stateLock)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                CleanupExpiredStateLocked(now);
                McpLeaseState existing;
                if (_sceneLeases.TryGetValue(scopeKey, out existing)) throw new McpProtocolException("EDIT_LEASE_CONFLICT", "An edit lease is already active for this " + scopeKind + ".", LeaseDetails(existing, "active"));
                var lease = new McpLeaseState { LeaseId = Guid.NewGuid().ToString("N"), SceneId = scopeKey, Owner = request.Owner, AcquiredUnixMs = now, ExpiresUnixMs = now + request.TtlMs };
                _sceneLeases[scopeKey] = lease;
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
                TryDelete(AssetOperationPath(key));
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
            var fingerprint = Fingerprint(method + "\n" + JsonSerializer.Serialize(PlainForJson(request), false));
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

        // FlaxEngine.Json serializes public fields and settable properties
        // only, so a C# anonymous type (get-only properties) becomes "{}"
        // (live-verified on Flax 1.12). The bridge builds error details and
        // idempotency fingerprint inputs from anonymous types, so they are
        // projected to dictionaries before serialization: otherwise clients
        // never see details such as CurrentSceneRevision and every
        // anonymous fingerprint input hashes to the same value.
        private const int MaxPlainJsonDepth = 6;

        private static bool IsAnonymousType(Type type)
        {
            return type.Name.StartsWith("<>", StringComparison.Ordinal) && type.IsDefined(typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute), false);
        }

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
            // FlaxEngine.Utils.GetAssemblies lists the default context plus the
            // CURRENT scripting context only. AppDomain.GetAssemblies also
            // returns game assemblies of contexts unloaded by earlier script
            // reloads; a type from one of those cannot be instantiated
            // (live-verified: Actor.AddScript then throws NullReference).
            foreach (var assembly in FlaxEngine.Utils.GetAssemblies()) { if (assembly == null) continue; type = assembly.GetType(typeName, false); if (type != null) break; }
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

        private static IUndoAction CreateBreakPrefabLinkAction(Actor actor)
        {
            // Flax 1.12 exposes BreakPrefabLinkAction in its editor assembly
            // but keeps the type internal. Invoke the documented public
            // Break(Actor) factory so break/undo/redo flow through the
            // reviewed action (Do, then Undo.AddAction like McpScriptFieldUndo).
            var type = typeof(IUndoAction).Assembly.GetType("FlaxEditor.Actions.BreakPrefabLinkAction", false);
            var method = type == null ? null : type.GetMethod("Break", BindingFlags.Static | BindingFlags.Public, null, new[] { typeof(Actor) }, null);
            var action = method == null ? null : method.Invoke(null, new object[] { actor }) as IUndoAction;
            if (action == null) throw new McpProtocolException("UNSUPPORTED_FLAX_VERSION", "This Flax version does not expose a prefab break-link undo action.");
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
            try { output = Path.GetFullPath(Path.IsPathRooted(entry.ResultUrl) ? entry.ResultUrl : Path.Combine(Globals.ProjectFolder, entry.ResultUrl)); } catch { return; } // same normalisation as QueueAssetReimport; the dictionary compares case-insensitively
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
                PersistAssetImportOperationLocked(operation);
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
            FEditor.LightmapsBakeStart += OnLightmapsBakeStart;
            FEditor.LightmapsBakeProgress += OnLightmapsBakeProgress;
            FEditor.LightmapsBakeEnd += OnLightmapsBakeEnd;
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
            FEditor.LightmapsBakeStart -= OnLightmapsBakeStart;
            FEditor.LightmapsBakeProgress -= OnLightmapsBakeProgress;
            FEditor.LightmapsBakeEnd -= OnLightmapsBakeEnd;
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
                RestoreAssetImportOperations();
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
            return new McpResponse { id = id, token = requestToken, ok = false, errorCode = code, error = message, errorDetails = details == null ? null : JsonSerializer.Serialize(PlainForJson(details), false), timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }
        private static bool IsSafeRequestFile(string name) { if (string.IsNullOrEmpty(name) || name.Length > 133 || !name.EndsWith(".json")) return false; for (var i = 0; i < name.Length - 5; i++) { var c = name[i]; if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false; } return true; }
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

    // Bridge v29 material-parameter undo. This is a bridge-owned generic
    // snapshot action (before/after values re-applied plus Asset.Save), NOT
    // the editor MaterialInstanceWindow action: that action requires an open
    // material window and is not bridge-usable, so the choice is documented
    // in every set_parameters result warning.
    internal sealed class McpMaterialParametersUndo : IUndoAction
    {
        private Guid _assetId;
        private readonly string[] _names;
        private readonly object[] _before;
        private readonly object[] _after;

        public string ActionString { get { return "Set material parameters"; } }

        public McpMaterialParametersUndo(Guid assetId, string[] names, object[] before, object[] after)
        {
            _assetId = assetId;
            _names = names;
            _before = before;
            _after = after;
        }

        public void Do() { Apply(_after); }
        public void Undo() { Apply(_before); }
        public void Dispose() { }

        private void Apply(object[] values)
        {
            MaterialBase material = null;
            try { material = Content.Load(_assetId, 250) as MaterialBase; } catch { material = null; }
            if (material == null || material.LastLoadFailed) return;
            for (var i = 0; i < _names.Length; i++)
            {
                try { material.SetParameterValue(_names[i], values[i], true); }
                catch { }
            }
            // Undo/redo of an asset edit must restore durability, not just
            // memory: failures here are logged, never thrown, because Flax
            // invokes undo outside any request context.
            try
            {
                if (material.Save()) Debug.LogWarning("[Flax MCP] Material undo save failed for " + _assetId.ToString("N") + ".");
            }
            catch (Exception ex) { Debug.LogWarning("[Flax MCP] Material undo save failed: " + ex.Message); }
        }
    }

    // Bridge v33 generic member undo for actor and UI-control members.
    // Before/after values are re-applied through the same reviewed Editor
    // wrapper as the live write (ScriptMemberInfo.SetValue). Scene-object
    // references are stored by ID and re-resolved on apply, so the undo
    // stack never holds a destroyed actor or script.
    internal sealed class McpMemberUndo : IUndoAction
    {
        private sealed class SceneObjectRef { public Guid Id; }

        private Guid _ownerId;
        private readonly bool _control;
        private readonly string _member;
        private readonly object _before;
        private readonly object _after;

        public string ActionString { get { return "Set property"; } }

        public McpMemberUndo(Actor owner, bool control, string member, object before, object after)
        {
            _ownerId = owner.ID;
            _control = control;
            _member = member;
            _before = Pack(before);
            _after = Pack(after);
        }

        public void Do() { Apply(_after); }
        public void Undo() { Apply(_before); }
        public void Dispose() { }

        private static object Pack(object value)
        {
            var sceneObject = value as SceneObject;
            // Brushes and font references are mutable objects: the stack keeps
            // a private copy (see FlaxMcpBridgePlugin.SnapshotMemberValue).
            return sceneObject == null ? FlaxMcpBridgePlugin.SnapshotMemberValue(value) : new SceneObjectRef { Id = sceneObject.ID };
        }

        private static object Unpack(object value)
        {
            var reference = value as SceneObjectRef;
            if (reference == null) return FlaxMcpBridgePlugin.RestoreMemberValue(value);
            var id = reference.Id;
            return FObject.TryFind<SceneObject>(ref id);
        }

        private void Apply(object value)
        {
            var actor = Level.FindActor(_ownerId);
            if (actor == null) return;
            object target = actor;
            if (_control)
            {
                var ui = actor as UIControl;
                target = ui == null ? null : ui.Control;
            }
            if (target == null) return;
            var member = FlaxMcpBridgePlugin.FindEditorMember(target, _member);
            if (!member) return;
            member.SetValue(target, Unpack(value));
            if (actor.Scene != null)
                FEditor.Instance.Scene.MarkSceneEdited(actor.Scene);
        }
    }

    // Bridge v33 closure-based undo for writes whose apply step is a single
    // public engine call (for example ParticleEffect.SetParameterValue).
    internal sealed class McpLambdaUndo : IUndoAction
    {
        private readonly string _label;
        private readonly Action _do;
        private readonly Action _undo;

        public string ActionString { get { return _label; } }

        public McpLambdaUndo(string label, Action doAction, Action undoAction)
        {
            _label = label;
            _do = doAction;
            _undo = undoAction;
        }

        public void Do() { _do(); }
        public void Undo() { _undo(); }
        public void Dispose() { }
    }
}
#endif
