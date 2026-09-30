import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { isHeadlessRefusal, mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { isFamilyAllowed, policyForContext } from '../permissions.js';
import { ProjectMeta } from '../projectContext.js';

type RecordValue = Record<string, unknown>;

async function callMM(ctx: ProjectMeta, params: RecordValue, deadlineMs = 30_000) {
  const response = await callEditorBridge(ctx, 'mm.tuning', params, { deadlineMs: Math.min(60_000, deadlineMs) });
  return { data: response.data, bridge: response.bridge, warnings: response.warnings };
}

function mmError(error: unknown) {
  // P2: MM ops (status/clip_motion/preset) fail with INVALID_STATE when no
  // play session exists. The pre-P2 mapper reported those as
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

export const MMTuningSchema = z.object({
  op: z.enum(['status', 'top', 'replay', 'selftest', 'rebuild_start', 'rebuild_status', 'clip_motion']).describe('[local-bridge-only; absent in canonical installer] Read-only tuning read: live telemetry snapshot, top-N cost ranking from a trace file, deterministic replay verify, or native search self-test. rebuild_start queues a full DB rebuild (minutes, fire-and-forget); rebuild_status reads its progress marker. clip_motion audits per-clip baked motion (needs one play tick this session; reuses the preset field as a name filter).'),
  top_n: z.number().int().min(1).max(16).optional().default(8).describe('Candidates for op=top.'),
  entry_index: z.number().int().min(0).optional().describe('Trace entry for op=top (default: last).'),
  trace_path: z.string().max(512).optional().describe('Trace JSONL path for op=top/replay (default: Cache/MMTraceAuto.jsonl, fallback Cache/MMTrace.jsonl).'),
  max_entries: z.number().int().min(1).max(1200).optional().default(200).describe('Newest entries to replay for op=replay.'),
  preset: z.string().max(128).optional().describe('Name substring filter for op=clip_motion.'),
  timeout_ms: z.number().int().min(250).max(120_000).optional().default(60_000),
});

export const MMApplyPresetSchema = z.object({
  preset: z.enum(['baseline', 'pose', 'turn']).describe('[local-bridge-only; absent in canonical installer] Weight preset: trajectory-heavy baseline, pose-heavy precision, or turn-heavy. Live scene weights, no rebake. Marks the scene edited.'),
  timeout_ms: z.number().int().min(250).max(60_000).optional().default(30_000),
});

export async function handleMMTuning(args: z.infer<typeof MMTuningSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    // mm_tuning sits in the read family, but rebuild_start queues a full
    // database rebuild. That one op needs a profile that allows runtime tools.
    if (args.op === 'rebuild_start' && !isFamilyAllowed('runtime', policyForContext(ctx))) {
      throw new ToolDomainError('PERMISSION_DENIED', 'mm_tuning op "rebuild_start" queues a database rebuild and is not allowed by the active permission profile.');
    }
    const params: RecordValue = { Op: args.op, TopN: args.top_n, MaxEntries: args.max_entries };
    if (args.entry_index !== undefined) params.EntryIndex = args.entry_index;
    if (args.trace_path !== undefined) params.TracePath = args.trace_path;
    if (args.preset !== undefined) params.Preset = args.preset;
    const response = await callMM(ctx, params, args.timeout_ms);
    return ok(response.data, response.bridge, response.warnings);
  } catch (error) { return toolError(mmError(error)); }
}

export async function handleMMApplyPreset(args: z.infer<typeof MMApplyPresetSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callMM(ctx, { Op: 'preset', Preset: args.preset }, args.timeout_ms);
    return ok(response.data, response.bridge, response.warnings, [{ kind: 'mm.preset_applied', preset: args.preset }]);
  } catch (error) { return toolError(mmError(error)); }
}
