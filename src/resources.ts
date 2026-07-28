import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ProjectMeta } from './projectContext.js';

const CaptureId = /^[0-9a-f]{32}$/i;
const MaxCaptureBytes = 16 * 1024 * 1024;
const MaxListedCaptures = 64;
const CaptureTtlMs = 24 * 60 * 60 * 1000;

function captureDirectory(ctx: ProjectMeta): string {
  return path.join(ctx.projectPath, 'Cache', 'MCP', 'captures');
}

async function canonicalCaptureDirectory(ctx: ProjectMeta): Promise<string> {
  const project = await fs.realpath(ctx.projectPath);
  const expected = path.resolve(captureDirectory(ctx));
  const directory = await fs.realpath(expected);
  const relative = path.relative(project, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || directory.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
    throw new McpError(ErrorCode.InvalidParams, 'Capture cache must be a real directory inside the project.');
  }
  return directory;
}

async function confinedCaptureFile(directory: string, id: string): Promise<{ file: string; stat: Awaited<ReturnType<typeof fs.stat>> }> {
  const lexical = path.join(directory, `${id}.png`);
  const linkStat = await fs.lstat(lexical);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new McpError(ErrorCode.InvalidParams, 'Capture resource must be a regular project-local file.');
  }
  const file = await fs.realpath(lexical);
  const relative = path.relative(directory, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new McpError(ErrorCode.InvalidParams, 'Capture resource escapes the project cache.');
  }
  return { file, stat: await fs.stat(file) };
}

function numericStat(stat: Awaited<ReturnType<typeof fs.stat>>): { size: number; mtimeMs: number } {
  return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
}

function parseCaptureUri(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid Flax resource URI.');
  }
  const id = parsed.pathname.replace(/^\/+/, '');
  if (parsed.protocol !== 'flax:' || parsed.hostname !== 'capture' || parsed.search || parsed.hash || !CaptureId.test(id)) {
    throw new McpError(ErrorCode.InvalidParams, 'Expected flax://capture/<32-character-guid>.');
  }
  return id;
}

export async function listFlaxResources(ctx: ProjectMeta) {
  let directory: string;
  let names: string[];
  try {
    directory = await canonicalCaptureDirectory(ctx);
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { resources: [] };
    throw error;
  }
  const candidates = await Promise.all(names
    .filter(name => CaptureId.test(path.basename(name, '.png')) && path.extname(name).toLowerCase() === '.png')
    .map(async name => {
      const id = path.basename(name, '.png');
      try {
        const { stat } = await confinedCaptureFile(directory, id);
        const numeric = numericStat(stat);
        if (!stat.isFile() || numeric.size <= 0 || numeric.size > MaxCaptureBytes || Date.now() - numeric.mtimeMs > CaptureTtlMs) return null;
        return { id, stat, ...numeric };
      } catch {
        return null;
      }
    }));
  const resources = candidates
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MaxListedCaptures)
    .map(({ id, stat }) => ({
      uri: `flax://capture/${id}`,
      name: `Flax viewport capture ${id}`,
      description: 'A temporary game-viewport screenshot captured by the connected Flax Editor.',
      mimeType: 'image/png',
      size: Number(stat.size),
      annotations: { audience: ['user', 'assistant'] as ('user' | 'assistant')[], priority: 0.7, lastModified: stat.mtime.toISOString() },
    }));
  return { resources };
}

export async function readFlaxResource(uri: string, ctx: ProjectMeta) {
  const id = parseCaptureUri(uri);
  let confined;
  try {
    const directory = await canonicalCaptureDirectory(ctx);
    confined = await confinedCaptureFile(directory, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new McpError(ErrorCode.InvalidParams, 'Capture resource was not found or has expired.');
    }
    throw error;
  }
  const { file, stat } = confined;
  const numeric = numericStat(stat);
  if (!stat.isFile() || numeric.size <= 0 || numeric.size > MaxCaptureBytes || Date.now() - numeric.mtimeMs > CaptureTtlMs) {
    throw new McpError(ErrorCode.InvalidParams, 'Capture resource is empty, too large, or expired.');
  }
  const handle = await fs.open(file, 'r');
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || Number(opened.size) !== numeric.size || Number(opened.size) > MaxCaptureBytes) {
      throw new McpError(ErrorCode.InvalidParams, 'Capture resource changed while being opened.');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new McpError(ErrorCode.InvalidParams, 'Capture resource is not a valid PNG file.');
  }
  return {
    contents: [{
      uri: `flax://capture/${id}`,
      mimeType: 'image/png',
      blob: bytes.toString('base64'),
    }],
  };
}
