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

const INSTALL_RELATIVE_PATH = 'Source/Game/MCP/FlaxMcpBridge.cs';
const BUNDLE_RELATIVE_PATH = 'bridge/FlaxMcpBridge.cs';

export const InstallEditorBridgeSchema = z.object({
  dry_run: z.boolean().optional().default(false)
    .describe('Preview the exact installation decision without changing the project.'),
  expected_hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
    .describe('Required current installed SHA-256 when replacing unless force is true.'),
  force: z.boolean().optional().default(false)
    .describe('Allow replacement without expected_hash. A supplied expected_hash must still match.'),
});

export const GetEditorBridgeInstallationSchema = z.object({});

interface BridgeArtifact {
  content: string;
  hash: string;
  version: string | null;
}

export interface BridgeInstallationInfo {
  target: typeof INSTALL_RELATIVE_PATH;
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

function installTarget(ctx: ProjectMeta): string {
  return path.join(ctx.projectPath, ...INSTALL_RELATIVE_PATH.split('/'));
}

export async function inspectEditorBridgeInstallation(
  ctx: ProjectMeta,
  bundledPath?: string,
): Promise<BridgeInstallationInfo> {
  let bundled: BridgeArtifact | null = null;
  try {
    bundled = await readArtifact(bundledPath ?? await locateBundledEditorBridge());
  } catch (error: unknown) {
    if (bundledPath || !(error instanceof ToolDomainError && error.code === 'NOT_FOUND')) throw error;
  }

  const target = await assertWritePathWithinRoot(installTarget(ctx), ctx.projectPath);
  const installedContent = await readConfinedText(target, ctx.projectPath);
  const installed = installedContent === null ? null : {
    content: installedContent,
    hash: sha256(installedContent),
    version: bridgeVersion(installedContent),
  };

  return {
    target: INSTALL_RELATIVE_PATH,
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
  record: { replaced: boolean; before_hash: string | null; after_hash: string },
): Promise<void> {
  const auditFile = path.join(ctx.projectPath, '.flax-mcp', 'bridge-install-audit.jsonl');
  await assertWritePathWithinRoot(auditFile, ctx.projectPath);
  await fs.mkdir(path.dirname(auditFile), { recursive: true });
  await assertWritePathWithinRoot(auditFile, ctx.projectPath);
  await fs.appendFile(auditFile, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: 'install_editor_bridge',
    target: INSTALL_RELATIVE_PATH,
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
    const target = await assertWritePathWithinRoot(installTarget(ctx), ctx.projectPath);
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
      await appendInstallAudit(ctx, {
        replaced: before !== null,
        before_hash: beforeHash,
        after_hash: bundled.hash,
      }).catch(() => warnings.push('Editor Bridge installed, but the local install audit could not be written.'));
    }
    const data = {
      target: INSTALL_RELATIVE_PATH,
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
        path: INSTALL_RELATIVE_PATH,
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
  _args: unknown,
  ctx: ProjectMeta,
): Promise<ToolResponse> {
  try {
    const data = await inspectEditorBridgeInstallation(ctx);
    return toolResult(JSON.stringify(data, null, 2), { data });
  } catch (error) {
    return toolError(error);
  }
}
