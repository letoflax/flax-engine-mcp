import { z } from 'zod';
import { ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { FlaxId, ScalarValue, callLive, splitScalarValue } from './liveToolSupport.js';

// Bridge v33 play-mode script drive. Flax 1.12 binds no managed key or mouse
// injection, so gameplay is driven through the game's own scripts instead:
// write an editor-visible script member, or invoke a public method declared
// in game code. Engine-declared members and methods are never reachable.

const Identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const RuntimeSetScriptValueSchema = z.object({
  script_id: FlaxId,
  member: z.string().min(1).max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, 'Expected Member or Type.Member.')
    .describe('Editor-visible field or property declared in game code (public or [ShowInEditor], not [HideInEditor]).'),
  value: ScalarValue.describe('Coerced strictly to the member type; see actor_set_property for the string shapes of vectors, colors, enums, and references.'),
});

export const RuntimeInvokeScriptMethodSchema = z.object({
  script_id: FlaxId,
  method: z.string().min(1).max(128).regex(Identifier, 'Method must be a C# identifier.')
    .describe('Public, non-generic instance method declared in game code. Overloads are selected by argument count only.'),
  args: z.array(ScalarValue).max(4).optional().default([])
    .describe('Up to four positional arguments, each coerced strictly to its parameter type.'),
});

export const handleRuntimeSetScriptValue = (args: z.infer<typeof RuntimeSetScriptValueSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'runtime.set_script_value', {
    ScriptId: args.script_id,
    Member: args.member,
    ...splitScalarValue(args.value),
  }, {
    playScoped: true,
    changes: [{ kind: 'runtime.script_value_set', id: args.script_id, member: args.member }],
  });

export const handleRuntimeInvokeScriptMethod = (args: z.infer<typeof RuntimeInvokeScriptMethodSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'runtime.invoke_script_method', {
    ScriptId: args.script_id,
    Method: args.method,
    Args: args.args.map(splitScalarValue),
  }, {
    playScoped: true,
    // A method that threw may still have had side effects, so an invocation is always reported.
    changes: [{ kind: 'runtime.script_method_invoked', id: args.script_id, method: args.method }],
  });
