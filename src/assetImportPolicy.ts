import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectMeta } from './projectContext.js';

/**
 * Importing is intentionally opt-in.  The Editor is allowed to open a source
 * file, so a project path is not an implicit source-file permission.
 */
export const MAX_ASSET_IMPORT_ROOTS = 32;
export const MAX_ASSET_IMPORT_ROOT_PATH_CHARS = 1024;
export const MAX_ASSET_IMPORT_SOURCE_BYTES = 512 * 1024 * 1024;
export const ASSET_IMPORT_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.tga', '.bmp', '.gif', '.tif', '.tiff', '.dds', '.hdr', '.raw', '.exr',
  '.obj', '.fbx', '.x', '.dae', '.gltf', '.glb', '.blend', '.bvh', '.ase', '.ply', '.dxf', '.ifc',
  '.nff', '.smd', '.vta', '.mdl', '.md2', '.md3', '.md5mesh', '.q3o', '.q3s', '.ac', '.stl', '.lwo', '.lws', '.lxo',
  '.wav', '.mp3', '.ogg',
] as const;

export interface AssetImportPolicy {
  /** Canonical paths for bridge-only validation. Never include these in tool output. */
  roots: readonly string[];
  extensions: readonly string[];
  maxSourceBytes: number;
}

export const DEFAULT_ASSET_IMPORT_POLICY: AssetImportPolicy = {
  roots: [],
  extensions: ASSET_IMPORT_EXTENSIONS,
  maxSourceBytes: MAX_ASSET_IMPORT_SOURCE_BYTES,
};

function comparisonPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Parses only the repeatable CLI spelling. Canonicalisation is async below. */
export function parseAssetImportRootArguments(argv: readonly string[]): string[] {
  const roots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--asset-import-root') continue;
    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error('--asset-import-root requires an existing directory path.');
    }
    if (value.length > MAX_ASSET_IMPORT_ROOT_PATH_CHARS) {
      throw new Error(`--asset-import-root is limited to ${MAX_ASSET_IMPORT_ROOT_PATH_CHARS} characters.`);
    }
    roots.push(value);
    if (roots.length > MAX_ASSET_IMPORT_ROOTS) {
      throw new Error(`At most ${MAX_ASSET_IMPORT_ROOTS} --asset-import-root values may be configured.`);
    }
  }
  return roots;
}

/** Resolve every configured root once at startup so junctions and symlinks are never trusted by spelling alone. */
export async function createAssetImportPolicy(argv: readonly string[]): Promise<AssetImportPolicy> {
  const candidates = parseAssetImportRootArguments(argv);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let canonical: string;
    try {
      canonical = await fs.realpath(path.resolve(candidate));
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('--asset-import-root must name an existing readable directory.');
    }
    const key = comparisonPath(canonical);
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(canonical);
    }
  }
  return { roots, extensions: ASSET_IMPORT_EXTENSIONS, maxSourceBytes: MAX_ASSET_IMPORT_SOURCE_BYTES };
}

export function assetImportPolicyForContext(ctx: ProjectMeta): AssetImportPolicy {
  return ctx.assetImportPolicy ?? DEFAULT_ASSET_IMPORT_POLICY;
}

export interface VerifiedImportSource {
  canonicalPath: string;
  sizeBytes: number;
  modifiedUnixMs: number;
  extension: string;
  name: string;
}

function sourceNotAllowed(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'IMPORT_SOURCE_NOT_ALLOWED' });
}

/**
 * Re-stat/re-realpath prevents a source symlink/junction from being swapped
 * between validation and the bridge request. The bridge repeats this check
 * immediately before calling Flax's importer.
 */
export async function verifyAssetImportSource(sourcePath: string, policy: AssetImportPolicy): Promise<VerifiedImportSource> {
  if (policy.roots.length === 0) {
    throw sourceNotAllowed('Asset import is disabled because no --asset-import-root is configured.');
  }
  let canonical: string;
  let first: Awaited<ReturnType<typeof fs.stat>>;
  try {
    canonical = await fs.realpath(path.resolve(sourcePath));
    first = await fs.stat(canonical);
  } catch {
    throw sourceNotAllowed('Import source does not exist or cannot be resolved.');
  }
  if (!first.isFile()) throw sourceNotAllowed('Import source must be a regular file.');
  const ext = path.extname(canonical).toLowerCase();
  if (!policy.extensions.includes(ext)) throw sourceNotAllowed(`Import source extension "${ext || '(none)'}" is not allowlisted.`);
  if (first.size < 1 || first.size > policy.maxSourceBytes) {
    throw sourceNotAllowed(`Import source size must be between 1 and ${policy.maxSourceBytes} bytes.`);
  }
  if (!policy.roots.some(root => isInside(root, canonical))) {
    throw sourceNotAllowed('Import source is outside the configured asset import roots.');
  }

  // Use a second canonical path and stat just before handing it to the bridge.
  const rechecked = await fs.realpath(canonical).catch(() => null);
  if (!rechecked || comparisonPath(rechecked) !== comparisonPath(canonical)) {
    throw sourceNotAllowed('Import source changed while it was being validated.');
  }
  const second = await fs.stat(rechecked).catch(() => null);
  if (!second || !second.isFile() || second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
    throw sourceNotAllowed('Import source changed while it was being validated.');
  }
  return {
    canonicalPath: canonical,
    sizeBytes: first.size,
    modifiedUnixMs: Math.trunc(first.mtimeMs),
    extension: ext,
    name: path.basename(canonical),
  };
}

/** Validate an output without following an existing Content junction outside the project. */
export async function verifyAssetImportDestination(destination: string, ctx: ProjectMeta): Promise<{ absolutePath: string; relativePath: string }> {
  const normalized = destination.replaceAll('\\', '/');
  if (
    destination !== normalized ||
    !normalized.startsWith('Content/') ||
    path.isAbsolute(destination) ||
    normalized.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))
  ) {
    throw Object.assign(new Error('Import destination must be a project-relative file under Content/ without traversal.'), { code: 'VALIDATION_FAILED' });
  }
  if (path.extname(normalized).toLowerCase() !== '.flax') {
    throw Object.assign(new Error('Import destination must use the .flax asset extension.'), { code: 'VALIDATION_FAILED' });
  }
  const contentRoot = await fs.realpath(ctx.contentDir).catch(() => null);
  if (!contentRoot) throw Object.assign(new Error('Project Content directory is unavailable.'), { code: 'IMPORT_FAILED' });
  const absolutePath = path.resolve(ctx.projectPath, normalized);
  if (!isInside(contentRoot, absolutePath)) {
    throw Object.assign(new Error('Import destination escapes Content/.'), { code: 'VALIDATION_FAILED' });
  }
  let parent = path.dirname(absolutePath);
  while (true) {
    try {
      const canonicalParent = await fs.realpath(parent);
      if (!isInside(contentRoot, canonicalParent)) {
        throw Object.assign(new Error('Import destination parent resolves outside Content/.'), { code: 'VALIDATION_FAILED' });
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const next = path.dirname(parent);
        if (next === parent) throw Object.assign(new Error('Import destination parent cannot be resolved.'), { code: 'VALIDATION_FAILED' });
        parent = next;
        continue;
      }
      throw error;
    }
  }
  return { absolutePath, relativePath: normalized };
}

export async function chooseAssetImportDestination(
  requested: { absolutePath: string; relativePath: string },
  collisionPolicy: 'error' | 'rename',
): Promise<{ absolutePath: string; relativePath: string; renamed: boolean }> {
  const exists = async (candidate: string): Promise<boolean> => fs.lstat(candidate).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (!await exists(requested.absolutePath)) return { ...requested, renamed: false };
  if (collisionPolicy === 'error') {
    throw Object.assign(new Error('An asset already exists at the requested destination.'), { code: 'FILE_EXISTS' });
  }
  const ext = path.extname(requested.absolutePath);
  const stem = requested.absolutePath.slice(0, -ext.length);
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const candidate = `${stem}-${suffix}${ext}`;
    if (!await exists(candidate)) {
      return { absolutePath: candidate, relativePath: `${requested.relativePath.slice(0, -ext.length)}-${suffix}${ext}`.replaceAll('\\', '/'), renamed: true };
    }
  }
  throw Object.assign(new Error('Could not find a collision-free asset destination.'), { code: 'FILE_EXISTS' });
}
