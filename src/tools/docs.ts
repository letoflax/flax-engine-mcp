import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, safeReadFile } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const ListDocsSchema = z.object({});

export const ReadDocSchema = z.object({
  name: z.string().describe('Doc file name (e.g. "01-thiet-ke-kien-truc.md") or partial name'),
});

export async function handleListDocs(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const files = await walkDir(ctx.projectPath, ['.md']);
    if (files.length === 0) return toolResult('No markdown docs found.');

    const rows = await Promise.all(files.map(async f => {
      const stat = await fs.stat(f).catch(() => null);
      const rel = path.relative(ctx.projectPath, f);
      const size = stat ? `${stat.size}B` : '?';
      const mtime = stat ? stat.mtime.toISOString().slice(0, 10) : '?';
      return `${path.basename(f).padEnd(45)} ${size.padStart(8)}  ${mtime}  ${rel}`;
    }));

    const header = `${'Name'.padEnd(45)} ${'Size'.padStart(8)}  Modified    Path`;
    return toolResult([header, '-'.repeat(header.length), ...rows].join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

export async function handleReadDoc(
  args: z.infer<typeof ReadDocSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const allDocs = await walkDir(ctx.projectPath, ['.md']);
    const lower = args.name.toLowerCase();

    const match = allDocs.find(f =>
      path.basename(f).toLowerCase() === lower ||
      path.basename(f).toLowerCase().includes(lower)
    );

    if (!match) {
      const names = allDocs.map(f => path.basename(f)).join(', ');
      return toolError(new Error(`Doc "${args.name}" not found. Available: ${names}`));
    }

    const content = await safeReadFile(match);
    if (!content) return toolError(new Error(`Cannot read ${match}`));

    const rel = path.relative(ctx.projectPath, match);
    return toolResult(`<!-- ${rel} -->\n\n${content}`);
  } catch (e) {
    return toolError(e);
  }
}
