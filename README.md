# Flax Engine MCP

An MCP (Model Context Protocol) server that lets MCP clients interact with [Flax Engine](https://flaxengine.com/) game projects. It exposes 170 tools for reading and patching code, editing live scenes and actor properties, building UI, searching/importing/creating assets, working with safe live-prefab primitives, editing materials, animation graphs, and project settings, physics/navigation/lighting diagnostics, compiling, running and driving bounded play-mode checks, inspecting logs, and local diagnostics.

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

## Permissions

The default profile is `full`, preserving existing installations. Use a narrower profile for agent sessions that do not need every capability:

```bash
flax-mcp --project-path /path/to/project --permission-profile read-only
flax-mcp --project-path /path/to/project --permission-profile code-edit
flax-mcp --project-path /path/to/project --permission-profile scene-edit
flax-mcp --project-path /path/to/project --permission-profile full
```

- `read-only` permits inspection only.
- `code-edit` adds source generation/patching and compile operations.
- `scene-edit` adds scene editing and play-mode controls, but not source or asset changes.
- `full` permits every released tool.

Use repeatable `--allow-tool <name>` and `--deny-tool <name>` overrides for a specific server process; deny always wins. `--emergency-read-only` is an immediate safety switch: it blocks every mutation and runtime-control tool even if it was explicitly allowed. Tool discovery and `get_server_capabilities` report the tools available under the active policy.

Asset import is separately opt-in. By default no external file can be imported or reimported. Configure one or more canonical source roots when starting the server; the root locations themselves are never returned by MCP:

```bash
flax-mcp --project-path /path/to/flax/project \
  --asset-import-root /path/to/approved-art \
  --asset-import-root /path/to/approved-audio
```

Only the built-in Flax 1.12 texture, model, and audio source extensions are accepted, source files are capped at 512 MiB, and destination paths must be `Content/.../*.flax`. Symlinks and junctions are resolved before every import; collisions fail by default or can use the bounded `rename` policy.

## Doctor and local observability

Run a read-only diagnostic before connecting a client:

```bash
flax-mcp doctor --project-path /path/to/project
flax-mcp doctor --project-path /path/to/project --json
```

`doctor` checks Node, project metadata, declared Flax version, bridge installation and heartbeat/protocol, active permission flags, and cache/source/settings readability. It never reads the bridge token or prints the project path. Exit codes are stable: `0` means no failed checks (warnings are allowed), `1` means a check failed, and `2` means invalid doctor usage.

The read-only `server_get_health`, `server_get_metrics`, and `server_get_recent_errors` tools provide bounded, in-process health data. Metrics include tool counts, error codes/rate, P50/P95 duration, and observable IPC failures; recent errors have a maximum of 100 entries and redact token-like values. They reset when the MCP process restarts. Cloud telemetry is disabled and no metrics leave the process.

## Tools

### Project Info
| Tool | What it does |
|------|-------------|
| `get_server_capabilities` | Server/project identity, feature flags, mode, and Editor Bridge availability |
| `editor_get_status` | Validates the live bridge heartbeat, project identity, process, and freshness |
| `server_get_health` | Process-local health and bridge availability without secrets or cloud telemetry |
| `server_get_metrics` | Bounded in-process tool timing, error, and IPC-failure metrics |
| `server_get_recent_errors` | Up to 100 recent redacted in-process tool and IPC errors |
| `search_tools` | Keyword search over the permission-filtered tool registry by name and description |
| `get_editor_bridge_installation` | Compare bundled and installed Editor Bridge versions and hashes |
| `install_editor_bridge` | Preview or safely install the bridge into the editor target's detected game module; accepts `module` when targets are ambiguous |
| `get_project_info` | Project config from `.flaxproj` — name, version, default scene, directory layout |
| `get_game_settings` | Contents of `GameSettings.json` — product name, scene ID, all sub-settings refs |
| `get_project_summary` | Full project overview in one call — scripts, scenes, assets, settings, docs |
| `project_get_packages` | Offline `.flaxproj` reference inspection — engine/plugin/other refs with existence flags plus `Plugins/` names (no absolute paths) |

### Scripts
| Tool | What it does |
|------|-------------|
| `list_scripts` | List all C# scripts with size and modification time |
| `read_script` | Read a script by filename or path |
| `write_script` | Atomically create or overwrite a script with dry-run, expected-hash checks, and audit logging |
| `apply_script_patch` | Validate and atomically apply a bounded unified diff with dry-run and expected-hash support |
| `get_audit_entries` | Read recent redacted script mutation audit records |

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
| Tool | What it does |
|------|-------------|
| `play_get_status` | Read lifecycle state, session, duration, dirty-scene state, and frame count |
| `play_start_scenes` / `play_start_game` | Start current scenes or the configured first scene after safety gates |
| `play_stop` / `play_pause` / `play_resume` | Control the active simulation |
| `play_step_frame` | Advance a paused simulation one request at a time and verify Flax's run-to-repause lifecycle before continuing |
| `play_set_time_scale` | Set the play-mode time scale 0–10 (0 freezes for frame-step debugging) via `FlaxEngine.Time.TimeScale`; requires play mode, bridge v23. The bridge never resets it on `play_stop` — it persists until changed or play stops (Flax owns play lifecycle; set explicitly after each play start) |
| `input_key_press` | Simulate one key press in running, unpaused play (bridge v26). Managed-Flax-API-only scope: Flax 1.12 exposes no managed key-injection primitive, so valid calls report `UNSUPPORTED_FLAX_VERSION` after gates and validation |
| `input_mouse_click` | Simulate one Left/Right/Middle click at viewport-normalized x/y in running, unpaused play (bridge v26). Managed-Flax-API-only scope: Flax 1.12 exposes no managed button-injection primitive, so valid calls report `UNSUPPORTED_FLAX_VERSION` after gates and validation |
| `play_run_for` | Run for seconds, frames, or until a session-correlated log match, then request stop |
| `test_run_scenario` | Run a bounded gameplay smoke scenario for `run_seconds` and assert `log_contains`/`log_absent`/`no_errors`/`viewport_captured` conditions, always stopping play |
| `runtime_inspect_actor` | Read a bounded, allowlisted actor snapshot during play mode |
| `runtime_set_script_value` | During play mode, write one editor-visible field or property of a game script (members declared in game code only). No undo; the value is discarded when play stops (bridge v33) |
| `runtime_invoke_script_method` | During play mode, invoke one public, non-generic method declared in game code with up to four scalar arguments and return its result. A game exception comes back as data (`Threw`, `ExceptionType`), not as a tool error (bridge v33) |
| `perf_get_snapshot` | Read one instantaneous engine performance snapshot (FPS, frame time, draw calls, triangles, managed memory, actor count, GPU adapter/renderer). Works outside play mode (editor viewport rate) and in play mode; GPU fields are null when headless; single sample, no averaging (bridge v27) |
| `viewport_capture` | Capture the game viewport (requires play mode) or the editor viewport (bridge v22, works outside play mode) and return a readable temporary `flax://capture/<id>` PNG resource |
| `capture_compare` | Diff two viewport capture PNGs (`flax://capture/<id>` URIs or bare 32-hex ids) per pixel against a `threshold` fraction, with an optional red-overlay `emit_diff` PNG readable as a new capture resource |

### Live Logs
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
| `scene_open` | Open one Content scene asset by GUID or project-relative path (async — poll `scene_list_loaded`; an already-loaded scene is a no-op; refuses play mode, compiling scripts, active edit leases, and edited scenes unless `allow_dirty_scenes:true`) (bridge v25) |
| `scene_create` | Create a new `Content/.../*.scene` file from the Editor default template (Sun, Sky, SkyLight, Floor, Camera). Never overwrites and does not open it; `dry_run` previews, a real write needs `confirm:true` (bridge v33) |
| `scene_close` | Unload one loaded scene through the Editor scene state machine without the modal save prompt (async — poll `scene_list_loaded`). Refuses play mode, compiling scripts, active edit leases, and unsaved edits unless `allow_dirty:true`, which discards them (bridge v33) |
| `project_save_all` | Ask Flax Editor to save all edited project content |
| `actor_get` / `actor_find` | Read or search live actors; v7 snapshots include bounded hierarchy, local/world-transform, tags, and layer metadata |
| `actor_create` / `actor_update` | Create or patch allowlisted actor fields with dry-run support |
| `actor_get_properties` | List the editor-visible members of a live actor (the same selection the Flax property grid shows) with type, value, enum names, editor limits, and writability; works in play mode too (bridge v33) |
| `actor_set_property` | Set one editor-visible member of a live actor (`Mass`, `RigidBody.IsKinematic`, `BoxCollider.Size`, `AudioSource.Clip`, ...) through the Editor property wrapper with editor undo and a `dry_run` preview. Asset references take a GUID or `Content/` path, actor references a GUID, `""` clears (bridge v33). The aliases `Light.Color`, `Light.Brightness`, `Camera.FieldOfView`, `StaticModel.Model`, `Script.Enabled` work from bridge v28 |
| `actor_delete` / `actor_duplicate` | Delete or duplicate an actor with editor undo support |
| `actor_reparent` | Reparent an actor while preserving its world transform by default |
| `script_attach` / `script_detach` | Attach or detach a script with editor undo support |
| `script_instance_get` / `script_instance_update` | Read a script instance or patch its enabled state (arbitrary serialized script properties are deferred). `script_instance_get` accepts opt-in `include_values` for a bounded read-only projection of whitelisted public field values (bool/int/float/string/enum/Guid/Vector2-4/Color; max 64 fields alphabetically, strings capped at 512 chars, unsupported types are null with a reason; never mutates the script) |
| `script_instance_set_value` | Write one whitelisted public script field (same type whitelist) through the Editor property-grid wrapper with editor undo; Guid/Vector/Color values are strict strings; `dry_run` previews coercion with `would_change` plus before/after (bridge v28) |
| `edit_undo` / `edit_redo` | Execute the Flax Editor undo/redo stack |
| `editor_get_selection` / `editor_set_selection` | Read the editor actor selection (bounded IDs, names, parent scene IDs; empty is an empty list) or replace it with 1–200 actor IDs; optional `focus_viewport` frames the EditWin viewport on the new selection (bridge v24) |
| `edit_begin_lease` / `edit_get_lease` | Acquire or inspect a bounded v7 scene edit lease |
| `edit_commit_lease` / `edit_release_lease` | End a lease after visible edits; neither operation rolls changes back |

### Assets
| Tool | What it does |
|------|-------------|
| `get_asset_info` | Inspect JSON assets or the type, GUID, and version header of binary `.flax` assets |
| `reimport_asset` | Compatibility alias: delegates to `asset_reimport` with a v9 bridge; otherwise gives safe manual instructions and never launches an OS process |
| `list_assets` | List Content/ assets by type (scene, material, settings, other) with GUIDs |
| `asset_search` | Search the connected Content registry with filters, dependency/reference counts, and opaque cursor pagination (bridge v8) |
| `asset_get` | Read stable metadata for one Content asset selected by GUID or project-relative path (bridge v8) |
| `asset_dependencies` | Read direct or cycle-safe transitive dependency edges, depth-bounded to 16 (bridge v8) |
| `asset_find_references` | Find direct reverse references from source assets/scenes/prefabs without property paths (bridge v8) |
| `asset_import` / `asset_import_status` | Start or poll an allowlisted external import with dry-run, collision, and idempotency guards (bridge v9) |
| `asset_reimport` / `asset_reimport_status` | Start or poll a reimport using only Flax asset metadata and configured import roots (bridge v9) |
| `asset_get_import_settings` | Read bounded import options for one texture/model/audio asset: restored metadata or engine defaults (bridge v32) |
| `asset_set_import_settings` | Preview (`dry_run`) or apply allowlisted import-option scalars via reimport; polls via `asset_reimport_status` (bridge v32, requires `--asset-import-root`) |
| `asset_move` | Move one registry asset to an existing Content folder, with dry-run, collision, stale-index, and idempotency guards (bridge v10) |
| `asset_rename` | Rename one registry asset without changing its extension, with bounded reference impact (bridge v10) |
| `asset_duplicate` | Duplicate one registry asset to a named Content destination; existing references remain on the source (bridge v10) |
| `asset_delete` | Move one asset to an existing quarantine folder after explicit, current reference-count confirmation; it never permanently deletes data (bridge v13) |
| `asset_create` | Create one new empty asset the way the Editor Content window does: a binary `.flax` asset by kind (`Material`, `MaterialInstance`, `MaterialFunction`, `ParticleEmitter`, `ParticleEmitterFunction`, `ParticleSystem`, `AnimationGraph`, `AnimationGraphFunction`, `Animation`, `SceneAnimation`, `SkeletonMask`, `BehaviorTree`, `CollisionData`) or a `.json` data asset of a class (`kind: "JsonAsset"` plus `type_name`). Never overwrites; `dry_run` previews, a real write needs `confirm:true` (bridge v33) |
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
| `ui_control_set_property` | Set one of those control members through the Editor property wrapper with editor undo and a `dry_run` preview (bridge v33) |

### Particles
| Tool | What it does |
|------|-------------|
| `particle_get_parameters` | List the parameters a `ParticleEffect` actor exposes from its `ParticleSystem`: emitter track, name, type, value, default (bridge v33) |
| `particle_set_parameter` | Override one public parameter on a `ParticleEffect` actor through `ParticleEffect.SetParameterValue` with editor undo and `dry_run` (bridge v33) |

Audio needs no dedicated tools: `AudioSource.Clip`, `Volume`, `IsLooping`, `PlayOnStart` and the rest are editor-visible members, so `actor_create` plus `actor_set_property` configure them. The same goes for `ParticleEffect.ParticleSystem`.

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
| material_get_parameters | Read bounded public Material/MaterialInstance parameter metadata and safe value projections (bridge v13) |
| material_set_parameters | Set 1-16 named parameters on one Material/MaterialInstance with dry-run preview, editor undo, Asset.Save persistence, and unload/reload durability verification (bridge v29) |
| material_create_instance | Create a persisted MaterialInstance from one Material into a new Content/.../*.flax file, never overwriting (bridge v29) |
| material_assign_to_actor | Assign one Material/MaterialInstance to a ModelInstanceActor slot with editor undo; marks the scene edited without saving (bridge v29) |
| animation_list_clips | List registered Animation clips with public metadata and opaque cursor pagination (bridge v13) |
| animation_get_graph_parameters | Read live graph parameters from one loaded AnimatedModel (bridge v13) |
| animation_set_graph_parameter | Stable unsupported capability until an Editor-safe persistence, undo, and preview path is verified (bridge v13) |
| animation_validate_bindings | Compare a loaded AnimatedModel's public SkinnedModel, AnimationGraph, and graph BaseModel references (bridge v13) |

### Visject graphs
All graph writes go through the asset's Editor window and its save path; they are dry-run by default and saving cannot be undone.

| Tool | What it does |
|------|-------------|
| `graph_inspect` | Read a window-backed Visject graph (AnimationGraph, Material, or ParticleEmitter) as nodes, boxes, and parameters, optionally with sub-contexts (bridge v16, sub-contexts v19) |
| `graph_set_default_parameter` / `graph_add_parameter` | Persist one surface parameter default, or add one surface parameter (bridge v16) |
| `graph_undo` | Undo one step on the window-local undo stack for unsaved edits (bridge v16) |
| `graph_remove_node` / `graph_disconnect` | Delete one root-context node, or break one wire between two boxes (bridge v18) |
| `graph_set_node_values` / `graph_move_node` | Set value slots on one root node, or move it on the canvas (bridge v20) |
| `graph_set_model` | Bind a registry SkinnedModel as an AnimationGraph BaseModel; the bind pushes no undo action (bridge v21) |
| `animgraph_add_state` / `animgraph_add_transition` | Add one state or one state-to-state transition to an AnimationGraph state machine (bridge v17) |
| `animgraph_set_state_clip` | Assign an animation clip to a state by spawning a sampler and wiring Pose to State Output (bridge v20) |
| `mm_tuning` | Motion-matching tuning reads: live telemetry snapshot, top-N cost ranking from a trace, deterministic replay verify, or native search self-test (bridge v15 with `mm.tuning`) |
| `mm_apply_preset` | Apply a motion-matching weight preset (baseline, pose, turn) to live scene weights without rebaking |

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
| `settings_set_input_action` | Add or replace an input action binding (key, mouse button, or gamepad button) in the project Input settings (bridge v33) |
| `settings_set_input_axis` | Add or replace an input axis mapping (mouse, gamepad stick, or a keyboard button pair) (bridge v33) |
| `settings_remove_input_mapping` | Remove every action or axis mapping with a given name (bridge v33) |
| `settings_set_layer_name` | Name one of the 32 project layers; duplicate names are rejected (bridge v33) |
| `settings_add_tag` | Add one tag to the project Layers and Tags settings (bridge v33) |
| `settings_set_first_scene` | Set `GameSettings.FirstScene` to a Content scene asset (bridge v33) |

The `settings_*` writes go through the Editor's own `GameSettings.Load`/`Save` followed by `GameSettings.Apply`. `dry_run` returns before/after; a real write needs `confirm:true`, persists to disk immediately, and has no Editor undo record. They are refused in play mode, while scripts compile, and while the settings asset is open in an Editor window (the window keeps its own copy and would overwrite the change). Saving re-serializes the whole settings asset in the current engine format, exactly as saving from the Editor window does.

### Advanced domain queries
`physics_validate_colliders`, `physics_raycast`, `physics_get_layer_matrix`,
and `physics_find_overlaps` require bridge v14 and use bounded public Physics
queries. `navigation_get_status`, `navigation_validate_agents`, and
`navigation_query_path` are also read-only. `navigation_build` (bridge v31)
starts a navmesh build for one scene with optional bounds and polls to
completion or `timeout_ms` (a timeout reports `TIMEOUT` while the build
continues — Flax exposes no navmesh cancel API). `lighting_bake` (bridge v31)
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

Each workflow first asks the client to inspect safe MCP resources (and read-only tools when a needed resource is unavailable), honor the active permission profile, preview supported writes with `dry_run:true`, and get explicit confirmation before mutations, saves, builds, or destructive actions. The guidance uses bounded compile/play retries and reports unsupported transaction, property-editing, prefab, and build/cook operations instead of implying they occurred.

Teams can drop project-local workflow guides in `<project>/mcp-prompts/*.md`. File names must match `^[A-Za-z0-9_-]{1,64}\.md$` (up to 20 files, each up to 32 KiB); the stem becomes the prompt name, the first `# Heading` line becomes the description (otherwise the stem), and the full file text is served as the single user message on `prompts/get` with zero arguments (any argument is rejected as unknown). A missing `mcp-prompts/` directory means only the five built-ins are listed. Files with bad names, oversized content, built-in name collisions (built-in wins), or symlinks/junctions escaping the directory are skipped; the skipped count is reported as `_meta.projectPromptsSkipped` on `prompts/list`. Only stems are exposed, never absolute paths.

## Notes

- **Asset registry and graph reads** -- `asset_search`, `asset_get`, `asset_dependencies`, and `asset_find_references` require bridge v8. They use only public Flax 1.12 `Content` registry metadata and `Asset.GetReferences`; result pages are at most 200 entries, dependency depth is at most 16, registry scans are capped at 10,000 assets, and opaque cursors expire after ten minutes or invalidate when filters or registry metadata change. Paths/GUIDs are project-scoped. The bridge does not expose importer settings, file size/modified time/import status, actor/property reference locations, or inferred prefab overrides because public APIs do not verify them.
- **Asset compatibility aliases** -- `list_assets` delegates safe all/scene requests to `asset_search` with a v8 bridge; `get_asset_info` delegates `Content/...` paths to `asset_get`. Other legacy filters, bare filenames, offline projects, and bridges older than v8 keep their original filesystem-backed behavior.
- **Safe asset imports** -- `asset_import` and `asset_reimport` require bridge v9, the `full` permission profile (or an explicit tool allow override), and at least one `--asset-import-root`. They invoke only Flax's verified `Editor.Import`, `ContentImporting.Reimport`, and `BinaryAsset.ImportPath` APIs, never copy source files or launch editor processes. Type conversion outside (re)import is intentionally not exposed. New imports finish synchronously in Flax 1.12; reimports use Flax's queue and must be polled by operation ID (ten-minute retention, at most 512 records). Imports are rejected while Flax is playing, compiling/reloading, or already importing. The direct APIs are UI-free; headless availability still depends on the installed Flax Editor importer backend and should be verified in the target CI/editor setup.
- **Asset import settings (bridge v32)** -- `asset_get_import_settings` (read family, no import root needed) returns a bounded `{asset, type: texture|model|audio, restored, settings}` projection: restored importer metadata (`restored:true`) or engine `Options.Default` (`restored:false`); other asset types fail `VALIDATION_FAILED`. `asset_set_import_settings` (asset family, same full-profile plus `--asset-import-root` gating as `asset_reimport`) clones the current typed options, mutates an allowlist only — texture `srgb, compress, max_size, scale, generate_mipmaps, never_stream`; model `scale`, the `calculate/flip/reverse/optimize/merge/import_lods/import_vertex_colors` bools, both smoothing angles, `base_lod`/`lod_count`; audio `format, quality, disable_streaming, is_3d, bit_depth` — with strict ranges and exact-match enums (`Format` is `Raw|Vorbis`, `BitDepth` is `_8|_16|_24|_32`), and applies via `ContentImporting.Reimport(item, settings, skipDialog:true)` on the shared `reimport` operation records, so `asset_reimport_status` polls settings writes. `dry_run` returns `{would_change, before, after}`. Explicitly missing: dry-run validate-only import, standalone metadata write without reimport, and direct conversion outside (re)import.
- **Safe asset organization** -- `asset_move`, `asset_rename`, and `asset_duplicate` require bridge v10 and the `full` permission profile (or an explicit tool allow override). They select exactly one registry asset by GUID or `Content/...` path; destinations must be normalized existing folders inside `Content`, names cannot change an extension, and collisions either fail or receive a bounded `-N` suffix. Use `dry_run:true` before writing and pass `expected_path` and/or `expected_index_revision` from a recent asset read/search to reject stale state. The bridge calls only public Flax 1.12 `ContentDatabase.Move`, `Content.RenameAsset`, and `ContentDatabase.Copy` APIs—never a raw filesystem move/copy or reflection. Results include no more than 50 direct reverse references; actor/property locations remain unavailable. Move and rename verify that the source GUID remains; duplicate reports its new GUID while existing references continue to target the source. Flax exposes no verified undo record for these APIs, and v7 leases are scene-only, so results explicitly warn that undo and asset leases are unsupported. Calls do not save project content automatically.

- **Guarded asset deletion** -- `asset_delete` requires bridge v13 and the `full` permission profile (or an explicit allow override). It defaults to `dry_run:true` and is deliberately a quarantine move through the same public `ContentDatabase.Move` API, never `ContentDatabase.Delete`, `File.Delete`, or a raw filesystem fallback. Supply an existing dedicated Content folder as `quarantine_destination`; first review the preview, then repeat with `dry_run:false`, `confirm:true`, and either the exact `confirm_reference_count` returned by the preview or `require_unreferenced:true`. The bridge recomputes direct public `Asset.GetReferences` sources immediately before the move and rejects a changed/nonzero required count with `ASSET_REFERENCE_CONFLICT`. The selected GUID and existing references are preserved so the asset can be restored with `asset_move` or the Content Browser. Both previews and moves emit bounded audit metadata; permanent deletion is intentionally unsupported.

- **Safe prefab workflows** -- `prefab_create_from_actor`, `prefab_instantiate`, and `prefab_get_instances` require bridge v12. They use only the public Flax 1.12 `PrefabManager.CreatePrefab`, `PrefabManager.SpawnPrefab`, `Actor.IsPrefabRoot`, and `SceneObject.PrefabID` APIs. Creation accepts only a new project-relative `Content/.../*.prefab` path and never overwrites; it defaults `auto_link:false`. Instantiation requires a loaded `parent_id`, so the bridge can check the target scene revision/lease before it writes; top-level placement is deliberately deferred because Flax's unparented spawn selects its first loaded scene. Instance results are limited to currently loaded scenes, capped at 10,000 scanned actors and 200 entries/page; cursors expire after ten minutes. The bridge does not inspect or edit prefab files, use reflection, or claim unloaded-scene coverage.
- **Prefab override workflows** -- `prefab_get_overrides`, `prefab_revert_overrides`, `prefab_apply_overrides`, and `prefab_break_link` require bridge v30. The diff is bridge-synthesized (live subtree vs `Prefab.GetDefaultInstance()` defaults, 200 actors/entries cap, `Name`/`IsActive`/local transform/`Layer` only — not the engine diff window) because Flax 1.12 exposes no `ApplySingle`, `GetPrefabObjectIds`, or per-property diff/revert enumerator. Revert copies defaults into 1-32 listed actors (no cascade, no per-property revert) with editor undo; apply is whole-instance `PrefabManager.ApplyAll` with `confirm:true` plus a manual before-snapshot, and its prefab-asset save cannot be undone by `edit_undo`; break uses the reviewed `BreakPrefabLinkAction` undo path with `confirm:true`. No prefab open-stage tool is exposed (`PrefabsModule.OpenPrefab` is window-backed with no verified headless-safe stage API).

- **Foliage, navmesh, bake, and probe workflows** -- `foliage_add_instances`, `foliage_remove_instances`, `navigation_build`, `lighting_bake`, and `environment_probe_bake` require bridge v31 (all edit-time only: headless and play mode fail `INVALID_STATE`). Foliage batches are capped at 200 instances per call with one editor undo step, one `RebuildClusters` plus `UpdateCullDistance` (no progress/cancel API), local-space positions, and scene-edited-without-save semantics. Navmesh builds poll `IsBuildingNavMesh`/`NavMeshBuildingProgress` to completion or `timeout_ms` (`TIMEOUT` while the build continues; no cancel API; output persists via scene save by the user). Lightmap baking toggles via `BakeLightmapsOrCancel` with start-while-baking/cancel-while-idle no-op safety and `End(failed:true)` conflating failure with cancellation. Probe baking polls `HasContentLoaded`, which cannot distinguish a fresh bake from previously baked content. `terrain_paint` requires bridge v31 but stays a validated `UNSUPPORTED_FLAX_VERSION` stub: Flax 1.12 terrain data accessors return raw pointers (unsafe context not verified for Flax script compilation) and the `EditTerrain*` undo actions are internal editor types with no public factory.

- **Bounded build/cook workflows** -- `build_list_targets`, `build_validate`, `build_cook`, `build_get_status`, `build_get_result`, and `build_cancel` require bridge v13. They invoke only public Flax 1.12 `GameCooker.Build`, `GameCooker.Cancel`, event, and progress APIs. Output must be a non-empty project-relative directory below `Builds/`; non-empty destinations, arbitrary command lines, presets, package settings, and paths outside the project are rejected. Validation is deliberately preflight-only because Flax does not expose a reviewed managed API for toolchain availability. Build cancellation is asynchronous: acknowledgement means the request reached GameCooker, while a terminal cancellation requires later polling.

- **Editor-visible members (bridge v33)** -- `actor_get_properties`, `actor_set_property`, and the `ui_control_*` tools reach only members the Flax property grid would show: public or `[ShowInEditor]`, never `[HideInEditor]` (the selection rule of the Editor's `GenericEditor.GetItemsForType`). Writes additionally refuse `[ReadOnly]` and `[NoSerialize]` members, numeric values outside a member's `[Limit]`/`[Range]` bounds, and the Actor base members that `actor_update` owns (name, active, transform, layer, tags). The one exception to `[HideInEditor]` is the UI control layout set (`AnchorPreset`, `AnchorMin`, `AnchorMax`, `LocalX`, `LocalY`, `Width`, `Height`, `Offsets`), which the Editor edits through its dedicated UI control editor instead of the generic grid. Supported value types: bool, numbers, string, enum (names, comma-separated for flags), Guid, Vector/Float/Double/Int 2-4, Color, Quaternion, Rectangle, Margin, LocalizedString, LayersMask, asset references, `JsonAssetReference<T>`, and actor/script references. Values are written through `ScriptMemberInfo.SetValue`, the wrapper the property grid uses, inside a bridge undo action. All of these are edit-time only: headless editors and play mode are refused.
- **Driving gameplay in play mode (bridge v33)** -- Flax 1.12 binds no managed key or mouse injection (`Keyboard::OnKeyDown` and `Mouse::OnMouseDown` are not exposed to C#), so `input_key_press` and `input_mouse_click` stay validated stubs. Gameplay is driven through the game's own scripts instead: `runtime_set_script_value` writes an editor-visible script member and `runtime_invoke_script_method` calls a public, non-generic method declared in game code (never an engine method or a property accessor). Both require play mode, record no undo, and never mark a scene edited; Flax restores the edit-time scene when play stops.
- **Scene and content creation (bridge v33)** -- `scene_create`, `asset_create`, and `content_create_folder` never overwrite, reject paths that resolve outside `Content/` (symlinks and junctions included), and refresh the Editor Content database so the result is visible to `asset_get` immediately. `asset_create` accepts the asset tags the Editor's own asset proxies pass to `Editor.CreateAsset`, and for `JsonAsset` exactly the classes the Editor "Json Asset" dialog accepts, plus types with a registered spawnable JSON proxy such as `FlaxEngine.PhysicalMaterial`. Creation has no Editor undo record; remove an unwanted file with `asset_delete`.
- **Progress notifications** -- a `tools/call` request carrying `_meta.progressToken` receives `notifications/progress` while the server waits: compile and project-generation polls, play-state waits, `play_run_for`, asset import waits, build waits, viewport captures, and any single bridge call the Editor has not answered within a second. `progress` is milliseconds elapsed since the call started (so it always increases), `total` is the call's timeout when one applies, and `message` names the current phase. Requests without a token are unaffected.
- **Foundation contracts** — every tool validates arguments, advertises an output schema and annotations, and returns structured results with operation metadata.
- **Validation rules** — `validate_project` keeps its legacy text summary, while `structuredContent.data.findings` exposes stable rule IDs, severities, project-relative locations, suggested fixes, auto-fix metadata, filters (`rule_ids`, `severities`), per-call suppressions, and cursor pagination (maximum 200 findings/page). Offline rules cover missing first scenes/assets, compiler log failures, duplicate input mappings, statically suspicious network attributes, optional required-camera checks, invalid Flax headers, settings, and scene JSON. Editor/cooker-only checks are explicitly reported as capability gaps rather than inferred.
- **Editor status** — `get_server_capabilities` and `editor_get_status` validate a matching live heartbeat at `Cache/MCP/bridge.json`; otherwise the server reports offline mode. Project identity includes an explicit project ID when present and an opaque SHA-256 path fingerprint, never the full project path.
- **Bridge installation** — preview with `install_editor_bridge` using `dry_run:true`; replacement requires the installed `expected_hash` or explicit `force:true`. Restart/open Flax Editor and wait for C# compilation after installation. Installer changes have a separate redacted local audit at `.flax-mcp/bridge-install-audit.jsonl`.
- **Live editor operations** — scene/actor/script operations require bridge v5 or newer. Compile, play, live-log, capture, and runtime-inspection tools require bridge v6; the `editor` viewport selector for `viewport_capture` requires bridge v22. Revisions, edit leases, idempotency keys, local-transform/layer actor patches, and extended actor-find filters require bridge v7. Editor API mutations execute on Flax's main thread, and actor/script mutations integrate with the Undo stack. Transactions and atomic batches are not advertised.
- **Safe actor and script surface** — v7 actor snapshots expose parent ID, sibling order, child count, active-in-hierarchy, local and world transforms, tags (up to 64), layer index/name, static flags, and attached scripts. `actor_update` only patches name, active, one transform space per call (world or local), and the actor's layer; component and engine-actor members go through `actor_set_property` (bridge v33), which is limited to editor-visible members. `script_instance_update` is an optional-patch API with exactly one supported field, `enabled`; script field values are written with `script_instance_set_value` at edit time (bridge v28) or `runtime_set_script_value` during play (bridge v33). `script_instance_get` with `include_values:true` returns a bounded read-only projection of whitelisted public script field values (bool/int/float/string/enum/Guid/Vector2-4/Color, max 64 alphabetically, strings capped at 512 chars; unsupported types are null with a reason; live asset references are excluded). The projection never mutates the script and stays under the bridge 512 KiB response cap.
- **Bridge v7 revisions** — status, loaded-scene/tree/actor/script reads, and scene actor/script mutation results include `ProjectRevision`; scene-scoped values also include `SceneRevision`. These counters live for the connected bridge Editor session and advance only for mutations made through this bridge. They do not detect unsaved manual Editor edits because no verified Flax 1.12 editor event is used for that purpose. Pass `expected_scene_revision` to a live write to reject a stale bridge-known scene with `SCENE_REVISION_CONFLICT` and the current revision in error details. For guarded `actor_create`, provide `parent_id` in the target scene so the bridge can identify the scene before spawning.
- **Edit leases are not transactions** — `edit_begin_lease` creates a TTL-bound, scene-scoped coordination lease. The holder supplies `lease_id` on writes; other bridge writes to that scene are rejected while it is active, and play start is gated until the lease expires, is committed, or is released. Mutations remain visible immediately. `edit_commit_lease` and `edit_release_lease` only end the lease; neither commits an atomic batch nor rolls changes back. `TransactionsSupported` remains `false`.
- **Idempotent retries** — live mutations accept an optional `idempotency_key`; v7 caches a matching method/request result for ten minutes (up to 512 entries) and replays it without repeating the mutation or revision increment. Reusing a key for different input returns `IDEMPOTENCY_KEY_REUSED`. Create, duplicate, and script-attach operations are the main recommended uses.
- **Compile → diagnose → run loop** — patch source, call `code_compile`, inspect `code_get_diagnostics`, start play, query session-scoped logs/runtime state, optionally capture the viewport, then stop. Compile polling tolerates the bridge assembly and token being replaced during reload without blindly repeating the compile mutation.
- **Flax 1.12 headless limitation** — headless editors support bridge status, compilation, diagnostics, and logs, but reject play start. Flax 1.12 cannot reliably complete play cleanup without its game window; runtime inspection and viewport capture (game or editor) therefore require a headed editor. Game captures additionally require play mode; editor captures use `EditWin.Viewport.Task` and work outside play mode.
- **Temporary capture resources** — viewport PNGs stay below `Cache/MCP/captures`, are size/age bounded, and can be read with MCP `resources/read` using the returned `flax://capture/<id>` URI. Physical paths are not returned.
- **MCP resources** — `resources/list` exposes bounded JSON for project info/summary/settings, Editor status, loaded scenes, current diagnostics, recent logs, build status, and redacted audit entries, plus temporary captures. `resources/templates/list` advertises scene/actor templates only with bridge v5+ and asset templates only with v8+. Resource JSON is redacted and capped at 256 KiB; list cursors are opaque and expire after ten minutes.
- **Resource subscriptions** — `resources/subscribe` supports Editor status, a live scene tree, latest diagnostics, and recent logs (maximum 128). Notifications are debounced by about 350 ms after successful MCP mutations; Editor status also observes the bridge heartbeat at a bounded interval. Flax 1.12 has no verified general Editor event feed, so manual Editor/third-party changes are not promised; clients must refresh after changes made outside MCP. A successful viewport capture emits `notifications/resources/list_changed`.
- **Script mutations are hardened** — writes stay under `Source/`, reject symlink/junction escapes, use same-directory atomic replacement, support dry-run and expected hashes, and record redacted audit metadata.
- **Scene writes are legacy offline operations** — `create_actor` and `modify_actor` require `allow_offline_write:true`, refuse to run while the bridge is connected, directly edit serialized `.scene` files, and create a `.bak`; they do not use Flax Editor Undo/Redo or transactions.
- Run `npm test` to build and execute contract, resource, status, read-tool, script-safety, bridge-installer, file-RPC, live-editor, compile/play, and observability suites.
- **Editor integration fixtures** — `npm test` also creates isolated, disposable fixture projects and simulates the file-RPC peer for DTO and fault-injection coverage. This is not a claim that Flax GUI was run. The Windows/Flax 1.12 baseline and the manual headed-Editor procedure are recorded in [`docs/TESTING.md`](docs/TESTING.md) and [`test/compatibility-matrix.json`](test/compatibility-matrix.json).
