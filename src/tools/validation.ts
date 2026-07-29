import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectMeta, safeReadFile, walkDir } from '../projectContext.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { readTextFile } from '../textEncoding.js';

type Severity = 'error' | 'warning' | 'info';
type Check = 'scripts' | 'assets' | 'settings' | 'scenes';
type ValidateArgs = { checks?: Check[]; rule_ids?: string[]; severities?: Severity[]; suppressions?: string[]; cursor?: string; limit?: number; required_camera?: boolean };
interface Finding { ruleId: string; severity: Severity; check: Check; location: { kind: 'project' | 'file' | 'object'; path?: string; objectId?: string }; message: string; suggestedFix: string; autoFixAvailable: boolean; metadata: Record<string, unknown>; }

const MAX_FILES = 10_000;
const MAX_REFERENCES = 1_000;
const RULES = [
  ['FLAX001', 'Missing first scene', 'error', true], ['FLAX002', 'Missing asset reference', 'error', true], ['FLAX003', 'Script compile failure', 'error', true],
  ['FLAX004', 'Duplicate actor name in required-unique scope', 'info', false], ['FLAX005', 'Invalid network attribute usage', 'warning', true], ['FLAX006', 'Missing or inactive required camera', 'warning', true],
  ['FLAX007', 'Duplicate input mapping', 'warning', true], ['FLAX008', 'Unbalanced script braces', 'error', true], ['FLAX009', 'Invalid Flax asset header', 'warning', true],
  ['FLAX010', 'Missing required settings file', 'warning', true], ['FLAX011', 'Invalid scene JSON', 'error', true],
].map(([id, name, defaultSeverity, offline]) => ({ id, name, defaultSeverity, offline }));
const GUID = /^[0-9a-f]{32}$/i;

function relative(ctx: ProjectMeta, file: string): string { return path.relative(ctx.projectPath, file).split(path.sep).join('/'); }
function isGuid(value: unknown): value is string { return typeof value === 'string' && GUID.test(value); }
function finding(list: Finding[], ruleId: string, severity: Severity, check: Check, file: string | undefined, message: string, suggestedFix: string, metadata: Record<string, unknown> = {}): void {
  list.push({ ruleId, severity, check, location: { kind: file ? 'file' : 'project', ...(file ? { path: file } : {}) }, message, suggestedFix, autoFixAvailable: false, metadata });
}

async function assetId(file: string): Promise<string | null> {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.flax') {
    const handle = await fs.open(file, 'r').catch(() => null);
    if (!handle) return null;
    try { const header = Buffer.alloc(44); const read = await handle.read(header, 0, header.length, 0); return read.bytesRead >= 44 && header.subarray(0, 4).toString('ascii') === 'CFWF' ? header.subarray(0x1c, 0x2c).toString('hex') : null; }
    finally { await handle.close(); }
  }
  if (extension !== '.json' && extension !== '.scene') return null;
  try { const raw = await safeReadFile(file); const id = raw ? (JSON.parse(raw) as { ID?: unknown }).ID : undefined; return isGuid(id) ? id.toLowerCase() : null; } catch { return null; }
}

function referenceGuids(value: unknown, found: Array<{ key: string; id: string }> = []): Array<{ key: string; id: string }> {
  if (Array.isArray(value)) { for (const item of value) referenceGuids(item, found); return found; }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Actor links are GUID-shaped too, but are not Content asset references.
    const actorLink = /^(?:id|parentid|sceneobject|actor|actorid|objectid)$/i.test(key);
    if (isGuid(child) && !actorLink && /asset|reference|settings|scene|material|model|texture|prefab|shader|audio|animation/i.test(key)) found.push({ key, id: child.toLowerCase() });
    else referenceGuids(child, found);
  }
  return found;
}

function duplicateMappings(value: unknown): Array<{ name: string; kind: string; binding: string }> {
  const root = value && typeof value === 'object' ? value as { Data?: unknown } : {};
  const data = root.Data && typeof root.Data === 'object' ? root.Data as Record<string, unknown> : root as Record<string, unknown>;
  const duplicates: Array<{ name: string; kind: string; binding: string }> = [];
  for (const [kind, mappings] of [['action', data.ActionMappings], ['axis', data.AxisMappings]] as const) {
    if (!Array.isArray(mappings)) continue;
    const seen = new Set<string>();
    for (const item of mappings) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>, name = typeof row.Name === 'string' ? row.Name : '(unnamed)';
      const binding = kind === 'action' ? `${row.Mode ?? ''}:${row.Key ?? ''}:${row.MouseButton ?? ''}:${row.GamepadButton ?? ''}:${row.Gamepad ?? ''}` : `${row.Axis ?? ''}:${row.Gamepad ?? ''}:${row.PositiveButton ?? ''}:${row.NegativeButton ?? ''}:${row.Scale ?? ''}`;
      const identity = `${name}\u0000${binding}`;
      if (seen.has(identity)) duplicates.push({ name, kind, binding }); else seen.add(identity);
    }
  }
  return duplicates;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try { const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown }; if (decoded.v !== 1 || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 0) throw new Error(); return decoded.offset as number; }
  catch { throw new ToolDomainError('CURSOR_INVALID', 'Validation cursor is invalid or expired. Start a new validation request.'); }
}
function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ v: 1, offset })).toString('base64url'); }

export async function handleValidateProjectEnhanced(input: unknown, ctx: ProjectMeta): Promise<ToolResponse> {
  const args = input as ValidateArgs;
  const checks = args.checks ?? ['scripts', 'assets', 'settings', 'scenes'];
  const results: Finding[] = [];
  const warnings = [
    'Offline validation cannot verify live Editor compilation, dirty scenes, cooker output, build targets, plugin/module dependencies, or platform support.',
    'FLAX004 is skipped offline because required-unique actor scopes are not serialized consistently.',
  ];
  try {
    if (checks.includes('scripts')) {
      const scripts = await walkDir(ctx.sourceDir, ['.cs']);
      for (const file of scripts.filter(file => !path.basename(file).endsWith('.Build.cs') && !path.basename(file).endsWith('.Gen.cs'))) {
        const source = await fs.readFile(file, 'utf8').catch(() => null), target = relative(ctx, file);
        if (!source) { finding(results, 'FLAX008', 'warning', 'scripts', target, `Cannot read: ${target}`, 'Restore the source file and rerun validation.'); continue; }
        const opens = (source.match(/\{/g) ?? []).length, closes = (source.match(/\}/g) ?? []).length;
        if (opens !== closes) finding(results, 'FLAX008', 'error', 'scripts', target, `Unbalanced braces in ${path.basename(file)} ({:${opens} }:${closes})`, 'Fix the unmatched braces, then compile the project.', { openingBraces: opens, closingBraces: closes });
        if (!/:\s*(?:[\w.]*NetworkScript|[\w.]*INetworkObject)\b/.test(source)) {
          source.split(/\r?\n/).forEach((line, index) => {
            const attribute = line.match(/\[(NetworkReplicated|NetworkRpc|NetworkSync)(?:\([^\]]*\))?\]/)?.[1];
            if (attribute) finding(results, 'FLAX005', 'warning', 'scripts', target, `${attribute} is used in a file with no statically detectable NetworkScript or INetworkObject base.`, 'Use the attribute only on a supported network script type, or verify its base type in Flax Editor.', { line: index + 1, attribute, parserLimit: 'Partial classes and external base types are not resolved.' });
          });
        }
      }
      const latestLog = (await fs.readdir(ctx.logsDir).catch(() => [] as string[])).filter(file => file.endsWith('.txt')).sort().at(-1);
      if (latestLog) {
        const logPath = path.join(ctx.logsDir, latestLog), raw = await readTextFile(logPath).catch(() => null);
        const errors = raw?.split(/\r?\n/).filter(line => /error\s+CS\d+|Error:\s|\[Error\]|Build\s+FAILED|Compilation\s+failed/i.test(line)) ?? [];
        if (errors.length) finding(results, 'FLAX003', 'error', 'scripts', relative(ctx, logPath), `Latest compiler log contains ${errors.length} error line(s).`, 'Fix the compiler errors and rerun validation or use code_get_diagnostics with a connected Editor.', { errorLines: errors.slice(0, 20) });
      }
    }

    if (checks.includes('settings')) {
      const existing = await fs.readdir(ctx.settingsDir).catch(() => [] as string[]);
      for (const name of ['Input Settings.json', 'Physics Settings.json', 'Graphics Settings.json']) if (!existing.includes(name)) finding(results, 'FLAX010', 'warning', 'settings', `Content/Settings/${name}`, `Missing settings file: ${name}`, 'Create the setting through Flax Editor or restore it from source control.', { requiredFile: name });
      const inputPath = path.join(ctx.settingsDir, 'Input Settings.json'), input = await safeReadFile(inputPath);
      if (input) try { for (const duplicate of duplicateMappings(JSON.parse(input))) finding(results, 'FLAX007', 'warning', 'settings', relative(ctx, inputPath), `Duplicate ${duplicate.kind} input mapping "${duplicate.name}" for binding ${duplicate.binding}.`, 'Remove or intentionally differentiate one duplicate mapping in Input Settings.', duplicate); }
      catch { warnings.push('Input Settings.json could not be parsed; duplicate input mappings were not checked.'); }
    }

    const scenes = checks.includes('scenes') || checks.includes('assets') ? await walkDir(ctx.contentDir, ['.scene']) : [];
    const parsedScenes = new Map<string, { file: string; actors: Array<Record<string, unknown>> }>();
    for (const file of scenes.slice(0, MAX_FILES)) {
      try { const raw = await safeReadFile(file), json = raw ? JSON.parse(raw) as { ID?: unknown; Data?: unknown } : {}; if (isGuid(json.ID)) parsedScenes.set(json.ID.toLowerCase(), { file, actors: Array.isArray(json.Data) ? json.Data.filter((actor): actor is Record<string, unknown> => !!actor && typeof actor === 'object' && !Array.isArray(actor)) : [] }); }
      catch { /* FLAX011 is emitted by the assets check to preserve legacy grouping. */ }
    }
    if (checks.includes('scenes')) {
      const raw = await safeReadFile(ctx.flaxprojPath), project = raw ? JSON.parse(raw) as { DefaultScene?: unknown } : {}, firstScene = isGuid(project.DefaultScene) ? project.DefaultScene.toLowerCase() : undefined;
      if (!firstScene) finding(results, 'FLAX001', 'warning', 'scenes', path.basename(ctx.flaxprojPath), 'No valid DefaultScene is set in .flaxproj.', 'Select an existing first scene in project settings.');
      else if (!parsedScenes.has(firstScene)) finding(results, 'FLAX001', 'error', 'scenes', path.basename(ctx.flaxprojPath), `DefaultScene ID "${project.DefaultScene}" was not found in parsed .scene files.`, 'Set DefaultScene to an existing scene asset or restore the missing scene.', { sceneId: firstScene });
      else if (args.required_camera) {
        const scene = parsedScenes.get(firstScene)!;
        const cameras = scene.actors.filter(actor => String(actor.TypeName ?? '').toLowerCase().includes('camera')), active = cameras.filter(actor => actor.Active !== false && actor.IsActive !== false);
        if (!cameras.length || !active.length) finding(results, 'FLAX006', 'warning', 'scenes', relative(ctx, scene.file), cameras.length ? 'Required camera check found only inactive Camera actor(s) in the parsed DefaultScene.' : 'Required camera check found no Camera actor in the parsed DefaultScene.', 'Add or activate a Camera actor, then verify the scene in Flax Editor.', { requiredCamera: true, cameraCount: cameras.length, activeCameraCount: active.length, parserLimit: 'Only serialized Active/IsActive values are checked.' });
      }
    }

    if (checks.includes('assets')) {
      const allFiles = await walkDir(ctx.contentDir, []), scanned = allFiles.slice(0, MAX_FILES), knownIds = new Set<string>();
      if (allFiles.length > MAX_FILES) warnings.push(`Validation scanned only the first ${MAX_FILES} Content files; project file count exceeds the offline safety bound.`);
      for (const file of scanned) { const id = await assetId(file); if (id) knownIds.add(id); }
      let referenceCount = 0;
      for (const file of scanned) {
        const extension = path.extname(file).toLowerCase(), target = relative(ctx, file);
        if (extension === '.flax' && await assetId(file) === null) finding(results, 'FLAX009', 'warning', 'assets', target, `${target} has an invalid or unreadable Flax asset header`, 'Reimport or restore the asset; binary asset headers are not repaired automatically.');
        if (extension !== '.json' && extension !== '.scene') continue;
        try {
          const raw = await safeReadFile(file);
          for (const reference of referenceGuids(JSON.parse(raw ?? ''))) if (!knownIds.has(reference.id) && referenceCount++ < MAX_REFERENCES) finding(results, 'FLAX002', 'error', 'assets', target, `Reference field "${reference.key}" points to missing asset ID ${reference.id}.`, 'Restore the referenced asset or update the serialized reference in Flax Editor.', { referenceField: reference.key, assetId: reference.id, parserLimit: 'Only GUID values in asset/reference-shaped JSON fields are checked.' });
        } catch { if (extension === '.scene') finding(results, 'FLAX011', 'error', 'assets', target, `${target} is not valid scene JSON`, 'Restore valid scene JSON or open the scene in Flax Editor and save it again.'); }
      }
      if (referenceCount > MAX_REFERENCES) warnings.push(`Missing asset reference findings are capped at ${MAX_REFERENCES}.`);
    }

    results.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || (a.location.path ?? '').localeCompare(b.location.path ?? '') || a.message.localeCompare(b.message));
    const ids = new Set((args.rule_ids ?? []).map(value => value.toUpperCase())), severities = new Set(args.severities ?? ['error', 'warning', 'info']), suppressed = new Set((args.suppressions ?? []).map(value => value.toUpperCase()));
    const selected = results.filter(item => (!ids.size || ids.has(item.ruleId)) && severities.has(item.severity)), suppressedCount = selected.filter(item => suppressed.has(item.ruleId)).length, visible = selected.filter(item => !suppressed.has(item.ruleId));
    const offset = decodeCursor(args.cursor); if (offset > visible.length) throw new ToolDomainError('CURSOR_INVALID', 'Validation cursor points beyond the available findings. Start a new validation request.');
    const limit = args.limit ?? 100;
    const page = visible.slice(offset, offset + limit), nextCursor = offset + page.length < visible.length ? encodeCursor(offset + page.length) : undefined;
    const data = { findings: page, totalFindings: visible.length, returnedFindings: page.length, nextCursor, suppressedCount, rules: RULES, limits: { maxFiles: MAX_FILES, maxMissingAssetReferences: MAX_REFERENCES, maxPageSize: 200 }, capabilityGaps: ['Live compiler state, cooker output, build targets, dirty scenes, plugin/module dependencies, and platform settings require a connected Editor/cooker.', 'FLAX004 required-unique actor scopes are unavailable from the supported offline scene parser.'] };
    if (!visible.length) return toolResult('All checks passed. No issues found.', { data, warnings });
    const text = [`## Validation Results (${visible.length} issue(s))`, '']; for (const item of page) text.push(`${item.severity === 'error' ? 'âœ—' : item.severity === 'warning' ? 'âš ' : 'â„¹'} [${item.check}] ${item.message}`); if (nextCursor) text.push('', `More findings are available. Use cursor: ${nextCursor}`);
    return toolResult(text.join('\n'), { data, warnings });
  } catch (error) { return toolError(error); }
}
