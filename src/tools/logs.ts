import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GetLatestLogSchema = z.object({
  lines: z.number().int().min(10).max(500).optional().default(100),
  filter: z.string().optional().describe('Only return lines containing this string'),
  all_logs: z.boolean().optional().default(false).describe('List all available log files instead of reading'),
});

export async function handleGetLatestLog(
  args: z.infer<typeof GetLatestLogSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const entries = await fs.readdir(ctx.logsDir).catch(() => [] as string[]);
    const logFiles = entries.filter(e => e.endsWith('.txt')).sort();

    if (logFiles.length === 0) return toolResult('No log files found in Logs/.');

    if (args.all_logs) {
      return toolResult(`Log files in Logs/:\n${logFiles.join('\n')}`);
    }

    const latest = logFiles[logFiles.length - 1];
    const logPath = path.join(ctx.logsDir, latest);
    const raw = await fs.readFile(logPath, 'utf-8').catch(() => null);
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
