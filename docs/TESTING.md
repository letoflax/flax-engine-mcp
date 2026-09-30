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
