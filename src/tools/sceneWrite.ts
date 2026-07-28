import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, walkDir, safeReadFile, assertSafePath } from '../projectContext.js';
import { ToolDomainError, toolResult, toolError, ToolResponse } from '../errors.js';
import crypto from 'node:crypto';
import { inspectEditorBridge } from './serverStatus.js';

export const CreateActorSchema = z.object({
  type_name: z.string().describe('Flax TypeName (e.g. "FlaxEngine.EmptyActor", "FlaxEngine.StaticModel", "FlaxEngine.PointLight")'),
  name: z.string().describe('Actor display name'),
  scene: z.string().optional().describe('Scene file name. Defaults to DefaultScene.'),
  parent_id: z.string().optional().describe('Parent actor ID (hex). Defaults to scene root.'),
  position: z.object({ X: z.number(), Y: z.number(), Z: z.number() }).optional().describe('World position'),
  allow_offline_write: z.boolean().optional().default(false)
    .describe('Required explicit opt-in for legacy direct scene serialization when no Editor Bridge is connected.'),
});

export const ModifyActorSchema = z.object({
  actor_id_or_name: z.string().describe('Actor ID (hex) or exact Name to find'),
  scene: z.string().optional().describe('Scene file name. Defaults to DefaultScene.'),
  name: z.string().optional().describe('New display name'),
  active: z.boolean().optional().describe('Set actor active/inactive'),
  position: z.object({ X: z.number(), Y: z.number(), Z: z.number() }).optional().describe('New world position'),
  allow_offline_write: z.boolean().optional().default(false)
    .describe('Required explicit opt-in for legacy direct scene serialization when no Editor Bridge is connected.'),
});

interface SceneActor {
  ID: string;
  TypeName: string;
  ParentID?: string;
  Name?: string;
  IsActive?: boolean;
  Transform?: {
    Translation?: { X: number; Y: number; Z: number };
    Orientation?: { X: number; Y: number; Z: number; W: number };
    Scale?: { X: number; Y: number; Z: number };
  };
  [key: string]: unknown;
}

interface SceneFile {
  ID?: string;
  TypeName?: string;
  Data: SceneActor[];
  [key: string]: unknown;
}

function flaxGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function loadScene(ctx: ProjectMeta, sceneArg?: string): Promise<{ path: string; data: SceneFile }> {
  let scenePath: string | null = null;

  if (sceneArg) {
    const scenes = await walkDir(ctx.contentDir, ['.scene']);
    scenePath = scenes.find(s =>
      path.basename(s) === sceneArg ||
      path.basename(s) === sceneArg + '.scene'
    ) ?? null;
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
              const p = JSON.parse(raw) as SceneFile;
              if (p.ID === defaultId) { scenePath = s; break; }
            } catch { /* skip */ }
          }
        }
      }
      if (!scenePath && scenes.length > 0) scenePath = scenes[0] ?? null;
    }
  }

  if (!scenePath) throw new Error('Scene file not found.');
  assertSafePath(scenePath, ctx.projectPath);

  const raw = await safeReadFile(scenePath);
  if (!raw) throw new Error(`Cannot read scene: ${scenePath}`);

  return { path: scenePath, data: JSON.parse(raw) as SceneFile };
}

async function saveScene(scenePath: string, data: SceneFile): Promise<void> {
  // Backup before writing
  const backupPath = scenePath + '.bak';
  await fs.copyFile(scenePath, backupPath);
  await fs.writeFile(scenePath, JSON.stringify(data, null, '\t'), 'utf-8');
}

async function requireLegacyOfflineWrite(allowed: boolean, ctx: ProjectMeta): Promise<void> {
  if (!allowed) {
    throw new ToolDomainError(
      'VALIDATION_FAILED',
      'Legacy direct scene writes require allow_offline_write:true. Prefer actor_create or actor_update.',
    );
  }
  const bridge = await inspectEditorBridge(ctx);
  if (bridge.connected) {
    throw new ToolDomainError(
      'VALIDATION_FAILED',
      'Direct scene serialization is disabled while Flax Editor is connected. Use actor_create or actor_update.',
    );
  }
}

export async function handleCreateActor(
  args: z.infer<typeof CreateActorSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    await requireLegacyOfflineWrite(args.allow_offline_write, ctx);
    const { path: scenePath, data } = await loadScene(ctx, args.scene);

    // Find scene root ID (first entry with TypeName ending in .Scene)
    const sceneRoot = data.Data.find(a => a.TypeName.endsWith('.Scene'));
    const parentId = args.parent_id ?? sceneRoot?.ID;

    if (!parentId) return toolError(new Error('Could not determine parent ID. Pass parent_id explicitly.'));

    const newId = flaxGuid();
    const newActor: SceneActor = {
      ID: newId,
      TypeName: args.type_name,
      ParentID: parentId,
      Name: args.name,
    };

    if (args.position) {
      newActor.Transform = {
        Translation: args.position,
        Orientation: { X: 0, Y: 0, Z: 0, W: 1 },
        Scale: { X: 1, Y: 1, Z: 1 },
      };
    }

    data.Data.push(newActor);
    await saveScene(scenePath, data);

    const rel = path.relative(ctx.projectPath, scenePath);
    return toolResult(
      `Created actor "${args.name}" (${args.type_name})\nID: ${newId}\nParent: ${parentId}\nScene: ${rel}\nBackup saved to ${path.basename(scenePath)}.bak`
    );
  } catch (e) {
    return toolError(e);
  }
}

export async function handleModifyActor(
  args: z.infer<typeof ModifyActorSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    await requireLegacyOfflineWrite(args.allow_offline_write, ctx);
    const { path: scenePath, data } = await loadScene(ctx, args.scene);

    const actor = data.Data.find(a =>
      a.ID === args.actor_id_or_name ||
      a.Name === args.actor_id_or_name
    );

    if (!actor) {
      return toolError(new Error(`Actor "${args.actor_id_or_name}" not found in scene.`));
    }

    const changes: string[] = [];

    if (args.name !== undefined) {
      actor.Name = args.name;
      changes.push(`Name → "${args.name}"`);
    }

    if (args.active !== undefined) {
      actor.IsActive = args.active;
      changes.push(`IsActive → ${args.active}`);
    }

    if (args.position !== undefined) {
      if (!actor.Transform) {
        actor.Transform = { Orientation: { X: 0, Y: 0, Z: 0, W: 1 }, Scale: { X: 1, Y: 1, Z: 1 } };
      }
      actor.Transform.Translation = args.position;
      changes.push(`Position → (${args.position.X}, ${args.position.Y}, ${args.position.Z})`);
    }

    if (changes.length === 0) return toolResult('Nothing to change. Provide at least one field to update.');

    await saveScene(scenePath, data);

    const rel = path.relative(ctx.projectPath, scenePath);
    return toolResult(
      `Modified actor "${actor.Name ?? actor.ID}" in ${rel}:\n${changes.map(c => `  • ${c}`).join('\n')}\nBackup saved to ${path.basename(scenePath)}.bak`
    );
  } catch (e) {
    return toolError(e);
  }
}
