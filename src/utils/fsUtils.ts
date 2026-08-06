import * as fs from 'fs/promises';
import * as path from 'path';

export interface FsEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
}

export async function readDir(dirPath: string): Promise<FsEntry[]> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return Promise.all(
    entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(async e => {
        const fullPath = path.join(dirPath, e.name);
        return {
          name: e.name,
          fullPath,
          // A symlink's Dirent reports isDirectory() === false even when it points
          // at a directory, which would render it as a leaf file. stat() follows the
          // link so symlinked directories expand like they do in the built-in
          // explorer; a broken link stats to nothing and stays a leaf.
          isDirectory: e.isSymbolicLink() ? await isDirectory(fullPath) : e.isDirectory(),
        };
      }),
  );
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function hasMatchingDescendant(
  dirPath: string,
  filter: string,
  // Real paths of directories already walked, so a symlink cycle (or a directory
  // reachable by two paths) terminates instead of recursing forever. Shared across
  // siblings: re-walking a directory that already came back false can't change the answer.
  seen: Set<string> = new Set(),
): Promise<boolean> {
  const real = await realPathOrSelf(dirPath);
  if (seen.has(real)) return false;
  seen.add(real);

  const lowerFilter = filter.toLowerCase();
  const entries = await readDir(dirPath);
  for (const entry of entries) {
    if (!entry.isDirectory) {
      if (entry.name.toLowerCase().includes(lowerFilter)) return true;
    } else {
      if (await hasMatchingDescendant(entry.fullPath, filter, seen)) return true;
    }
  }
  return false;
}

async function realPathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}
