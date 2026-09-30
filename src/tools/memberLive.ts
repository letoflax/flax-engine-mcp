import { z } from 'zod';
import { ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { FlaxId, RevisionedLiveWrite, ScalarValue, callLive, splitScalarValue } from './liveToolSupport.js';

// Bridge v33 editor-visible member surface for actors, UI controls, and
// particle parameter overrides. "Editor-visible" means the member would show
// in the Flax property grid (public or [ShowInEditor], never [HideInEditor]).

const MemberList = {
  filter: z.string().min(1).max(128).optional()
    .describe('Case-insensitive substring filter on member names.'),
  include_unsupported: z.boolean().optional().default(false)
    .describe('Also list members whose value type cannot be projected or written (reported without a value).'),
  limit: z.number().int().min(1).max(256).optional().default(128),
};
const MemberName = z.string().min(1).max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, 'Expected Member or Type.Member.');
const MemberValue = ScalarValue.describe(
  'Coerced strictly to the member type: boolean, finite number, or string. Strings carry enum names ("A, B" for flags), '
  + 'vectors ("x,y[,z[,w]]"), colors ("#rrggbb[aa]" or "r,g,b[,a]"), rectangles ("x,y,width,height"), margins ("left,right,top,bottom"), '
  + 'and references: an asset GUID or Content/ path, an actor or script GUID, or "" to clear a reference.');

export const ActorGetPropertiesSchema = z.object({ actor_id: FlaxId, ...MemberList });
export const UiControlGetPropertiesSchema = z.object({
  actor_id: FlaxId.describe('GUID of the FlaxEngine.UIControl actor that owns the control.'),
  ...MemberList,
});
export const UiControlCreateSchema = z.object({
  parent_id: FlaxId.describe('A FlaxEngine.UICanvas actor, or a UIControl actor whose control is a ContainerControl.'),
  control_type: z.string().min(1).max(256).optional().default('FlaxEngine.GUI.Button')
    .describe('Fully qualified FlaxEngine.GUI.Control type, for example FlaxEngine.GUI.Label, Image, TextBox, Panel, VerticalPanel. Editor-only FlaxEditor.* controls are rejected.'),
  name: z.string().min(1).max(128).optional()
    .describe('Actor name. Defaults to the control type name.'),
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});
export const UiControlSetPropertySchema = z.object({
  actor_id: FlaxId.describe('GUID of the FlaxEngine.UIControl actor that owns the control.'),
  property: MemberName.describe('Control member, for example Text, Width, Height, Location, AnchorPreset, BackgroundColor, Visible.'),
  value: MemberValue,
  dry_run: z.boolean().optional().default(false)
    .describe('Preview the coercion and report would_change plus before/after without writing.'),
  ...RevisionedLiveWrite,
});
export const ParticleGetParametersSchema = z.object({ actor_id: FlaxId });
export const ParticleSetParameterSchema = z.object({
  actor_id: FlaxId.describe('GUID of a FlaxEngine.ParticleEffect actor.'),
  name: z.string().min(1).max(256),
  track: z.string().min(1).max(256).optional()
    .describe('Emitter track name. Required only when the parameter name exists on more than one track.'),
  value: MemberValue,
  dry_run: z.boolean().optional().default(false),
  ...RevisionedLiveWrite,
});

type Revisioned = { expected_scene_revision?: number; lease_id?: string; idempotency_key?: string };

function revision(args: Revisioned, dryRun: boolean): Record<string, unknown> {
  // Dry runs never consume idempotency keys (the bridge would otherwise file
  // the preview under the key a later real write wants to use).
  return {
    ExpectedSceneRevision: args.expected_scene_revision,
    LeaseId: args.lease_id,
    IdempotencyKey: dryRun ? undefined : args.idempotency_key,
  };
}

/** Reports a write only when it changed something: previews and writes of the current value report none. */
function writeChange(dryRun: boolean, change: Record<string, unknown>): (result: Record<string, unknown>) => unknown[] {
  return result => (dryRun || result.WouldChange === false ? [] : [change]);
}

function memberList(args: { actor_id: string; filter?: string; include_unsupported: boolean; limit: number }): Record<string, unknown> {
  return { ActorId: args.actor_id, Filter: args.filter, IncludeUnsupported: args.include_unsupported, Limit: args.limit };
}

export const handleActorGetProperties = (args: z.infer<typeof ActorGetPropertiesSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'actor.get_properties', memberList(args));

export const handleUiControlGetProperties = (args: z.infer<typeof UiControlGetPropertiesSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'ui.get_control_properties', memberList(args));

export const handleUiControlCreate = (args: z.infer<typeof UiControlCreateSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'ui.create_control', {
    ParentId: args.parent_id,
    ControlType: args.control_type,
    Name: args.name,
    DryRun: args.dry_run,
    ...revision(args, args.dry_run),
  }, {
    changes: args.dry_run ? [] : [{ kind: 'ui.control_created', parentId: args.parent_id, controlType: args.control_type }],
  });

export const handleUiControlSetProperty = (args: z.infer<typeof UiControlSetPropertySchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'ui.set_control_property', {
    ActorId: args.actor_id,
    Property: args.property,
    ...splitScalarValue(args.value),
    DryRun: args.dry_run,
    ...revision(args, args.dry_run),
  }, {
    changes: writeChange(args.dry_run, { kind: 'ui.control_property_set', id: args.actor_id, property: args.property }),
  });

export const handleParticleGetParameters = (args: z.infer<typeof ParticleGetParametersSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'particle.get_parameters', { ActorId: args.actor_id });

export const handleParticleSetParameter = (args: z.infer<typeof ParticleSetParameterSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'particle.set_parameter', {
    ActorId: args.actor_id,
    Track: args.track,
    Name: args.name,
    ...splitScalarValue(args.value),
    DryRun: args.dry_run,
    ...revision(args, args.dry_run),
  }, {
    changes: writeChange(args.dry_run, { kind: 'particle.parameter_set', id: args.actor_id, name: args.name }),
  });
