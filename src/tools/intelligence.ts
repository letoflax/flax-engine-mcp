import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, safeReadFile } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GetProjectSummarySchema = z.object({
  sections: z.array(z.enum(['scripts', 'scenes', 'assets', 'settings', 'docs']))
    .optional()
    .describe('Which sections to include. Omit to include all.'),
});

export const GetCompilerErrorsSchema = z.object({
  log_file: z.string().optional().describe('Specific log file name. Defaults to latest.'),
  include_warnings: z.boolean().optional().default(false),
});

export const ValidateProjectSchema = z.object({
  checks: z.array(z.enum(['scripts', 'assets', 'settings', 'scenes']))
    .optional()
    .describe('Which checks to run. Omit to run all.'),
});

// ---------- get_project_summary ----------

export async function handleGetProjectSummary(
  args: z.infer<typeof GetProjectSummarySchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const sections = args.sections ?? ['scripts', 'scenes', 'assets', 'settings', 'docs'];
    const output: string[] = [`# Project Summary: ${ctx.projectName}`, ''];

    if (sections.includes('scripts')) {
      const files = await walkDir(ctx.sourceDir, ['.cs']);
      const gameFiles = files.filter(f =>
        !path.basename(f).endsWith('.Build.cs') && !path.basename(f).endsWith('.Gen.cs')
      );
      output.push('## Scripts', '');

      for (const f of gameFiles) {
        const source = await fs.readFile(f, 'utf-8').catch(() => null);
        if (!source) continue;

        const classMatch = source.match(/(?:public|internal)\s+(?:partial\s+)?class\s+(\w+)(?:\s*:\s*([^{\n,]+))?/);
        if (!classMatch) continue;

        const className = classMatch[1];
        const baseClass = (classMatch[2] ?? '').trim();
        const pubFields = [...source.matchAll(/public\s+([\w<>[\]]+)\s+(\w+)\s*[{;=]/g)]
          .map(m => `${m[1]} ${m[2]}`).slice(0, 6);
        const methods = [...source.matchAll(/public\s+(?:override\s+)?[\w]+\s+(\w+)\s*\(/g)]
          .map(m => m[1]).filter(n => n !== 'if' && n !== 'for' && n !== 'while').slice(0, 8);

        output.push(`**${className}**${baseClass ? ` : ${baseClass}` : ''} — ${path.relative(ctx.projectPath, f)}`);
        if (pubFields.length > 0) output.push(`  Fields: ${pubFields.join(', ')}`);
        if (methods.length > 0) output.push(`  Methods: ${methods.join(', ')}`);
        output.push('');
      }
    }

    if (sections.includes('scenes')) {
      output.push('## Scenes', '');
      const scenes = await walkDir(ctx.contentDir, ['.scene']);
      for (const s of scenes) {
        const raw = await safeReadFile(s);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { Data?: unknown[] };
          const count = (parsed.Data ?? []).length;
          output.push(`  ${path.basename(s)}: ${count} actors/components`);
        } catch { output.push(`  ${path.basename(s)}: (unreadable)`); }
      }
      output.push('');
    }

    if (sections.includes('assets')) {
      output.push('## Assets', '');
      const all = await walkDir(ctx.contentDir, []);
      const byType: Record<string, number> = {};
      for (const f of all) {
        const ext = path.extname(f) || 'no-ext';
        byType[ext] = (byType[ext] ?? 0) + 1;
      }
      for (const [ext, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
        output.push(`  ${ext.padEnd(10)} ${count} file(s)`);
      }
      output.push('');
    }

    if (sections.includes('settings')) {
      output.push('## Settings', '');
      const sFiles = await fs.readdir(ctx.settingsDir).catch(() => [] as string[]);
      for (const s of sFiles.filter(f => f.endsWith('.json'))) {
        output.push(`  ${s}`);
      }
      output.push('');
    }

    if (sections.includes('docs')) {
      output.push('## Documentation', '');
      const docs = await walkDir(ctx.projectPath, ['.md']);
      for (const d of docs) {
        output.push(`  ${path.relative(ctx.projectPath, d)}`);
      }
      output.push('');
    }

    return toolResult(output.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

// ---------- get_compiler_errors ----------

const ERROR_PATTERNS = [
  /error\s+CS\d+/i,
  /Error:\s/,
  /\[Error\]/,
  /Build\s+FAILED/i,
  /Compilation\s+failed/i,
];

const WARNING_PATTERNS = [
  /warning\s+CS\d+/i,
  /Warning:\s/,
  /\[Warning\]/,
];

export async function handleGetCompilerErrors(
  args: z.infer<typeof GetCompilerErrorsSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let logFile: string | null = null;

    const entries = (await fs.readdir(ctx.logsDir).catch(() => [] as string[]))
      .filter(e => e.endsWith('.txt'))
      .sort();

    if (args.log_file) {
      const found = entries.find(e => e === args.log_file || e.includes(args.log_file ?? ''));
      logFile = found ? path.join(ctx.logsDir, found) : null;
    } else {
      const latest = entries[entries.length - 1];
      logFile = latest ? path.join(ctx.logsDir, latest) : null;
    }

    if (!logFile) return toolResult('No log files found.');

    const raw = await safeReadFile(logFile);
    if (!raw) return toolError(new Error(`Cannot read ${logFile}`));

    const lines = raw.split('\n');
    const errors: string[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ERROR_PATTERNS.some(p => p.test(line))) {
        errors.push(`  L${i + 1}: ${line.trim()}`);
      } else if (args.include_warnings && WARNING_PATTERNS.some(p => p.test(line))) {
        warnings.push(`  L${i + 1}: ${line.trim()}`);
      }
    }

    const out: string[] = [`Log: ${path.basename(logFile)}`, ''];

    if (errors.length === 0 && warnings.length === 0) {
      out.push('No compilation errors or warnings found.');
    } else {
      if (errors.length > 0) {
        out.push(`## Errors (${errors.length})`, ...errors, '');
      }
      if (warnings.length > 0) {
        out.push(`## Warnings (${warnings.length})`, ...warnings, '');
      }
    }

    return toolResult(out.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

// ---------- validate_project ----------

interface Issue {
  severity: 'error' | 'warning' | 'info';
  check: string;
  message: string;
}

export async function handleValidateProject(
  args: z.infer<typeof ValidateProjectSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  const checks = args.checks ?? ['scripts', 'assets', 'settings', 'scenes'];
  const issues: Issue[] = [];

  try {
    // --- Scripts check ---
    if (checks.includes('scripts')) {
      const files = await walkDir(ctx.sourceDir, ['.cs']);
      for (const f of files.filter(f => !path.basename(f).endsWith('.Build.cs') && !path.basename(f).endsWith('.Gen.cs'))) {
        const source = await fs.readFile(f, 'utf-8').catch(() => null);
        if (!source) { issues.push({ severity: 'warning', check: 'scripts', message: `Cannot read: ${path.relative(ctx.projectPath, f)}` }); continue; }

        const opens = (source.match(/\{/g) ?? []).length;
        const closes = (source.match(/\}/g) ?? []).length;
        if (opens !== closes) {
          issues.push({ severity: 'error', check: 'scripts', message: `Unbalanced braces in ${path.basename(f)} ({:${opens} }:${closes})` });
        }
      }
    }

    // --- Settings check ---
    if (checks.includes('settings')) {
      const required = ['Input Settings.json', 'Physics Settings.json', 'Graphics Settings.json'];
      const existing = await fs.readdir(ctx.settingsDir).catch(() => [] as string[]);
      for (const req of required) {
        if (!existing.includes(req)) {
          issues.push({ severity: 'warning', check: 'settings', message: `Missing settings file: ${req}` });
        }
      }
    }

    // --- Scenes check ---
    if (checks.includes('scenes')) {
      const projRaw = await safeReadFile(ctx.flaxprojPath);
      if (projRaw) {
        const proj = JSON.parse(projRaw) as { DefaultScene?: string };
        if (!proj.DefaultScene) {
          issues.push({ severity: 'warning', check: 'scenes', message: 'No DefaultScene set in .flaxproj' });
        } else {
          const scenes = await walkDir(ctx.contentDir, ['.scene']);
          let found = false;
          for (const s of scenes) {
            const raw = await safeReadFile(s);
            if (raw) {
              try {
                const p = JSON.parse(raw) as { ID?: string };
                if (p.ID === proj.DefaultScene) { found = true; break; }
              } catch { /* skip */ }
            }
          }
          if (!found) issues.push({ severity: 'error', check: 'scenes', message: `DefaultScene ID "${proj.DefaultScene}" not found in any .scene file` });
        }
      }
    }

    // --- Assets check ---
    if (checks.includes('assets')) {
      const sceneFiles = await walkDir(ctx.contentDir, ['.scene']);
      const allAssetIds = new Set<string>();
      const allFiles = await walkDir(ctx.contentDir, []);
      for (const f of allFiles) {
        const ext = path.extname(f);
        if (ext === '.flax' || ext === '.json') {
          const raw = await safeReadFile(f);
          if (raw) {
            try { const p = JSON.parse(raw) as { ID?: string }; if (p.ID) allAssetIds.add(p.ID); } catch { /* skip */ }
          }
        }
      }

      for (const s of sceneFiles) {
        const raw = await safeReadFile(s);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { Data?: Array<Record<string, unknown>> };
          const refs = JSON.stringify(parsed).match(/[0-9a-f]{32}/g) ?? [];
          const uniqueRefs = [...new Set(refs)];
          const broken = uniqueRefs.filter(id => !allAssetIds.has(id));
          if (broken.length > 3) {
            issues.push({ severity: 'info', check: 'assets', message: `${path.basename(s)}: ${broken.length} unresolved asset references (may include engine-internal IDs)` });
          }
        } catch { /* skip */ }
      }
    }

    if (issues.length === 0) {
      return toolResult('All checks passed. No issues found.');
    }

    const out: string[] = [`## Validation Results (${issues.length} issue(s))`, ''];
    for (const issue of issues) {
      const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
      out.push(`${icon} [${issue.check}] ${issue.message}`);
    }

    return toolResult(out.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}
