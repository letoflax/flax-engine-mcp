import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { isHeadlessRefusal, mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';

type RecordValue = Record<string, unknown>;

async function callMM(ctx: ProjectMeta, params: RecordValue, deadlineMs = 30_000) {
  const response = await callEditorBridge(ctx, 'mm.tuning', params, { deadlineMs: Math.min(60_000, deadlineMs) });
  return { data: response.data, bridge: response.bridge, warnings: response.warnings };
}

function mmError(error: unknown) {
  // P2: the preset op fails with INVALID_STATE when no play session
  // exists. The pre-P2 mapper reported those as
  // INVALID_PLAY_STATE; the shared mapper folds every non-headless
  // INVALID_STATE into EDITOR_BUSY, which would mislead callers testing
  // play-state. Keep the MM-specific code for the non-headless case and
  // delegate everything else (including headless evidence → HEADLESS_MODE).
  if (error instanceof BridgeRpcError && error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    if (remote?.code === 'INVALID_STATE' && !isHeadlessRefusal(error)) {
      return new ToolDomainError('INVALID_PLAY_STATE', error.message, remote?.details);
    }
  }
  return mapBridgeError(error);
}

function ok(data: unknown, bridge: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings, changes });
}

export const MMApplyPresetSchema = z.object({
  preset: z.enum(['baseline', 'pose', 'turn']).describe('[local-bridge-only; absent in canonical installer] Weight preset: trajectory-heavy baseline, pose-heavy precision, or turn-heavy. Live scene weights, no rebake. Marks the scene edited.'),
  timeout_ms: z.number().int().min(250).max(60_000).optional().default(30_000),
});

export async function handleMMApplyPreset(args: z.infer<typeof MMApplyPresetSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callMM(ctx, { Op: 'preset', Preset: args.preset }, args.timeout_ms);
    return ok(response.data, response.bridge, response.warnings, [{ kind: 'mm.preset_applied', preset: args.preset }]);
  } catch (error) { return toolError(mmError(error)); }
}
