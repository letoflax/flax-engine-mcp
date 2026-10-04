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
