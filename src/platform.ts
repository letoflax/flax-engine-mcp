import path from 'node:path';

/**
 * Host-platform helpers shared by path comparisons and Flax install discovery.
 * Windows and macOS (default APFS/HFS+) resolve paths case-insensitively; Linux does not.
 */
export function pathsCaseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** A resolved path folded for equality checks and lock keys on case-insensitive hosts. */
export function comparablePathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(value);
  return pathsCaseInsensitive(platform) ? resolved.toLowerCase() : resolved;
}

/** Folder under `<Flax>/Binaries/Editor/` holding the Editor build for a host platform. */
export function flaxEditorPlatformFolder(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return 'Win64';
  if (platform === 'linux') return 'Linux';
  if (platform === 'darwin') return 'Mac';
  return null;
}

/** File name of the Flax Editor executable on a host platform. */
export function flaxEditorFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'FlaxEditor.exe' : 'FlaxEditor';
}

/** Display modes `editor_launch` can start an Editor on. */
export type EditorDisplayMode = 'desktop' | 'offscreen';

/** Default WIDTHxHEIGHT of the private compositor an off-screen Editor runs in. */
export const DEFAULT_OFFSCREEN_SIZE = '1920x1080';

const OFFSCREEN_MIN_EDGE = 320;
const OFFSCREEN_MAX_EDGE = 8192;

/** Parses "1920x1080" (case-insensitive x). Returns null when it is malformed or an edge is outside 320..8192. */
export function parseOffscreenSize(value: string): { width: number; height: number } | null {
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const inRange = (edge: number) => edge >= OFFSCREEN_MIN_EDGE && edge <= OFFSCREEN_MAX_EDGE;
  return inRange(width) && inRange(height) ? { width, height } : null;
}

/**
 * How an Editor can be run without showing on the user's screen, per host. Only Linux has an implementation
 * (a private headless Weston compositor); Windows and macOS have no equivalent that this server can start.
 */
export function offscreenDisplayBackend(platform: NodeJS.Platform = process.platform): 'weston' | null {
  return platform === 'linux' ? 'weston' : null;
}

/** Install hint shown when the off-screen compositor binary is missing. */
export const WESTON_INSTALL_HINT = 'Install Weston (a Wayland compositor): Fedora "sudo dnf install weston", Debian/Ubuntu "sudo apt install weston", Arch "sudo pacman -S weston".';

/** The per-user runtime directory Wayland sockets live in: $XDG_RUNTIME_DIR, else /run/user/<uid>. Null when unknown. */
export function waylandRuntimeDir(env: NodeJS.ProcessEnv = process.env, uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null): string | null {
  const configured = env['XDG_RUNTIME_DIR'];
  if (configured) return configured;
  return uid === null ? null : `/run/user/${uid}`;
}

/** True when a process with this pid exists (signal 0); EPERM counts as alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
