import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { TestRunScenarioSchema, handleTestRunScenario } from './testScenario.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

interface Fixture {
  root: string;
  ctx: ProjectMeta;
  requests: string;
  responses: string;
  cleanup: () => Promise<void>;
}

// The default bridge is v6, the oldest one scenarios without steps run on; steps need v33.
async function fixture(bridgeVersion = 6): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-scenario-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  await fs.mkdir(requests, { recursive: true });
  await fs.mkdir(responses, { recursive: true });
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid, Project: root, Timestamp: Date.now(), BridgeVersion: bridgeVersion, ProtocolVersion: 1,
  }));
  await fs.writeFile(path.join(cache, 'token'), TOKEN);
  return { root, ctx: await createProjectContext(root), requests, responses, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function nextRequest(f: Fixture, previousName?: string): Promise<{ name: string; body: Record<string, unknown> }> {
  const end = Date.now() + 2_000;
  while (Date.now() < end) {
    const names = await fs.readdir(f.requests);
    const name = names.find(item => item.endsWith('.json') && item !== previousName);
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(f.requests, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for scenario bridge request.');
}

async function respond(f: Fixture, request: { name: string; body: Record<string, unknown> }, result: unknown): Promise<void> {
  const response = { id: request.body.id, token: TOKEN, ok: true, resultJson: JSON.stringify(result), timestamp: Date.now() };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

function envelopeData(result: Awaited<ReturnType<typeof handleTestRunScenario>>): Record<string, any> {
  return (result.structuredContent as Record<string, any>).data as Record<string, any>;
}

test('dry_run validates args and makes zero RPCs', async () => {
  const f = await fixture();
  try {
    const result = await handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'dry-smoke',
      run_seconds: 5,
      start: 'scenes',
      asserts: [{ type: 'no_errors' }],
      dry_run: true,
    }), f.ctx);
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.dryRun, true);
    assert.equal(envelope.data.scenario, 'dry-smoke');
    assert.ok(Array.isArray(envelope.data.plannedSteps));
    assert.ok(envelope.data.plannedSteps.includes('play_stop (always, even on failure/timeout)'));
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('pass path satisfies asserts and always stops play', async () => {
  const f = await fixture();
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'pass-smoke',
      run_seconds: 1,
      start: 'scenes',
      asserts: [{ type: 'no_errors' }],
    }), f.ctx);

    let request = await nextRequest(f);
    assert.equal(request.body.method, 'code.status');
    await respond(f, request, { Phase: 'succeeded', IsReady: true, IsCompiling: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, HasDirtyScenes: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.start_scenes');
    await respond(f, request, { IsPlayModeRequested: true, IsPlayMode: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-pass-1' });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-pass-1' });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'log.query');
    await respond(f, request, { Entries: [], NextSequence: 1, HasMore: false, DroppedCount: 0 });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.stop');
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    request = await nextRequest(f, request.name);
    assert.equal(request.body.method, 'play.status');
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    const data = envelopeData(result);
    assert.equal(data.scenario, 'pass-smoke');
    assert.equal(data.passed, true);
    assert.deepEqual(data.failures, []);
    assert.equal(data.session_id, 'scenario-pass-1');
    assert.equal(typeof data.duration, 'number');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('failing log_absent assert still calls play_stop and reports failure', async () => {
  const f = await fixture();
  const seenMethods: string[] = [];
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'fail-smoke',
      run_seconds: 1,
      start: 'scenes',
      asserts: [{ type: 'log_absent', query: 'boom' }],
    }), f.ctx);

    let request = await nextRequest(f);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { Phase: 'succeeded', IsReady: true, IsCompiling: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, HasDirtyScenes: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayModeRequested: true, IsPlayMode: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-fail-1' });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: true, IsPaused: false, SessionId: 'scenario-fail-1' });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    assert.equal(request.body.method, 'log.query');
    await respond(f, request, {
      Entries: [{ Sequence: 7, Severity: 'Error', Message: 'boom happened' }],
      NextSequence: 8, HasMore: false, DroppedCount: 0,
    });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    assert.equal(request.body.method, 'play.stop');
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    request = await nextRequest(f, request.name);
    seenMethods.push(String(request.body.method));
    await respond(f, request, { IsPlayMode: false, IsPaused: false });

    const result = await pending;
    const data = envelopeData(result);
    assert.equal(data.passed, false);
    assert.ok(data.failures.some((failure: string) => failure.includes('log_absent violated')));
    assert.ok(seenMethods.includes('play.stop'), 'play_stop must be attempted even when an assert fails');
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('invalid args rejected by zod', () => {
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: '' }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'x'.repeat(65) }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', run_seconds: 0 }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', run_seconds: 61 }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', start: 'editor' }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', asserts: [{ type: 'log_contains', query: '' }] }));
  assert.throws(() => TestRunScenarioSchema.parse({
    scenario_name: 'ok',
    asserts: Array.from({ length: 9 }, () => ({ type: 'no_errors' })),
  }));
  assert.throws(() => TestRunScenarioSchema.parse({ scenario_name: 'ok', asserts: [{ type: 'unknown' }] }));
});

// ── Scripted steps ──────────────────────────────────────────────────────────

const SCRIPT = 'b'.repeat(32);
const SESSION = 'scenario-steps-1';

interface Planned {
  method: string;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

interface Seen {
  method: string;
  params: Record<string, any>;
  at: number;
}

async function respondError(f: Fixture, request: { name: string; body: Record<string, unknown> }, error: NonNullable<Planned['error']>): Promise<void> {
  const response = {
    id: request.body.id, token: TOKEN, ok: false, errorCode: error.code, error: error.message,
    ...(error.details === undefined ? {} : { errorDetails: JSON.stringify(error.details) }),
    timestamp: Date.now(),
  };
  const target = path.join(f.responses, request.name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(response));
  await fs.rename(`${target}.tmp`, target);
}

/** Answers the next requests in order and records them; a request out of order fails the test. */
async function serve(f: Fixture, plan: Planned[]): Promise<Seen[]> {
  const seen: Seen[] = [];
  let previous: string | undefined;
  for (const planned of plan) {
    const request = await nextRequest(f, previous);
    previous = request.name;
    seen.push({ method: String(request.body.method), params: JSON.parse(String(request.body.paramsJson)), at: Date.now() });
    assert.equal(request.body.method, planned.method, `request ${seen.length} of the plan`);
    if (planned.error) await respondError(f, request, planned.error);
    else await respond(f, request, planned.result);
  }
  return seen;
}

const RUNNING = { IsPlayMode: true, IsPaused: false, SessionId: SESSION };
/** The requests every real run sends before its timeline starts; the last one confirms play is running. */
const START: Planned[] = [
  { method: 'code.status', result: { Phase: 'succeeded', IsReady: true, IsCompiling: false } },
  { method: 'play.status', result: { IsPlayMode: false, IsPaused: false, IsPlayModeRequested: false, HasDirtyScenes: false } },
  { method: 'play.start_scenes', result: { IsPlayModeRequested: true, IsPlayMode: false } },
  { method: 'play.status', result: RUNNING },
  { method: 'play.status', result: RUNNING },
];
/** The requests every real run ends with, whatever happened before. */
const STOP: Planned[] = [
  { method: 'play.stop', result: { IsPlayMode: false, IsPaused: false } },
  { method: 'play.status', result: { IsPlayMode: false, IsPaused: false } },
];
const NO_LOG_ENTRIES = { Entries: [], NextSequence: 1, HasMore: false, DroppedCount: 0 };

const invoked = (result: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ ScriptId: SCRIPT, Invoked: true, Threw: false, PlaySessionId: SESSION, Result: result, ...extra });

test('without steps the parsed arguments, the report, and the changes keep their previous shape', async () => {
  assert.deepEqual(TestRunScenarioSchema.parse({ scenario_name: 'plain' }), {
    scenario_name: 'plain', run_seconds: 5, start: 'scenes', allow_failed_compile: false, asserts: [], steps: [], dry_run: false,
  });

  const f = await fixture();
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'plain', run_seconds: 1 }), f.ctx);
    const seen = await serve(f, [...START, ...STOP]);
    assert.deepEqual(seen.map(request => request.params), [{}, {}, { AllowDirtyScenes: false, AllowCompileFailure: false }, {}, {}, {}, {}]);
    const result = await pending;
    assert.deepEqual(Object.keys(envelopeData(result)), ['scenario', 'passed', 'failures', 'duration', 'session_id']);
    assert.deepEqual((result.structuredContent as Record<string, any>).changes, [{ kind: 'test.scenario.completed', scenario: 'plain', passed: true }]);
    assert.equal(envelopeData(result).passed, true);
  } finally { await f.cleanup(); }
});

test('the mid-run viewport capture still happens once at the midpoint of the wait', async () => {
  const f = await fixture();
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'capture-only', run_seconds: 1, asserts: [{ type: 'viewport_captured' }],
    }), f.ctx);
    const seen = await serve(f, [
      ...START,
      { method: 'capture.start', result: { CaptureId: 'cap-1' } },
      { method: 'capture.status', result: { Phase: 'completed', SizeBytes: 12 } },
      ...STOP,
    ]);
    const runStart = seen[4].at;
    assert.deepEqual(seen[5].params, { Viewport: 'game' });
    assert.ok(seen[5].at - runStart >= 450, `capture came ${seen[5].at - runStart} ms into a 1000 ms run`);
    // The second half of the wait runs after the capture, so the run is not cut short.
    assert.ok(seen[7].at - seen[6].at >= 450, `stop came ${seen[7].at - seen[6].at} ms after the capture finished`);
    const data = envelopeData(await pending);
    assert.equal(data.passed, true);
    assert.equal('steps' in data, false);
  } finally { await f.cleanup(); }
});

test('steps run at their stated times in time order, send the runtime tool requests, and are reported', async () => {
  const f = await fixture(33);
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-pass',
      run_seconds: 1,
      asserts: [{ type: 'no_errors' }],
      steps: [
        { type: 'invoke_script_method', at_seconds: 0.9, script_id: SCRIPT, method: 'Jump', args: [2, true, 'high'], expect: { returned: 4 } },
        { type: 'set_script_value', at_seconds: 0.1, script_id: SCRIPT, member: 'MoveInput', value: '1,0' },
        { type: 'set_script_value', at_seconds: 0.5, script_id: SCRIPT, member: 'MoveInput', value: '0,0' },
      ],
    }), f.ctx);
    const setResult = {
      ScriptId: SCRIPT, Member: 'MoveInput', Type: 'FlaxEngine.Vector2', PlaySessionId: SESSION,
      Before: { Kind: 'vector2', Vector2: { X: 0, Y: 0 } }, After: { Kind: 'vector2', Vector2: { X: 1, Y: 0 } },
      Warnings: ['Runtime write: no undo was recorded and the value is discarded when play stops.'],
    };
    const seen = await serve(f, [
      ...START,
      { method: 'runtime.set_script_value', result: setResult },
      { method: 'runtime.set_script_value', result: setResult },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'integer', Integer: 4 }, { Method: 'Jump', ReturnType: 'int' }) },
      { method: 'log.query', result: NO_LOG_ENTRIES },
      ...STOP,
    ]);

    // The invoke step (0.9 s) was listed first but runs last; the exact tool request shapes are the tools' own.
    assert.deepEqual(seen[5].params, { ScriptId: SCRIPT, Member: 'MoveInput', Text: '1,0' });
    assert.deepEqual(seen[6].params, { ScriptId: SCRIPT, Member: 'MoveInput', Text: '0,0' });
    assert.deepEqual(seen[7].params, { ScriptId: SCRIPT, Method: 'Jump', Args: [{ Number: 2 }, { Bool: true }, { Text: 'high' }] });
    const runStart = seen[4].at;
    assert.ok(seen[5].at - runStart >= 50, `first step ran ${seen[5].at - runStart} ms into the run`);
    assert.ok(seen[6].at - runStart >= 450, `second step ran ${seen[6].at - runStart} ms into the run`);
    assert.ok(seen[7].at - runStart >= 850, `third step ran ${seen[7].at - runStart} ms into the run`);
    // The wait after the last step is what remains of run_seconds, not a fresh full wait.
    assert.ok(seen[8].at - runStart >= 950 && seen[8].at - runStart < 1800, `assertions started ${seen[8].at - runStart} ms into a 1000 ms run`);

    const result = await pending;
    const envelope = result.structuredContent as Record<string, any>;
    const data = envelopeData(result);
    assert.equal(envelope.ok, true);
    assert.equal(data.passed, true);
    assert.deepEqual(data.failures, []);
    assert.equal(data.session_id, SESSION);
    const setReport = (index: number, atSeconds: number) => ({
      index, type: 'set_script_value', at_seconds: atSeconds, script_id: SCRIPT, ok: true,
      member: 'MoveInput', before: setResult.Before, after: setResult.After,
    });
    assert.deepEqual(data.steps, [
      setReport(1, 0.1),
      setReport(2, 0.5),
      {
        index: 0, type: 'invoke_script_method', at_seconds: 0.9, script_id: SCRIPT, ok: true,
        method: 'Jump', invoked: true, threw: false, result: { Kind: 'integer', Integer: 4 },
      },
    ]);
    // The writes the steps made are reported, and so is the bridge's own note once, not once per step.
    assert.deepEqual(envelope.changes, [
      { kind: 'runtime.script_value_set', id: SCRIPT, member: 'MoveInput' },
      { kind: 'runtime.script_value_set', id: SCRIPT, member: 'MoveInput' },
      { kind: 'runtime.script_method_invoked', id: SCRIPT, method: 'Jump' },
      { kind: 'test.scenario.completed', scenario: 'steps-pass', passed: true },
    ]);
    assert.deepEqual(envelope.warnings, setResult.Warnings);
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('steps at the same time keep their listed order and run before the mid-run capture', async () => {
  const f = await fixture(33);
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-order',
      run_seconds: 1,
      asserts: [{ type: 'viewport_captured' }],
      steps: [
        { type: 'invoke_script_method', at_seconds: 0.5, script_id: SCRIPT, method: 'Second' },
        { type: 'set_script_value', at_seconds: 0.2, script_id: SCRIPT, member: 'Early', value: true },
        { type: 'set_script_value', at_seconds: 0.5, script_id: SCRIPT, member: 'Third', value: 3 },
      ],
    }), f.ctx);
    const setOk = (member: string) => ({ ScriptId: SCRIPT, Member: member, PlaySessionId: SESSION });
    const seen = await serve(f, [
      ...START,
      { method: 'runtime.set_script_value', result: setOk('Early') },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'void' }) },
      { method: 'runtime.set_script_value', result: setOk('Third') },
      { method: 'capture.start', result: { CaptureId: 'cap-2' } },
      { method: 'capture.status', result: { Phase: 'completed' } },
      ...STOP,
    ]);
    assert.deepEqual(seen.slice(5, 9).map(request => request.params.Member ?? request.params.Method ?? request.params.Viewport), ['Early', 'Second', 'Third', 'game']);
    assert.ok(seen[10].at - seen[9].at >= 450, 'the wait after the capture is not shortened by the steps');
    const data = envelopeData(await pending);
    assert.equal(data.passed, true);
    assert.deepEqual(data.steps.map((step: any) => step.index), [1, 0, 2]);
  } finally { await f.cleanup(); }
});

test('invocation expectations fail the scenario like a failed assertion, and play still stops', async () => {
  const f = await fixture(33);
  try {
    const at = (index: number) => Number((index * 0.02).toFixed(2));
    const step = (index: number, method: string, expect?: Record<string, unknown>) => ({
      type: 'invoke_script_method', at_seconds: at(index), script_id: SCRIPT, method, ...(expect ? { expect } : {}),
    });
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-expect',
      run_seconds: 1,
      steps: [
        step(0, 'IsAlive', { returned: true }),
        step(1, 'Score', { returned: 10 }),
        step(2, 'Explode', { threw: true }),
        step(3, 'Crash'),
        step(4, 'Calm', { threw: true }),
        step(5, 'Speed', { returned: 0.1 }),
        step(6, 'Pos', { returned: '1,2,3' }),
        step(7, 'Name', { returned: 'Hero' }),
        step(8, 'Mode', { returned: 'Fast' }),
        step(9, 'Lives', { returned: 3.5 }),
      ],
    }), f.ctx);
    const threw = { Invoked: true, Threw: true, PlaySessionId: SESSION, ExceptionType: 'System.InvalidOperationException', ExceptionMessage: 'bad state' };
    const seen = await serve(f, [
      ...START,
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'boolean', Boolean: true }) },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'integer', Integer: 3 }) },
      { method: 'runtime.invoke_script_method', result: threw },
      { method: 'runtime.invoke_script_method', result: threw },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'void' }) },
      // A float result reaches the bridge as a 32-bit value: 0.1f is 0.10000000149011612.
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'number', Number: 0.10000000149011612 }) },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'vector3', Vector3: { X: 1, Y: 2, Z: 3 } }) },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'string', Text: 'Hero' }) },
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'enum', Text: 'Fast', Integer: 2 }) },
      // An integer result is compared exactly, never rounded to the expectation.
      { method: 'runtime.invoke_script_method', result: invoked({ Kind: 'integer', Integer: 3 }) },
      ...STOP,
    ]);
    assert.equal(seen.filter(request => request.method === 'play.stop').length, 1);

    const data = envelopeData(await pending);
    assert.equal(data.passed, false);
    assert.deepEqual(data.failures, [
      'steps[1] (invoke_script_method Score at 0.02s) expected result 10 but got integer 3',
      'steps[3] (invoke_script_method Crash at 0.06s) threw System.InvalidOperationException: bad state',
      'steps[4] (invoke_script_method Calm at 0.08s) was expected to throw but returned normally',
      'steps[6] (invoke_script_method Pos at 0.12s) expected result "1,2,3" but got vector3 (only boolean, integer, number, string, enum, actor, script, and asset results can be compared)',
      'steps[9] (invoke_script_method Lives at 0.18s) expected result 3.5 but got integer 3',
    ]);
    assert.deepEqual(data.steps.map((entry: any) => entry.ok), [true, false, true, false, false, true, false, true, true, false]);
    assert.equal(data.steps[2].threw, true);
    assert.equal(data.steps[2].exception_type, 'System.InvalidOperationException');
    assert.equal(data.steps[3].exception_message, 'bad state');
  } finally { await f.cleanup(); }
});

test('a failed step call is reported and later steps still run, unless the run cannot continue', async () => {
  const f = await fixture(33);
  try {
    // A refused call (here: no such method) does not stop the remaining steps.
    let pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-refused',
      run_seconds: 1,
      steps: [
        { type: 'invoke_script_method', at_seconds: 0, script_id: SCRIPT, method: 'Missing' },
        { type: 'set_script_value', at_seconds: 0.1, script_id: SCRIPT, member: 'Speed', value: 2 },
      ],
    }), f.ctx);
    await serve(f, [
      ...START,
      { method: 'runtime.invoke_script_method', error: { code: 'VALIDATION_FAILED', message: "Public instance method 'Missing' was not found." } },
      { method: 'runtime.set_script_value', result: { ScriptId: SCRIPT, Member: 'Speed', PlaySessionId: SESSION } },
      ...STOP,
    ]);
    let data = envelopeData(await pending);
    assert.equal(data.passed, false);
    assert.deepEqual(data.failures, ["steps[0] (invoke_script_method Missing at 0s) failed: VALIDATION_FAILED: Public instance method 'Missing' was not found."]);
    assert.deepEqual(data.steps.map((entry: any) => entry.ok), [false, true]);
    assert.deepEqual(data.steps[0].error, { code: 'VALIDATION_FAILED', message: "Public instance method 'Missing' was not found." });

    // Play no longer running: the later step is not sent, the wait is not slept out, assertions and stop still happen.
    const startedAt = Date.now();
    pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-fatal',
      run_seconds: 10,
      asserts: [{ type: 'no_errors' }],
      steps: [
        { type: 'set_script_value', at_seconds: 0.1, script_id: SCRIPT, member: 'Speed', value: 2 },
        { type: 'invoke_script_method', at_seconds: 0.2, script_id: SCRIPT, method: 'Jump' },
        { type: 'invoke_script_method', at_seconds: 0.3, script_id: SCRIPT, method: 'Land' },
      ],
    }), f.ctx);
    const seen = await serve(f, [
      ...START,
      { method: 'runtime.set_script_value', error: { code: 'INVALID_STATE', message: 'runtime.set_script_value requires play mode.' } },
      { method: 'log.query', result: NO_LOG_ENTRIES },
      ...STOP,
    ]);
    assert.equal(seen.some(request => request.method === 'runtime.invoke_script_method'), false);
    data = envelopeData(await pending);
    assert.ok(Date.now() - startedAt < 5_000, 'the 10 second wait was skipped');
    assert.equal(data.passed, false);
    assert.deepEqual(data.failures, [
      'steps[0] (set_script_value Speed at 0.1s) failed: INVALID_PLAY_STATE: runtime.set_script_value requires play mode.',
      '2 later step(s) not run: the bridge or the play session is no longer usable',
    ]);
    assert.deepEqual(data.steps.map((entry: any) => [entry.index, entry.ok, entry.skipped === true]), [[0, false, false], [1, false, true], [2, false, true]]);
    assert.deepEqual(await fs.readdir(f.requests), []);
  } finally { await f.cleanup(); }
});

test('stopping the scripted run early also skips the pending capture and reports it', async () => {
  const f = await fixture(33);
  try {
    const startedAt = Date.now();
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-fatal-capture',
      run_seconds: 30,
      asserts: [{ type: 'viewport_captured' }],
      steps: [{ type: 'invoke_script_method', at_seconds: 0.1, script_id: SCRIPT, method: 'Jump' }],
    }), f.ctx);
    // The error text mentions the viewport; that must not hide the missing capture.
    await serve(f, [
      ...START,
      { method: 'runtime.invoke_script_method', error: { code: 'INVALID_STATE', message: 'The viewport is gone: play mode ended.' } },
      ...STOP,
    ]);
    const data = envelopeData(await pending);
    assert.ok(Date.now() - startedAt < 10_000, 'the rest of the 30 second run was not slept out');
    assert.deepEqual(data.failures, [
      'steps[0] (invoke_script_method Jump at 0.1s) failed: INVALID_PLAY_STATE: The viewport is gone: play mode ended.',
      'viewport_captured violated: no successful viewport capture during run',
    ]);
  } finally { await f.cleanup(); }
});

test('a step that ran in a different play session fails the scenario', async () => {
  const f = await fixture(33);
  try {
    const pending = handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'steps-session',
      run_seconds: 1,
      steps: [{ type: 'set_script_value', at_seconds: 0, script_id: SCRIPT, member: 'Speed', value: 2 }],
    }), f.ctx);
    await serve(f, [
      ...START,
      { method: 'runtime.set_script_value', result: { ScriptId: SCRIPT, Member: 'Speed', PlaySessionId: 'someone-elses-session' } },
      ...STOP,
    ]);
    const data = envelopeData(await pending);
    assert.equal(data.passed, false);
    assert.deepEqual(data.failures, [`steps[0] (set_script_value Speed at 0s) ran in play session someone-elses-session, not this scenario's session ${SESSION}`]);
  } finally { await f.cleanup(); }
});

test('steps are refused before any request when the bridge is older than v33', async () => {
  const f = await fixture(32);
  try {
    const steps = [{ type: 'set_script_value', at_seconds: 0, script_id: SCRIPT, member: 'Speed', value: 2 }];
    for (const dryRun of [false, true]) {
      const result = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'old-bridge', run_seconds: 1, steps, dry_run: dryRun }), f.ctx);
      assert.equal(result.isError, true);
      const error = (result.structuredContent as Record<string, any>).error;
      assert.equal(error.code, 'UNSUPPORTED_FLAX_VERSION');
      assert.match(error.message, /bridge v33 or newer/);
      assert.match(error.message, /v32/);
      assert.equal(error.details.minimumBridgeVersion, 33);
      // Nothing was started, so there is nothing to stop.
      assert.deepEqual(await fs.readdir(f.requests), []);
    }

    // The same old bridge still runs a scenario without steps: dry-run needs no request at all.
    const plain = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'old-bridge-plain', dry_run: true }), f.ctx);
    assert.equal(plain.isError, undefined);
  } finally { await f.cleanup(); }
});

test('a missing bridge heartbeat is not mistaken for an old bridge', async () => {
  const f = await fixture(33);
  try {
    await fs.rm(path.join(f.root, 'Cache', 'MCP', 'bridge.json'));
    const result = await handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'no-heartbeat',
      run_seconds: 1,
      steps: [{ type: 'set_script_value', at_seconds: 0, script_id: SCRIPT, member: 'Speed', value: 2 }],
    }), f.ctx);
    // The scenario ran and reported the failed start; it was not refused as UNSUPPORTED_FLAX_VERSION.
    assert.equal(result.isError, undefined);
    const data = envelopeData(result);
    assert.equal(data.passed, false);
    assert.match(data.failures[0], /^start failed: EDITOR_NOT_CONNECTED/);
  } finally { await f.cleanup(); }
});

test('steps respect the permission policy of the runtime tools they stand for', async () => {
  const f = await fixture(33);
  try {
    f.ctx.permissionPolicy = { profile: 'full', allowTools: [], denyTools: ['runtime_invoke_script_method'], emergencyReadOnly: false };
    const invokeStep = { type: 'invoke_script_method', at_seconds: 0, script_id: SCRIPT, method: 'Jump' };
    const setStep = { type: 'set_script_value', at_seconds: 0, script_id: SCRIPT, member: 'Speed', value: 2 };
    for (const dryRun of [false, true]) {
      const result = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'denied', run_seconds: 1, steps: [setStep, invokeStep], dry_run: dryRun }), f.ctx);
      assert.equal(result.isError, true);
      const error = (result.structuredContent as Record<string, any>).error;
      assert.equal(error.code, 'PERMISSION_DENIED');
      assert.match(error.message, /runtime_invoke_script_method/);
      assert.deepEqual(await fs.readdir(f.requests), []);
    }
    // Only the steps actually used are checked.
    const allowed = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'set-only', run_seconds: 1, steps: [setStep], dry_run: true }), f.ctx);
    assert.equal(allowed.isError, undefined);

    f.ctx.permissionPolicy = { profile: 'full', allowTools: [], denyTools: ['runtime_set_script_value'], emergencyReadOnly: false };
    const setDenied = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'denied-set', run_seconds: 1, steps: [setStep], dry_run: true }), f.ctx);
    assert.equal((setDenied.structuredContent as Record<string, any>).error.code, 'PERMISSION_DENIED');

    // Without steps the policy for those tools is irrelevant.
    const plain = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'no-steps', dry_run: true }), f.ctx);
    assert.equal(plain.isError, undefined);
  } finally { await f.cleanup(); }
});

test('dry_run with steps lists them in time order, previews them, and makes zero RPCs', async () => {
  const f = await fixture(33);
  try {
    const result = await handleTestRunScenario(TestRunScenarioSchema.parse({
      scenario_name: 'dry-steps',
      run_seconds: 4,
      asserts: [{ type: 'viewport_captured' }],
      steps: [
        { type: 'invoke_script_method', at_seconds: 3, script_id: SCRIPT, method: 'Jump', args: [1.5, 'x'], expect: { returned: 'ok' } },
        { type: 'set_script_value', at_seconds: 1, script_id: SCRIPT, member: 'Speed', value: 2 },
      ],
      dry_run: true,
    }), f.ctx);
    const envelope = result.structuredContent as Record<string, any>;
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.plannedSteps, [
      'play_start_scenes',
      'play_get_status (confirm running)',
      'wait 4s',
      `at 1s: runtime_set_script_value (Speed = 2 on script ${SCRIPT})`,
      `at 3s: runtime_invoke_script_method (Jump(1.5, "x") on script ${SCRIPT}, expecting returned="ok")`,
      'viewport_capture (game, once mid-run)',
      'play_stop (always, even on failure/timeout)',
    ]);
    assert.equal(envelope.data.preview.steps.length, 2);
    assert.deepEqual(envelope.changes, []);
    assert.deepEqual(await fs.readdir(f.requests), []);

    // A dry-run without steps previews exactly what it always did.
    const plain = await handleTestRunScenario(TestRunScenarioSchema.parse({ scenario_name: 'dry-plain', dry_run: true }), f.ctx);
    assert.deepEqual(Object.keys((plain.structuredContent as Record<string, any>).data.preview), ['start', 'run_seconds', 'allow_failed_compile', 'asserts']);
  } finally { await f.cleanup(); }
});

test('step arguments are validated with the limits of the runtime tools', () => {
  const step = { type: 'invoke_script_method', at_seconds: 1, script_id: SCRIPT, method: 'Jump' };
  const set = { type: 'set_script_value', at_seconds: 1, script_id: SCRIPT, member: 'Speed', value: 2 };
  const parse = (extra: Record<string, unknown>) => TestRunScenarioSchema.safeParse({ scenario_name: 'ok', run_seconds: 5, ...extra });

  assert.equal(parse({ steps: [step, set] }).success, true);
  assert.equal(parse({ steps: [{ ...step, args: [1, true, 'a', 4], expect: { threw: false } }] }).success, true);
  assert.equal(parse({ steps: [{ ...set, member: 'Player.Speed' }] }).success, true);
  // A step may run at the very end of the run but not after it.
  assert.equal(parse({ steps: [{ ...step, at_seconds: 5 }] }).success, true);
  const late = parse({ steps: [step, { ...step, at_seconds: 5.5 }] });
  assert.equal(late.success, false);
  assert.deepEqual(late.success ? [] : late.error.issues.map(issue => issue.path), [['steps', 1, 'at_seconds']]);
  assert.equal(parse({ steps: [{ ...step, at_seconds: -1 }] }).success, false);
  assert.equal(parse({ run_seconds: 60, steps: [{ ...step, at_seconds: 60 }] }).success, true);

  assert.equal(parse({ steps: [{ ...step, script_id: 'nope' }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, method: 'get-Value' }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, args: [1, 2, 3, 4, 5] }] }).success, false);
  assert.equal(parse({ steps: [{ ...set, member: 'A.B.C' }] }).success, false);
  assert.equal(parse({ steps: [{ ...set, value: null }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, type: 'press_key' }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, at_seconds: undefined }] }).success, false);

  // Typos are errors, not silently dropped: a dropped expectation would pass a scenario it should fail.
  assert.equal(parse({ steps: [{ ...step, arg: [1] }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, expect: { throws: true } }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, expect: { threw: true, returned: 1 } }] }).success, false);
  assert.equal(parse({ steps: [{ ...step, expect: { returned: null } }] }).success, false);
  assert.equal(parse({ steps: [{ ...set, expect: { returned: 1 } }] }).success, false);
  assert.equal(parse({ bogus: 1 }).success, false);

  const sixteen = Array.from({ length: 16 }, () => step);
  assert.equal(parse({ steps: sixteen }).success, true);
  assert.equal(parse({ steps: [...sixteen, step] }).success, false);
});

test('the registered tool publishes steps and stays strict', async () => {
  const f = await fixture(33);
  try {
    const { buildToolRegistry } = await import('./index.js');
    const tool = buildToolRegistry(f.ctx).find(entry => entry.name === 'test_run_scenario');
    assert.ok(tool);
    const schema = tool.inputSchema as Record<string, any>;
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.properties.steps, 'steps must be in the published input schema');
    assert.equal(schema.properties.steps.maxItems, 16);
    assert.match(tool.description, /steps/);
    assert.match(tool.description, /v33/);
    // Validation goes through the registry's parser, including the cross-field rule.
    assert.equal(tool.zodInputSchema.safeParse({ scenario_name: 'x', bogus: true }).success, false);
    assert.equal(tool.zodInputSchema.safeParse({
      scenario_name: 'x', run_seconds: 2, steps: [{ type: 'set_script_value', at_seconds: 3, script_id: SCRIPT, member: 'A', value: 1 }],
    }).success, false);
  } finally { await f.cleanup(); }
});
