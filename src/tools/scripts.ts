import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, safeReadFile, assertSafePath } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const ListScriptsSchema = z.object({
  filter: z.string().optional().describe('Substring to filter script names (case-insensitive)'),
  include_build_scripts: z.boolean().optional().default(false).describe(
    'Include *.Build.cs and *.Gen.cs files'
  ),
});

export const ReadScriptSchema = z.object({
  name: z.string().describe('Script file name (e.g. "PlayerScript.cs") or relative path from project root'),
});

export const WriteScriptSchema = z.object({
  name: z.string().describe('Script file name or relative path under Source/ (e.g. "Game/EnemyScript.cs")'),
  content: z.string().describe('Full C# source code to write'),
  overwrite: z.boolean().optional().default(false).describe('Must be true to overwrite an existing file'),
});

export async function handleListScripts(
  args: z.infer<typeof ListScriptsSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let files = await walkDir(ctx.sourceDir, ['.cs']);

    if (!args.include_build_scripts) {
      files = files.filter(f => {
        const base = path.basename(f);
        return !base.endsWith('.Build.cs') && !base.endsWith('.Gen.cs');
      });
    }

    if (args.filter) {
      const lower = args.filter.toLowerCase();
      files = files.filter(f => path.basename(f).toLowerCase().includes(lower));
    }

    if (files.length === 0) {
      return toolResult('No scripts found.');
    }

    const rows = await Promise.all(files.map(async f => {
      const stat = await fs.stat(f).catch(() => null);
      const rel = path.relative(ctx.projectPath, f);
      const size = stat ? `${stat.size}B` : '?';
      const mtime = stat ? stat.mtime.toISOString().slice(0, 10) : '?';
      return `${path.basename(f).padEnd(30)} ${rel.padEnd(50)} ${size.padStart(8)}  ${mtime}`;
    }));

    const header = `${'Name'.padEnd(30)} ${'Path'.padEnd(50)} ${'Size'.padStart(8)}  Modified`;
    const sep = '-'.repeat(header.length);
    return toolResult([header, sep, ...rows].join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

export async function handleReadScript(
  args: z.infer<typeof ReadScriptSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let resolved: string;

    if (args.name.includes(path.sep) || args.name.includes('/')) {
      resolved = path.resolve(ctx.projectPath, args.name);
    } else {
      const all = await walkDir(ctx.sourceDir, ['.cs']);
      const match = all.find(f => path.basename(f) === args.name);
      if (!match) {
        return toolError(new Error(`Script "${args.name}" not found. Use list_scripts to see available files.`));
      }
      resolved = match;
    }

    assertSafePath(resolved, ctx.projectPath);

    const content = await safeReadFile(resolved);
    if (content === null) {
      return toolError(new Error(`File not found: ${resolved}`));
    }

    const rel = path.relative(ctx.projectPath, resolved);
    return toolResult(`// ${rel}\n\n${content}`);
  } catch (e) {
    return toolError(e);
  }
}

export async function handleWriteScript(
  args: z.infer<typeof WriteScriptSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let target: string;

    if (args.name.includes('/') || args.name.includes(path.sep)) {
      target = path.resolve(ctx.sourceDir, args.name);
    } else {
      target = path.join(ctx.sourceDir, 'Game', args.name);
    }

    assertSafePath(target, ctx.projectPath);

    const existing = await safeReadFile(target);
    if (existing !== null && !args.overwrite) {
      return toolError(new Error(
        `File already exists: ${path.relative(ctx.projectPath, target)}\nSet overwrite:true to replace it.`
      ));
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, args.content, 'utf-8');

    const rel = path.relative(ctx.projectPath, target);
    return toolResult(`Written: ${rel} (${Buffer.byteLength(args.content, 'utf-8')} bytes)`);
  } catch (e) {
    return toolError(e);
  }
}
