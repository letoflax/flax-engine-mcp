import fs from 'node:fs/promises';
import path from 'node:path';

export interface ProjectMeta {
  projectPath: string;
  projectName: string;
  flaxprojPath: string;
  contentDir: string;
  sourceDir: string;
  logsDir: string;
  settingsDir: string;
}

export async function createProjectContext(projectPath: string): Promise<ProjectMeta> {
  const abs = path.resolve(projectPath);

  try {
    await fs.access(abs);
  } catch {
    throw new Error(`Project path not found: ${abs}`);
  }

  const entries = await fs.readdir(abs);
  const flaxprojFile = entries.find(e => e.endsWith('.flaxproj'));
  if (!flaxprojFile) {
    throw new Error(`No .flaxproj found in ${abs}. Not a Flax Engine project.`);
  }

  const flaxprojPath = path.join(abs, flaxprojFile);
  const projData = JSON.parse(await fs.readFile(flaxprojPath, 'utf-8')) as { Name?: string };

  return {
    projectPath: abs,
    projectName: projData.Name ?? flaxprojFile.replace('.flaxproj', ''),
    flaxprojPath,
    contentDir: path.join(abs, 'Content'),
    sourceDir: path.join(abs, 'Source'),
    logsDir: path.join(abs, 'Logs'),
    settingsDir: path.join(abs, 'Content', 'Settings'),
  };
}

export function assertSafePath(resolved: string, projectPath: string): void {
  if (!resolved.startsWith(projectPath + path.sep) && resolved !== projectPath) {
    throw new Error(`Access denied: path is outside project root`);
  }
}

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function walkDir(
  dir: string,
  exts: string[],
  maxDepth = 5,
  currentDepth = 0
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];
  const results: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...await walkDir(full, exts, maxDepth, currentDepth + 1));
    } else if (entry.isFile()) {
      if (exts.length === 0 || exts.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  return results;
}
