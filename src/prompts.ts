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
Before proposing any action, inspect available read-only context: call resources/list and read only the safe, relevant resources it returns. If a needed resource is not available, use the corresponding read-only tool instead; do not invent state. Read get_server_capabilities and honor the active permission profile.

Treat this prompt as guidance only: it does not grant permission and it performs no tool call or persistence itself. Prefer dry_run:true for every supported mutation. Explain the exact intended change and ask for explicit confirmation immediately before any write, scene mutation, save, build, cook, deletion, or other destructive action. Keep edits small and use expected hashes, revisions, leases, and idempotency keys where the selected tool supports them.

After a source change, follow compile -> code_get_diagnostics -> bounded retry. Do not retry a failed compile or mutation indefinitely. For play checks, use a bounded run, inspect session-scoped logs/runtime state, optionally capture the viewport, and always stop play when finished. Report unsupported operations rather than simulating them: transactions and atomic batches are unavailable; arbitrary actor/script properties, prefab overrides, and unverified importer/build operations may be unsupported. Unsaved editor changes remain dirty until an explicitly confirmed scene_save or project_save_all; rollback means the verified tool-specific undo/restore path, not an implied transaction.`.trim();

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
    render: args => `Implement this gameplay feature: ${args.feature}\nTarget scene/context: ${optionalValue(args, 'target_scene', 'not specified')}\nMaximum compile/fix attempts: ${optionalValue(args, 'max_compile_attempts', '3')}\nSave at end requested: ${optionalValue(args, 'save_at_end', 'false')}\n\nPlan: inspect conventions and the relevant scripts/scene first; propose the smallest code or scene changes; preview every supported write; compile and inspect diagnostics after each accepted source change; attach a compiled script only after identifying the target actor; run one bounded smoke test if play is supported; inspect logs and optionally capture the viewport; stop play; then summarize changes, diagnostics, and rollback options. If save_at_end is true, request confirmation again before saving.\n\n${sharedSafetyInstructions}`,
  },
  {
    name: 'fix_compile_errors',
    title: 'Fix compile errors',
    description: 'Guides minimal, diagnostic-driven compile fixes with a strict retry bound.',
    arguments: [
      { name: 'max_attempts', description: 'Optional compile/fix attempts (1-5, default 3).', kind: 'integer', min: 1, max: 5 },
      { name: 'save_at_end', description: 'Optional boolean; request confirmation for an explicit save only when true.', kind: 'boolean' },
    ],
    render: args => `Fix the current compilation failures with at most ${optionalValue(args, 'max_attempts', '3')} edit/compile attempts. Save at end requested: ${optionalValue(args, 'save_at_end', 'false')}.\n\nPlan: read current diagnostics and each referenced source file before editing. Group only directly related errors, propose the smallest patch, preview it, and ask for confirmation. Compile once after each accepted patch, then re-read diagnostics. Stop when the errors are resolved, the retry bound is reached, or diagnostics prove a problem is outside the supported surface. Do not hide errors by deleting unrelated code. If save_at_end is true, request confirmation before an explicit save.\n\n${sharedSafetyInstructions}`,
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
    render: args => `Create a scene from this description: ${args.description}\nProposed scene name: ${optionalValue(args, 'scene_name', 'not specified')}\nDry run: ${optionalValue(args, 'dry_run', 'true')}\nSave at end requested: ${optionalValue(args, 'save_at_end', 'false')}\n\nPlan: inspect project/scene conventions and resolve candidate assets before editing. Produce an actor hierarchy and asset plan for review. If live-editor scene editing is available, use a lease and expected scene revision, preview each create/update, validate the resulting tree, and keep mutations visible but unsaved for review. Transactions/atomic batches are unavailable, so do not claim begin/commit/rollback semantics; use editor undo only where verified. Run a bounded play check only after confirmation, inspect logs, capture if useful, and stop play. If save_at_end is true, request confirmation before scene_save or project_save_all.\n\n${sharedSafetyInstructions}`,
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
    render: args => `Debug this runtime exception or symptom: ${args.symptom}\nMaximum reproduction duration: ${optionalValue(args, 'run_seconds', '15')} seconds\nApply a proposed fix after confirmation: ${optionalValue(args, 'apply_fix', 'false')}\n\nPlan: inspect prior diagnostics and recent logs first. Check play status, start only if supported and confirmed, reproduce for the bounded duration, collect session-scoped runtime errors/logs and optional runtime inspection/capture, then stop play. Trace only evidence-backed source references. Present a minimal fix proposal; if apply_fix is false, do not write. If true, still preview and obtain confirmation before the patch, compile, re-check diagnostics, and perform at most one bounded verification run.\n\n${sharedSafetyInstructions}`,
  },
  {
    name: 'prepare_release_build',
    title: 'Prepare release build',
    description: 'Guides a release-readiness review while clearly separating unsupported build/cook operations.',
    arguments: [
      { name: 'target', description: 'Optional intended platform/configuration label.', kind: 'text' },
      { name: 'max_compile_attempts', description: 'Optional compile/fix attempts (1-5, default 2).', kind: 'integer', min: 1, max: 5 },
      { name: 'save_at_end', description: 'Optional boolean; request confirmation for an explicit save only when true.', kind: 'boolean' },
    ],
    render: args => `Prepare release readiness for target: ${optionalValue(args, 'target', 'not specified')}\nMaximum compile/fix attempts: ${optionalValue(args, 'max_compile_attempts', '2')}\nSave at end requested: ${optionalValue(args, 'save_at_end', 'false')}\n\nPlan: inspect project settings, current diagnostics, and editor status. Validate the project, verify first-scene/settings assumptions, and compile with the stated retry bound. Summarize warnings, validation findings, and any unsaved state. Do not claim to cook, package, or build artifacts unless a supported tool explicitly advertises that operation; report that gap and the next manual Editor step instead. If save_at_end is true, request confirmation before saving.\n\n${sharedSafetyInstructions}`,
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

export function listFlaxPrompts(): ListPromptsResult {
  return { prompts: PROMPT_DEFINITIONS.map(promptMetadata) };
}

export function getFlaxPrompt(name: string, rawArgs?: unknown): GetPromptResult {
  const definition = PROMPT_DEFINITIONS.find(candidate => candidate.name === name);
  if (!definition) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  const args = parseArguments(definition, rawArgs);
  return {
    description: definition.description,
    messages: [{ role: 'user', content: { type: 'text', text: definition.render(args) } }],
  };
}
