import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ProjectMeta, walkDir, assertSafePath } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GetAssetInfoSchema = z.object({
  path: z.string().describe('Asset path relative to project root, or just the filename (e.g. "Blue Material.flax")'),
});

export const ReimportAssetSchema = z.object({
  path: z.string().describe('Asset path relative to project root or filename'),
  type: z.string().optional().describe('Desired asset type after reimport, e.g. "SkinnedModel", "Model", "Texture"'),
  open_editor: z.boolean().optional().default(false)
    .describe('Open FlaxEditor with this project so you can reimport manually'),
});

// ponytail: CFWF binary format — TypeName is UTF-16LE null-terminated at offset 0x2C
const FLAX_MAGIC = 'CFWF';
const TYPENAME_OFFSET = 0x2C;
const GUID_OFFSET = 0x1C;
const GUID_LEN = 16;

function readFlaxBinary(buf: Buffer): { typeName: string; guid: string; version: number } | null {
  if (buf.length < TYPENAME_OFFSET + 4) return null;
  if (buf.slice(0, 4).toString('ascii') !== FLAX_MAGIC) return null;

  const version = buf.readUInt32LE(4);
  const guid = buf.slice(GUID_OFFSET, GUID_OFFSET + GUID_LEN).toString('hex');

  // Scan for null-terminator in UTF-16LE
  let end = TYPENAME_OFFSET;
  while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) {
    end += 2;
  }
  const typeName = end > TYPENAME_OFFSET
    ? buf.slice(TYPENAME_OFFSET, end).toString('utf16le')
    : '(unknown)';

  return { typeName, guid, version };
}

async function resolveAsset(input: string, ctx: ProjectMeta): Promise<string> {
  // Try as relative path first
  const direct = path.resolve(ctx.projectPath, input);
  try { await fs.access(direct); return direct; } catch { /* fall through */ }

  // Search by filename
  const all = await walkDir(ctx.contentDir, []);
  const match = all.find(f => path.basename(f) === input || path.basename(f) === input + '.flax');
  if (match) return match;

  throw new Error(`Asset "${input}" not found. Use list_assets to browse.`);
}

export async function handleGetAssetInfo(
  args: z.infer<typeof GetAssetInfoSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const resolved = await resolveAsset(args.path, ctx);
    assertSafePath(resolved, ctx.projectPath);

    const stat = await fs.stat(resolved);
    const rel = path.relative(ctx.projectPath, resolved);
    const ext = path.extname(resolved);

    const lines: string[] = [
      `Asset: ${rel}`,
      `Size:  ${stat.size} bytes`,
      `Modified: ${stat.mtime.toISOString().slice(0, 19).replace('T', ' ')}`,
      '',
    ];

    // Try JSON first (.scene, settings .json)
    if (ext === '.json' || ext === '.scene') {
      const raw = await fs.readFile(resolved, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      lines.push(`Type:   ${parsed['TypeName'] ?? '(none)'}`);
      lines.push(`ID:     ${parsed['ID'] ?? '(none)'}`);
      const data = parsed['Data'];
      if (Array.isArray(data)) {
        lines.push(`Entries: ${data.length}`);
      } else if (data && typeof data === 'object') {
        lines.push('Data keys: ' + Object.keys(data).join(', '));
      }
      return toolResult(lines.join('\n'));
    }

    // Binary .flax
    if (ext === '.flax') {
      const buf = await fs.readFile(resolved);
      const info = readFlaxBinary(buf);

      if (!info) {
        lines.push('Format: unrecognized binary (not CFWF)');
        return toolResult(lines.join('\n'));
      }

      lines.push(`Type:    ${info.typeName}`);
      lines.push(`GUID:    ${info.guid}`);
      lines.push(`Version: ${info.version}`);
      lines.push('');

      const shortType = info.typeName.split('.').pop() ?? '';
      if (shortType === 'SkinnedModel' || shortType === 'Model') {
        lines.push('Note: skeleton bones and import settings are stored in binary chunks — not extractable without editor.');
        lines.push('      Use reimport_asset with open_editor:true to inspect/change in FlaxEditor.');
      }

      return toolResult(lines.join('\n'));
    }

    lines.push(`Extension: ${ext} (not a known Flax asset format)`);
    return toolResult(lines.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

// ponytail: reimport requires live editor — we can open it but not script the reimport.
// Upgrade path: Flax Editor Plugin API (C#) to automate reimport without GUI.
export async function handleReimportAsset(
  args: z.infer<typeof ReimportAssetSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const resolved = await resolveAsset(args.path, ctx);
    assertSafePath(resolved, ctx.projectPath);
    const rel = path.relative(ctx.projectPath, resolved);

    // Show current state first
    const buf = await fs.readFile(resolved);
    const info = readFlaxBinary(buf);
    const currentType = info?.typeName.split('.').pop() ?? 'unknown';

    const lines: string[] = [
      `Asset: ${rel}`,
      `Current type: ${currentType}`,
    ];

    if (args.type) {
      lines.push(`Requested type: ${args.type}`);
      if (args.type === currentType) {
        lines.push('Already this type — nothing to reimport.');
        return toolResult(lines.join('\n'));
      }
    }

    lines.push('');
    lines.push('⚠  Reimport cannot be automated from MCP.');
    lines.push('   Flax has no headless CLI flag for asset reimport.');
    lines.push('   This requires the live editor: right-click asset → Reimport → change Type.');

    if (args.open_editor) {
      const editorPaths = [
        '/home/letofanius/Flax/Editor/Binaries/Editor/Linux/Release/FlaxEditor',
        '/home/letofanius/Flax/Editor/Binaries/Editor/Linux/Development/FlaxEditor',
      ];
      const editorBin = editorPaths.find(async p => { try { await fs.access(p); return true; } catch { return false; } })
        ?? editorPaths[0];

      try {
        await fs.access(editorBin ?? '');
        spawn(editorBin ?? '', ['-project', ctx.projectPath], { detached: true, stdio: 'ignore' }).unref();
        lines.push('');
        lines.push(`Launched FlaxEditor with project: ${ctx.projectPath}`);
        lines.push(`Now reimport "${path.basename(resolved)}" manually in the Content browser.`);
      } catch {
        lines.push('');
        lines.push('FlaxEditor binary not found at expected path.');
      }
    } else {
      lines.push('');
      lines.push('Pass open_editor:true to launch FlaxEditor automatically.');
    }

    return toolResult(lines.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}
