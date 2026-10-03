import { z } from 'zod';
import { ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { BRIDGE_V34, FlaxId, ScalarValue, callLive, splitScalarValue } from './liveToolSupport.js';
import { MemberPathSchema, memberNameOrPath } from './editorLive.js';
import { InstanceParam } from './gameRuntime.js';

// Bridge v33 play-mode script drive. Flax 1.12 binds no managed key or mouse
// injection, so gameplay is driven through the game's own scripts instead:
// write an editor-visible script member, or invoke a public method declared
// in game code. Engine-declared members and methods are never reachable.

const Identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RuntimeMemberName = z.string().min(1).max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, 'Expected Member or Type.Member.')
  .describe('Editor-visible field or property declared in game code (public or [ShowInEditor], not [HideInEditor]).');
const RuntimeScriptValue = ScalarValue.describe('Coerced strictly to the member type; see actor_set_property for the string shapes of vectors, quaternions, colors, enums, references (including "engine:<path>" engine assets), brushes, and fonts.');

/** The plain-member form: scenario steps extend this object (they do not take a nested path). */
export const RuntimeSetScriptValueMemberSchema = z.object({
  script_id: FlaxId,
  member: RuntimeMemberName,
  value: RuntimeScriptValue,
});

/**
 * The runtime_set_script_value tool input: a plain member, or (bridge v34) a
 * nested path with member omitted.
 */
export const RuntimeSetScriptValueSchema = z.object({
  script_id: FlaxId,
  member: RuntimeMemberName.optional().describe('Editor-visible field or property declared in game code (public or [ShowInEditor], not [HideInEditor]). Omit it when path is given.'),
  path: MemberPathSchema.optional(),
  value: RuntimeScriptValue,
  instance: InstanceParam,
}).superRefine((value, ctx) => memberNameOrPath('member', value, ctx));

export const RuntimeInvokeScriptMethodSchema = z.object({
  script_id: FlaxId,
  method: z.string().min(1).max(128).regex(Identifier, 'Method must be a C# identifier.')
    .describe('Public, non-generic instance method declared in game code. Overloads are selected by argument count only.'),
  args: z.array(ScalarValue).max(4).optional().default([])
    .describe('Up to four positional arguments, each coerced strictly to its parameter type (same string shapes as actor_set_property).'),
  instance: InstanceParam,
});

export const handleRuntimeSetScriptValue = (args: z.infer<typeof RuntimeSetScriptValueSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'runtime.set_script_value', {
    ScriptId: args.script_id,
    ...(args.path === undefined ? { Member: args.member } : { Path: args.path }),
    ...splitScalarValue(args.value),
  }, {
    playScoped: true,
    instance: args.instance,
    changes: [{ kind: 'runtime.script_value_set', id: args.script_id, member: args.path === undefined ? args.member : args.path.join('.') }],
    ...(args.path === undefined ? {} : { minimumBridgeVersion: BRIDGE_V34 }),
  });

export const handleRuntimeInvokeScriptMethod = (args: z.infer<typeof RuntimeInvokeScriptMethodSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'runtime.invoke_script_method', {
    ScriptId: args.script_id,
    Method: args.method,
    Args: args.args.map(splitScalarValue),
  }, {
    playScoped: true,
    instance: args.instance,
    // A method that threw may still have had side effects, so an invocation is always reported.
    changes: [{ kind: 'runtime.script_method_invoked', id: args.script_id, method: args.method }],
  });
