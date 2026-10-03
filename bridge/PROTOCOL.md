# Flax MCP Editor Bridge protocol (Editor bridge v34, runtime bridge v35 / protocol v1)

`FlaxMcpBridge.cs` is an Editor-only Flax 1.12 plugin. It uses only files below
`<project>/Cache/MCP`; it does not open a network listener.

This document is cumulative. The opening sections describe the v5 to v7 baseline;
each later `## Bridge vNN` section records what that version added or superseded,
and the "Bridge v34" section describes the newest Editor bridge. The last
section, "Runtime bridge (v35)", describes the separate bridge file for cooked
games (server 1.13.0, 177 tools). Sections are
not in strict version order (after v14 the file continues with v27 down to v16,
then v28 to v34), so when two statements disagree, the one from the higher bridge
version wins (for the Editor bridge; the runtime bridge is a separate file and
only the "Runtime bridge (v35)" section describes it). The protocol version stays 1: every addition since v5 is optional or
additive.

At startup the bridge creates `requests/`, `processing/`, and `responses/` (plus
`captures/` and `operations/`), then writes these project-local files:

- `bridge.json`: `{ "BridgeVersion": 34, "ProtocolVersion": 1, "Pid": 123, "Project": "...", "EditorVersion": "1.12.6912", "Timestamp": 0 }`.
  It is atomically rewritten every two seconds. `Timestamp` is Unix milliseconds.
  Since v34 only one Editor per project owns this directory; see "Bridge directory
  ownership (v34)".
- `token`: a fresh 256-bit base64url session token. The bridge requires it on every
  request and deletes it on normal shutdown. It is marked hidden where the host
  filesystem supports that attribute; callers must treat `Cache/MCP` as private.

The Node client writes `requests/<id>.json` using a temporary file then rename.
`id` is 1–128 ASCII alphanumeric, `_`, or `-` and must equal the filename stem; the bridge atomically moves it to
`processing/` before reading it, so a request is executed at most once by one
bridge instance. A response is atomically written to `responses/<id>.json`.

Request fields are lowercase `id`, `token`, `method`, `paramsJson`, and `deadlineUnixMs`.
`paramsJson` is a JSON string, not an arbitrary object, and is capped at 64 KiB
(the whole request file at 128 KiB; a successful `resultJson` at 512 KiB, beyond
which the bridge answers `RESPONSE_TOO_LARGE`).
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
attach/detach/instance read/update, and `edit.undo`/`edit.redo`. The
`script.instance_update` method only permits an optional `Enabled` patch and an
empty patch fails; that has not changed. Later versions add bounded, separately
named writes instead of widening it: `script.instance_set_value` (v28),
`actor.set_property` (v28, generic editor-visible members in v33), and play-mode
`runtime.set_script_value` (v33). They go through the Editor property wrapper and
never accept an arbitrary serialized blob. `actor.update`
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
`Active` filters. These fields are explicit allowlisted DTO members; at v7,
arbitrary actor components/properties, prefab overrides, and script serialized
properties were unsupported. Later versions add editor-visible member reads and
writes (v28, v33) and prefab override workflows (v30) as separate methods.

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

In v6 viewport capture was play-mode-only (bridge v22 added an `editor` viewport
scope that works outside play mode, see "Bridge v22"); both scopes are unavailable
in headless mode. It writes a
PNG below `Cache/MCP/captures`; status returns an opaque capture ID, never an
arbitrary caller path. Files expire after 24 hours and the Node server exposes
them through `flax://capture/<id>` with bounded MCP `resources/list` and
`resources/read` handlers.

`actor.duplicate` delegates to Flax's undoable editor command. Flax 1.12 does not
return the new actor ID from that public command, so the response reports
`Verified:false` and `NewActorId:null`; clients must refresh the scene tree.

`actor.validate_create` takes the same parameters as `actor.create` and resolves
the type and parent without spawning; the Node `actor_create` dry-run uses it.
`scene.save` fails with `EDITOR_BUSY` while game scripts are compiling or reloading
(saving then could flush unresolved script values), and its `McpSceneRef` result may
carry a `SaveReport` string when keyed lines present in the scene file before the
save are gone after it (the scene serializer omits values equal to C# defaults and
flushes dangling asset references as empty).

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

## MCP resource delivery (Node server)

The Node MCP server exposes bridge data as bounded read-only resources; this does
not add a bridge RPC or imply an Editor event stream. Fixed resources include
project metadata/settings, bridge status, loaded scenes, diagnostics, logs,
script compilation status (`flax://build/status`, not GameCooker builds), and
script audit history. Live scene/actor URIs require bridge
v5; live asset URIs require v8. All resource URIs use canonical `flax://` paths,
reject queries/fragments/encoded traversal, redact host paths, and limit JSON to
256 KiB. Capture PNG resources retain the existing cache confinement, TTL, and
size checks.

The MCP server may subscribe clients to Editor status, scene trees, diagnostics,
and logs. It sends debounced `notifications/resources/updated` only after a
successful call of a fixed set of MCP tools (scene save, actor create/update/
delete/duplicate/reparent, script attach/detach/enabled patch, undo/redo, C#
source writes, compile and project generation, and play controls);
other write tools, such as `actor_set_property` or `scene_open`, do not trigger it.
Editor status is also bounded-polled through the heartbeat. The bridge has no verified callback
for manual Editor edits or arbitrary plugin mutations, so those changes are not
guaranteed to cause notifications. Successful captures cause the server to send
`notifications/resources/list_changed`.

## Bridge v8: public asset registry and reference graph

Bridge v8 keeps protocol v1 because the asset RPCs and status fields are additive.
`status` adds `AssetRegistrySupported:true`, `AssetReferenceGraphSupported:true`,
`AssetImportSettingsSupported:false` (true since bridge v32), and
`AssetReferenceLocationsSupported:false`.

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
or reflection. (Importer settings are still not part of the `asset.get` or
`asset.search` results; bridge v32 reads and writes them through the separate
`asset.get_import_settings` and `asset.set_import_settings` methods.)

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
`CollisionPolicy`, `DryRun`, `AllowedImportRoots`, and `MaxSourceBytes`, plus an
optional `ModelImportType` (`Model`, `SkinnedModel`, `Animation`, or `Prefab`;
added with bridge v16) that selects the model importer type for model sources.
`DestinationPath` is strictly project-relative `Content/.../*.flax`; absolute
paths, traversal, and a Content parent resolving through a junction are rejected.
`CollisionPolicy` is `error` (default), bounded `rename`, or (bridge v34)
`replace`; see "Import changes (v34)". `error` and `rename` never overwrite.
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
metadata sources reject rather than prompting for a file. `asset.reimport_start`
also accepts the optional `ModelImportType` (v16), which switches a model source
between the four importer types; no other importer setting or type change is
available through it. Bridge v32 adds allowlisted importer-option writes as
`asset.set_import_settings` (see "Bridge v32").

Both start methods reject `EDITOR_BUSY` while the Editor is playing, starting
play, compiling/reloading scripts, or already importing content. They are UI-free
and can be requested from a headed or headless Editor, but actual headless import
success remains dependent on the installed Flax importer backend; callers should
validate that environment. Operation records contain only kind, phase, bounded
progress, timestamps, the Content-relative result path, the result asset ID
(`ResultAssetId`, set on `asset.import_start` success since bridge v34; before
v34 it was always null), the collision `Renamed` and `Replaced` flags, and
bounded error text--never a source path or configured root. They expire after
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
API (including compilation and content importing). At v11 the only safe
checkpoint was queued project generation before it runs; cancellation then
returns terminal `cancelled` with `OPERATION_CANCELLED`. Since bridge v13 a
running `build_cook` operation can also be cancelled (asynchronously, see the
v13 build section). The v31 navmesh, lightmap, and probe bakes do not create
operation handles; only `lighting.bake` can be cancelled, through its own
toggle. These raw handles are not a claim of MCP Tasks support.

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

As shipped in v13, the method names material.set_parameters,
material.create_instance, material.assign_to_actor, and
animation.set_graph_parameter were present only to return stable
UNSUPPORTED_FLAX_VERSION capabilities. Flax 1.12 exposes runtime setters and
virtual material instances, but v13 had no reviewed Editor undo, durable-save,
actor-slot targeting, semantic-preview, and confirmation path for those
mutations, so it never called SetParameterValue or CreateVirtualInstance and did
not mutate material slots or animation graph state. Superseded by bridge v29:
the three material methods are now real edit-time implementations (see
"Bridge v29" below). Only animation.set_graph_parameter is still a stable
UNSUPPORTED_FLAX_VERSION capability.

## Bridge v14: bounded advanced domain queries

Bridge v14 adds read-only `physics.validate_colliders`, `physics.raycast`,
`physics.get_layer_matrix`, and `physics.find_overlaps`; navigation status,
agent validation, and path query methods; lighting status/validation; plus
`terrain.get_summary` and `foliage.get_summary`. All query only public Flax
1.12 runtime state and cap caller-controlled result counts. In a real Editor the
v14 queries returned empty objects until the named-DTO fix shipped with bridge v33
(see "Serialization and type-resolution fixes shipped with v33" below); the
field names did not change.

`navigation.build`, `lighting.bake`, and `environment_probe.bake` shipped as
stable `UNSUPPORTED_FLAX_VERSION` capabilities (bridge v31 replaced all three
stubs with real implementations — see "Bridge v31" below). Terrain and foliage
shipped metadata-only; bridge v31 adds real foliage instance writes and a
`terrain.paint` method that is a validated stub with no verified managed write
path (see "Bridge v31").

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

The bundled bridge has no project-local methods: every method the Node server calls is implemented in `bridge/FlaxMcpBridge.cs` (or `bridge/FlaxMcpRuntimeBridge.cs`). A project-local method that a bridge does not implement answers `METHOD_NOT_FOUND` (`METHOD_NOT_ALLOWED` on bridges before v34), which the shared mapper reports as `UNSUPPORTED_FLAX_VERSION` with a capability hint. The game-specific motion-matching tools `mm_tuning` and `mm_apply_preset` (method `mm.tuning`) were removed from the server: they belong to one game, not to the general engine surface.

Capability checks must use the `*Supported` status flags (e.g.
`GraphSetModelSupported`, `ScriptFieldValuesReadSupported`,
`SceneOpenSupported`), never the bare version number: the flax-test local
bridge advertised `BridgeVersion = 21` for its experimental `scene.open`
while canonical v21 means `graph.set_model` — the same number named two
different capability sets. Canonical v25+ ships `scene.open` (`scene_open`
in Node); older canonical installers answer that method with
`METHOD_NOT_ALLOWED`. From v34 an unknown method is `METHOD_NOT_FOUND` and its
error details list the known methods; see "Bridge v34".

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
At v28 `Property` had to exactly equal one allowlist entry — `Light.Color`,
`Light.Brightness`, `Camera.FieldOfView`, `StaticModel.Model`,
`Script.Enabled` — with no dotted-path parsing, and anything else failed with
`VALIDATION_FAILED` listing the allowlist. (Superseded by bridge v33: any
other name is now resolved as an editor-visible member, `Member` or
`Type.Member`, and the allowlist survives as five aliases with unchanged
behaviour; see "Bridge v33".) Each entry runs a direct typed
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
  by the user. Bridge v34 changes the wait and Phase semantics and allows
  headless Editors; see "navigation.build (changed in v34)".
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
  edit-time via `RequireEditTime` (bridge v34 relaxes this for
  `navigation.build`, which only refuses play mode and works headless):
  headless fails `INVALID_STATE`
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
  passed straight to `Reimport`. The importer replaces its options
  wholesale with that object
  (`TextureImportEntry`/`ModelImportEntry`/`AudioImportEntry`
  `.TryOverrideSettings`).
- Classification uses the exact registry type name only:
  `FlaxEngine.Texture` → `texture`; `FlaxEngine.Model` and
  `FlaxEngine.SkinnedModel` → `model`; `FlaxEngine.AudioClip` → `audio`.
  `BinaryAssetProxy.ConstructItem` builds a `TextureAssetItem` for every
  `TextureBase` (`CubeTexture`, `SpriteAtlas`, `IESProfile`), so the item
  subclass alone is not enough; those types are refused. The public
  `TextureAssetItem` / `ModelItem` / `SkinnedModeItem` subclasses are a
  cross-check for texture and model (`AudioClipItem` is internal, CS0122).

Wire shape: settings travel as explicit key/scalar entries with exact C#
option field names (bool/integer/number/string exactly-one-of), never
anonymous types. `asset.get_import_settings` returns `{Asset, Type:
texture|model|audio, Restored, Settings}` with a bounded read-only
projection. An unsupported asset type fails `VALIDATION_FAILED` with
`{TypeName}` details; the check runs on the registry record, before the
editor item lookup, `Content.Load`, or any source check.
`asset.get` sets `ImportSettingsAvailable` from the same classification.

`asset.set_import_settings` restores the current options once and derives
`Before`, `After`, and the object handed to `Reimport` from that single
value. It mutates the allowlist only and rejects unknown or duplicate
keys, a value with more or fewer than one scalar, NaN and infinities, and
out-of-range values with `VALIDATION_FAILED`. Ranges are the engine's own
`Limit` attributes (`TextureTool.h`, `ModelTool.h`, `AudioTool.h`) except
where noted: texture `MaxSize` 1-16384 (bridge policy, no engine limit),
`Scale` 0.0001-8 (engine minimum, tighter bridge maximum); model `Scale`
0.001-1000 (bridge policy), `SmoothingNormalsAngle` 0-175,
`SmoothingTangentsAngle` 0-45, `BaseLOD` 0-5, `LODCount` 1-6; audio
`Quality` 0-1; enums exact-match (`Format` is `Raw|Vorbis`, `BitDepth` is
`_8|_16|_24|_32`). A float option also accepts an `Integer`-typed value;
Node always sends floats as `Number`.

When the current options cannot be restored (`Restored:false`) the write
fails `IMPORT_FAILED` and nothing is reimported: defaults would replace
every option the caller did not name. `asset.reimport_start` with
`ModelImportType` refuses for the same reason.

The write applies through
`ContentImporting.Reimport(item, settings, skipSettingsDialog:true)` on
the shared `"reimport"` operation records, so `asset_reimport_status`
polls settings writes like ordinary reimports. That `Reimport` overload
only queues a request, and queues nothing when `item.GetImportPath` fails
or the import path no longer exists, in which case `ImportFileEnd` never
fires. The bridge therefore runs the same two public checks first
(`QueueAssetReimport`, shared with `asset.reimport_start`) and fails
`IMPORT_FAILED` instead of leaving an operation `running` forever.

Result: `{Operation, WouldChange, Before, After, Adopted}`. `DryRun`
returns the preview without touching the importer; a no-change write
finishes `succeeded` with `WouldChange:false` and queues no reimport. The
bridge stores each operation's preview for as long as its operation
record lives; a request that reuses a known `OperationId` gets that stored
result with `Adopted:true`. `WouldChange`, `Before`, and `After` are
`null` when the first call failed before a preview existed, which means
"unknown", never "no change"; the failure is in `Operation.Phase` /
`Operation.ErrorCode`. A failed operation record keeps its real error
code (`VALIDATION_FAILED`, `EDITOR_BUSY`, `ASSET_NOT_FOUND`,
`IMPORT_SOURCE_NOT_ALLOWED`, `FILE_EXISTS`); Node maps any other code to
`IMPORT_FAILED`.

Explicitly missing (not claimed): dry-run validate-only import (no
`PreviewImport`/`ValidateOptions` in the managed API); standalone
metadata write without reimport; direct conversion outside (re)import.
The bridge never returns importer source paths; the set path revalidates
the source against the configured import roots and the `Editor.CanImport`
gate before mutating.

## Bridge v33: editor-visible members, UI, runtime script drive, settings, content lifecycle (170-tool contract)
Bridge v33 keeps protocol v1 and the full v32 surface and adds 18 tools for
a 170-tool contract. The follow-up to v33 removed the game-specific
`mm_tuning` tool (no bridge change), so the server now registers 169 tools. `status` adds `ActorPropertyReadSupported`,
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
against a real Flax 1.12 Editor except for the gaps listed under "Not
exercised live" in `docs/TESTING.md`.

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
  (integer), `asset` and `json_asset` (`""` clears;
  `JsonAssetReference<T>` also checks `DataTypeName`), `brush`, `font`,
  `actor` and `script` (GUID, `""` clears).
- Asset references are a GUID, a `Content/` path, or `engine:<internal path>`
  (the `Content.LoadAsyncInternal` form: relative to the engine Content
  folder, no extension, e.g. `engine:Editor/Primitives/Cube`). Project
  assets resolve first; engine assets resolve only from the engine asset
  registry under `Globals.EngineContentFolder` and are loaded by ID and
  type-checked like project assets. No file path is composed from caller
  input: an `engine:` path with `\`, `:`, `.`/`..` segments, a `.flax`
  suffix, or control characters fails `VALIDATION_FAILED`. Assets of other
  referenced projects are not resolvable (`ASSET_NOT_FOUND`). Asset values
  read back as `{Kind: "asset", AssetId, Text}` where `Text` is the
  `Content/` or `engine:` form (null for other assets).
- `brush` (`FlaxEngine.GUI.IBrush`): `"<kind>:<value>[;option=value]"`, `""`
  clears. Kinds: `solid:<color>`, `gradient:<color>;end=<color>`,
  `texture:<Texture>[;filter=linear|point]`,
  `texture9:<Texture>[;filter][;border_size=<n>][;border=l,r,t,b]`,
  `sprite:<SpriteAtlas>;sprite=<name>` (or `;index=<n>`) `[;filter]`,
  `sprite9:` with the texture9 options, `material:<MaterialBase>`,
  `ui_brush:<JsonAsset of UIBrushAsset>`,
  `video:<VideoPlayer actor GUID>[;filter]`. These are the entries of
  `FlaxEditor.CustomEditors.Editors.IBrushEditor` except `GPUTextureBrush`
  (a runtime GPU texture, not an asset). Omitted options take the brush
  constructor defaults; unknown or repeated options, a bad filter, an
  out-of-range border, and an unknown sprite fail `VALIDATION_FAILED`.
  Read-back is `{Kind: "brush", Text, AssetId, TypeName}` with every
  option spelled out, so writing `Text` back is a no-op; a brush type
  without a string form has `Text` null and a member `Reason`.
- `font` (`FlaxEngine.FontReference`): `"<FontAsset>;size=<points>"` (size
  1-500, the engine `[Limit]`). `""` yields an empty reference (no asset,
  size 30), never null, because `Label.DrawSelf` dereferences it.
  Read-back is `{Kind: "font", Text, AssetId, Number}`.
- `actor.set_property` / `ui.set_control_property` results add `Warnings`
  for values the engine accepts but would not draw: a `BackgroundBrush`
  set while `BackgroundColor` alpha is 0, a non-GUI material in a
  `MaterialBrush`, a font reference without an asset. The Editor property
  grid writes under `CustomEditor.IsSettingValue`, which makes
  `Control.BackgroundBrush` switch a transparent `BackgroundColor` to
  white; the bridge does not set that flag (its undo action reverts one
  member only), so it warns instead of writing a second member.
- Brushes compare through their string form (`Sprite9SlicingBrush.Equals`
  ignores its border fields). `McpMemberUndo` keeps private copies of
  brushes and font references, since the property grid mutates them in
  place; a video brush is kept as the player's ID.
- The `StaticModel.Model` alias sends an engine reference through the
  generic member path (its own loader resolves project assets only), so
  that call returns the generic result shape.
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
  `Confirm`. The Node tools always send `DryRun` explicitly: their `dry_run`
  defaults to false, and a call with neither `dry_run:true` nor `confirm:true`
  is rejected before it reaches the bridge. Results report `Saved`,
  `WouldChange`, and before/after. A request that matches the current settings
  saves nothing.
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
- `asset.create` and `scene.create` query `Content.GetAssetInfo` with
  `StringUtils.NormalizePath(Path.Combine(Globals.ProjectFolder, path))`,
  the spelling the Editor content database itself uses as the registry
  key. An OS-spelled path names the same file but misses that key, so the
  engine registered the new file a second time and logged "Founded
  duplicated asset" followed by "Cannot modify duplicated asset ID" after
  every binary `asset.create` (seen in the first v33 live run; fixed and
  re-verified live).

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

### Headless refusals and timeouts (Node mapping)
- Every headless refusal is raised as `INVALID_STATE` with "headless" in
  the message and no details, and only when the Editor is headless
  (`RequireEditTime`, graph inspect/edit/undo, editor selection, viewport
  capture, play start). The shared Node mapper (`mapBridgeError`,
  `isHeadlessRefusal`) therefore reads the message as well as the details
  and reports `HEADLESS_MODE`; before this, material and graph tools
  reported a headless refusal as `EDITOR_BUSY`, and play start as
  `INVALID_PLAY_STATE`. `viewport_capture` keeps its own
  `CAPTURE_UNAVAILABLE`. Any other `INVALID_STATE` stays `EDITOR_BUSY`, or
  `INVALID_PLAY_STATE` for play-scoped and domain tools.
- `actor.create`, `actor.update`, `actor.delete`, `script.attach`,
  `script.detach`, and `edit.undo` carry no headless gate and work in a
  headless Editor.
- A `TIMEOUT` on a write means the outcome is unknown: the bridge checks
  the deadline only before it starts a request and cannot cancel one that
  is already running. Read the state back before retrying. For
  `graph.add_parameter` a blind retry is safe, because a duplicate name is
  refused with `VALIDATION_FAILED`.

### Progress notifications (Node only)
A `tools/call` carrying `_meta.progressToken` receives
`notifications/progress` with `progress` in milliseconds since the call
started, `total` equal to the timeout of the call when one applies, and a
`message`. Sources: the compile, generate, play, import, build, and
capture polling loops, and any bridge request still pending after one
second.

## Bridge v34: editor lifecycle, replace imports, scene reload, nested paths, graph edits (175-tool contract)

Bridge v34 keeps protocol v1 and the full v33 surface. The server (1.12.0) now
registers 175 tools: the 169 of v33 plus `editor_quit`, `editor_options`,
`editor_launch`, `graph_list_archetypes`, `graph_edit`, and
`animgraph_set_transition`. Six bridge methods are new (`editor.quit`,
`editor.get_options`, `editor.set_option`, `graph.list_archetypes`,
`graph.edit`, `animgraph.set_transition`); `editor_launch` is Node-only (it
starts a process and needs no bridge). Existing methods gain optional fields
(`asset.import_start`, `scene.open`, `script.instance_set_value`,
`actor.set_property`, `runtime.set_script_value`, `script.instance_get`,
`asset.create`, `navigation.build`, and the `graph.*` methods for
`MaterialFunction` windows). Node gates each new method or field at bridge v34
(`BRIDGE_V34`): a plain `scene_open`, an `asset_create` of any kind but
`GameplayGlobals`, and every v33 call keep working against v33.

### Method discovery and `METHOD_NOT_FOUND`
- An unknown method now answers `METHOD_NOT_FOUND` (it was
  `METHOD_NOT_ALLOWED`, "not in the bridge allowlist"). The error details carry
  `{ Method, Methods }`, the list of methods this bridge knows.
- `status.Methods` is the same list (`string[]`) and
  `status.MethodDiscoverySupported` is `true`. A client can discover a method
  before calling it instead of provoking an error.
- The Node mapper reports both `METHOD_NOT_FOUND` and `METHOD_NOT_ALLOWED` as
  `UNSUPPORTED_FLAX_VERSION` with a capability hint, so a project-local method
  missing from a bridge behaves as before.

### Capability flags
`status` adds these booleans, all `true` on a v34 bridge. Check them rather than
the version number.

| Flag | Meaning |
|---|---|
| `MethodDiscoverySupported` | `status.Methods` and `METHOD_NOT_FOUND` details list the known methods |
| `AssetImportResultIdSupported` | `asset.import_start` returns `ResultAssetId` |
| `AssetImportReplaceSupported` | `CollisionPolicy:"replace"` |
| `BridgeOwnershipSupported` | one Editor owns `Cache/MCP`, others stand by |
| `EditorReadinessSupported` | readiness fields on `status` |
| `EditorQuitSupported` | `editor.quit` |
| `EditorOptionsSupported` | `editor.get_options` / `editor.set_option` |
| `SceneReplaceSupported`, `SceneReloadSupported` | `scene.open` `Replace` / `Reload` |
| `NestedMemberPathSupported` | `Path` on the three member writes |
| `ScriptAssetReferenceWriteSupported` | `script.instance_set_value` takes asset references and the other `actor.set_property` value shapes |
| `GraphArchetypeListSupported` | `graph.list_archetypes` |
| `GraphEditSupported` | `graph.edit` |
| `MaterialFunctionGraphSupported` | graph methods open `MaterialFunction` / `ParticleEmitterFunction` windows |
| `AnimgraphTransitionSettingsSupported` | `animgraph.set_transition` |
| `GameplayGlobalsCreateSupported` | `asset.create` kind `GameplayGlobals` |

### Editor readiness (`status`, `EditorReadinessSupported`)
`status` additionally reports:

| Field | Meaning |
|---|---|
| `EditorState` | Type name of the Editor state machine's current state (`LoadingState`, `EditingSceneState`, `PlayingState`, `ReloadingScriptsState`, `ChangingScenesState`, `BuildingLightingState`, `BuildingScenesState`, `ClosingState`) |
| `IsEditMode` | `StateMachine.IsEditMode` (the state is `EditingSceneState`) |
| `IsCompiling` | `ScriptsBuilder.IsCompiling` |
| `ScriptsReady` | `ScriptsBuilder.IsReady && !ScriptsBuilder.IsCompiling`; false while scripts compile or the scripting domain reloads |
| `IsImporting` | `ContentImporting.IsImporting` |
| `LastCompileFailed` | `ScriptsBuilder.LastCompilationFailed` (the value `code.status` reports as `LastCompilationFailed`) |
| `LoadedSceneCount` | `Level.ScenesCount` |

`status` stays cheap and never throws for these fields: each probe is guarded,
and a field the Editor cannot answer in its current state keeps its default
(`null` / `false` / `0`).

Ready means: the bridge answers, `IsCompiling` is false, `ScriptsReady` is true,
`IsImporting` is false, and `EditorState` is `EditingSceneState` or
`PlayingState`. The Node tool `editor_get_status` with `wait_ready:true` applies
exactly this rule, plus optional `require_scene` (`LoadedSceneCount` above zero)
and `min_bridge_version`. It treats a missing or stale heartbeat and a token
change during a script reload as "reloading" and keeps waiting; `timeout_ms`
defaults to 120000 (at most 300000) and a timeout returns `TIMEOUT` with the last
observed state. The result adds `ready`, `waitedMs`, and a `readiness` object
(`editorState`, `isEditMode`, `isCompiling`, `scriptsReady`, `isImporting`,
`lastCompileFailed`, `loadedSceneCount`); a bridge older than v34 only proves
that it answers.

### `editor.quit` (`EditorQuitSupported`)
Params `{ Unsaved: "refuse" | "save" | "discard" (default "refuse"), StopPlay:
bool }`. Result `{ Accepted, Phase: "exiting" | "stopping_play", SavedSceneIds[],
DiscardedSceneIds[], DiscardedAssetWindows[], Pid }`.

- Refused with `EDITOR_BUSY` while scripts compile or reload, content imports,
  or a game build (GameCooker) runs.
- Unsaved edits are detected the way the Editor's close path sees them: every
  loaded scene with `Editor.Scene.IsEdited(scene)` and every open asset editor
  window (`AssetEditorWindow`) with `IsEdited`.
  - `refuse`: `DIRTY_SCENE` listing the edited scenes and asset windows (details
    `DirtyScenes[]`, `DirtyAssetWindows[]`); nothing is changed. Node reports it
    as `DIRTY_SCENES`.
  - `save`: edited asset windows are saved with their own `Save()`, edited
    scenes with `Editor.Scene.SaveScenes()` (the File menu path; asynchronous,
    the exit waits for it). `SavedSceneIds` lists the scenes that were edited. A
    window that is still edited after `Save()` fails the request with
    `ASSET_OPERATION_FAILED`.
  - `discard`: nothing is saved; `DiscardedSceneIds` and `DiscardedAssetWindows`
    report what was dropped.
- Play mode (or a requested play start): without `StopPlay` the request fails
  with `INVALID_STATE` ("play mode active"). With `StopPlay:true` the bridge
  requests the Editor's normal play stop, answers `Accepted:true,
  Phase:"stopping_play"`, and exits only after play mode has ended. Scene edits
  are evaluated after play ends in that case: with `refuse` and edited scenes the
  quit is cancelled (logged in the Editor log), with `save` the scenes are saved
  first, with `discard` they are dropped. `SavedSceneIds` / `DiscardedSceneIds`
  are empty in the `stopping_play` response because scene state is not
  meaningful during play. A play stop that does not finish within 60 seconds
  cancels the pending quit.
- Exit: the response is written first. The request only arms a pending quit; the
  bridge's update tick calls `Engine.RequestExit()` on a later frame, once the
  response file is on disk, no scene or level action is pending, and (if needed)
  play mode has ended. `RequestExit` closes the main window with
  `ClosingReason.EngineExit`, which shows no save prompt (the prompt exists only
  for `ClosingReason.User`). `Pid` is the Editor process id. A second
  `editor.quit` while one is pending answers `Accepted:true` again. Headless
  Editors quit the same way.
- The Node tool `editor_quit` (`timeout_ms` default 60000, at most 120000) then
  waits for the `Pid` process to exit and returns `exited` (false plus a warning
  when the process outlives `timeout_ms`).

### `editor.get_options` / `editor.set_option` (`EditorOptionsSupported`)
Only two General options are exposed (an allow-list, not a generic option
editor): `AutoReloadScriptsOnMainWindowFocus` and
`ForceScriptCompilationOnStartup`.

`editor.get_options` returns `{ AutoReloadScriptsOnMainWindowFocus,
ForceScriptCompilationOnStartup, Scope: "user-global" }`, read from
`Editor.Options.Options.General`. No file path is ever returned.

`editor.set_option` takes `{ Name, Value, DryRun (default true), Confirm }` and
returns `{ Name, Previous, Value, Changed, DryRun, Scope: "user-global" }`.

- `DryRun:true` reports `Previous` / `Value` / `Changed` and writes nothing.
- A real write needs `Confirm:true` (else `INVALID_REQUEST`), is refused with
  `EDITOR_BUSY` while the Editor Options window is visible (so the window cannot
  overwrite it with its own copy), and goes exactly the way that window's Save
  button does: deep-copy `Editor.Options.Options` (JSON round trip), change the
  field on the copy, call `Editor.Options.Apply(copy)`. A write that would not
  change the value does not call `Apply`. An unknown `Name` fails with
  `INVALID_REQUEST`.
- Scope is `user-global`: the Editor stores options per user
  (`%AppData%/Flax/EditorOptions.json` on Windows), not per project, and every
  Editor of that user shares the file. Editors that are already running keep
  their in-memory copy and only pick the change up when they restart; an Editor
  that saves its options afterwards overwrites the file with its own copy. This
  is why the Node tool `editor_options` sits in the `code` permission family and
  needs `confirm:true`.
- With `AutoReloadScriptsOnMainWindowFocus` off the Editor does not recompile
  and reload scripts when its main window regains focus, and play mode runs the
  last compiled game assemblies. Run `code_compile` after editing scripts, or
  the play session executes stale code. `ForceScriptCompilationOnStartup` off
  lets the Editor start without compiling the game scripts when they are already
  up to date.

### Bridge directory ownership (v34)
Several Editors can open the same project. Only one owns `Cache/MCP` at a time;
ownership is decided from `bridge.json`.

- Init: if `bridge.json` names a different PID that is alive and whose
  `Timestamp` is younger than 30 seconds, this Editor enters **standby**. It logs
  once "another Flax Editor (pid N) owns Cache/MCP; this Editor's MCP bridge is on
  standby" and writes no token or heartbeat, does not poll `requests/`,
  subscribes to no Editor events, and restores or persists no state.
- Every two seconds a standby Editor re-checks. When the owner process is gone
  or its heartbeat is older than 30 seconds it takes ownership: it restores the
  persisted state, writes a NEW session token and the heartbeat, and starts
  polling. If `bridge.json` was removed (clean exit, or the owner's script
  reload), it waits an extra 15 seconds first so a reloading owner can
  re-initialise before the file is treated as released. Clients must re-read
  `token` after a takeover (`UNAUTHORIZED` with the old token).
- An owner that finds another live Editor's fresh heartbeat in `bridge.json` (it
  was stalled for more than 30 seconds and lost the directory) demotes itself to
  standby. Each heartbeat tick also restores the token file if a racing Editor
  overwrote it.
- Script reload or exit of the owning Editor: the same PID re-initialises as
  owner exactly as before. Deinit deletes `token` and `bridge.json` only when
  `bridge.json` names this Editor's PID; a standby or demoted Editor leaves the
  owner's files alone.
- `status.BridgeOwnershipSupported` is `true`. Nothing else is exposed in
  `status`; a standby Editor cannot answer requests, so a client talking to a
  project with a standby Editor always reaches the owner.
- Remaining limit: an Editor whose main thread is blocked for more than 30
  seconds (for example during a very long import) looks dead to a standby Editor.

### Import changes (v34)
**`ResultAssetId`.** After a successful `asset.import_start` (not a dry run) the
bridge resolves the ID of the written asset and returns it as `ResultAssetId`
(32-character GUID without separators, the managed "N" form) on the operation
record and the start/status results.

- Primary source: `Content.GetAssetInfo(<engine spelling of the result path>)`;
  see "Path-spelling safety" for why the spelling matters.
- Fallback: the 16 ID bytes at offset 28 of the binary asset header
  (`new Guid(byte[16])`), read from the written file.
- It stays null only when both fail (a warning is written to the Editor log).
  `status.AssetImportResultIdSupported` is `true`.
- `asset.reimport_start` and `asset.set_import_settings` already return the ID of
  the reimported asset. A dry run returns no `ResultAssetId`, except a `replace`
  dry run onto an existing asset, which returns the ID that would be preserved.

**Persistence of import records.** Import and reimport records (and the
fingerprint used for retry adoption) are persisted as
`Cache/MCP/asset-operations/<operationId>.json` when created, finished, and
completed, and flushed on script reload. After a reload `asset.import_status` /
`asset.reimport_status` and an `OperationId` retry find the record again
(ten-minute TTL, cap 512). A record that was still unfinished at the reload is
restored as `failed` with `ErrorCode: "IMPORT_FAILED"` and a message saying the
asset may or may not have been written; check the Content registry before
retrying. Operation IDs and the pending-reimport output paths are compared
case-insensitively.

**`CollisionPolicy:"replace"`.** Reimports a new source into an existing
registered asset and keeps its asset ID, so references stay valid. It needs
`Confirm:true` (unless `DryRun:true`), otherwise `INVALID_REQUEST`.

1. The destination file must exist and be a registered Content asset (else
   `FILE_EXISTS`; a destination that does not exist is imported as a normal new
   asset and `Replaced` is false).
2. The importer's output type for the source extension is compared with the
   existing asset's type name from the registry: texture extensions write
   `FlaxEngine.Texture`, audio extensions `FlaxEngine.AudioClip`, model
   extensions `FlaxEngine.Model` or, with `ModelImportType`,
   `SkinnedModel` / `Animation` / `Prefab`. A mismatch fails with
   `VALIDATION_FAILED` before anything is written. (Live probe: a cross-type
   `Editor.Import` onto an existing path silently writes a new sibling
   `Name (0).flax` and still reports success.)
3. The bridge calls `Editor.Import(source, <registered asset path in engine
   spelling>)`, the same call a Content Browser reimport ends up making, and
   waits for it like a normal import (it is synchronous in Flax 1.12).
4. It then verifies that no new sibling `<Name> (N).flax` appeared next to the
   asset and that the asset ID, read from the file header and from the registry,
   equals the ID before the import. Either failure fails the operation with
   `ASSET_OPERATION_FAILED` (details: previous/new IDs or the created sibling
   paths; the bridge never deletes files).

Result: `Replaced:true`, `ResultAssetId` = the preserved ID, `Renamed:false`. The
import uses engine-default import options (or `ModelImportType`); the previous
options of the asset are not restored, so adjust them afterwards with
`asset.set_import_settings`. `status.AssetImportReplaceSupported` is `true`.
`error` and `rename` behave as before.

**Node side.** `asset_import` accepts `collision_policy:"replace"` (with
`confirm:true`, or `dry_run:true` to preview) and `items[]` (1-32
`{source_path, destination, model_import_type?}`), which the server runs one
after another with one generated operation ID each; the bridge sees ordinary
single imports. A relative `--asset-import-root` is resolved against
`--project-path`.

### Path-spelling safety (Flax 1.12)
`Content.GetAssetInfo(string path)` and the other path-based Content calls
(`LoadAsync(path)`, `Load(path)`, `GetAsset(path)`, `RenameAsset(old, new)`) on a
file the engine already registered under a different spelling (backslashes,
relative `Content/...`, different case) make Flax re-register the file under a
NEW asset ID ("Founded duplicated asset ... Changing asset id"); the Content
database keeps the old ID and later loads fail. The bridge therefore never asks
the engine for an asset by an arbitrary path:

- lookups use the asset ID whenever a registry record is at hand;
- where a path is unavoidable it is `EngineAssetPath(rel)`
  (`StringUtils.NormalizePath(Path.Combine(Globals.ProjectFolder, rel))`, with
  the on-disk casing of every segment, the spelling the Editor's own Content
  database uses), or `EngineAssetPathFromAbsolute(abs)` for an already-absolute
  output path;
- model, skinned model, and generic asset loads try the ID first and fall back to
  `EngineAssetPath(record.Path)` (engine `engine:<path>` records are loaded by ID
  only); the "registry/file ID mismatch" guard is unchanged;
- `material.create_instance` no longer calls `Content.GetAssetInfo` for its
  destination clash check (the v33 check rewrote an existing asset's ID before
  answering `FILE_EXISTS`); it uses the registry records plus
  `File.Exists(EngineAssetPath(destination))`;
- `asset.rename` passes engine-spelled source and destination paths to
  `Content.RenameAsset`;
- `scene.open` with `Reload` never looks a `SceneAsset` up by path (see below).

### `navigation.build` (changed in v34)
- `Navigation.BuildNavMesh(..., float timeoutMs)`: the argument is "the timeout
  to wait before building" (a start delay), not a build timeout. v31 to v33
  passed the request's `TimeoutMs` there, so `IsBuildingNavMesh` stayed false for
  that long and the bridge reported `completed` before the build ran (the build
  then started about 15 s later). v34 passes 0 (build now); `TimeoutMs`
  (500-60000, default 15000) is only the bridge's own wait budget.
- Result `Phase`: `completed` only when `IsBuildingNavMesh` was observed true and
  then false, or the newest write time of `NavMesh*.flax` under Content changed
  during the wait (a build too short to observe); `running` when the budget
  elapsed while the build is still running; `queued` when it elapsed before the
  engine started the build (requests enqueue until the next game-scripts update)
  and no new navmesh data was seen. `timeout` is no longer produced. Node reports
  `running` and `queued` as `TIMEOUT` (details `phase`, `progress`, `sceneId`,
  `observedBuilding`) while the build continues in the background; there is no
  cancel API.
- Result DTO `McpNavigationBuildResult` gains `ObservedBuilding` (bool),
  `DataChanged` (bool), and `WaitedMs` (int). `Progress` is 1 for `completed`.
- Headless Editors are now supported: the CPU navmesh build needs no window
  (live-probed on Flax 1.12: tiles built, `NavMeshDefault.flax` saved). The
  play-mode gate (`INVALID_STATE`) stays, and a compile/reload gate
  (`INVALID_STATE` while `ScriptsBuilder.IsCompiling` or not ready) was added.
  `RequireNotPlaying(capability)` is the play-mode half of `RequireEditTime`.
- The engine writes the navmesh data asset itself when a build finishes; the
  bridge still does not save the scene.

### `scene.open` Replace / Reload / DiscardUnsaved
Capability flags `SceneReplaceSupported`, `SceneReloadSupported`. Node requires
bridge v34 for `replace`, `reload`, and `discard_unsaved`.

`McpSceneOpen` gains `bool Replace; bool Reload; bool DiscardUnsaved;`.
`McpSceneOpenResult` gains `string[] UnloadedSceneIds; string DiskSha256;`.

- Exactly one of `AssetId` / `Path` as before. `Replace` and `Reload` are
  mutually exclusive; `DiscardUnsaved` is valid only together with one of them
  (`VALIDATION_FAILED` otherwise). All existing gates still apply first: play
  mode (`INVALID_STATE`), compiling scripts (`EDITOR_BUSY`), active edit leases
  (`EDIT_LEASE_ACTIVE`). A second `scene.open` while a multi-scene reload is
  still loading is refused with `EDITOR_BUSY`. The Editor must also be in a state
  that can change scenes (`EDITOR_BUSY` otherwise).
- Both modes run through the Editor scene state machine
  (`FlaxEditor.States.ChangingScenesState`), the path `SceneModule.OpenScene`
  takes, without its modal "save before closing?" prompt. The bridge refuses
  instead: a scene that would be unloaded with unsaved edits fails with
  `DIRTY_SCENE` (details `DirtyScenes`) unless `DiscardUnsaved:true`.
  `AllowDirtyScenes` never discards edits; it only acknowledges dirty scenes for
  an additive open.
- **Replace** = `ChangeScenes([id], every other loaded scene)`. The target is
  never in the unload list, so an already-loaded target stays loaded and only the
  others close (no other scene loaded: `Phase: "already_loaded"`, nothing
  happens). `Phase: "replacing"`; `UnloadedSceneIds` lists the scenes being
  closed (`N` GUIDs). The call returns once the change started; poll
  `scene.list_loaded` for the result.
- **Reload** re-reads the scene file from disk. Live-verified on Flax 1.12: the
  `SceneAsset` stays cached in `Content` after its scene unloads (it drops after
  about 5-7 s, but any managed `Content.GetAsset` call pins it), and a plain
  close and open, `Level.UnloadScene` + `LoadScene`, the Editor "Reload scenes"
  command, and a same-scene `ChangeScenes` all rebuild the scene from that stale
  cached data. The bridge therefore calls `Reload()` on the cached asset first
  (found by ID with `Content.GetAsset(Guid)`; path-based lookups under a
  different path spelling make Flax re-register the file under a new asset ID and
  are never used), which is safe while the scene is still loaded. Then:
  - the only loaded scene: `ChangeScenes([id], [scene])`;
  - several loaded scenes: `UnloadScene(scene)`, and once the unload finished (a
    later frame, driven by a main-thread poller with a 60 s limit)
    `LoadScene(id, additive:true)`;
  - the scene is not loaded: the normal additive open (honours
    `AllowDirtyScenes` for other edited scenes).

  `Phase: "reloading"`; `DiskSha256` is the SHA-256 (lowercase hex) of the scene
  file as read for this request, so a caller can confirm the reloaded content is
  the file it just edited.
- Warning: the Editor autosave can write a loaded, edited scene back to its
  file. An external edit to a scene file while the scene is open can be
  overwritten; change the file with the scene closed (or reload right after, and
  compare `DiskSha256` with the hash of what you wrote).

### Nested member `Path`
`script.instance_set_value` (`McpScriptFieldSet.Path`), `actor.set_property`
(`McpActorPropertySet.Path`), and `runtime.set_script_value`
(`McpRuntimeScriptValueSet.Path`) accept `string[] Path`, 1-4 C# identifiers
(`^[A-Za-z_][A-Za-z0-9_]*$`, at most 128 characters each; the `Type.Member` form
is not available inside a path). Flag: `NestedMemberPathSupported`.

- When `Path` is given the plain name (`Field` / `Property` / `Member`) must be
  omitted; the bridge accepts it only if it equals `Path[0]`, Node rejects it.
  `Path` always takes the generic member route (never the five legacy
  `actor.set_property` aliases).
- `Path[0]` resolves like a plain member name on the target (script, actor, or UI
  control actor) with the usual v33 rules (`MemberWriteBlockReason`:
  engine-declared script members, Actor base members, unsupported leaf types).
  Every deeper level must be an editor-visible member of the value in front of it
  (the `GenericEditor.GetItemsForType` selection: public or `[ShowInEditor]`,
  never `[HideInEditor]`), and every level must be writable: `[ReadOnly]` or
  setter-less members are refused, and at edit time `[NoSerialize]` members are
  refused too (play-mode `runtime.set_script_value` keeps the runtime rules: no
  `[NoSerialize]` refusal).
- Intermediate levels are a non-engine user struct, or a non-null class instance
  that is not an engine object (`Asset`, `SceneObject`, any `FlaxEngine.Object`),
  array, list, dictionary, or other collection. A null class instance, a
  collection, an engine struct (`FlaxEngine.*`, `System.*`), and members of a
  supported leaf kind (vectors, colors, strings, asset references, brushes, ...)
  are refused. Arrays and lists are not addressable in this version. The leaf
  must be a supported member type and goes through `CoerceMemberValue` like a
  top-level member.
- Write, like the property grid (`CustomEditor.SetValue` / `RefreshInternal` /
  `SyncParent`): the chain of values is read from the root member down, the leaf
  is set on the innermost value (a boxed copy for a struct), then every parent is
  written back to its own member with `ScriptMemberInfo.SetValue`, always, for
  structs and classes alike. Edit time: one snapshot undo record
  (`Undo.RecordBegin` / `RecordEnd`) on the owning script or actor, before and
  after. Runtime: no undo, no scene edit.
- `DryRun` validates the whole path and returns `Before` / `After` of the leaf
  plus the resolved `Path` (member names as declared) with `WouldChange`; nothing
  is written. The result's `Field` / `Property` / `Member` is the dotted resolved
  path and `Type` is the leaf type. A write of the value the leaf already holds
  reports `WouldChange:false` and changes nothing (no undo record, scene not
  marked edited).
- Errors are `VALIDATION_FAILED` with a message beginning `Path segment <index>
  ('<name>'):` and details `{ Path, SegmentIndex, Segment }`.

### `script.instance_set_value` value forms and `script.instance_get` values (v34)
`script.instance_set_value` now runs the `actor.set_property` pipeline instead of
the v28 whitelist (flag `ScriptAssetReferenceWriteSupported`): the member must be
one the property grid shows (properties as well as public fields; `Type.Member`
is still rejected, `Field` stays a plain identifier), `MemberWriteBlockReason` and
the edit-time `[NoSerialize]` refusal apply, and the value is coerced by
`CoerceMemberValue`. Request and response field names, `DryRun` (`WouldChange`,
`Before`, `After`), and the error codes are unchanged. New value forms: asset
references as a 32-hex GUID, a project `Content/...` path, or `engine:<path>`
(`""` clears), actor and script GUIDs, Quaternion (`"x,y,z,w"`), rectangles,
margins, flag enums, brushes, and fonts, that is exactly the `actor.set_property`
shapes. Undo is one snapshot record on the script (instead of the old per-field
action).

`script.instance_get` with `IncludeValues`: asset-reference fields are projected
as `{ Kind: "asset", AssetId: "<N guid>", TypeName }` (a null reference as
`Kind: "null"` with `TypeName`) instead of null plus `Reason`. Values of
user-defined struct and class fields appear as `Value.Kind: "struct"` or
`"object"` with `Value.TypeName` and a `Fields` array (same shape as a top-level
entry), up to two levels deep, at most 32 members per level and 128 nested entries
per field; deeper values and collections stay null with a `Reason`.

### Visject graphs: archetype listing, batched edits, nested and transition contexts
`graph.list_archetypes` and `graph.edit` generalise the root-only graph writes of
v16-v20. Both work on any window-backed graph asset (`AnimationGraph`,
`Material`, `ParticleEmitter`, and new in v34 `MaterialFunction` and
`ParticleEmitterFunction`), on any context of it, and use the same window path as
the older graph tools: the asset's Editor window, `AssetEditorWindow.Save()`, no
headless writes, no direct `.flax` edits. They are gated by
`EnsureGraphEditorReady` (not headless; real runs also not while playing,
compiling, reloading, or importing), by the per-asset edit lease, and by
`IdempotencyKey` exactly like `graph.set_node_values`. Flags:
`GraphArchetypeListSupported`, `GraphEditSupported`,
`MaterialFunctionGraphSupported`.

**`context_path` grammar.** `ContextPath` (Node: `context_path`) is an array of at
most 8 strings walked from the root context. Empty or omitted is the root
context. Each element is one of:

| Element | Meaning |
|---|---|
| decimal surface node id, for example `"4"` | The sub-context owned by that node of the current context (a State Machine node, a State node, a function node, ...). The walk is the one `graph_inspect` uses for sub-contexts: `OpenContext(ISurfaceContext)` on the node. |
| `"transition:<fromStateNodeId>:<toStateNodeId>"` | The rule graph of the transition from state `<from>` (a State or Any node) to state `<to>`, in the current context, which must be a state-machine context. Both ids are decimal. |

A transition is not a surface node, so no node id reaches it. The bridge finds it
through the Editor's internal `Animation+StateMachineStateBase.Transitions` field
and opens it with `OpenContext(transition)`, which is what the Editor's own
`EditRule()` does. This is the user-approved reflection exception described under
"`animgraph.set_transition`"; the lookup is read-only and every member is checked
at run time. A missing member answers `UNSUPPORTED_FLAX_VERSION` and names the
member. Typical errors: `NOT_FOUND` (no node or transition, with the segment
index) and `VALIDATION_FAILED` (node owns no sub-context, malformed element, too
many segments). Every read and write remembers the window's original context
chain and restores it afterwards, also on failure.

**`graph.list_archetypes`.** `McpGraphListArchetypes { AssetId | Path,
ContextPath }` -> `McpGraphArchetypeList { AssetId, ContextKind, Archetypes[],
ExistingNodes[], Warnings[] }`. Read-only. `ContextKind` is `root`,
`state_machine`, `state`, `transition`, or `nested`. An archetype is `{ GroupId,
TypeId, Title, Description, Inputs[{Id,Name,Type}], Outputs[{Id,Name,Type}],
DefaultValueKinds[] }`. `DefaultValueKinds` has one entry per default value slot:
`boolean`, `integer`, `number`, `string`, `vector2/3/4`, `color`, `asset_id` (a
Guid slot), `bytes` (an opaque slot, not writable), or `null`.

Allowed archetype rules (exactly the Editor's menus, live-verified in Flax 1.12):

- Normal contexts (root, state graph, MaterialFunction, particle emitter, ...):
  every archetype with `!NodeFlags.NoSpawnViaGUI` and
  `surface.CanUseNodeType(group, archetype)`. Counts seen: AnimationGraph root and
  state 180, Material 203, MaterialFunction 205, ParticleEmitter 155 (particle
  modules are group 15).
- A state-machine context offers only `(9,20)` State and `(9,34)` Any. The bridge
  reads the private static `AnimGraphSurface.StateMachineGroupArchetypes` by
  reflection when present and otherwise uses those two ids.
- A transition rule context offers the normal list plus `(9,23)` Transition
  Source State Anim. The bridge reads
  `AnimGraphSurface.StateMachineTransitionGroupArchetype` when present and
  otherwise uses `(9,23)`.

`SpawnNode` itself enforces none of this, so `graph.edit` checks every `add_node`
against the same list. `ExistingNodes` is `McpGraphNodeDto[]` (id, group, type,
title, position, value count) of the context: use it to find a node id that
already exists, for example the Rule Output node of a transition rule graph (a
fresh rule graph has it with id 1).

**`graph.edit`.**

```text
McpGraphEdit { AssetId | Path, Ops[1..64], DryRun = true, Confirm, LeaseId, IdempotencyKey }
McpGraphEditOp { Op, ContextPath, Ref, GroupId, TypeId, X, Y, Values[], NodeId, FromNodeId, FromBoxId, ToNodeId, ToBoxId }
McpGraphEditResult { AssetId, DryRun, Saved, Ops[], Refs[], ProjectRevision, Warnings[] }
McpGraphEditOpResult { Index, Op, Ref, NodeId, Applied, Warnings[] }
```

Every op carries its own `ContextPath`, so one batch can touch several contexts.
Ops run in order.

| `Op` | Fields | Behaviour |
|---|---|---|
| `add_node` | `GroupId`, `TypeId`, `X`, `Y`, optional `Ref`, optional `Values` | Checks the archetype against the context's allowed list, coerces `Values` before spawning, then `SpawnNode`. `Ref` (`$name`) binds the new node for later ops of the same batch and context. Particle modules are plain `add_node` of group 15 in the emitter context. |
| `connect` | `FromNodeId/FromBoxId`, `ToNodeId/ToBoxId` | One endpoint must be an output box and the other an input box (either order). `Box.CanConnectWith`, then the Editor's undo-aware `Box.Connect`, then the wire is verified. An existing wire is refused. In a state-machine context, connecting two states (State or Any to a State) creates a transition instead (box ids are ignored, use 0). |
| `disconnect` | same fields | The wire must exist. Uses the same Editor connect toggle, so it is undo-aware. Removing a state transition is not supported. |
| `set_values` | `NodeId`, `Values[{Index, Value}]` | Same value coercion as `graph.set_node_values`, applied with one `SetValues`. |
| `move` | `NodeId`, `X`, `Y` | Moves the node; the bridge records its own undo step. |
| `remove` | `NodeId` | Undo-aware delete with its wires; engine-protected (`NoRemove`) nodes are refused. |

`NodeId`, `FromNodeId`, and `ToNodeId` are a decimal id or a `$ref`; a `$ref` is
valid only in the context where `add_node` created it. Node ids of `add_node` ops
are assigned when the batch is applied (dry runs report `NodeId: null`); use
`Refs[]` or `Ops[].NodeId` of the real result.

**Value layouts.** Values are `{ Index, Value }` entries using the
`graph.set_node_values` value shapes (`boolean`, `number` / `integer`, `string`,
`vector2/3/4`, `color`, `asset_id`):

- `asset_id` fills a Guid slot. An all-zero id clears it. A Guid slot also
  accepts one of the graph's own parameter ids (from `graph_inspect`
  `Parameters[].Id`), which is how the Get Parameter node `(6,1)` is bound:
  value 0 = the parameter id.
- A `vector4` fills a `Float4` slot.
- Animation `(9,2)`: `[Guid clip, float speed, bool loop, float start]`. (The v33
  comment that said `[null, float, int, float]` was wrong.)
- Slot `(9,32)`: `[string slot name]`.
- Multi Blend 1D `(9,12)` and 2D `(9,13)`: `[Float4 range, float speed, bool loop,
  float start]`, then for blend point `i` `[4+2i] Float4(x, y, 0, speed)` and
  `[5+2i] Guid clip`. 1D ranges use X/Y of the first Float4, 2D uses all four. A
  node starts with one empty point. These are the only nodes that can grow:
  setting an index past the end appends whole point pairs (missing slots default
  to `Float4(0,0,0,1)` and an empty clip) up to 255 points. The Node tool limits
  value indexes to 64 and 32 entries per op, so a Node call sets at most about 30
  points per node.
- State `(9,20)`: `[string name, bytes, bytes]`; only the name is writable.

**Dry run and real run.** `DryRun` (default true) runs the whole batch as a
validation pass against the live window and reports `Ops[]` with warnings, `Refs[]`
and no ids. It changes nothing, saves nothing, and leaves the window on its
original context. Checks it makes: op shape, context paths, node and box
existence, ref use, archetype allowed, value slots and types, wire direction, and
(for nodes that already exist and no earlier op touched) box compatibility.
Anything that depends on nodes created in the same batch (box types of new nodes,
a transition created by an earlier op) is checked when the batch is applied.

A real run needs `DryRun:false` and `Confirm:true`. It runs the validation pass
again, applies the ops in order, marks every context on each op's path modified
(`VisjectSurfaceContext.Save` only descends into children with `IsModified`), then
calls `AssetEditorWindow.Save()` once. If an op fails, the bridge flushes the
surface's batched undo actions, rewinds the window's undo stack to where the batch
started, saves nothing, and answers the op's error code with `graph.edit op <i>
(<op>) failed: <reason>`, `Details { OpIndex, Op, RolledBack, Saved:false }`. If
the undo stack cannot rewind (no undo stack), `RolledBack` is false and the
message says the edits stay in the window unsaved. After a successful batch the
window undo stack holds the batch as one entry; saving cannot be undone. The
undo-aware pieces: `add_node`, `set_values`, `remove`, `connect`, `disconnect`,
and state links use the Editor's own undo actions; `move` uses a bridge-owned
action because `Control.Location` records none.

**MaterialFunction windows.** `MaterialFunction` windows (and
`ParticleEmitterFunction`, which shares the base class) are `AssetEditorWindow`s
with a public `Surface` but are not `IVisjectSurfaceWindow`: the bridge uses that
`Surface`, readiness is `Surface.Enabled` plus the cloned asset being loaded, and
saving is `AssetEditorWindow.Save()`. This applies to `graph_inspect`,
`graph_list_archetypes`, `graph_edit`, and the older graph writes. Function
windows have no parameters, so `graph_add_parameter` answers
`UNSUPPORTED_FLAX_VERSION` for them. `AnimationGraphFunction`, VisualScript, and
BehaviorTree stay out of scope. (`ParticleEmitterFunction` shares
`MaterialFunction`'s base class but was not separately live-verified.)

**Worked example: a state machine with an `Any -> Dead` transition rule
`State == 3`.** Assumes an AnimationGraph `Content/Anim/Zombie.flax` that already
has an integer parameter `State` (`graph_add_parameter` with `type: "integer"`).
Arguments are the Node tool's snake_case; every write shown uses
`dry_run:false, confirm:true`, and each step is best run once as a dry run first.

1. Add the state machine node at the root (group 9, type 18) and read its id from
   the real result (`ops[0].node_id`, say `10`):

```json
{ "path": "Content/Anim/Zombie.flax",
  "ops": [{ "op": "add_node", "ref": "$sm", "group_id": 9, "type_id": 18, "x": 200, "y": 100 }],
  "dry_run": false, "confirm": true }
```

2. In the state machine context add two states and the Any node, and wire the Any
   node to Dead. States are named through value 0; connecting states creates the
   transition. Read the new ids from `refs` (say `$idle=11`, `$dead=12`,
   `$any=13`):

```json
{ "path": "Content/Anim/Zombie.flax",
  "ops": [
    { "op": "add_node", "context_path": ["10"], "ref": "$idle", "group_id": 9, "type_id": 20, "x": 100, "y": 100,
      "values": [{ "index": 0, "value": "Idle" }] },
    { "op": "add_node", "context_path": ["10"], "ref": "$dead", "group_id": 9, "type_id": 20, "x": 400, "y": 100,
      "values": [{ "index": 0, "value": "Dead" }] },
    { "op": "add_node", "context_path": ["10"], "ref": "$any", "group_id": 9, "type_id": 34, "x": 250, "y": -80 },
    { "op": "connect", "context_path": ["10"], "from_node_id": "$any", "from_box_id": 0, "to_node_id": "$dead", "to_box_id": 0 }
  ],
  "dry_run": false, "confirm": true }
```

3. Find the Rule Output node of the new transition rule graph and the archetype
   ids allowed there (`graph_list_archetypes`):

```json
{ "path": "Content/Anim/Zombie.flax", "context_path": ["10", "transition:13:12"] }
```

   `existing_nodes` lists `Rule Output` (group 9, type 22, id `1`); `archetypes`
   includes Get Parameter `(6,1)`, `==` `(12,1)`, and Integer `(2,2)`. Get the
   `State` parameter id from `graph_inspect` (`Parameters[].Id`, say `P`).

4. Build `State == 3` in the transition's rule graph and wire it to Rule Output
   box 0 (`Can Start Transition`):

```json
{ "path": "Content/Anim/Zombie.flax",
  "ops": [
    { "op": "add_node", "context_path": ["10", "transition:13:12"], "ref": "$get", "group_id": 6, "type_id": 1, "x": -400, "y": 0,
      "values": [{ "index": 0, "value": { "asset_id": "<P>" } }] },
    { "op": "add_node", "context_path": ["10", "transition:13:12"], "ref": "$eq", "group_id": 12, "type_id": 1, "x": -200, "y": 0 },
    { "op": "add_node", "context_path": ["10", "transition:13:12"], "ref": "$three", "group_id": 2, "type_id": 2, "x": -400, "y": 120,
      "values": [{ "index": 0, "value": 3 }] },
    { "op": "connect", "context_path": ["10", "transition:13:12"], "from_node_id": "$get", "from_box_id": 0, "to_node_id": "$eq", "to_box_id": 0 },
    { "op": "connect", "context_path": ["10", "transition:13:12"], "from_node_id": "$three", "from_box_id": 0, "to_node_id": "$eq", "to_box_id": 1 },
    { "op": "connect", "context_path": ["10", "transition:13:12"], "from_node_id": "$eq", "from_box_id": 2, "to_node_id": 1, "to_box_id": 0 }
  ],
  "dry_run": false, "confirm": true }
```

   Transition settings (blend time, `use_default_rule`, interruption) are
   `animgraph_set_transition`. The default (entry) state of the machine and each
   state's clip are separate steps (`animgraph_set_state_clip`, or `graph_edit`
   inside the state context `["10", "11"]` with an Animation node `(9,2)` whose
   value 0 is the clip id wired to the State Output node). The box ids above
   (`==` boxes 0 and 1 inputs and 2 output; Get Parameter output 0; Integer
   output 0) are the ones the Flax 1.12 live probe used; `graph_list_archetypes`
   returns the authoritative box ids for any other node.

### `animgraph.set_transition` and the reflection exception
`animgraph.set_transition` `{AssetId?|Path?, StateMachineNodeId?,
FromStateNodeId, ToStateNodeId, BlendDuration?, BlendMode?, Enabled?, Solo?,
UseDefaultRule?, Interruption?, Order?, DryRun = true, Confirm, LeaseId?,
IdempotencyKey?}` changes the settings of one **existing** state-machine
transition. Create the transition first with `animgraph.add_transition`; the
conditional rule graph of a transition is built with `graph.edit` (`ContextPath`
`"transition:<from>:<to>"`). Flag: `AnimgraphTransitionSettingsSupported`.

- Selection: the state machine is `StateMachineNodeId` (decimal node id of a
  `(9,18)` node in the root context) or, when omitted, the first one, exactly as
  `animgraph.add_transition` does. `FromStateNodeId` and `ToStateNodeId` are
  decimal node ids inside that state machine; the transition is the entry of the
  source state's `Transitions` list whose destination is `ToStateNodeId`. A
  missing machine, state, or transition answers `NOT_FOUND`.
- Fields (all optional, at least one required; omitted fields are left alone):
  - `BlendDuration` seconds, finite, 0 to 20 (the Editor's own limit).
  - `BlendMode` an `AlphaBlendMode` name (`Linear`, `Cubic`, `HermiteCubic`,
    `Sinusoidal`, `QuadraticInOut`, ...), matched by name, case-insensitive;
    numbers are refused.
  - `Enabled`, `Solo`, `UseDefaultRule` booleans.
  - `Interruption` string array of `RuleRechecking`, `Instant`, `SourceState`,
    `DestinationState`; `[]` clears every flag.
  - `Order` integer; transitions with a higher order are evaluated first. The
    bridge accepts -1000000 to 1000000, the Node tool schema -1024 to 1024. If
    the Editor build has no `Order` member the bridge answers `VALIDATION_FAILED`
    naming `Order` for that field only.
- Result: `{AssetId, StateMachineNodeId, FromStateNodeId, ToStateNodeId, Before,
  After, DryRun, WouldChange, Saved, ProjectRevision, Warnings}` where `Before` /
  `After` are `{BlendDuration, BlendMode, Enabled, Solo, UseDefaultRule,
  Interruption[], Order}`. `Before` is read from the live transition. A dry run
  (the default) returns the planned `After` without writing and without saving. A
  request that changes nothing is a no-op (`WouldChange:false`, `Saved:false`). A
  real write needs `DryRun:false` and `Confirm:true`, honors the per-asset edit
  lease and idempotency key, reads `After` back from the live transition, and
  persists with `AssetEditorWindow.Save()` (not undoable after the save). Gates are
  the same as `animgraph.add_transition` (`EnsureGraphEditorReady`,
  play/compile/import busy refusal, `INVALID_STATE` + `NotReady` retry contract).

**Reflection exception (user-approved).** Flax exposes no public API for
state-machine transitions, so `animgraph.set_transition` and the `transition:`
context walk are the one bridge path that reaches `FlaxEditor` internals by
reflection (live-verified on Flax 1.12). The members used:

| Member | Use |
|---|---|
| `FlaxEditor.Surface.Archetypes.Animation+StateMachineStateBase` (type) | the source state node is an instance of it |
| `Animation+StateMachineStateBase.Transitions` (field, `List<StateMachineTransition>`) | enumerate the transitions of the source state |
| `Animation+StateMachineTransition` (type) and field `DestinationState` | match the destination state node id |
| `Animation+StateMachineTransition.BlendDuration` (float), `BlendMode` (enum), `Enabled`, `Solo`, `UseDefaultRule` (bool), `Interruption` (flags enum) | read before-values and set through the property setters |
| `Animation+StateMachineTransition.Order` (int, optional) | same; the only optional member |
| `Animation+StateMachineTransition+InterruptionFlags` names `RuleRechecking`, `Instant`, `SourceState`, `DestinationState` | each name is verified at runtime |

Every member is checked at runtime before any window is touched; the bridge
answers `UNSUPPORTED_FLAX_VERSION` with `details.Member` naming the first missing
member (for example `Animation+StateMachineStateBase.Transitions`) and changes
nothing. The bridge never encodes the transition byte blob and never calls
`SaveTransitions` itself: the Editor's property setters call
`SaveTransitions(withUndo:true)`, so one write is one batched Editor undo entry,
then the window save runs like every other graph write. If a setter throws,
already applied fields are reverted and nothing is saved. A contract test
(`bridgeV34TransitionContract.test.ts`) pins the existence checks and the
setter-only write path.

### `asset.create`: GameplayGlobals
`asset.create` now accepts `Kind: "GameplayGlobals"` with `Variables: [{Name,
Type, Value}]`. Flag: `GameplayGlobalsCreateSupported`.

- `Editor.CreateAsset("GameplayGlobals")` fails in Flax 1.12. The bridge uses the
  path the Content Browser uses (`GameplayGlobalsProxy.Create`):
  `Content.CreateVirtualAsset<GameplayGlobals>()`, `Save(destination)`, destroy
  the virtual asset. With variables it then loads the new asset, copies
  `DefaultValues`, adds the entries, assigns the dictionary back (the getter
  returns a copy), and calls `Save()`, the same sequence
  `GameplayGlobalsWindow.Save` performs.
- `Variables` is only valid with this kind (`VALIDATION_FAILED` otherwise, even
  when empty). At most 64 entries. `Name` is 1 to 128 characters without control
  characters and unique (ordinal). `Type` is one of `float`, `int`, `bool`,
  `Float2`, `Float3`, `Float4`, `Color` (case-insensitive on input); anything else
  is refused. `Value` is parsed with the invariant culture: `float` `1.5`, `int`
  `3`, `bool` `true` / `false`, vectors comma-separated (`"1,2"`, `"1,2,3"`,
  `"1,2,3,4"`, optional surrounding parentheses or brackets), `Color` `"r,g,b"` or
  `"r,g,b,a"` (alpha defaults to 1). Everything is validated before the dry-run
  answer; invalid variables never create a file.
- Conventions are those of every v33 creation: `Content/` destination with
  `.flax`, never overwrites (`FILE_EXISTS`), `DryRun` then `Confirm:true`,
  content database refresh, result `Asset` metadata from the created-asset helper
  (ID read from the file header if the registry has not listed it yet), no Editor
  undo record. The file is saved under the engine path spelling
  (`EngineAssetPath`), so no duplicate asset ID is registered. If any step after
  the first save fails, the half-created file is deleted and
  `ASSET_OPERATION_FAILED` is returned.
- The Node server requires bridge v34 only for `kind: "GameplayGlobals"`; the
  other kinds still work on v33.

### GUID forms
Three spellings of the same 16 bytes occur around a project:

| Form | Where | Layout |
|---|---|---|
| raw header bytes | `.flax` header, 16 bytes at offset `0x1c` (magic `CFWF`) | four little-endian `uint32` words A, B, C, D |
| managed "N" | the bridge (`asset.get`, every `AssetId` field), all tool inputs and outputs | `new Guid(rawBytes).ToString("N")` |
| native "N" | `.scene`, `.prefab`, `.json` text, the engine `Register asset` log | A, B, C, D each printed as `%08x` (each 4-byte group of the raw bytes reversed) |

Conversion between managed and native is an involution: keep the first 8 hex
digits (word A), swap the two 4-digit halves of the second word, and reverse the
bytes of the third and fourth words independently. `src/guid.ts` implements
`nativeToManaged`, `managedToNative`, and `headerBytesToManaged` (raw header bytes
to managed). Vector (AR15, `docs/GUID_AUDIT_P7.md`): raw
`36b2fba2c2103341abe253a0c8d1839c`, managed `a2fbb23610c24133abe253a0c8d1839c`,
native `a2fbb236413310c2a053e2ab9c83d1c8`. Verified against `flax-test/Content`:
native-form references to 44 binary assets in scenes, prefabs, and JSON matched
the converted header GUIDs, and none matched the managed spelling.

Rules:
- Tools print and accept managed IDs. A native ID typed into a tool field is a
  different GUID.
- The offline readers (`list_assets`, `get_asset_info`, `read_settings`,
  `validate_project`) print the managed form for `.flax` headers and for IDs found
  in `.scene` / `.json` files, so an offline ID matches what `asset_get` returns.
  Before v34 they printed the raw header hex, which is a third spelling.
- The legacy offline `create_actor` / `modify_actor` accept a managed `parent_id`
  / `actor_id_or_name` (the native spelling also works) and write native IDs into
  the scene file.
- Hand-written `.scene` / `.prefab` / `.json` content must use the native
  spelling; a managed spelling only resolves through the bridge and is fragile.
- `validate_project` (FLAX002) converts native scene references before comparing
  them with the `.flax` headers; a reference to an existing binary asset is no
  longer reported missing. Findings carry `assetId` (managed) and `assetIdNative`
  (as written in the file).

### Headless workflow
A headless Editor (`-headless`) runs the bridge like a headed one, and
`status.IsHeadless` tells a client which mode it is talking to. The refusals come
from the bridge's `IsHeadlessMode` gates and are mapped to `HEADLESS_MODE` (see
"Headless refusals and timeouts (Node mapping)").

- Works headless: `editor_get_status` (including `wait_ready`), `editor_quit`,
  `editor_options`, `code_compile` / `code_get_diagnostics` /
  `code_generate_project`, logs, asset search / import / reimport / organize /
  create and import settings (import success still depends on the installed
  importer backend), content folder creation, project-settings writes, scene
  create / open / close / save / list, scene file edits, `actor_create` /
  `actor_update` / `actor_delete`, `script_attach` / `script_detach`, `edit_undo`,
  the member reads (`actor_get_properties`, `ui_control_get_properties`,
  `script_instance_get`), the physics, navigation, lighting, and terrain/foliage
  read queries, and `navigation_build` (new in v34).
- Refused headless with `HEADLESS_MODE`: play start (`play_start_scenes`,
  `play_start_game`, `test_run_scenario`), `editor_set_selection`, viewport
  capture, the Visject graph tools (`graph_inspect`, `graph_list_archetypes`,
  `graph_edit`, graph writes, `graph_undo`, `animgraph_*` writes), the member
  writes that need Editor windows (`actor_set_property`,
  `script_instance_set_value`, `ui_control_*` writes, `particle_set_parameter`,
  material writes), the other bakes (`lighting_bake`, `environment_probe_bake`),
  and foliage writes.
- Typical cycle for an agent driving a headless Editor: `editor_launch` (when the
  server runs with `--flax-editor`) -> `editor_get_status` with `wait_ready:true`
  -> edit and `code_compile` -> `editor_quit` (`unsaved:"save"` or `"discard"`,
  `stop_play:true` if needed) when done or before replacing the bridge file.

### Error mapping addendum (Node)
- Remote `UNAUTHORIZED` (the bridge session token changed because the Editor
  reloaded scripts, another Editor took over `Cache/MCP`, or another Editor
  answered this project's bridge) maps to `EDITOR_BUSY` with `details: {
  retryable: true, reason: "bridge_session_changed", details }`. Reads may be
  repeated; writes are never retried automatically (use an idempotency key, or
  re-read state first).
- The shared mapper also maps `IMPORT_SOURCE_NOT_ALLOWED`, `IMPORT_FAILED`,
  `FILE_EXISTS`, and `OPERATION_NOT_FOUND` to the same-named tool error codes, and
  `DIRTY_SCENE` to `DIRTY_SCENES`.
- A `TIMEOUT` on a write still means the outcome is unknown. A timed-out
  `asset_import` start returns `operation_id` in `error.details`; poll
  `asset_import_status` with it.

### Node-only surfaces (no bridge method)
- `editor_launch` (enabled with the server flag `--flax-editor <FlaxEditor.exe>`)
  runs `FlaxEditor.exe -project <project path>` with `-headless` and / or
  `-skipcompile` only when requested; no other argument can be passed. The process
  is detached with stdio ignored and its pid returned. It refuses with
  `EDITOR_BUSY` when this project's `Cache/MCP/bridge.json` heartbeat is live or a
  `FlaxEditor` process already has `-project <this project>` on its command line.
  With `wait_ready` (default true) it polls the heartbeat until it is live
  (`timeout_ms`, default 120000, at most 300000); a timeout (`TIMEOUT`) leaves the
  Editor running, an Editor that exits first yields `EDITOR_NOT_CONNECTED`.
  Without the flag it answers `UNSUPPORTED_FLAX_VERSION` naming the flag.
- `flax-mcp call <tool> [json | @file | -]` and `flax-mcp tools [--json]` run the
  same registry, schema validation, permission policy, and bridge client as the
  server from a shell, so scripts need no raw `Cache/MCP/requests` writes (see the
  README "Command line" section).

## Runtime bridge (v35): a cooked game, a second bridge file (177-tool contract)

Server 1.13.0 registers 177 tools: the 175 of v34 plus `game_launch`,
`game_list_instances`, and `game_stop`, minus the game-specific
`mm_apply_preset`, which was removed afterwards (no bridge change). The
Editor bridge stays at v34 and does not change. `bridge/FlaxMcpRuntimeBridge.cs` is a second, self-contained bridge
that runs inside a cooked Development game. It reports `BridgeVersion` 35 and
`Kind` `"game"`, keeps protocol v1, and carries a first-line
`// MCP-BRIDGE-VERSION: 35` marker like the Editor file (34). Nothing from v1 to
v34 changes for an Editor client.

### Purpose and safety
- It is a `GamePlugin` (`FlaxMcpRuntimeBridgePlugin`) for debugging and driving a
  running game from the MCP server: script-member writes and method calls, actor
  inspection, captures, logs, time scale, performance, and a clean quit.
- The whole file is inside `#if FLAX_GAME && !BUILD_RELEASE` and, defensively,
  `#if !FLAX_EDITOR`. The Editor bridge is `#if FLAX_EDITOR`, so the two files
  never compile together (which is why the runtime file may reuse the Editor
  bridge's DTO class names). A Release game build, including a Release cook,
  contains none of it; it also compiles to nothing in the Editor.
- It is inert without `-mcpdir`. Like the Editor bridge it uses files only, opens
  no network listener, and requires the per-start session token on every request.
- `install_editor_bridge` with `include_runtime:true` copies it next to
  `FlaxMcpBridge.cs` (see the README). The installer reads the installed version
  from `BridgeVersion = 35`.

### Activation
- `Initialize` does nothing unless `Engine.CommandLine` contains
  `-mcpdir=<absolute path>`. The value may be unquoted, quoted as a whole argument
  (`"-mcpdir=C:\a b\c"`, the form Node produces on Windows for a path with
  spaces), or quoted after the equals sign (`-mcpdir="C:\a b\c"`). The switch name
  is matched case-insensitively and must be its own argument.
- A missing value, a relative path, or a path longer than 240 characters logs a
  warning and the bridge stays inert.
- `-mcpinstance=<name>` must match `[A-Za-z0-9_-]{1,64}`. The default, and the
  fallback for an invalid name (with a warning), is the process id.
- If the directory already holds a heartbeat from another process that is alive
  and younger than 30 s, the bridge stays inert and warns. The leftovers of a dead
  process are replaced.
- On deinitialize the bridge deletes `bridge.json` and `token` when they are its
  own (the heartbeat pid is this process).

### Directory and transport
`<mcpdir>` is the instance directory itself. The MCP server passes
`<project>/Cache/MCP-Runtime/<instance>` (`RUNTIME_BRIDGE_CACHE_DIRECTORY =
'Cache/MCP-Runtime'`). The layout is the Editor's: `requests/`, `processing/`,
`responses/`, `captures/`, `token`, `bridge.json`. The transport is the Editor's
unchanged: request `{ id, token, method, paramsJson, deadlineUnixMs }` (the same
64 KiB and 128 KiB caps and 60 s deadline rule), response `{ id, token, ok,
errorCode, error, errorDetails, resultJson, timestamp }` (512 KiB result cap,
`RESPONSE_TOO_LARGE`), the request claimed by moving it into `processing/`, the
response published with a temporary file plus rename, a fresh 256-bit token on
every start, a heartbeat every two seconds, and at most four requests picked up
per poll. Work that touches the engine runs on the game's update thread
(`Scripting.InvokeOnUpdate`) and is bounded by the request deadline.

### Heartbeat and status
`bridge.json` is `McpRuntimeBridgeInfo { BridgeVersion = 35, ProtocolVersion = 1,
Kind = "game", Pid, Instance, ProductName, EngineVersion, Timestamp }`
(`Timestamp` is Unix milliseconds). There is no project path: the directory is the
identity.

`status` returns `McpRuntimeStatus { BridgeVersion, ProtocolVersion, Kind, Pid,
Instance, ProductName, EngineVersion, FrameCount, TimeScale, LoadedSceneCount,
Methods }`. `Methods` is the list below. An unknown method answers
`METHOD_NOT_FOUND` with `{ Method, Methods }` in the error details.

### Methods
Request and response DTOs, field names, and error codes are the Editor bridge's
wherever the method exists there.

| Method | Notes |
|---|---|
| `status` | `McpRuntimeStatus` as above |
| `runtime.set_script_value` | `McpRuntimeScriptValueSet` / `McpRuntimeScriptValueResult`, including the nested `Path` (1-4 member names, `Member` omitted). No play-mode gate (the game is always running); `PlaySessionId` is always null |
| `runtime.invoke_script_method` | At most 4 scalar arguments, overloads chosen by argument count (two overloads with the same count are refused). A game exception comes back as data (`Threw`, `ExceptionType`, `ExceptionMessage`), not as an error |
| `runtime.inspect_actor` | `McpRuntimeActorInspect` -> `McpRuntimeActorInspection`; `Depth` 0-4; `ProjectRevision` and `SceneRevision` are 0 (there is no editing session) |
| `capture.start` / `capture.status` | `Screenshot.Capture(<instance>/captures/<id>.png)`. `Viewport` must be `"game"` (empty and `"main"` are accepted as the same viewport); a non-zero `Width` or `Height` is `VALIDATION_FAILED`, so the size is fixed (Flax 1.12 main-render capture) and cannot be chosen. `capture.status` reports `Phase` `Pending`, then `Completed` once the file exists with size > 0; `Path` is `captures/<id>.png`, relative to the instance directory. An id this session did not start is `NOT_FOUND`. At most 64 captures are kept, none older than 24 h |
| `log.query` | The Editor's `McpLogQuery` / `McpLogQueryResult`, fed by a ring of 2000 entries from `Debug.Logger.LogHandler` (`SendLog`, `SendExceptionLog`). `Category` is always `"engine"` and `PlaySessionId` is always null (a game has no play sessions). The project folder and the instance directory are redacted from messages and stacks |
| `play.set_time_scale` | `Time.TimeScale`, 0 to 10 (else `VALIDATION_FAILED`); returns `McpRuntimePlayStatus { State, IsPlayMode, IsPaused, FrameCount, TimeScale, PreviousTimeScale }` |
| `perf.snapshot` | The Editor's `McpPerfSnapshot`; `IsPlayMode` is always true |
| `game.quit` | Answers `McpRuntimeQuitResult { Accepted, Phase = "exiting", Pid }` first. `Engine.RequestExit()` runs from the update loop on a later frame, after the response file is on disk (or after 5 s at the latest) |

### Differences from the Editor contract
- **System.Reflection, not ScriptMemberInfo.** A game build has no `FlaxEditor`
  types (`ScriptType`, `ScriptMemberInfo`). The v28 rule that script members are
  resolved through `ScriptMemberInfo` only applies to the Editor bridge; the
  runtime bridge resolves members with `System.Reflection`.
- **Visible members.** Only public instance fields and properties declared by game
  types are visible, found by walking up the base chain until the first engine or
  framework type (a type whose full name starts with `FlaxEngine.`, `FlaxEditor.`,
  `System.`, or `Microsoft.`). Members of engine base classes (`Enabled`, `Actor`,
  lifecycle methods) are never writable or invocable. `[HideInEditor]` members are
  hidden; `[ReadOnly]` members and members without a public setter are read-only.
  Non-public `[ShowInEditor]` members are not visible (the Editor shows them).
  Invocable methods are public, non-generic instance methods declared in game
  types.
- **Writable value types.** bool, integers, float and double, string, enum (name,
  or a defined number), Guid (32 hex), `Vector2/3/4`, `Float2/3/4`, `Color`,
  `Quaternion`, asset references by 32-hex GUID (`Content.LoadAsync(Guid, Type)`;
  an empty string clears), and actor and script references by GUID. There is no
  `Content/...` path and no `engine:` lookup in a cooked game. Asset values are
  reported as GUID and type only.
- **No persistence machinery.** `[NoSerialize]` is not refused (nothing is
  saved). There is no undo, no revision counter, no edit lease, and no dry run; a
  write is gone when the game exits.
- **No input injection.** The runtime bridge has no `input.*` methods. Flax 1.12
  exposes no managed key or mouse injection API (`FlaxEngine.Input` is read-only
  from C#), and the bridge stays managed-API-only and never uses OS-level input;
  the Editor bridge's `input_key_press` and `input_mouse_click` are
  `UNSUPPORTED_FLAX_VERSION` for the same reason. Drive a cooked game through its
  own script methods and members.
- **No play state.** There are no play, pause, or play-session methods and no
  headless gate, so the Editor play-mode and headless refusals do not occur.

### Node side
- **Heartbeat validation (`inspectRuntimeBridge`).** An instance is connected only
  when `bridge.json` parses with `Kind` `"game"`, an `Instance` equal to the
  directory name (when present), a positive `Pid` whose process is alive, and a
  `Timestamp` no older than 30 s and not more than 5 s in the future. The client
  then requires `ProtocolVersion` 1 and `BridgeVersion` >= 35, else
  `BRIDGE_UNSUPPORTED`. A missing `bridge.json` is retried briefly while the token
  exists (the replace window), as for the Editor. One request at a time is allowed
  per instance directory (`BRIDGE_CONCURRENT_CALL`); different instances run in
  parallel. Instance names are validated (`^[A-Za-z0-9_-]{1,64}$`) before any path
  is built, so a name can never leave `Cache/MCP-Runtime`.
- **Routing by `instance`.** `runtime_set_script_value`,
  `runtime_invoke_script_method`, `runtime_inspect_actor`, `viewport_capture`
  (only `viewport:"game"`), `log_get_recent`, `log_search`,
  `log_get_runtime_errors`, `perf_get_snapshot`, and `play_set_time_scale` accept
  an optional `instance`. With it the same request DTOs go to that game's runtime
  bridge: no Editor, play mode, or headless gate applies, `PlaySessionId` is never
  sent (`play_session_id` together with `instance` is `INVALID_ARGUMENT`), and the
  scene-revision and edit-lease fields do not exist. Without `instance` nothing
  changes. `status` and `game.quit` are reached only through `game_launch` and
  `game_stop`.
- **Captures.** For `viewport_capture` with `instance`, Node calls `capture.start`
  with `Viewport:"game"` only, polls `capture.status` until `Phase` is completed,
  validates the file (a regular file inside `<instance>/captures`, PNG signature,
  at most 16 MiB), copies it to `Cache/MCP/captures/<new 32-hex id>.png`, deletes
  the source, and answers with `flax://capture/<new id>`, so the existing resource
  reader, size limit, and 24 h expiry apply.
- **`GAME_NOT_CONNECTED`.** For a runtime call, `BRIDGE_UNAVAILABLE` and
  `BRIDGE_AUTH_FAILED` (no live heartbeat, a dead or hung process, a missing or
  changed token) map to the new tool error code `GAME_NOT_CONNECTED`, the game
  counterpart of `EDITOR_NOT_CONNECTED`. Everything else maps like the Editor
  (`mapRuntimeBridgeError` delegates to the shared mapper), so a remote
  `INVALID_STATE` keeps the `EDITOR_BUSY` meaning ("retry later") and a capture
  refusal is `CAPTURE_UNAVAILABLE`.
- **Envelope mode.** The tool envelope `mode` is `offline`, `editor-connected`, or
  `game-connected` (new). A call that reached a game is `game-connected`.
- **Node-only tools.** `game_launch`, `game_list_instances`, and `game_stop` wrap
  the runtime-only methods. `game_launch` (enabled with `--allow-game-launch`,
  parsed next to `--flax-editor`, so also by `flax-mcp call`) resolves `exe` with
  `realpath` against the realpath of the project root and refuses anything outside
  it, a non-file, and (on Windows) a non-`.exe`. It starts the process detached,
  with stdio ignored and the exe's folder as the working directory, with exactly
  `-mcpdir=<absolute instance dir> -mcpinstance=<name>` followed by up to 32
  validated switches (`-name` or `-name=value`, never `-mcpdir` or `-mcpinstance`
  in any letter case). It first clears a stale `bridge.json` and `token` of that
  instance and refuses with `EDITOR_BUSY` when the instance already has a live
  heartbeat or was started by this server and still runs. The pid is remembered in
  a process-local set until the child exits. With `wait_ready` (default true) it
  polls the heartbeat every 250 ms and then calls `status`; a child that exits
  first is `GAME_NOT_CONNECTED`, a missed `timeout_ms` is `TIMEOUT` (the game keeps
  running). `game_stop` sends `game.quit`, waits for the pid to exit, and with
  `force:true` kills only a pid in the launched set (any other instance is
  `PERMISSION_DENIED` before anything is sent). `game_list_instances` reads the
  heartbeat files only and never returns a path.

### Smoke builds
```
dotnet build test/flax-api-smoke/RuntimeBridgeCompileSmoke.csproj -nologo -v:minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Source\Platforms\Windows\Binaries\Game\x64\Development\FlaxEngine.CSharp.dll'
dotnet build test/flax-api-smoke/RuntimeBridgeCompileSmoke.csproj -nologo -v:minimal -p:RuntimeBuildConfig=Release -p:FlaxEngineCSharpPath='...same dll...'
```
The first compiles the file with `FLAX_GAME;BUILD_DEVELOPMENT` against the game
assembly (no `FlaxEditor` namespace). The second (`BUILD_RELEASE`) must build with
0 warnings too and produces an assembly with no types. The Editor smoke
(`BridgeCompileSmoke.csproj`, `FLAX_EDITOR`) lists its one source file explicitly
and is unaffected. A live run of a cooked Development build is not yet recorded;
`test/compatibility-matrix.json` declares the v35 surface as pending live
verification.
