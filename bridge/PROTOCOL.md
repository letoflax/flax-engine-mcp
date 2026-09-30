# Flax MCP Editor Bridge protocol (bridge v14 / protocol v1)

`FlaxMcpBridge.cs` is an Editor-only Flax 1.12 plugin. It uses only files below
`<project>/Cache/MCP`; it does not open a network listener.

At startup the bridge creates `requests/`, `processing/`, and `responses/`, then
writes these project-local files:

- `bridge.json`: `{ "BridgeVersion": 14, "ProtocolVersion": 1, "Pid": 123, "Project": "...", "EditorVersion": "1.12.6912", "Timestamp": 0 }`.
  It is atomically rewritten every two seconds. `Timestamp` is Unix milliseconds.
- `token`: a fresh 256-bit base64url session token. The bridge requires it on every
  request and deletes it on normal shutdown. It is marked hidden where the host
  filesystem supports that attribute; callers must treat `Cache/MCP` as private.

The Node client writes `requests/<id>.json` using a temporary file then rename.
`id` is 1–128 ASCII alphanumeric, `_`, or `-` and must equal the filename stem; the bridge atomically moves it to
`processing/` before reading it, so a request is executed at most once by one
bridge instance. A response is atomically written to `responses/<id>.json`.

Request fields are lowercase `id`, `token`, `method`, `paramsJson`, and `deadlineUnixMs`.
`paramsJson` is a JSON string, not an arbitrary object, and is capped at 64 KiB.
`deadlineUnixMs` is Unix milliseconds; it may be zero or within the next 60 s.
Response fields are lowercase `id`, `token`, `ok`, `errorCode`, `error`, optional `errorDetails`, `resultJson`, and `timestamp`. `errorDetails` is an optional JSON string added in bridge v7; clients that do not understand it can ignore it. The v7 revision conflict uses it to return the current bridge-known revision.
The client rejects a response unless its token matches the active session token
using a constant-time comparison. Failure responses echo the request token; an
unauthorized request never receives the active session token.
Successful `resultJson` payload DTOs use PascalCase fields. Status results omit the
project path, and scene paths are project-relative; the heartbeat's project path
exists only so the local client can reject a bridge from another project.

Bridge v5 methods remain available: `status`, `scene.list_loaded`, `scene.get_tree`, `scene.save`,
`project.save_all`, actor CRUD/find/duplicate/reparent, narrowly scoped script
attach/detach/instance read/update, and `edit.undo`/`edit.redo`. The script update
surface only permits an optional `Enabled` patch; an empty patch fails, and arbitrary
reflection-based or serialized-property changes are not exposed. `actor.update`
permits only name, active, world position/scale/Euler angles, local
position/scale/Euler angles, layer, and v15 component assignments for
`FlaxEngine.AnimatedModel` (`SkinnedModel`, `AnimationGraph`,
`UpdateWhenOffscreen`) and `FlaxEngine.StaticModel` (`Model`). Asset selectors
accept either a 32-character GUID or a `Content/...` path, never both in the
same field. World-space and local-space patches cannot
be combined in one request. The public Flax 1.12 API does not expose a reliable transaction/rollback
primitive for arbitrary operations, so the bridge advertises `TransactionsSupported:false`
and intentionally does not claim an atomic batch operation.
Recursive actor-tree results are bounded to 64 levels and 2,000 actors; larger
trees fail with `RESPONSE_TOO_LARGE` instead of exhausting the editor or client.

Bridge v7 actor DTOs additionally expose bounded, public Flax 1.12 metadata:
`ParentId`, `OrderInParent`, `ChildrenCount`, `ActiveInHierarchy`, world and local
position/scale/Euler angles, `Layer`, `LayerName`, numeric `StaticFlags`, and up to
64 tag names (`TagsTruncated` reports the remainder). `actor.find` retains its
v5 name-substring filter and adds v7-only exact `TypeName`, direct `ParentId`, and
`Active` filters. These fields are explicit allowlisted DTO members; arbitrary
actor components/properties, prefab overrides, and script serialized properties
remain unsupported.

Bridge v6 adds:

- `code.status`, `code.compile_start`, `code.diagnostics`,
  `code.generate_project_start`, and `code.generate_project_status`.
- `play.status`, `play.start_scenes`, `play.start_game`, `play.stop`,
  `play.pause`, `play.resume`, and `play.step`.
- `log.query`, `capture.start`, `capture.status`, and
  `runtime.inspect_actor`.

Compilation and project generation use operation IDs and persisted state below
`Cache/MCP`. Starting an operation is a short request; clients poll status
instead of holding one RPC open. Script compilation may unload and recreate the
bridge assembly, heartbeat, and session token. A client must never blindly
repeat `code.compile_start` after losing its response: v6 accepts a caller-selected
operation ID and may adopt only that exact persisted operation. Successful completion
requires script reload to finish and the editor to be ready. Diagnostics are
tied to the latest operation, bounded and paginated; file paths are
project-relative.

Play start is rejected while compilation is active, after a failed compile
unless explicitly overridden, or with edited scenes unless explicitly allowed.
Flax 1.12 headless editors also reject play start because their game-window
cleanup path cannot reliably leave play mode; status, compile, diagnostics, and
log queries remain available headlessly.
Status includes a play-session ID, lifecycle state, mode, duration, dirty-scene
state, and an informational editor frame counter. Frame stepping is acknowledged
by Flax's running-to-repaused lifecycle before another step is requested. Stop is
idempotent. Runtime actor inspection is read-only, play-mode-only, depth-bounded,
and exposes only allowlisted actor/script metadata.

`log.query` reads a bounded in-memory ring using sequence numbers, severity,
category, play-session, and substring filters. Entries are correlated with the
active compilation/play session, and log text is redacted before it leaves the
bridge. `Tail:true` requests the newest matching entries; ordinary sequence
scans remain ascending and paginated.

Viewport capture is play-mode-only and unavailable in headless mode. It writes a
PNG below `Cache/MCP/captures`; status returns an opaque capture ID, never an
arbitrary caller path. Files expire after 24 hours and the Node server exposes
them through `flax://capture/<id>` with bounded MCP `resources/list` and
`resources/read` handlers.

`actor.duplicate` delegates to Flax's undoable editor command. Flax 1.12 does not
return the new actor ID from that public command, so the response reports
`Verified:false` and `NewActorId:null`; clients must refresh the scene tree.

## Bridge v7: revisions, edit leases, and idempotency

Bridge v7 keeps protocol v1 because all wire additions are optional/additive. Its
status result adds `ProjectRevision`, `RevisionScope:"bridge-session-known-mutations"`,
`EditLeasesSupported:true`, and `EditLeaseSemantics:"visible-immediately-no-rollback"`.
Loaded scene results add `ProjectRevision` and `SceneRevision`; actor and script
snapshots, and scene actor/script mutation results, carry the same relevant values.

`ProjectRevision` and each `SceneRevision` begin at zero when this bridge Editor
session initializes. They advance only after a mutation executed through this
bridge. The bridge deliberately does not claim to observe unsaved manual Editor
edits or arbitrary third-party plugin changes: Flax 1.12 has no verified event
used by this bridge for that detection. A caller must read again after any
out-of-band change it knows about.

The live write DTOs (`actor.create`, `actor.update`, `actor.set_property`,
`actor.delete`, `actor.duplicate`, `actor.reparent`, `script.attach`,
`script.detach`, `script.instance_update`, and `script.instance_set_value`)
accept optional PascalCase `ExpectedSceneRevision` and
`LeaseId`. When a target scene can be identified before the mutation, a mismatched
revision fails with `SCENE_REVISION_CONFLICT`; `errorDetails` includes
`SceneId`, `ExpectedSceneRevision`, `CurrentSceneRevision`, and `ProjectRevision`.
An active lease held by a different ID fails with `EDIT_LEASE_CONFLICT`; an
expired/missing supplied lease fails with `EDIT_LEASE_EXPIRED`. `actor.create`
cannot identify Flax's editor-default spawn scene before `Spawn` when `ParentId`
is absent, so it rejects guarded (`ExpectedSceneRevision` or `LeaseId`) creates
without a parent. Cross-scene reparenting is not supported by the v7 lease scope.

The lease RPC methods are `edit.lease_begin` (`SceneId`, `Owner`, `TtlMs`),
`edit.lease_get` (`SceneId` or `LeaseId`), `edit.lease_commit` (`LeaseId`), and
`edit.lease_release` (`LeaseId`). TTL is 1,000 through 300,000 ms. Only one lease
per loaded scene is active. `commit` and `release` both end the lease; they do not
commit or roll back an atomic transaction. Writes are visible immediately, and
play start fails with `EDIT_LEASE_ACTIVE` while any unexpired bridge lease exists.
`TransactionsSupported` stays `false` because the verified public Flax 1.12 API
provides undo record/action methods but no safe arbitrary multi-operation
transaction with commit/rollback semantics.

Bridge v16 extends leases to scene-less graph writes: `edit.lease_begin`
accepts exactly one scope — `SceneId` or a graph `AssetId`/`Path`
(AnimationGraph/Material/ParticleEmitter only). Graph scopes are keyed
`graph:<assetId>` in the same lease table, so `edit.lease_get` (by `LeaseId`),
`edit.lease_commit`, and `edit.lease_release` work unchanged, and expiry sweeps
apply equally. `graph.set_default_parameter` and `graph.add_parameter` accept
optional `LeaseId` (enforced on dry-run previews too): an active foreign lease
fails with `EDIT_LEASE_CONFLICT`, a supplied-but-unknown lease with
`EDIT_LEASE_EXPIRED`. With no active lease, writes without `LeaseId` stay allowed.

Those live write DTOs also accept optional `IdempotencyKey` (1--128 characters).
For ten minutes, with a maximum of 512 retained entries, a repeated key with the
same method and serialized request returns the original result without performing
the side effect or advancing revisions. Reusing a retained key for different input
fails with `IDEMPOTENCY_KEY_REUSED`. The cache is bridge-session-local and is not a
durable request journal; clients should use it for retry recovery, especially for
create, duplicate, and script attach.

## Script field value reads (P7 read surface, no version bump)

`script.instance_get` accepts an opt-in PascalCase `IncludeValues` flag (default
false, so default reads stay wire-identical to older bridges). With
`IncludeValues:true` the result adds a bounded read-only projection of the
script's public instance fields: `Values` (alphabetical, at most 64 entries),
`ValuesIncluded:true`, `ValuesTruncated` (true when fields were dropped), and a
`Warnings` note that values are a bounded projection and script writes are
limited to `Enabled` plus bounded `script.instance_set_value` field writes
(bridge v28). With the flag absent or false, `Values` is null and
`ValuesIncluded` is false.

Each entry carries `Name`, `Type` (full type name), `Value` (a v13
`McpMaterialTypedValue` shape plus an `enum` kind carrying the numeric value,
display text, and enum type name), and `Reason`. The whitelist is
bool/int/float/string/enum/Guid/Vector2-4/Color plus null; live `Asset`
references, unsupported runtime types, and unreadable fields are a null `Value`
with a `Reason`. Strings truncate at 512 characters. Field reads never mutate
the script, and the global 512 KiB `MaxResultBytes` cap still bounds the total
response (`RESPONSE_TOO_LARGE` on overflow). `script.instance_update` still
accepts only `Enabled`; bounded field writes go through
`script.instance_set_value` (bridge v28) and arbitrary serialized script
writes remain unexposed.

## Bridge v8: public asset registry and reference graph

## MCP resource delivery (Node server)

The Node MCP server exposes bridge data as bounded read-only resources; this does
not add a bridge RPC or imply an Editor event stream. Fixed resources include
project metadata/settings, bridge status, loaded scenes, diagnostics, logs,
compile status, and script audit history. Live scene/actor URIs require bridge
v5; live asset URIs require v8. All resource URIs use canonical `flax://` paths,
reject queries/fragments/encoded traversal, redact host paths, and limit JSON to
256 KiB. Capture PNG resources retain the existing cache confinement, TTL, and
size checks.

The MCP server may subscribe clients to Editor status, scene trees, diagnostics,
and logs. It sends debounced `notifications/resources/updated` only after a
successful MCP mutation known to affect a subscribed resource; Editor status is
also bounded-polled through the heartbeat. The bridge has no verified callback
for manual Editor edits or arbitrary plugin mutations, so those changes are not
guaranteed to cause notifications. Successful captures cause the server to send
`notifications/resources/list_changed`.

Bridge v8 keeps protocol v1 because the asset RPCs and status fields are additive.
`status` adds `AssetRegistrySupported:true`, `AssetReferenceGraphSupported:true`,
`AssetImportSettingsSupported:false`, and `AssetReferenceLocationsSupported:false`.

The v8 allowlisted methods are `asset.search`, `asset.get`,
`asset.dependencies`, and `asset.find_references`. Successful result DTOs use
PascalCase. `asset.get`, `asset.dependencies`, and `asset.find_references` require
exactly one `AssetId` or `Path` selector. All selector and result paths are
project-relative `Content/...` paths; IDs are 32-character GUIDs.

`asset.search` accepts `Query`, `Path`, `Type`, `Extension`, `Guid`, `Folder`,
`HasMissingDependency`, `Limit`, and `Cursor`. `asset.dependencies` accepts
`Transitive` and `MaxDepth` in addition to its selector and paging fields.
Search/reference pages have a maximum `Limit` of 200. Dependency requests are
direct by default; transitive traversal is cycle-safe and has `MaxDepth` 1--16.
The bridge scans at most 10,000 registry assets and 10,000 dependency edges per
request. Larger work fails with `RESPONSE_TOO_LARGE`.

Cursors are opaque bridge-generated IDs. They are scoped to the method and
filters/root selector, carry the registry metadata revision, expire after ten
minutes, and fail with `CURSOR_INVALID` if reused for a different scope or after
registry metadata changes. Missing selectors fail with `ASSET_NOT_FOUND`.

The implementation uses only public Flax 1.12 APIs: `Content.GetAllAssets`,
`Content.GetAssetInfo`, `Content.Load`, and `Asset.GetReferences`.
`GetReferences` returns direct IDs only and can contain duplicates/invalid IDs;
v8 deduplicates and validates them against the Content registry before returning
them. Reverse references are a bounded scan of those verified direct asset
references. Result kind is `asset`, `scene`, or `prefab` only when the registry
type verifies it; actor and property paths are intentionally absent. Public APIs
do not verify importer settings, import status, file size, modified time, or
asset-reference locations, so v8 omits them instead of inferring them from files
or reflection.

## Bridge v9: allowlisted asset import and reimport

Bridge v9 keeps protocol v1. It adds `AssetImportSupported:true`,
`AssetReimportSupported:true`, `AssetImportSynchronous:true`, and
`AssetReimportSynchronous:false` to `status`, plus
four allowlisted methods: `asset.import_start`, `asset.import_status`,
`asset.reimport_start`, and `asset.reimport_status`.

The Node server must pass canonical configured roots from repeatable
`--asset-import-root` options. No roots means the start methods reject with
`IMPORT_SOURCE_NOT_ALLOWED`; root paths are never emitted in a response. The
bridge repeats canonical existing-file, root containment, extension, size, and
post-validation checks immediately before calling Flax. Supported source types
are Flax 1.12's built-in texture/model/audio extensions, and the hard source
maximum is 512 MiB. A source path which escapes a root through symlinks or
junctions is rejected.

`asset.import_start` accepts PascalCase `OperationId`, `IdempotencyKey`,
`SourcePath`, `SourceSizeBytes`, `SourceLastWriteUnixMs`, `DestinationPath`,
`CollisionPolicy`, `DryRun`, `AllowedImportRoots`, and `MaxSourceBytes`.
`DestinationPath` is strictly project-relative `Content/.../*.flax`; absolute
paths, traversal, and a Content parent resolving through a junction are rejected.
`CollisionPolicy` is `error` (default) or bounded `rename`, never overwrite.
The verified direct API is `FlaxEditor.Editor.Import(inputPath, outputPath)`;
the bridge never substitutes `File.Copy`, opens an import dialog, or launches a
process. Flax 1.12 returns this call synchronously, so a successful operation is
terminal (`succeeded` or `dry_run`) before the start response is written.

`asset.reimport_start` accepts the same operation/idempotency/dry-run/root
guards plus exactly one existing registry selector: `AssetId` or `Path`. The
selected object must load as `BinaryAsset`; the bridge uses only its public
`ImportPath` metadata, then queues the verified public
`ContentImporting.Reimport(..., skipSettingsDialog:true)` API. Its worker
completion event provides the terminal operation state/progress; no void-returning
reimport API is misrepresented as synchronous success. Missing or unallowlisted
metadata sources reject rather than prompting for a file. Importer settings and
type changes remain unsupported.

Both start methods reject `EDITOR_BUSY` while the Editor is playing, starting
play, compiling/reloading scripts, or already importing content. They are UI-free
and can be requested from a headed or headless Editor, but actual headless import
success remains dependent on the installed Flax importer backend; callers should
validate that environment. Operation records contain only kind, phase, bounded
progress, timestamps, Content-relative result path/GUID, collision rename flag,
and bounded error text--never a source path or configured root. They expire after
ten minutes and are capped at 512. Reusing an operation ID with a different
request fingerprint or an idempotency key with a different request yields
`IDEMPOTENCY_KEY_REUSED`; expired/unknown/mismatched status IDs yield
`OPERATION_NOT_FOUND`.

## Bridge v10: safe Content asset organization

Bridge v10 keeps protocol v1 and preserves every v5--v9 method. `status` adds
`AssetOrganizationSupported:true`, `AssetOrganizationUndoSupported:false`,
`AssetOrganizationLeaseSupported:false`, and
`AssetOrganizationAtomicity:"single-content-api-call-not-transactional"`.
The v7 edit lease is scene-scoped, so it cannot guard an asset organization
operation and is deliberately not accepted by these methods.

The new allowlisted methods are `asset.move`, `asset.rename`, and
`asset.duplicate`. Each accepts exactly one `AssetId` or Content-relative
`Path`, `CollisionPolicy` (`error` or bounded `rename`), `DryRun`, optional
`ExpectedPath`, optional `ExpectedIndexRevision`, and optional
`IdempotencyKey`. `asset.move` additionally requires an existing Content
`Destination` folder. `asset.rename` requires `Name`; `asset.duplicate`
requires both `Destination` and `Name`. Names are filenames without an
extension; the source extension is retained. Paths use normalized
project-relative `Content/...` notation; absolute paths, traversal, junction
escapes, nonexistent destination folders, extension changes, and overwrite
requests are rejected.

The bridge validates source identity and Content index revision before the
write. A stale `ExpectedPath` or `ExpectedIndexRevision` fails with
`ASSET_REVISION_CONFLICT` and bounded current details. An occupied destination
fails with `FILE_EXISTS` unless `CollisionPolicy:"rename"` can find one of at
most 999 `-N` suffixes. Reused idempotency keys retain the normal ten-minute,
512-entry v7 cache behavior.

These methods invoke only compile-probed public Flax 1.12 APIs:
`FEditor.Instance.ContentDatabase.Move`, `Content.RenameAsset`, and
`FEditor.Instance.ContentDatabase.Copy`. The bridge never performs a raw
`File.Move`/`File.Copy` fallback and never uses reflection. The returned
`ReferenceImpact` contains at most 50 direct reverse sources obtained from the
public `Asset.GetReferences` graph; actor and property locations remain
unavailable. Move/rename verify that the source GUID remains in the registry;
duplicate verifies a different destination GUID and reports that existing
references remain bound to the source asset.

Flax 1.12 does not expose a verified public undo record for these Content APIs,
so each result and status capability explicitly reports `UndoSupported:false`.
The operation is one Editor Content API call, not a multi-operation transaction
or rollback guarantee. No project content is saved automatically. Successful
and dry-run Node calls write only bounded Content-relative audit metadata.

## Bridge v11: generic persisted operation handles

Bridge v11 keeps protocol v1 and adds `OperationStatusSupported:true`,
`OperationCancelSupported:true`, and
`OperationHandleSemantics:"raw-handles-no-mcp-tasks"` to `status`. It exposes
`operation.status` and `operation.cancel`, both with a PascalCase
`OperationId` (a 32-character GUID without separators).

Operation records are bounded to 512 and atomically persisted beneath
`Cache/MCP/operations/<operationId>.json`. A record contains only the operation
ID/kind, phase, progress, bounded message, steps, timestamps, a bounded result
summary, diagnostics, and error fields. It never includes request tokens,
import source paths, configured roots, or arbitrary result payloads. Records
expire after ten minutes. A reload restores only the exact persisted ID and
marks a non-terminal operation `interrupted`; clients must not blindly repeat a
start request after a lost response.

Current compile, project-generation, import, and reimport handles are mirrored
into this common status surface. `operation.cancel` is truthful: it returns
`CANCELLATION_UNSUPPORTED` when Flax's public backend has no safe cancellation
API (including compilation and content importing). The only currently safe
checkpoint is queued project generation before it runs; cancellation then
returns terminal `cancelled` with `OPERATION_CANCELLED`. These raw handles are
not a claim of MCP Tasks support.

## Bridge v12: bounded prefab editor workflows

Bridge v12 keeps protocol v1 and preserves all v5--v11 methods. It adds
`prefab.create_from_actor`, `prefab.instantiate`, and `prefab.get_instances`,
backed only by verified public Flax 1.12 APIs (`PrefabManager.CreatePrefab`,
`PrefabManager.SpawnPrefab`, `Actor.IsPrefabRoot`, and prefab link metadata).
Creation requires a new project-relative `Content/.../*.prefab` path and never
overwrites; instantiation requires a loaded `ParentId` so scene revision and edit
lease guards can be checked before mutation. Instance enumeration scans loaded
scene actor trees only, capped at 10,000 actors and 200 results per page with
bounded cursors. (Bridge v12 shipped `prefab.get_overrides`,
`prefab.revert_overrides`, `prefab.apply_overrides`, and
`prefab.break_link` as explicit stable `UNSUPPORTED_FLAX_VERSION`
capabilities; bridge v30 replaced those stubs with real implementations —
see "Bridge v30" below.)

## Bridge v13: guarded asset quarantine deletion

Bridge v13 preserves every v5--v12 method and adds `asset.delete`. The method
is intentionally named for its user-facing workflow, but it is not a permanent
delete: it moves exactly one selected registry asset to a caller-provided,
existing Content-relative `Destination` using the compile-probed public
`FEditor.Instance.ContentDatabase.Move` API. `status` adds
`AssetQuarantineDeleteSupported:true` and `AssetPermanentDeleteSupported:false`.
The bridge never calls `ContentDatabase.Delete`, `File.Delete`, or
`Directory.Delete` for this method.

The request accepts exactly one `AssetId` or `Path`, an existing normalized
Content `Destination`, `CollisionPolicy`, `DryRun`, optional `ExpectedPath`,
optional `ExpectedIndexRevision`, optional `IdempotencyKey`, plus
`ConfirmReferenceCount`, `RequireUnreferenced`, and `Confirm`. Node defaults
`dry_run:true`; a dry run returns the bounded direct reverse-reference impact
without a mutation. A non-dry-run request must set `Confirm:true` and either
provide the exact `ConfirmReferenceCount` observed during review or set
`RequireUnreferenced:true`. The bridge rebuilds the public `Asset.GetReferences`
graph immediately before moving; a changed count or nonzero required count fails
with `ASSET_REFERENCE_CONFLICT` and bounded expected/current details. The GUID
and existing references are preserved, so restoration is a normal `asset.move`
or Content Browser operation.

The quarantine folder is never created through an unmanaged filesystem call;
callers create/select it through normal Editor workflows before invoking the
method. As with v10 organization, no verified undo record, asset lease, atomic
multi-operation rollback, automatic project save, actor/property reference
location, or permanent deletion capability is claimed. Node records bounded
Content-relative audit metadata for both successful previews and moves.

## Bridge v13: bounded build/cook workflows

Bridge v13 keeps protocol v1 and all v5--v12 methods. It adds
`build.list_targets`, `build.validate`, `build.cook`, `build.status`,
`build.result`, and `build.cancel`, backed only by Flax 1.12's public
`GameCooker.Build`, `GameCooker.Cancel`, build event, and progress event APIs.

The build target allowlist is deliberately small: `windows64`, `linux_x64`,
`macos_x64`, `macos_arm64`, `android_arm64`, and `web`; configurations are
`debug`, `development`, and `release`. `build.list_targets` and
`build.validate` are preflight only: Flax exposes no reviewed managed API for
checking whether a target toolchain is installed, so a listed target is not a
claim that it is locally buildable.

`build.cook` requires a caller-selected or generated 32-character `OperationId`
and a project-relative, non-empty `OutputPath` below `Builds/`. The bridge
rejects traversal, absolute paths, wrong separators, more than 32
identifier-like custom defines, a non-empty output directory, play mode, script
reload, and concurrent cooking. It never accepts arbitrary commands, build
presets, packaging settings, or an output path outside the project.
`DryRun:true` validates but never calls `GameCooker.Build`.

Build progress and terminal state appear both in the dedicated status/result
methods and generic v11 `operation.status` (`Kind:"build_cook"`).
`build.result` returns `BUILD_NOT_COMPLETE` until terminal. Unlike compilation
and content import, Flax 1.12 exposes `GameCooker.Cancel`; `build.cancel` and
generic `operation.cancel` request it asynchronously. A cancellation request is
terminal only after the cooker reports completion, so callers must poll rather
than treating acknowledgement as proof of cleanup.
## Bridge v13: bounded material and animation inspection

Bridge v13 keeps protocol v1. It adds public, read-only Flax 1.12 inspection
methods: material.get_parameters, animation.list_clips,
animation.get_graph_parameters, and animation.validate_bindings.

material.get_parameters selects exactly one registry Material or
MaterialInstance by 32-character GUID or Content/... path. It exposes a
bounded safe projection of the public MaterialBase.Parameters collection:
parameter ID/name/type/public/override flags and scalar, vector, color, asset,
or otherwise type-only value information. It never reflects arbitrary Variant
contents. A material-instance result may identify its public base material.

animation.list_clips lists registry assets whose verified type is
FlaxEngine.Animation, with public length, duration, frames-per-second, and
clip-info counts. It uses the existing 10,000-asset registry cap, 200-result
page maximum, and ten-minute opaque cursor rules. animation.get_graph_parameters
requires one loaded AnimatedModel actor and reports its live public Parameters
collection. animation.validate_bindings compares that actor's public
SkinnedModel, AnimationGraph, and graph BaseModel references; it does not infer
skeleton compatibility beyond matching public asset IDs.

The v13 method names material.set_parameters, material.create_instance,
material.assign_to_actor, and animation.set_graph_parameter are present only to
return stable UNSUPPORTED_FLAX_VERSION capabilities. Flax 1.12 exposes runtime
setters and virtual material instances, but this bridge has no reviewed Editor
undo, durable-save, actor-slot targeting, semantic-preview, and confirmation
path for those mutations. It therefore never calls SetParameterValue or
CreateVirtualInstance, nor does it mutate material slots or animation graph
state.
## Bridge v14: bounded advanced domain queries

Bridge v14 adds read-only `physics.validate_colliders`, `physics.raycast`,
`physics.get_layer_matrix`, and `physics.find_overlaps`; navigation status,
agent validation, and path query methods; lighting status/validation; plus
`terrain.get_summary` and `foliage.get_summary`. All query only public Flax
1.12 runtime state and cap caller-controlled result counts.

`navigation.build`, `lighting.bake`, and `environment_probe.bake` shipped as
stable `UNSUPPORTED_FLAX_VERSION` capabilities (bridge v31 replaced all three
stubs with real implementations — see "Bridge v31" below). Terrain and foliage
shipped metadata-only; bridge v31 adds real foliage instance writes while
`terrain.paint` remains a validated stub with no verified managed write path
(see "Bridge v31").
## Bridge v27: engine-side performance snapshot

Bridge v27 keeps protocol v1 and the full v26 surface. It adds
`perf.snapshot`, a read-only, single-sample engine telemetry read that works
in and out of play mode (no play gate, no headless gate — headless only
nulls the GPU fields). `status` adds `PerfSnapshotSupported:true`. Node
exposes `perf_get_snapshot` (read family, so the read-only profile keeps
it), requires bridge v27, and reports `perfSnapshot` in
`get_server_capabilities`.

The method takes no parameters (`{}`) and returns `McpPerfSnapshot { Fps,
FrameTimeMs, DrawCalls, Triangles, ManagedMemoryBytes, ActorCount,
GpuAdapter, RendererType, IsPlayMode, TimestampUnixMs }` — all primitive or
nullable, where null means the backing API had no data (never an error).
There is no history or averaging in the bridge; callers average by making N
calls. The sample is one main-thread read (`OnMain`) with no allocation
storms beyond a single actor-enumeration array.

SDK truth per field (Flax 1.12, verified against `Source/` headers plus the
shipped `FlaxEngine.CSharp.xml`):

- `Fps` (`Engine.FramesPerSecond`, `Source/Engine/Engine/Engine.h`
  `API_FUNCTION`/`API_PROPERTY GetFramesPerSecond`, `P:FlaxEngine.Engine.
  FramesPerSecond`): frames rendered during the last second. Outside play
  mode this is the editor viewport rendering rate (editor-idle FPS), not
  game FPS. Null unless positive and sane.
- `FrameTimeMs` (`Time.UnscaledDeltaTime * 1000`, `Source/Engine/Engine/
  Time.h` `API_PROPERTY`, `P:FlaxEngine.Time.UnscaledDeltaTime`):
  TimeScale-independent last-frame delta, so `play_set_time_scale` never
  distorts it. Null unless finite, positive, and under 60 s.
- `DrawCalls`/`Triangles` (`ProfilingTools.Stats.DrawStats`,
  `Source/Engine/Profiler/ProfilingTools.h` `API_FIELD(ReadOnly) static
  MainStats Stats` updated every frame, `P:FlaxEngine.ProfilingTools.Stats`
  with `F:...MainStats.DrawStats` of `T:FlaxEngine.RenderStatsData`):
  `ProfilerGPU.GetLastFrameData` was evaluated and rejected — its C++
  `(float&, float&, RenderStatsData&)` refs bind by value in C#
  (`M:FlaxEngine.ProfilerGPU.GetLastFrameData(Single,Single,
  RenderStatsData)` carries no byref markers, and both `out` and `ref`
  fail with CS1615), so managed code cannot receive its outputs.
  `Stats.DrawStats` is the only public managed path to `RenderStatsData`.
  `MainStats` is only populated while the profiler session counts frames,
  so `Stats.FPS` is its own freshness signal, and an all-zero `DrawStats`
  beside `FPS > 0` is self-contradictory (every presented frame issues
  draw calls): it positively means "no valid sample right now", so both
  stay null. Live-verified: a default editor session reports `FPS > 0`
  with zeroed `DrawStats`, so the snapshot honestly returns nulls rather
  than misleading zeros.
  Headless editors render nothing, so both stay null there.
- `ManagedMemoryBytes` (`System.GC.GetTotalMemory(false)`, BCL): no
  induced collection; always available in and out of play.
- `ActorCount` (`Level.GetActors(typeof(Actor), false).Length`,
  `M:FlaxEngine.Level.GetActors(Type,Boolean)`): the same public
  enumeration the bridge validation scans already use; one call, includes
  inactive actors, works in and out of play because editor scenes are
  loaded levels.
- `GpuAdapter` (`GPUDevice.Instance.Adapter.Description`,
  `Source/Engine/Graphics/GPUDevice.h` `API_PROPERTY GetAdapter` plus
  `GPUAdapter.h` `API_PROPERTY GetDescription`,
  `P:FlaxEngine.GPUDevice.Instance` / `P:FlaxEngine.GPUAdapter.
  Description`, capped at 256 chars) and `RendererType`
  (`GPUDevice.Instance.RendererType`, `API_PROPERTY GetRendererType`,
  `P:FlaxEngine.GPUDevice.RendererType`). Headless editors have no GPU
  device, so both stay null without throwing.
- `IsPlayMode` (`FEditor.IsPlayMode`, the same flag `status` reports) and
  `TimestampUnixMs` (`DateTimeOffset.UtcNow`, always present).
## Bridge v26: play-mode input simulation (managed-API-only scope)

Bridge v26 keeps protocol v1 and the full v25 surface. It adds
`input.key_press` and `input.mouse_click`, one input event per call (a single
key press OR a single click). `status` adds `InputSimulationSupported:true`.
Node exposes `input_key_press` and `input_mouse_click` (runtime family),
requires bridge v26 for both, and reports `inputSimulation` in
`get_server_capabilities`.

The request DTOs are `McpKeyPress { Key, HoldMs }` and `McpMouseClick
{ Button, X, Y, HoldMs }` (PascalCase on the wire: `{ "Key": "W",
"HoldMs": 50 }`, `{ "Button": "Left", "X": 0.5, "Y": 0.5, "HoldMs": 50 }`).
`Key` must parse to a `FlaxEngine.KeyboardKeys` member (case-insensitive,
1–64 characters, names only — numeric strings rejected; `None`/`MAX`
rejected) with `VALIDATION_FAILED` otherwise. `Button` defaults to `Left`
and must be `Left`/`Right`/`Middle` (`VALIDATION_FAILED` otherwise).
`X`/`Y` must be finite viewport-normalized coordinates in `[0,1]`
(`VALIDATION_FAILED` outside). `HoldMs` defaults to 50 and must be within
0..2000 (`VALIDATION_FAILED` outside). Both calls require running,
unpaused play (`INVALID_STATE` when not playing or paused — key presses
while paused do nothing in Flax, mirroring the `play.pause` gate shape;
headless needs no separate gate because play cannot start headless).

Managed-API-only scope (verified, not inferred): Flax 1.12 exposes no
managed key/button injection primitive. `FlaxEngine.Input` offers only read
state (`GetKey`/`GetKeyDown`/`GetKeyUp`, `GetMouseButton*`, `GetAction*`)
plus engine-raised events (`KeyDown`/`KeyUp`/`MouseDown`/`MouseUp`) that C#
cannot raise (verified: `Keyboard.OnKeyDown`/`Mouse.OnMouseDown` carry no
`API_FUNCTION` and are absent from `FlaxEngine.CSharp`, and raising
`Input.KeyDown` from outside fails compilation — see `Source/Engine/Input`
headers and the shipped `FlaxEngine.CSharp.xml`). No Simulate/Inject input
API exists anywhere under `Source/Engine/Input` or `Source/Editor`. The
only managed-verified cursor primitive is the `Input.MousePosition` setter,
which moves the cursor but cannot press buttons, and viewport-normalized
mapping has no verified managed game-viewport-rect API in play-in-editor.
OS-level injection (`SendInput`/user32 P/Invoke, child processes, every
other unmanaged escape) stays forbidden, so the bridge performs no partial
click: after gates and validation both methods report a stable
`UNSUPPORTED_FLAX_VERSION` capability (`input_key_press`/`input_mouse_click`
with the bridge version in details), the same pattern as
`navigation.build`/`lighting.bake`. `HoldMs` is still validated so the
contract is stable for a future managed primitive; the intended release
design is a `Scripting.Update` frame countdown (already subscribed) — never
blocking the main thread — with guaranteed release even if the caller
disconnects.
## Bridge v25: canonical scene open

Bridge v25 keeps protocol v1 and the full v24 surface. It adds
`scene.open`, a canonical Content scene opener backed by the verified public
Flax 1.12 `FlaxEngine.Level.LoadSceneAsync(Guid)` API (see
`FlaxEngine.CSharp.xml` `M:FlaxEngine.Level.LoadSceneAsync(Guid)` and
`Source/Engine/Level/Level.h` `API_FUNCTION() static bool
LoadSceneAsync(const Guid& id)` — background load, returns true only when
loading cannot be done). Node exposes `scene_open` (scene family), requires
bridge v25, and reports `sceneOpen` in `get_server_capabilities`.

The request DTO is `McpSceneOpen { AssetId, Path, AllowDirtyScenes }`
(PascalCase on the wire: `{ "AssetId": "<32-hex>" }` or `{ "Path":
"Content/Levels/Arena.scene", "AllowDirtyScenes": true }`). Exactly one of
`AssetId` (32-hex GUID) or `Path` (`Content/...`, no traversal) is required
— the same selector convention as `asset.get` — resolved through the
existing Content registry. The selected asset must verify as
`FlaxEngine.SceneAsset`, otherwise the call fails with `ASSET_NOT_FOUND`.

The scene load is async: a started load returns `McpSceneOpenResult
{ SceneId, Phase:"opening" }` immediately and the caller polls
`scene.list_loaded` until the scene appears (documented; the bridge never
blocks). An already-loaded scene ID returns it with Phase
`"already_loaded"` as a no-op success without touching the editor.

Safety gates (all hold unconditionally, including the no-op path): play mode
or a requested play start fails with `INVALID_STATE`; compiling/reloading
scripts fails with `EDITOR_BUSY` (the same
`ScriptsBuilder.IsCompiling||!IsReady` check the scene-save path uses);
any active bridge edit lease fails with `EDIT_LEASE_ACTIVE` (the same lease
table check play start uses, with active-lease details); edited loaded
scenes fail with `DIRTY_SCENE` listing the dirty scene names unless
`AllowDirtyScenes:true` is explicit (mirroring the play-start
`AllowDirtyScenes` gate convention, which uses `VALIDATION_FAILED` there).
`status` adds `SceneOpenSupported:true`.

## Bridge v24: editor selection

Bridge v24 keeps protocol v1 and the full v23 surface. It adds
`editor.get_selection` and `editor.set_selection`, an edit-time selection
surface backed by the verified Flax 1.12 `SceneEditingModule` API
(`FlaxEngine.CSharp.xml` `F:FlaxEditor.Modules.SceneEditingModule.Selection`
— a public `List<SceneGraphNode>` — plus `Select`/`Deselect`; actor mapping
via `ActorNode.Actor` and `SceneModule.GetActorNode`, all verified by
reflection against the shipped `FlaxEngine.CSharp.dll`).

`editor.get_selection` takes no parameters and returns `McpSelectionResult
{ Selection: McpSelectionEntry[] { ActorId, Name, SceneId }, Count }`,
bounded to 200 entries in selection order. Only `ActorNode` entries with a
live actor are reported. An empty selection is valid and returns an empty
list, not an error. It works outside play mode.

`editor.set_selection` takes `McpSelectionRequest { ActorIds, FocusViewport
}` (PascalCase on the wire: `{ "ActorIds": ["..."], "FocusViewport": true
}`). `ActorIds` must contain 1–200 32-hex GUIDs (`VALIDATION_FAILED`
outside that range, `INVALID_REQUEST` for malformed IDs); each ID is
resolved with the existing `RequireActor` helper (`NOT_FOUND` for unknown
actors). Every actor resolves before any mutation, so unknown IDs fail
without changing the current selection; duplicates collapse to one entry.
The replacement uses the verified `Select(nodes, additive:false)` path, and
the new selection is returned in the same shape as get. Optional
`FocusViewport` (default false) frames the `EditWin` viewport on the new
selection via the verified `MainEditorGizmoViewport.FocusSelection()` (a
single-actor selection frames exactly that actor); a missing editor window
fails with `INVALID_STATE` before mutating. No play-mode gating applies
(selection is an edit-time concept), but both calls are meaningless
headless and fail with `INVALID_STATE`. `status` adds
`EditorSelectionSupported:true`. Node exposes `editor_get_selection`
(read family) and `editor_set_selection` (scene family), requires bridge
v24 for both, and reports `editorSelection` in `get_server_capabilities`.

## Bridge v23: play time scale

Bridge v23 keeps protocol v1 and the full v22 surface. It adds
`play.set_time_scale`, a bounded play-mode mutation backed by the public
Flax 1.12 `FlaxEngine.Time.TimeScale` property (float, get/set; default 1 —
verified via `Source/Engine/Engine/Time.h` `API_FIELD() static float
TimeScale` and `FlaxEngine.CSharp.xml` `P:FlaxEngine.Time.TimeScale`
`[Unmanaged] { get; set; }`).

The request DTO is `McpTimeScaleRequest { TimeScale }` (PascalCase on the
wire: `{ "TimeScale": 0.25 }`); the result reuses the existing
`McpPlayStatus` shape returned by `play.status`/`play.pause` so callers keep
one play-state contract. `status` adds `PlayTimeScaleSupported:true`. Node
requires bridge v23 for this tool and reports `playTimeScale` in
`get_server_capabilities`.

Validation: play mode is required (`INVALID_STATE` when not playing, same
code as `play.pause` — this also covers headless editors, where play cannot
start). `TimeScale` must be finite and within 0..10 (`VALIDATION_FAILED`
outside); 0 = frozen is legitimate for frame-step debugging alongside
`play.step`. The bridge never resets the scale on `play.stop`: the value is
engine-global and persists until changed or until play stops (Flax owns play
lifecycle cleanup; always set explicitly after each play start rather than
assuming it survived a stop/start cycle).

## Bridge v22: editor viewport capture

Bridge v22 keeps protocol v1 and the full v21 surface. `capture.start`
accepts a `Viewport` selector: `game`/`main` (default, requires play mode,
captures `MainRenderTask` via `Screenshot.Capture(path)`) or
`editor`/`edit` (captures `EditWin.Viewport.Task` via
`Screenshot.Capture(task, path)`, works outside play mode). Unknown values
fail with `VALIDATION_FAILED`; a missing editor task fails with
`CAPTURE_UNAVAILABLE`. Both scopes remain unavailable in headless mode.
`status` adds `EditorViewportCaptureSupported:true`. Node requires bridge v22
only for the `editor` selector; `game` captures keep working on bridge v6+.

## Bridge v21: AnimationGraph BaseModel binding (Phase 7)

Bridge v21 keeps protocol v1 and the full v20 surface. It adds
`graph.set_model`, dry-run by default with `confirm:true`,
idempotency keys, per-asset leases, and `AssetEditorWindow.Save()` persist.

`graph.set_model` binds one registry `FlaxEngine.SkinnedModel` (exactly one
`ModelAssetId`/`ModelPath`, validated through the generic asset registry —
not the graph scope) as the `FlaxEngine.AnimationGraph` BaseModel (exactly
one graph `AssetId`/`Path`; AnimationGraph assets only). The write path is
the public `AnimationGraphWindow.SetBaseModel`, the read path the public
`AnimationGraph.BaseModel`. The model asset is loaded with the same
`WaitForLoaded` + registry/file ID-guard path as actor model binds, and the
post-write BaseModel is re-read before saving; a mismatch refuses to save.

`AnimationGraphWindow.SetBaseModel` pushes NO undo action (Cecil-verified,
like disconnect/move), so the bind is non-undoable: every response carries
a no-undo warning in the `SaveToOriginal` class — `graph.undo` cannot
restore the previous BaseModel (re-run set_model with the prior model to
revert). Rebinding the already-bound model is refused with
`VALIDATION_FAILED` (idempotent no-op refused), reported on dry-run
previews via `AlreadyBound`. Node clients require bridge v21 for this tool.
## Bridge v20: clip wiring, node values, node move (Phase 6)

Bridge v20 keeps protocol v1 and the full v19 surface. It adds
`graph.set_node_values`, `graph.move_node` (root context only), and
`animgraph.set_state_clip`, all dry-run by default with `confirm:true`,
idempotency keys, per-asset leases, and `AssetEditorWindow.Save()` persist.

`graph.set_node_values` writes 1–32 slots through the public
`SurfaceNode.SetValue(index, value, graphEdited:true)` path, which pushes
`EditNodeValuesAction` — value writes ARE window-undoable. Inputs coerce per
slot: the live slot type first, the archetype default slot type second,
float for typeless numbers last; `asset_id` inputs must be 32-hex IDs of
assets present in the project registry (dangling references fail closed).

`graph.move_node` sets the public `Control.Location`. The setter pushes no
undo action, so moves warn like disconnects.

`animgraph.set_state_clip` resolves the machine and the named state, opens
the state sub-context, spawns the `(9,2)` sampler from archetype defaults
when missing, assigns slot 0 (the clip; shape-inferred from
`DefaultValues=[null, 1, 1, 0]` and runtime-verified by re-read), and wires
the sampler Pose output to the `(9,21)` State Output input through the
public `Box.CreateConnection` path (verified both directions; pushes no undo
action, warned). All archetype IDs and box choices resolve at runtime — no
hardcoded layouts. Node clients require bridge v20 for these three tools.

## Bridge v19: read-only sub-context inspection (Phase 6a)

Bridge v19 keeps protocol v1 and the full v18 surface. It extends
`graph.inspect` with `IncludeSubcontexts` (default false — legacy reads are
byte-identical) plus `MaxDepth` (1–5). Each returned context carries
`OwnerNodeID`, the root-relative node `Path`, `Depth`, and its own
`Nodes[]`/`Boxes[]`/`Parameters[]` under the same bounds as the root read
(`Limit` nodes per context, 32 values per node, 64 boxes per node, safe-typed
value projection). IL-verified correction: `FindContext(path)` only reads the
surface context cache and cannot see never-opened contexts, so discovery
navigates with `OpenContext(path)` (which materializes via `CreateContext` +
`Load` without touching asset data) under before/after stack balancing, then
restores the entry view. Reused user windows may briefly flicker and fire
`ContextChanged`, but nothing is marked edited and nothing is ever saved —
the op stays read-only. Child paths extend the parent path with the child's
`OwnerNodeID`; traversal is depth-bounded and cycle-guarded, and the
existing 512 KiB response cap still fails large graphs closed. Node clients
request bridge v19 only when the flag is set; flag-off reads keep working on
bridge v16+.

## Bridge v18: bounded graph removal (Phase 5ab)

Bridge v18 keeps protocol v1 and the full v17 surface. It adds the removal
pair `graph.remove_node` + `graph.disconnect`, scoped to the graph root
context only (sub-contexts stay Phase 6a). No new hardcoded archetype IDs or
layouts: every check is read at runtime from the live objects.

`graph.remove_node` deletes one root node through the public
`VisjectSurface.Delete(IEnumerable<SurfaceControl>, withUndo:true)` path,
which is Cecil-verified undo-aware (pushes `AddRemoveNodeAction` +
`EditNodeConnections`), so the removal IS restorable via `graph.undo` while
the window undo stack retains it. Fail-closed guards: `NoRemove`-flagged
nodes (read at runtime from `NodeArchetype.Flags`, e.g. graph outputs) and
the sole remaining root node are refused with `VALIDATION_FAILED`; if the
node survives `Delete`, nothing is saved.

`graph.disconnect` breaks one output-to-input wire through the public
`Box.BreakConnection(Box)` path (verified both directions, then re-checked).
`BreakConnection`/`RemoveConnections` push NO undo action and do not mark
edited (Cecil-verified IL): the bridge marks modified/edited itself, persists
via `AssetEditorWindow.Save()`, and every response carries a no-undo warning
in the `SaveToOriginal` class — `graph.undo` cannot restore a broken wire.
Missing endpoints, same-direction endpoints, and already-disconnected boxes
fail closed (`NOT_FOUND` / `VALIDATION_FAILED`, idempotent no-op refused).
Boxes resolve by scanning `TryGetBox` matching `Box.ID`, mirroring
`graph.inspect`. Node clients require bridge v18 for these two tools.

## Bridge v17: bounded AnimGraph state-machine macros

Bridge v17 keeps protocol v1 and the full v16 surface. It adds two additive-only
AnimGraph macros gated by a Cecil-verified Flax 1.12 group-9 allowlist
(StateMachine=(9,18), State=(9,20); Entry=(9,19) and State-Output=(9,21) are
engine auto-ensured, Transition=(9,23), Any=(9,34)).

`animgraph.add_state` spawns one `(9,20)` state node inside the graph's state
machine context (creating the `(9,18)` container from archetype defaults when
missing), with the name stored in the archetype-cloned values — never hardcoded
value arrays. `animgraph.add_transition` connects two states through the public
`IConnectionInstigator.Connect` path (the same flow as an editor drop-connect,
including native undo recording) with default rule data and no rule graph, after
a runtime `CanConnectWith` gate. Both ops are dry-run by default, require
`confirm:true`, honor idempotency keys and per-asset edit leases, persist via
`AssetEditorWindow.Save()`, and reuse the v16 readiness/retry contract
(`IsLoaded` + `Surface.Enabled`, `INVALID_STATE` + `details.NotReady`).
State clip wiring (sampler inside the state sub-context) is out of scope:
states are created empty and the schema accepts no clip field. Node clients
require bridge v17 for these two tools (`GraphTopologyWriteSupported`,
`AnimgraphStateWriteSupported`, `AnimgraphTransitionWriteSupported`).

## Bridge v16: window-backed Visject node-graph editing

Bridge v16 keeps protocol v1. It adds a window-backed Visject surface for
`FlaxEngine.AnimationGraph`, `FlaxEngine.Material`, and
`FlaxEngine.ParticleEmitter` assets only. VisualScript, BehaviorTree,
MaterialInstance, and Function assets are rejected even though they share
`IVisjectSurfaceWindow`, because their windows do not inherit
`VisjectSurfaceWindow`3. Direct `.flax` byte edits are forbidden and the
headless `SaveSurface(byte[])` path is never used for writes.

`graph.inspect` is read-only. It reuses an already-open editor window or
opens the asset SHOWN (visible tab), reads `Surface.Nodes`,
`Surface.Parameters`, and per-node boxes via `TryGetBox` (connections are
reported as `nodeID:boxID` pairs through the public `Box.ParentNode`), then
closes the window only when the bridge opened it. Node identity is the
`UInt16` groupID + typeID pair; values are a bounded safe projection.
Opening shown is mandatory, not a preference: a hidden (`disableAutoShow`) window never
loads and its surface stays blank forever (behavior-grounded: 7/7 hidden-open
reads returned blank surfaces; consistent with upstream source, unverified
against this 1.12 binary build).

Readiness contract (behavior-grounded): `VisjectSurfaceWindow.LoadSurface()`
runs in a later `Update()` frame and enables the surface only in
`OnSurfaceEditingStart()`, so a same-tick read after `Open()` always
sees a blank surface. The bridge therefore gates every graph operation on
`IVisjectSurfaceWindow.VisjectAsset.IsLoaded` AND `VisjectSurface.Enabled`
(all in-scope windows construct their surface disabled), fails fast with
`ASSET_OPERATION_FAILED` when `LastLoadFailed`, keeps a bridge-opened
window open across not-ready attempts, and reports `INVALID_STATE`
with `details = { NotReady: true, RetryAfterMs: 1500, ... }` (a named
field-based DTO: `FlaxEngine.Json` drops anonymous-type properties to
`{}`, which would silently disable client retries). Node clients
auto-retry not-ready responses (6 attempts max, honor `RetryAfterMs`
clamped to 250–5000 ms) instead of hand-pumping retries. Bridge-owned
windows are tracked per asset ID, closed after the operation
completes, and swept when stale (>120 s); user-opened windows are reused
and always left open.

`graph.set_default_parameter` persists one surface default value through the
public window path (`SurfaceParameter.Value` plus `OnParamEdited` and
`MarkAsEdited`, then `AssetEditorWindow.Save()`). It is dry-run by default
and requires `confirm: true` for a real save. `graph.add_parameter` is the
only bounded additive macro: it appends one parameter whose type must appear
in the window's own `NewParameterTypes` allowlist. Node spawn, wire
connect/remove, and state/transition macros remain unavailable. Every save
goes through `SaveToOriginal` internally and cannot be undone afterwards;
`graph.undo` only reverts unsaved steps on the window-local undo stack and is
separate from the global `edit.undo`.

## Local-only surfaces (vắng mặt ở canonical installer)

| Method | Lives on | Node tool | Notes |
|---|---|---|---|
| `mm.tuning` / `mm_apply_preset` | local dev bridge | `mm_tuning`, `mm_apply_preset` | Missing method answers `METHOD_NOT_ALLOWED` → shared mapper reports `UNSUPPORTED_FLAX_VERSION` with capability hint. |

Capability checks must use the `*Supported` status flags (e.g.
`GraphSetModelSupported`, `ScriptFieldValuesReadSupported`,
`SceneOpenSupported`), never the bare version number: the flax-test local
bridge advertised `BridgeVersion = 21` for its experimental `scene.open`
while canonical v21 means `graph.set_model` — the same number named two
different capability sets. Canonical v25+ ships `scene.open` (`scene_open`
in Node); older canonical installers answer that method with
`METHOD_NOT_ALLOWED`. The canonical installer does not ship the row above,
so a stock editor answers that method with `METHOD_NOT_ALLOWED`.

## Bridge v28: bounded script/component property write

Bridge v28 keeps protocol v1 and the full v27 surface. It adds
`script.instance_set_value` and `actor.set_property`, both edit-time only:
headless editors fail with `INVALID_STATE` (editor ops) and play mode (or
a requested play start) fails with `INVALID_STATE`, mirroring the
`scene.open` gate shape. Both accept the v7 `ExpectedSceneRevision` and
`LeaseId` guards via `CheckSceneWrite` plus `IdempotencyKey` (ten-minute
replay, `IDEMPOTENCY_KEY_REUSED` on key reuse with different input).
`status` adds `ScriptFieldWriteSupported:true` and
`ActorPropertyWriteSupported:true`. Node exposes `script_instance_set_value`
and `actor_set_property` (scene family), requires bridge v28 for both, and
reports `scriptFieldWrite`/`actorPropertyWrite` in
`get_server_capabilities`. `arbitrarySerializedScriptProperties` stays
`false`: every write below is allowlisted or strictly coerced, never an
arbitrary serialized blob.

The `ScriptMemberInfo` decision (verified, not inferred): arbitrary
script-field write has exactly one public setter — the reflection-backed
`FlaxEditor.Scripting.ScriptMemberInfo.SetValue(obj, value)`
(`M:FlaxEditor.Scripting.ScriptMemberInfo.SetValue(System.Object,
System.Object)`), the exact wrapper the Editor property grid uses via
`ValueContainer`. There is no typed `SetBool`/`SetFloat`/… overload.
The bridge therefore resolves the field with the same hierarchy walk as
the P7 read surface (`GetField(name, Public|Instance|DeclaredOnly)`,
most-derived first), wraps it in `new ScriptMemberInfo(field)`, and reads
via `GetValue` / writes via `SetValue`. The v9 contract test asserting no
raw `PropertyInfo.SetValue` is kept (still no raw reflection on game
objects); the v28 contract test allowlists `ScriptMemberInfo.SetValue` as
the ONLY reflection-backed setter call in the bridge. Spot-verified SDK
surface (`FlaxEngine.CSharp.xml`): `ScriptMemberInfo(MemberInfo)`,
`GetValue`/`SetValue`, `HasSet`, `ValueType` (a `ScriptType` unwrapped via
`.Type`), `ScriptType.GetField(name, flags)`; `Undo.RecordAction`,
`Undo.AddAction`, `IUndoAction`; `SceneModule.MarkSceneEdited` (already
used as `FEditor.Instance.Scene.MarkSceneEdited`); direct typed setters
`Light.Color`, `Light.Brightness`, `Camera.FieldOfView`,
`StaticModel.Model`, `Script.Enabled`. Probe correction: Flax 1.12
`Light` has no `Intensity` property, so the allowlist carries
`Light.Brightness` instead.

`script.instance_set_value` takes `McpScriptFieldSet { ScriptId, Field,
Bool?, Number?, Text, DryRun, ExpectedSceneRevision, LeaseId,
IdempotencyKey }` (Node splits its `bool|number|string` union into
exactly one of `Bool`/`Number`/`Text`). `Field` is 1–128 chars matching
`^[A-Za-z_][A-Za-z0-9_]*$`. Static, non-public, no-setter
(`!HasSet`, init-only, literal), and unsupported-type fields fail with
`VALIDATION_FAILED` carrying a reason in the `script_instance_get` reason
style. The whitelist is bool/int/float/string/enum/Guid/Vector2/Vector3/
Vector4/Color (both `Vector*` and `Float*` spellings coerce to the field's
actual type). Coercion is strict: bool needs JSON bool; int needs an
integral finite number in target range; float needs a finite number in
range; string needs a string (max 4096 chars); enum needs a name
(case-insensitive `Enum.Parse`) or a defined numeric value; Guid needs a
32-hex string; vectors need `"x,y[,z[,w]]"` with finite invariant floats;
Color needs `"#rrggbb[aa]"` or `"r,g,b[,a]"`. Anything else fails with
`VALIDATION_FAILED` — never a silent default. `DryRun:true` reads the
current value via `GetValue` first and returns `WouldChange` plus
`Before`/`After` projections without writing, advancing no revision, and
never consuming an idempotency key. A real write applies through
`McpScriptFieldUndo` (an `IUndoAction` mirroring `McpScriptEnabledUndo`:
script re-resolved by ID, field re-resolved by name, `MarkSceneEdited` on
apply), registered with `Undo.AddAction`, then `MarkSceneEdited` and a
scene-revision advance. The result echoes `Before`/`After` plus both
revisions, so callers verify without saving.

`actor.set_property` takes `McpActorPropertySet { ActorId, Property,
Bool?, Number?, Text, ExpectedSceneRevision, LeaseId, IdempotencyKey }`.
`Property` must exactly equal one allowlist entry — `Light.Color`,
`Light.Brightness`, `Camera.FieldOfView`, `StaticModel.Model`,
`Script.Enabled` — with no dotted-path parsing; anything else fails with
`VALIDATION_FAILED` listing the allowlist. Each entry runs a direct typed
setter inside `Undo.RecordAction` (the `UpdateActor` pattern) plus
`MarkSceneEdited`: `Light.Color` (actor must be `FlaxEngine.Light`,
Text color), `Light.Brightness` (number >= 0), `Camera.FieldOfView`
(number in 0–180 exclusive), `StaticModel.Model` (32-hex model asset GUID
only, loaded and registry/file-ID-verified like `actor.update`),
`Script.Enabled` (a script GUID, same typed setter and
`McpScriptEnabledUndo` path as `script.instance_update`). The result
carries `Before`/`After` projections and, for actor targets, the updated
`ActorDto`, so callers verify and undo without saving. Bogus script/actor
IDs fail with `NOT_FOUND` via the existing `RequireScript`/`RequireActor`
helpers.

## Bridge v29: bounded material write/create/assign

Bridge v29 keeps protocol v1 and the full v28 surface. It replaces the
stable-unsupported material stubs (`material.set_parameters`,
`material.create_instance`, `material.assign_to_actor`) with real
edit-time-only implementations: headless editors fail with
`INVALID_STATE` (editor ops) and play mode (or a requested play start)
fails with `INVALID_STATE`, mirroring the v28 `RequireEditTime` gate.
`status` flips `MaterialParameterWriteSupported`,
`MaterialInstanceCreationSupported`, and `MaterialAssignmentSupported` to
`true`. Node requires bridge v29 for all three tools and reports
`material.setParameters`/`createInstance`/`assignToActor` in
`get_server_capabilities`. Animation graph writes
(`animation.set_graph_parameter`) stay a stable `UNSUPPORTED_FLAX_VERSION`
capability.

SDK truth (Flax 1.12, spot-verified against `Source/` headers plus the
shipped `FlaxEngine.CSharp.xml`): `ModelInstanceActor.SetMaterial(entryIndex,
material)` is `API_FUNCTION` public (`Source/Engine/Level/Actors/
ModelInstanceActor.h:79`); slots are serializable (`Entries`) and persist
via `SceneModule.MarkSceneEdited` + `Level.SaveScene`; there is NO
dedicated slot undo action, so assignment composes the generic
`Undo.RecordAction` path. `Content.CreateVirtualAsset<T>` is public
(generic plus `Type` overloads) and `Asset.Save(path)` is public
(`Source/Engine/Content/Asset.h:240`, "Must be specified when saving
virtual asset"). `MaterialBase.SetParameterValue(name, value,
warnIfMissing)` and `GetParameterValue(name)` are public
(`Source/Engine/Content/Assets/MaterialBase.h:63-71`); durability goes
through `Asset.Save`, and because the byte-level save path is
headers-only in the SDK, every write proves durability by unloading the
asset and reloading it from disk before reporting `Verified:true`.
`MaterialParameterType` is an enum (`Bool`, `Integer`, `Float`,
`Vector2/3/4`, `Color`, `Texture`, `CubeTexture`, `NormalMap`, plus
unsupported `Matrix`/GPU/scene/global kinds); `MaterialInstance.
BaseMaterial` is get/set.

`material.set_parameters` takes `McpMaterialSetParametersRequest {
AssetId, Path, Parameters[1..16] { Name, Bool?, Number?, Text },
DryRun, Confirm, IdempotencyKey }`. The target must be a registry
`FlaxEngine.Material` or `FlaxEngine.MaterialInstance`; names must exist
(`GetParameter` miss fails `VALIDATION_FAILED` with up to 32 available
names; duplicates fail too). Coercion is strict per `ParameterType`:
Bool needs JSON bool; Integer needs an integral finite number in Int32
range; Float needs a finite number in float range; Vector2/3/4 need
`"x,y[,z[,w]]"` invariant floats (applied as `Float2/3/4`); Color needs
`"#rrggbb[aa]"` or `"r,g,b[,a]"`; Texture/CubeTexture/NormalMap need a
32-hex asset GUID that resolves in `Content.GetAssetInfo`. Anything else
fails `VALIDATION_FAILED` — never a silent default. Values apply via
`SetParameterValue(name, value, warnIfMissing:true)` with full in-memory
revert on any failure (nothing is saved on the failure path), then a
bridge-owned `McpMaterialParametersUndo` snapshot action is registered
with `Undo.AddAction`, then `Asset.Save()`, then unload +
`Content.Load` reload with per-value comparison (`Verified:true` only on
a full match; epsilon 1e-6 for float/vector/color components, asset-ID
comparison when a texture read projects the loaded `Asset` instead of
its GUID). A save failure reverts memory and throws
`ASSET_OPERATION_FAILED`; a reload mismatch throws
`ASSET_OPERATION_FAILED` with `{ Verified:false }` details. Undo
honesty: this is a generic snapshot action (values re-applied plus
`Asset.Save`, failures logged never thrown), NOT the editor
`MaterialInstanceWindow` action, which requires an open material window
and is not bridge-usable — every result warning says so. Real writes
need `confirm:true`; dry runs validate/coerce and preview without
mutating, advancing no revision and never consuming an idempotency key.
Asset-scoped writes take no scene lease (same precedent as v10 asset
organization); retry safety comes from `IdempotencyKey` (ten-minute
replay, `IDEMPOTENCY_KEY_REUSED` on key reuse with different input).

`material.create_instance` takes `McpMaterialCreateInstanceRequest {
AssetId, Path, DestinationPath, DryRun, Confirm, IdempotencyKey }`. The
base must be exactly `FlaxEngine.Material` (instances as bases are
rejected); the destination must be a `Content/.../*.flax` file path and
is never overwritten — both `Content.GetAssetInfo(destination)` and
on-disk presence fail with `FILE_EXISTS`. The write creates
`Content.CreateVirtualAsset<MaterialInstance>()`, binds `BaseMaterial`,
creates missing parent folders under Content, and persists with
`Asset.Save(absoluteDestination)`, returning the new asset GUID. Like
v10 asset organization there is no verified Editor undo record for
creation; warnings direct callers to `asset_delete` (quarantine) for
cleanup, and note the Content-database scan is asynchronous (one
registry rebuild confirms the common case; otherwise the result carries
a poll-`asset_get` warning).

`material.assign_to_actor` takes `McpMaterialAssignRequest { AssetId,
Path, ActorId, Slot 0..255, DryRun, Confirm, IdempotencyKey,
ExpectedSceneRevision, LeaseId }`. The actor must cast to
`FlaxEngine.ModelInstanceActor` (`StaticModel`, `AnimatedModel`,
`SkinnedModel`, or another subtype — anything else fails
`VALIDATION_FAILED` naming the actual `TypeName`); the slot is bounds-
checked against `MaterialSlots.Length` (`VALIDATION_FAILED` reporting
the valid `0..count-1` range). Scene-scoped `CheckSceneWrite` guards
(revision + lease, like other scene writes) apply alongside idempotency.
The write runs `SetMaterial(slot, material)` inside
`Undo.RecordAction(actor, "Assign material", ...)` plus `MarkSceneEdited`
(the composed generic path — no dedicated slot action exists), advances
the scene revision, and verifies `GetMaterial(slot)` reports the assigned
ID. The scene is marked edited, never saved (`scene_save` persists it);
the result reports `SceneEdited`, both revisions, and before/after
material metadata.

## Bridge v30: prefab override diff/revert/apply/break

Bridge v30 keeps protocol v1 and the full v29 surface. It replaces the
stable-unsupported prefab stubs (`prefab.get_overrides`,
`prefab.revert_overrides`, `prefab.apply_overrides`, `prefab.break_link`)
with real implementations. `status` flips `PrefabOverridesSupported`,
`PrefabApplyOverridesSupported`, `PrefabRevertOverridesSupported`, and
`PrefabBreakLinkSupported` to `true` (keeping
`PrefabWorkflowsSupported`). Node requires bridge v30 for all four tools
and reports `prefab.overrides/applyOverrides/revertOverrides/breakLink`
in `get_server_capabilities`. Tool names and the 147-tool contract are
unchanged.

SDK truth (Flax 1.12, spot-verified against the shipped
`FlaxEngine.CSharp.xml`; Editor C# sources are not shipped with the SDK):
introspection and link APIs are public — `Actor.IsPrefabRoot/
GetPrefabRoot`, `SceneObject.HasPrefabLink/PrefabID/PrefabObjectID`,
`Prefab.GetDefaultInstance()/GetNestedObject()`,
`SceneObject.BreakPrefabLink()`, `PrefabManager.SpawnPrefab/CreatePrefab/
ApplyAll`. Verified ABSENT (0 hits in XML and `Source/`): `ApplySingle`,
`GetPrefabObjectIds`, and any per-property diff/revert enumerator.
`BreakPrefabLinkAction` documents undo/redo (`BreakLinks` supports
undo/redo) but the type itself is internal, so the bridge invokes its
documented public `Break(Actor)` factory via reflection (same precedent
as the internal `AddRemoveScript` factory) and runs Do/AddAction through
`IUndoAction`. Apply has no reviewed undo record. `PrefabsModule.
OpenPrefab(Guid)` is public but opens an editor window with no verified
headless-safe or close/save-stage API, so no open-stage tool is exposed.

Honesty notes (also repeated in every result warning):

- Diff is synthesized, not the engine diff: `prefab.get_overrides`
  walks the live instance subtree (capped at 200 actors) and compares
  each linked actor against its `Prefab.GetDefaultInstance()` default
  using the same value semantics as the read projections
  (bool/int/float/string/enum/Guid/Vector/Color, epsilon 1e-6 for
  floats). Only `Name`, `IsActive`, `LocalPosition`, `LocalScale`,
  `LocalEulerAngles`, and `Layer` are compared; scripts and all other
  properties are out of scope. Entries are `{ ActorId, Path, Property,
  InstanceValue, PrefabValue }` (capped at 200, `Truncated` flag).
  Nested prefabs resolve per actor through its own `PrefabID`, with
  `GetNestedObject` linkage annotated when available. Unlinked actors
  return `HasPrefabLink:false` with no entries instead of an error.
- Revert is copy-default, not an engine revert: `prefab.
  revert_overrides` takes 1-32 `ActorIds` from a single loaded scene
  and copies the six diff properties from prefab defaults into each
  listed actor (no cascade — list children explicitly; no per-property
  revert — a follow-up). Dry-run previews; a real write needs
  `confirm:true`, runs each actor inside `Undo.RecordAction("Revert
  prefab overrides", ...)` plus `MarkSceneEdited` (revertible with
  `edit_undo`), re-verifies, and advances the scene revision.
- Apply is whole-instance only: Flax exposes no `ApplySingle`, so
  `prefab.apply_overrides` calls `PrefabManager.ApplyAll(actor)`,
  which saves the prefab asset and synchronizes active instances. A
  real write needs `confirm:true` and returns the pre-apply diff as
  `BeforeSnapshot` for manual inspection — the asset save cannot be
  undone by `edit_undo`.
- Break is undoable: `prefab.break_link` breaks one actor's link via
  the reflected `BreakPrefabLinkAction` factory (`Do` + `Undo.
  AddAction`) plus `MarkSceneEdited`. Dry-run previews; a real write
  needs `confirm:true` (consistent with all other destructive bridge
  tools even though undo exists) and is revertible with `edit_undo`.
  Breaking an unlinked actor fails closed (`VALIDATION_FAILED`).

All three mutations are idempotent (`IdempotencyKey`, ten-minute
replay) with dry-run previews that never consume a key, honor
`ExpectedSceneRevision`/`LeaseId` via `CheckSceneWrite`, and refuse
play mode, script compilation, and reload via the v12
`EnsurePrefabEditorReady` gate (headless reads/writes stay allowed, as
with the rest of the prefab surface).

## Bridge v31: foliage/navmesh/bake/probe writes (terrain stays a stub)
Bridge v31 keeps protocol v1 and the full v30 surface. It replaces the
stable-unsupported `navigation.build`, `lighting.bake`, and
`environment_probe.bake` stubs with real implementations (tool names
unchanged) and adds three tools — `terrain_paint`,
`foliage_add_instances`, `foliage_remove_instances` — for a 150-tool
contract. `status` flips `NavigationBuildSupported`,
`LightingBakeSupported`, `FoliageInstanceWriteSupported`, and
`EnvironmentProbeBakeSupported` to `true` and adds explicit
`TerrainPaintSupported:false`. Node requires bridge v31 for all six
tools and reports `navigationBuild`/`lightingBake`/
`environmentProbeBake`/`foliageInstanceWrite` (plus hard-`false`
`terrainPaint`) in `get_server_capabilities`. The three renamed stubs
stay in the runtime permission family; the three new tools are in the
scene family (scene-edit profile).

SDK truth (Flax 1.12, spot-verified against `Source/` headers plus the
shipped `FlaxEngine.CSharp.xml`; every new call site is additionally
compile-probed by `test/flax-api-smoke/BridgeCompileSmoke.csproj`):

- Foliage: `Foliage.AddInstance(ref FoliageInstance)` is `API_FUNCTION`
  (`Source/Engine/Foliage/Foliage.h:98`), with `RemoveInstance` (:104),
  `RebuildClusters` (:131), and `UpdateCullDistance` (:136).
  `FoliageInstance.Transform` is local-space relative to the foliage
  actor; bounds/random are recalculated by the engine. Undo uses the
  public `FlaxEditor.Tools.Foliage.Undo.EditFoliageAction(Foliage)` plus
  `RecordEnd()` — direct construction, no reflection. Rotations are
  pitch/yaw/roll degrees via `Quaternion.Euler`.
- Navmesh: `Navigation.BuildNavMesh` overloads (`Navigation.h:104,113`)
  are public async ThreadPool work; `IsBuildingNavMesh` (:91) and
  `NavMeshBuildingProgress` (:96) are the poll pair; `Navigation.h`
  contains zero cancel hits. Requests enqueue until the next
  game-scripts update. No `SaveNavMesh` member exists anywhere in the
  XML, so no save is claimed or performed.
- Lightmaps: `Editor.BakeLightmapsOrCancel` is a parameterless toggle
  (start when idle, cancel when running); progress arrives as
  `LightmapsBakeProgress(step, stepProgress, totalProgress)` and
  completion as `LightmapsBakeEnd(failed)`, where `failed:true`
  conflates bake failure and cancellation.
- Probes: `EnvironmentProbe.Bake(float)` (`EnvironmentProbe.h:134`) and
  `SkyLight.Bake(float)` (`SkyLight.h:92`) run as async graphics tasks;
  the float is a seconds "startup time" allowance, not a bake duration.
  Completion is observed via `Actor.HasContentLoaded`; no percent
  progress and no cancel API exist.
- Terrain (blocked): `TerrainPatch.ModifyHeightMap/ModifyHolesMask/
  ModifySplatMap` are sync `API_FUNCTION`
  (`TerrainPatch.h:287,296,306`) and `TerrainTools` exposes
  `Modify*`/`Get*Data` wrappers — but every data accessor returns a raw
  `float*`/`byte*`/`Color32*`, which safe managed bridge code cannot
  touch (CS0214 without an `unsafe` context, and Flax script compilation
  is not verified to allow `unsafe`), and
  `EditTerrainHeightMapAction/EditTerrainHolesMapAction/
  EditTerrainSplatMapAction` are internal editor types with no public
  factory (CS0122; only non-public reflection could reach them, beyond
  this repo's public-factory precedent). `terrain.paint` therefore keeps
  its name, enforces the full rect contract Node-side, passes the
  edit-time gate, and reports stable `UNSUPPORTED_FLAX_VERSION`.
  Unblocking needs a live editor: either verify `unsafe` survives Flax
  script compilation, or bind a managed path and prove the undo restore.

Honesty notes (also repeated in result warnings):

- Foliage batches are capped at 200 instances per call with no
  progress/cancel on `RebuildClusters` — one `RebuildClusters` plus
  `UpdateCullDistance` runs after each batch. Adds validate every
  transform before touching undo; removes validate against the live
  count, reject duplicates, and remove highest-first. Each call is one
  `EditFoliageAction` undo step plus `MarkSceneEdited` (revertible with
  `edit_undo`); scenes are never saved. Positions are local-space, which
  callers must account for.
- Navmesh `navigation.build` starts the build on the main thread, then
  polls from the background request thread so the editor stays
  responsive. `Phase:completed` returns progress; `Phase:timeout`
  surfaces as a Node `TIMEOUT` error with the last progress while the
  build continues in the background. Whole-scene builds (the default)
  discard all tiles and warn they may take a while. No revision is
  advanced and nothing is saved; navmesh output persists via scene save
  by the user.
- Lightmap `lighting.bake start` returns `{Phase:baking}` and the caller
  polls `status` (`{IsBaking, Step, StepProgress, TotalProgress}` plus
  the last `Failed` outcome). Start-while-baking and cancel-while-idle
  are no-op reports that never touch the toggle, so a status check can
  never accidentally start or stop a bake. Bakes refuse headless
  (`INVALID_STATE`) and play mode, like all v31 writes.
- Probe `environment_probe.bake` rejects non-probe actors with
  `VALIDATION_FAILED`, converts `timeout_ms` to the seconds `Bake`
  expects, and polls `HasContentLoaded`, which cannot distinguish a
  fresh bake from previously baked content. Timeout surfaces as Node
  `TIMEOUT`; the bake may still complete in the background.
- All five write/start ops (including the terrain stub) require
  edit-time via `RequireEditTime`: headless fails `INVALID_STATE`
  (GPU/editor-ops dependent; navmesh is CPU work but keeps the gate for
  consistency) and play mode fails `INVALID_STATE`, mirroring
  `actor_update`. The status polls (`navigation.get_status`,
  `lighting.bake status`) are read-only and ungated. Scene writes honor
  foreign edit leases fail-closed via `CheckSceneWrite`; v31 schemas
  carry no `IdempotencyKey`, so retries are caller-driven.

## Bridge v32: asset import-settings get/set (152-tool contract)
Bridge v32 keeps protocol v1 and the full v31 surface and adds two tools
— `asset_get_import_settings` (read family, no import root needed) and
`asset_set_import_settings` (asset family, same full-profile plus
`--asset-import-root` gating as `asset_reimport`) — for a 152-tool
contract. `status` flips `AssetImportSettingsSupported` to `true` and
Node reports version-gated `assetImportSettings` / `assetImport.settings`
in `get_server_capabilities` (both require bridge v32).

SDK truth (Flax 1.12, spot-verified against the shipped
`FlaxEngine.CSharp.xml` plus a reflection dump of the real editor DLL;
every new call site is additionally compile-probed by
`test/flax-api-smoke/BridgeCompileSmoke.csproj`):

- Typed overloads exist: `FlaxEditor.Editor.Import(string, string,
  TextureTool.Options | ModelTool.Options | AudioTool.Options)`
  (`FlaxEngine.CSharp.xml:78954,78971,78988`);
  `ContentImportingModule.Reimport(BinaryAssetItem, Object settings,
  bool skipSettingsDialog)` (:97732) and `Import(..., Object)`
  (:97748,:97757); `Editor.CanImport` gate (:79433).
- Read path: `Editor.TryRestoreImportOptions(ref TextureTool.Options |
  ModelTool.Options | AudioTool.Options, assetPath)`
  (:78963,:78980,:78997) with `Options.Default` fallback; source path via
  `BinaryAssetItem.GetImportPath` (:75226) / `BinaryAsset.ImportPath`.
- `Options` structs are public value types with scalar fields (verified
  by reflection against `FlaxEngine.CSharp.dll`): texture `sRGB`,
  `Compress`, `MaxSize`, `Scale`, `GenerateMipMaps`, `NeverStream` (plus
  read-only `Type`: `FlaxEngine.TextureFormatType` =
  `Unknown,ColorRGB,ColorRGBA,NormalMap,GrayScale,HdrRGBA,HdrRGB`); model
  `Scale`, smoothing-angle floats, `CalculateNormals/FlipNormals/
  CalculateTangents/ReverseWindingOrder/OptimizeMeshes/MergeMeshes/
  ImportLODs/ImportVertexColors`, `BaseLOD`/`LODCount` ints; audio
  `Format` (`FlaxEngine.AudioFormat` = `Raw,Vorbis`), `Quality`,
  `DisableStreaming`, `Is3D`, `BitDepth` (`_8,_16,_24,_32`).
- `FlaxEditor.Content.Import.{Texture,Model,Audio}ImportSettings` are
  classes with a public `Settings` field; the typed settings object is
  passed straight to `Reimport`. `AudioClipItem` is internal to the
  editor assembly (CS0122), so audio assets are classified by registry
  type name `FlaxEngine.AudioClip` while texture/model use the public
  `TextureAssetItem` / `ModelItem` / `SkinnedModeItem` subclasses.

Wire shape: settings travel as explicit key/scalar entries with exact C#
option field names (bool/integer/number/string exactly-one-of), never
anonymous types. `asset.get_import_settings` returns `{asset, type:
texture|model|audio, restored, settings}` with a bounded read-only
projection; unknown asset types fail `VALIDATION_FAILED`.
`asset.set_import_settings` clones the current options, mutates the
allowlist only (strict ranges: texture `MaxSize` 1-16384, `Scale`
(0,8]; model `Scale` 0.001-1000, smoothing angles 0-180, `BaseLOD`
0-16, `LODCount` 1-16; audio `Quality` 0-1; enums exact-match:
`Format` is `Raw|Vorbis`, `BitDepth` is `_8|_16|_24|_32`), rejects
unknown/duplicate keys with `VALIDATION_FAILED`, and applies through
`ContentImporting.Reimport(item, settings, skipSettingsDialog:true)` on
the shared `"reimport"` operation records, so `asset_reimport_status`
polls settings writes like ordinary reimports. `dry_run` returns
`{would_change, before, after}` without touching the importer; a
no-change write finishes `succeeded` without reimporting.

Explicitly missing (not claimed): dry-run validate-only import (no
`PreviewImport`/`ValidateOptions` in the managed API); standalone
metadata write without reimport; direct conversion outside (re)import.
The bridge never returns importer source paths; the set path revalidates
the source against the configured import roots and the `Editor.CanImport`
gate before mutating.

## Bridge v33: editor-visible members, UI, runtime script drive, settings, content lifecycle (170-tool contract)
Bridge v33 keeps protocol v1 and the full v32 surface and adds 18 tools for
a 170-tool contract. `status` adds `ActorPropertyReadSupported`,
`GenericActorPropertyWriteSupported`, `UiControlWorkflowsSupported`,
`RuntimeScriptDriveSupported`, `SettingsWriteSupported`,
`SceneCreateSupported`, `SceneCloseSupported`,
`ContentFolderCreateSupported`, `AssetCreateSupported`, and
`ParticleParameterWorkflowsSupported`. Node version-gates every new method
(and the generic and dry-run paths of `actor.set_property`) at bridge v33.

API truth comes from the Flax 1.12 C++ headers under `Source/` and a
decompile of the shipped `FlaxEngine.CSharp.dll` (the install ships no
`.cpp` and no Editor C# sources). Every call site is compiled by
`test/flax-api-smoke/BridgeCompileSmoke.csproj`, and the surface was run
against a real Flax 1.12 Editor (see `docs/TESTING.md`).

Design rule: a method exists only where it follows the path the Editor
itself uses. Input injection therefore stays the v26 stub
(`Keyboard::OnKeyDown` and `Mouse::OnMouseDown` carry no `API_FUNCTION`;
dispatching into `RootControl.GameRoot` would reach GUI only and leave
`FlaxEngine.Input` disagreeing with it).

### Editor-visible members
- `actor.get_properties` `{ActorId, Filter?, IncludeUnsupported, Limit}`
  returns `{ActorId, Target: "actor", TypeName, Members[], TotalCount,
  UnsupportedSkipped, Truncated, ProjectRevision, SceneRevision,
  Warnings}`. Each member is `{Name, DeclaringType, Type, Kind, Group,
  Writable, Value, EnumValues, Min, Max, Reason, Tooltip}`. `Limit` is
  1-256 (default 128); members sort by name. It is a read with no
  edit-time gate, so it also works headless and in play mode.
- Member selection mirrors
  `FlaxEditor.CustomEditors.Editors.GenericEditor.GetItemsForType`:
  properties need a getter plus a setter or `[ShowInEditor]`, public
  visibility or `[ShowInEditor]`, and no `[HideInEditor]`; fields need
  public visibility or `[ShowInEditor]` and no `[HideInEditor]`. Indexers
  and static members are skipped.
- `actor.set_property` gains `DryRun` and the generic path: `Property` is
  `Member` or `Type.Member` (the prefix must name a type in the hierarchy
  of the target). The five v28 aliases keep their dedicated setters; a
  dry-run of the four actor aliases uses the generic path, and
  `Script.Enabled` has no dry-run. The result adds `Type`, `DryRun`,
  `WouldChange`.
- Writes refuse: `[ReadOnly]` or setter-less members; `[NoSerialize]`
  members (an edit-time write would not persist); members declared on
  `FlaxEngine.Object` or `SceneObject`; members declared on `Actor` except
  `StaticFlags` (name, active, transform, layer, tags belong to
  `actor.update`); unsupported value types; numeric values outside the
  `[Limit]`/`[Range]` bounds of the member.
- Value kinds: `boolean`, `integer`, `number`, `string`, `enum` (names,
  comma-separated for `[Flags]`, or a defined numeric value), `guid`,
  `vector2/3/4` (Vector, Float, Double, Int), `color`, `quaternion`
  (`"x,y,z,w"`), `rectangle` (`"x,y,width,height"`), `margin`
  (`"left,right,top,bottom"`), `localized_string`, `layers_mask`
  (integer), `asset` and `json_asset` (GUID or `Content/` path, `""`
  clears; `JsonAssetReference<T>` also checks `DataTypeName`), `actor` and
  `script` (GUID, `""` clears). Asset references resolve through the
  project Content registry, so engine-content assets cannot be assigned.
- The write is `ScriptMemberInfo.SetValue` (the property-grid wrapper)
  inside `McpMemberUndo`, registered with `Editor.Undo.AddAction`;
  scene-object references are stored by ID and re-resolved on undo. It
  requires edit time (`RequireEditTime`: headless and play mode fail
  `INVALID_STATE`) and honors `ExpectedSceneRevision`, `LeaseId`, and
  `IdempotencyKey`; dry-runs never consume the key.

### UI controls
- `ui.create_control` `{ParentId, ControlType, Name?, DryRun, ...}` spawns
  `new UIControl { Control, Name, StaticFlags }` through
  `SceneEditing.Spawn`, as the Editor scene tree does. The parent must be
  a `UICanvas` or a `UIControl` whose control is a `ContainerControl`.
  `ControlType` must be a visible, non-abstract `FlaxEngine.GUI.Control`
  with a parameterless constructor; `FlaxEditor.*` controls (absent from a
  cooked game) and `RootControl` types are rejected.
- `ui.get_control_properties` and `ui.set_control_property` apply the
  member surface to `UIControl.Control` (`Target: "control"`). In addition
  to the grid-visible members they reach exactly the `[HideInEditor]`
  layout members that
  `FlaxEditor.CustomEditors.Dedicated.UIControlControlEditor` edits:
  `AnchorPreset`, `AnchorMin`, `AnchorMax`, `LocalX`, `LocalY`, `Width`,
  `Height`, plus `Offsets`. Several of these are `[NoSerialize]` views
  over the serialized anchors and offsets, so they are exempt from the
  `[NoSerialize]` refusal. `Parent` and `IndexInParent` stay with
  `actor.reparent`.

### Play-mode script drive
- `runtime.set_script_value` `{ScriptId, Member, Bool|Number|Text}` and
  `runtime.invoke_script_method` `{ScriptId, Method, Args[]}` require play
  mode (`INVALID_STATE` otherwise; Node reports `INVALID_PLAY_STATE`).
- Both reach game code only: members and methods declared on
  `FlaxEngine.*`, `FlaxEditor.*`, `System.*`, or `Microsoft.*` types are
  refused. Invocation needs a public, non-generic instance method that is
  not a special name (no property accessors), at most four arguments of
  supported kinds, and a unique overload for the argument count.
- An exception thrown by the game method is returned as data (`Invoked`,
  `Threw`, `ExceptionType`, `ExceptionMessage`), because the call did
  happen. Neither method records undo, marks a scene edited, or advances
  a scene revision; Flax restores the edit-time scene when play stops.

### Project settings
- `settings.set_input_action`, `settings.set_input_axis`,
  `settings.remove_input_mapping`, `settings.set_layer_name`,
  `settings.add_tag`, and `settings.set_first_scene` load through
  `GameSettings.Load<T>()`, save through `GameSettings.Save<T>()`
  (`Editor.SaveJsonAsset`), then call `GameSettings.Apply()`.
- `DryRun` defaults to `true` on the bridge; a real write needs
  `Confirm`. Results report `Saved`, `WouldChange`, and before/after. A
  request that matches the current settings saves nothing.
- Refusals: play mode or requested play (`INVALID_STATE`), compiling or
  reloading scripts (`EDITOR_BUSY`), and the settings asset being open in
  an Editor window (`EDITOR_BUSY`, via `WindowsModule.FindEditor`).
  Headless editors are allowed.
- Saving re-serializes the whole asset in the current engine format, as
  the Editor window does. Axis mappings have no engine defaults, so
  omitted fields use `DeadZone` 0.1, `Sensitivity` 1, `Gravity` 1,
  `Scale` 1.

### Scene and content lifecycle
- `scene.create` `{Path, DryRun, Confirm, IdempotencyKey?}` calls
  `SceneModule.CreateSceneFile` (the Editor default template) at a new
  `Content/.../*.scene`; it does not open the scene.
- `scene.close` `{SceneId, AllowDirty}` mirrors edit-mode
  `SceneModule.CloseScene` without its modal dialog:
  `ClearRefsToSceneObjects` then `ChangingScenesState.UnloadScene`. It
  needs `CurrentState.CanChangeScene`, refuses active edit leases
  (`EDIT_LEASE_ACTIVE`) and an edited scene unless `AllowDirty`
  (`DIRTY_SCENE`), and returns `Phase: "closing"`; poll
  `scene.list_loaded`.
- `content.create_folder` `{Path, DryRun}` creates a folder below
  `Content/`; an existing folder is a no-op.
- `asset.create` `{Kind, Path, TypeName?, DryRun, Confirm,
  IdempotencyKey?}` calls `Editor.CreateAsset(tag, path)` for `Material`,
  `MaterialInstance`, `MaterialFunction`, `ParticleEmitter`,
  `ParticleEmitterFunction`, `ParticleSystem`, `AnimationGraph`,
  `AnimationGraphFunction`, `Animation`, `SceneAnimation`,
  `SkeletonMask`, `BehaviorTree`, `CollisionData`, or
  `Editor.SaveJsonAsset(path, new T())` for `JsonAsset`. JSON types follow
  `GenericJsonCreateEntry`: visible, non-abstract, non-generic classes
  with a parameterless constructor that are not `Attribute`,
  `FlaxEngine.Object`, or `Control`, plus types with a registered
  `SpawnableJsonAssetProxy<T>` (for example `FlaxEngine.PhysicalMaterial`).
- Creation never overwrites (`FILE_EXISTS`), canonicalizes the nearest
  existing parent so a symlink or junction cannot leave `Content/`,
  refreshes the Content database through `ContentDatabase.RefreshFolder`,
  and reads the ID of a new binary asset from its header because the
  registry lists it a moment later. There is no Editor undo record.

### Particle parameters
- `particle.get_parameters` `{ActorId}` lists `ParticleEffect.Parameters`
  as `{Track, Name, Type, IsPublic, Writable, Value, DefaultValue}`.
- `particle.set_parameter` `{ActorId, Track?, Name, Bool|Number|Text,
  DryRun, ...}` calls `ParticleEffect.SetParameterValue` inside
  `McpLambdaUndo`. `Track` is needed only when the name exists on several
  emitter tracks. Undo restores the previous value as an explicit
  override.

### Serialization and type-resolution fixes shipped with v33
- `FlaxEngine.Json` serializes public fields and settable properties
  only, so a C# anonymous type becomes `{}`. The v14 domain queries
  (`physics.*`, `navigation.get_status`, `navigation.validate_agents`,
  `navigation.query_path`, `lighting.get_status`, `lighting.validate`,
  `terrain.get_summary`, `foliage.get_summary`) returned anonymous types
  and were therefore empty in a real Editor. They now return named DTOs
  with the same field names.
- Error details and idempotency fingerprint inputs are still written as
  anonymous types in the source; `PlainForJson` projects them to
  dictionaries at every serialization site. Details such as
  `CurrentSceneRevision` now reach the client, and the asset import,
  reimport, and import-settings fingerprints distinguish requests again.
- `ResolveType` and the JSON asset type lookup use
  `FlaxEngine.Utils.GetAssemblies()` (default context plus the current
  scripting context). `AppDomain.GetAssemblies()` also returns game
  assemblies from contexts unloaded by earlier script reloads, and a type
  from one of those cannot be instantiated: `script.attach` and
  `actor.create` with a game type failed with a `NullReferenceException`
  after any recompile in the same Editor session.

### Progress notifications (Node only)
A `tools/call` carrying `_meta.progressToken` receives
`notifications/progress` with `progress` in milliseconds since the call
started, `total` equal to the timeout of the call when one applies, and a
`message`. Sources: the compile, generate, play, import, build, and
capture polling loops, and any bridge request still pending after one
second.
