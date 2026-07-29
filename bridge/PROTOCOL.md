# Flax MCP Editor Bridge protocol (bridge v9 / protocol v1)

`FlaxMcpBridge.cs` is an Editor-only Flax 1.12 plugin. It uses only files below
`<project>/Cache/MCP`; it does not open a network listener.

At startup the bridge creates `requests/`, `processing/`, and `responses/`, then
writes these project-local files:

- `bridge.json`: `{ "BridgeVersion": 9, "ProtocolVersion": 1, "Pid": 123, "Project": "...", "EditorVersion": "1.12.6912", "Timestamp": 0 }`.
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
position/scale/Euler angles, and layer. World-space and local-space patches cannot
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

The live write DTOs (`actor.create`, `actor.update`, `actor.delete`,
`actor.duplicate`, `actor.reparent`, `script.attach`, `script.detach`, and
`script.instance_update`) accept optional PascalCase `ExpectedSceneRevision` and
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

Those live write DTOs also accept optional `IdempotencyKey` (1--128 characters).
For ten minutes, with a maximum of 512 retained entries, a repeated key with the
same method and serialized request returns the original result without performing
the side effect or advancing revisions. Reusing a retained key for different input
fails with `IDEMPOTENCY_KEY_REUSED`. The cache is bridge-session-local and is not a
durable request journal; clients should use it for retry recovery, especially for
create, duplicate, and script attach.

## Bridge v8: public asset registry and reference graph

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
