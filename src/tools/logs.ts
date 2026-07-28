import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';
import { readTextFile } from '../textEncoding.js';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod } from '../bridge/protocol.js';
import { inspectEditorBridge } from './serverStatus.js';

export const GetLatestLogSchema = z.object({
  lines: z.number().int().min(10).max(500).optional().default(100),
  filter: z.string().optional().describe('Only return lines containing this string'),
  all_logs: z.boolean().optional().default(false).describe('List all available log files instead of reading'),
});

const LATEST_LOG_DEPRECATION = 'Deprecated legacy tool: delegated to live editor logs. Prefer log_get_recent or log_search.';

async function hasPhase2Bridge(ctx: ProjectMeta): Promise<boolean> {
  const bridge = await inspectEditorBridge(ctx);
  return bridge.connected && bridge.protocolVersion === '1' && Number(bridge.bridgeVersion) >= 6;
}

function liveEntries(value: unknown): Record<string, unknown>[] {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const entries = source.Entries ?? source.entries;
  return Array.isArray(entries) ? entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
}

function renderLiveLine(entry: Record<string, unknown>): string {
  const message = String(entry.Message ?? entry.message ?? '').trim();
  const level = String(entry.Level ?? entry.level ?? '').trim();
  return level ? `[${level}] ${message}` : message;
}

async function getLiveLatestLog(args: z.infer<typeof GetLatestLogSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  const limit = Math.min(args.lines, 200);
  const response = await callEditorBridge(ctx, 'log.query' as BridgeMethod, {
    SinceSequence: 0,
    Limit: limit,
    Tail: true,
    ...(args.filter ? { Contains: args.filter } : {}),
  });
  let lines = liveEntries(response.data).map(renderLiveLine);
  if (args.filter) {
    const needle = args.filter.toLowerCase();
    lines = lines.filter(line => line.toLowerCase().includes(needle));
  }
  const header = `Log: live editor session | Total: live stream | Showing last ${lines.length}${args.filter ? ` matching "${args.filter}"` : ''}\n${'â”€'.repeat(60)}`;
  const warnings = [LATEST_LOG_DEPRECATION, ...response.warnings];
  if (args.lines > limit) warnings.push('Live editor log queries are capped at 200 lines.');
  if (args.all_logs) warnings.push('all_logs is not available from the live log stream; recent entries were returned instead.');
  return toolResult(`${header}\n${lines.join('\n')}`, {
    mode: 'editor-connected',
    data: { source: 'live_editor_logs', entries: lines.length },
    warnings,
  });
}

export async function handleGetLatestLog(
  args: z.infer<typeof GetLatestLogSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    if (await hasPhase2Bridge(ctx)) return await getLiveLatestLog(args, ctx);
    const entries = await fs.readdir(ctx.logsDir).catch(() => [] as string[]);
    const logFiles = entries.filter(e => e.endsWith('.txt')).sort();

    if (logFiles.length === 0) return toolResult('No log files found in Logs/.');

    if (args.all_logs) {
      return toolResult(`Log files in Logs/:\n${logFiles.join('\n')}`);
    }

    const latest = logFiles[logFiles.length - 1];
    const logPath = path.join(ctx.logsDir, latest);
    const raw = await readTextFile(logPath).catch(() => null);
    if (!raw) return toolError(new Error(`Cannot read ${latest}`));

    let lines = raw.split('\n');
    if (args.filter) {
      const lower = args.filter.toLowerCase();
      lines = lines.filter(l => l.toLowerCase().includes(lower));
    }

    const tail = lines.slice(-args.lines);
    const header = `Log: ${latest} | Total: ${raw.split('\n').length} lines | Showing last ${tail.length}${args.filter ? ` matching "${args.filter}"` : ''}\n${'─'.repeat(60)}`;

    return toolResult(`${header}\n${tail.join('\n')}`);
  } catch (e) {
    return toolError(e);
  }
}
