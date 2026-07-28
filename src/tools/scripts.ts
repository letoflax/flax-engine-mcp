import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, safeReadFile, assertSafePath } from '../projectContext.js';
import { ToolDomainError, toolResult, toolError, ToolResponse } from '../errors.js';
import {
  assertSha256,
  assertWritePathWithinRoot,
  atomicWriteConfined,
  assertContentSize,
  readConfinedText,
  sha256,
  summarizeChange,
  withTargetLock,
} from '../writeSafety.js';
import { appendScriptAudit } from '../audit.js';

export const ListScriptsSchema = z.object({
  filter: z.string().optional().describe('Substring to filter script names (case-insensitive)'),
  include_build_scripts: z.boolean().optional().default(false).describe(
    'Include *.Build.cs and *.Gen.cs files'
  ),
});

export const ReadScriptSchema = z.object({
  name: z.string().describe('Script file name (e.g. "PlayerScript.cs") or relative path from project root'),
});

const ScriptMutationFields = {
  name: z.string().describe('Script file name or relative path under Source/ (e.g. "Game/EnemyScript.cs")'),
  dry_run: z.boolean().optional().default(false).describe('Preview validation and change metadata without writing the script.'),
  expected_hash: z.string().length(64).regex(/^[a-fA-F0-9]{64}$/).optional().describe('SHA-256 hash of the current file; rejects stale writes.'),
};

export const WriteScriptSchema = z.object({
  ...ScriptMutationFields,
  content: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 1024 * 1024, {
    message: 'content must not exceed 1048576 UTF-8 bytes',
  }).describe('Full C# source code to write'),
  overwrite: z.boolean().optional().default(false).describe('Must be true to overwrite an existing file'),
});

export const ApplyScriptPatchSchema = z.object({
  ...ScriptMutationFields,
  patch: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 256 * 1024, {
    message: 'patch must not exceed 262144 UTF-8 bytes',
  }).describe('A bounded unified diff. Only @@ hunks with context, +, and - lines are accepted.'),
});

function changeResult(action: string, target: string, dryRun: boolean, before: string | null, after: string): string {
  const change = summarizeChange(before, after);
  return `${dryRun ? 'Dry run:' : action + ':'} ${target}\n${JSON.stringify({ ...change, dry_run: dryRun }, null, 2)}`;
}

async function resolveScriptTarget(name: string, ctx: ProjectMeta): Promise<string> {
  const target = name.includes('/') || name.includes(path.sep)
    ? path.resolve(ctx.sourceDir, name)
    : path.join(ctx.sourceDir, 'Game', name);
  const sourceRelative = path.relative(path.resolve(ctx.sourceDir), target);
  if (sourceRelative === '..' || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) {
    throw new ToolDomainError('INVALID_PATH', 'Access denied: script path is outside Source/.');
  }
  if (path.extname(target).toLowerCase() !== '.cs') {
    throw new ToolDomainError('VALIDATION_FAILED', 'Script name must end in .cs.');
  }
  return assertWritePathWithinRoot(target, ctx.projectPath);
}

function publicTarget(target: string, ctx: ProjectMeta): string {
  return path.relative(ctx.projectPath, target).split(path.sep).join('/');
}

async function auditMutation(
  ctx: ProjectMeta,
  operation: 'write_script' | 'apply_script_patch',
  target: string,
  dryRun: boolean,
  success: boolean,
  before?: string | null,
  after?: string,
  error?: unknown,
): Promise<void> {
  const summary = after === undefined ? undefined : summarizeChange(before ?? null, after);
  await appendScriptAudit(ctx, {
    operation,
    target: publicTarget(target, ctx),
    dry_run: dryRun,
    success,
    ...(summary ?? {}),
    ...(error instanceof Error ? { error: error.message } : error ? { error: String(error) } : {}),
  });
}

async function auditSuccessOrWarning(
  ctx: ProjectMeta,
  operation: 'write_script' | 'apply_script_patch',
  target: string,
  dryRun: boolean,
  before: string | null,
  after: string,
): Promise<string[]> {
  try {
    await auditMutation(ctx, operation, target, dryRun, true, before, after);
    return [];
  } catch {
    return ['The script operation succeeded, but its audit entry could not be recorded.'];
  }
}

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
    if (files.length === 0) return toolResult('No scripts found.');
    const rows = await Promise.all(files.map(async f => {
      const stat = await fs.stat(f).catch(() => null);
      const rel = path.relative(ctx.projectPath, f);
      const size = stat ? `${stat.size}B` : '?';
      const mtime = stat ? stat.mtime.toISOString().slice(0, 10) : '?';
      return `${path.basename(f).padEnd(30)} ${rel.padEnd(50)} ${size.padStart(8)}  ${mtime}`;
    }));
    const header = `${'Name'.padEnd(30)} ${'Path'.padEnd(50)} ${'Size'.padStart(8)}  Modified`;
    return toolResult([header, '-'.repeat(header.length), ...rows].join('\n'));
  } catch (error) {
    return toolError(error);
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
      if (!match) return toolError(new Error(`Script "${args.name}" not found. Use list_scripts to see available files.`));
      resolved = match;
    }
    assertSafePath(resolved, ctx.projectPath);
    const content = await safeReadFile(resolved);
    if (content === null) return toolError(new Error(`File not found: ${resolved}`));
    return toolResult(`// ${path.relative(ctx.projectPath, resolved)}\n\n${content}`);
  } catch (error) {
    return toolError(error);
  }
}

export async function handleWriteScript(
  args: z.infer<typeof WriteScriptSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  let target: string | undefined;
  let before: string | null = null;
  try {
    assertSha256(args.expected_hash);
    target = await resolveScriptTarget(args.name, ctx);
    await withTargetLock(target, ctx.projectPath, async () => {
      before = await readConfinedText(target!, ctx.projectPath);
      if (before !== null && !args.overwrite) {
        throw new ToolDomainError('FILE_EXISTS', `File already exists: ${publicTarget(target!, ctx)}. Set overwrite:true to replace it.`);
      }
      if (args.expected_hash !== undefined && (before === null || sha256(before) !== args.expected_hash.toLowerCase())) {
        throw new ToolDomainError('FILE_CHANGED', 'Expected hash does not match the current file; refresh the script and retry.');
      }
      // Validate here as well as at the schema boundary so direct handler calls
      // cannot bypass the limit, including dry-run requests.
      assertContentSize(args.content);
      if (!args.dry_run) await atomicWriteConfined(target!, args.content, ctx.projectPath, before);
    });
  } catch (error) {
    if (target) await auditMutation(ctx, 'write_script', target, args.dry_run, false, before, undefined, error).catch(() => undefined);
    return toolError(error);
  }
  const warnings = await auditSuccessOrWarning(ctx, 'write_script', target!, args.dry_run, before, args.content);
  return toolResult(changeResult('Written', publicTarget(target!, ctx), args.dry_run, before, args.content), warnings);
}

interface ParsedHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[]; }

function applyUnifiedDiff(source: string, patch: string): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const hunks: ParsedHunk[] = [];
  let index = 0;
  while (index < lines.length && (lines[index]!.startsWith('--- ') || lines[index]!.startsWith('+++ ') || lines[index] === '')) index++;
  while (index < lines.length) {
    const header = lines[index]!;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(header);
    if (!match) throw new ToolDomainError('VALIDATION_FAILED', 'Invalid unified diff hunk header.');
    index++;
    const hunkLines: string[] = [];
    while (index < lines.length && !lines[index]!.startsWith('@@ ')) {
      const line = lines[index]!;
      if (line === '' && index === lines.length - 1) { index++; break; }
      if (line === '\\ No newline at end of file') { index++; continue; }
      if (!/^[ +\-]/.test(line)) throw new ToolDomainError('VALIDATION_FAILED', 'Invalid unified diff line; each hunk line must begin with space, +, or -.');
      hunkLines.push(line);
      index++;
    }
    hunks.push({ oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: hunkLines });
    if (hunks.length > 200) throw new ToolDomainError('VALIDATION_FAILED', 'Patch exceeds the 200-hunk limit.');
  }
  if (hunks.length === 0) throw new ToolDomainError('VALIDATION_FAILED', 'Patch contains no unified diff hunks.');

  const original = source.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > original.length) throw new ToolDomainError('PATCH_CONFLICT', 'Patch hunks are out of order or outside the current source file.');
    output.push(...original.slice(cursor, start));
    cursor = start;
    let consumed = 0;
    let produced = 0;
    for (const line of hunk.lines) {
      const kind = line[0]!;
      const text = line.slice(1);
      if (kind === ' ') {
        if (original[cursor] !== text) throw new ToolDomainError('PATCH_CONFLICT', 'Patch context does not match the current file.');
        output.push(text); cursor++; consumed++; produced++;
      } else if (kind === '-') {
        if (original[cursor] !== text) throw new ToolDomainError('PATCH_CONFLICT', 'Patch removal does not match the current file.');
        cursor++; consumed++;
      } else {
        output.push(text); produced++;
      }
    }
    if (consumed !== hunk.oldCount || produced !== hunk.newCount) throw new ToolDomainError('VALIDATION_FAILED', 'Patch hunk line counts do not match its header.');
  }
  output.push(...original.slice(cursor));
  return output.join('\n');
}

export async function handleApplyScriptPatch(
  args: z.infer<typeof ApplyScriptPatchSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  let target: string | undefined;
  let before: string | null = null;
  let after: string | undefined;
  try {
    assertSha256(args.expected_hash);
    target = await resolveScriptTarget(args.name, ctx);
    await withTargetLock(target, ctx.projectPath, async () => {
      before = await readConfinedText(target!, ctx.projectPath);
      if (before === null) throw new ToolDomainError('NOT_FOUND', `File not found: ${publicTarget(target!, ctx)}. Patch operations require an existing script.`);
      if (args.expected_hash !== undefined && sha256(before) !== args.expected_hash.toLowerCase()) {
        throw new ToolDomainError('FILE_CHANGED', 'Expected hash does not match the current file; refresh the script and retry.');
      }
      after = applyUnifiedDiff(before, args.patch);
      assertContentSize(after);
      if (!args.dry_run) await atomicWriteConfined(target!, after, ctx.projectPath, before);
    });
  } catch (error) {
    if (target) await auditMutation(ctx, 'apply_script_patch', target, args.dry_run, false, before, undefined, error).catch(() => undefined);
    return toolError(error);
  }
  const finalAfter = after!;
  const warnings = await auditSuccessOrWarning(ctx, 'apply_script_patch', target!, args.dry_run, before, finalAfter);
  return toolResult(changeResult('Patched', publicTarget(target!, ctx), args.dry_run, before, finalAfter), warnings);
}
