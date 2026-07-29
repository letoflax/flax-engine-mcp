import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, assertSafePath } from '../projectContext.js';
import { toolResult, toolError, ToolDomainError, ToolResponse } from '../errors.js';
import { inspectEditorBridge } from './serverStatus.js';
import { AssetReimportSchema, handleAssetReimport } from './assetImport.js';

export const GetAssetInfoSchema = z.object({
  path: z.string().describe('Asset path relative to project root, or just the filename (e.g. "Blue Material.flax")'),
});

export const ReimportAssetSchema = z.object({
  path: z.string().describe('Asset path relative to project root or filename'),
  type: z.string().optional().describe('Deprecated: the safe reimport API preserves the existing asset type.'),
  open_editor: z.boolean().optional().default(false)
    .describe('Deprecated safe compatibility flag. This server never launches an editor process.'),
  dry_run: z.boolean().optional().default(false),
  wait: z.boolean().optional().default(false),
  timeout_ms: z.number().int().min(250).max(30_000).optional().default(10_000),
  operation_id: z.string().regex(/^[0-9a-fA-F]{32}$/).optional(),
  idempotency_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict();

const FLAX_MAGIC = 'CFWF';
const TYPENAME_OFFSET = 0x2C;
const GUID_OFFSET = 0x1C;
const GUID_LEN = 16;

function readFlaxBinary(buf: Buffer): { typeName: string; guid: string; version: number } | null {
  if (buf.length < TYPENAME_OFFSET + 4 || buf.slice(0, 4).toString('ascii') !== FLAX_MAGIC) return null;
  const version = buf.readUInt32LE(4);
  const guid = buf.slice(GUID_OFFSET, GUID_OFFSET + GUID_LEN).toString('hex');
  let end = TYPENAME_OFFSET;
  while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
  return { typeName: end > TYPENAME_OFFSET ? buf.slice(TYPENAME_OFFSET, end).toString('utf16le') : '(unknown)', guid, version };
}

async function resolveAsset(input: string, ctx: ProjectMeta): Promise<string> {
  const direct = path.resolve(ctx.projectPath, input);
  try { await fs.access(direct); return direct; } catch { /* fall through */ }
  const all = await walkDir(ctx.contentDir, []);
  const match = all.find(f => path.basename(f) === input || path.basename(f) === input + '.flax');
  if (match) return match;
  throw new Error(`Asset "${input}" not found. Use list_assets to browse.`);
}

export async function handleGetAssetInfo(args: z.infer<typeof GetAssetInfoSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
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
    if (ext === '.json' || ext === '.scene') {
      const parsed = JSON.parse(await fs.readFile(resolved, 'utf-8')) as Record<string, unknown>;
      lines.push(`Type:   ${parsed['TypeName'] ?? '(none)'}`);
      lines.push(`ID:     ${parsed['ID'] ?? '(none)'}`);
      const data = parsed['Data'];
      if (Array.isArray(data)) lines.push(`Entries: ${data.length}`);
      else if (data && typeof data === 'object') lines.push('Data keys: ' + Object.keys(data).join(', '));
      return toolResult(lines.join('\n'));
    }
    if (ext === '.flax') {
      const info = readFlaxBinary(await fs.readFile(resolved));
      if (!info) return toolResult([...lines, 'Format: unrecognized binary (not CFWF)'].join('\n'));
      lines.push(`Type:    ${info.typeName}`, `GUID:    ${info.guid}`, `Version: ${info.version}`, '');
      const shortType = info.typeName.split('.').pop() ?? '';
      if (shortType === 'SkinnedModel' || shortType === 'Model') {
        lines.push('Note: skeleton bones and importer metadata require the live editor.');
        lines.push('      Use asset_reimport with a bridge v9 and configured import roots.');
      }
      return toolResult(lines.join('\n'));
    }
    lines.push(`Extension: ${ext} (not a known Flax asset format)`);
    return toolResult(lines.join('\n'));
  } catch (error) {
    return toolError(error);
  }
}

/** Safe compatibility alias: delegate online, otherwise give manual instructions without starting a process. */
export async function handleReimportAsset(args: z.infer<typeof ReimportAssetSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const resolved = await resolveAsset(args.path, ctx);
    assertSafePath(resolved, ctx.projectPath);
    const relative = path.relative(ctx.projectPath, resolved).replaceAll('\\', '/');
    if (!relative.startsWith('Content/')) {
      throw new ToolDomainError('VALIDATION_FAILED', 'reimport_asset only accepts a Content/ asset.');
    }
    const bridge = await inspectEditorBridge(ctx);
    if (bridge.connected && bridge.protocolVersion === '1' && Number(bridge.bridgeVersion) >= 9) {
      if (args.type) {
        throw new ToolDomainError('VALIDATION_FAILED', 'Changing an asset type is not supported by the safe reimport API; omit type to use existing importer metadata.');
      }
      return handleAssetReimport(AssetReimportSchema.parse({
        path: relative,
        dry_run: args.dry_run,
        wait: args.wait,
        timeout_ms: args.timeout_ms,
        operation_id: args.operation_id,
        idempotency_key: args.idempotency_key,
      }), ctx);
    }
    const info = readFlaxBinary(await fs.readFile(resolved));
    const lines = [
      `Asset: ${relative}`,
      `Current type: ${info?.typeName.split('.').pop() ?? 'unknown'}`,
      '',
      'Automated reimport requires a connected bridge v9 and configured --asset-import-root values.',
      'Manual fallback: open this project in Flax Editor, select the asset in Content, then choose Reimport.',
    ];
    if (args.open_editor) lines.push('open_editor:true is intentionally ignored; MCP never launches OS editor processes.');
    return toolResult(lines.join('\n'), {
      mode: bridge.connected ? 'editor-connected' : 'offline',
      data: { asset: relative, mode: 'manual-only', bridgeVersion: bridge.bridgeVersion },
      warnings: ['Deprecated compatibility alias: prefer asset_reimport when a v9 bridge is connected.'],
    });
  } catch (error) {
    return toolError(error);
  }
}
