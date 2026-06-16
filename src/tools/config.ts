import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, safeReadFile } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GetInputActionsSchema = z.object({});
export const GetPhysicsSettingsSchema = z.object({});

const KEY_NAMES: Record<number, string> = {
  0: 'None', 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl',
  18: 'Alt', 27: 'Escape', 32: 'Space', 37: 'Left', 38: 'Up', 39: 'Right',
  40: 'Down', 65: 'A', 66: 'B', 67: 'C', 68: 'D', 69: 'E', 70: 'F',
  71: 'G', 72: 'H', 73: 'I', 74: 'J', 75: 'K', 76: 'L', 77: 'M',
  78: 'N', 79: 'O', 80: 'P', 81: 'Q', 82: 'R', 83: 'S', 84: 'T',
  85: 'U', 86: 'V', 87: 'W', 88: 'X', 89: 'Y', 90: 'Z',
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5',
};

const MOUSE_NAMES: Record<number, string> = {
  0: 'None', 1: 'Left', 2: 'Right', 3: 'Middle',
};

const AXIS_NAMES: Record<number, string> = {
  0: 'Mouse X', 1: 'Mouse Y', 2: 'Mouse Scroll',
  3: 'Gamepad Left X', 4: 'Gamepad Left Y',
  5: 'Gamepad Right X', 6: 'Gamepad Right Y',
};

const MODE_NAMES: Record<number, string> = {
  0: 'Press', 1: 'Down', 2: 'Release',
};

interface InputData {
  ActionMappings?: Array<{
    Name: string; Mode: number;
    Key: number; MouseButton: number; GamepadButton: number; Gamepad: number;
  }>;
  AxisMappings?: Array<{
    Name: string; Axis: number; Gamepad: number;
    Scale?: number; DeadZone?: number; Sensitivity?: number;
    PositiveButton?: number; NegativeButton?: number;
  }>;
}

interface PhysicsData {
  DefaultGravity?: { X: number; Y: number; Z: number };
  QueriesHitTriggers?: boolean;
  BounceThresholdVelocity?: number;
  FrictionCombineMode?: number;
  RestitutionCombineMode?: number;
  MaxDeltaTime?: number;
  LayerMasks?: number[];
  [key: string]: unknown;
}

interface SettingsFile<T> {
  ID?: string;
  TypeName?: string;
  EngineBuild?: number;
  Data?: T;
}

export async function handleGetInputActions(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const filePath = path.join(ctx.settingsDir, 'Input Settings.json');
    const raw = await safeReadFile(filePath);
    if (!raw) return toolError(new Error('Input Settings.json not found.'));

    const parsed = JSON.parse(raw) as SettingsFile<InputData>;
    const data = parsed.Data ?? {};

    const lines: string[] = ['## Action Mappings', ''];

    for (const a of data.ActionMappings ?? []) {
      const key = KEY_NAMES[a.Key] ?? `Key(${a.Key})`;
      const mouse = a.MouseButton > 0 ? `  Mouse:${MOUSE_NAMES[a.MouseButton] ?? a.MouseButton}` : '';
      const mode = MODE_NAMES[a.Mode] ?? `Mode(${a.Mode})`;
      lines.push(`  ${a.Name.padEnd(20)} ${mode}  Key:${key}${mouse}`);
    }

    lines.push('', '## Axis Mappings', '');

    for (const a of data.AxisMappings ?? []) {
      const axis = AXIS_NAMES[a.Axis] ?? `Axis(${a.Axis})`;
      const posKey = a.PositiveButton != null && a.PositiveButton > 0
        ? `  +${KEY_NAMES[a.PositiveButton] ?? a.PositiveButton}` : '';
      const negKey = a.NegativeButton != null && a.NegativeButton > 0
        ? `  -${KEY_NAMES[a.NegativeButton] ?? a.NegativeButton}` : '';
      const scale = a.Scale != null ? `  scale:${a.Scale}` : '';
      lines.push(`  ${a.Name.padEnd(20)} ${axis}${posKey}${negKey}${scale}`);
    }

    return toolResult(lines.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

export async function handleGetPhysicsSettings(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const filePath = path.join(ctx.settingsDir, 'Physics Settings.json');
    const raw = await safeReadFile(filePath);
    if (!raw) return toolError(new Error('Physics Settings.json not found.'));

    const parsed = JSON.parse(raw) as SettingsFile<PhysicsData>;
    const data = parsed.Data ?? {};

    const gravity = data.DefaultGravity;
    const lines: string[] = [
      '## Physics Settings',
      '',
      `Gravity:            X:${gravity?.X ?? 0}  Y:${gravity?.Y ?? -981}  Z:${gravity?.Z ?? 0}`,
      `QueriesHitTriggers: ${data.QueriesHitTriggers ?? true}`,
      `BounceThreshold:    ${data.BounceThresholdVelocity ?? 200} cm/s`,
      `MaxDeltaTime:       ${data.MaxDeltaTime ?? 0.1}s`,
      '',
      '## Layer Masks (first 8)',
    ];

    const masks = data.LayerMasks ?? [];
    for (let i = 0; i < Math.min(8, masks.length); i++) {
      lines.push(`  Layer ${i}: ${masks[i] === 4294967295 ? 'collide all' : `0x${(masks[i] ?? 0).toString(16).toUpperCase()}`}`);
    }

    // Other settings
    lines.push('', '## Other', '');
    const skip = new Set(['DefaultGravity', 'LayerMasks', 'QueriesHitTriggers', 'BounceThresholdVelocity', 'MaxDeltaTime']);
    for (const [k, v] of Object.entries(data)) {
      if (!skip.has(k)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }

    return toolResult(lines.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}
