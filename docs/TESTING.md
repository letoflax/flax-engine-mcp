# Editor integration and compatibility testing

`npm test` includes deterministic integration-shaped tests in
`src/integration/editorIntegration.test.ts`. They generate a small temporary
project (two scenes, prefab, material/texture/model placeholders, ordinary and
network scripts, and an intentional compile error) and drive a simulated
file-RPC Editor peer. They validate DTO shape and failure handling, but do not
start Flax or claim GUI coverage.

The current compatibility metadata is in `test/compatibility-matrix.json`.
It records Windows + Flax 1.12 as the current/recommended baseline. Headless
coverage is status, compile, diagnostics, and logs, plus the bridge v33 checks
listed in the live run below (member reads, project-settings writes, scene and
content creation, scene open/close, and the domain queries); edit-time writes
that need Editor windows or the live scene are refused headless by design
(`HEADLESS_MODE`), while `actor_create`, `actor_update`, `script_attach`, and
undo have no headless gate and work. Flax 1.12
play, game-viewport capture, and runtime inspection require a headed Editor and a
game window; editor-viewport capture (bridge v22) requires a headed Editor whose
Edit tab is the selected tab of its dock panel. After play mode the Game tab is
in front, and the capture then reports `completed` with a fully transparent
image; with the Edit tab selected it produced a real image even with the window
minimized. Run those manually on a dedicated project copy. Linux and macOS
are intentionally marked unverified until their workflow has passed.

For a real manual run, install the bundled bridge into a disposable fixture
project, open it using Flax 1.12, then perform the roadmap sequence: connect,
read scene, create/update/attach, undo/redo/save, patch the intentional error,
compile fail/fix/succeed, and (headed only) play/log/game-capture/stop plus an
editor-capture outside play mode. Record the result in
the matrix rather than treating the simulated peer as Editor verification.

The integration suite has explicit skips where the host has no configured
Flax Editor, prohibits symlink/junction creation, or for the operation
cancellation probe (the simulated peer cannot run a cancellable build or import,
so that probe needs a real Editor; simulated-peer coverage of `operation_cancel`
and `build_cancel` lives in `src/operations.test.ts` and
`src/tools/buildLive.test.ts`). Scoped temporary directories are removed in every
test, including on a failed assertion.

Before claiming compatibility with a bridge change, run the compile-only API smoke probes
against the installed Flax 1.12 managed artifact. The three commands below cover the prefab
(v12), material/animation (v13 reads, v29 writes) and full-bridge surfaces; `test/flax-api-smoke/` also
holds `VisjectGraphApiCompileProbe.csproj` (graph editing) and `GraphSetModelApiCompileProbe.csproj`
(`graph_set_model`), built the same way:

```powershell
dotnet build test/flax-api-smoke/PrefabApiCompileProbe.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
dotnet build test/flax-api-smoke/MaterialAnimationApiCompileProbe.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
dotnet build test/flax-api-smoke/BridgeCompileSmoke.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
```

The direct probes validate public signatures; the final command compiles the
whole bridge source with FLAX_EDITOR against the same artifact. Neither starts
Flax or validates Editor Undo behavior, so a clean build proves only that the
referenced signatures exist. Behavior needs a real Editor: the live run below
records the bridge v33 surface, and the follow-up run after it records the v32
import-settings surface. The bridge v29 (material writes), v30 (prefab
override diff/revert/apply/break-link) and v31 (foliage, navmesh, bake, probe)
surfaces have no live run recorded in this file beyond their headless refusals
and what the v33 runs happened to exercise; they are covered by these probes and
the simulated-peer tests. `animation_set_graph_parameter` and `terrain_paint` remain
stable `UNSUPPORTED_FLAX_VERSION` capabilities, as do `input_key_press` and
`input_mouse_click` after their gates and validation.

## Bridge v33 live run (Windows, Flax 1.12.6912, 2026-09-30)

Bridge v33 was exercised against a real Flax 1.12 Editor on a disposable
copy of a small template project (one scene with lights, a camera, two
static models with box colliders). The bridge was installed into
`Source/Game/MCP/`, compiled by the Editor's own script build, and driven
through the built Node tool registry (`dispatchToolCall`), so every call
went through the real file-RPC transport.

Headless Editor (`-headless -std`):

- bridge v33 compiles, starts, and hot-reloads through `code_compile`
- `actor_get_properties` on collider, light, camera, static model, sky,
  UI canvas, and particle effect actors
- all six `settings_*` writes: dry-run, save, no-op detection, refusals;
  the saved JSON and the reloaded settings were read back
- `scene_create`, `scene_open`, `scene_close`, `content_create_folder`
- `asset_create` for all 13 binary kinds and for `JsonAsset`
  (`FlaxEngine.PhysicalMaterial`, a settings class, and four rejected
  types)
- the eleven v14 domain queries (empty objects before the named-DTO fix,
  real data after it), error details, and idempotency key reuse
- edit-time writes are refused in headless mode as designed

Headed Editor (window minimized):

- generic `actor_set_property`: bool, float, int, vector, color, enum,
  flags enum, asset reference, `JsonAssetReference<T>`, actor reference,
  clearing a reference, editor-limit refusal, type-mismatch refusals,
  dry-run, idempotent replay, stale-revision conflict
- `edit_undo` / `edit_redo` over those writes
- `ui_control_create` under a `UICanvas` and under a container control,
  `ui_control_get_properties`, `ui_control_set_property` for text, color,
  and the layout members; the saved scene kept the layout across an
  Editor restart
- `script_attach` after several script reloads (this is what exposed the
  stale-assembly type lookup)
- play mode: `runtime_set_script_value` (float, string, enum, vector,
  actor reference, a `[NoSerialize]` field), `runtime_invoke_script_method`
  (return values, a thrown exception, arity, generic, accessor, and
  engine-method refusals); values reverted when play stopped
- `scene_close` refusals (dirty scene, active lease) and the
  `allow_dirty` discard path
- a real MCP stdio session calling `code_compile` with a progress token
  received five `notifications/progress` messages

Not exercised in this run (the first two were covered by the follow-up run
below):

- `particle_set_parameter` with a real parameter. No tool can author a
  particle system with emitter tracks, and the project had none, so only
  the empty-system read, the not-found path, and the edit-time gate ran.
- The settings refusal while the settings asset window is open (it needs
  a person to open the window).
- Linux and macOS.

## Bridge v33 follow-up live run (Windows, Flax 1.12.6912, 2026-09-30)

After the follow-up changes (import-settings fixes, brush/font/engine-asset
member values, `test_run_scenario` steps, the shared headless mapping) the
merged build was run again on the same disposable project, in two headless and
two headed Editor sessions. Scaffolding that no tool can provide (an emitter
track in a particle system, opening a settings window, a virtual texture saved
without import metadata, script methods to call) lived in the disposable
project's own game scripts, never in the bridge.

Import settings (`asset_get`, `asset_get_import_settings`,
`asset_set_import_settings`, `asset_reimport`), headless:

- `ImportSettingsAvailable` is true for Texture, Model, SkinnedModel, and
  AudioClip, false for scene, prefab, material, material instance, Animation,
  CubeTexture, and a JSON settings asset; reading settings of those seven
  fails `VALIDATION_FAILED` with the type name (no SpriteAtlas was available)
- a dry run repeated with the same `operation_id` returns the same preview
  with `adopted:true`; different settings under that id fail
  `IDEMPOTENCY_KEY_REUSED`
- a write whose values already match succeeds with a warning and no
  `changes`; the asset file's time, size, and hash are unchanged
- a real `max_size` write on a texture reads back with every other setting
  unchanged; model (`scale`, `lod_count`) and audio (`format`, `bit_depth`,
  `is_3d`) writes read back too
- range errors: `smoothing_normals_angle:176`, `base_lod:6`, `lod_count:7`
  fail `INVALID_ARGUMENT` in Node; texture `scale:9` fails `VALIDATION_FAILED`
  in the bridge
- `restored:false` was produced with a texture saved from a virtual asset:
  the read carries the warning and both dry run and write fail
  `IMPORT_FAILED`. A CSG mesh reads `restored:true` and is refused on write
  because it has no importer source
- `asset_reimport` with `model_import_type` on a Model and on an Animation
  keeps the other import options
- with the source file removed, reimport and settings write fail at once
  with `IMPORT_SOURCE_NOT_ALLOWED`; failed operations keep their error code
  when polled

Member values, headed:

- engine assets by `engine:` path and by GUID, through the generic member
  and the `StaticModel.Model` alias; read-back, write-back as a no-op,
  undo/redo; bad paths and wrong types are refused
- texture, solid, sprite (`engine:Editor/IconsAtlas`), and GUI-material
  brushes and a font size change: read-back, write-back as a no-op, and
  undo/redo; the texture, solid, and sprite brushes and the font read back
  identically after `scene_save` and an Editor restart
- warnings (transparent `BackgroundColor`, non-GUI material, font without
  an asset) arrive in the result and in the envelope, for
  `ui_control_set_property` and `actor_set_property`

`test_run_scenario` steps, headed:

- a dry run lists the steps and starts nothing
- a passing scenario with both step types and bool, int, float, double,
  string, enum, actor, and void returns, plus an expected throw
- failing scenarios: wrong value, wrong kind, unexpected throw, expected
  throw that did not happen, unknown member or method, a vector return
- play was stopped after every scenario

Gaps from the first run, headed:

- `particle_set_parameter` on a system with two tracks of one emitter:
  ambiguous name refused without `track`, dry run, write, read-back, no-op
  repeat, undo, redo; bool, int, color, and vector values; refusals for
  non-public parameters, wrong value types, and unknown names or tracks
- with the Input, Layers And Tags, or Game settings window open, the
  matching `settings_*` dry run and write fail `EDITOR_BUSY` and the file is
  untouched; other settings assets stay writable

Headless refusals (tool-level codes; see the table in `README.md`):

- member, UI, particle, material, graph, foliage, bake, selection, and play
  start calls report `HEADLESS_MODE`. Material and graph tools reported
  `EDITOR_BUSY`, and play start `INVALID_PLAY_STATE`, before the mapper fix
  made during this run
- `viewport_capture` reports `CAPTURE_UNAVAILABLE`; runtime script tools
  outside play report `INVALID_PLAY_STATE`
- `actor_update`, `actor_create`, and `script_attach` are not refused
  headless

Regression sweep, headed: `scene_get_tree`, `actor_get_properties`, a generic
`actor_set_property` with undo, `ui_control_create` with
`ui_control_set_property`, a `settings_add_tag` dry run, `scene_create` with
`scene_close`, `asset_create`, play start with `runtime_set_script_value`,
`runtime_invoke_script_method` and `play_stop`, `physics_raycast`,
`lighting_get_status`, and `viewport_capture` (game and editor).

Defects found and fixed during the run:

- headless refusals mapped to `EDITOR_BUSY` or `INVALID_PLAY_STATE` for
  material, graph, and play-start tools (now `HEADLESS_MODE`)
- every binary `asset_create` made the engine log "Founded duplicated asset"
  and "Cannot modify duplicated asset ID", because the bridge queried the
  asset registry with an OS-spelled path; it now uses the engine's
  normalized spelling, and the log is clean in headless and headed sessions

Observed and not changed:

- the Editor's own auto save (every five minutes by default) wrote the scene
  after tool edits without any save call, headless and headed
- after a script hot reload the Editor reported a scene as not edited while
  unsaved edits were still live, so dirty-scene gates did not fire
- three consecutive `graph_add_parameter` calls returned `TIMEOUT` while the
  Editor main thread stalled; the first still took effect. Not reproduced
- an editor-viewport capture taken while the Game tab was in front reported
  `completed` with a fully transparent image
- `viewport_capture` sometimes reports `size_bytes` as width x height x 4
  instead of the PNG file size
- one `code_compile` issued right after a source change failed with
  `INTERNAL_ERROR` "Missing or invalid bridge session token" because the
  Editor's own recompile reloaded the bridge mid-call; the retry succeeded
- `asset_reimport_status` on a no-op settings write, `scene_open` answering
  `already_loaded`, and `play_stop` when already stopped each report a
  `changes` entry

Not exercised live:

- an asset-typed particle parameter (`graph_add_parameter` offers no asset
  type, so no tool can author one) and a brush type without a string form
- `restored:false` for a Model or an AudioClip (only a Texture was produced)
- a SpriteAtlas as an unsupported import-settings type
- Linux and macOS.

## Bridge v34 live run (Windows, Flax 1.12.6912, 2026-10-03)

Bridge v34 (server 1.12.0) was run against a real Flax 1.12 Editor on a scratch
copy of a small template project, never on an Editor the user had open. The
bridge was installed into `Source/Game/MCP/` and compiled by the Editor's own
script build. Calls went through the built CLI (`flax-engine-mcp call ...`) and
the Node tool registry, so every call used the real file-RPC transport. Probe
scripts (nested class/struct fields, an animation driver) lived in the scratch
project's own game sources, never in the bridge. Editors were started headless
and headed (minimized); one Editor per project at a time, except in the
standby test.

Results:

| Area | Check | Result |
| --- | --- | --- |
| Import | `asset_import` batch of 3 files; `ResultAssetId` equals header bytes 28..43 read as a .NET Guid and equals `asset_get` | pass |
| Import | replace keeps the ID and needs confirm; cross-type replace refused (`VALIDATION_FAILED`) | pass |
| Offline | `list_assets` and `get_asset_info` GUIDs equal `asset_get` | pass |
| Transport | raw `ping` gives `METHOD_NOT_FOUND` with a Methods list | pass |
| Ownership | second Editor on one project stays standby; takeover after a clean quit about 17 s; after a kill 2 s (after fix) | pass |
| Navigation | headless `navigation_build` reports `completed` (26 of 26 builds after fix) | pass (after fix) |
| Lifecycle | `editor_launch` headless and headed; `editor_get_status` `wait_ready` with `require_scene` | pass |
| Lifecycle | `editor_quit`: dirty scene refused (`DIRTY_SCENES`), `save`, `discard`, refused during play (`EDITOR_BUSY`), `stop_play` | pass |
| Options | `editor_options` read, dry-run, set, restore; `EditorOptions.json` SHA256 identical before and after | pass |
| CLI | exit codes 0 / 1 / 2 | pass |
| Scenes | on-disk `.scene` edit then `scene_open` with reload; `DiskSha256` matches the file | pass |
| Scenes | `reload` and `replace` refused on a dirty scene; `replace` on a clean scene unloads the others | pass |
| Scripts | `script_instance_set_value` with asset refs (path and GUID), nested class and struct paths, save, reload, persistence | pass |
| Scripts | refusals: List member, unknown member, path through a scalar, wrong type, wrong asset type | pass |
| Undo | `edit_undo` / `edit_redo` restore values including an asset ref | pass |
| Play | `runtime_set_script_value` with a path during play (struct and nested class) | pass |
| AnimGraph | zombie graph built through graph tools (4 states, Any, 7 transitions with `State == N` rules, blends, Entry, clips, Multi Blend 1D); verified after Editor restart | pass (after fixes) |
| AnimGraph | play test: pose signature changed correctly across State 2, 1, 0, 1, 3, 0 and Speed 380, 150, 0 | pass |
| X3 | Material with a Color constant wired to the output: shader compilation succeeded | pass |
| X3 | MaterialFunction with input, float, add, output, all connected | pass |
| X3 | ParticleEmitter modules added through `graph_edit` (15,100 and 15,301), persisted | pass (after fix) |
| X3 | GameplayGlobals with 3 variables (Single, Int32, Color) reopened after a fresh Editor start | pass |

Defects found and fixed during the run:

- `bridge/FlaxMcpBridge.cs`: the Editor never started the bridge because game
  assemblies have no `System.Diagnostics.Process` (CS1069). `IsProcessAlive` now
  uses kernel32 P/Invoke.
- `bridge/FlaxMcpBridge.cs`: the first P/Invoke used `SetLastError`, `bool` and
  `out`, which throw under disabled runtime marshalling; the catch reported
  "alive" and takeover waited for the 30 s heartbeat. The imports are now
  blittable (`Marshal.GetLastSystemError`, an unmanaged buffer).
- `bridge/FlaxMcpBridge.cs`: headless `navigation_build` returned `TIMEOUT`
  "queued" because a small build lasts 3 to 6 ms and the 100 ms poll missed it.
  Completion is now detected by sampling on the request thread and by
  `Engine.UpdateCount` advancing twice, with a 250 ms quiet window and a
  warning when no tile build was observed.
- `bridge/FlaxMcpBridge.cs`: `graph_edit` refused a wire from a Get Parameter
  node created in the same batch (its boxes exist only after spawn).
  `GraphEditResolveBox` now accepts boxes 0..4 of that archetype.
- `bridge/FlaxMcpBridge.cs`: `graph_edit` could not add particle modules (group
  15 is `NoSpawnViaGUI`). They are now offered at the root of a
  ParticleEmitter surface, as the stage header "+" menu does.
- `src/tools/serverStatus.ts`: one call failed with `EDITOR_NOT_CONNECTED`
  because `bridge.json` was briefly missing during `File.Replace` on Windows.
  The read retries while the `token` file exists.

Tests added or adjusted: `bridgeV34ImportContract`, `bridgeV7Contract`,
`bridgeV34PathSafetyContract`, `bridgeV34GraphContract` and `serverStatus`.
After the fixes `npm test` gives 481 tests, 477 pass, 0 fail, 4 skipped, and the
`BridgeCompileSmoke` build succeeds with 0 warnings and 0 errors.

Known limitations and observations:

- No tool reads GameplayGlobals values; they were checked with an Editor probe
  in the scratch project.
- `graph_inspect` does not list transition contexts; use `graph_list_archetypes`
  `existing_nodes` with the context path.
- The navmesh `completed` signal is inferred from a processed request when the
  build is too short to observe.
- `code_compile` can return `EDITOR_BUSY` or `TIMEOUT` while the Editor is
  already compiling.
- Two Editors on one project while sources change can leave one stuck in
  "scripts compiling"; `editor_quit` then returns `EDITOR_BUSY`.
- Play stop leaves a transient "running" state for a moment.
- Scratch project files were deleted once mid-run by an unknown cause (the
  Editor logged "Content item removed"); the originals were intact.
- `mm_apply_preset` and `src/tools/mmTuning.ts` are game-specific and should be
  removed from the MCP.
- Windows only; Linux and macOS not exercised.

## Runtime bridge v35 live run (Windows, Flax 1.12.6912, 2026-10-03)

The runtime bridge (`bridge/FlaxMcpRuntimeBridge.cs`, server 1.13.0) was run in
cooked Windows Development builds of a scratch copy of a small template project,
never in a game or Editor the user had open. Both bridge files were installed
with `install_editor_bridge` (`include_runtime: true`, preview first, then
apply; `get_editor_bridge_installation` reported both files as current). A probe
script `RuntimeProbe` lived in the scratch project's own game sources: a float,
Vector3, Color, enum, bool, string, `Material` and `List<int>` field, a nested
`[Serializable]` struct field, `Add(int, int)`, a method that throws, a method
that logs warning/error/exception lines, a method that blocks the game thread,
and an update that can throw. It was attached to an actor of the start scene
through the Editor bridge tools and the scene saved.

Setup used:

- Cook: a headless Editor (`editor_launch`), then `build_validate` and
  `build_cook` (windows64, development and release, `wait: true`) into
  `Builds/Win64Dev*` and `Builds/Win64Rel*`. The in-Editor cook path worked, with
  one environment note: the cooker builds the game with `-dotnet=8`, so the
  Editor must be started with `DOTNET_ROOT` pointing at a dotnet root that has
  SDK 8 (without it `build_cook` ends `BUILD_FAILED` and the Editor log says
  "Missing .NET SDK 8"). The output directory must be new for each cook.
- Games were started with `game_launch` from a server run with
  `--allow-game-launch`. One-shot CLI calls cannot show `launched_by_this_server`
  or `force` across calls, so the launch, stop and force-kill checks used one
  persistent MCP stdio session (SDK client); instance tools also ran through the
  CLI.

Results:

| Area | Check | Result |
| --- | --- | --- |
| Installer | `install_editor_bridge` preview, apply, `get_editor_bridge_installation` for both files (version 34 and 35, hashes equal to `bridge/`) | pass |
| Cook | in-Editor `build_validate` and `build_cook` Development and Release | pass (needs `DOTNET_ROOT` with SDK 8) |
| Release | Release `Game.CSharp.dll` has no `FlaxMcpRuntimeBridge` type (Development has it); the Release game ignores `-mcpdir` and writes nothing | pass |
| Release | `RuntimeBridgeCompileSmoke` with `RuntimeBuildConfig=Release` builds with 0 warnings | pass |
| Inert | game started without `-mcpdir`: no `Cache/MCP-Runtime` created | pass |
| Inert | relative `-mcpdir` and empty `-mcpdir=` stay inert; `-mcpinstance=a/b` falls back to the pid | pass |
| Command line | `-mcpdir` unquoted, quoted value with spaces, and whole switch quoted (what `spawn` produces) | pass |
| Launch | `game_launch` two instances (`g1`, `g2`) with `wait_ready`, `status` has version 35, `Kind game`, frame count, scene count | pass (after fix) |
| Launch | default instance name `g<n>`; `wait_ready: false`; relaunch of an instance name after a kill (stale files cleared) | pass |
| Launch | refused: instance with path characters, `-mcpdir` in args, exe outside the project (`INVALID_PATH`, `NOT_FOUND`), name with a live heartbeat (`EDITOR_BUSY`), no `--allow-game-launch` | pass |
| List | `game_list_instances` live, stale (`process_not_running`), `launched_by_this_server`, no paths | pass |
| Scripts | `runtime_invoke_script_method` `Add` result; throwing method returns `Threw`, `ExceptionType`, `ExceptionMessage` as data; wrong arg count, unknown script refused | pass |
| Scripts | `runtime_set_script_value`: float, nested struct path (`Inner.Gain`, `Inner.Count`), Vector3, Color, enum, bool, string; values read back through a probe method | pass |
| Scripts | Material by 32-hex GUID set and cleared; path value, wrong asset type (MaterialInstance into Material), List member, engine member (`Enabled`), unknown member, path through a scalar, bad enum, bad string refused (`VALIDATION_FAILED`) | pass |
| Actors | `runtime_inspect_actor` returns the actor, children and script ids with `IsPlayMode` true | pass |
| Logs | `log_search`, `log_get_recent`, `log_get_runtime_errors` return the probe lines, `Debug.LogError`, `Debug.LogException` and update exceptions as errors | pass |
| Capture | `viewport_capture instance:` returns a PNG (1280x720) through the capture cache and the `flax://capture/<id>` resource; `viewport:"editor"` refused; raw `capture.start` with Width/Height gives `VALIDATION_FAILED` | pass |
| Perf | `perf_get_snapshot` FPS, frame time, managed memory, actor count, GPU adapter, renderer; draw calls and triangles are null | pass |
| Time | `play_set_time_scale` 0.5, 0 (frames keep advancing, bridge responsive), 1, 2; 11 refused by the schema, 20 refused by the bridge | pass |
| Transport | raw `ping` gives `METHOD_NOT_FOUND` with the Methods list; raw `capture.status` with a traversal id gives `INVALID_REQUEST` | pass |
| Stop | `game_stop` clean quit (about 0.3 s), process exits, heartbeat removed | pass |
| Stop | `game_stop` with `force` on a launched game: graceful quit first, process killed after the timeout when the game thread is blocked (about 1.9 s with `timeout_ms` 2000) | pass |
| Stop | `force` on an instance another server process launched: `PERMISSION_DENIED`, nothing stopped | pass |
| Stop | instance tools and `game_stop` on a stopped instance answer `GAME_NOT_CONNECTED`; unknown instance the same | pass |
| Stop | `game_stop` while a call is blocking the game thread: `EDITOR_BUSY` (one request in flight per instance); `force` still kills | pass |
| Multi | two instances answered independently (separate values, logs, captures, time scale) | pass |

Defects found and fixed during the run:

- `src/tools/gameRuntime.ts`: `game_launch` with `wait_ready` returned as soon
  as the bridge answered `status`, which is before the first scene has loaded
  (frame 2, `loaded_scene_count` 0 in the first launch). A script tool called
  right afterwards answered `NOT_FOUND` and a first capture was almost empty.
  `wait_ready` now also waits up to 10 s (within `timeout_ms`) for a loaded
  scene, then returns ready with a warning when none loaded.

Tests added or adjusted: `gameRuntime` (waits for the first scene to load, warns
when none ever does). After the fix `npm test` gives 537 tests, 533 pass, 0
fail, 4 skipped; `BridgeCompileSmoke` and `RuntimeBridgeCompileSmoke`
(Development and Release) build with 0 warnings and 0 errors.

Known limitations and observations:

- `perf_get_snapshot` reports `draw_calls` and `triangles` as null for a game.
- Responses from a game carry the bridge block with the key `editorVersion`
  holding the game's engine version.
- `StackTrace` of log entries is always null (the tools never request it, as for
  the Editor).
- A game started by `game_launch` runs at the unfocused frame cap of the
  project's Time settings (about 30 FPS) when it does not have focus.
- `force` is a graceful quit followed by a kill after `timeout_ms`; it cannot
  reach a game that another server process launched.
- A cooked game only has the assets the cooker included; asset GUIDs that were
  not cooked cannot be loaded by `runtime_set_script_value`.
- Cooking needs `DOTNET_ROOT` with SDK 8 and a fresh output directory (see Setup).
- Windows only; Linux and macOS cooked games were not exercised.
