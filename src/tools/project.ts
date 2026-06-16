import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, safeReadFile } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const GetProjectInfoSchema = z.object({});

export const GetGameSettingsSchema = z.object({});

export async function handleGetProjectInfo(_args: unknown, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const projRaw = await safeReadFile(ctx.flaxprojPath);
    if (!projRaw) return toolError(new Error('.flaxproj file not found'));
    const proj = JSON.parse(projRaw) as Record<string, unknown>;

    const metaPath = path.join(ctx.projectPath, 'meta.xml');
    const metaRaw = await safeReadFile(metaPath);

    const contentEntries = await fs.readdir(ctx.contentDir).catch(() => [] as string[]);
    const sourceEntries = await fs.readdir(ctx.sourceDir).catch(() => [] as string[]);

    const lines = [
      '## Project Config',
      `Name:            ${proj['Name'] ?? 'unknown'}`,
      `Version:         ${proj['Version'] ?? 'unknown'}`,
      `Company:         ${proj['Company'] ?? ''}`,
      `GameTarget:      ${proj['GameTarget'] ?? ''}`,
      `EditorTarget:    ${proj['EditorTarget'] ?? ''}`,
      `MinEngineVersion:${proj['MinEngineVersion'] ?? ''}`,
      `DefaultScene:    ${proj['DefaultScene'] ?? ''}`,
      '',
      '## Directory Layout',
      `Content/: ${contentEntries.join(', ')}`,
      `Source/:  ${sourceEntries.join(', ')}`,
    ];

    if (metaRaw) {
      lines.push('', '## meta.xml', metaRaw.trim());
    }

    return toolResult(lines.join('\n'));
  } catch (e) {
    return toolError(e);
  }
}

export async function handleGetGameSettings(_args: unknown, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const settingsPath = path.join(ctx.contentDir, 'GameSettings.json');
    const raw = await safeReadFile(settingsPath);
    if (!raw) return toolError(new Error('GameSettings.json not found — is this a valid Flax project?'));
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return toolResult(JSON.stringify(parsed, null, 2));
  } catch (e) {
    return toolError(e);
  }
}
