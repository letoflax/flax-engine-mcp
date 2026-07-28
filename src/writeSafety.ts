import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolDomainError } from './errors.js';

export const MAX_SCRIPT_BYTES = 1024 * 1024;

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function assertSha256(value: string | undefined, field = 'expected_hash'): void {
  if (value !== undefined && !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ToolDomainError('VALIDATION_FAILED', `${field} must be a 64-character SHA-256 hex digest.`);
  }
}

export function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new ToolDomainError('CONTENT_TOO_LARGE', `Content exceeds the ${MAX_SCRIPT_BYTES}-byte write limit.`);
  }
}

export async function canonicalProjectRoot(projectPath: string): Promise<string> {
  return fs.realpath(path.resolve(projectPath));
}

/**
 * Confines a path to root both lexically and after resolving any existing links.
 * For a new file, the closest existing parent is canonicalized so a symlink or
 * junction in the path cannot redirect a subsequent write outside the project.
 */
export async function assertWritePathWithinRoot(target: string, projectPath: string): Promise<string> {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Access denied: path is outside the permitted directory.');
  }

  const realRoot = await canonicalProjectRoot(root);
  let existing = resolved;
  while (true) {
    try {
      await fs.lstat(existing);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('Access denied: no existing parent for destination.');
      existing = parent;
    }
  }

  const realExisting = await fs.realpath(existing);
  const existingRelative = path.relative(realRoot, realExisting);
  if (existingRelative === '..' || existingRelative.startsWith(`..${path.sep}`) || path.isAbsolute(existingRelative)) {
    throw new Error('Access denied: destination resolves outside the permitted directory.');
  }

  // Existing destinations must also be checked directly, rather than relying on
  // the parent path, because a file may itself be a symbolic link.
  try {
    const realTarget = await fs.realpath(resolved);
    const targetRelative = path.relative(realRoot, realTarget);
    if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
      throw new Error('Access denied: destination resolves outside the permitted directory.');
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return resolved;
}

export async function readConfinedText(target: string, projectPath: string): Promise<string | null> {
  const resolved = await assertWritePathWithinRoot(target, projectPath);
  try {
    return await fs.readFile(resolved, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWriteConfined(
  target: string,
  content: string,
  projectPath: string,
  expectedBefore: string | null,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  assertContentSize(content);

  const resolved = await assertWritePathWithinRoot(target, projectPath);
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true });
  // mkdir may have traversed a junction created since the first check; verify
  // the now-existing parent immediately before creating the temporary file.
  await assertWritePathWithinRoot(resolved, projectPath);

  const temp = path.join(parent, `.${path.basename(resolved)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await beforeReplace?.();
    // The per-target MCP lock serializes cooperating callers. This comparison
    // also detects a non-cooperating editor/user write before replacement.
    const current = await readConfinedText(resolved, projectPath);
    if (current !== expectedBefore) {
      throw new ToolDomainError('FILE_CHANGED', 'The script changed during this operation; refresh it and retry.');
    }
    await fs.rename(temp, resolved);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Holds an adjacent, exclusive lock across the read/hash/write critical section. */
export async function withTargetLock<T>(
  target: string,
  projectPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolved = await assertWritePathWithinRoot(target, projectPath);
  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true });
  await assertWritePathWithinRoot(resolved, projectPath);
  const lock = path.join(parent, `.${path.basename(resolved)}.flax-mcp.lock`);
  await assertWritePathWithinRoot(lock, projectPath);
  let handle: fs.FileHandle | undefined;
  try {
    try {
      handle = await fs.open(lock, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ToolDomainError('FILE_CHANGED', 'The script is being modified by another operation; retry shortly.');
      }
      throw error;
    }
    return await operation();
  } finally {
    await handle?.close().catch(() => undefined);
    if (handle) await fs.rm(lock, { force: true }).catch(() => undefined);
  }
}

export function summarizeChange(before: string | null, after: string): {
  created: boolean;
  before_hash: string | null;
  after_hash: string;
  bytes_before: number;
  bytes_after: number;
  lines_added: number;
  lines_removed: number;
} {
  const oldLines = before === null ? [] : before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  return {
    created: before === null,
    before_hash: before === null ? null : sha256(before),
    after_hash: sha256(after),
    bytes_before: before === null ? 0 : Buffer.byteLength(before, 'utf8'),
    bytes_after: Buffer.byteLength(after, 'utf8'),
    lines_added: newLines.length - prefix - suffix,
    lines_removed: oldLines.length - prefix - suffix,
  };
}
