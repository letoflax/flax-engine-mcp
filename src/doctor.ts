import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createProjectContext } from './projectContext.js';
import { parsePermissionPolicy } from './permissions.js';
import { inspectEditorBridge, readProjectIdentity } from './tools/serverStatus.js';
import { inspectEditorBridgeInstallation } from './tools/bridgeInstaller.js';

export const DOCTOR_EXIT_OK = 0;
export const DOCTOR_EXIT_FAILED = 1;
export const DOCTOR_EXIT_USAGE = 2;

type CheckStatus = 'pass' | 'warn' | 'fail';
interface DoctorCheck { name: string; status: CheckStatus; message: string }
export interface DoctorResult { exitCode: number; text: string; data: Record<string, unknown> }

function hasFlag(argv: readonly string[], flag: string): boolean { return argv.includes(flag); }

function projectPathFrom(argv: readonly string[]): string | null {
  const index = argv.indexOf('--project-path');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

async function readable(directory: string): Promise<boolean> {
  try { await fs.access(directory, constants.R_OK); return true; } catch { return false; }
}

/** Read-only preflight suitable for support bundles and CI. It never reads a token. */
export async function runDoctor(argv = process.argv): Promise<DoctorResult> {
  const json = hasFlag(argv, '--json');
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, message: string) => checks.push({ name, status, message });
  const major = Number(process.versions.node.split('.')[0]);
  add('node.version', Number.isInteger(major) && major >= 20 ? 'pass' : 'fail', `Node ${process.versions.node}; requires >=20.`);
  const requested = projectPathFrom(argv);
  if (!requested) {
    add('project.path', 'fail', 'Missing --project-path.');
    return { ...render({ checks, nodeVersion: process.versions.node }, json), exitCode: DOCTOR_EXIT_USAGE };
  }

  const absolute = path.resolve(requested);
  let entries: string[];
  try { entries = await fs.readdir(absolute); }
  catch { add('project.path', 'fail', 'Project directory is not readable.'); return render({ checks, nodeVersion: process.versions.node }, json); }
  const projectFile = entries.find(entry => entry.endsWith('.flaxproj'));
  if (!projectFile) {
    add('project.file', 'fail', 'No .flaxproj file found.');
    return render({ checks, nodeVersion: process.versions.node }, json);
  }
  add('project.file', 'pass', 'Flax project file found.');

  let ctx;
  try { ctx = await createProjectContext(absolute); }
  catch { add('project.file', 'fail', '.flaxproj is not readable JSON.'); return render({ checks, nodeVersion: process.versions.node }, json); }
  let identity;
  try {
    identity = await readProjectIdentity(ctx);
    add('flax.version', identity.minEngineVersion ? 'pass' : 'warn', identity.minEngineVersion ? `Minimum Flax version: ${identity.minEngineVersion}.` : 'No minimum Flax version is declared.');
  } catch { add('flax.version', 'fail', 'Could not read project metadata.'); }

  const [sourceOk, settingsOk, cacheOk] = await Promise.all([readable(ctx.sourceDir), readable(ctx.settingsDir), readable(path.join(ctx.projectPath, 'Cache'))]);
  add('source.readability', sourceOk ? 'pass' : 'warn', sourceOk ? 'Source directory is readable.' : 'Source directory is missing or unreadable.');
  add('settings.readability', settingsOk ? 'pass' : 'warn', settingsOk ? 'Settings directory is readable.' : 'Content/Settings is missing or unreadable.');
  add('cache.readability', cacheOk ? 'pass' : 'warn', cacheOk ? 'Cache directory is readable.' : 'Cache directory is missing or unreadable; it is created by Flax when needed.');
  try {
    const policy = parsePermissionPolicy(argv);
    add('permissions', 'pass', `Permission profile: ${policy.profile}${policy.emergencyReadOnly ? ' (emergency read-only)' : ''}.`);
  } catch (error) { add('permissions', 'fail', error instanceof Error ? error.message : 'Invalid permission flags.'); }
  try {
    const [bridge, installation] = await Promise.all([inspectEditorBridge(ctx), inspectEditorBridgeInstallation(ctx)]);
    add('bridge.installation', installation.bundled.available ? (installation.installed.present ? 'pass' : 'warn') : 'fail', installation.bundled.available ? (installation.installed.present ? 'Bundled and installed bridge were detected.' : 'Bundled bridge is available but not installed.') : 'Bundled bridge asset is unavailable.');
    add('bridge.heartbeat', bridge.connected ? 'pass' : 'warn', bridge.connected ? `Bridge protocol ${bridge.protocolVersion ?? 'unknown'} is connected.` : `Bridge is not connected (${bridge.reason}).`);
    add('bridge.protocol', bridge.connected && bridge.protocolVersion !== '1' ? 'fail' : bridge.connected ? 'pass' : 'warn', bridge.connected ? `Protocol ${bridge.protocolVersion ?? 'unknown'}.` : 'Protocol handshake is unavailable until the bridge connects.');
  } catch { add('bridge', 'warn', 'Bridge inspection was unavailable.'); }

  return render({ checks, nodeVersion: process.versions.node, project: { name: ctx.projectName, version: identity?.version ?? null, minEngineVersion: identity?.minEngineVersion ?? null } }, json);
}

function render(base: Record<string, unknown>, json: boolean): DoctorResult {
  const checks = base.checks as DoctorCheck[];
  const failed = checks.some(check => check.status === 'fail');
  const data = { ok: !failed, ...base, privacy: { cloudTelemetry: false, tokenRead: false, projectPathExposed: false } };
  const text = json
    ? JSON.stringify(data, null, 2)
    : [`Flax MCP doctor: ${failed ? 'FAILED' : 'OK'}`, ...checks.map(check => `${check.status.toUpperCase().padEnd(4)} ${check.name} — ${check.message}`)].join('\n');
  return { exitCode: failed ? DOCTOR_EXIT_FAILED : DOCTOR_EXIT_OK, text, data };
}
