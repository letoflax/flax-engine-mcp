# Editor integration and compatibility testing

`npm test` includes deterministic integration-shaped tests in
`src/integration/editorIntegration.test.ts`. They generate a small temporary
project (two scenes, prefab, material/texture/model placeholders, ordinary and
network scripts, and an intentional compile error) and drive a simulated
file-RPC Editor peer. They validate DTO shape and failure handling, but do not
start Flax or claim GUI coverage.

The current compatibility metadata is in `test/compatibility-matrix.json`.
It records Windows + Flax 1.12 as the current/recommended baseline, with
headless coverage limited to status, compile, diagnostics, and logs. Flax 1.12
play, game-viewport capture, and runtime inspection require a headed Editor and a
game window; editor-viewport capture (bridge v22) requires a headed Editor with
the editor window visible and works outside play mode. Run those manually on a
dedicated project copy. Linux and macOS
are intentionally marked unverified until their workflow has passed.

For a real manual run, install the bundled bridge into a disposable fixture
project, open it using Flax 1.12, then perform the roadmap sequence: connect,
read scene, create/update/attach, undo/redo/save, patch the intentional error,
compile fail/fix/succeed, and (headed only) play/log/game-capture/stop plus an
editor-capture outside play mode. Record the result in
the matrix rather than treating the simulated peer as Editor verification.

The integration suite has explicit skips where the host has no configured
Flax Editor, prohibits symlink/junction creation, or the bridge exposes no
cancellable operation API. Scoped temporary directories are removed in every
test, including on a failed assertion.

For the bridge v12 prefab and v13 material/animation surfaces, run the compile-only API smoke probes against
the installed Flax 1.12 managed artifact before claiming compatibility:

```powershell
dotnet build test/flax-api-smoke/PrefabApiCompileProbe.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
dotnet build test/flax-api-smoke/MaterialAnimationApiCompileProbe.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
dotnet build test/flax-api-smoke/BridgeCompileSmoke.csproj --nologo --verbosity minimal -p:FlaxEngineCSharpPath='D:\Apps\Flax\Flax_1.12\Binaries\Editor\Win64\Development\FlaxEngine.CSharp.dll'
```

The direct probes validate public signatures; the final command compiles the
whole bridge source with FLAX_EDITOR against the same artifact. Neither starts
Flax or validates Editor Undo behavior; that is why v12 keeps
override/revert/apply/break-link and v13 keeps material/animation mutations
explicitly unsupported.

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

Not exercised live:

- `particle_set_parameter` with a real parameter. No tool can author a
  particle system with emitter tracks, and the project had none, so only
  the empty-system read, the not-found path, and the edit-time gate ran.
- The settings refusal while the settings asset window is open (it needs
  a person to open the window).
- Linux and macOS.
