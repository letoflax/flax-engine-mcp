import fs from 'node:fs/promises';
import { z } from 'zod';
import path from 'node:path';
import { ProjectMeta, safeReadFile } from '../projectContext.js';
import { toolResult, toolError, ToolResponse } from '../errors.js';

export const ReadSettingsSchema = z.object({
  name: z.string().describe('Partial name of the settings file (e.g. "Input", "Physics", "Graphics")'),
});

interface FlaxSettings {
  ID?: string;
  TypeName?: string;
  EngineBuild?: number;
  Data?: unknown;
  [key: string]: unknown;
}

export async function handleReadSettings(
  args: z.infer<typeof ReadSettingsSchema>,
  ctx: ProjectMeta
): Promise<ToolResponse> {
  try {
    const entries = await fs.readdir(ctx.settingsDir).catch(() => [] as string[]);
    const jsonFiles = entries.filter(e => e.endsWith('.json'));

    const lower = args.name.toLowerCase();
    const matches = jsonFiles.filter(f => f.toLowerCase().includes(lower));

    if (matches.length === 0) {
      return toolResult(
        `No settings file matching "${args.name}".\nAvailable: ${jsonFiles.join(', ')}`
      );
    }

    if (matches.length > 1) {
      return toolResult(
        `Multiple matches for "${args.name}": ${matches.join(', ')}\nPlease be more specific.`
      );
    }

    const filePath = path.join(ctx.settingsDir, matches[0]);
    const raw = await safeReadFile(filePath);
    if (!raw) return toolError(new Error(`Cannot read ${matches[0]}`));

    const parsed = JSON.parse(raw) as FlaxSettings;
    const header = [
      `File:        ${matches[0]}`,
      `ID:          ${parsed.ID ?? ''}`,
      `TypeName:    ${parsed.TypeName ?? ''}`,
      `EngineBuild: ${parsed.EngineBuild ?? ''}`,
      '',
      '## Data',
    ].join('\n');

    return toolResult(`${header}\n${JSON.stringify(parsed.Data ?? parsed, null, 2)}`);
  } catch (e) {
    return toolError(e);
  }
}
