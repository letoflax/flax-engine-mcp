import { z } from 'zod';
import { ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import { ConfirmedWrite, ContentPath, FlaxId, callLive, requiresConfirmation } from './liveToolSupport.js';

// Bridge v33 project-settings writes. The bridge goes through the Editor's
// GameSettings.Load/Save followed by GameSettings.Apply, refuses play mode,
// and refuses while the settings asset is open in an Editor window.

const EnumName = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Expected an enum member name.');
const SettingsName = z.string().min(1).max(64);
const Gamepad = z.enum(['All', 'Gamepad0', 'Gamepad1', 'Gamepad2', 'Gamepad3', 'Gamepad4', 'Gamepad5']);

export const SettingsSetInputActionSchema = z.object({
  name: SettingsName.describe('Action name used by Input.GetAction and InputEvent.'),
  mode: z.enum(['Pressing', 'Press', 'Release']).optional().default('Pressing'),
  key: EnumName.optional().describe('FlaxEngine.KeyboardKeys member, for example Spacebar, W, Return.'),
  mouse_button: z.enum(['Left', 'Middle', 'Right', 'Extended1', 'Extended2']).optional(),
  gamepad_button: EnumName.optional().describe('FlaxEngine.GamepadButton member, for example A, Start, RightShoulder.'),
  gamepad: Gamepad.optional().default('All'),
  replace: z.boolean().optional().default(false)
    .describe('Remove every existing binding with this name first. Without it the binding is appended (an action may have several bindings).'),
  ...ConfirmedWrite,
}).strict().superRefine((value, ctx) => {
  if (value.key === undefined && value.mouse_button === undefined && value.gamepad_button === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one of key, mouse_button, or gamepad_button.' });
  }
  requiresConfirmation(value, ctx);
});

export const SettingsSetInputAxisSchema = z.object({
  name: SettingsName.describe('Axis name used by Input.GetAxis.'),
  axis: z.enum([
    'MouseX', 'MouseY', 'MouseWheel', 'GamepadLeftStickX', 'GamepadLeftStickY', 'GamepadRightStickX', 'GamepadRightStickY',
    'GamepadLeftTrigger', 'GamepadRightTrigger', 'KeyboardOnly', 'GamepadDPadX', 'GamepadDPadY',
  ]).optional().default('KeyboardOnly'),
  positive_button: EnumName.optional().describe('FlaxEngine.KeyboardKeys member driving the axis toward +1.'),
  negative_button: EnumName.optional().describe('FlaxEngine.KeyboardKeys member driving the axis toward -1.'),
  gamepad_positive_button: EnumName.optional(),
  gamepad_negative_button: EnumName.optional(),
  gamepad: Gamepad.optional().default('All'),
  dead_zone: z.number().min(0).max(1).optional().default(0.1),
  sensitivity: z.number().min(0).max(1000).optional().default(1),
  gravity: z.number().min(0).max(1000).optional().default(1),
  scale: z.number().min(-1000).max(1000).optional().default(1),
  snap: z.boolean().optional().default(false),
  replace: z.boolean().optional().default(false)
    .describe('Remove every existing axis mapping with this name first. Without it the mapping is appended.'),
  ...ConfirmedWrite,
}).strict().superRefine((value, ctx) => {
  if (value.axis === 'KeyboardOnly'
    && value.positive_button === undefined && value.negative_button === undefined
    && value.gamepad_positive_button === undefined && value.gamepad_negative_button === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A KeyboardOnly axis needs at least one positive or negative button.' });
  }
  requiresConfirmation(value, ctx);
});

export const SettingsRemoveInputMappingSchema = z.object({
  kind: z.enum(['action', 'axis']),
  name: SettingsName.describe('Every mapping of this kind with this exact name is removed.'),
  ...ConfirmedWrite,
}).strict().superRefine(requiresConfirmation);

export const SettingsSetLayerNameSchema = z.object({
  index: z.number().int().min(0).max(31),
  name: z.string().max(64).describe('New layer name. An empty string clears the slot (layer 0 must keep a name).'),
  ...ConfirmedWrite,
}).strict().superRefine(requiresConfirmation);

export const SettingsAddTagSchema = z.object({
  tag: z.string().min(1).max(128),
  ...ConfirmedWrite,
}).strict().superRefine(requiresConfirmation);

export const SettingsSetFirstSceneSchema = z.object({
  asset_id: FlaxId.optional(),
  path: ContentPath.optional(),
  ...ConfirmedWrite,
}).strict().superRefine((value, ctx) => {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
  requiresConfirmation(value, ctx);
});

/** Reports a change only when the bridge actually saved the settings asset. */
function savedChange(kind: string, detail: Record<string, unknown>): (result: Record<string, unknown>) => unknown[] {
  return result => (result.Saved === true ? [{ kind, ...detail }] : []);
}

function confirmation(args: { dry_run: boolean; confirm?: true }): Record<string, unknown> {
  return { DryRun: args.dry_run, Confirm: args.confirm === true };
}

export const handleSettingsSetInputAction = (args: z.infer<typeof SettingsSetInputActionSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'settings.set_input_action', {
    Name: args.name,
    Mode: args.mode,
    Key: args.key,
    MouseButton: args.mouse_button,
    GamepadButton: args.gamepad_button,
    Gamepad: args.gamepad,
    Replace: args.replace,
    ...confirmation(args),
  }, { changes: savedChange('settings.input_action_set', { name: args.name }) });

export const handleSettingsSetInputAxis = (args: z.infer<typeof SettingsSetInputAxisSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'settings.set_input_axis', {
    Name: args.name,
    Axis: args.axis,
    PositiveButton: args.positive_button,
    NegativeButton: args.negative_button,
    GamepadPositiveButton: args.gamepad_positive_button,
    GamepadNegativeButton: args.gamepad_negative_button,
    Gamepad: args.gamepad,
    DeadZone: args.dead_zone,
    Sensitivity: args.sensitivity,
    Gravity: args.gravity,
    Scale: args.scale,
    Snap: args.snap,
    Replace: args.replace,
    ...confirmation(args),
  }, { changes: savedChange('settings.input_axis_set', { name: args.name }) });

export const handleSettingsRemoveInputMapping = (args: z.infer<typeof SettingsRemoveInputMappingSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'settings.remove_input_mapping', { Kind: args.kind, Name: args.name, ...confirmation(args) },
    { changes: savedChange('settings.input_mapping_removed', { mappingKind: args.kind, name: args.name }) });

export const handleSettingsSetLayerName = (args: z.infer<typeof SettingsSetLayerNameSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'settings.set_layer_name', { Index: args.index, Name: args.name, ...confirmation(args) },
    { changes: savedChange('settings.layer_name_set', { index: args.index, name: args.name }) });

export const handleSettingsAddTag = (args: z.infer<typeof SettingsAddTagSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'settings.add_tag', { Tag: args.tag, ...confirmation(args) },
    { changes: savedChange('settings.tag_added', { tag: args.tag }) });

export const handleSettingsSetFirstScene = (args: z.infer<typeof SettingsSetFirstSceneSchema>, ctx: ProjectMeta): Promise<ToolResponse> =>
  callLive(ctx, 'settings.set_first_scene', { AssetId: args.asset_id, Path: args.path, ...confirmation(args) },
    { changes: savedChange('settings.first_scene_set', { scene: args.asset_id ?? args.path }) });
