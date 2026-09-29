import { z } from 'zod';
import { toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';
import {
  handlePlayGetStatus,
  handlePlayStartGame,
  handlePlayStartScenes,
  handlePlayStop,
} from './runtimeLive.js';
import {
  handleLogGetRuntimeErrors,
  handleLogSearch,
  handleViewportCapture,
} from './liveObservability.js';

const LogSeverity = z.enum(['trace', 'debug', 'info', 'warning', 'error', 'fatal']);

const AssertLogContainsSchema = z.object({
  type: z.literal('log_contains'),
  query: z.string().min(1).max(256),
  severities: z.array(LogSeverity).max(6).optional(),
});

const AssertLogAbsentSchema = z.object({
  type: z.literal('log_absent'),
  query: z.string().min(1).max(256),
  severities: z.array(LogSeverity).max(6).optional(),
});

const AssertNoErrorsSchema = z.object({
  type: z.literal('no_errors'),
});

const AssertViewportSchema = z.object({
  type: z.literal('viewport_captured'),
});

const ScenarioAssertSchema = z.discriminatedUnion('type', [
  AssertLogContainsSchema,
  AssertLogAbsentSchema,
  AssertNoErrorsSchema,
  AssertViewportSchema,
]);

export type ScenarioAssert = z.infer<typeof ScenarioAssertSchema>;

export const TestRunScenarioSchema = z.object({
  scenario_name: z.string().min(1).max(64),
  run_seconds: z.number().min(1).max(60).optional().default(5),
  start: z.enum(['scenes', 'game']).optional().default('scenes'),
  allow_failed_compile: z.boolean().optional().default(false),
  asserts: z.array(ScenarioAssertSchema).max(8).optional().default([]),
  dry_run: z.boolean().optional().default(false),
});

export type TestRunScenarioArgs = z.infer<typeof TestRunScenarioSchema>;

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function sessionIdOf(value: unknown): string | null {
  const row = asRow(value);
  for (const key of ['SessionId', 'sessionId', 'PlaySessionId', 'playSessionId']) {
    if (typeof row[key] === 'string' && (row[key] as string).length > 0) return row[key] as string;
  }
  return null;
}

function extractSessionId(data: unknown): string | null {
  const row = asRow(data);
  // Direct shape (play.status bridge payload).
  const direct = sessionIdOf(data);
  if (direct) return direct;
  // handlePlayStartScenes/Game envelope data: { result, state, bridge }.
  const fromState = sessionIdOf(row.state);
  if (fromState) return fromState;
  const fromResult = sessionIdOf(row.result);
  if (fromResult) return fromResult;
  return null;
}

function playStateOf(value: unknown): string {
  const row = asRow(value);
  for (const key of ['Phase', 'phase']) {
    if (typeof row[key] === 'string') {
      const phase = (row[key] as string).toLowerCase();
      if (phase) return phase;
    }
  }
  for (const key of ['State', 'state', 'Status', 'status']) {
    if (typeof row[key] === 'string') {
      const display = (row[key] as string).toLowerCase();
      if (display === 'starting' || display === 'stopping') return display;
      if (display === 'running' || display === 'paused' || display === 'stopped') return display;
    }
  }
  if (row.IsPlayMode === true || row.isPlayMode === true) {
    return row.IsPaused === true || row.isPaused === true ? 'paused' : 'running';
  }
  if (row.IsPlayModeRequested === true || row.isPlayModeRequested === true) return 'starting';
  if ('IsPlayMode' in row || 'isPlayMode' in row || 'IsPlayModeRequested' in row || 'isPlayModeRequested' in row) {
    return 'stopped';
  }
  return 'unknown';
}

function envelopeOf(response: ToolResponse): { ok: boolean; data?: unknown; error?: { code?: string; message?: string }; warnings: string[] } {
  const envelope = response.structuredContent as Row | undefined;
  return {
    ok: envelope?.ok === true && !response.isError,
    data: (envelope as Row | undefined)?.data,
    error: asRow((envelope as Row | undefined)?.error) as { code?: string; message?: string },
    warnings: Array.isArray((envelope as Row | undefined)?.warnings) ? ((envelope as unknown as { warnings: string[] }).warnings ?? []) : [],
  };
}

function errorText(env: { error?: { code?: string; message?: string } }, fallback: string): string {
  if (env.error?.code || env.error?.message) {
    return `${env.error?.code ?? 'ERROR'}: ${env.error?.message ?? fallback}`;
  }
  return fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function success(data: unknown, bridge: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings, changes });
}

export async function handleTestRunScenario(args: TestRunScenarioArgs, ctx: ProjectMeta): Promise<ToolResponse> {
  const needsViewport = args.asserts.some(assert => assert.type === 'viewport_captured');

  if (args.dry_run) {
    const plannedSteps = [
      args.start === 'game' ? 'play_start_game' : 'play_start_scenes',
      'play_get_status (confirm running)',
      `wait ${args.run_seconds}s`,
      ...(needsViewport ? ['viewport_capture (game, once mid-run)'] : []),
      ...args.asserts
        .filter(assert => assert.type !== 'viewport_captured')
        .map(assert => {
          if (assert.type === 'no_errors') return 'log_get_runtime_errors (session-scoped)';
          return `log_search (${assert.type}: "${assert.query}")`;
        }),
      'play_stop (always, even on failure/timeout)',
    ];
    const data = {
      dryRun: true,
      scenario: args.scenario_name,
      plannedSteps,
      preview: {
        start: args.start,
        run_seconds: args.run_seconds,
        allow_failed_compile: args.allow_failed_compile,
        asserts: args.asserts,
      },
    };
    return success(data, undefined, ['Dry-run validated arguments and did not start or stop simulation.']);
  }

  const startedAt = Date.now();
  const failures: string[] = [];
  const warnings: string[] = [];
  let bridge: unknown;
  let sessionId: string | null = null;
  let viewportOk = false;

  try {
    const startArgs = {
      wait: true,
      timeout_ms: 30_000,
      dry_run: false,
      allow_dirty: false,
      allow_failed_compile: args.allow_failed_compile,
    };
    const startResponse = args.start === 'game'
      ? await handlePlayStartGame(startArgs, ctx)
      : await handlePlayStartScenes(startArgs, ctx);
    const startEnv = envelopeOf(startResponse);
    if (!startEnv.ok) {
      failures.push(`start failed: ${errorText(startEnv, 'play start failed')}`);
    } else {
      const dataRow = asRow(startEnv.data);
      sessionId = extractSessionId(dataRow.state) ?? extractSessionId(dataRow.result) ?? null;
      const bridgeRow = asRow(dataRow.bridge);
      if (Object.keys(bridgeRow).length > 0) bridge = dataRow.bridge;
      warnings.push(...startEnv.warnings);

      try {
        const statusResponse = await handlePlayGetStatus({}, ctx);
        const statusEnv = envelopeOf(statusResponse);
        if (!statusEnv.ok) {
          failures.push(`status check failed: ${errorText(statusEnv, 'play_get_status failed')}`);
        } else {
          const statusData = asRow(statusEnv.data);
          const result = statusData.result !== undefined ? statusData.result : statusEnv.data;
          const sid = extractSessionId(result);
          if (sid) sessionId = sid;
          if (asRow(statusData.bridge).connected !== undefined || typeof statusData.bridge === 'object') {
            bridge = statusData.bridge ?? bridge;
          }
          warnings.push(...statusEnv.warnings);
          const state = playStateOf(result);
          if (state !== 'running' && state !== 'paused') {
            failures.push(`play did not reach running state (state=${state})`);
          }
        }
      } catch (error) {
        failures.push(`status check threw: ${error instanceof Error ? error.message : String(error)}`);
      }

      const totalMs = Math.round(args.run_seconds * 1000);
      if (needsViewport) {
        await sleep(Math.floor(totalMs / 2));
        try {
          const captureResponse = await handleViewportCapture({ viewport: 'game', timeout_ms: 10_000, poll_interval_ms: 100 }, ctx);
          const captureEnv = envelopeOf(captureResponse);
          if (!captureEnv.ok) {
            failures.push(`viewport_captured failed: ${errorText(captureEnv, 'viewport capture failed')}`);
          } else {
            viewportOk = true;
            warnings.push(...captureEnv.warnings);
          }
        } catch (error) {
          failures.push(`viewport_captured threw: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(totalMs - Math.floor(totalMs / 2));
      } else {
        await sleep(totalMs);
      }

      for (const assert of args.asserts) {
        try {
          if (assert.type === 'viewport_captured') {
            if (!viewportOk && !failures.some(failure => failure.includes('viewport'))) {
              failures.push('viewport_captured violated: no successful viewport capture during run');
            }
          } else if (assert.type === 'no_errors') {
            const logResponse = await handleLogGetRuntimeErrors(
              { since_sequence: 0, play_session_id: sessionId ?? undefined, limit: 100, max_scan: 1000 },
              ctx,
            );
            const logEnv = envelopeOf(logResponse);
            if (!logEnv.ok) {
              failures.push(`no_errors check failed: ${errorText(logEnv, 'log_get_runtime_errors failed')}`);
            } else {
              const errors = asRow(logEnv.data).errors;
              const list = Array.isArray(errors) ? errors : [];
              if (list.length > 0) {
                failures.push(`no_errors violated: ${list.length} error(s) in session logs`);
              }
              warnings.push(...logEnv.warnings);
            }
          } else if (assert.type === 'log_contains') {
            const logResponse = await handleLogSearch(
              {
                since_sequence: 0,
                severities: assert.severities,
                play_session_id: sessionId ?? undefined,
                query: assert.query,
                match: 'substring',
                case_sensitive: false,
                limit: 100,
                max_scan: 1000,
              },
              ctx,
            );
            const logEnv = envelopeOf(logResponse);
            if (!logEnv.ok) {
              failures.push(`log_contains check failed: ${errorText(logEnv, 'log_search failed')}`);
            } else {
              const entries = asRow(logEnv.data).entries;
              const list = Array.isArray(entries) ? entries : [];
              if (list.length === 0) {
                failures.push(`log_contains violated: query "${assert.query}" not found in session logs`);
              }
              warnings.push(...logEnv.warnings);
            }
          } else if (assert.type === 'log_absent') {
            const logResponse = await handleLogSearch(
              {
                since_sequence: 0,
                severities: assert.severities,
                play_session_id: sessionId ?? undefined,
                query: assert.query,
                match: 'substring',
                case_sensitive: false,
                limit: 100,
                max_scan: 1000,
              },
              ctx,
            );
            const logEnv = envelopeOf(logResponse);
            if (!logEnv.ok) {
              failures.push(`log_absent check failed: ${errorText(logEnv, 'log_search failed')}`);
            } else {
              const entries = asRow(logEnv.data).entries;
              const list = Array.isArray(entries) ? entries : [];
              if (list.length > 0) {
                failures.push(`log_absent violated: query "${assert.query}" found ${list.length} time(s) in session logs`);
              }
              warnings.push(...logEnv.warnings);
            }
          }
        } catch (error) {
          failures.push(`${assert.type} check threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error) {
    failures.push(`scenario failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      const stopResponse = await handlePlayStop({ wait: true, timeout_ms: 30_000, dry_run: false }, ctx);
      const stopEnv = envelopeOf(stopResponse);
      if (!stopEnv.ok) {
        failures.push(`cleanup play_stop failed: ${errorText(stopEnv, 'play_stop failed')}`);
      } else {
        warnings.push(...stopEnv.warnings);
      }
    } catch (error) {
      failures.push(`cleanup play_stop threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const duration = (Date.now() - startedAt) / 1000;
  const passed = failures.length === 0;
  const data = {
    scenario: args.scenario_name,
    passed,
    failures,
    duration,
    session_id: sessionId,
  };
  return success(data, bridge, warnings, [{ kind: 'test.scenario.completed', scenario: args.scenario_name, passed }]);
}
