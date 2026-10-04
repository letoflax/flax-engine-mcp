import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import {
  PERF_CAPTURE_MAX_SAMPLES,
  PerfCaptureSchema,
  PerfGetGpuEventsSchema,
  aggregateGpuFrames,
  handlePerfCapture,
  handlePerfGetGpuEvents,
  parseGpuEvents,
  percentile,
  summarizeGpuPasses,
  summarizePerfSamples,
  type GpuFrame,
  type PerfLiveDeps,
} from './perfLive.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
interface SeenRequest { method: string; params: Record<string, any> }
interface Fixture { root: string; ctx: ProjectMeta; dir: string; cleanup(): Promise<void> }

async function fixture(bridgeVersion = 36, runtime?: string): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-perf-'));
  const dir = runtime === undefined ? path.join(root, 'Cache', 'MCP') : path.join(root, 'Cache', 'MCP-Runtime', runtime);
  await Promise.all([fs.mkdir(path.join(dir, 'requests'), { recursive: true }), fs.mkdir(path.join(dir, 'responses'), { recursive: true })]);
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), '{"Name":"Fixture"}');
  await fs.writeFile(path.join(dir, 'bridge.json'), JSON.stringify({
    Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1,
    ...(runtime === undefined ? {} : { Kind: 'game', Instance: runtime, ProductName: 'Fixture', EngineVersion: '1.12.6912' }),
  }));
  await fs.writeFile(path.join(dir, 'token'), TOKEN);
  return { root, dir, ctx: await createProjectContext(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** A fake bridge peer: answers every request in order with `respond`; a thrown { code } becomes a bridge error. */
function peer(f: Fixture, respond: (request: SeenRequest, index: number) => unknown) {
  const seen: SeenRequest[] = [];
  let stopped = false;
  const requests = path.join(f.dir, 'requests');
  const loop = (async () => {
    while (!stopped) {
      let names: string[] = [];
      try { names = (await fs.readdir(requests)).filter(name => name.endsWith('.json')); } catch { /* removed */ }
      for (const name of names) {
        let body: Record<string, any>;
        try { body = JSON.parse(await fs.readFile(path.join(requests, name), 'utf8')) as Record<string, any>; } catch { continue; }
        await fs.rm(path.join(requests, name), { force: true });
        const request: SeenRequest = { method: body.method, params: JSON.parse(body.paramsJson) };
        seen.push(request);
        let reply: Record<string, unknown>;
        try { reply = { id: body.id, token: body.token, ok: true, resultJson: JSON.stringify(respond(request, seen.length - 1)) }; }
        catch (error) {
          const failure = error as { code?: string; message?: string };
          reply = { id: body.id, token: body.token, ok: false, errorCode: failure.code ?? 'INTERNAL_ERROR', error: failure.message ?? 'failed' };
        }
        const target = path.join(f.dir, 'responses', `${body.id}.json`);
        await fs.writeFile(`${target}.tmp`, JSON.stringify(reply));
        await fs.rename(`${target}.tmp`, target);
      }
      await new Promise(resolve => setTimeout(resolve, 3));
    }
  })();
  return { seen, stop: async () => { stopped = true; await loop; } };
}

/** Deterministic clock: sleeping advances time, so a 60 s capture runs instantly. */
function fakeDeps(): PerfLiveDeps & { time: number } {
  const deps = { time: 0, now: () => deps.time, sleep: async (ms: number) => { deps.time += ms; } };
  return deps;
}

const envelope = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;

const ev = (Name: string, Depth: number, TimeMs: number, DrawCalls = 0, Triangles = 0) => ({ Name, Depth, TimeMs, DrawCalls, DispatchCalls: 0, Triangles, Vertices: 0 });
function gpuReply(events: ReturnType<typeof ev>[] | null, extra: Record<string, unknown> = {}) {
  return {
    ProfilerAvailable: true, Reason: events ? null : 'no_data_yet', ProfilerEnabled: true, EnabledByBridge: true, WasEnabled: false,
    Restored: false, FrameCount: 100, HasData: events !== null, DrawGpuTimeMs: events ? events[0].TimeMs : null, DrawCpuTimeMs: 2,
    EventCount: events?.length ?? 0, Truncated: false, Events: events ?? [], GpuAdapter: 'AMD Radeon RX 7900 GRE', RendererType: 'Vulkan',
    IsPlayMode: false, TimestampUnixMs: 1, ...extra,
  };
}
const frame = (scale = 1) => [
  ev('Frame', 0, 10 * scale), ev('GBuffer', 1, 4 * scale, 100, 5000), ev('Depth', 2, 1 * scale, 40, 2000), ev('Lights', 1, 3 * scale, 10, 100), ev('Post', 1, 2 * scale, 5, 10),
];

// ------------------------------------------------------------------ schemas

test('perf tool schemas have bounded defaults and refuse unbounded captures', () => {
  assert.deepEqual(PerfGetGpuEventsSchema.parse({}), { frames: 1, timeout_ms: 5_000, min_ms: 0, max_events: 100, sort_by: 'order' });
  assert.equal(PerfGetGpuEventsSchema.safeParse({ frames: 61 }).success, false);
  assert.equal(PerfGetGpuEventsSchema.safeParse({ max_events: 1_001 }).success, false);
  assert.equal(PerfGetGpuEventsSchema.safeParse({ min_ms: -1 }).success, false);
  assert.deepEqual(PerfCaptureSchema.parse({}), { duration_s: 5, interval_ms: 250, hitch_factor: 2, include_gpu: false, gpu_depth: 1 });
  assert.equal(PerfCaptureSchema.safeParse({ duration_s: 61 }).success, false);
  assert.equal(PerfCaptureSchema.safeParse({ interval_ms: 49 }).success, false);
  assert.equal(PerfCaptureSchema.safeParse({ duration_s: 60, interval_ms: 100 }).success, true);
  assert.equal(PerfCaptureSchema.safeParse({ duration_s: 60, interval_ms: 50 }).success, false, `more than ${PERF_CAPTURE_MAX_SAMPLES} samples`);
  assert.equal(PerfCaptureSchema.safeParse({ instance: '../x' }).success, false);
});

// ------------------------------------------------------------------ pure helpers

test('percentile uses nearest rank and aggregateGpuFrames averages per path key', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  const a = parseGpuEvents(gpuReply(frame(1))).frame!;
  const b = parseGpuEvents(gpuReply(frame(3))).frame!;
  const agg = aggregateGpuFrames([a, b]);
  assert.equal(agg.totalGpuMs, 20);
  assert.deepEqual(agg.events.map(e => [e.name, e.depth, e.time_ms]), [['Frame', 0, 20], ['GBuffer', 1, 8], ['Depth', 2, 2], ['Lights', 1, 6], ['Post', 1, 4]]);
  assert.equal(agg.events[1].draw_calls, 100);
  assert.deepEqual(aggregateGpuFrames([]), { events: [], totalGpuMs: null, drawCpuMs: null });
  // Repeated names under one parent stay separate events.
  const dup = parseGpuEvents(gpuReply([ev('Frame', 0, 5), ev('Pass', 1, 2), ev('Pass', 1, 3)])).frame!;
  assert.deepEqual(aggregateGpuFrames([dup]).events.map(e => e.time_ms), [5, 2, 3]);
  // An event missing from one frame averages as 0 ms.
  const sparse = parseGpuEvents(gpuReply([ev('Frame', 0, 4)])).frame!;
  assert.equal(aggregateGpuFrames([a, sparse]).events.find(e => e.name === 'GBuffer')!.time_ms, 2);
});

test('parseGpuEvents allowlists fields and treats an empty or no-data reply as no frame', () => {
  const parsed = parseGpuEvents({ ...gpuReply(frame()), Secret: 'C:/Users/x/secret', Events: [...frame(), { Name: 'bad', Depth: -1, TimeMs: 1 }, null, 'x'] });
  assert.equal(parsed.frame!.events.length, 5);
  assert.equal(parsed.meta.adapter, 'AMD Radeon RX 7900 GRE');
  assert.equal(parseGpuEvents(gpuReply(null)).frame, null);
  assert.equal(parseGpuEvents(null).meta.available, false);
  assert.equal(parseGpuEvents({ HasData: true, Events: [] }).frame, null);
});

test('summarizePerfSamples computes avg, percentiles, hitches and draw stats', () => {
  const frameMs = [10, 10, 10, 10, 10, 10, 10, 10, 10, 50];
  const samples = frameMs.map((ms, i) => ({ t: i * 100, fps: 100, frameMs: ms, drawCalls: 100 + i, triangles: 1000 }));
  const s = summarizePerfSamples(samples, 2);
  assert.equal(s.frame_ms.avg, 14);
  assert.equal(s.frame_ms.min, 10);
  assert.equal(s.frame_ms.median, 10);
  assert.equal(s.frame_ms.p95, 50);
  assert.equal(s.frame_ms.p99, 50);
  assert.equal(s.hitches.count, 1);
  assert.equal(s.hitches.threshold_ms, 20);
  assert.equal(s.avg_fps, 100);
  assert.deepEqual(s.draw_calls, { samples: 10, avg: 104.5, max: 109 });
  assert.equal(summarizePerfSamples(samples, 2, 5).hitches.count, 10);
  const none = summarizePerfSamples([{ t: 0, fps: null, frameMs: null, drawCalls: null, triangles: null }], 2);
  assert.equal(none.frame_ms.avg, null);
  assert.equal(none.avg_fps, null);
  assert.equal(none.hitches.count, null);
  assert.equal(none.draw_calls.max, null);
  const gpu = summarizeGpuPasses([parseGpuEvents(gpuReply(frame(1))).frame!, parseGpuEvents(gpuReply(frame(3))).frame!], 1);
  assert.deepEqual(gpu.passes.map(p => [p.name, p.avg_ms]), [['GBuffer', 8], ['Lights', 6], ['Post', 4]]);
  assert.equal(gpu.passes[0].share_pct, 40);
});

// ------------------------------------------------------------------ perf_get_gpu_events

test('perf_get_gpu_events enables, waits for distinct frames, averages, filters and restores', async () => {
  const f = await fixture();
  const replies = [gpuReply(null), gpuReply(frame(1)), gpuReply(frame(1)), gpuReply(frame(3))];
  const server = peer(f, (request, index) => {
    if (request.params.Restore) return gpuReply(null, { Restored: true, ProfilerEnabled: false, EnabledByBridge: false });
    return replies[index];
  });
  try {
    const args = PerfGetGpuEventsSchema.parse({ frames: 2, min_ms: 3, sort_by: 'time', max_events: 3 });
    const result = await handlePerfGetGpuEvents(args, f.ctx, fakeDeps());
    assert.equal(result.isError, undefined);
    assert.deepEqual(server.seen.map(r => r.method), Array(5).fill('perf.gpu_events'));
    assert.deepEqual(server.seen.slice(0, 4).map(r => r.params.Enable), [true, true, true, true]);
    assert.deepEqual(server.seen[4].params, { Restore: true, MaxEvents: 1 });
    const data = envelope(result).data;
    assert.equal(data.available, true);
    assert.equal(data.frames_sampled, 2, 'the repeated frame is not counted twice');
    assert.equal(data.total_gpu_ms, 20);
    assert.deepEqual(data.events.map((e: any) => [e.name, e.time_ms]), [['Frame', 20], ['GBuffer', 8], ['Lights', 6]]);
    assert.equal(data.matching_events, 4, 'Depth (2 ms) is below min_ms');
    assert.equal(data.truncated, true);
    assert.deepEqual(data.profiler, { was_enabled: false, enabled_by_tool: true, restored: true });
    assert.equal(data.gpu_adapter, 'AMD Radeon RX 7900 GRE');
    assert.equal(envelope(result).mode, 'editor-connected');
    assert.equal(JSON.stringify(data).includes(f.root), false);
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_get_gpu_events returns nulls, not an error, when headless', async () => {
  const f = await fixture();
  const server = peer(f, () => ({ ProfilerAvailable: false, Reason: 'headless', FrameCount: 5, HasData: false, Events: [], IsPlayMode: false, TimestampUnixMs: 1 }));
  try {
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({}), f.ctx, fakeDeps());
    assert.equal(result.isError, undefined);
    const data = envelope(result).data;
    assert.equal(data.available, false);
    assert.equal(data.reason, 'headless');
    assert.equal(data.total_gpu_ms, null);
    assert.equal(data.event_count, null);
    assert.deepEqual(data.events, []);
    assert.equal(data.gpu_adapter, null);
    assert.equal(server.seen.length, 1, 'nothing was enabled, so nothing is restored');
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_get_gpu_events reports no_data_yet after the timeout and still restores the profiler', async () => {
  const f = await fixture();
  const server = peer(f, request => request.params.Restore ? gpuReply(null, { Restored: true }) : gpuReply(null));
  try {
    const deps = fakeDeps();
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({ timeout_ms: 500 }), f.ctx, deps);
    const data = envelope(result).data;
    assert.equal(data.available, false);
    assert.equal(data.reason, 'no_data_yet');
    assert.equal(data.total_gpu_ms, null);
    assert.equal(data.profiler.restored, true);
    assert.equal(server.seen[server.seen.length - 1].params.Restore, true);
    assert.ok(deps.time >= 500);
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_get_gpu_events warns when fewer frames resolve than requested', async () => {
  const f = await fixture();
  const server = peer(f, request => request.params.Restore ? gpuReply(null, { Restored: true }) : gpuReply(frame(1)));
  try {
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({ frames: 3, timeout_ms: 500 }), f.ctx, fakeDeps());
    assert.equal(envelope(result).data.frames_sampled, 1);
    assert.ok((envelope(result).warnings as string[]).some(w => w.includes('1 of 3')));
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_get_gpu_events restores the profiler when a later call fails', async () => {
  const f = await fixture();
  const server = peer(f, (request, index) => {
    if (request.params.Restore) return gpuReply(null, { Restored: true });
    if (index === 0) return gpuReply(null);
    throw Object.assign(new Error('Editor main-thread call timed out.'), { code: 'DEADLINE_EXCEEDED' });
  });
  try {
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({}), f.ctx, fakeDeps());
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'TIMEOUT');
    assert.equal(server.seen[server.seen.length - 1].params.Restore, true);
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_get_gpu_events refuses an outdated editor bridge without contacting it', async () => {
  const f = await fixture(35);
  try {
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({}), f.ctx, fakeDeps());
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'UNSUPPORTED_FLAX_VERSION');
    assert.deepEqual(await fs.readdir(path.join(f.dir, 'requests')), []);
  } finally { await f.cleanup(); }
});

test('perf_get_gpu_events and perf_capture route to a game instance and report an old runtime bridge', async () => {
  const f = await fixture(36, 'g1');
  const server = peer(f, request => {
    if (request.method === 'perf.snapshot') return { Fps: 60, FrameTimeMs: 16, DrawCalls: 10, Triangles: 100, IsPlayMode: true };
    return request.params.Restore ? gpuReply(null, { Restored: true }) : gpuReply(frame(1), { IsPlayMode: true });
  });
  try {
    const gpu = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({ instance: 'g1' }), f.ctx, fakeDeps());
    assert.equal(gpu.isError, undefined);
    assert.equal(envelope(gpu).mode, 'game-connected');
    assert.equal(envelope(gpu).data.is_play_mode, true);
    const capture = await handlePerfCapture(PerfCaptureSchema.parse({ instance: 'g1', duration_s: 0.5, interval_ms: 250, include_gpu: true }), f.ctx, fakeDeps());
    assert.equal(capture.isError, undefined);
    assert.equal(envelope(capture).mode, 'game-connected');
    assert.equal(envelope(capture).data.capture.is_play_mode, true);
    assert.equal(envelope(capture).data.gpu.available, true);
    await assert.rejects(fs.access(path.join(f.root, 'Cache', 'MCP')), 'the editor bridge directory is never touched');
  } finally { await server.stop(); await f.cleanup(); }
  const old = await fixture(35, 'g2');
  const oldServer = peer(old, () => { throw Object.assign(new Error("Method 'perf.gpu_events' is not a runtime bridge method."), { code: 'METHOD_NOT_FOUND' }); });
  try {
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({ instance: 'g2' }), old.ctx, fakeDeps());
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await oldServer.stop(); await old.cleanup(); }
});

// ------------------------------------------------------------------ perf_capture

test('perf_capture samples the snapshot path and summarizes frame time, hitches, draw calls and triangles', async () => {
  const f = await fixture(36);
  const frameMs = [16, 16, 17, 16, 16, 16, 40, 16, 16, 16];
  let n = 0;
  const server = peer(f, request => {
    assert.equal(request.method, 'perf.snapshot');
    const i = n++;
    return { Fps: 60, FrameTimeMs: frameMs[i], DrawCalls: 100 * (i + 1), Triangles: 1000 * (i + 1), IsPlayMode: false, GpuAdapter: 'GPU', RendererType: 'Vulkan' };
  });
  try {
    const result = await handlePerfCapture(PerfCaptureSchema.parse({ duration_s: 1, interval_ms: 100 }), f.ctx, fakeDeps());
    assert.equal(result.isError, undefined);
    const data = envelope(result).data;
    assert.equal(data.capture.samples, 10);
    assert.equal(data.frame_ms.min, 16);
    assert.equal(data.frame_ms.median, 16);
    assert.equal(data.frame_ms.max, 40);
    assert.equal(data.frame_ms.p95, 40);
    assert.equal(data.hitches.count, 1);
    assert.equal(data.hitches.threshold_ms, 32);
    assert.equal(data.avg_fps, 60);
    assert.equal(data.draw_calls.max, 1000);
    assert.equal(data.draw_calls.avg, 550);
    assert.equal(data.triangles.max, 10000);
    assert.equal(data.gpu, undefined);
    assert.equal(data.capture.gpu_adapter, 'GPU');
    assert.equal(server.seen.length, 10, 'bounded by the sample count');
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_capture include_gpu aggregates passes and restores the profiler', async () => {
  const f = await fixture(36);
  let gpuCalls = 0;
  const server = peer(f, request => {
    if (request.method === 'perf.snapshot') return { Fps: 60, FrameTimeMs: 16, IsPlayMode: true };
    if (request.params.Restore) return gpuReply(null, { Restored: true });
    gpuCalls++;
    return gpuReply(frame(gpuCalls));
  });
  try {
    const result = await handlePerfCapture(PerfCaptureSchema.parse({ duration_s: 0.5, interval_ms: 100, include_gpu: true }), f.ctx, fakeDeps());
    const data = envelope(result).data;
    assert.equal(data.gpu.available, true);
    assert.equal(data.gpu.frames, 5);
    assert.equal(data.gpu.pass_depth, 1);
    assert.deepEqual(data.gpu.passes.map((p: any) => p.name), ['GBuffer', 'Lights', 'Post']);
    assert.equal(data.gpu.passes[0].avg_ms, 12);
    assert.equal(data.gpu.total_gpu_ms_avg, 30);
    assert.deepEqual(data.gpu.profiler, { was_enabled: false, enabled_by_tool: true, restored: true });
    assert.equal(server.seen[server.seen.length - 1].params.Restore, true);
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_capture include_gpu on a headless editor keeps the snapshot stats and reports why GPU is empty', async () => {
  const f = await fixture(36);
  const server = peer(f, request => request.method === 'perf.snapshot'
    ? { Fps: 30, FrameTimeMs: 33, DrawCalls: null, Triangles: null, IsPlayMode: false }
    : { ProfilerAvailable: false, Reason: 'headless', HasData: false, Events: [] });
  try {
    const result = await handlePerfCapture(PerfCaptureSchema.parse({ duration_s: 0.5, interval_ms: 100, include_gpu: true }), f.ctx, fakeDeps());
    const data = envelope(result).data;
    assert.equal(data.frame_ms.avg, 33);
    assert.equal(data.draw_calls.avg, null);
    assert.equal(data.draw_calls.max, null);
    assert.deepEqual([data.gpu.available, data.gpu.reason, data.gpu.total_gpu_ms_avg, data.gpu.passes], [false, 'headless', null, []]);
    assert.equal(server.seen.filter(r => r.method === 'perf.gpu_events').length, 1, 'stops asking after the first unavailable reply');
  } finally { await server.stop(); await f.cleanup(); }
});

test('perf_capture keeps partial data when the bridge fails mid-capture and errors when it never answers', async () => {
  const f = await fixture(36);
  const server = peer(f, (_request, index) => {
    if (index >= 3) throw Object.assign(new Error('Editor main-thread call timed out.'), { code: 'DEADLINE_EXCEEDED' });
    return { Fps: 60, FrameTimeMs: 16, IsPlayMode: false };
  });
  try {
    const result = await handlePerfCapture(PerfCaptureSchema.parse({ duration_s: 1, interval_ms: 100 }), f.ctx, fakeDeps());
    assert.equal(result.isError, undefined);
    assert.equal(envelope(result).data.capture.samples, 3);
    assert.ok((envelope(result).warnings as string[]).some(w => w.includes('Stopped after 3 samples')));
    assert.ok((envelope(result).warnings as string[]).some(w => w.includes('Fewer than 5')));
  } finally { await server.stop(); await f.cleanup(); }
  const g = await fixture(36);
  const failing = peer(g, () => { throw Object.assign(new Error('boom'), { code: 'DEADLINE_EXCEEDED' }); });
  try {
    const result = await handlePerfCapture(PerfCaptureSchema.parse({ duration_s: 0.5 }), g.ctx, fakeDeps());
    assert.equal(result.isError, true);
    assert.equal(envelope(result).error.code, 'TIMEOUT');
  } finally { await failing.stop(); await g.cleanup(); }
});

test('perf_capture needs only the v27 snapshot bridge when include_gpu is off', async () => {
  const f = await fixture(27);
  const server = peer(f, () => ({ Fps: 60, FrameTimeMs: 16, IsPlayMode: false }));
  try {
    const result = await handlePerfCapture(PerfCaptureSchema.parse({ duration_s: 0.5, interval_ms: 250 }), f.ctx, fakeDeps());
    assert.equal(result.isError, undefined);
    assert.equal(envelope(result).data.capture.samples, 2);
  } finally { await server.stop(); await f.cleanup(); }
  const g = await fixture(35);
  try {
    const result = await handlePerfGetGpuEvents(PerfGetGpuEventsSchema.parse({}), g.ctx, fakeDeps());
    assert.equal(envelope(result).error.code, 'UNSUPPORTED_FLAX_VERSION');
  } finally { await g.cleanup(); }
});
