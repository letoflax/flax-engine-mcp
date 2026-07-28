import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ProjectMeta } from '../projectContext.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import {
  assertContentSize,
  assertSha256,
  assertWritePathWithinRoot,
  atomicWriteConfined,
  readConfinedText,
  sha256,
  withTargetLock,
} from '../writeSafety.js';

const DEFAULT_MODULE = 'Game';
const BUNDLE_RELATIVE_PATH = 'bridge/FlaxMcpBridge.cs';
const ModuleName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);

export const InstallEditorBridgeSchema = z.object({
  dry_run: z.boolean().optional().default(false)
    .describe('Preview the exact installation decision without changing the project.'),
  expected_hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
    .describe('Required current installed SHA-256 when replacing unless force is true.'),
  force: z.boolean().optional().default(false)
    .describe('Allow replacement without expected_hash. A supplied expected_hash must still match.'),
  module: ModuleName.optional()
    .describe('Flax module name to install into. Required only when the Editor target has multiple ambiguous modules.'),
});

export const GetEditorBridgeInstallationSchema = z.object({
  module: ModuleName.optional(),
});

interface BridgeArtifact {
  content: string;
  hash: string;
  version: string | null;
}

export interface BridgeInstallationInfo {
  target: string;
  module: string;
  bundled: { available: boolean; version: string | null; hash: string | null };
  installed: { present: boolean; version: string | null; hash: string | null };
  current: boolean;
}

function bridgeVersion(content: string): string | null {
  const match = content.match(/\bBridgeVersion\b\s*(?:=>|=)\s*(?:["']([^"']+)["']|(\d+(?:\.\d+)*))/);
  return match?.[1] ?? match?.[2] ?? null;
}

async function readArtifact(filePath: string): Promise<BridgeArtifact> {
  const content = await fs.readFile(filePath, 'utf8');
  return { content, hash: sha256(content), version: bridgeVersion(content) };
}

export async function locateBundledEditorBridge(): Promise<string> {
  const moduleCandidate = fileURLToPath(new URL(`../../${BUNDLE_RELATIVE_PATH}`, import.meta.url));
  const cwdCandidate = path.resolve(process.cwd(), BUNDLE_RELATIVE_PATH);
  for (const candidate of [...new Set([moduleCandidate, cwdCandidate])]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new ToolDomainError(
    'NOT_FOUND',
    `Bundled Editor Bridge is unavailable. Expected package asset: ${BUNDLE_RELATIVE_PATH}.`,
  );
}

interface InstallLocation { module: string; relativeTarget: string; absoluteTarget: string }

async function findModuleBuildFiles(sourceDir: string, depth = 0): Promise<Array<{ module: string; directory: string }>> {
  if (depth > 5) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const modules: Array<{ module: string; directory: string }> = [];
  for (const entry of entries) {
    const full = path.join(sourceDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      modules.push(...await findModuleBuildFiles(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.Build.cs') && !entry.name.endsWith('Target.Build.cs')) {
      modules.push({ module: entry.name.slice(0, -'.Build.cs'.length), directory: sourceDir });
    }
  }
  return modules;
}

async function editorTargetModules(ctx: ProjectMeta): Promise<Set<string>> {
  const result = new Set<string>();
  let entries: string[];
  try {
    entries = await fs.readdir(ctx.sourceDir);
  } catch {
    return result;
  }
  for (const name of entries.filter(name => name.endsWith('EditorTarget.Build.cs'))) {
    const file = path.join(ctx.sourceDir, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const content = await fs.readFile(file, 'utf8');
      for (const match of content.matchAll(/Modules\.Add\s*\(\s*(?:nameof\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)|["']([^"']+)["'])\s*\)/g)) {
        result.add(match[1] ?? match[2]);
      }
    } catch { /* ignore unreadable target metadata */ }
  }
  return result;
}

async function resolveInstallLocation(ctx: ProjectMeta, requestedModule?: string): Promise<InstallLocation> {
  const discovered = await findModuleBuildFiles(ctx.sourceDir);
  const unique = [...new Map(discovered.map(item => [item.module.toLocaleLowerCase(), item])).values()];
  let selected: { module: string; directory: string } | undefined;
  if (requestedModule) {
    selected = unique.find(item => item.module.toLocaleLowerCase() === requestedModule.toLocaleLowerCase());
    if (!selected) {
      throw new ToolDomainError('VALIDATION_FAILED', `Flax module "${requestedModule}" was not found under Source/.`, {
        modules: unique.map(item => item.module),
      });
    }
  } else if (unique.length === 0) {
    // Preserve template/bootstrap behavior when Build.cs files have not been
    // generated yet. Once modules exist, never invent a detached Game folder.
    selected = { module: DEFAULT_MODULE, directory: path.join(ctx.sourceDir, DEFAULT_MODULE) };
  } else {
    const referenced = await editorTargetModules(ctx);
    const editorCandidates = unique.filter(item => [...referenced].some(name => name.toLocaleLowerCase() === item.module.toLocaleLowerCase()));
    if (editorCandidates.length === 1) selected = editorCandidates[0];
    else if (unique.length === 1) selected = unique[0];
    else {
      throw new ToolDomainError('VALIDATION_FAILED', 'Multiple Flax modules are available; specify the module argument explicitly.', {
        modules: unique.map(item => item.module),
        editorTargetModules: [...referenced],
      });
    }
  }
  const relativeDirectory = path.relative(ctx.projectPath, selected.directory).replaceAll('\\', '/');
  const relativeTarget = `${relativeDirectory}/MCP/FlaxMcpBridge.cs`;
  return {
    module: selected.module,
    relativeTarget,
    absoluteTarget: path.join(selected.directory, 'MCP', 'FlaxMcpBridge.cs'),
  };
}

export async function inspectEditorBridgeInstallation(
  ctx: ProjectMeta,
  bundledPath?: string,
  requestedModule?: string,
): Promise<BridgeInstallationInfo> {
  let bundled: BridgeArtifact | null = null;
  try {
    bundled = await readArtifact(bundledPath ?? await locateBundledEditorBridge());
  } catch (error: unknown) {
    if (bundledPath || !(error instanceof ToolDomainError && error.code === 'NOT_FOUND')) throw error;
  }

  const location = await resolveInstallLocation(ctx, requestedModule);
  const target = await assertWritePathWithinRoot(location.absoluteTarget, ctx.projectPath);
  const installedContent = await readConfinedText(target, ctx.projectPath);
  const installed = installedContent === null ? null : {
    content: installedContent,
    hash: sha256(installedContent),
    version: bridgeVersion(installedContent),
  };

  return {
    target: location.relativeTarget,
    module: location.module,
    bundled: {
      available: bundled !== null,
      version: bundled?.version ?? null,
      hash: bundled?.hash ?? null,
    },
    installed: {
      present: installed !== null,
      version: installed?.version ?? null,
      hash: installed?.hash ?? null,
    },
    current: bundled !== null && installed !== null && bundled.hash === installed.hash,
  };
}

async function appendInstallAudit(
  ctx: ProjectMeta,
  target: string,
  record: { replaced: boolean; before_hash: string | null; after_hash: string },
): Promise<void> {
  const auditFile = path.join(ctx.projectPath, '.flax-mcp', 'bridge-install-audit.jsonl');
  await assertWritePathWithinRoot(auditFile, ctx.projectPath);
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  await assertWritePathWithinRoot(auditFile, ctx.projectPath);
  await fs.appendFile(auditFile, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: 'install_editor_bridge',
    target,
    success: true,
    replaced: record.replaced,
    before_hash: record.before_hash,
    after_hash: record.after_hash,
  })}\n`, 'utf8');
}

export async function installEditorBridge(
  args: z.infer<typeof InstallEditorBridgeSchema>,
  ctx: ProjectMeta,
  bundledPath?: string,
): Promise<ToolResponse> {
  try {
    assertSha256(args.expected_hash);
    const bundled = await readArtifact(bundledPath ?? await locateBundledEditorBridge());
    assertContentSize(bundled.content);
    const location = await resolveInstallLocation(ctx, args.module);
    const target = await assertWritePathWithinRoot(location.absoluteTarget, ctx.projectPath);
    let before: string | null = null;
    let unchanged = false;

    const perform = async (): Promise<void> => {
      before = await readConfinedText(target, ctx.projectPath);
      const beforeHash = before === null ? null : sha256(before);
      unchanged = beforeHash === bundled.hash;
      if (unchanged) return;
      if (args.expected_hash !== undefined && beforeHash !== args.expected_hash.toLowerCase()) {
        throw new ToolDomainError('FILE_CHANGED', 'Installed Editor Bridge hash does not match expected_hash.');
      }
      if (before !== null && args.expected_hash === undefined && !args.force) {
        throw new ToolDomainError(
          'FILE_EXISTS',
          'Editor Bridge is already installed with different content. Supply its expected_hash or set force:true.',
        );
      }
      if (!args.dry_run) {
        await atomicWriteConfined(target, bundled.content, ctx.projectPath, before);
      }
    };

    // Dry-run must not create a lock file or destination directory.
    if (args.dry_run) await perform();
    else await withTargetLock(target, ctx.projectPath, perform);

    const beforeHash = before === null ? null : sha256(before);
    const action = unchanged ? 'unchanged' : before === null ? 'create' : 'replace';
    const warnings: string[] = [];
    if (!args.dry_run && !unchanged) {
      await appendInstallAudit(ctx, location.relativeTarget, {
        replaced: before !== null,
        before_hash: beforeHash,
        after_hash: bundled.hash,
      }).catch(() => warnings.push('Editor Bridge installed, but the local install audit could not be written.'));
    }
    const data = {
      target: location.relativeTarget,
      module: location.module,
      action,
      dry_run: args.dry_run,
      bundled_version: bundled.version,
      bundled_hash: bundled.hash,
      installed_before_hash: beforeHash,
      restart_required: !args.dry_run && !unchanged,
      instructions: unchanged
        ? 'The bundled Editor Bridge is already installed.'
        : args.dry_run
          ? 'Run again with dry_run:false to install it.'
          : 'Open or restart Flax Editor and wait for C# compilation, then call editor_get_status.',
    };
    return toolResult(JSON.stringify(data, null, 2), {
      data,
      warnings,
      changes: args.dry_run || unchanged ? [] : [{
        kind: before === null ? 'file.created' : 'file.replaced',
        path: location.relativeTarget,
      }],
    });
  } catch (error) {
    return toolError(error);
  }
}

export async function handleInstallEditorBridge(
  args: z.infer<typeof InstallEditorBridgeSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  return installEditorBridge(args, ctx);
}

export async function handleGetEditorBridgeInstallation(
  args: z.infer<typeof GetEditorBridgeInstallationSchema>,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  try {
    const data = await inspectEditorBridgeInstallation(ctx, undefined, args.module);
    return toolResult(JSON.stringify(data, null, 2), { data });
  } catch (error) {
    return toolError(error);
  }
}
