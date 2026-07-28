import fs from 'node:fs/promises';
import { z } from 'zod';
import { ProjectMeta, walkDir } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';
import path from 'node:path';

export const SearchInFilesSchema = z.object({
  pattern: z.string().describe('Text to search for (literal string)'),
  scope: z.enum(['scripts', 'docs', 'all']).optional().default('scripts'),
  case_sensitive: z.boolean().optional().default(false),
  max_results: z.number().int().min(1).max(200).optional().default(50),
});

export async function handleSearchInFiles(
  args: z.infer<typeof SearchInFilesSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let files: string[] = [];
    if (args.scope === 'scripts' || args.scope === 'all') {
      files.push(...await walkDir(ctx.sourceDir, ['.cs']));
    }
    if (args.scope === 'docs' || args.scope === 'all') {
      files.push(...await walkDir(ctx.projectPath, ['.md']));
    }
    files = [...new Set(files)].sort();

    const results: string[] = [];
    let total = 0;
    let truncated = false;

    for (const file of files) {
      const raw = await fs.readFile(file, 'utf-8').catch(() => null);
      if (!raw) continue;

      const lines = raw.split('\n');
      const fileHits: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = args.case_sensitive ? line : line.toLowerCase();
        const needle = args.case_sensitive ? args.pattern : args.pattern.toLowerCase();

        if (haystack.includes(needle)) {
          if (total >= args.max_results) { truncated = true; break; }
          fileHits.push(`  ${i + 1}: ${line.trim()}`);
          total++;
        }
      }

      if (fileHits.length > 0) {
        const rel = path.relative(ctx.projectPath, file);
        results.push(`${rel}:`);
        results.push(...fileHits);
        results.push('');
      }

      if (truncated) break;
    }

    if (results.length === 0) return toolResult(`No matches for "${args.pattern}".`);

    const summary = `Found ${total} match${total !== 1 ? 'es' : ''}${truncated ? ` (truncated at ${args.max_results})` : ''} for "${args.pattern}":\n`;
    return toolResult(summary + results.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}
