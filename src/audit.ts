import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta } from './projectContext.js';
import { toolError, toolResult, ToolResponse } from './errors.js';
import { assertWritePathWithinRoot } from './writeSafety.js';

const AUDIT_DIR = '.flax-mcp';
const AUDIT_FILE = 'audit.jsonl';

export interface ScriptAuditEntry {
  timestamp: string;
  operation: 'write_script' | 'apply_script_patch';
  target: string;
  dry_run: boolean;
  success: boolean;
  created?: boolean;
  before_hash?: string | null;
  after_hash?: string;
  bytes_before?: number;
  bytes_after?: number;
  lines_added?: number;
  lines_removed?: number;
  error?: string;
}

function auditPath(ctx: ProjectMeta): string {
  return path.join(ctx.projectPath, AUDIT_DIR, AUDIT_FILE);
}

export async function appendScriptAudit(ctx: ProjectMeta, entry: Omit<ScriptAuditEntry, 'timestamp'>): Promise<void> {
  const file = auditPath(ctx);
  await assertWritePathWithinRoot(file, ctx.projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await assertWritePathWithinRoot(file, ctx.projectPath);
  // JSON is deliberately constructed from a fixed allow-list. Script source,
  // patch text, and arbitrary request payloads must never enter this log.
  const record: ScriptAuditEntry = {
    timestamp: new Date().toISOString(),
    operation: entry.operation,
    target: entry.target,
    dry_run: entry.dry_run,
    success: entry.success,
    ...(entry.created !== undefined ? { created: entry.created } : {}),
    ...(entry.before_hash !== undefined ? { before_hash: entry.before_hash } : {}),
    ...(entry.after_hash !== undefined ? { after_hash: entry.after_hash } : {}),
    ...(entry.bytes_before !== undefined ? { bytes_before: entry.bytes_before } : {}),
    ...(entry.bytes_after !== undefined ? { bytes_after: entry.bytes_after } : {}),
    ...(entry.lines_added !== undefined ? { lines_added: entry.lines_added } : {}),
    ...(entry.lines_removed !== undefined ? { lines_removed: entry.lines_removed } : {}),
    ...(entry.error !== undefined ? { error: entry.error.slice(0, 240) } : {}),
  };
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export const GetAuditEntriesSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25).describe('Maximum most-recent entries to return (1-100).'),
  operation: z.enum(['write_script', 'apply_script_patch']).optional().describe('Optional mutation operation filter.'),
});

export async function handleGetAuditEntries(
  args: z.infer<typeof GetAuditEntriesSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  try {
    const file = auditPath(ctx);
    await assertWritePathWithinRoot(file, ctx.projectPath);
    const raw = await fs.readFile(file, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    const records = raw.split('\n').filter(Boolean).flatMap(line => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') return [];
        const value = parsed as Record<string, unknown>;
        // Defense in depth for legacy/tampered audit files: return only the
        // safe public fields rather than echoing arbitrary JSONL payloads.
        const entry: ScriptAuditEntry = {
          timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
          operation: value.operation === 'apply_script_patch' ? 'apply_script_patch' : 'write_script',
          target: typeof value.target === 'string' ? value.target : '',
          dry_run: value.dry_run === true,
          success: value.success === true,
        };
        for (const key of ['created', 'before_hash', 'after_hash', 'bytes_before', 'bytes_after', 'lines_added', 'lines_removed', 'error'] as const) {
          const candidate = value[key];
          if (typeof candidate === 'boolean' || typeof candidate === 'string' || typeof candidate === 'number' || candidate === null) {
            Object.assign(entry, { [key]: candidate });
          }
        }
        return [entry];
      } catch {
        return [];
      }
    }).filter(entry => !args.operation || entry.operation === args.operation).slice(-args.limit).reverse();
    return toolResult(JSON.stringify({ entries: records, redacted_fields: ['content', 'patch'] }, null, 2));
  } catch (error) {
    return toolError(error);
  }
}
