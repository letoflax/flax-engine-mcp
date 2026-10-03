import { z } from 'zod';
import { toolError, toolResult, ToolResponse } from '../errors.js';
import { EditorBridgeCall, callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
import { BridgeMethod } from '../bridge/protocol.js';
import { ProjectMeta } from '../projectContext.js';
import { reportProgress } from '../progress.js';
import { BRIDGE_V34 } from './liveToolSupport.js';
import { inspectEditorBridge, isProcessAlive } from './serverStatus.js';

// Bridge v34 Editor lifecycle and options. editor_quit and editor_options
// reach the Editor through the bridge (editor.quit, editor.get_options,
// editor.set_option); editor_launch starts a new Editor process from the
// server and therefore needs no bridge.

export const EDITOR_OPTION_NAMES = ['AutoReloadScriptsOnMainWindowFocus', 'ForceScriptCompilationOnStartup'] as const;

export const EditorQuitSchema = z.object({
  unsaved: z.enum(['refuse', 'save', 'discard']).optional().default('refuse')
    .describe('What to do when scenes or asset windows have unsaved edits: refuse (default) leaves the Editor running, save writes them first, discard drops them.'),
  stop_play: z.boolean().optional().default(false)
    .describe('Stop play mode first. Without it, quitting during play mode is refused.'),
  timeout_ms: z.number().int().min(1).max(120000).optional().default(60000)
    .describe('How long to wait for the Editor process to exit after the quit is accepted (at most 120000).'),
}).strict();

export const EditorLaunchSchema = z.object({
  headless: z.boolean().optional().default(false)
    .describe('Start the Editor without a window (-headless).'),
  skip_compile: z.boolean().optional().default(false)
    .describe('Skip the startup script compilation (-skipcompile).'),
  wait_ready: z.boolean().optional().default(true)
    .describe('Wait until the new Editor bridge answers and reports it is ready.'),
  timeout_ms: z.number().int().min(1).max(300000).optional().default(120000)
    .describe('How long to wait for readiness (at most 300000).'),
}).strict();

export const EditorOptionsSchema = z.object({
  set: z.object({
    name: z.enum(EDITOR_OPTION_NAMES),
    value: z.boolean(),
  }).strict().optional()
    .describe('Option to change. Omit to read the current options.'),
  dry_run: z.boolean().optional().default(true)
    .describe('Preview the change without writing it (default true). Ignored when set is omitted.'),
  confirm: z.literal(true).optional()
    .describe('Required to apply a change: the option is a user-global Editor setting that persists across projects.'),
}).strict().superRefine((value, ctx) => {
  if (value.set !== undefined && !value.dry_run && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Set confirm: true to change an Editor option, or dry_run: true to preview it.' });
  }
});

/** Seams for tests: the bridge call, process liveness, the heartbeat pid, and time. */
export interface EditorLifecycleDeps {
  call: (ctx: ProjectMeta, method: BridgeMethod, params: Record<string, unknown>, deadlineMs: number) => Promise<EditorBridgeCall>;
  isAlive: (pid: number) => boolean;
  heartbeatPid: (ctx: ProjectMeta) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultLifecycleDeps: EditorLifecycleDeps = {
  call: (ctx, method, params, deadlineMs) => callEditorBridge(ctx, method, params, { deadlineMs, minimumBridgeVersion: BRIDGE_V34 }),
  isAlive: isProcessAlive,
  heartbeatPid: async ctx => (await inspectEditorBridge(ctx)).pid,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
};

const QUIT_POLL_MS = 200;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export async function handleEditorQuit(
  args: z.infer<typeof EditorQuitSchema>,
  ctx: ProjectMeta,
  deps: EditorLifecycleDeps = defaultLifecycleDeps,
): Promise<ToolResponse> {
  try {
    const heartbeatPid = await deps.heartbeatPid(ctx).catch(() => null);
    const response = await deps.call(ctx, 'editor.quit', { Unsaved: args.unsaved, StopPlay: args.stop_play }, 30_000);
    const result = asRecord(response.data);
    const accepted = result.Accepted === true;
    const reportedPid = typeof result.Pid === 'number' && result.Pid > 0 ? result.Pid : null;
    const pid = reportedPid ?? heartbeatPid;
    const warnings = [...response.warnings];
    let exited = false;
    const startedAt = deps.now();
    if (accepted) {
      if (pid === null) {
        warnings.push('The bridge pid is unknown, so the Editor exit could not be confirmed.');
      } else {
        const end = startedAt + args.timeout_ms;
        for (;;) {
          if (!deps.isAlive(pid)) { exited = true; break; }
          reportProgress(`Waiting for Editor process ${pid} to exit (${result.Phase === 'stopping_play' ? 'stopping play mode first' : 'exiting'})`, args.timeout_ms);
          if (deps.now() + QUIT_POLL_MS > end) break;
          await deps.sleep(QUIT_POLL_MS);
        }
        if (!exited) warnings.push(`The Editor process ${pid} was still running after ${args.timeout_ms} ms. The quit was accepted and may still complete; check editor_get_status.`);
      }
    }
    const data = {
      accepted,
      phase: typeof result.Phase === 'string' ? result.Phase : null,
      savedSceneIds: stringList(result.SavedSceneIds),
      discardedSceneIds: stringList(result.DiscardedSceneIds),
      discardedAssetWindows: stringList(result.DiscardedAssetWindows),
      exited,
      pid,
      waitedMs: deps.now() - startedAt,
    };
    return toolResult(JSON.stringify(data, null, 2), {
      mode: 'editor-connected',
      data,
      warnings,
      changes: accepted ? [{ kind: 'editor.quit', pid, exited, unsaved: args.unsaved }] : [],
    });
  } catch (error) {
    return toolError(mapBridgeError(error));
  }
}

export { handleEditorLaunch } from './editorLaunch.js';

const USER_GLOBAL_NOTE = 'Editor options are stored per user (not per project) and shared by every Editor of this user. Editors that are already running keep their own copy until they restart.';

export async function handleEditorOptions(
  args: z.infer<typeof EditorOptionsSchema>,
  ctx: ProjectMeta,
  deps: EditorLifecycleDeps = defaultLifecycleDeps,
): Promise<ToolResponse> {
  try {
    if (args.set === undefined) {
      const response = await deps.call(ctx, 'editor.get_options', {}, 15_000);
      const result = asRecord(response.data);
      const data = {
        autoReloadScriptsOnMainWindowFocus: result.AutoReloadScriptsOnMainWindowFocus === true,
        forceScriptCompilationOnStartup: result.ForceScriptCompilationOnStartup === true,
        scope: typeof result.Scope === 'string' ? result.Scope : 'user-global',
        note: USER_GLOBAL_NOTE,
      };
      return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings: response.warnings, changes: [] });
    }
    const response = await deps.call(ctx, 'editor.set_option', {
      Name: args.set.name,
      Value: args.set.value,
      DryRun: args.dry_run,
      Confirm: args.confirm === true,
    }, 15_000);
    const result = asRecord(response.data);
    const changed = result.Changed === true;
    const dryRun = result.DryRun === true;
    const applied = changed && !dryRun;
    const scope = typeof result.Scope === 'string' ? result.Scope : 'user-global';
    const data = {
      name: typeof result.Name === 'string' ? result.Name : args.set.name,
      previous: result.Previous === true,
      value: result.Value === true,
      changed,
      dryRun,
      applied,
      scope,
      note: USER_GLOBAL_NOTE,
    };
    const warnings = [...response.warnings];
    if (applied && args.set.name === 'AutoReloadScriptsOnMainWindowFocus' && !args.set.value) {
      warnings.push('With auto reload off, play mode uses the last compiled game assemblies: run code_compile after editing scripts.');
    }
    return toolResult(JSON.stringify(data, null, 2), {
      mode: 'editor-connected',
      data,
      warnings,
      changes: applied ? [{ kind: 'editor.option_set', name: data.name, previous: data.previous, value: data.value, scope }] : [],
    });
  } catch (error) {
    return toolError(mapBridgeError(error));
  }
}
