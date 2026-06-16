# Flax Engine MCP

An MCP (Model Context Protocol) server that lets Claude interact with [Flax Engine](https://flaxengine.com/) game projects. It exposes 23 tools for reading code, editing scenes, generating scripts, validating your project, and more.

## Requirements

- Node.js 18+
- A Flax Engine project (must contain a `.flaxproj` file)

## Install & Build

```bash
git clone https://github.com/letofanius/flax-engine-mcp.git
cd flax-engine-mcp
npm install
npm run build
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
| `get_project_info` | Project config from `.flaxproj` — name, version, default scene, directory layout |
| `get_game_settings` | Contents of `GameSettings.json` — product name, scene ID, all sub-settings refs |
| `get_project_summary` | Full project overview in one call — scripts, scenes, assets, settings, docs |

### Scripts
| Tool | What it does |
|------|-------------|
| `list_scripts` | List all C# scripts with size and modification time |
| `read_script` | Read a script by filename or path |
| `write_script` | Create or overwrite a script (requires `overwrite:true` to replace existing) |

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

- **Scene writes are safe** — `create_actor` and `modify_actor` always save a `.bak` backup before modifying the scene file.
- **`write_script` is safe** — requires `overwrite:true` to replace an existing file.
- **Path traversal is blocked** — all file operations are restricted to the project directory.
