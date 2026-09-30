import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectMeta, safeReadFile } from '../projectContext.js';
import { toolResult, toolError, ToolDomainError, ToolResponse } from '../errors.js';
import { readProjectIdentity } from './serverStatus.js';

export const GetProjectPackagesSchema = z.object({});

export type PackageReferenceKind = 'engine' | 'plugin' | 'other';

export interface PackageReferenceInfo {
  name: string;
  kind: PackageReferenceKind;
  raw: string;
  exists: boolean;
}

export interface ProjectPackagesData {
  name: string;
  project_version: string | null;
  min_engine_version: string | null;
  game_target: string | null;
  editor_target: string | null;
  /** Path hash or explicit project id only. The full project path is never returned. */
  id: string;
  references: PackageReferenceInfo[];
  /** Names of directories directly under <project>/Plugins. No paths. */
  plugins: string[];
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The $(EnginePath)/Flax.flaxproj ref is the engine; other *.flaxproj refs are plugins. */
function classifyReference(raw: string): PackageReferenceKind {
  const normalized = raw.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'flax.flaxproj') return 'engine';
  if (base.endsWith('.flaxproj')) return 'plugin';
  return 'other';
}

/**
 * Mirrors the src/resources.ts scrub and liveObservability redactText path
 * discipline: variable placeholders such as $(EnginePath) survive, while host
 * absolute paths collapse to <redacted-path>. The caller extracts the safe
 * basename before redaction so names are always preserved.
 */
function redactRaw(value: string): string {
  let text = value.replaceAll('\\', '/');
  text = text.replace(/[A-Za-z]:\/(?:[^\\/:*?"<>|\s]+\/)*[^\\/:*?"<>|\s]+/g, '<redacted-path>');
  text = text.replace(/(^|[\s("'=:])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, '$1<redacted-path>');
  return text;
}

function referenceBasename(raw: string): string {
  const normalized = raw.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || normalized;
}

/**
 * Resolves only what is trivially resolvable offline: $(ProjectPath) maps to
 * the active project directory. Anything still holding a variable (notably
 * $(EnginePath), which is editor-known) is unverifiable offline. The resolved
 * candidate is used for a boolean existence probe only and never returned.
 */
async function referenceExists(raw: string, ctx: ProjectMeta): Promise<boolean> {
  const expanded = raw.replace(/\$\(\s*projectpath\s*\)/gi, ctx.projectPath);
  if (/\$\(/.test(expanded)) return false;
  const candidate = path.isAbsolute(expanded) ? expanded : path.join(ctx.projectPath, expanded);
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function listPluginNames(projectPath: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(projectPath, 'Plugins'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Applies path redaction to every string so no absolute path can leak. */
function cleanStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactRaw(value);
  if (Array.isArray(value)) return value.map(cleanStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cleanStrings(item)]),
    );
  }
  return value;
}

export async function handleGetProjectPackages(_args: unknown, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const projRaw = await safeReadFile(ctx.flaxprojPath);
    if (!projRaw) throw new ToolDomainError('NOT_FOUND', '.flaxproj file not found.');
    let proj: unknown;
    try {
      proj = JSON.parse(projRaw);
    } catch {
      throw new ToolDomainError('VALIDATION_FAILED', 'The .flaxproj file contains invalid JSON.');
    }
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
      throw new ToolDomainError('VALIDATION_FAILED', 'The .flaxproj file must contain a JSON object.');
    }
    const project = proj as Record<string, unknown>;
    const identity = await readProjectIdentity(ctx);

    const rawReferences = Array.isArray(project['References']) ? project['References'] as unknown[] : [];
    const references: PackageReferenceInfo[] = [];
    for (const entry of rawReferences) {
      const candidate = typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? (entry as Record<string, unknown>)['Name']
          : undefined;
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const raw = candidate.trim();
      references.push({
        name: referenceBasename(raw),
        kind: classifyReference(raw),
        raw: redactRaw(raw),
        exists: await referenceExists(raw, ctx),
      });
    }

    const data = cleanStrings({
      name: stringField(project['Name']) ?? ctx.projectName,
      project_version: stringField(project['Version']),
      min_engine_version: stringField(project['MinEngineVersion']),
      game_target: stringField(project['GameTarget']),
      editor_target: stringField(project['EditorTarget']),
      id: identity.id,
      references,
      plugins: await listPluginNames(ctx.projectPath),
    } satisfies ProjectPackagesData) as ProjectPackagesData;

    return toolResult(JSON.stringify(data, null, 2), { data });
  } catch (e) {
    return toolError(e);
  }
}
