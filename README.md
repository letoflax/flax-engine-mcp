# Flax Engine MCP

An MCP (Model Context Protocol) server that lets MCP clients interact with [Flax Engine](https://flaxengine.com/) game projects. It exposes 86 tools for reading and patching code, editing live scenes, searching/importing assets, working with safe live-prefab primitives, compiling, running bounded play-mode checks, inspecting logs, and local diagnostics.

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
| `get_editor_bridge_installation` | Compare bundled and installed Editor Bridge versions and hashes |
| `install_editor_bridge` | Preview or safely install the bridge into the editor target's detected game module; accepts `module` when targets are ambiguous |
| `get_project_info` | Project config from `.flaxproj` — name, version, default scene, directory layout |
| `get_game_settings` | Contents of `GameSettings.json` — product name, scene ID, all sub-settings refs |
| `get_project_summary` | Full project overview in one call — scripts, scenes, assets, settings, docs |

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
| `play_run_for` | Run for seconds, frames, or until a session-correlated log match, then request stop |
| `runtime_inspect_actor` | Read a bounded, allowlisted actor snapshot during play mode |
| `viewport_capture` | Capture the game viewport and return a readable temporary `flax://capture/<id>` PNG resource |

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
| `project_save_all` | Ask Flax Editor to save all edited project content |
| `actor_get` / `actor_find` | Read or search live actors; v7 snapshots include bounded hierarchy, local/world-transform, tags, and layer metadata |
| `actor_create` / `actor_update` | Create or patch allowlisted actor fields with dry-run support |
| `actor_delete` / `actor_duplicate` | Delete or duplicate an actor with editor undo support |
| `actor_reparent` | Reparent an actor while preserving its world transform by default |
| `script_attach` / `script_detach` | Attach or detach a script with editor undo support |
| `script_instance_get` / `script_instance_update` | Read a script instance or patch its enabled state (arbitrary serialized script properties are deferred) |
| `edit_undo` / `edit_redo` | Execute the Flax Editor undo/redo stack |
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

### Prefabs
| Tool | What it does |
|------|-------------|
| `prefab_create_from_actor` | Create a new `Content/.../*.prefab` from a loaded actor hierarchy; never overwrites and defaults `auto_link` to false (bridge v12) |
| `prefab_instantiate` | Instantiate a prefab under a required loaded parent with bounded world transform/name, dry-run, revision, lease, and idempotency guards (bridge v12) |
| `prefab_get_instances` | List instance roots in currently loaded scenes with opaque cursor pagination (bridge v12) |
| `prefab_get_overrides` | Stable unsupported capability: Flax 1.12 has no verified public override-diff API (bridge v12) |
| `prefab_revert_overrides` | Stable unsupported capability; dry-run defaults to true because no verified public revert API exists (bridge v12) |
| `prefab_apply_overrides` / `prefab_break_link` | Stable unsupported capabilities until an undoable, previewable, confirmation-safe Editor path is verified (bridge v12) |

### Settings & Config
| Tool | What it does |
|------|-------------|
| `read_settings` | Read any settings file by partial name — `"Input"`, `"Physics"`, `"Graphics"`, etc. |
| `get_input_actions` | All input action and axis mappings from `Input Settings.json` |
| `get_physics_settings` | Gravity, bounce, and layer masks from `Physics Settings.json` |

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

## Notes

- **Asset registry and graph reads** -- `asset_search`, `asset_get`, `asset_dependencies`, and `asset_find_references` require bridge v8. They use only public Flax 1.12 `Content` registry metadata and `Asset.GetReferences`; result pages are at most 200 entries, dependency depth is at most 16, registry scans are capped at 10,000 assets, and opaque cursors expire after ten minutes or invalidate when filters or registry metadata change. Paths/GUIDs are project-scoped. The bridge does not expose importer settings, file size/modified time/import status, actor/property reference locations, or inferred prefab overrides because public APIs do not verify them.
- **Asset compatibility aliases** -- `list_assets` delegates safe all/scene requests to `asset_search` with a v8 bridge; `get_asset_info` delegates `Content/...` paths to `asset_get`. Other legacy filters, bare filenames, offline projects, and bridges older than v8 keep their original filesystem-backed behavior.
- **Safe asset imports** -- `asset_import` and `asset_reimport` require bridge v9, the `full` permission profile (or an explicit tool allow override), and at least one `--asset-import-root`. They invoke only Flax's verified `Editor.Import`, `ContentImporting.Reimport`, and `BinaryAsset.ImportPath` APIs, never copy source files or launch editor processes. Importer settings/type conversion are intentionally not exposed. New imports finish synchronously in Flax 1.12; reimports use Flax's queue and must be polled by operation ID (ten-minute retention, at most 512 records). Imports are rejected while Flax is playing, compiling/reloading, or already importing. The direct APIs are UI-free; headless availability still depends on the installed Flax Editor importer backend and should be verified in the target CI/editor setup.

- **Safe prefab workflows** -- `prefab_create_from_actor`, `prefab_instantiate`, and `prefab_get_instances` require bridge v12. They use only the public Flax 1.12 `PrefabManager.CreatePrefab`, `PrefabManager.SpawnPrefab`, `Actor.IsPrefabRoot`, and `SceneObject.PrefabID` APIs. Creation accepts only a new project-relative `Content/.../*.prefab` path and never overwrites; it defaults `auto_link:false`. Instantiation requires a loaded `parent_id`, so the bridge can check the target scene revision/lease before it writes; top-level placement is deliberately deferred because Flax's unparented spawn selects its first loaded scene. Instance results are limited to currently loaded scenes, capped at 10,000 scanned actors and 200 entries/page; cursors expire after ten minutes. The bridge does not inspect or edit prefab files, use reflection, or claim unloaded-scene coverage.
- **Prefab limitations** -- Flax 1.12 has no verified public API for reading property-level overrides or reverting them. Although public engine APIs expose apply and break-link operations, bridge v12 does not expose them because it has not verified a reviewed undo, semantic preview, and confirmation path. `prefab_get_overrides`, `prefab_revert_overrides`, `prefab_apply_overrides`, and `prefab_break_link` therefore return the stable `UNSUPPORTED_FLAX_VERSION` capability error with an explicit reason instead of inferring state from serialization.

- **Foundation contracts** — every tool validates arguments, advertises an output schema and annotations, and returns structured results with operation metadata.
- **Validation rules** — `validate_project` keeps its legacy text summary, while `structuredContent.data.findings` exposes stable rule IDs, severities, project-relative locations, suggested fixes, auto-fix metadata, filters (`rule_ids`, `severities`), per-call suppressions, and cursor pagination (maximum 200 findings/page). Offline rules cover missing first scenes/assets, compiler log failures, duplicate input mappings, statically suspicious network attributes, optional required-camera checks, invalid Flax headers, settings, and scene JSON. Editor/cooker-only checks are explicitly reported as capability gaps rather than inferred.
- **Editor status** — `get_server_capabilities` and `editor_get_status` validate a matching live heartbeat at `Cache/MCP/bridge.json`; otherwise the server reports offline mode. Project identity includes an explicit project ID when present and an opaque SHA-256 path fingerprint, never the full project path.
- **Bridge installation** — preview with `install_editor_bridge` using `dry_run:true`; replacement requires the installed `expected_hash` or explicit `force:true`. Restart/open Flax Editor and wait for C# compilation after installation. Installer changes have a separate redacted local audit at `.flax-mcp/bridge-install-audit.jsonl`.
- **Live editor operations** — scene/actor/script operations require bridge v5 or newer. Compile, play, live-log, capture, and runtime-inspection tools require bridge v6. Revisions, edit leases, idempotency keys, local-transform/layer actor patches, and extended actor-find filters require bridge v7. Editor API mutations execute on Flax's main thread, and actor/script mutations integrate with the Undo stack. Transactions and atomic batches are not advertised.
- **Safe actor and script surface** — v7 actor snapshots expose parent ID, sibling order, child count, active-in-hierarchy, local and world transforms, tags (up to 64), layer index/name, static flags, and attached scripts. `actor_update` only patches name, active, one transform space per call (world or local), and the actor's layer; it never applies arbitrary reflected properties. `script_instance_update` is an optional-patch API with exactly one supported field, `enabled`; arbitrary serialized script fields/properties and asset-reference patching remain deferred because no verified public typed Editor setter is used.
- **Bridge v7 revisions** — status, loaded-scene/tree/actor/script reads, and scene actor/script mutation results include `ProjectRevision`; scene-scoped values also include `SceneRevision`. These counters live for the connected bridge Editor session and advance only for mutations made through this bridge. They do not detect unsaved manual Editor edits because no verified Flax 1.12 editor event is used for that purpose. Pass `expected_scene_revision` to a live write to reject a stale bridge-known scene with `SCENE_REVISION_CONFLICT` and the current revision in error details. For guarded `actor_create`, provide `parent_id` in the target scene so the bridge can identify the scene before spawning.
- **Edit leases are not transactions** — `edit_begin_lease` creates a TTL-bound, scene-scoped coordination lease. The holder supplies `lease_id` on writes; other bridge writes to that scene are rejected while it is active, and play start is gated until the lease expires, is committed, or is released. Mutations remain visible immediately. `edit_commit_lease` and `edit_release_lease` only end the lease; neither commits an atomic batch nor rolls changes back. `TransactionsSupported` remains `false`.
- **Idempotent retries** — live mutations accept an optional `idempotency_key`; v7 caches a matching method/request result for ten minutes (up to 512 entries) and replays it without repeating the mutation or revision increment. Reusing a key for different input returns `IDEMPOTENCY_KEY_REUSED`. Create, duplicate, and script-attach operations are the main recommended uses.
- **Compile → diagnose → run loop** — patch source, call `code_compile`, inspect `code_get_diagnostics`, start play, query session-scoped logs/runtime state, optionally capture the viewport, then stop. Compile polling tolerates the bridge assembly and token being replaced during reload without blindly repeating the compile mutation.
- **Flax 1.12 headless limitation** — headless editors support bridge status, compilation, diagnostics, and logs, but reject play start. Flax 1.12 cannot reliably complete play cleanup without its game window; runtime inspection and viewport capture therefore require a headed editor.
- **Temporary capture resources** — viewport PNGs stay below `Cache/MCP/captures`, are size/age bounded, and can be read with MCP `resources/read` using the returned `flax://capture/<id>` URI. Physical paths are not returned.
- **MCP resources** — `resources/list` exposes bounded JSON for project info/summary/settings, Editor status, loaded scenes, current diagnostics, recent logs, build status, and redacted audit entries, plus temporary captures. `resources/templates/list` advertises scene/actor templates only with bridge v5+ and asset templates only with v8+. Resource JSON is redacted and capped at 256 KiB; list cursors are opaque and expire after ten minutes.
- **Resource subscriptions** — `resources/subscribe` supports Editor status, a live scene tree, latest diagnostics, and recent logs (maximum 128). Notifications are debounced by about 350 ms after successful MCP mutations; Editor status also observes the bridge heartbeat at a bounded interval. Flax 1.12 has no verified general Editor event feed, so manual Editor/third-party changes are not promised; clients must refresh after changes made outside MCP. A successful viewport capture emits `notifications/resources/list_changed`.
- **Script mutations are hardened** — writes stay under `Source/`, reject symlink/junction escapes, use same-directory atomic replacement, support dry-run and expected hashes, and record redacted audit metadata.
- **Scene writes are legacy offline operations** — `create_actor` and `modify_actor` require `allow_offline_write:true`, refuse to run while the bridge is connected, directly edit serialized `.scene` files, and create a `.bak`; they do not use Flax Editor Undo/Redo or transactions.
- Run `npm test` to build and execute contract, resource, status, read-tool, script-safety, bridge-installer, file-RPC, live-editor, compile/play, and observability suites.
- **Editor integration fixtures** — `npm test` also creates isolated, disposable fixture projects and simulates the file-RPC peer for DTO and fault-injection coverage. This is not a claim that Flax GUI was run. The Windows/Flax 1.12 baseline and the manual headed-Editor procedure are recorded in [`docs/TESTING.md`](docs/TESTING.md) and [`test/compatibility-matrix.json`](test/compatibility-matrix.json).
