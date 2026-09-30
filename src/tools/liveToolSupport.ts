import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';

/** Minimum bridge for the v33 member, UI, runtime-script, settings, lifecycle, and particle surface. */
export const BRIDGE_V33 = 33;

export const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');

function isContentPath(value: string, allowRoot: boolean): boolean {
  if (value.replaceAll('\\', '/') !== value) return false;
  if (allowRoot && value === 'Content') return true;
  return value.startsWith('Content/')
    && !value.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'));
}

export const ContentPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  if (!isContentPath(value, false)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative path under Content/ without traversal.' });
  }
});

/** Bridge value union: the bridge coerces strictly to the target member type. */
export const ScalarValue = z.union([z.boolean(), z.number().finite(), z.string().max(4096)]);
export type ScalarValueInput = z.infer<typeof ScalarValue>;

export function splitScalarValue(value: ScalarValueInput): { Bool?: boolean; Number?: number; Text?: string } {
  if (typeof value === 'boolean') return { Bool: value };
  if (typeof value === 'number') return { Number: value };
  return { Text: value };
}

export const RevisionedLiveWrite = {
  expected_scene_revision: z.number().int().nonnegative().optional()
    .describe('Bridge-known revision required before writing. Rejects stale scene state.'),
  lease_id: z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character edit lease ID.').optional()
    .describe('Active edit lease for the target scene.'),
  idempotency_key: z.string().min(1).max(128).optional()
    .describe('Optional retry key. Replays the original result without another side effect for ten minutes.'),
};

/** Durable writes without an Editor undo record need an explicit confirm unless they are previews. */
export const ConfirmedWrite = {
  dry_run: z.boolean().optional().default(false)
    .describe('Preview the change without saving anything.'),
  confirm: z.literal(true).optional()
    .describe('Required for a real write: the change persists to disk immediately and has no Editor undo record.'),
};

export function requiresConfirmation(value: { dry_run: boolean; confirm?: true }, ctx: z.RefinementCtx): void {
  if (!value.dry_run && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Set confirm: true to persist this change, or dry_run: true to preview it.' });
  }
}

export function mapLiveError(error: unknown, playScoped = false): ToolDomainError {
  if (error instanceof BridgeRpcError && error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    if (remote?.code === 'SCENE_REVISION_CONFLICT') return new ToolDomainError('SCENE_REVISION_CONFLICT', error.message, remote.details);
    if (remote?.code === 'FILE_EXISTS') return new ToolDomainError('FILE_EXISTS', error.message, remote.details);
    if (remote?.code === 'INVALID_STATE') {
      // Play-mode tools report a wrong play state, not a busy editor.
      if (playScoped) return new ToolDomainError('INVALID_PLAY_STATE', error.message, remote.details);
      // The bridge edit-time gate names headless mode in its message and sends no details.
      if (/headless/i.test(error.message)) return new ToolDomainError('HEADLESS_MODE', error.message, remote.details);
    }
  }
  return mapBridgeError(error);
}

function bridgeWarnings(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const warnings = (value as { Warnings?: unknown }).Warnings;
  return Array.isArray(warnings) ? warnings.filter((entry): entry is string => typeof entry === 'string') : [];
}

export interface LiveCallOptions {
  /** Side effects to report. A function receives the bridge result so previews and no-ops can report none. */
  changes?: unknown[] | ((result: Record<string, unknown>) => unknown[]);
  playScoped?: boolean;
  minimumBridgeVersion?: number;
  warnings?: string[];
}

export async function callLive(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: Record<string, unknown>,
  options: LiveCallOptions = {},
): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion: options.minimumBridgeVersion ?? BRIDGE_V33 });
    const result = typeof response.data === 'object' && response.data !== null ? response.data as Record<string, unknown> : {};
    const changes = typeof options.changes === 'function' ? options.changes(result) : options.changes ?? [];
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: response.mode,
      data,
      warnings: [...response.warnings, ...bridgeWarnings(response.data), ...(options.warnings ?? [])],
      changes,
    });
  } catch (error) {
    return toolError(mapLiveError(error, options.playScoped === true));
  }
}
