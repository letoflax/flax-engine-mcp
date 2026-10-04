# Flax Engine MCP

An MCP (Model Context Protocol) server that lets MCP clients interact with [Flax Engine](https://flaxengine.com/) game projects. It exposes 180 tools for reading and patching code, editing live scenes and actor properties, building UI, searching/importing/creating assets, working with safe live-prefab primitives, editing materials, animation graphs, and project settings, physics/navigation/lighting diagnostics, compiling, running and driving bounded play-mode checks, inspecting logs, and local diagnostics.

## Requirements

- Node.js 20+
- A Flax Engine project (must contain a `.flaxproj` file)

## Install & Build

```bash
git clone https://github.com/letofanius/flax-engine-mcp.git
cd flax-engine-mcp
npm install
npm run build
npm test
```

## Add to Claude Code

```bash
claude mcp add flax -- node /path/to/flax-engine-mcp/dist/index.js --project-path /path/to/your/flax/project
```

To use a different project, just change `--project-path`. You can run multiple instances with different project paths under different names (`flax-fps`, `flax-rpg`, etc.).

| Flag | Meaning |
|---|---|
| `--project-path <dir>` | The Flax project (a directory with a `.flaxproj`). Without it the current directory is used. |
| `--permission-profile`, `--allow-tool`, `--deny-tool`, `--emergency-read-only` | The permission policy, see Permissions. |
| `--asset-import-root <dir>` | Approved external source root for `asset_import` / `asset_reimport` (repeatable). May be project-relative, for example `--asset-import-root Content/Raws`: a relative root is resolved against `--project-path`, never against the working directory of the process. Roots are canonicalised once at startup (symlinks and junctions resolved), must exist, and are limited to 32 roots of 1024 characters. |
| `--flax-editor <path>` | Enables the `editor_launch` tool. The path must be an existing file named `FlaxEditor.exe` (case-insensitive; on Linux and macOS the extension-less `FlaxEditor` binary is accepted too), or a directory: a Flax install folder, where the host's `Binaries/Editor/<Win64\|Linux\|Mac>/<Development\|Release\|Debug>/FlaxEditor[.exe]` is used (first found), or a macOS `FlaxEditor.app` bundle (`Contents/MacOS/FlaxEditor`). A relative path is resolved against the working directory. Without the flag `editor_launch` answers `UNSUPPORTED_FLAX_VERSION` with a hint naming the flag. |
| `--allow-game-launch` | Enables the `game_launch` tool (cooked games that run the runtime bridge, see "Testing a cooked build"). A plain switch without a value; it also works for `flax-mcp call`. Without it `game_launch` answers `UNSUPPORTED_FLAX_VERSION` with a hint naming the flag. `game_list_instances` and `game_stop` do not need it. |

```bash
# Windows
flax-mcp --project-path D:/Games/MyGame --asset-import-root Content/Raws --asset-import-root D:/Art/Incoming --flax-editor "D:/Apps/Flax/Flax_1.12/Binaries/Editor/Win64/Development/FlaxEditor.exe"
# Linux (the install folder is enough; Binaries/Editor/Linux/Development/FlaxEditor is picked)
flax-mcp --project-path ~/Games/MyGame --asset-import-root Content/Raws --flax-editor ~/Applications/FlaxEngine
# macOS
flax-mcp --project-path ~/Games/MyGame --flax-editor /Applications/FlaxEngine/Binaries/Editor/Mac/Development/FlaxEditor
```

The server runs on Windows, Linux and macOS. Platform notes: the running-Editor check of `editor_launch` reads the
process list with PowerShell (`Get-CimInstance Win32_Process`) on Windows, `/proc/<pid>/cmdline` on Linux and
`ps` on macOS; project-path comparisons and per-project locks fold letter case on Windows and macOS only. The C#
bridges check process liveness with kernel32 on Windows, `/proc` on Linux and libc `kill(pid, 0)` on macOS.

## Permissions

The default profile is `full`, preserving existing installations. Use a narrower profile for agent sessions that do not need every capability:

```bash
flax-mcp --project-path /path/to/project --permission-profile read-only
flax-mcp --project-path /path/to/project --permission-profile code-edit
flax-mcp --project-path /path/to/project --permission-profile scene-edit
flax-mcp --project-path /path/to/project --permission-profile full
```

Every tool belongs to exactly one capability family in `src/permissions.ts`; a profile is a set of families. The `read` family includes `editor_get_status` (also with `wait_ready`), `graph_list_archetypes`, and `game_list_instances`:

- `read-only` permits the `read` family (inspection only).
- `code-edit` adds the `code` family: script writes/patches/generation, `code_compile`, `code_generate_project`, `operation_cancel`, `install_editor_bridge`, and `editor_options` (it changes a user-global Editor setting; reading it is allowed through the same tool).
- `scene-edit` adds the `scene` family (live actor/script/selection edits, undo/redo, edit leases, scene save/open/close, the legacy offline `create_actor`/`modify_actor`, prefab instantiate/revert/break-link, material assignment, UI/particle/foliage writes) and the `runtime` family (play controls, `test_run_scenario`, captures, runtime inspection and script drive, `build_cook`/`build_cancel`, navmesh/lightmap/probe bakes, the Editor process controls `editor_quit` and `editor_launch`, and the cooked-game controls `game_launch` and `game_stop`). It does not include compile, source writes, or the `asset` family.
- `full` permits every released tool, including the `asset` family (asset import/reimport/move/rename/duplicate/delete/create, project-settings writes, `scene_create`, `content_create_folder`, prefab creation and apply, and material, graph (including `graph_edit` and `animgraph_set_transition`), and import-settings writes), which no narrower profile includes.

`game_launch` is additionally gated by `--allow-game-launch`, a second, independent opt-in on top of the profile (like `--flax-editor` for `editor_launch`): a profile that includes the `runtime` family does not enable it without the flag.

Use repeatable `--allow-tool <name>` and `--deny-tool <name>` overrides for a specific server process; deny always wins, and an override naming a tool that is not registered has no effect. `--emergency-read-only` is an immediate safety switch: it blocks every tool outside the `read` family even if it was explicitly allowed. Tool discovery and `get_server_capabilities` report the tools available under the active policy; a call to a tool the policy hides fails with `PERMISSION_DENIED`.

Asset import is separately opt-in. By default no external file can be imported or reimported. Configure one or more canonical source roots (at most 32, each an existing directory; otherwise the server refuses to start) when starting the server; the root locations themselves are never returned by MCP:

```bash
flax-mcp --project-path /path/to/flax/project \
  --asset-import-root /path/to/approved-art \
  --asset-import-root /path/to/approved-audio
```

A root may be project-relative (`--asset-import-root Content/Raws`); it is resolved against `--project-path`. Only the built-in Flax 1.12 texture, model, and audio source extensions are accepted, source files are capped at 512 MiB, and destination paths must be `Content/.../*.flax`. Symlinks and junctions are resolved before every import. Collisions fail by default (`collision_policy: "error"`), can use the bounded `rename` policy, or (bridge v34) `replace`, which reimports the new source into the existing asset and keeps its GUID so references stay valid (needs `confirm: true`, or `dry_run: true` to preview; the importer type must match the existing asset, and the asset's previous import options are not restored). `items` imports 1-32 source/destination pairs in one call. The result carries the new asset's ID (`ResultAssetId`, bridge v34).

## Doctor and local observability

Run a read-only diagnostic before connecting a client:

```bash
flax-mcp doctor --project-path /path/to/project
flax-mcp doctor --project-path /path/to/project --json
```

`doctor` checks Node, project metadata, declared Flax version, bridge installation and heartbeat/protocol, active permission flags, and cache/source/settings readability. It never reads the bridge token or prints the project path. Exit codes are stable: `0` means no failed checks (warnings are allowed), `1` means a check failed, and `2` means invalid doctor usage.

The read-only `server_get_health`, `server_get_metrics`, and `server_get_recent_errors` tools provide bounded, in-process health data. Metrics include tool counts, error codes/rate, P50/P95 duration, and observable IPC failures; recent errors have a maximum of 100 entries and redact token-like values. They reset when the MCP process restarts. Cloud telemetry is disabled and no metrics leave the process.

## Command line

Scripts and agents that cannot speak MCP can call the same tools through the same registry, schema validation, permission policy, and bridge client as the server:

```bash
flax-mcp tools [--json] [--project-path <dir>] [policy flags]
flax-mcp call <tool> [json | @file | -] [--project-path <dir>] [policy flags]
```

- `call` takes the tool arguments as an inline JSON object, `@path/to/args.json` (a UTF-8 BOM is tolerated), or `-` to read JSON from stdin. No argument means `{}`. It prints the tool envelope (`operationId`, `mode`, `ok`, `data` or `error`, `warnings`, `changes`, `timing`) as JSON on stdout.
- Exit codes: `0` success, `1` tool error (the envelope is still printed; includes `PERMISSION_DENIED`), `2` usage error (unknown tool, bad JSON, unreadable `@file`, unknown option, invalid `--project-path` or policy flag; nothing is printed on stdout).
- `tools` prints the tools permitted under the policy as `name  family` lines, or `[{name, family}]` with `--json`.
- Policy flags are exactly the server's: `--permission-profile`, `--allow-tool`, `--deny-tool`, `--emergency-read-only`, `--asset-import-root`, `--flax-editor`, `--allow-game-launch`. `call` and `tools` are commands, never a project path.

This replaces hand-written file-RPC scripts: instead of writing request files into `Cache/MCP/requests`, generating an operation ID, and sending import roots yourself (and getting `METHOD_NOT_ALLOWED` for methods that are not on the bridge allowlist), call the tool:

```bash
flax-mcp call asset_import '{"items":[{"source_path":"D:/Art/Incoming/rifle.fbx","destination":"Content/Weapons/Rifle.flax"},{"source_path":"D:/Art/Incoming/rifle_d.png","destination":"Content/Weapons/Rifle_D.flax"}],"wait":true}' --project-path D:/Games/MyGame --asset-import-root D:/Art/Incoming
flax-mcp call editor_get_status '{"wait_ready":true}' --project-path D:/Games/MyGame
```

## Tools

### Project Info
| Tool | What it does |
|------|-------------|
| `get_server_capabilities` | Server/project identity, feature flags, mode, and Editor Bridge availability |
| `editor_get_status` | Validates the live bridge heartbeat, project identity, process, and freshness. With `wait_ready:true` it polls (with progress notifications) until the bridge answers and is idle (not compiling, reloading scripts, importing, or switching scenes), optionally with `require_scene:true` (a scene loaded) and `min_bridge_version` (for example `34` after installing a new bridge); heartbeat gaps and token changes during a script reload are waited out. `timeout_ms` defaults to 120000 (max 300000); a timeout returns `TIMEOUT` with the last observed state. The result adds `ready`, `waitedMs`, and a `readiness` object (`editorState`, `isEditMode`, `isCompiling`, `scriptsReady`, `isImporting`, `lastCompileFailed`, `loadedSceneCount`; bridge v34 reports them, older bridges only prove that they answer) |
| `server_get_health` | Process-local health and bridge availability without secrets or cloud telemetry |
| `server_get_metrics` | Bounded in-process tool timing, error, and IPC-failure metrics |
| `server_get_recent_errors` | Up to 100 recent redacted in-process tool and IPC errors |
| `search_tools` | Keyword search over the permission-filtered tool registry by name and description |
| `get_editor_bridge_installation` | Compare bundled and installed Editor Bridge versions and hashes; the `runtime` field reports the same for the runtime bridge file `FlaxMcpRuntimeBridge.cs` (`runtime.bundled.available` is `false` when the package does not carry it) |
| `install_editor_bridge` | Preview or safely install the bridge into the editor target's detected game module; accepts `module` when targets are ambiguous. `include_runtime:true` also installs the runtime (cooked game) bridge `FlaxMcpRuntimeBridge.cs` next to it (bridge v35; `runtime_expected_hash` guards replacing it, see Notes) |
| `get_project_info` | Project config from `.flaxproj` — name, version, default scene, directory layout |
| `get_game_settings` | Contents of `GameSettings.json` — product name, scene ID, all sub-settings refs |
| `get_project_summary` | Full project overview in one call — scripts, scenes, assets, settings, docs |
| `project_get_packages` | Offline `.flaxproj` reference inspection — engine/plugin/other refs with existence flags plus `Plugins/` names (no absolute paths) |

### Editor lifecycle
| Tool | What it does |
|------|-------------|
| `editor_launch` | Start a Flax Editor for this project, optionally `headless` and/or `skip_compile`, and with `wait_ready` (default true) wait until its bridge reports ready (`timeout_ms` default 120000, max 300000). Enabled only with `--flax-editor`; passes only `-project <this project>` plus `-headless`/`-skipcompile`, never any other argument. Refuses with `EDITOR_BUSY` when this project already has a live bridge heartbeat or a `FlaxEditor` process with `-project` for it, and returns the pid (bridge v34 for the readiness wait) |
| `editor_quit` | Quit the connected Editor through its exit path (`Engine.RequestExit`, no save prompt), then wait until its process exits. `unsaved` is `refuse` (default, `DIRTY_SCENES` listing edited scenes and asset windows), `save`, or `discard`; `stop_play:true` stops play mode first (otherwise play mode refuses the quit). Refused with `EDITOR_BUSY` while scripts compile, content imports, or a build runs. Returns `accepted`, `phase`, `savedSceneIds`, `discardedSceneIds`, `discardedAssetWindows`, `exited`, `pid` (`exited:false` plus a warning when the process outlives `timeout_ms`, default 60000, max 120000) (bridge v34) |
| `editor_options` | Read, or with `set` change, one of two user-global Editor options: `AutoReloadScriptsOnMainWindowFocus` or `ForceScriptCompilationOnStartup`. A change is a dry run by default, needs `confirm:true`, and is refused with `EDITOR_BUSY` while the Editor Options window is open. The options file is shared by all Editors of the user and other running Editors only see a change after a restart. With auto reload off, play mode uses the last compiled assemblies (run `code_compile` first). Never returns file paths (bridge v34) |

After a script change, an Editor restart, or a bridge install, call `editor_get_status` with `wait_ready:true` instead of sleeping and retrying. The usual restart cycle is `editor_quit` -> build or edit offline -> `editor_launch` (with `--flax-editor`) -> `editor_get_status` with `wait_ready:true`.

### Cooked game instances (bridge v35)
| Tool | What it does |
|------|-------------|
| `game_launch` | Start a cooked game that runs the runtime bridge as a named instance and, with `wait_ready` (default true, `timeout_ms` default 60000, max 120000), wait until its bridge heartbeat is live and it answers `status`. Enabled only with `--allow-game-launch`. `exe` is relative to the project root and, after resolving symlinks, must be a file inside it (on Windows also `.exe`). `instance` matches `[A-Za-z0-9_-]{1,64}` (default `g<n>`, the lowest free n). `args` takes at most 32 switches of the form `-name` or `-name=value`; `-mcpdir` and `-mcpinstance` are set by the server and refused. The process is started detached, with outputs ignored, and keeps running when the server exits. Refused with `EDITOR_BUSY` when the instance name already has a live heartbeat or was launched by this server and still runs. Returns `instance`, `pid`, `exe` (project-relative) and, when ready, `bridge_version`, `product_name`, `engine_version`, `frame_count`, `loaded_scene_count` |
| `game_list_instances` | List the instances under `Cache/MCP-Runtime` that have a heartbeat: `instance`, `state` (`live` or `stale`), `reason` (`connected`, `heartbeat_stale`, `process_not_running`, `wrong_kind`, `instance_mismatch`, `heartbeat_invalid`), `pid`, `bridge_version`, `protocol_version`, `product_name`, `engine_version`, `heartbeat_age_ms`, `launched_by_this_server`. Reads heartbeat files only and never returns a filesystem path |
| `game_stop` | Send `game.quit` (the game answers first and exits on a later frame), then wait up to `timeout_ms` (default 15000, max 120000) for the process to exit. `force:true` kills the process when the graceful quit did not finish, but only a pid this server process started with `game_launch`; for any other instance `force` is refused with `PERMISSION_DENIED` before anything is sent. An instance that is not running (or whose heartbeat is stale) reports `GAME_NOT_CONNECTED` |

Eleven other tools take an optional `instance` (a name from `game_list_instances`) and then talk to that cooked game instead of the Editor: `runtime_set_script_value`, `runtime_invoke_script_method`, `runtime_inspect_actor`, `viewport_capture` (only `viewport:"game"`), `log_get_recent`, `log_search`, `log_get_runtime_errors`, `perf_get_snapshot`, `perf_get_gpu_events`, `perf_capture`, and `play_set_time_scale`. See "Testing a cooked build" in Notes.

### Scripts
| Tool | What it does |
|------|-------------|
| `list_scripts` | List all C# scripts with size and modification time |
| `read_script` | Read a script by filename or path |
| `write_script` | Atomically create or overwrite a script with dry-run, expected-hash checks, and audit logging |
| `apply_script_patch` | Validate and atomically apply a bounded unified diff with dry-run and expected-hash support |
| `get_audit_entries` | Read recent redacted audit records for script writes/patches and asset move/rename/duplicate/delete (optional `operation` filter) |

### Code Analysis
| Tool | What it does |
|------|-------------|
| `get_script_classes` | Parse C# classes — base class, fields, methods, attributes |
| `find_references` | Find all scripts that reference a given class, type, or method |
| `list_networked_scripts` | Find all `[NetworkReplicated]`, `[NetworkRpc]`, `NetworkScript` usage |
| `search_in_files` | Grep for text in scripts and/or docs |

### Code Generation
| Tool | What it does |
|------|-------------|
| `generate_script` | Generate C# boilerplate from a template. Available templates: `basic_script`, `network_script`, `weapon_script`, `player_input`, `animation_driver`, `scene_manager`. Add `save:true` to write to disk. |

### Compile & Diagnostics
| Tool | What it does |
|------|-------------|
| `code_generate_project` | Generate solution/project files through the connected editor, with an optional wait for completion |
| `code_compile` | Start Flax script compilation and safely follow it across bridge assembly reloads |
| `code_get_diagnostics` | Read bounded diagnostics for the current compilation, filtered by severity/file with optional source context |

### Play Mode & Runtime
Eight of these tools (`play_set_time_scale`, `runtime_inspect_actor`, `runtime_set_script_value`, `runtime_invoke_script_method`, `perf_get_snapshot`, `perf_get_gpu_events`, `perf_capture`, `viewport_capture`) accept an optional `instance` that targets a cooked game started with `game_launch` instead of the Editor (bridge v35, see "Testing a cooked build"); with it no Editor and no play mode are needed.

| Tool | What it does |
|------|-------------|
| `play_get_status` | Read lifecycle state, session, duration, dirty-scene state, and frame count |
| `play_start_scenes` / `play_start_game` | Start current scenes or the configured first scene after safety gates |
| `play_stop` / `play_pause` / `play_resume` | Control the active simulation |
| `play_step_frame` | Advance a paused simulation by `frames` (1-120, default 1), one bridge request per frame, verifying Flax's run-to-repause lifecycle before the next |
| `play_set_time_scale` | Set the play-mode time scale 0–10 (0 freezes for frame-step debugging) via `FlaxEngine.Time.TimeScale`; requires play mode, bridge v23. The bridge never resets it on `play_stop` — it persists until changed or play stops (Flax owns play lifecycle; set explicitly after each play start) |
| `input_key_press` | Simulate one key press in running, unpaused play (bridge v26). Managed-Flax-API-only scope: Flax 1.12 exposes no managed key-injection primitive, so valid calls report `UNSUPPORTED_FLAX_VERSION` after gates and validation |
| `input_mouse_click` | Simulate one Left/Right/Middle click at viewport-normalized x/y in running, unpaused play (bridge v26). Managed-Flax-API-only scope: Flax 1.12 exposes no managed button-injection primitive, so valid calls report `UNSUPPORTED_FLAX_VERSION` after gates and validation |
| `play_run_for` | Run for seconds, frames, or until a session-correlated log match, then request stop |
| `test_run_scenario` | Run a bounded gameplay smoke scenario for `run_seconds` and assert `log_contains`/`log_absent`/`no_errors`/`viewport_captured` conditions, always stopping play. Optional `steps` (max 16) act on the game during the run at `at_seconds` after play is confirmed running: `set_script_value` (same fields as `runtime_set_script_value`) and `invoke_script_method` (same fields as `runtime_invoke_script_method`, plus `expect: { threw?, returned? }`). A failed step or expectation fails the scenario; steps need bridge v33 |
| `runtime_inspect_actor` | Read a bounded, allowlisted actor snapshot during play mode |
| `runtime_set_script_value` | During play mode, write one editor-visible field or property of a game script (members declared in game code only), or with `path` (1-4 member names, `member` omitted, bridge v34) a member nested in a user struct or class. No undo; the value is discarded when play stops (bridge v33) |
| `runtime_invoke_script_method` | During play mode, invoke one public, non-generic method declared in game code with up to four scalar arguments and return its result. A game exception comes back as data (`Threw`, `ExceptionType`), not as a tool error (bridge v33) |
| `perf_get_snapshot` | Read one instantaneous engine performance snapshot (FPS, frame time, draw calls, triangles, managed memory, actor count, GPU adapter/renderer). Works outside play mode (editor viewport rate) and in play mode; GPU fields are null when headless, and draw calls/triangles stay null whenever the profiler reports no valid draw stats (always headless; see the v27 section of `bridge/PROTOCOL.md`); single sample, no averaging (bridge v27) |
| `perf_get_gpu_events` | Read per-pass GPU timings of the last rendered frame (or averaged over `frames` 1-60 distinct frames): `{name, depth, time_ms, draw_calls, dispatch_calls, triangles}` per event plus `total_gpu_ms`, from `ProfilingTools.EventsGPU`, the data of the Editor Profiler window GPU tab. `min_ms`, `max_events` and `sort_by` shape the list. It turns the GPU profiler on for the call and puts the previous state back (a 30 s bridge lease restores it if the call dies). Headless, or no resolved GPU frame in `timeout_ms`, answers `available:false` with a `reason` and null totals instead of failing. Edit and play mode; requires bridge v36 (Editor, or runtime bridge with `instance`) |
| `perf_capture` | Sample `perf_get_snapshot` for `duration_s` (0.5-60) every `interval_ms` (at most 600 samples) and return frame-time avg/min/median/p95/p99/max, avg fps, the hitch count over `hitch_factor` x median (or an absolute `hitch_threshold_ms`), and avg/max draw calls and triangles. Server-side on the existing v27 snapshot call, so it needs no new bridge method; statistical (one frame time per sample, not every frame). `include_gpu:true` also samples GPU events (v36) and adds the average GPU ms per pass at `gpu_depth` (default 2); `draw_stats` (default true) enables the GPU profiler for the capture so draw calls and triangles are not null |
| `viewport_capture` | Capture the game viewport (requires play mode) or the editor viewport (bridge v22, works outside play mode) and return a readable temporary `flax://capture/<id>` PNG resource |
| `capture_compare` | Diff two viewport capture PNGs (`flax://capture/<id>` URIs or bare 32-hex ids) per pixel against a `threshold` fraction, with an optional red-overlay `emit_diff` PNG readable as a new capture resource |

### Live Logs
All three tools accept an optional `instance` that reads the log of a cooked game started with `game_launch` instead of the Editor session (bridge v35). The game log has category `engine` only and no play sessions, so `play_session_id` together with `instance` is `INVALID_ARGUMENT`.

| Tool | What it does |
|------|-------------|
| `log_get_recent` | Read the newest bounded entries from the editor-session log ring |
| `log_search` | Search a bounded sequence range with substring or guarded-regex matching |
| `log_get_runtime_errors` | Read Error/Fatal/exception entries, optionally scoped to a play session |

### Scene
| Tool | What it does |
|------|-------------|
| `get_scene_actors` | Actor hierarchy from a `.scene` file with TypeNames and attached scripts |
| `create_actor` | Legacy offline scene serialization; requires `allow_offline_write:true` and no connected editor |
| `modify_actor` | Legacy offline actor update; requires `allow_offline_write:true` and no connected editor |

### Live Editor
| Tool | What it does |
|------|-------------|
| `scene_list_loaded` | List scenes currently loaded by the connected Flax Editor |
| `scene_get_tree` | Read a loaded scene's live actor hierarchy |
| `scene_save` | Save one loaded scene |
| `scene_open` | Open one Content scene asset by GUID or project-relative path (async — poll `scene_list_loaded`; an already-loaded scene is a no-op; refuses play mode, compiling scripts, active edit leases, and edited scenes unless `allow_dirty_scenes:true`) (bridge v25). Bridge v34 adds `replace` (make it the only loaded scene), `reload` (re-read the scene file from disk; reports `disk_sha256`) and `discard_unsaved` (drop edits instead of `DIRTY_SCENE`); `replace` and `reload` are mutually exclusive. The Editor autosave can overwrite external edits of a scene file while the scene is open |
| `scene_create` | Create a new `Content/.../*.scene` file from the Editor default template (Sun, Sky, SkyLight, Floor, Camera). Never overwrites and does not open it; `dry_run` previews, a real write needs `confirm:true` (bridge v33) |
| `scene_close` | Unload one loaded scene through the Editor scene state machine without the modal save prompt (async — poll `scene_list_loaded`). Refuses play mode, compiling scripts, active edit leases, and unsaved edits unless `allow_dirty:true`, which discards them (bridge v33) |
| `project_save_all` | Ask Flax Editor to save all edited project content |
| `actor_get` / `actor_find` | Read or search live actors; v7 snapshots include bounded hierarchy, local/world-transform, tags, and layer metadata |
| `actor_create` / `actor_update` | Create or patch allowlisted actor fields with dry-run support. `actor_update` patches name, active, one transform space, layer, and (bridge v15) model/graph assignments: `skinned_model_*`, `animation_graph_*`, `update_when_offscreen` on `AnimatedModel` and `static_model_*` on `StaticModel` |
| `actor_get_properties` | List the editor-visible members of a live actor (the same selection the Flax property grid shows) with type, value, enum names, editor limits, and writability; works in play mode too (bridge v33) |
| `actor_set_property` | Set one editor-visible member of a live actor (`Mass`, `RigidBody.IsKinematic`, `BoxCollider.Size`, `AudioSource.Clip`, ...) through the Editor property wrapper with editor undo and a `dry_run` preview. Asset references take a GUID, a `Content/` path, or `engine:<path>` for engine content, actor references a GUID, `""` clears; brush and font members take the strings described in Notes (bridge v33). The aliases `Light.Color`, `Light.Brightness`, `Camera.FieldOfView`, `StaticModel.Model`, `Script.Enabled` work from bridge v28. Bridge v34 `path` (1-4 member names, `property` omitted) writes a member nested in a user struct or class, writing each parent back like the property grid |
| `actor_delete` / `actor_duplicate` | Delete or duplicate an actor with editor undo support (Flax returns no new actor ID from a duplicate, so the result reports `NewActorId:null`; refresh the tree) |
| `actor_reparent` | Reparent an actor while preserving its world transform by default |
| `script_attach` / `script_detach` | Attach or detach a script with editor undo support |
| `script_instance_get` / `script_instance_update` | Read a script instance or patch its enabled state (`script_instance_update` accepts nothing else; arbitrary serialized script properties are not exposed). `script_instance_get` accepts opt-in `include_values` for a bounded read-only projection of public field values (bool/int/float/string/enum/Guid/Vector2-4/Color; from bridge v34 also asset references as GUID plus type name and nested user struct and class values up to two levels deep; max 64 fields alphabetically, strings capped at 512 chars, unsupported types are null with a reason; never mutates the script) |
| `script_instance_set_value` | Write one editor-visible script member through the Editor property-grid wrapper with one editor undo record; `dry_run` previews coercion with `would_change` plus before/after (bridge v28). Bridge v34 uses the `actor_set_property` pipeline and value shapes, including asset references (`GUID`, `Content/...`, `engine:<path>`, `""` clears), and `path` (1-4 names, `field` omitted) writes a nested member of a user struct or class; bridges v28-v33 accept only bool/int/float/string/enum/Guid/Vector2-4/Color fields |
| `edit_undo` / `edit_redo` | Execute the Flax Editor undo/redo stack |
| `editor_get_selection` / `editor_set_selection` | Read the editor actor selection (bounded IDs, names, parent scene IDs; empty is an empty list) or replace it with 1–200 actor IDs; optional `focus_viewport` frames the EditWin viewport on the new selection (bridge v24) |
| `edit_begin_lease` / `edit_get_lease` | Acquire or inspect a bounded v7 edit lease for one loaded scene (`scene_id`) or, since bridge v16, one AnimationGraph/Material/ParticleEmitter asset (`asset_id` or `path`) |
| `edit_commit_lease` / `edit_release_lease` | End a lease after visible edits; neither operation rolls changes back |

### Assets
| Tool | What it does |
|------|-------------|
| `get_asset_info` | Inspect JSON assets or the type, GUID, and version header of binary `.flax` assets; IDs print in the bridge's managed 32-hex form, so they match `asset_get` |
| `reimport_asset` | Compatibility alias: delegates to `asset_reimport` with a v9 bridge; otherwise gives safe manual instructions and never launches an OS process (only `editor_launch` starts the Editor, and only with `--flax-editor`; only `game_launch` starts a cooked game, and only with `--allow-game-launch`) |
| `list_assets` | List Content/ assets by type (scene, material, settings, other) with GUIDs in the managed 32-hex form `asset_get` uses |
| `asset_search` | Search the connected Content registry with filters, dependency/reference counts, and opaque cursor pagination (bridge v8) |
| `asset_get` | Read stable metadata for one Content asset selected by GUID or project-relative path; `ImportSettingsAvailable` says whether `asset_get_import_settings` supports its type (bridge v8) |
| `asset_get_model_stats` | Per-LOD triangle, vertex and mesh counts, LOD and streamed-LOD counts, material slot count (and bone count for a SkinnedModel) of one Model or SkinnedModel asset, the numbers the Editor model window shows; `asset_get` returns registry metadata only. LODs still streaming in report null counts. Requires bridge v36 |
| `asset_dependencies` | Read direct or cycle-safe transitive dependency edges, depth-bounded to 16 (bridge v8) |
| `asset_find_references` | Find direct reverse references from source assets/scenes/prefabs without property paths (bridge v8) |
| `asset_import` / `asset_import_status` | Start or poll an allowlisted external import with dry-run, collision, and idempotency guards; optional `model_import_type` (`Model`, `SkinnedModel`, `Animation`, `Prefab`) for model sources (bridge v9). `items` (1-32 `{source_path, destination, model_import_type?}`) imports several files in one call with per-item results and an aggregate status (`succeeded`, `partial`, `pending`, `failed`). Bridge v34 adds `collision_policy:"replace"` (reimport into the existing asset keeping its GUID; needs `confirm:true`, or `dry_run:true` to preview) and returns the new asset's ID (`ResultAssetId`) |
| `asset_reimport` / `asset_reimport_status` | Start or poll a reimport using only Flax asset metadata and configured import roots; optional `model_import_type` as above (bridge v9) |
| `asset_get_import_settings` | Read bounded import options for one `Texture`, `Model`/`SkinnedModel`, or `AudioClip` asset: restored metadata, or engine defaults with a warning when nothing can be restored. Other types (including `CubeTexture`, `SpriteAtlas`, `IESProfile`) fail `VALIDATION_FAILED` (bridge v32) |
| `asset_set_import_settings` | Preview (`dry_run`) or apply allowlisted import-option scalars via reimport; both return `would_change`/`before`/`after`, a write whose values already match queues no reimport, and an asset whose current options cannot be restored is refused with `IMPORT_FAILED`. Polls via `asset_reimport_status` (bridge v32, requires `--asset-import-root`) |
| `asset_move` | Move one registry asset to an existing Content folder, with dry-run, collision, stale-index, and idempotency guards (bridge v10) |
| `asset_rename` | Rename one registry asset without changing its extension, with bounded reference impact (bridge v10) |
| `asset_duplicate` | Duplicate one registry asset to a named Content destination; existing references remain on the source (bridge v10) |
| `asset_delete` | Move one asset to an existing quarantine folder after explicit, current reference-count confirmation; it never permanently deletes data (bridge v13) |
| `asset_create` | Create one new empty asset the way the Editor Content window does: a binary `.flax` asset by kind (`Material`, `MaterialInstance`, `MaterialFunction`, `ParticleEmitter`, `ParticleEmitterFunction`, `ParticleSystem`, `AnimationGraph`, `AnimationGraphFunction`, `Animation`, `SceneAnimation`, `SkeletonMask`, `BehaviorTree`, `CollisionData`, `GameplayGlobals`) or a `.json` data asset of a class (`kind: "JsonAsset"` plus `type_name`). `kind: "GameplayGlobals"` also takes `variables` (up to 64 `{name, type, value}` with `type` `float`, `int`, `bool`, `Float2`, `Float3`, `Float4` or `Color` and an invariant-culture string value, for example `"0.5"`, `"1,2,3"`, `"1,0.5,0.25,1"`) written as the asset's default values (bridge v34). Never overwrites; `dry_run` previews, a real write needs `confirm:true` (bridge v33) |
| `content_create_folder` | Create a folder below `Content/` (missing parents included) and refresh the Editor Content database; an existing folder is a no-op (bridge v33) |

For example, first preview a move and then repeat the same request without
`dry_run` after confirmation:

```json
{
  "asset_id": "0123456789abcdef0123456789abcdef",
  "destination": "Content/Materials/Shared",
  "collision_policy": "error",
  "dry_run": true,
  "expected_path": "Content/Materials/Temporary/Surface.flax",
  "expected_index_revision": "<64-character revision from asset_search>",
  "idempotency_key": "organize-surface-1"
}
```

`asset_rename` takes `name` instead of `destination`; `asset_duplicate` takes
both. The name excludes the extension, which remains the source extension.

### Prefabs
| Tool | What it does |
|------|-------------|
| `prefab_create_from_actor` | Create a new `Content/.../*.prefab` from a loaded actor hierarchy; never overwrites and defaults `auto_link` to false (bridge v12) |
| `prefab_instantiate` | Instantiate a prefab under a required loaded parent with bounded world transform/name, dry-run, revision, lease, and idempotency guards (bridge v12) |
| `prefab_get_instances` | List instance roots in currently loaded scenes with opaque cursor pagination (bridge v12) |
| `prefab_get_overrides` | Synthesized override diff for one linked subtree vs `Prefab.GetDefaultInstance()` defaults (200 actors/entries cap; Name/IsActive/local transform/Layer only — not the engine diff) (bridge v30) |
| `prefab_revert_overrides` | Revert ALL overrides on 1-32 listed linked actors by copying prefab defaults, with dry-run preview and editor undo (no per-property revert, no cascade) (bridge v30) |
| `prefab_apply_overrides` | Push the whole-instance diff into the prefab asset via `PrefabManager.ApplyAll` with `confirm:true` + before-snapshot; the asset save cannot be undone by `edit_undo` (bridge v30) |
| `prefab_break_link` | Break one actor's prefab link via the reviewed `BreakPrefabLinkAction` undo path with `confirm:true`; revertible with `edit_undo` (bridge v30) |

### UI
| Tool | What it does |
|------|-------------|
| `ui_control_create` | Create a `UIControl` actor owning a new GUI control (`FlaxEngine.GUI.Button`, `Label`, `Image`, `TextBox`, `Panel`, ...) under a `UICanvas` or a container `UIControl`, the way the Editor scene tree spawns it, with editor undo and `dry_run`. Create the canvas first with `actor_create` type `FlaxEngine.UICanvas` (bridge v33) |
| `ui_control_get_properties` | List the editor-visible members of the control owned by a `UIControl` actor, including the layout members the Editor's dedicated UI editor exposes (`AnchorPreset`, `AnchorMin`, `AnchorMax`, `LocalX`, `LocalY`, `Width`, `Height`, `Offsets`) (bridge v33) |
| `ui_control_set_property` | Set one of those control members through the Editor property wrapper with editor undo and a `dry_run` preview, including brushes (`Image.Brush`, `BackgroundBrush`) and fonts (`Label.Font`) (bridge v33) |

### Particles
| Tool | What it does |
|------|-------------|
| `particle_get_parameters` | List the parameters a `ParticleEffect` actor exposes from its `ParticleSystem`: emitter track, name, type, value, default (bridge v33) |
| `particle_set_parameter` | Override one public parameter on a `ParticleEffect` actor through `ParticleEffect.SetParameterValue` with editor undo and `dry_run` (bridge v33) |

Audio needs no dedicated tools: `AudioSource.Clip`, `Volume`, `IsLooping`, `PlayOnStart` and the rest are editor-visible members, so `actor_create` plus `actor_set_property` configure them. The same goes for `ParticleEffect.ParticleSystem`.

#### Recipe: AudioSource, PointLight, or UI control to prefab
No dedicated tool is needed: build the actor in a loaded scene, configure it, then save it as a prefab. Each step previews with `dry_run:true`; the examples show the real writes.

1. `actor_create` with `{"type_name": "FlaxEngine.AudioSource", "name": "Footstep"}` (or `FlaxEngine.PointLight`). The result carries the new actor ID.
2. `actor_set_property` with `{"target_id": "<actor id>", "property": "AudioSource.Clip", "value": "Content/Audio/Step.flax"}`, then `Volume`, `IsLooping`, `PlayOnStart`. For a light use the aliases `Light.Color` and `Light.Brightness`, or any other member `actor_get_properties` lists. For a UI control create it with `ui_control_create` under a `UICanvas` (create the canvas with `actor_create` type `FlaxEngine.UICanvas` first) and set it with `ui_control_set_property`.
3. `prefab_create_from_actor` with `{"actor_id": "<actor id>", "destination_path": "Content/Prefabs/Footstep.prefab"}`. It never overwrites and defaults `auto_link` to false, so the source actor stays an ordinary scene actor; remove it afterwards with `actor_delete` if the prefab is all you need, or place instances with `prefab_instantiate`.

Check the actor with `actor_get_properties` before step 3, and save the scene with `scene_save` if you keep the source actor.

### Build & Cook
| Tool | What it does |
|------|-------------|
| `build_list_targets` | List the reviewed GameCooker target allowlist; a listed target is not proof its local toolchain is installed (bridge v13) |
| `build_validate` | Non-mutating preflight for a target and output below `Builds/`; toolchain availability remains unknown until start (bridge v13) |
| `build_cook` | Start a bounded GameCooker build into an empty project-relative `Builds/...` directory, with dry-run and an operation handle (bridge v13) |
| `build_get_status` / `build_get_result` | Poll a build handle or retrieve its terminal result; result rejects a non-terminal build (bridge v13) |
| `build_cancel` | Request GameCooker cancellation; poll to confirm terminal cleanup (bridge v13) |

### Materials & Animation
| Tool | What it does |
|------|-------------|
| `material_get_parameters` | Read bounded public Material/MaterialInstance parameter metadata and safe value projections (bridge v13) |
| `material_set_parameters` | Set 1-16 named parameters on one Material/MaterialInstance with dry-run preview (a real write needs `confirm:true`), editor undo, Asset.Save persistence, and unload/reload durability verification; edit-time only (bridge v29) |
| `material_create_instance` | Create a persisted MaterialInstance from one Material into a new Content/.../*.flax file, never overwriting; a real write needs `confirm:true` (bridge v29) |
| `material_assign_to_actor` | Assign one Material/MaterialInstance to a ModelInstanceActor slot with editor undo; marks the scene edited without saving; a real write needs `confirm:true` (bridge v29) |
| `animation_list_clips` | List registered Animation clips with public metadata and opaque cursor pagination (bridge v13) |
| `animation_get_graph_parameters` | Read live graph parameters from one loaded AnimatedModel (bridge v13) |
| `animation_set_graph_parameter` | Stable unsupported capability until an Editor-safe persistence, undo, and preview path is verified (bridge v13) |
| `animation_validate_bindings` | Compare a loaded AnimatedModel's public SkinnedModel, AnimationGraph, and graph BaseModel references (bridge v13) |

### Visject graphs
All graph writes go through the asset's Editor window and its save path; they are dry-run by default and saving cannot be undone. With bridge v34 the graph tools also open `MaterialFunction` and `ParticleEmitterFunction` assets, and `graph_edit` can edit nested contexts (`context_path`: decimal node ids, or `transition:<from>:<to>` for a state-machine transition rule graph); see the worked example in `bridge/PROTOCOL.md`, "Bridge v34".

| Tool | What it does |
|------|-------------|
| `graph_inspect` | Read a window-backed Visject graph (AnimationGraph, Material, ParticleEmitter, or, with bridge v34, MaterialFunction and ParticleEmitterFunction) as nodes, boxes, and parameters, optionally with sub-contexts (bridge v16, sub-contexts v19) |
| `graph_set_default_parameter` / `graph_add_parameter` | Persist one surface parameter default, or add one surface parameter (bridge v16) |
| `graph_undo` | Undo one step on the window-local undo stack for unsaved edits (bridge v16) |
| `graph_remove_node` / `graph_disconnect` | Delete one root-context node, or break one wire between two boxes (bridge v18) |
| `graph_set_node_values` / `graph_move_node` | Set value slots on one root node, or move it on the canvas (bridge v20) |
| `graph_list_archetypes` | List the node archetypes the Editor menu offers in one context of a graph asset (root, a nested context, or a state-machine transition rule graph), with title, boxes and default value kinds, plus the nodes already in that context. Read-only (bridge v34) |
| `graph_edit` | Apply 1-64 ordered edits (`add_node`, `connect`, `disconnect`, `set_values`, `move`, `remove`) as one batch in any context of a graph asset, saving once; `$ref` names bind nodes created earlier in the batch, and a failed op rolls the batch back unsaved (bridge v34) |
| `graph_set_model` | Bind a registry SkinnedModel as an AnimationGraph BaseModel; the bind pushes no undo action (bridge v21) |
| `animgraph_add_state` / `animgraph_add_transition` | Add one state or one state-to-state transition to an AnimationGraph state machine (bridge v17) |
| `animgraph_set_state_clip` | Assign an animation clip to a state by spawning a sampler and wiring Pose to State Output (bridge v20) |
| `animgraph_set_transition` | Set blend duration/mode, enabled, solo, default rule, interruption flags, and order on one existing AnimationGraph state-machine transition, selected by source and destination state node ids; reports before/after, dry-run by default, `confirm:true` for a real write. Uses Editor-internal members by reflection (checked at runtime, `UNSUPPORTED_FLAX_VERSION` naming a missing member) (bridge v34) |

### Operations
| Tool | What it does |
|------|-------------|
| `operation_get_status` | Read one persisted bridge operation by its exact handle (bridge v11; raw handles, not MCP Tasks) |
| `operation_cancel` | Request cancellation when the backend advertises a safe cancellation checkpoint (bridge v11) |

### Settings & Config
| Tool | What it does |
|------|-------------|
| `read_settings` | Read any settings file by partial name — `"Input"`, `"Physics"`, `"Graphics"`, etc. |
| `get_input_actions` | All input action and axis mappings from `Input Settings.json` |
| `get_physics_settings` | Gravity, bounce, and layer masks from `Physics Settings.json` |
| `settings_set_input_action` | Add an input action binding (key, mouse button, or gamepad button) to the project Input settings; the binding is appended unless `replace:true` first removes the existing bindings of that name (bridge v33) |
| `settings_set_input_axis` | Add an input axis mapping (mouse, gamepad stick, or a keyboard button pair), appended unless `replace:true` first removes the existing mappings of that name (bridge v33) |
| `settings_remove_input_mapping` | Remove every action or axis mapping (`kind`) with a given name (bridge v33) |
| `settings_set_layer_name` | Name one of the 32 project layers; duplicate names are rejected, and an empty name clears a slot except layer 0 (bridge v33) |
| `settings_add_tag` | Add one tag to the project Layers and Tags settings (bridge v33) |
| `settings_set_first_scene` | Set `GameSettings.FirstScene` to a Content scene asset (bridge v33) |

The `settings_*` writes go through the Editor's own `GameSettings.Load`/`Save` followed by `GameSettings.Apply`. `dry_run` returns before/after; a real write needs `confirm:true`, persists to disk immediately, and has no Editor undo record. They are refused in play mode, while scripts compile, and while the settings asset is open in an Editor window (the window keeps its own copy and would overwrite the change). Saving re-serializes the whole settings asset in the current engine format, exactly as saving from the Editor window does.

### Advanced domain queries
`physics_validate_colliders`, `physics_raycast`, `physics_get_layer_matrix`,
and `physics_find_overlaps` require bridge v14 and use bounded public Physics
queries (`physics_get_layer_matrix` lists layer names only: Flax 1.12 has no
reviewed managed collision-matrix reader). `navigation_get_status`,
`navigation_validate_agents`, and
`navigation_query_path` are also read-only. `navigation_build` (bridge v31)
starts a navmesh build for one scene with optional bounds, immediately since
bridge v34 (v31-v33 misused `timeout_ms` as a start delay), and waits up to
`timeout_ms` for it to be observed starting and finishing. `completed` is
reported only for an observed build (or new navmesh data); otherwise it reports
`TIMEOUT` with phase `running` or `queued` while the build continues in the
background (Flax exposes no navmesh cancel API). It works in a headless Editor
(CPU build; the engine saves the navmesh data itself). `lighting_bake` (bridge v31)
starts, cancels, or polls lightmap baking via the `BakeLightmapsOrCancel`
toggle (`End(failed:true)` conflates failure and cancellation).
`lighting_validate` reads bounded lightmap-related actor state in loaded
scenes, and `lighting_get_status` reads the bridge-tracked lightmap bake
phase without starting a bake.
`environment_probe_bake` (bridge v31) bakes one `EnvironmentProbe`/`SkyLight`
and polls `HasContentLoaded` (no progress or cancel API).
`terrain_get_summary` and `foliage_get_summary` are bounded read-only actor
metadata; `foliage_add_instances`/`foliage_remove_instances` (bridge v31)
write capped 1-200 batches with one editor undo step, one
`RebuildClusters` plus `UpdateCullDistance`, and mark the scene edited without
saving. `terrain_paint` (bridge v31) is a validated stub: Flax 1.12 terrain
data accessors return raw pointers and the `EditTerrain*` undo actions are
internal with no public factory, so it reports `UNSUPPORTED_FLAX_VERSION`
after full contract validation.

### Project Health
| Tool | What it does |
|------|-------------|
| `get_compiler_errors` | Compatibility alias to live diagnostics with an offline log-scan fallback; prefer `code_get_diagnostics` |
| `validate_project` | Backward-compatible health-check text plus paged, suppressible `FLAX001+` structured findings for offline project validation |

### Documentation
| Tool | What it does |
|------|-------------|
| `list_docs` | List all `.md` files in the project |
| `read_doc` | Read a doc file by name or partial name |
| `get_latest_log` | Compatibility alias to the live log ring with an offline file fallback; prefer `log_get_recent` or `log_search` |

## MCP Prompts

The server advertises five read-only guided workflows through MCP `prompts/list` and `prompts/get`: `create_gameplay_feature`, `fix_compile_errors`, `create_scene_from_description`, `debug_runtime_exception`, and `prepare_release_build`. Prompt arguments follow MCP's `Record<string,string>` contract; unknown, missing, malformed boolean, and out-of-range integer values are rejected. Getting a prompt never calls a tool, changes project state, or saves content.

Each workflow first asks the client to inspect safe MCP resources (and read-only tools when a needed resource is unavailable), read `get_server_capabilities` for the features the connected bridge supports, honor the active permission profile, preview supported writes with `dry_run:true`, and get explicit confirmation before mutations, saves, builds, or destructive actions. The guidance names the tools that exist today for each workflow: editor-visible actor properties (`actor_get_properties`, `actor_set_property`), UI (`ui_control_*`), project settings (`settings_*`), scene and content creation (`scene_create`, `scene_close`, `asset_create`, `content_create_folder`), materials, prefab overrides, particle parameters, play-mode script drive (`runtime_*` and `test_run_scenario` steps), and the bounded build/cook tools. It separates edits that go through the Editor undo stack from durable writes with no undo (settings saves, scene and asset creation, prefab apply, build output), states that edit leases are not transactions and that Flax 1.12 has no key or mouse injection, and mentions progress notifications for clients that send `_meta.progressToken`. It still reports as unsupported: transactions and atomic batches, arbitrary reflected properties, per-property prefab apply or revert (prefab overrides are a bounded diff with whole-instance apply and revert-all only), and the validated stubs `terrain_paint`, `animation_set_graph_parameter`, `input_key_press`, and `input_mouse_click`.

Teams can drop project-local workflow guides in `<project>/mcp-prompts/*.md`. File names must match `^[A-Za-z0-9_-]{1,64}\.md$` (up to 20 files, each up to 32 KiB); the stem becomes the prompt name, the first `# Heading` line becomes the description (otherwise the stem), and the full file text is served as the single user message on `prompts/get` with zero arguments (any argument is rejected as unknown). A missing `mcp-prompts/` directory means only the five built-ins are listed. Files with bad names, oversized content, built-in name collisions (built-in wins), or symlinks/junctions escaping the directory are skipped; the skipped count is reported as `_meta.projectPromptsSkipped` on `prompts/list`. Only stems are exposed, never absolute paths.

## Notes

- **Asset registry and graph reads** -- `asset_search`, `asset_get`, `asset_dependencies`, and `asset_find_references` require bridge v8. They use only public Flax 1.12 `Content` registry metadata and `Asset.GetReferences`; result pages are at most 200 entries, dependency depth is at most 16, registry scans are capped at 10,000 assets, and opaque cursors expire after ten minutes or invalidate when filters or registry metadata change. Paths/GUIDs are project-scoped. The registry reads do not return importer settings (use `asset_get_import_settings`, bridge v32), file size/modified time/import status, or actor/property reference locations, because public APIs do not verify them.
- **Asset compatibility aliases** -- `list_assets` delegates safe all/scene requests to `asset_search` with a v8 bridge; `get_asset_info` delegates `Content/...` paths to `asset_get`. Other legacy filters, bare filenames, offline projects, and bridges older than v8 keep their original filesystem-backed behavior. **GUID forms**: tools print and accept asset and actor IDs in the Editor bridge's managed 32-digit "N" form. The offline readers (`list_assets`, `get_asset_info`, `read_settings`, `validate_project`) print the same form for `.flax` headers and for IDs found in `.scene`/`.json` files (the files store the engine's native text form, a different spelling of the same 16 bytes), so an offline ID matches what `asset_get` returns. The legacy `create_actor`/`modify_actor` accept a managed `parent_id`/`actor_id_or_name` (the native spelling also works) and write native IDs into the scene file. Hand-written scene, prefab, or JSON content must use the native spelling; see "GUID forms" in `bridge/PROTOCOL.md`.
- **Safe asset imports** -- `asset_import` and `asset_reimport` require bridge v9, the `full` permission profile (or an explicit tool allow override), and at least one `--asset-import-root`. They invoke only Flax's verified `Editor.Import`, `ContentImporting.Reimport`, and `BinaryAsset.ImportPath` APIs, never copy source files or launch editor processes (only `editor_launch` does, and only with `--flax-editor`; `game_launch` starts only a cooked game, and only with `--allow-game-launch`). Type conversion outside (re)import is intentionally not exposed. New imports finish synchronously in Flax 1.12; reimports use Flax's queue and must be polled by operation ID (ten-minute retention, at most 512 records). Imports are rejected while Flax is playing, compiling/reloading, or already importing. The direct APIs are UI-free; headless availability still depends on the installed Flax Editor importer backend and should be verified in the target CI/editor setup. Bridge v34 adds `ResultAssetId` (the written asset's ID, from the registry or the file header), `collision_policy:"replace"` (`Editor.Import` onto the existing registered asset, the call a Content Browser reimport ends up making; it is refused with `VALIDATION_FAILED` when the importer type differs from the existing asset, because Flax would otherwise silently write a new sibling `Name (0).flax`, and it fails with `ASSET_OPERATION_FAILED` if a sibling appeared or the asset ID changed), `items[]` batches (run one after another; an Editor-level error such as `EDITOR_NOT_CONNECTED`, `EDITOR_BUSY`, `TIMEOUT`, `UNSUPPORTED_FLAX_VERSION`, `RATE_LIMITED`, or `HEADLESS_MODE` stops the batch and the remaining items are reported `skipped`; two items may not target the same destination; with `idempotency_key`, item N uses `<key>:<N>`), and persisted import records (`Cache/MCP/asset-operations`), so `asset_import_status` and an `operation_id` retry still work after a script reload. A start call that times out returns `operation_id` in `error.details`; poll `asset_import_status` with it to learn whether the import ran. The result has `destination: { path, requested, renamed }`.
- **Asset path safety (Flax 1.12)** -- asking the engine for an asset by a path spelling other than the one it registered (backslashes, a relative `Content/...`, different case) makes Flax re-register the file under a new asset ID. The bridge therefore uses asset IDs, or the engine's own path spelling (`StringUtils.NormalizePath(ProjectFolder + relative path)` with on-disk casing), for every lookup; the v33 `material_create_instance` clash check that rewrote an existing asset's ID is fixed.
- **Asset import settings (bridge v32)** -- `asset_get_import_settings` (read family, no import root needed) returns a bounded `{asset, type: texture|model|audio, restored, settings}` projection: restored importer metadata (`restored:true`) or engine `Options.Default` (`restored:false`, reported with a warning because those are not the values the asset was imported with). Support is decided by the exact registry type: `FlaxEngine.Texture`, `FlaxEngine.Model`, `FlaxEngine.SkinnedModel`, `FlaxEngine.AudioClip`. Every other type fails `VALIDATION_FAILED`, including `CubeTexture`, `SpriteAtlas`, and `IESProfile`, whose importers carry state the allowlist does not cover. `asset_set_import_settings` (asset family, same full-profile plus `--asset-import-root` gating as `asset_reimport`) clones the restored typed options, mutates an allowlist only — texture `srgb, compress, max_size, scale, generate_mipmaps, never_stream`; model `scale`, the `calculate/flip/reverse/optimize/merge/import_lods/import_vertex_colors` bools, both smoothing angles, `base_lod`/`lod_count`; audio `format, quality, disable_streaming, is_3d, bit_depth` — and applies via `ContentImporting.Reimport(item, settings, skipDialog:true)` on the shared `reimport` operation records, so `asset_reimport_status` polls settings writes. Ranges follow the engine's own limits: texture `max_size` 1-16384 and `scale` 0.0001-8; model `scale` 0.001-1000, `smoothing_normals_angle` 0-175, `smoothing_tangents_angle` 0-45, `base_lod` 0-5, `lod_count` 1-6; audio `quality` 0-1; enums are exact (`format` is `Raw|Vorbis`, `bit_depth` is `_8|_16|_24|_32`). The input schema is typed per key, so an unknown key, a wrong type, or a value outside the published range fails `INVALID_ARGUMENT` before any RPC; a key that belongs to another asset type, or a value outside that type's range, fails `VALIDATION_FAILED` at the bridge. The importer replaces its options wholesale with the object passed to `Reimport`, so a write is refused with `IMPORT_FAILED` when the asset's current options cannot be restored (otherwise every option that was not requested would silently become an engine default); the same rule applies to `asset_reimport` with `model_import_type`. Both `dry_run` and real writes return `{would_change, before, after}`; a write whose values already match finishes `succeeded` with a warning, an empty `changes` list, and no reimport. A call that reuses a known `operation_id` replays the first call's result with `adopted:true`, and reports the first call's failure instead of a success if it failed. A reimport the Editor would not queue (import metadata not loadable, or source file gone) now fails at once instead of staying `running`. `asset_get`'s `ImportSettingsAvailable` reports only that the asset type is supported, not that a write will succeed: an asset the engine generated itself (for example a CSG mesh) reads `restored:true` with default values and is refused on write with `IMPORT_FAILED` because it has no importer source, and `restored:false` was observed for a texture saved from a virtual asset. A reimport whose source file is gone fails with `IMPORT_SOURCE_NOT_ALLOWED`. Explicitly missing: dry-run validate-only import, standalone metadata write without reimport, and direct conversion outside (re)import.
- **Safe asset organization** -- `asset_move`, `asset_rename`, and `asset_duplicate` require bridge v10 and the `full` permission profile (or an explicit tool allow override). They select exactly one registry asset by GUID or `Content/...` path; destinations must be normalized existing folders inside `Content`, names cannot change an extension, and collisions either fail or receive a bounded `-N` suffix. Use `dry_run:true` before writing and pass `expected_path` and/or `expected_index_revision` from a recent asset read/search to reject stale state. The bridge calls only public Flax 1.12 `ContentDatabase.Move`, `Content.RenameAsset`, and `ContentDatabase.Copy` APIs—never a raw filesystem move/copy or reflection. Results include no more than 50 direct reverse references; actor/property locations remain unavailable. Move and rename verify that the source GUID remains; duplicate reports its new GUID while existing references continue to target the source. Flax exposes no verified undo record for these APIs, and v7 leases are scene-only, so results explicitly warn that undo and asset leases are unsupported. Calls do not save project content automatically.

- **Guarded asset deletion** -- `asset_delete` requires bridge v13 and the `full` permission profile (or an explicit allow override). It defaults to `dry_run:true` and is deliberately a quarantine move through the same public `ContentDatabase.Move` API, never `ContentDatabase.Delete`, `File.Delete`, or a raw filesystem fallback. Supply an existing dedicated Content folder as `quarantine_destination`; first review the preview, then repeat with `dry_run:false`, `confirm:true`, and either the exact `confirm_reference_count` returned by the preview or `require_unreferenced:true`. The bridge recomputes direct public `Asset.GetReferences` sources immediately before the move and rejects a changed/nonzero required count with `ASSET_REFERENCE_CONFLICT`. The selected GUID and existing references are preserved so the asset can be restored with `asset_move` or the Content Browser. Both previews and moves emit bounded audit metadata; permanent deletion is intentionally unsupported.

- **Safe prefab workflows** -- `prefab_create_from_actor`, `prefab_instantiate`, and `prefab_get_instances` require bridge v12. They use only the public Flax 1.12 `PrefabManager.CreatePrefab`, `PrefabManager.SpawnPrefab`, `Actor.IsPrefabRoot`, and `SceneObject.PrefabID` APIs. Creation accepts only a new project-relative `Content/.../*.prefab` path and never overwrites; it defaults `auto_link:false`. Instantiation requires a loaded `parent_id`, so the bridge can check the target scene revision/lease before it writes; top-level placement is deliberately deferred because Flax's unparented spawn selects its first loaded scene. Instance results are limited to currently loaded scenes, capped at 10,000 scanned actors and 200 entries/page; cursors expire after ten minutes. These three v12 methods do not inspect or edit prefab files, use reflection, or claim unloaded-scene coverage (the v30 override tools below differ: break-link reaches the internal `BreakPrefabLinkAction` factory by reflection, and apply saves the prefab asset).
- **Prefab override workflows** -- `prefab_get_overrides`, `prefab_revert_overrides`, `prefab_apply_overrides`, and `prefab_break_link` require bridge v30. The diff is bridge-synthesized (live subtree vs `Prefab.GetDefaultInstance()` defaults, 200 actors/entries cap, `Name`/`IsActive`/local transform/`Layer` only — not the engine diff window) because Flax 1.12 exposes no `ApplySingle`, `GetPrefabObjectIds`, or per-property diff/revert enumerator. Revert copies defaults into 1-32 listed actors (no cascade, no per-property revert) with editor undo; apply is whole-instance `PrefabManager.ApplyAll` with `confirm:true` plus a manual before-snapshot, and its prefab-asset save cannot be undone by `edit_undo`; break uses the reviewed `BreakPrefabLinkAction` undo path with `confirm:true`. No prefab open-stage tool is exposed (`PrefabsModule.OpenPrefab` is window-backed with no verified headless-safe stage API).

- **Foliage, navmesh, bake, and probe workflows** -- `foliage_add_instances`, `foliage_remove_instances`, `navigation_build`, `lighting_bake`, and `environment_probe_bake` require bridge v31 (edit-time only: play mode is refused with `INVALID_PLAY_STATE`; all except `navigation_build` also refuse a headless Editor with `HEADLESS_MODE`). Foliage batches are capped at 200 instances per call with one editor undo step, one `RebuildClusters` plus `UpdateCullDistance` (no progress/cancel API), local-space positions, and scene-edited-without-save semantics. `navigation_build` starts the build immediately (bridge v34; v31-v33 misused `timeout_ms` as a start delay) and waits up to `timeout_ms` for it to be observed starting and finishing (`IsBuildingNavMesh` true then false, or new navmesh data); `completed` is reported only for an observed build, otherwise `TIMEOUT` with phase `running` or `queued` while the build continues in the background (no cancel API). It works in a headless Editor (CPU build; the engine saves the navmesh data itself, the scene is not saved). Lightmap baking toggles via `BakeLightmapsOrCancel` with start-while-baking/cancel-while-idle no-op safety and `End(failed:true)` conflating failure with cancellation. Probe baking polls `HasContentLoaded`, which cannot distinguish a fresh bake from previously baked content. `terrain_paint` requires bridge v31 but stays a validated `UNSUPPORTED_FLAX_VERSION` stub: Flax 1.12 terrain data accessors return raw pointers (unsafe context not verified for Flax script compilation) and the `EditTerrain*` undo actions are internal editor types with no public factory.

- **Bounded build/cook workflows** -- `build_list_targets`, `build_validate`, `build_cook`, `build_get_status`, `build_get_result`, and `build_cancel` require bridge v13. They invoke only public Flax 1.12 `GameCooker.Build`, `GameCooker.Cancel`, event, and progress APIs. Output must be a non-empty project-relative directory below `Builds/`; non-empty destinations, arbitrary command lines, presets, package settings, and paths outside the project are rejected. Validation is deliberately preflight-only because Flax does not expose a reviewed managed API for toolchain availability. Build cancellation is asynchronous: acknowledgement means the request reached GameCooker, while a terminal cancellation requires later polling.

- **Editor-visible members (bridge v33)** -- `actor_get_properties`, `actor_set_property`, and the `ui_control_*` tools reach only members the Flax property grid would show: public or `[ShowInEditor]`, never `[HideInEditor]` (the selection rule of the Editor's `GenericEditor.GetItemsForType`). Writes additionally refuse `[ReadOnly]` and `[NoSerialize]` members, numeric values outside a member's `[Limit]`/`[Range]` bounds, and the Actor base members that `actor_update` owns (name, active, transform, layer, tags). The one exception to `[HideInEditor]` is the UI control layout set (`AnchorPreset`, `AnchorMin`, `AnchorMax`, `LocalX`, `LocalY`, `Width`, `Height`, `Offsets`), which the Editor edits through its dedicated UI control editor instead of the generic grid (they are also exempt from the `[NoSerialize]` refusal, being views over the serialized anchors and offsets). Supported value types: bool, numbers, string, enum (names, comma-separated for flags), Guid, Vector/Float/Double/Int 2-4, Color, Quaternion, Rectangle, Margin, LocalizedString, LayersMask, asset references, `JsonAssetReference<T>`, GUI brushes (`IBrush`), `FontReference`, and actor/script references. An asset reference is a GUID, a `Content/` path, or engine content as `engine:<path>` (the path below the engine Content folder without extension, e.g. `engine:Editor/Primitives/Cube`); assets of other referenced projects are not resolvable. A brush is `<kind>:<value>[;option=value]` with the kinds the Editor brush picker offers: `solid:<color>`, `gradient:<color>;end=<color>`, `texture:<Texture>`, `texture9:<Texture>`, `sprite:<SpriteAtlas>;sprite=<name>`, `sprite9:...`, `material:<MaterialBase>`, `ui_brush:<JsonAsset>`, `video:<VideoPlayer GUID>` (for example `texture:Content/UI/Logo.flax`, `sprite:engine:Editor/IconsAtlas;sprite=Play64`, `solid:#ff8000`); `GPUTextureBrush` holds a runtime GPU texture and is refused. A font is `<font asset>;size=<points>` (size 1-500). `*_get_properties` returns the same strings in `Value.Text`, so a value can be read, edited, and written back. A write the engine accepts but would not draw (a `BackgroundBrush` while `BackgroundColor` is transparent, a non-GUI material, a font without an asset) succeeds with a warning. The same value syntax applies to `runtime_set_script_value` and `runtime_invoke_script_method` arguments. Values are written through `ScriptMemberInfo.SetValue`, the wrapper the property grid uses, inside a bridge undo action. The writes (`actor_set_property`, `ui_control_create`, `ui_control_set_property`) are edit-time only: a headless Editor is refused with `HEADLESS_MODE` and play mode with `EDITOR_BUSY` (the bridge sends wire code `INVALID_STATE` for both). The `StaticModel.Model` alias accepts a GUID or an `engine:<path>` reference; a project `Content/...` path is accepted through the generic member name `Model`. The reads (`actor_get_properties`, `ui_control_get_properties`) have no such gate and also work headless and in play mode. Bridge v34 `path` (1-4 C# identifiers) reaches members nested in a user struct or non-null user class through `actor_set_property`, `script_instance_set_value`, and `runtime_set_script_value` (not `ui_control_set_property`); every level must be editor-visible and writable, engine structs and objects, collections, and null classes are refused, and each parent is written back like the property grid (one undo record at edit time). A `dry_run` validates the whole path and returns the resolved path with `would_change`; errors begin with `Path segment <index> ('<name>'):`.
- **Driving gameplay in play mode (bridge v33)** -- Flax 1.12 binds no managed key or mouse injection (`Keyboard::OnKeyDown` and `Mouse::OnMouseDown` are not exposed to C#), so `input_key_press` and `input_mouse_click` stay validated stubs. Gameplay is driven through the game's own scripts instead: `runtime_set_script_value` writes an editor-visible script member and `runtime_invoke_script_method` calls a public, non-generic method declared in game code (never an engine method or a property accessor). Both require play mode, record no undo, and never mark a scene edited; Flax restores the edit-time scene when play stops. `test_run_scenario` accepts timed `steps` that call these two tools during a bounded run. An `invoke_script_method` step fails when the method throws unless `expect.threw` is true, and `expect.returned` compares the result: booleans, numbers (integers exactly, floats within a relative 1e-6), and strings (string results, enum names, or an actor, script, or asset GUID); vector and other structured results cannot be compared. Steps run in `at_seconds` order on the scenario's own timeline, so a slow step delays later ones and never shortens the run. They are checked before play starts: a permission policy that denies the matching `runtime_*` tool gives `PERMISSION_DENIED`, and a connected bridge older than v33 gives `UNSUPPORTED_FLAX_VERSION` (both also under `dry_run`). If a step fails with `TIMEOUT`, `EDITOR_NOT_CONNECTED`, or `INVALID_PLAY_STATE`, later steps are skipped and reported as such; asserts and `play_stop` still run. A scenario without `steps` behaves exactly as before. A cooked game has no input injection either; with `instance` the same two tools drive it (see "Testing a cooked build").
- **Scene and content creation (bridge v33)** -- `scene_create`, `asset_create`, and `content_create_folder` never overwrite, reject paths that resolve outside `Content/` (symlinks and junctions included), and refresh the Editor Content database. The registry can list a new asset a moment later: the bridge reads a new binary asset's ID from its file header, and adds a warning to poll `asset_get` for the path when it cannot report an ID yet. `asset_create` accepts the asset tags the Editor's own asset proxies pass to `Editor.CreateAsset`, and for `JsonAsset` exactly the classes the Editor "Json Asset" dialog accepts, plus types with a registered spawnable JSON proxy such as `FlaxEngine.PhysicalMaterial`. Creation has no Editor undo record; remove an unwanted file with `asset_delete`. `asset_create` kind `GameplayGlobals` is created through the Editor Content Browser path (`GameplayGlobalsProxy.Create`) because `Editor.CreateAsset` fails for it in Flax 1.12; the variables are validated before anything is written, and only that kind needs bridge v34.
- **Progress notifications** -- a `tools/call` request carrying `_meta.progressToken` receives `notifications/progress` while the server waits: compile and project-generation polls, play-state waits, `play_run_for`, asset import waits, build waits, viewport captures, and any single bridge call the Editor has not answered within a second. `progress` is milliseconds elapsed since the call started (so it always increases), `total` is the call's timeout when one applies, and `message` names the current phase. Requests without a token are unaffected.
- **Foundation contracts** — every tool validates arguments, advertises an output schema and annotations, and returns structured results with operation metadata.
- **Validation rules** — `validate_project` keeps its legacy text summary, while `structuredContent.data.findings` exposes stable rule IDs, severities, project-relative locations, suggested fixes, auto-fix metadata, filters (`rule_ids`, `severities`), per-call suppressions, and cursor pagination (maximum 200 findings/page). Offline rules cover missing first scenes/assets, compiler log failures, duplicate input mappings, statically suspicious network attributes, optional required-camera checks, invalid Flax headers, settings, and scene JSON. Editor/cooker-only checks are explicitly reported as capability gaps rather than inferred.
- **Editor status** — `get_server_capabilities` and `editor_get_status` validate a matching live heartbeat at `Cache/MCP/bridge.json`; otherwise the server reports offline mode. Project identity includes an explicit project ID when present and an opaque SHA-256 path fingerprint, never the full project path.
- **Waiting for the Editor** — after a script change, an Editor restart, or a bridge install, call `editor_get_status` with `wait_ready:true` (add `require_scene:true` before scene work and `min_bridge_version:34` after installing a new bridge file) instead of sleeping and retrying. The usual restart cycle is `editor_quit` (`unsaved:"save"` or `"discard"`, `stop_play:true` if needed) -> build or edit offline -> start the Editor (`editor_launch` when the server runs with `--flax-editor`) -> `editor_get_status` with `wait_ready:true`. Remote `UNAUTHORIZED` (the bridge session token changed after a script reload or an Editor takeover) is reported as `EDITOR_BUSY` with `retryable:true` and `reason:"bridge_session_changed"`: reads may be repeated, writes are never retried automatically.
- **Several Editors, one project (bridge v34)** — only one Editor owns `Cache/MCP` (decided from `bridge.json`: a live process with a heartbeat younger than 30 s). Another Editor that opens the same project stays on standby: it writes no token or heartbeat and answers nothing until the owner exits or stalls for more than 30 seconds, then takes over with a new session token. A client therefore always reaches the owner.
- **Testing a cooked build (bridge v35)** -- a cooked Development game can run a second bridge, `bridge/FlaxMcpRuntimeBridge.cs`, so several game instances can be driven from the same MCP session without the Editor. The runtime bridge is compiled only under `FLAX_GAME && !BUILD_RELEASE`, does nothing unless the game is started with `-mcpdir`, and is never part of a Release cook: a Release build contains no bridge and cannot be driven this way.
  1. Install it before cooking: `install_editor_bridge` with `include_runtime:true` (preview with `dry_run:true` first), then let the Editor recompile (`editor_get_status` with `wait_ready:true`).
  2. Cook a Development build with `build_cook` (`configuration:"development"`, an empty `output_path` below `Builds/`).
  3. Start the server with `--allow-game-launch` and launch two instances with `game_launch`: `{exe:"<cooked exe below the output path>", instance:"host"}` and `{exe:"<same exe>", instance:"client", args:["-windowed"]}`. `exe` is relative to the project root and must resolve to a file inside it (on Windows an `.exe`); the cook output below `Builds/` always qualifies.
  4. Drive them by passing `instance`: `runtime_invoke_script_method`, `runtime_set_script_value`, `runtime_inspect_actor`, `log_search` / `log_get_recent` / `log_get_runtime_errors`, `viewport_capture` (`viewport:"game"`; the PNG is copied into the usual capture cache and returned as a `flax://capture/<id>` resource, and its size is the game window's, not selectable), `perf_get_snapshot`, `perf_capture`, `perf_get_gpu_events` (runtime bridge v36), `play_set_time_scale`. `game_list_instances` shows what is live.
  5. Stop them: `game_stop {instance:"host"}`, then `game_stop {instance:"client", force:true}` if one hangs. `force` works only for a game launched by this server process; through the `flax-mcp call` CLI each call is its own process, so `force` cannot kill a game an earlier CLI call launched.

  An `instance` call goes to the game's runtime bridge: the Editor play-mode and headless gates do not apply, there is no play session (`play_session_id` with `instance` is `INVALID_ARGUMENT`), members are found through `System.Reflection` and only public fields and properties declared in game code are visible (no `Content/` path or `engine:` lookup, asset references take a GUID), and writes have no undo and are gone when the game exits. A game that is not running, whose heartbeat is older than 30 s, or whose session token is gone answers `GAME_NOT_CONNECTED` (the game counterpart of `EDITOR_NOT_CONNECTED`). The tool envelope `mode` for a call that reached a game is `game-connected` (otherwise `offline` or `editor-connected`). Each instance keeps its files under `Cache/MCP-Runtime/<instance>`; no tool returns that path. There is no input simulation in a cooked game (Flax 1.12 has no managed input injection), so drive it through its own script methods. The runtime bridge has not yet been verified live against a cooked build; see [`docs/TESTING.md`](docs/TESTING.md).
- **Bridge installation** — preview with `install_editor_bridge` using `dry_run:true`; replacement requires the installed `expected_hash` or explicit `force:true`. Restart/open Flax Editor and wait for C# compilation after installation. Installer changes have a separate redacted local audit at `.flax-mcp/bridge-install-audit.jsonl`. `include_runtime:true` also installs `bridge/FlaxMcpRuntimeBridge.cs` as `Source/<module>/MCP/FlaxMcpRuntimeBridge.cs`, next to `FlaxMcpBridge.cs`, with the same guards: preview with `dry_run:true`, replacing a file that differs needs `runtime_expected_hash` (the installed hash) or `force:true`, and nothing is written when either file is refused. Both files carry a first-line `// MCP-BRIDGE-VERSION: <n>` marker (34 for the Editor bridge, 35 for the runtime bridge). The runtime file compiles to nothing in the Editor and in Release game builds.
- **Live editor operations** — scene/actor/script operations require bridge v5 or newer. Compile, play, live-log, capture, and runtime-inspection tools require bridge v6; the `editor` viewport selector for `viewport_capture` requires bridge v22. Revisions, edit leases, idempotency keys, local-transform/layer actor patches, and extended actor-find filters require bridge v7. Tools added later state their own minimum in the tables above (`(bridge vNN)`); a bridge older than that fails the call with `UNSUPPORTED_FLAX_VERSION`. Editor API mutations execute on Flax's main thread, and actor/script mutations integrate with the Undo stack. Transactions and atomic batches are not advertised.
- **Safe actor and script surface** — v7 actor snapshots expose parent ID, sibling order, child count, active-in-hierarchy, local and world transforms, tags (up to 64), layer index/name, static flags, and attached scripts. `actor_update` only patches name, active, one transform space per call (world or local), the actor's layer, and the bridge v15 model/graph assignments listed in the tools table; other component and engine-actor members go through `actor_set_property` (bridge v33), which is limited to editor-visible members. `script_instance_update` is an optional-patch API with exactly one supported field, `enabled`; script values are written with `script_instance_set_value` at edit time (bridge v28) or `runtime_set_script_value` during play (bridge v33); both write editor-visible script members, including nested members through `path` (bridge v34). `script_instance_get` with `include_values:true` returns a bounded read-only projection of public script field values (bool/int/float/string/enum/Guid/Vector2-4/Color, max 64 alphabetically, strings capped at 512 chars; from bridge v34 asset references as GUID plus type name and nested user struct and class values up to two levels deep; collections and other unsupported types are null with a reason). The projection never mutates the script and stays under the bridge 512 KiB response cap.
- **Bridge v7 revisions** — status, loaded-scene/tree/actor/script reads, and scene actor/script mutation results include `ProjectRevision`; scene-scoped values also include `SceneRevision`. These counters live for the connected bridge Editor session and advance only for mutations made through this bridge. They do not detect unsaved manual Editor edits because no verified Flax 1.12 editor event is used for that purpose. Pass `expected_scene_revision` to a live write to reject a stale bridge-known scene with `SCENE_REVISION_CONFLICT` and the current revision in error details. For guarded `actor_create`, provide `parent_id` in the target scene so the bridge can identify the scene before spawning.
- **Edit leases are not transactions** — `edit_begin_lease` creates a TTL-bound (1-300 s) coordination lease scoped to one loaded scene or, since bridge v16, one Visject graph asset. The holder supplies `lease_id` on writes; other bridge writes to that scene or graph asset are rejected while it is active, and play start, `scene_open`, and `scene_close` are gated until the lease expires, is committed, or is released. Mutations remain visible immediately. `edit_commit_lease` and `edit_release_lease` only end the lease; neither commits an atomic batch nor rolls changes back. `TransactionsSupported` remains `false`.
- **Idempotent retries** — live mutations accept an optional `idempotency_key`; v7 caches a matching method/request result for ten minutes (up to 512 entries) and replays it without repeating the mutation or revision increment. Reusing a key for different input returns `IDEMPOTENCY_KEY_REUSED`. Create, duplicate, and script-attach operations are the main recommended uses.
- **Compile → diagnose → run loop** — patch source, call `code_compile`, inspect `code_get_diagnostics`, start play, query session-scoped logs/runtime state, optionally capture the viewport, then stop. Compile polling tolerates the bridge assembly and token being replaced during reload without blindly repeating the compile mutation.
- **Flax 1.12 headless limitation** — headless editors support bridge status, compilation, diagnostics, and logs, plus the v33 checks recorded in [`docs/TESTING.md`](docs/TESTING.md) (member reads, project-settings writes, scene and content creation, scene open/close, and the domain queries), but reject play start. Flax 1.12 cannot reliably complete play cleanup without its game window; runtime inspection and viewport capture (game or editor) therefore require a headed editor. Edit-time writes that need Editor windows or the live scene (`actor_set_property`, `script_instance_set_value`, `ui_control_*` writes, `particle_set_parameter`, material writes, graph tools, foliage writes, `lighting_bake`, `environment_probe_bake`, `editor_set_selection`) are refused when the Editor is headless (`navigation_build` is the exception since bridge v34: the CPU navmesh build needs no window); the table below lists the code each tool reports. `actor_create`, `actor_update`, `actor_delete`, `script_attach`, `script_detach`, and `edit_undo` have no headless gate and work in a headless Editor. Game captures additionally require play mode; editor captures use `EditWin.Viewport.Task` and work outside play mode, but only while the Edit tab is the selected tab of its dock panel: with the Game tab in front (as it is after play mode) the capture reports `completed` with a fully transparent image.
- **Headless workflow** — a headless Editor (`-headless`) runs the bridge like a headed one, and `status.IsHeadless` tells a client which mode it is talking to. Works headless: `editor_get_status` (including `wait_ready`), `editor_quit`, `editor_options`, `code_compile` / `code_get_diagnostics` / `code_generate_project`, logs, asset search/import/reimport/organize/create and import settings, content folder creation, project settings writes, scene create/open/close/save/list, scene file edits, `actor_create` / `actor_update` / `actor_delete`, `script_attach` / `script_detach`, `edit_undo`, the member reads (`actor_get_properties`, `ui_control_get_properties`, `script_instance_get`), the physics, navigation, lighting, and terrain/foliage read queries, and `navigation_build`. Refused headless with `HEADLESS_MODE`: play start (`play_start_scenes`, `play_start_game`, `test_run_scenario`), `editor_set_selection`, viewport capture, the Visject graph tools (`graph_inspect`, `graph_list_archetypes`, `graph_edit`, graph writes, `graph_undo`, `animgraph_*` writes), the member writes that need Editor windows (`actor_set_property`, `script_instance_set_value`, `ui_control_*` writes, `particle_set_parameter`, material writes), `lighting_bake`, `environment_probe_bake`, and foliage writes. A typical agent cycle is `editor_launch` (with `--flax-editor`, `headless:true`) -> `editor_get_status` with `wait_ready:true` -> edit and `code_compile` -> `editor_quit`. The refusals come from the bridge's `IsHeadlessMode` gates (`bridge/FlaxMcpBridge.cs`).
- **Error codes for headless and play-mode refusals** — the bridge answers both with wire code `INVALID_STATE`; the tools report the codes below (observed on Flax 1.12.6912). `HEADLESS_MODE` means a retry cannot help; `EDITOR_BUSY` and `INVALID_PLAY_STATE` clear when play stops.

  | Tools | Headless Editor | Play mode (headed) |
  |---|---|---|
  | `actor_set_property`, `script_instance_set_value`, `ui_control_create`, `ui_control_set_property`, `particle_set_parameter`, `material_set_parameters`, `material_create_instance`, `material_assign_to_actor` | `HEADLESS_MODE` | `EDITOR_BUSY` |
  | `foliage_add_instances`, `foliage_remove_instances`, `lighting_bake`, `environment_probe_bake`, `terrain_paint` | `HEADLESS_MODE` | `INVALID_PLAY_STATE` |
  | `navigation_build` | works headless | `INVALID_PLAY_STATE` |
  | `editor_set_selection`, `graph_inspect`, `graph_list_archetypes`, graph edits (`graph_edit`, `animgraph_set_transition`, ...), `graph_undo` | `HEADLESS_MODE` | not gated by play mode |
  | `play_start_scenes`, `play_start_game` (and `test_run_scenario`, as a failed start) | `HEADLESS_MODE` | — |
  | `viewport_capture` | `CAPTURE_UNAVAILABLE` | — |
  | `runtime_set_script_value`, `runtime_invoke_script_method`, `play_pause` outside play | `INVALID_PLAY_STATE` | — |
  | `settings_*` writes | allowed | `EDITOR_BUSY` |

- **Editor auto save** — the Flax Editor saves edited scenes and content on its own every five minutes by default (Options → General → Auto Save), headless or headed. A tool result that says the scene was marked edited and not saved is true when it is returned, but the Editor may write the scene to disk shortly afterwards without any MCP call. After a script hot reload the Editor can also report a scene as not edited while unsaved edits are still live.
- **A `TIMEOUT` on a write means the outcome is unknown** — the bridge checks the deadline before it starts a request and cannot cancel one already running, so a call that timed out may still have taken effect. Read the state back before retrying.
- **Temporary capture resources** — viewport PNGs stay below `Cache/MCP/captures`, are size/age bounded, and can be read with MCP `resources/read` using the returned `flax://capture/<id>` URI. Physical paths are not returned.
- **MCP resources** — `resources/list` exposes bounded JSON for project info/summary/settings, Editor status, loaded scenes, current diagnostics, recent logs, script compilation status (`flax://build/status`; it is not the GameCooker `build_*` state), and redacted audit entries, plus temporary captures. `resources/templates/list` advertises scene/actor templates only with bridge v5+ and asset templates only with v8+. Resource JSON is redacted and capped at 256 KiB; list cursors are opaque and expire after ten minutes.
- **Resource subscriptions** — `resources/subscribe` supports Editor status, a live scene tree, latest diagnostics, and recent logs (maximum 128). Notifications are debounced by about 350 ms after successful calls of a fixed set of MCP tools (scene save, actor create/update/delete/duplicate/reparent, script attach/detach/enabled patch, undo/redo, C# source writes, compile and project generation, and play controls; later write tools such as `actor_set_property` or `scene_open` do not trigger them); Editor status also observes the bridge heartbeat at a bounded interval. Flax 1.12 has no verified general Editor event feed, so manual Editor/third-party changes are not promised; clients must refresh after changes made outside MCP. A successful viewport capture emits `notifications/resources/list_changed`.
- **Script mutations are hardened** — writes stay under `Source/`, reject symlink/junction escapes, use same-directory atomic replacement, support dry-run and expected hashes, and record redacted audit metadata.
- **Scene writes are legacy offline operations** — `create_actor` and `modify_actor` require `allow_offline_write:true`, refuse to run while the bridge is connected, directly edit serialized `.scene` files, and create a `.bak`; they do not use Flax Editor Undo/Redo or transactions.
- Run `npm test` to build and execute contract, resource, status, read-tool, script-safety, bridge-installer, file-RPC, live-editor, compile/play, and observability suites.
- **Editor integration fixtures** — `npm test` also creates isolated, disposable fixture projects and simulates the file-RPC peer for DTO and fault-injection coverage. This is not a claim that Flax GUI was run. The Windows/Flax 1.12 baseline and the manual headed-Editor procedure are recorded in [`docs/TESTING.md`](docs/TESTING.md) and [`test/compatibility-matrix.json`](test/compatibility-matrix.json).
