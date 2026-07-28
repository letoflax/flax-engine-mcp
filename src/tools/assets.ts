import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, safeReadFile, assertSafePath } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const ListAssetsSchema = z.object({
  type: z.enum(['all', 'scene', 'material', 'settings', 'other']).optional().default('all'),
  directory: z.string().optional().describe('Subdirectory within Content/ (e.g. "Materials", "Settings")'),
});

export const GetSceneActorsSchema = z.object({
  scene: z.string().optional().describe('Scene file name or relative path. Defaults to DefaultScene from .flaxproj'),
  filter_type: z.string().optional().describe('Filter actors by TypeName substring (e.g. "Script", "StaticModel")'),
  include_transforms: z.boolean().optional().default(false),
});

interface FlaxAsset {
  ID?: string;
  TypeName?: string;
  [key: string]: unknown;
}

const FLAX_MAGIC = 'CFWF';
const FLAX_GUID_OFFSET = 0x1c;
const FLAX_TYPENAME_OFFSET = 0x2c;

async function readBinaryAssetHeader(filePath: string): Promise<{ typeName: string; guid: string } | null> {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.length <= FLAX_TYPENAME_OFFSET || data.subarray(0, 4).toString('ascii') !== FLAX_MAGIC) {
      return null;
    }

    let end = FLAX_TYPENAME_OFFSET;
    while (end + 1 < data.length && (data[end] !== 0 || data[end + 1] !== 0)) end += 2;
    return {
      typeName: data.subarray(FLAX_TYPENAME_OFFSET, end).toString('utf16le'),
      guid: data.subarray(FLAX_GUID_OFFSET, FLAX_GUID_OFFSET + 16).toString('hex'),
    };
  } finally {
    await handle.close();
  }
}

export async function handleListAssets(
  args: z.infer<typeof ListAssetsSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let searchRoot = ctx.contentDir;
    if (args.directory) {
      searchRoot = path.resolve(ctx.contentDir, args.directory);
      assertSafePath(searchRoot, ctx.projectPath);
    }

    const allFiles = await walkDir(searchRoot, []);

    const results: string[] = [];
    for (const f of allFiles) {
      const ext = path.extname(f);
      const base = path.basename(f);
      const rel = path.relative(ctx.projectPath, f);
      const binaryHeader = ext === '.flax' ? await readBinaryAssetHeader(f) : null;

      let assetType = 'other';
      if (ext === '.scene') assetType = 'scene';
      else if (ext === '.flax') {
        assetType = binaryHeader && /(?:^|\.)Material(?:Instance)?$/i.test(binaryHeader.typeName) ? 'material' : 'other';
      }
      else if (ext === '.json' && f.includes('Settings')) assetType = 'settings';

      if (args.type !== 'all' && args.type !== assetType) continue;

      let guid = '';
      if (ext === '.flax') {
        guid = binaryHeader?.guid ?? '';
      } else if (ext === '.scene' || ext === '.json') {
        const raw = await safeReadFile(f);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as FlaxAsset;
            guid = parsed.ID ?? '';
          } catch { /* not valid JSON */ }
        }
      }

      results.push(`${assetType.padEnd(10)} ${base.padEnd(40)} ${guid.padEnd(34)} ${rel}`);
    }

    if (results.length === 0) return toolResult('No assets found.');

    const header = `${'Type'.padEnd(10)} ${'Name'.padEnd(40)} ${'GUID'.padEnd(34)} Path`;
    const sep = '-'.repeat(header.length);
    return toolResult([header, sep, ...results].join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

interface SceneActor {
  ID?: string;
  TypeName?: string;
  ParentID?: string;
  Name?: string;
  V?: Record<string, unknown>;
  Transform?: unknown;
  [key: string]: unknown;
}

export async function handleGetSceneActors(
  args: z.infer<typeof GetSceneActorsSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    let scenePath: string | null = null;

    if (args.scene) {
      if (args.scene.includes('/') || args.scene.endsWith('.scene')) {
        scenePath = path.resolve(ctx.contentDir, args.scene);
        assertSafePath(scenePath, ctx.projectPath);
      } else {
        const scenes = await walkDir(ctx.contentDir, ['.scene']);
        scenePath = scenes.find(s => path.basename(s) === args.scene || path.basename(s) === args.scene + '.scene') ?? null;
      }
    } else {
      const projRaw = await safeReadFile(ctx.flaxprojPath);
      if (projRaw) {
        const proj = JSON.parse(projRaw) as { DefaultScene?: string };
        const defaultId = proj.DefaultScene;
        const scenes = await walkDir(ctx.contentDir, ['.scene']);
        if (defaultId) {
          for (const s of scenes) {
            const raw = await safeReadFile(s);
            if (raw) {
              try {
                const parsed = JSON.parse(raw) as FlaxAsset;
                if (parsed.ID === defaultId) { scenePath = s; break; }
              } catch { /* skip */ }
            }
          }
        }
        if (!scenePath && scenes.length > 0) scenePath = scenes[0];
      }
    }

    if (!scenePath) return toolError(new Error('No scene file found.'));

    const raw = await safeReadFile(scenePath);
    if (!raw) return toolError(new Error(`Scene file not found: ${scenePath}`));

    const parsed = JSON.parse(raw) as { Data?: SceneActor[] };
    const actors: SceneActor[] = Array.isArray(parsed.Data) ? parsed.Data : [];

    let filtered = actors;
    if (args.filter_type) {
      const lower = args.filter_type.toLowerCase();
      filtered = actors.filter(a => (a.TypeName ?? '').toLowerCase().includes(lower));
    }

    const idToActor = new Map(actors.map(a => [a.ID, a]));
    const lines: string[] = [`Scene: ${path.basename(scenePath)} (${filtered.length} actors)\n`];

    function getDepth(actor: SceneActor): { depth: number; cyclic: boolean } {
      const visited = new Set<string>();
      let current: SceneActor | undefined = actor;
      let depth = 0;

      while (current?.ParentID) {
        if (visited.has(current.ParentID)) return { depth, cyclic: true };
        visited.add(current.ParentID);
        const parent = idToActor.get(current.ParentID);
        depth++;
        if (!parent || depth >= actors.length) return { depth, cyclic: depth >= actors.length };
        current = parent;
      }
      return { depth, cyclic: false };
    }

    for (const actor of filtered) {
      const { depth, cyclic } = getDepth(actor);
      const indent = '  '.repeat(depth);
      const name = actor.Name ?? '(unnamed)';
      const type = actor.TypeName ?? '';
      let line = `${indent}• ${name} [${type}]${cyclic ? ' ⚠ cyclic parent reference' : ''}`;

      if (args.include_transforms && actor.Transform) {
        line += ` T:${JSON.stringify(actor.Transform)}`;
      }

      const scripts = actors.filter(a => a.ParentID === actor.ID && (a.TypeName ?? '').startsWith('Game.'));
      if (scripts.length > 0) {
        line += ` — scripts: ${scripts.map(s => s.TypeName).join(', ')}`;
      }

      lines.push(line);
    }

    return toolResult(lines.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}
