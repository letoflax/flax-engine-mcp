import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod } from '../bridge/protocol.js';
import { ProjectMeta } from '../projectContext.js';
import { ToolDomainError, toolError, ToolResponse } from '../errors.js';
import { reportProgress } from '../progress.js';
import { InstanceParam, callGame } from './gameRuntime.js';
import { BRIDGE_V36 } from './liveToolSupport.js';
import { bridgeError, clean, cleanPerfSnapshot, finiteNumber, ok, val } from './liveObservability.js';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// perf_get_gpu_events (bridge v36 perf.gpu_events) and perf_capture
// (server-side sampling of perf.snapshot, optionally with perf.gpu_events).
// ---------------------------------------------------------------------------

/** Bridge-side cap per call; the bridge response limit is 512 KiB. */
const BRIDGE_EVENT_CAP = 1_000;
/** The bridge polls its request directory every 100 ms, so a faster rate than this cannot be honoured anyway. */
const GPU_POLL_MS = 50;
export const PERF_CAPTURE_MAX_SAMPLES = 600;
export const PERF_CAPTURE_MAX_DURATION_S = 60;

export const PerfGetGpuEventsSchema = z.object({
  frames: z.number().int().min(1).max(60).optional().default(1)
    .describe('Number of distinct rendered frames to average (1-60). 1 returns the last resolved GPU frame. Event times are averaged per event path (ancestors + name + occurrence) and divided by the frames sampled.'),
  timeout_ms: z.number().int().min(500).max(30_000).optional().default(5_000)
    .describe('How long to wait for GPU timer queries to resolve and for the requested number of frames. A result with fewer frames than requested carries a warning.'),
  min_ms: z.number().min(0).max(1_000).optional().default(0)
    .describe('Drop events whose (averaged) GPU time is below this many milliseconds.'),
  max_events: z.number().int().min(1).max(BRIDGE_EVENT_CAP).optional().default(100)
    .describe('Maximum events returned after min_ms filtering; `truncated` says when more matched.'),
  sort_by: z.enum(['order', 'time']).optional().default('order')
    .describe('"order" keeps the frame pre-order hierarchy (as the Profiler window lists it), "time" sorts by time_ms descending. The cap applies after sorting.'),
  instance: InstanceParam,
});

export const PerfCaptureSchema = z.object({
  duration_s: z.number().min(0.5).max(PERF_CAPTURE_MAX_DURATION_S).optional().default(5)
    .describe(`Capture length in seconds (0.5-${PERF_CAPTURE_MAX_DURATION_S}).`),
  interval_ms: z.number().int().min(50).max(5_000).optional().default(250)
    .describe('Target time between snapshots (50-5000 ms). Every sample is one bridge round trip, and the bridge polls requests every 100 ms, so the real rate is usually slower; see interval_actual_ms in the result.'),
  hitch_factor: z.number().min(1.1).max(20).optional().default(2)
    .describe('A sample is a hitch when its frame time exceeds hitch_factor times the median frame time (default 2).'),
  hitch_threshold_ms: z.number().positive().max(10_000).optional()
    .describe('Absolute hitch threshold in ms; when given it replaces hitch_factor.'),
  include_gpu: z.boolean().optional().default(false)
    .describe('Also sample perf.gpu_events (bridge v36) with each snapshot and aggregate the average GPU ms per pass at gpu_depth. Enables GPU profiling for the capture and restores the previous state.'),
  gpu_depth: z.number().int().min(0).max(4).optional().default(1)
    .describe('Event depth that counts as a "pass" for include_gpu (0 is the frame root).'),
  instance: InstanceParam,
}).superRefine((value, ctx) => {
  const samples = Math.ceil((value.duration_s * 1000) / value.interval_ms);
  if (samples > PERF_CAPTURE_MAX_SAMPLES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interval_ms'], message: `duration_s / interval_ms allows ${samples} samples; the maximum is ${PERF_CAPTURE_MAX_SAMPLES}. Raise interval_ms or lower duration_s.` });
  }
});

export interface PerfLiveDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
}
const defaultDeps: PerfLiveDeps = { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => Date.now() };

// ---------------------------------------------------------------- GPU events

export interface GpuEvent { name: string; depth: number; time_ms: number; draw_calls: number; dispatch_calls: number; triangles: number }
export interface GpuFrame {
  events: GpuEvent[];
  drawGpuMs: number | null;
  drawCpuMs: number | null;
  eventCount: number;
  truncated: boolean;
}
interface GpuMeta {
  available: boolean;
  reason: string | null;
  wasEnabled: boolean | null;
  enabledByBridge: boolean | null;
  restored: boolean | null;
  adapter: string | null;
  renderer: string | null;
  isPlayMode: boolean | null;
}

function boolOrNull(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null; }
function text(value: unknown, max = 256): string | null { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }
const round = (value: number, digits = 4): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Allowlisted projection of one McpPerfGpuEvents response. */
export function parseGpuEvents(raw: unknown): { meta: GpuMeta; frame: GpuFrame | null } {
  const row: Row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : {};
  const meta: GpuMeta = {
    available: val(row, 'ProfilerAvailable', 'profilerAvailable') === true,
    reason: text(val(row, 'Reason', 'reason'), 64),
    wasEnabled: boolOrNull(val(row, 'WasEnabled', 'wasEnabled')),
    enabledByBridge: boolOrNull(val(row, 'EnabledByBridge', 'enabledByBridge')),
    restored: boolOrNull(val(row, 'Restored', 'restored')),
    adapter: text(val(row, 'GpuAdapter', 'gpuAdapter')),
    renderer: text(val(row, 'RendererType', 'rendererType'), 64),
    isPlayMode: boolOrNull(val(row, 'IsPlayMode', 'isPlayMode')),
  };
  const list = val(row, 'Events', 'events');
  if (val(row, 'HasData', 'hasData') !== true || !Array.isArray(list) || list.length === 0) return { meta, frame: null };
  const events: GpuEvent[] = [];
  for (const item of list.slice(0, 2_000)) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Row;
    const time = finiteNumber(val(e, 'TimeMs', 'timeMs'));
    const depth = finiteNumber(val(e, 'Depth', 'depth'));
    if (time === null || depth === null || depth < 0 || depth > 64) continue;
    events.push({
      name: text(val(e, 'Name', 'name'), 128) ?? '',
      depth: Math.trunc(depth),
      time_ms: Math.max(0, time),
      draw_calls: finiteNumber(val(e, 'DrawCalls', 'drawCalls')) ?? 0,
      dispatch_calls: finiteNumber(val(e, 'DispatchCalls', 'dispatchCalls')) ?? 0,
      triangles: finiteNumber(val(e, 'Triangles', 'triangles')) ?? 0,
    });
  }
  if (events.length === 0) return { meta, frame: null };
  return {
    meta,
    frame: {
      events,
      drawGpuMs: finiteNumber(val(row, 'DrawGpuTimeMs', 'drawGpuTimeMs')),
      drawCpuMs: finiteNumber(val(row, 'DrawCpuTimeMs', 'drawCpuTimeMs')),
      eventCount: finiteNumber(val(row, 'EventCount', 'eventCount')) ?? events.length,
      truncated: val(row, 'Truncated', 'truncated') === true,
    },
  };
}

/** Frames are the same when every event time is identical: the bridge re-reads the last resolved frame until a newer one resolves. */
function frameFingerprint(frame: GpuFrame): string {
  return `${frame.events.length}:${frame.events.map(e => e.time_ms).join(',')}`;
}

/** Root (depth 0) total: the frame GPU time the engine reports, else the sum of the depth-0 events. */
function frameTotalMs(frame: GpuFrame): number {
  if (frame.drawGpuMs !== null) return frame.drawGpuMs;
  return frame.events.filter(e => e.depth === 0).reduce((sum, e) => sum + e.time_ms, 0);
}

interface Aggregated extends GpuEvent { order: number }

/** Averages events of several frames per path key (ancestor names + name + occurrence among equal paths); missing = 0 ms. */
export function aggregateGpuFrames(frames: GpuFrame[]): { events: GpuEvent[]; totalGpuMs: number | null; drawCpuMs: number | null } {
  if (frames.length === 0) return { events: [], totalGpuMs: null, drawCpuMs: null };
  const map = new Map<string, Aggregated>();
  for (const frame of frames) {
    const stack: string[] = [];
    const seen = new Map<string, number>();
    for (const e of frame.events) {
      stack.length = Math.min(stack.length, e.depth);
      while (stack.length < e.depth) stack.push('');
      stack.push(e.name);
      const pathKey = stack.join('/');
      const occurrence = seen.get(pathKey) ?? 0;
      seen.set(pathKey, occurrence + 1);
      const key = `${pathKey}#${occurrence}`;
      const entry = map.get(key) ?? { name: e.name, depth: e.depth, time_ms: 0, draw_calls: 0, dispatch_calls: 0, triangles: 0, order: map.size };
      entry.time_ms += e.time_ms;
      entry.draw_calls += e.draw_calls;
      entry.dispatch_calls += e.dispatch_calls;
      entry.triangles += e.triangles;
      map.set(key, entry);
    }
  }
  const n = frames.length;
  const events = [...map.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...e }) => ({
    name: e.name,
    depth: e.depth,
    time_ms: round(e.time_ms / n),
    draw_calls: Math.round(e.draw_calls / n),
    dispatch_calls: Math.round(e.dispatch_calls / n),
    triangles: Math.round(e.triangles / n),
  }));
  const totals = frames.map(frameTotalMs);
  const cpu = frames.map(f => f.drawCpuMs).filter((v): v is number => v !== null);
  return {
    events,
    totalGpuMs: round(totals.reduce((a, b) => a + b, 0) / n),
    drawCpuMs: cpu.length ? round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
  };
}

async function callGpu(ctx: ProjectMeta, instance: string | undefined, params: Row, deadlineMs?: number) {
  return instance === undefined
    ? callEditorBridge<BridgeMethod, Row, unknown>(ctx, 'perf.gpu_events', params, { minimumBridgeVersion: BRIDGE_V36, ...(deadlineMs ? { deadlineMs } : {}) })
    : callGame<unknown>(ctx, instance, 'perf.gpu_events', params, deadlineMs);
}

export async function handlePerfGetGpuEvents(
  args: z.infer<typeof PerfGetGpuEventsSchema>,
  ctx: ProjectMeta,
  deps: PerfLiveDeps = defaultDeps,
): Promise<ToolResponse> {
  const warnings: string[] = [];
  let enabledTouched = false;
  let meta: GpuMeta | null = null;
  const frames: GpuFrame[] = [];
  let lastFingerprint = '';
  let lastReason: string | null = null;
  let restored: boolean | null = null;
  try {
    const started = deps.now();
    const deadline = started + args.timeout_ms;
    let first = true;
    while (true) {
      const response = await callGpu(ctx, args.instance, { Enable: true, MaxEvents: BRIDGE_EVENT_CAP });
      if (first) enabledTouched = true;
      first = false;
      warnings.push(...response.warnings.filter(w => !warnings.includes(w)));
      const parsed = parseGpuEvents(response.data);
      meta = parsed.meta;
      lastReason = parsed.meta.reason;
      if (!parsed.meta.available) break;
      if (parsed.frame) {
        const fingerprint = frameFingerprint(parsed.frame);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          frames.push(parsed.frame);
          if (parsed.frame.truncated) warnings.push(`The bridge capped the frame at ${BRIDGE_EVENT_CAP} events (the frame has ${parsed.frame.eventCount}).`);
        }
      }
      if (frames.length >= args.frames || deps.now() >= deadline) break;
      reportProgress('Sampling GPU events', args.timeout_ms);
      await deps.sleep(Math.min(GPU_POLL_MS, Math.max(0, deadline - deps.now())));
    }
  } catch (error) {
    // Put the profiler back before reporting the failure.
    if (enabledTouched) await restoreGpu(ctx, args.instance).catch(() => undefined);
    return toolError(error instanceof ToolDomainError ? error : bridgeError(error, false, args.instance !== undefined));
  }
  if (enabledTouched && meta?.available) {
    try {
      const response = await callGpu(ctx, args.instance, { Restore: true, MaxEvents: 1 });
      restored = parseGpuEvents(response.data).meta.restored;
    } catch {
      warnings.push('Could not confirm restoring the GPU profiler; the bridge restores it by itself within 30 seconds.');
    }
  }
  if (!meta) return toolError(new ToolDomainError('INTERNAL_ERROR', 'The bridge returned no GPU event data.'));

  const aggregated = aggregateGpuFrames(frames);
  const matching = aggregated.events.filter(e => e.time_ms >= args.min_ms);
  const ordered = args.sort_by === 'time' ? [...matching].sort((a, b) => b.time_ms - a.time_ms) : matching;
  const events = ordered.slice(0, args.max_events).map(e => ({
    name: e.name, depth: e.depth, time_ms: e.time_ms, draw_calls: e.draw_calls, dispatch_calls: e.dispatch_calls, triangles: e.triangles,
  }));
  let reason: string | null = null;
  if (frames.length === 0) reason = meta.available ? (lastReason ?? 'no_data_yet') : (meta.reason ?? 'unavailable');
  else if (frames.length < args.frames) warnings.push(`Only ${frames.length} of ${args.frames} requested frames resolved within ${args.timeout_ms} ms; averaged over those.`);
  const data = {
    available: frames.length > 0,
    reason,
    frames_requested: args.frames,
    frames_sampled: frames.length,
    total_gpu_ms: aggregated.totalGpuMs,
    draw_cpu_ms: aggregated.drawCpuMs,
    event_count: frames.length ? aggregated.events.length : null,
    matching_events: frames.length ? matching.length : null,
    truncated: matching.length > events.length,
    events,
    profiler: { was_enabled: meta.wasEnabled, enabled_by_tool: meta.enabledByBridge, restored },
    gpu_adapter: meta.adapter,
    renderer_type: meta.renderer,
    is_play_mode: meta.isPlayMode,
  };
  return ok(clean(data, ctx), warnings, args.instance);
}

async function restoreGpu(ctx: ProjectMeta, instance: string | undefined): Promise<void> {
  await callGpu(ctx, instance, { Restore: true, MaxEvents: 1 });
}

// ---------------------------------------------------------------- perf_capture

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
const r2 = (v: number | null): number | null => (v === null ? null : round(v, 3));

interface PerfSample { t: number; fps: number | null; frameMs: number | null; drawCalls: number | null; triangles: number | null }

export function summarizePerfSamples(samples: PerfSample[], hitchFactor: number, hitchThresholdMs?: number) {
  const frameTimes = samples.map(s => s.frameMs).filter((v): v is number => v !== null);
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const median = percentile(sorted, 50);
  const threshold = hitchThresholdMs ?? (median === null ? null : median * hitchFactor);
  const hitches = threshold === null ? null : frameTimes.filter(v => v > threshold).length;
  const fpsValues = samples.map(s => s.fps).filter((v): v is number => v !== null);
  const avgFrame = mean(frameTimes);
  const draws = samples.map(s => s.drawCalls).filter((v): v is number => v !== null);
  const tris = samples.map(s => s.triangles).filter((v): v is number => v !== null);
  return {
    frame_ms: {
      samples: frameTimes.length,
      avg: r2(avgFrame),
      min: r2(sorted.length ? sorted[0] : null),
      median: r2(median),
      p95: r2(percentile(sorted, 95)),
      p99: r2(percentile(sorted, 99)),
      max: r2(sorted.length ? sorted[sorted.length - 1] : null),
    },
    avg_fps: r2(fpsValues.length ? mean(fpsValues) : avgFrame ? 1000 / avgFrame : null),
    fps_source: fpsValues.length ? 'engine_fps_counter' : avgFrame ? 'frame_time' : null,
    hitches: {
      threshold_ms: r2(threshold),
      rule: hitchThresholdMs !== undefined ? 'absolute' : `median x ${hitchFactor}`,
      count: hitches,
    },
    draw_calls: { samples: draws.length, avg: r2(mean(draws)), max: draws.length ? Math.max(...draws) : null },
    triangles: { samples: tris.length, avg: r2(mean(tris)), max: tris.length ? Math.max(...tris) : null },
  };
}

export function summarizeGpuPasses(frames: GpuFrame[], depth: number) {
  if (frames.length === 0) return { samples: 0, total_gpu_ms_avg: null, passes: [] as Array<{ name: string; avg_ms: number; max_ms: number; share_pct: number | null }> };
  const sums = new Map<string, { sum: number; max: number }>();
  for (const frame of frames) {
    const perFrame = new Map<string, number>();
    for (const e of frame.events) if (e.depth === depth) perFrame.set(e.name, (perFrame.get(e.name) ?? 0) + e.time_ms);
    for (const [name, time] of perFrame) {
      const entry = sums.get(name) ?? { sum: 0, max: 0 };
      entry.sum += time;
      entry.max = Math.max(entry.max, time);
      sums.set(name, entry);
    }
  }
  const total = mean(frames.map(frameTotalMs));
  const passes = [...sums.entries()]
    .map(([name, v]) => ({ name, avg_ms: round(v.sum / frames.length), max_ms: round(v.max), share_pct: total ? round((100 * (v.sum / frames.length)) / total, 1) : null }))
    .sort((a, b) => b.avg_ms - a.avg_ms)
    .slice(0, 25);
  return { samples: frames.length, total_gpu_ms_avg: total === null ? null : round(total), passes };
}

export async function handlePerfCapture(
  args: z.infer<typeof PerfCaptureSchema>,
  ctx: ProjectMeta,
  deps: PerfLiveDeps = defaultDeps,
): Promise<ToolResponse> {
  const warnings: string[] = [];
  const samples: PerfSample[] = [];
  const gpuFrames: GpuFrame[] = [];
  let gpuMeta: GpuMeta | null = null;
  let gpuActive = args.include_gpu;
  let gpuTouched = false;
  let lastGpuFingerprint = '';
  let isPlayMode: boolean | null = null;
  let adapter: string | null = null;
  let renderer: string | null = null;
  const durationMs = args.duration_s * 1000;
  const maxSamples = Math.min(PERF_CAPTURE_MAX_SAMPLES, Math.ceil(durationMs / args.interval_ms));
  const started = deps.now();
  try {
    while (samples.length < maxSamples) {
      const tick = deps.now();
      let snapshotResponse;
      try {
        snapshotResponse = args.instance === undefined
          ? await callEditorBridge<BridgeMethod, Row, unknown>(ctx, 'perf.snapshot', {}, { minimumBridgeVersion: 27 })
          : await callGame<unknown>(ctx, args.instance, 'perf.snapshot', {});
      } catch (error) {
        if (samples.length === 0) throw error;
        warnings.push(`Stopped after ${samples.length} samples: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      warnings.push(...snapshotResponse.warnings.filter(w => !warnings.includes(w)));
      const snap = cleanPerfSnapshot(snapshotResponse.data);
      isPlayMode = snap.is_play_mode === true;
      adapter = (snap.gpu_adapter as string | null) ?? adapter;
      renderer = (snap.renderer_type as string | null) ?? renderer;
      samples.push({
        t: deps.now() - started,
        fps: snap.fps as number | null,
        frameMs: snap.frame_time_ms as number | null,
        drawCalls: snap.draw_calls as number | null,
        triangles: snap.triangles as number | null,
      });
      if (gpuActive) {
        try {
          const response = await callGpu(ctx, args.instance, { Enable: true, MaxEvents: BRIDGE_EVENT_CAP });
          const parsed = parseGpuEvents(response.data);
          gpuMeta = parsed.meta;
          if (parsed.meta.available) gpuTouched = true;
          if (!parsed.meta.available) gpuActive = false;
          else if (parsed.frame) {
            const fingerprint = frameFingerprint(parsed.frame);
            if (fingerprint !== lastGpuFingerprint) { lastGpuFingerprint = fingerprint; gpuFrames.push(parsed.frame); }
          }
        } catch (error) {
          // The snapshot data is still good; GPU events are the optional part.
          if (samples.length === 1) throw error;
          warnings.push(`GPU events stopped: ${error instanceof Error ? error.message : String(error)}`);
          gpuActive = false;
        }
      }
      if (samples.length >= maxSamples || deps.now() - started >= durationMs) break;
      reportProgress('Sampling performance', durationMs);
      const spent = deps.now() - tick;
      await deps.sleep(Math.max(0, args.interval_ms - spent));
    }
  } catch (error) {
    if (gpuTouched) await restoreGpu(ctx, args.instance).catch(() => undefined);
    return toolError(error instanceof ToolDomainError ? error : bridgeError(error, false, args.instance !== undefined));
  }
  let restored: boolean | null = null;
  if (gpuTouched) {
    try {
      const response = await callGpu(ctx, args.instance, { Restore: true, MaxEvents: 1 });
      restored = parseGpuEvents(response.data).meta.restored;
    } catch {
      warnings.push('Could not confirm restoring the GPU profiler; the bridge restores it by itself within 30 seconds.');
    }
  }
  const elapsed = samples.length ? samples[samples.length - 1].t : 0;
  const summary = summarizePerfSamples(samples, args.hitch_factor, args.hitch_threshold_ms);
  if (summary.frame_ms.samples < 5) warnings.push('Fewer than 5 frame-time samples: percentiles and the hitch count are not meaningful.');
  const data: Row = {
    ...summary,
    capture: {
      samples: samples.length,
      duration_s: round(elapsed / 1000, 2),
      interval_requested_ms: args.interval_ms,
      interval_actual_ms: samples.length > 1 ? round(elapsed / (samples.length - 1), 1) : null,
      is_play_mode: isPlayMode,
      gpu_adapter: adapter,
      renderer_type: renderer,
      method: 'Statistical: one perf.snapshot (Time.UnscaledDeltaTime of the latest frame) per sample, not every frame. A hitch is only counted when a sample lands on it.',
    },
  };
  if (args.include_gpu) {
    const passes = summarizeGpuPasses(gpuFrames, args.gpu_depth);
    data.gpu = {
      available: gpuFrames.length > 0,
      reason: gpuFrames.length > 0 ? null : (gpuMeta ? (gpuMeta.available ? (gpuMeta.reason ?? 'no_data_yet') : (gpuMeta.reason ?? 'unavailable')) : 'not_sampled'),
      pass_depth: args.gpu_depth,
      frames: passes.samples,
      total_gpu_ms_avg: passes.total_gpu_ms_avg,
      passes: passes.passes,
      profiler: { was_enabled: gpuMeta?.wasEnabled ?? null, enabled_by_tool: gpuMeta?.enabledByBridge ?? null, restored },
    };
  }
  return ok(clean(data, ctx), warnings, args.instance);
}
