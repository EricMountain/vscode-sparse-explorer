import * as fs from 'fs/promises';
import * as path from 'path';

export interface FsEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
}

export async function readDir(dirPath: string): Promise<FsEntry[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => ({
        name: e.name,
        fullPath: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }));
  } catch {
    return [];
  }
}

export async function hasMatchingDescendant(dirPath: string, filter: string): Promise<boolean> {
  const lowerFilter = filter.toLowerCase();
  const entries = await readDir(dirPath);
  for (const entry of entries) {
    if (!entry.isDirectory) {
      if (entry.name.toLowerCase().includes(lowerFilter)) return true;
    } else {
      if (await hasMatchingDescendant(entry.fullPath, filter)) return true;
    }
  }
  return false;
}
