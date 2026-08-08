import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readDir, hasMatchingDescendant } from '../utils/fsUtils';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sparse-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

describe('readDir', () => {
  test('returns files and directories', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'foo.ts'), '');
    const entries = await readDir(tmpDir);
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['foo.ts', 'src']);
  });

  test('isDirectory is correct for each entry', async () => {
    await fs.mkdir(path.join(tmpDir, 'dir'));
    await fs.writeFile(path.join(tmpDir, 'file.ts'), '');
    const entries = await readDir(tmpDir);
    const dir = entries.find(e => e.name === 'dir')!;
    const file = entries.find(e => e.name === 'file.ts')!;
    expect(dir.isDirectory).toBe(true);
    expect(file.isDirectory).toBe(false);
  });

  test('fullPath is the absolute path of each entry', async () => {
    await fs.writeFile(path.join(tmpDir, 'foo.ts'), '');
    const entries = await readDir(tmpDir);
    expect(entries[0].fullPath).toBe(path.join(tmpDir, 'foo.ts'));
  });

  test('includes dotfiles and dot-directories', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'));
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '');
    await fs.writeFile(path.join(tmpDir, '.env'), '');
    await fs.writeFile(path.join(tmpDir, 'visible.ts'), '');
    const entries = await readDir(tmpDir);
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['.env', '.git', '.gitignore', 'visible.ts']);
  });

  test('returns empty array for a non-existent directory', async () => {
    const entries = await readDir(path.join(tmpDir, 'does-not-exist'));
    expect(entries).toEqual([]);
  });

  test('a symlink to a directory reports isDirectory true', async () => {
    await fs.mkdir(path.join(tmpDir, 'target'));
    await fs.symlink(path.join(tmpDir, 'target'), path.join(tmpDir, 'link'));
    const entries = await readDir(tmpDir);
    const link = entries.find(e => e.name === 'link')!;
    expect(link.isDirectory).toBe(true);
    expect(link.fullPath).toBe(path.join(tmpDir, 'link'));
  });

  test('a symlink to a file reports isDirectory false', async () => {
    await fs.writeFile(path.join(tmpDir, 'target.ts'), '');
    await fs.symlink(path.join(tmpDir, 'target.ts'), path.join(tmpDir, 'link.ts'));
    const entries = await readDir(tmpDir);
    expect(entries.find(e => e.name === 'link.ts')!.isDirectory).toBe(false);
  });

  test('a broken symlink is listed as a non-directory', async () => {
    await fs.symlink(path.join(tmpDir, 'gone'), path.join(tmpDir, 'dangling'));
    const entries = await readDir(tmpDir);
    const dangling = entries.find(e => e.name === 'dangling')!;
    expect(dangling).toBeDefined();
    expect(dangling.isDirectory).toBe(false);
  });

  test('lists the contents of a symlinked directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'target'));
    await fs.writeFile(path.join(tmpDir, 'target', 'inside.ts'), '');
    await fs.symlink(path.join(tmpDir, 'target'), path.join(tmpDir, 'link'));
    const entries = await readDir(path.join(tmpDir, 'link'));
    expect(entries.map(e => e.name)).toEqual(['inside.ts']);
  });
});

describe('hasMatchingDescendant', () => {
  test('returns false for an empty directory', async () => {
    expect(await hasMatchingDescendant(tmpDir, 'test')).toBe(false);
  });

  test('finds a directly matching file', async () => {
    await fs.writeFile(path.join(tmpDir, 'MyComponent.test.ts'), '');
    expect(await hasMatchingDescendant(tmpDir, 'test')).toBe(true);
  });

  test('returns false when no files match', async () => {
    await fs.writeFile(path.join(tmpDir, 'component.ts'), '');
    expect(await hasMatchingDescendant(tmpDir, 'test')).toBe(false);
  });

  test('finds a matching file nested in a subdirectory', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'button.spec.ts'), '');
    expect(await hasMatchingDescendant(tmpDir, 'spec')).toBe(true);
  });

  test('is case-insensitive', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), '');
    expect(await hasMatchingDescendant(tmpDir, 'readme')).toBe(true);
    expect(await hasMatchingDescendant(tmpDir, 'README')).toBe(true);
  });

  test('does not match directory names, only file names', async () => {
    await fs.mkdir(path.join(tmpDir, 'tests'));
    // 'tests' dir exists but has no files inside — no file name contains 'test'
    expect(await hasMatchingDescendant(tmpDir, 'test')).toBe(false);
  });

  test('descends through a symlinked directory', async () => {
    const target = path.join(tmpDir, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'button.spec.ts'), '');
    const root = path.join(tmpDir, 'root');
    await fs.mkdir(root);
    await fs.symlink(target, path.join(root, 'link'));
    expect(await hasMatchingDescendant(root, 'spec')).toBe(true);
  });

  test('terminates on a symlink cycle', async () => {
    const a = path.join(tmpDir, 'a');
    await fs.mkdir(a);
    await fs.symlink(tmpDir, path.join(a, 'loop'));
    expect(await hasMatchingDescendant(tmpDir, 'nomatch')).toBe(false);
  });
});
