import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ExpandStore } from '../ExpandStore';
import { FilteredExplorerProvider, ExplorerNode } from '../FilteredExplorerProvider';

// Pull in the mocked vscode so tests can control workspace folders.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');

// Minimal stubs — FilteredExplorerProvider only reads .tabPaths and .paths.
const tabTracker = { tabPaths: new Set<string>() } as any;
const admittedStore = { paths: new Set<string>() } as any;

function makeProvider(expandStore: ExpandStore): FilteredExplorerProvider {
  return new FilteredExplorerProvider(tabTracker, admittedStore, expandStore);
}

function node(fsPath: string, isDirectory = true, isWorkspaceRoot = false): ExplorerNode {
  return { uri: { fsPath } as any, isDirectory, isWorkspaceRoot };
}

describe('getTreeItem — contextValue', () => {
  beforeEach(() => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/root' } }];
    admittedStore.paths = new Set<string>();
    tabTracker.tabPaths = new Set<string>();
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders = undefined;
  });

  test('unexpanded non-root dir gets seDir.filtered', () => {
    const expandStore = new ExpandStore();
    const item = makeProvider(expandStore).getTreeItem(node('/root/src'));
    expect(item.contextValue).toBe('seDir.filtered');
  });

  test('dir that is itself expanded gets seDir.expanded', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root/src');
    const item = makeProvider(expandStore).getTreeItem(node('/root/src'));
    expect(item.contextValue).toBe('seDir.expanded');
  });

  test('dir that is itself expanded with a filter gets seDir.expandedFiltered', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root/src');
    expandStore.setFilter('/root/src', 'test');
    const item = makeProvider(expandStore).getTreeItem(node('/root/src'));
    expect(item.contextValue).toBe('seDir.expandedFiltered');
    expect(item.description).toBe('● filter: test');
  });

  test('expanded dir with no filter gets a bullet description', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root/src');
    const item = makeProvider(expandStore).getTreeItem(node('/root/src'));
    expect(item.description).toBe('●');
  });

  test('child dir of an expanded dir gets seDir.inExpanded', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root/src');
    const item = makeProvider(expandStore).getTreeItem(node('/root/src/utils'));
    expect(item.contextValue).toBe('seDir.inExpanded');
  });

  test('deeply nested child of an expanded dir gets seDir.inExpanded', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root/src');
    const item = makeProvider(expandStore).getTreeItem(node('/root/src/utils/helpers'));
    expect(item.contextValue).toBe('seDir.inExpanded');
  });

  test('workspace root not expanded gets seDir.workspaceRoot', () => {
    const expandStore = new ExpandStore();
    const item = makeProvider(expandStore).getTreeItem(node('/root', true, true));
    expect(item.contextValue).toBe('seDir.workspaceRoot');
  });

  test('workspace root expanded gets seDir.workspaceRoot.expanded', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root');
    const item = makeProvider(expandStore).getTreeItem(node('/root', true, true));
    expect(item.contextValue).toBe('seDir.workspaceRoot.expanded');
  });

  test('workspace root expanded with filter gets seDir.workspaceRoot.expandedFiltered', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root');
    expandStore.setFilter('/root', 'ts');
    const item = makeProvider(expandStore).getTreeItem(node('/root', true, true));
    expect(item.contextValue).toBe('seDir.workspaceRoot.expandedFiltered');
  });

  test('file gets seFile contextValue', () => {
    const expandStore = new ExpandStore();
    const item = makeProvider(expandStore).getTreeItem(node('/root/src/foo.ts', false));
    expect(item.contextValue).toBe('seFile');
  });

  test('open file gets bullet description', () => {
    const expandStore = new ExpandStore();
    tabTracker.tabPaths = new Set(['/root/src/foo.ts']);
    const item = makeProvider(expandStore).getTreeItem(node('/root/src/foo.ts', false));
    expect(item.description).toBe('•');
  });

  test('closed file has no description', () => {
    const expandStore = new ExpandStore();
    tabTracker.tabPaths = new Set<string>();
    const item = makeProvider(expandStore).getTreeItem(node('/root/src/foo.ts', false));
    expect(item.description).toBeUndefined();
  });

  // Regression: scope must be re-derived from the stores on every getTreeItem call,
  // not cached on the node object. Before the fix, inExpandedContext was stored on the
  // node; VS Code's item cache could hand back a stale node with a stale flag.
  test('contextValue updates after collapseAll on the same node object', () => {
    const expandStore = new ExpandStore();
    expandStore.expand('/root/src');
    const provider = makeProvider(expandStore);
    const n = node('/root/src/utils');

    expect(provider.getTreeItem(n).contextValue).toBe('seDir.inExpanded');

    expandStore.collapseAll();

    // Same node instance — but scope must be re-derived from the now-empty store.
    expect(provider.getTreeItem(n).contextValue).toBe('seDir.filtered');
  });

  test('_scopeFor stops at workspace root and does not walk past it', () => {
    // /root is the workspace root. /root/src is not expanded. /root is not expanded.
    // A node at /root/src should be seDir.filtered, not crash or give a wrong answer.
    const expandStore = new ExpandStore();
    const item = makeProvider(expandStore).getTreeItem(node('/root/src'));
    expect(item.contextValue).toBe('seDir.filtered');
  });
});

describe('getChildren', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sparse-provider-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.mkdir(path.join(tmpDir, 'lib'));
    await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'src', 'b.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'lib', 'c.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'README.md'), '');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    admittedStore.paths = new Set<string>();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
    vscode.workspace.workspaceFolders = undefined;
  });

  test('filtered mode: only shows dirs that contain admitted files', async () => {
    admittedStore.paths = new Set([path.join(tmpDir, 'src', 'a.ts')]);
    const expandStore = new ExpandStore();
    const children = await makeProvider(expandStore).getChildren();
    const names = children.map(n => path.basename(n.uri.fsPath));
    expect(names).toContain('src');
    expect(names).not.toContain('lib');
    expect(names).not.toContain('README.md');
  });

  test('filtered mode: shows nothing when no files are admitted', async () => {
    admittedStore.paths = new Set<string>();
    const expandStore = new ExpandStore();
    const children = await makeProvider(expandStore).getChildren();
    expect(children).toHaveLength(0);
  });

  test('expanded mode: shows all entries regardless of admittedStore', async () => {
    admittedStore.paths = new Set<string>();
    const expandStore = new ExpandStore();
    expandStore.expand(tmpDir);
    const children = await makeProvider(expandStore).getChildren();
    const names = children.map(n => path.basename(n.uri.fsPath)).sort();
    expect(names).toEqual(['README.md', 'lib', 'src'].sort());
  });

  test('expanded mode with filter: excludes files/dirs that do not match', async () => {
    admittedStore.paths = new Set<string>();
    const expandStore = new ExpandStore();
    expandStore.expand(tmpDir);
    expandStore.setFilter(tmpDir, '.ts');  // matches .ts files
    const children = await makeProvider(expandStore).getChildren();
    const names = children.map(n => path.basename(n.uri.fsPath));
    // src and lib contain .ts files; README.md does not
    expect(names).toContain('src');
    expect(names).toContain('lib');
    expect(names).not.toContain('README.md');
  });

  describe('a directory symlinked into the workspace', () => {
    // Target lives outside the workspace, as a symlinked dir typically would.
    let external: string;

    beforeEach(async () => {
      external = await fs.mkdtemp(path.join(os.tmpdir(), 'sparse-external-'));
      await fs.writeFile(path.join(external, 'linked.ts'), '');
      await fs.symlink(external, path.join(tmpDir, 'linkdir'));
    });

    afterEach(async () => {
      await fs.rm(external, { recursive: true });
    });

    test('expanded mode: renders as a directory, not a leaf file', async () => {
      admittedStore.paths = new Set<string>();
      const expandStore = new ExpandStore();
      expandStore.expand(tmpDir);
      const children = await makeProvider(expandStore).getChildren();
      const link = children.find(n => path.basename(n.uri.fsPath) === 'linkdir')!;
      expect(link).toBeDefined();
      expect(link.isDirectory).toBe(true);
    });

    test('expanded mode: its contents are listed', async () => {
      admittedStore.paths = new Set<string>();
      const expandStore = new ExpandStore();
      expandStore.expand(tmpDir);
      const provider = makeProvider(expandStore);
      const link = (await provider.getChildren()).find(
        n => path.basename(n.uri.fsPath) === 'linkdir',
      )!;
      const grandchildren = await provider.getChildren(link);
      expect(grandchildren.map(n => path.basename(n.uri.fsPath))).toEqual(['linked.ts']);
    });

    test('filtered mode: an admitted file underneath makes it visible as a directory', async () => {
      admittedStore.paths = new Set([path.join(tmpDir, 'linkdir', 'linked.ts')]);
      const expandStore = new ExpandStore();
      const provider = makeProvider(expandStore);
      const link = (await provider.getChildren()).find(
        n => path.basename(n.uri.fsPath) === 'linkdir',
      )!;
      expect(link).toBeDefined();
      expect(link.isDirectory).toBe(true);
      const grandchildren = await provider.getChildren(link);
      expect(grandchildren.map(n => path.basename(n.uri.fsPath))).toEqual(['linked.ts']);
    });
  });

  test('dirs sort before files within the same level', async () => {
    admittedStore.paths = new Set([
      path.join(tmpDir, 'src', 'a.ts'),
      path.join(tmpDir, 'README.md'),
    ]);
    const expandStore = new ExpandStore();
    const children = await makeProvider(expandStore).getChildren();
    const firstIsDir = children[0].isDirectory;
    expect(firstIsDir).toBe(true);
  });
});
