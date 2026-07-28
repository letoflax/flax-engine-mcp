# Flax Engine MCP

An MCP (Model Context Protocol) server that lets Claude interact with [Flax Engine](https://flaxengine.com/) game projects. It exposes 29 tools for reading code, editing scenes, generating scripts, validating your project, and more.

## Requirements

- Node.js 18+
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

## Tools

### Project Info
| Tool | What it does |
|------|-------------|
| `get_server_capabilities` | Server/project identity, feature flags, mode, and Editor Bridge availability |
| `editor_get_status` | Validates the live bridge heartbeat, project identity, process, and freshness |
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

### Scene
| Tool | What it does |
|------|-------------|
| `get_scene_actors` | Actor hierarchy from a `.scene` file with TypeNames and attached scripts |
| `create_actor` | Add a new actor to a scene (auto-backs up the scene before writing) |
| `modify_actor` | Change an actor's name, position, or active state |

### Assets
| Tool | What it does |
|------|-------------|
| `get_asset_info` | Inspect JSON assets or the type, GUID, and version header of binary `.flax` assets |
| `reimport_asset` | Inspect reimport intent and optionally launch Flax Editor for manual reimport |
| `list_assets` | List Content/ assets by type (scene, material, settings, other) with GUIDs |

### Settings & Config
| Tool | What it does |
|------|-------------|
| `read_settings` | Read any settings file by partial name — `"Input"`, `"Physics"`, `"Graphics"`, etc. |
| `get_input_actions` | All input action and axis mappings from `Input Settings.json` |
| `get_physics_settings` | Gravity, bounce, and layer masks from `Physics Settings.json` |

### Project Health
| Tool | What it does |
|------|-------------|
| `get_compiler_errors` | Scan log files for C# errors and warnings (`error CS*`, `Build FAILED`) |
| `validate_project` | Health check — script syntax, missing settings, broken scene references |

### Documentation
| Tool | What it does |
|------|-------------|
| `list_docs` | List all `.md` files in the project |
| `read_doc` | Read a doc file by name or partial name |
| `get_latest_log` | Tail the latest Flax Engine log with optional text filter |

## Notes

- **Foundation contracts** — every tool validates arguments, advertises an output schema and annotations, and returns structured results with operation metadata.
- **Editor status** — `get_server_capabilities` and `editor_get_status` validate a matching live heartbeat at `Cache/MCP/bridge.json`; otherwise the server reports offline mode.
- **Script mutations are hardened** — writes stay under `Source/`, reject symlink/junction escapes, use same-directory atomic replacement, support dry-run and expected hashes, and record redacted audit metadata.
- **Scene writes are legacy offline operations** — `create_actor` and `modify_actor` directly edit serialized `.scene` files and create a `.bak`; they do not use Flax Editor Undo/Redo or transactions.
- Run `npm test` to build and execute the contract, status, read-tool, and script-safety suites.
