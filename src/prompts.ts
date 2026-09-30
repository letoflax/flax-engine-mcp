import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, McpError, type GetPromptResult, type ListPromptsResult, type Prompt } from '@modelcontextprotocol/sdk/types.js';

type PromptValue = string | boolean | number | undefined;
type PromptArguments = Record<string, PromptValue>;

interface ArgumentDefinition {
  name: string;
  description: string;
  required?: boolean;
  kind: 'text' | 'boolean' | 'integer';
  min?: number;
  max?: number;
}

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: ArgumentDefinition[];
  render: (args: PromptArguments) => string;
}

const sharedSafetyInstructions = `
Before proposing any action, inspect available read-only context: call resources/list and read only the safe, relevant resources it returns. If a needed resource is not available, use the corresponding read-only tool instead; do not invent state. Read get_server_capabilities and honor the active permission profile and the features it reports: a tool that needs a newer Editor Bridge fails with UNSUPPORTED_FLAX_VERSION, so check the matching flag (for example actorPropertyWrite, uiControls, runtimeScriptDrive, settingsWrite, sceneCreate, assetCreate, prefab.overrides, buildCook.available) before planning around it, and use search_tools when unsure which tool covers a step.

Treat this prompt as guidance only: it does not grant permission and it performs no tool call or persistence itself. Prefer dry_run:true for every supported mutation. Explain the exact intended change and ask for explicit confirmation immediately before any write, scene mutation, save, build, cook, deletion, or other destructive action. Keep edits small and use expected hashes, revisions, leases, and idempotency keys where the selected tool supports them.

Know which writes can be undone. Live scene edits go through the Editor and can usually be reverted with edit_undo (a tool's description says when a step is not undoable); they only mark the scene edited and stay unsaved until an explicitly confirmed scene_save or project_save_all. Durable writes have no undo: settings_* saves, scene_create, asset_create, content_create_folder, asset_move/asset_rename/asset_duplicate, prefab_apply_overrides (edit_undo cannot revert its prefab save), Visject graph saves, and build_cook output. For those, run the dry_run preview first, show it, and only after the user confirms repeat the call once, with confirm:true where the tool asks for it. Edit leases are visible-immediately coordination locks, not transactions: releasing one never rolls anything back.

After a source change, follow compile -> code_get_diagnostics -> bounded retry. Do not retry a failed compile or mutation indefinitely. Long calls (compile, project generation, play start and stop, import, build, capture) send notifications/progress when the client passes _meta.progressToken; prefer that to polling in a tight loop.

For play checks, use a bounded run (play_run_for or test_run_scenario), inspect session-scoped logs/runtime state, optionally capture the viewport, and always stop play when finished. Flax 1.12 binds no key or mouse injection, so input_key_press and input_mouse_click only validate and then report UNSUPPORTED_FLAX_VERSION. To act on the game during play use runtime_set_script_value and runtime_invoke_script_method (or the steps of test_run_scenario): they reach only members and methods declared in game code, need play mode, record no undo, and are discarded when play stops.

Report unsupported operations rather than simulating them: transactions and atomic batches are unavailable; arbitrary reflected actor properties and arbitrary serialized script properties are not exposed (actor_set_property and ui_control_set_property reach only members the Editor property grid shows, script_instance_set_value only whitelisted public script fields, and actor_update owns name, active, transform, and layer); prefab overrides are a synthesized diff limited to name, active, local transform, and layer, with whole-instance apply and revert-all only; terrain_paint and animation_set_graph_parameter are validated stubs; importer operations need a configured import root and the full permission profile. Unsaved editor changes remain dirty until an explicitly confirmed scene_save or project_save_all; rollback means the verified tool-specific undo/restore path, not an implied transaction.`.trim();

function optionalValue(args: PromptArguments, name: string, fallback: string): string {
  const value = args[name];
  return value === undefined ? fallback : String(value);
}

const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'create_gameplay_feature',
    title: 'Create gameplay feature',
    description: 'Guides a safe, compile-validated gameplay feature implementation and optional smoke test.',
    arguments: [
      { name: 'feature', description: 'Required concise description of the gameplay feature.', required: true, kind: 'text' },
      { name: 'target_scene', description: 'Optional project-relative target scene or actor context.', kind: 'text' },
      { name: 'max_compile_attempts', description: 'Optional bounded compile/fix attempts (1-5, default 3).', kind: 'integer', min: 1, max: 5 },
      { name: 'save_at_end', description: 'Optional boolean; request confirmation for an explicit save only when true.', kind: 'boolean' },
    ],
    render: args => `Implement this gameplay feature: ${args.feature}\nTarget scene/context: ${optionalValue(args, 'target_scene', 'not specified')}\nMaximum compile/fix attempts: ${optionalValue(args, 'max_compile_attempts', '3')}\nSave at end requested: ${optionalValue(args, 'save_at_end', 'false')}\n\nPlan:\n1. Inspect first: get_project_summary, get_script_classes, find_references, and read_script for conventions and the scripts involved; scene_get_tree, actor_find, and actor_get for the target scene or actor. Propose the smallest code, scene, and settings changes and get them approved.\n2. Code: write_script or apply_script_patch with dry_run:true and expected_hash, then code_compile and code_get_diagnostics after each accepted source change, within the compile attempt bound.\n3. Wiring, only after identifying the target actor: script_attach (dry_run first) for the compiled script; actor_get_properties to see which editor-visible members exist, then actor_set_property (dry_run first) for component settings such as colliders, rigid bodies, lights, cameras, and audio sources; script_instance_set_value for public fields of the feature's own script; ui_control_create (under a UICanvas made with actor_create) with ui_control_get_properties and ui_control_set_property for UI; material_get_parameters, material_set_parameters, and material_assign_to_actor for materials; particle_get_parameters and particle_set_parameter for particle effects. Use a lease and the expected scene revision for scene edits where the tool supports them.\n4. Input bindings and other project settings the feature needs: read the current bindings with get_input_actions, then settings_set_input_action or settings_set_input_axis (dry_run first). Settings writes save immediately, have no undo, and are refused in play mode or while the settings window is open, so confirm the exact before/after first.\n5. Verify with one bounded run. Prefer test_run_scenario: its steps drive the game during play (set_script_value and invoke_script_method at stated times, with an expectation on a returned value or on whether the method threw) and its asserts check logs, errors, and the viewport. That needs a public method or editor-visible member declared in game code as a test hook; if the feature has none, propose adding one. Otherwise use play_run_for. Inspect session-scoped logs, optionally capture the viewport, and confirm play is stopped.\n6. Summarize changes, diagnostics, the scenario result, and rollback options: edit_undo covers live scene edits, while settings writes and created assets cannot be undone. If save_at_end is true, request confirmation again before saving.\n\n${sharedSafetyInstructions}`,
  },
  {
    name: 'fix_compile_errors',
    title: 'Fix compile errors',
    description: 'Guides minimal, diagnostic-driven compile fixes with a strict retry bound.',
    arguments: [
      { name: 'max_attempts', description: 'Optional compile/fix attempts (1-5, default 3).', kind: 'integer', min: 1, max: 5 },
      { name: 'save_at_end', description: 'Optional boolean; request confirmation for an explicit save only when true.', kind: 'boolean' },
    ],
    render: args => `Fix the current compilation failures with at most ${optionalValue(args, 'max_attempts', '3')} edit/compile attempts. Save at end requested: ${optionalValue(args, 'save_at_end', 'false')}.\n\nPlan:\n1. Read current diagnostics with code_get_diagnostics (get_compiler_errors scans the log files when no Editor is connected) and each referenced source file with read_script before editing.\n2. Group only directly related errors, propose the smallest patch, preview it (apply_script_patch or write_script with dry_run:true and expected_hash), and ask for confirmation.\n3. Compile once with code_compile after each accepted patch, then re-read the diagnostics of that compilation with code_get_diagnostics.\n4. Stop when the errors are resolved, the retry bound is reached, or diagnostics prove a problem is outside the supported surface. If the failing file is the installed Editor Bridge (FlaxMcpBridge.cs) rather than game code, do not patch it by hand: compare get_editor_bridge_installation and offer install_editor_bridge as a previewed reinstall. If the project files look stale, code_generate_project can regenerate them; ask first.\n\nDo not hide errors by deleting unrelated code. If save_at_end is true, request confirmation before an explicit save.\n\n${sharedSafetyInstructions}`,
  },
  {
    name: 'create_scene_from_description',
    title: 'Create scene from description',
    description: 'Guides a reviewed scene plan, asset resolution, and bounded live-editor validation.',
    arguments: [
      { name: 'description', description: 'Required description of the desired scene.', required: true, kind: 'text' },
      { name: 'scene_name', description: 'Optional proposed scene name.', kind: 'text' },
      { name: 'dry_run', description: 'Optional boolean; default true and keep mutations in preview until confirmed.', kind: 'boolean' },
      { name: 'save_at_end', description: 'Optional boolean; request confirmation for an explicit save only when true.', kind: 'boolean' },
    ],
    render: args => `Create a scene from this description: ${args.description}\nProposed scene name: ${optionalValue(args, 'scene_name', 'not specified')}\nDry run: ${optionalValue(args, 'dry_run', 'true')}\nSave at end requested: ${optionalValue(args, 'save_at_end', 'false')}\n\nPlan:\n1. Inspect first: get_project_summary and get_scene_actors for conventions, scene_list_loaded for what is loaded, and asset_search, asset_get, and asset_dependencies to resolve candidate assets (models, materials, prefabs, audio). Produce an actor hierarchy and asset plan for review before any write.\n2. Scene file: to start a new scene use scene_create at a new Content/.../*.scene path (it never overwrites, seeds the Editor default template of Sun, Sky, SkyLight, Floor, and Camera, and does not open the scene), then scene_open and poll scene_list_loaded. content_create_folder makes a missing folder. The file is written immediately with no undo, so confirm the path first. To extend a scene that is already loaded, skip this step.\n3. New content the scene needs: asset_create for empty Materials, ParticleSystems, AnimationGraphs, and similar assets (never overwrites, no undo), material_create_instance for material variants, and prefab_instantiate for existing prefabs (a loaded parent actor is required).\n4. Build the hierarchy with a lease and the expected scene revision: actor_create, actor_update (name, active, transform, layer), actor_reparent, and script_attach; actor_get_properties then actor_set_property for component settings; ui_control_create (create a UICanvas first) with ui_control_set_property for UI; material_assign_to_actor and particle_set_parameter for looks and effects; prefab_get_overrides on prefab instances you changed. Preview each create/update with dry_run:true. With no Editor connected, create_actor and modify_actor edit the .scene file directly (backed up first); prefer the live tools whenever an Editor is connected.\n5. Validate the resulting tree with scene_get_tree and actor_get, and keep the edits visible but unsaved for review. If Dry run is true, stop after the previews and wait for the user to approve real writes. Transactions/atomic batches are unavailable, so do not claim begin/commit/rollback semantics; use edit_undo only for edits the tool says are undoable. scene_close unloads a scene you no longer need; it refuses an edited scene unless allow_dirty is set, and that discards the edits, so ask first.\n6. Run a bounded play check only after confirmation (test_run_scenario or play_run_for), inspect logs, capture if useful, and stop play. If save_at_end is true, request confirmation before scene_save or project_save_all.\n\n${sharedSafetyInstructions}`,
  },
  {
    name: 'debug_runtime_exception',
    title: 'Debug runtime exception',
    description: 'Guides bounded reproduction, session-scoped log analysis, and a reviewed fix proposal.',
    arguments: [
      { name: 'symptom', description: 'Required exception message, reproduction clue, or observed symptom.', required: true, kind: 'text' },
      { name: 'run_seconds', description: 'Optional bounded reproduction duration in seconds (1-120, default 15).', kind: 'integer', min: 1, max: 120 },
      { name: 'apply_fix', description: 'Optional boolean; default false means propose but do not write a patch.', kind: 'boolean' },
    ],
    render: args => `Debug this runtime exception or symptom: ${args.symptom}\nMaximum reproduction duration: ${optionalValue(args, 'run_seconds', '15')} seconds\nApply a proposed fix after confirmation: ${optionalValue(args, 'apply_fix', 'false')}\n\nPlan:\n1. Inspect first: code_get_diagnostics, log_get_recent or log_search for the symptom, and play_get_status. Do not start play until you have a reproduction plan and the user confirms.\n2. Reproduce once within the duration bound with play_run_for or test_run_scenario. If the symptom needs gameplay input, remember Flax 1.12 cannot inject keys or the mouse: drive it through game code with runtime_set_script_value and runtime_invoke_script_method, or as steps of test_run_scenario at stated times (an expectation on the returned value or on whether the method threw records the outcome, and the same scenario doubles as the regression check afterwards). Both reach only members and methods declared in game code, and their effects vanish when play stops.\n3. Collect session-scoped evidence: log_get_runtime_errors, log_search, runtime_inspect_actor, actor_get_properties (it works in play mode), script_instance_get with include_values, and optionally viewport_capture or perf_get_snapshot. To study one moment, play_pause then play_step_frame or play_set_time_scale. Always stop play (play_stop) when finished.\n4. Trace only evidence-backed source references with read_script and find_references. Present a minimal fix proposal; if apply_fix is false, do not write. If true, still preview and obtain confirmation before the patch (apply_script_patch with dry_run:true and expected_hash), compile, re-check diagnostics, and perform at most one bounded verification run, ideally the scenario that reproduced the problem.\n\n${sharedSafetyInstructions}`,
  },
  {
    name: 'prepare_release_build',
    title: 'Prepare release build',
    description: 'Guides a release-readiness review: settings, diagnostics, a smoke test, and a confirmed, bounded build/cook when the connected Editor Bridge supports it.',
    arguments: [
      { name: 'target', description: 'Optional intended platform/configuration label.', kind: 'text' },
      { name: 'max_compile_attempts', description: 'Optional compile/fix attempts (1-5, default 2).', kind: 'integer', min: 1, max: 5 },
      { name: 'save_at_end', description: 'Optional boolean; request confirmation for an explicit save only when true.', kind: 'boolean' },
    ],
    render: args => `Prepare release readiness for target: ${optionalValue(args, 'target', 'not specified')}\nMaximum compile/fix attempts: ${optionalValue(args, 'max_compile_attempts', '2')}\nSave at end requested: ${optionalValue(args, 'save_at_end', 'false')}\n\nPlan:\n1. Inspect: get_project_info, get_game_settings, read_settings, get_input_actions, validate_project, editor_get_status, and code_get_diagnostics. Verify the first-scene and settings assumptions; if the first scene is wrong, settings_set_first_scene can fix it (dry_run first; it saves immediately and has no undo, so confirm the exact change).\n2. Compile with code_compile within the stated retry bound and re-read code_get_diagnostics. Summarize warnings, validation findings, and unsaved state (scene_list_loaded shows what is loaded; edits stay unsaved until a confirmed scene_save or project_save_all).\n3. Review prefab instances that were changed with prefab_get_instances and prefab_get_overrides. Whether to push them into the prefab is the user's decision: prefab_apply_overrides applies the whole instance and its prefab save cannot be undone.\n4. Smoke test with one bounded test_run_scenario (its steps can drive the game through script members and methods declared in game code, since Flax 1.12 has no key or mouse injection), and confirm play is stopped.\n5. Build only when get_server_capabilities reports buildCook.available: build_list_targets for the reviewed targets, build_validate (preflight only; toolchain availability stays unknown until a real start), then build_cook with dry_run:true. Start the real build only after explicit confirmation, into an empty project-relative Builds/ directory. Poll build_get_status (or operation_get_status), read build_get_result once it is complete (BUILD_NOT_COMPLETE while running), and use build_cancel only if the user asks; cancellation is confirmed by later status polling. Arbitrary command lines, presets, package settings, and output outside Builds/ are not exposed: report that gap and the next manual Editor step instead of claiming it happened. If buildCook.available is false, report that and stop at readiness.\n\nIf save_at_end is true, request confirmation before saving.\n\n${sharedSafetyInstructions}`,
  },
];

function promptMetadata(definition: PromptDefinition): Prompt {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    arguments: definition.arguments.map(({ name, description, required }) => ({ name, description, required: required === true })),
  };
}

const PROJECT_PROMPTS_DIR = 'mcp-prompts';
const PROJECT_PROMPT_PATTERN = /^[A-Za-z0-9_-]{1,64}\.md$/;
const MAX_PROJECT_PROMPTS = 20;
const MAX_PROJECT_PROMPT_BYTES = 32 * 1024;

const BUILTIN_PROMPT_NAMES = new Set(PROMPT_DEFINITIONS.map(definition => definition.name));

interface ProjectPromptEntry {
  name: string;
  description: string;
  content: string;
}

function isInsideDir(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function extractProjectDescription(content: string, stem: string): string {
  for (const line of content.split('\n')) {
    const match = /^#\s+(.*)$/.exec(line.trimEnd());
    if (!match) continue;
    const heading = match[1]!.trim();
    if (heading) return heading.length > 256 ? `${heading.slice(0, 256)}…` : heading;
  }
  return stem;
}

function parseZeroArguments(promptName: string, rawArgs: unknown): void {
  if (rawArgs === undefined) rawArgs = {};
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new McpError(ErrorCode.InvalidParams, 'Prompt arguments must be an object of string values.');
  }
  for (const [name] of Object.entries(rawArgs as Record<string, unknown>)) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown argument "${name}" for prompt "${promptName}".`);
  }
}

async function discoverProjectPrompts(projectPath?: string): Promise<{ entries: ProjectPromptEntry[]; skipped: number }> {
  const empty = { entries: [], skipped: 0 };
  if (!projectPath) return empty;
  const dir = path.join(path.resolve(projectPath), PROJECT_PROMPTS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return empty;
    return empty;
  }
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return { entries: [], skipped: names.length };
  }
  names.sort();
  const entries: ProjectPromptEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of names) {
    if (!PROJECT_PROMPT_PATTERN.test(entry) || entry.includes('..')) {
      skipped += 1;
      continue;
    }
    if (entries.length >= MAX_PROJECT_PROMPTS) {
      skipped += 1;
      continue;
    }
    const stem = entry.slice(0, -'.md'.length);
    if (seen.has(stem) || BUILTIN_PROMPT_NAMES.has(stem)) {
      skipped += 1;
      continue;
    }
    const lexical = path.join(realDir, entry);
    let realFile: string;
    try {
      realFile = await fs.realpath(lexical);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isInsideDir(realDir, realFile)) {
      skipped += 1;
      continue;
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(realFile);
    } catch {
      skipped += 1;
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_PROJECT_PROMPT_BYTES) {
      skipped += 1;
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(realFile, 'utf-8');
    } catch {
      skipped += 1;
      continue;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_PROJECT_PROMPT_BYTES) {
      skipped += 1;
      continue;
    }
    seen.add(stem);
    entries.push({ name: stem, description: extractProjectDescription(content, stem), content });
  }
  return { entries, skipped };
}

function parseArguments(definition: PromptDefinition, rawArgs: unknown): PromptArguments {
  if (rawArgs === undefined) rawArgs = {};
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new McpError(ErrorCode.InvalidParams, 'Prompt arguments must be an object of string values.');
  }
  const entries = Object.entries(rawArgs as Record<string, unknown>);
  const allowed = new Map(definition.arguments.map(argument => [argument.name, argument]));
  for (const [name, value] of entries) {
    if (!allowed.has(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown argument "${name}" for prompt "${definition.name}".`);
    if (typeof value !== 'string') throw new McpError(ErrorCode.InvalidParams, `Argument "${name}" must be a string.`);
  }

  const parsed: PromptArguments = {};
  for (const argument of definition.arguments) {
    const value = (rawArgs as Record<string, string>)[argument.name];
    if (value === undefined) {
      if (argument.required) throw new McpError(ErrorCode.InvalidParams, `Missing required argument "${argument.name}" for prompt "${definition.name}".`);
      continue;
    }
    if (argument.kind === 'text') {
      const text = value.trim();
      if (!text) throw new McpError(ErrorCode.InvalidParams, `Argument "${argument.name}" must not be empty.`);
      parsed[argument.name] = text;
    } else if (argument.kind === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new McpError(ErrorCode.InvalidParams, `Argument "${argument.name}" must be exactly "true" or "false".`);
      parsed[argument.name] = value === 'true';
    } else {
      if (!/^(0|[1-9]\d*)$/.test(value)) throw new McpError(ErrorCode.InvalidParams, `Argument "${argument.name}" must be a base-10 integer.`);
      const integer = Number(value);
      if (!Number.isSafeInteger(integer) || (argument.min !== undefined && integer < argument.min) || (argument.max !== undefined && integer > argument.max)) {
        throw new McpError(ErrorCode.InvalidParams, `Argument "${argument.name}" must be an integer from ${argument.min} to ${argument.max}.`);
      }
      parsed[argument.name] = integer;
    }
  }
  return parsed;
}

export async function listFlaxPrompts(projectPath?: string): Promise<ListPromptsResult> {
  const prompts: Prompt[] = PROMPT_DEFINITIONS.map(promptMetadata);
  if (!projectPath) return { prompts };
  const discovered = await discoverProjectPrompts(projectPath);
  for (const entry of discovered.entries) {
    prompts.push({ name: entry.name, title: entry.name, description: entry.description, arguments: [] });
  }
  if (discovered.skipped > 0) {
    return { prompts, _meta: { projectPromptsSkipped: discovered.skipped } } as ListPromptsResult;
  }
  return { prompts };
}

export async function getFlaxPrompt(name: string, rawArgs?: unknown, projectPath?: string): Promise<GetPromptResult> {
  const definition = PROMPT_DEFINITIONS.find(candidate => candidate.name === name);
  if (definition) {
    const args = parseArguments(definition, rawArgs);
    return {
      description: definition.description,
      messages: [{ role: 'user', content: { type: 'text', text: definition.render(args) } }],
    };
  }
  if (projectPath) {
    const discovered = await discoverProjectPrompts(projectPath);
    const entry = discovered.entries.find(candidate => candidate.name === name);
    if (entry) {
      parseZeroArguments(entry.name, rawArgs);
      return {
        description: entry.description,
        messages: [{ role: 'user', content: { type: 'text', text: entry.content } }],
      };
    }
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
}
