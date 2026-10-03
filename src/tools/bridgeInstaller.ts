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
const RUNTIME_BUNDLE_RELATIVE_PATH = 'bridge/FlaxMcpRuntimeBridge.cs';
const EDITOR_FILE_NAME = 'FlaxMcpBridge.cs';
const RUNTIME_FILE_NAME = 'FlaxMcpRuntimeBridge.cs';
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
  include_runtime: z.boolean().optional().default(false)
    .describe('Also install the runtime (cooked game) bridge FlaxMcpRuntimeBridge.cs (bridge v35) into the same MCP/ folder. It compiles to nothing in the Editor and in Release builds. Install it before cooking a Development build; the same replacement guards apply to it.'),
  runtime_expected_hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
    .describe('With include_runtime: required current installed SHA-256 of FlaxMcpRuntimeBridge.cs when replacing it unless force is true.'),
});

export const GetEditorBridgeInstallationSchema = z.object({
  module: ModuleName.optional(),
});

interface BridgeArtifact {
  content: string;
  hash: string;
  version: string | null;
}

export interface BridgeFileInstallationInfo {
  target: string;
  bundled: { available: boolean; version: string | null; hash: string | null };
  installed: { present: boolean; version: string | null; hash: string | null };
  current: boolean;
}

/** The top-level fields describe the Editor bridge; `runtime` describes the runtime (cooked game) bridge file. */
export interface BridgeInstallationInfo extends BridgeFileInstallationInfo {
  module: string;
  runtime: BridgeFileInstallationInfo;
}

function bridgeVersion(content: string): string | null {
  const match = content.match(/\bBridgeVersion\b\s*(?:=>|=)\s*(?:["']([^"']+)["']|(\d+(?:\.\d+)*))/);
  return match?.[1] ?? match?.[2] ?? null;
}

async function readArtifact(filePath: string): Promise<BridgeArtifact> {
  const content = await fs.readFile(filePath, 'utf8');
  return { content, hash: sha256(content), version: bridgeVersion(content) };
}

async function locateBundled(relativePath: string, label: string): Promise<string> {
  const moduleCandidate = fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
  const cwdCandidate = path.resolve(process.cwd(), relativePath);
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
    `Bundled ${label} is unavailable. Expected package asset: ${relativePath}.`,
  );
}

export function locateBundledEditorBridge(): Promise<string> {
  return locateBundled(BUNDLE_RELATIVE_PATH, 'Editor Bridge');
}

export function locateBundledRuntimeBridge(): Promise<string> {
  return locateBundled(RUNTIME_BUNDLE_RELATIVE_PATH, 'Runtime Bridge');
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

async function resolveInstallLocation(ctx: ProjectMeta, requestedModule?: string, fileName = EDITOR_FILE_NAME): Promise<InstallLocation> {
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
  const relativeTarget = `${relativeDirectory}/MCP/${fileName}`;
  return {
    module: selected.module,
    relativeTarget,
    absoluteTarget: path.join(selected.directory, 'MCP', fileName),
  };
}

async function readBundledOrNull(explicitPath: string | undefined, locate: () => Promise<string>): Promise<BridgeArtifact | null> {
  try {
    return await readArtifact(explicitPath ?? await locate());
  } catch (error: unknown) {
    if (explicitPath || !(error instanceof ToolDomainError && error.code === 'NOT_FOUND')) throw error;
    return null;
  }
}

async function inspectBridgeFile(ctx: ProjectMeta, location: InstallLocation, bundled: BridgeArtifact | null): Promise<BridgeFileInstallationInfo> {
  const target = await assertWritePathWithinRoot(location.absoluteTarget, ctx.projectPath);
  const installedContent = await readConfinedText(target, ctx.projectPath);
  const installed = installedContent === null ? null : {
    content: installedContent,
    hash: sha256(installedContent),
    version: bridgeVersion(installedContent),
  };
  return {
    target: location.relativeTarget,
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

export async function inspectEditorBridgeInstallation(
  ctx: ProjectMeta,
  bundledPath?: string,
  requestedModule?: string,
  bundledRuntimePath?: string,
): Promise<BridgeInstallationInfo> {
  const bundled = await readBundledOrNull(bundledPath, locateBundledEditorBridge);
  const bundledRuntime = await readBundledOrNull(bundledRuntimePath, locateBundledRuntimeBridge);
  const location = await resolveInstallLocation(ctx, requestedModule);
  const runtimeLocation = await resolveInstallLocation(ctx, requestedModule, RUNTIME_FILE_NAME);
  const editor = await inspectBridgeFile(ctx, location, bundled);
  const runtime = await inspectBridgeFile(ctx, runtimeLocation, bundledRuntime);
  return { ...editor, module: location.module, runtime };
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

interface FileInstallPlan {
  location: InstallLocation;
  target: string;
  bundled: BridgeArtifact;
  expectedHash: string | undefined;
}

interface FileInstallOutcome {
  action: 'unchanged' | 'create' | 'replace';
  beforeHash: string | null;
}

/** Decides what installing one file would do; throws the same refusals a real install would. Reads only. */
async function decideInstall(plan: FileInstallPlan, force: boolean, ctx: ProjectMeta): Promise<FileInstallOutcome & { before: string | null }> {
  const before = await readConfinedText(plan.target, ctx.projectPath);
  const beforeHash = before === null ? null : sha256(before);
  if (beforeHash === plan.bundled.hash) return { action: 'unchanged', beforeHash, before };
  if (plan.expectedHash !== undefined && beforeHash !== plan.expectedHash.toLowerCase()) {
    throw new ToolDomainError('FILE_CHANGED', `Installed ${path.basename(plan.target)} hash does not match expected_hash.`);
  }
  if (before !== null && plan.expectedHash === undefined && !force) {
    throw new ToolDomainError(
      'FILE_EXISTS',
      `${path.basename(plan.target)} is already installed with different content. Supply its expected hash or set force:true.`,
    );
  }
  return { action: before === null ? 'create' : 'replace', beforeHash, before };
}

async function applyInstall(plan: FileInstallPlan, args: { dry_run: boolean; force: boolean }, ctx: ProjectMeta): Promise<FileInstallOutcome> {
  let outcome: FileInstallOutcome & { before: string | null } = { action: 'unchanged', beforeHash: null, before: null };
  const perform = async (): Promise<void> => {
    outcome = await decideInstall(plan, args.force, ctx);
    if (outcome.action === 'unchanged' || args.dry_run) return;
    await atomicWriteConfined(plan.target, plan.bundled.content, ctx.projectPath, outcome.before);
  };
  // Dry-run must not create a lock file or destination directory.
  if (args.dry_run) await perform();
  else await withTargetLock(plan.target, ctx.projectPath, perform);
  return { action: outcome.action, beforeHash: outcome.beforeHash };
}

export async function installEditorBridge(
  args: z.infer<typeof InstallEditorBridgeSchema>,
  ctx: ProjectMeta,
  bundledPath?: string,
  bundledRuntimePath?: string,
): Promise<ToolResponse> {
  try {
    assertSha256(args.expected_hash);
    assertSha256(args.runtime_expected_hash);
    const bundled = await readArtifact(bundledPath ?? await locateBundledEditorBridge());
    assertContentSize(bundled.content);
    const location = await resolveInstallLocation(ctx, args.module);
    const editorPlan: FileInstallPlan = {
      location,
      target: await assertWritePathWithinRoot(location.absoluteTarget, ctx.projectPath),
      bundled,
      expectedHash: args.expected_hash,
    };
    let runtimePlan: FileInstallPlan | undefined;
    if (args.include_runtime) {
      const bundledRuntime = await readArtifact(bundledRuntimePath ?? await locateBundledRuntimeBridge());
      assertContentSize(bundledRuntime.content);
      const runtimeLocation = await resolveInstallLocation(ctx, args.module, RUNTIME_FILE_NAME);
      runtimePlan = {
        location: runtimeLocation,
        target: await assertWritePathWithinRoot(runtimeLocation.absoluteTarget, ctx.projectPath),
        bundled: bundledRuntime,
        expectedHash: args.runtime_expected_hash,
      };
    }
    if (args.runtime_expected_hash !== undefined && !args.include_runtime) {
      throw new ToolDomainError('VALIDATION_FAILED', 'runtime_expected_hash requires include_runtime:true.');
    }

    // Refuse before writing anything: a runtime file that would be refused must not leave the editor file half-updated.
    if (runtimePlan && !args.dry_run) {
      await decideInstall(editorPlan, args.force, ctx);
      await decideInstall(runtimePlan, args.force, ctx);
    }
    const editorOutcome = await applyInstall(editorPlan, args, ctx);
    const runtimeOutcome = runtimePlan ? await applyInstall(runtimePlan, args, ctx) : undefined;

    const warnings: string[] = [];
    const changes: unknown[] = [];
    const written: Array<{ plan: FileInstallPlan; outcome: FileInstallOutcome }> = [
      { plan: editorPlan, outcome: editorOutcome },
      ...(runtimePlan && runtimeOutcome ? [{ plan: runtimePlan, outcome: runtimeOutcome }] : []),
    ];
    for (const { plan, outcome } of written) {
      if (args.dry_run || outcome.action === 'unchanged') continue;
      changes.push({ kind: outcome.action === 'create' ? 'file.created' : 'file.replaced', path: plan.location.relativeTarget });
      await appendInstallAudit(ctx, plan.location.relativeTarget, {
        replaced: outcome.beforeHash !== null,
        before_hash: outcome.beforeHash,
        after_hash: plan.bundled.hash,
      }).catch(() => warnings.push(`${path.basename(plan.target)} installed, but the local install audit could not be written.`));
    }
    const anyChange = written.some(({ outcome }) => outcome.action !== 'unchanged');
    const allUnchanged = !anyChange;
    const data = {
      target: location.relativeTarget,
      module: location.module,
      action: editorOutcome.action,
      dry_run: args.dry_run,
      bundled_version: bundled.version,
      bundled_hash: bundled.hash,
      installed_before_hash: editorOutcome.beforeHash,
      ...(runtimePlan && runtimeOutcome ? {
        runtime: {
          target: runtimePlan.location.relativeTarget,
          action: runtimeOutcome.action,
          bundled_version: runtimePlan.bundled.version,
          bundled_hash: runtimePlan.bundled.hash,
          installed_before_hash: runtimeOutcome.beforeHash,
        },
      } : {}),
      restart_required: !args.dry_run && anyChange,
      instructions: allUnchanged
        ? (runtimePlan ? 'The bundled Editor Bridge and Runtime Bridge are already installed.' : 'The bundled Editor Bridge is already installed.')
        : args.dry_run
          ? 'Run again with dry_run:false to install it.'
          : `Open or restart Flax Editor and wait for C# compilation, then call editor_get_status.${runtimePlan ? ' The Runtime Bridge takes effect in the next cooked Development build (build_cook).' : ''}`,
    };
    return toolResult(JSON.stringify(data, null, 2), { data, warnings, changes: args.dry_run ? [] : changes });
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
