import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GetScriptClassesSchema = z.object({
  filter: z.string().optional().describe('Filter by script name or class name (case-insensitive)'),
});

export const FindReferencesSchema = z.object({
  symbol: z.string().describe('Class name, method name, or type to search for'),
  scope: z.enum(['scripts', 'all']).optional().default('scripts'),
});

export const ListNetworkedScriptsSchema = z.object({});

interface ClassInfo {
  file: string;
  namespace: string;
  className: string;
  baseClass: string;
  fields: FieldInfo[];
  methods: MethodInfo[];
}

interface FieldInfo {
  type: string;
  name: string;
  access: string;
  attributes: string[];
}

interface MethodInfo {
  name: string;
  returnType: string;
  access: string;
  attributes: string[];
}

function parseClass(source: string, relPath: string): ClassInfo[] {
  const results: ClassInfo[] = [];

  const nsMatch = source.match(/^namespace\s+([\w.]+)/m);
  const ns = nsMatch ? nsMatch[1] : '';

  const classPattern = /(?:public|internal|private|protected)?\s*(?:partial\s+)?class\s+(\w+)(?:\s*:\s*([^{,\n]+(?:,\s*[^{,\n]+)*))?/g;
  let classMatch: RegExpExecArray | null;

  while ((classMatch = classPattern.exec(source)) !== null) {
    const className = classMatch[1];
    const baseRaw = classMatch[2] ?? '';
    const baseClass = baseRaw.split(',')[0].trim();

    // Extract attributes + fields
    const fields: FieldInfo[] = [];
    const fieldPattern = /(?<attrs>(?:\[[^\]]+\]\s*)*)?(?<access>public|private|protected|internal)\s+(?<type>[\w<>[\].,\s]+?)\s+(?<name>\w+)\s*(?:=|;|\{)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldPattern.exec(source)) !== null) {
      const attrsRaw = (fm.groups?.['attrs'] ?? '').trim();
      const attrs = attrsRaw ? [...attrsRaw.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]) : [];
      fields.push({
        type: (fm.groups?.['type'] ?? '').trim(),
        name: fm.groups?.['name'] ?? '',
        access: fm.groups?.['access'] ?? '',
        attributes: attrs,
      });
    }

    // Extract methods
    const methods: MethodInfo[] = [];
    const methodPattern = /(?<attrs>(?:\[[^\]]+\]\s*)*)?(?<access>public|private|protected|internal|override)\s+(?:async\s+)?(?<ret>[\w<>[\]]+)\s+(?<name>\w+)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodPattern.exec(source)) !== null) {
      const name = mm.groups?.['name'] ?? '';
      if (name === 'if' || name === 'while' || name === 'for' || name === 'switch') continue;
      const attrsRaw = (mm.groups?.['attrs'] ?? '').trim();
      const attrs = attrsRaw ? [...attrsRaw.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]) : [];
      methods.push({
        name,
        returnType: mm.groups?.['ret'] ?? '',
        access: mm.groups?.['access'] ?? '',
        attributes: attrs,
      });
    }

    results.push({ file: relPath, namespace: ns, className, baseClass, fields, methods });
  }

  return results;
}

export async function handleGetScriptClasses(
  args: z.infer<typeof GetScriptClassesSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const files = await walkDir(ctx.sourceDir, ['.cs']);
    const gameFiles = files.filter(f => !path.basename(f).endsWith('.Build.cs') && !path.basename(f).endsWith('.Gen.cs'));

    const filter = args.filter?.toLowerCase();
    const output: string[] = [];

    for (const f of gameFiles) {
      const base = path.basename(f);
      const source = await fs.readFile(f, 'utf-8').catch(() => null);
      if (!source) continue;

      const rel = path.relative(ctx.projectPath, f);
      const classes = parseClass(source, rel);

      for (const cls of classes) {
        if (filter &&
          !base.toLowerCase().includes(filter) &&
          !cls.className.toLowerCase().includes(filter)) continue;

        output.push(`## ${cls.className}${cls.baseClass ? ` : ${cls.baseClass}` : ''}`);
        output.push(`File: ${cls.file}${cls.namespace ? `  |  Namespace: ${cls.namespace}` : ''}`);

        if (cls.fields.length > 0) {
          output.push('Fields:');
          for (const f of cls.fields) {
            const attrs = f.attributes.length > 0 ? `  [${f.attributes.join(', ')}]` : '';
            output.push(`  ${f.access} ${f.type} ${f.name}${attrs}`);
          }
        }

        if (cls.methods.length > 0) {
          output.push('Methods:');
          for (const m of cls.methods) {
            const attrs = m.attributes.length > 0 ? `  [${m.attributes.join(', ')}]` : '';
            output.push(`  ${m.access} ${m.returnType} ${m.name}()${attrs}`);
          }
        }

        output.push('');
      }
    }

    if (output.length === 0) return toolResult('No classes found.');
    return toolResult(output.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

export async function handleFindReferences(
  args: z.infer<typeof FindReferencesSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const files = await walkDir(ctx.sourceDir, ['.cs']);
    if (args.scope === 'all') {
      files.push(...await walkDir(ctx.projectPath, ['.md']));
    }
    const uniqueFiles = [...new Set(files)].sort();

    const results: string[] = [];
    let total = 0;

    for (const f of uniqueFiles) {
      const source = await fs.readFile(f, 'utf-8').catch(() => null);
      if (!source) continue;

      const lines = source.split('\n');
      const hits: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(args.symbol)) {
          hits.push(`  ${i + 1}: ${lines[i].trim()}`);
          total++;
        }
      }

      if (hits.length > 0) {
        results.push(`${path.relative(ctx.projectPath, f)}:`);
        results.push(...hits);
        results.push('');
      }
    }

    if (results.length === 0) return toolResult(`No references to "${args.symbol}" found.`);
    return toolResult(`Found ${total} reference(s) to "${args.symbol}":\n\n${results.join('\n')}`);
  } catch (e) {
    return toolError(e);
  }
}

export async function handleListNetworkedScripts(
  _args: unknown,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const files = await walkDir(ctx.sourceDir, ['.cs']);
    const patterns = ['[NetworkReplicated]', '[NetworkRpc]', '[NetworkSync]', 'NetworkReplicated', 'NetworkScript', 'INetworkObject'];

    const output: string[] = [];

    for (const f of files) {
      if (path.basename(f).endsWith('.Build.cs') || path.basename(f).endsWith('.Gen.cs')) continue;
      const source = await fs.readFile(f, 'utf-8').catch(() => null);
      if (!source) continue;

      const lines = source.split('\n');
      const hits: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (patterns.some(p => line.includes(p))) {
          hits.push(`  ${i + 1}: ${line.trim()}`);
        }
      }

      if (hits.length > 0) {
        output.push(`${path.relative(ctx.projectPath, f)}:`);
        output.push(...hits);
        output.push('');
      }
    }

    if (output.length === 0) {
      return toolResult('No networked scripts found. No [NetworkReplicated], [NetworkRpc], or NetworkScript usage detected.');
    }

    return toolResult(`Networked code found:\n\n${output.join('\n')}`);
  } catch (e) {
    return toolError(e);
  }
}
