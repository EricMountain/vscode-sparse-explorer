import * as path from 'path';
import * as vscode from 'vscode';
import { AdmittedStore } from './AdmittedStore';
import { ExpandStore } from './ExpandStore';
import { ExplorerNode, FilteredExplorerProvider } from './FilteredExplorerProvider';
import { TabTracker } from './TabTracker';
import { log, resetClock } from './debugLog';

export function activate(context: vscode.ExtensionContext): void {
  const tabTracker = new TabTracker();
  const admittedStore = new AdmittedStore(context);
  const expandStore = new ExpandStore();
  const provider = new FilteredExplorerProvider(tabTracker, admittedStore, expandStore);

  let clipboard: { uri: vscode.Uri; mode: 'cut' | 'copy' } | undefined;

  // Admit all tabs already open at startup
  admittedStore.admitAll([...tabTracker.tabPaths]);

  // Auto-admit whenever a new tab is opened
  tabTracker.onDidOpenTabs(paths => {
    admittedStore.admitAll(paths);
  }, null, context.subscriptions);

  // Refresh the tree when tabs change (for the "open" description indicator)
  tabTracker.onDidChange(() => provider.refresh(), null, context.subscriptions);

  admittedStore.onDidChange(() => provider.refresh(), null, context.subscriptions);

  function _expandedRootPath(): string | undefined {
    return (vscode.workspace.workspaceFolders ?? []).find(f => expandStore.isExpanded(f.uri.fsPath))
      ?.uri.fsPath;
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateTitle();
      updateExpandContext();
      provider.refresh();
    }),
  );

  const treeView = vscode.window.createTreeView('sparseExplorer.view', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  // Mirrors the built-in Explorer, which shows the workspace/folder name in place of
  // the view's registered name.
  function updateTitle(): void {
    treeView.title = vscode.workspace.name;
  }
  updateTitle();

  function primaryRootPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  function updateExpandContext(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const hasExpanded = expandStore.hasAnyExpanded();
    const rootHasFilter = folders.some(
      f => expandStore.isExpanded(f.uri.fsPath) && expandStore.hasFilter(f.uri.fsPath),
    );
    void vscode.commands.executeCommand('setContext', 'sparseExplorer.hasExpanded', hasExpanded);
    void vscode.commands.executeCommand('setContext', 'sparseExplorer.rootHasFilter', rootHasFilter);
  }

  updateExpandContext();
  void vscode.commands.executeCommand('setContext', 'sparseExplorer.hasClipboard', false);

  // VS Code ignores a changed TreeItem.collapsibleState on an already-rendered row
  // and offers no API to collapse a single node. So expansion must be driven through
  // reveal (to open rows) and the built-in collapse-all command (to fold them up).
  async function revealExpanded(nodes: ExplorerNode[]): Promise<void> {
    for (const n of nodes) {
      await treeView.reveal(n, { expand: true, select: false, focus: false }).then(
        () => undefined,
        () => undefined,
      );
    }
  }

  // expandAll/collapseToFiltered/expandDir/collapseDir each run an async chain of
  // collapseAllRows/refresh/reveal calls. A fast repeat click (there's no visual feedback
  // while the chain is in flight) invokes the command again before the first call has
  // rendered anything, so the two chains interleave: two full collapse/refresh/reveal
  // cycles race each other and VS Code ends up doing several back-to-back render passes
  // when it catches up, which reads as flicker. Serialize these commands so a repeat
  // invocation while one is still running is a no-op.
  let treeOpInFlight = false;
  async function withTreeOpGuard(fn: () => Promise<void>): Promise<void> {
    if (treeOpInFlight) return;
    treeOpInFlight = true;
    try {
      await fn();
    } finally {
      treeOpInFlight = false;
    }
  }

  async function collapseAllRows(): Promise<void> {
    log('collapseAllRows: executing collapseAll command');
    await vscode.commands
      .executeCommand('workbench.actions.treeView.sparseExplorer.view.collapseAll')
      .then(
        () => undefined,
        () => undefined,
      );
    log('collapseAllRows: collapseAll command resolved');
  }

  function activeTabFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return undefined;
    const input = tab.input;
    if (
      input instanceof vscode.TabInputText ||
      input instanceof vscode.TabInputCustom ||
      input instanceof vscode.TabInputNotebook
    ) {
      return (input as vscode.TabInputText | vscode.TabInputCustom | vscode.TabInputNotebook).uri;
    }
    return undefined;
  }

  async function revealActiveFile(): Promise<void> {
    const uri = activeTabFileUri();
    if (!uri) return;
    if (uri.scheme !== 'file') return;
    if (!vscode.workspace.getWorkspaceFolder(uri)) return;
    if (!admittedStore.has(uri.fsPath)) return;
    log(`revealActiveFile: revealing ${uri.fsPath}`);
    await treeView
      .reveal({ uri, isDirectory: false, isWorkspaceRoot: false }, { select: true, focus: false })
      .then(() => undefined, () => undefined);
    log('revealActiveFile: done');
  }

  async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async function revealNode(node: ExplorerNode): Promise<void> {
    await treeView
      .reveal(node, { select: true, focus: false })
      .then(() => undefined, () => undefined);
  }

  // Mirrors the built-in Explorer's paste-conflict naming: "name copy.ext", "name copy 2.ext", ...
  async function uniqueDestUri(dir: string, baseName: string): Promise<vscode.Uri> {
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    let candidate = baseName;
    let n = 1;
    while (await fileExists(vscode.Uri.file(path.join(dir, candidate)))) {
      candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
      n++;
    }
    return vscode.Uri.file(path.join(dir, candidate));
  }

  async function createNewFile(dirPath: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'New file name',
      placeHolder: 'example.ts',
      validateInput: v => (v.trim() === '' ? 'Name required' : undefined),
    });
    if (!name) return;
    const newUri = vscode.Uri.file(path.join(dirPath, name));
    if (await fileExists(newUri)) {
      void vscode.window.showErrorMessage(`'${name}' already exists.`);
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to create file: ${(err as Error).message}`);
      return;
    }
    admittedStore.admit(newUri.fsPath);
    const doc = await vscode.workspace.openTextDocument(newUri);
    await vscode.window.showTextDocument(doc);
    await revealNode({ uri: newUri, isDirectory: false, isWorkspaceRoot: false });
  }

  async function createNewFolder(dirPath: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'New folder name',
      placeHolder: 'my-folder',
      validateInput: v => (v.trim() === '' ? 'Name required' : undefined),
    });
    if (!name) return;
    const newUri = vscode.Uri.file(path.join(dirPath, name));
    if (await fileExists(newUri)) {
      void vscode.window.showErrorMessage(`'${name}' already exists.`);
      return;
    }
    try {
      await vscode.workspace.fs.createDirectory(newUri);
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to create folder: ${(err as Error).message}`);
      return;
    }
    admittedStore.admit(newUri.fsPath);
    await revealNode({ uri: newUri, isDirectory: true, isWorkspaceRoot: false });
  }

  function revealInOS(node?: ExplorerNode): void {
    if (!node) return;
    void vscode.commands.executeCommand('revealFileInOS', node.uri);
  }

  async function promptFilter(dirPath: string): Promise<void> {
    const current = expandStore.getFilter(dirPath);
    const filter = await vscode.window.showInputBox({
      placeHolder: 'Filter files recursively...',
      value: current ?? '',
      prompt: 'Type to filter files within this directory (leave empty to show all)',
    });
    if (filter === undefined) return;
    if (filter === '') {
      expandStore.clearFilter(dirPath);
    } else {
      expandStore.setFilter(dirPath, filter);
    }
    updateExpandContext();
    provider.refresh();
  }

  // Title-bar commands act on the whole tree and ignore any argument: VS Code passes
  // the current tree selection to title-bar actions, which must not be mistaken for a
  // target. Item commands (the *Dir variants) act on the directory node they receive.

  function expandRoots(): ExplorerNode[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) expandStore.expand(f.uri.fsPath);
    updateExpandContext();
    provider.refresh();
    // Single-folder roots aren't rows (their children render at the top level and
    // re-fetch in expanded scope on refresh); only multi-root rows need revealing.
    return folders.length > 1
      ? folders.map(f => ({ uri: f.uri, isDirectory: true, isWorkspaceRoot: true }))
      : [];
  }

  const cmds: vscode.Disposable[] = [
    vscode.commands.registerCommand('sparseExplorer.refresh', () => {
      provider.refresh();
    }),

    vscode.commands.registerCommand('sparseExplorer.ejectItem', async (node: ExplorerNode) => {
      const fsPath = node.uri.fsPath;
      admittedStore.eject(fsPath);

      // Keep the view and the open tabs consistent: removing a file from the view
      // also closes its tab, otherwise an ejected file would linger as an open tab
      // and be re-admitted the moment it regained focus.
      const tabs = vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === fsPath);
      if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs);
      }
    }),

    // --- Title-bar (whole tree) ---

    vscode.commands.registerCommand('sparseExplorer.newFileRoot', async () => {
      const dirPath = primaryRootPath();
      if (!dirPath) return;
      await createNewFile(dirPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.newFolderRoot', async () => {
      const dirPath = primaryRootPath();
      if (!dirPath) return;
      await createNewFolder(dirPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.expandAll', async () => {
      await withTreeOpGuard(async () => {
        await revealExpanded(expandRoots());
      });
    }),

    vscode.commands.registerCommand('sparseExplorer.collapseToFiltered', async () => {
      await withTreeOpGuard(async () => {
        resetClock();
        log('collapseToFiltered: start');
        // Fold the rows first, while the tree's content still matches what's on screen.
        // Mutating expandStore before this and refreshing would re-fetch children for
        // still-expanded rows under the new (filtered) scope, flashing the wrong content
        // for a frame before the fold catches up (collapsibleState changes are ignored on
        // already-rendered rows, so only collapseAllRows() actually folds them — see
        // CLAUDE.md's TreeView gotcha #1).
        await collapseAllRows();
        expandStore.collapseAll();
        updateExpandContext();
        provider.refresh();
        await revealActiveFile();
        log('collapseToFiltered: end');
      });
    }),

    vscode.commands.registerCommand('sparseExplorer.filterExpanded', async () => {
      const dirPath = _expandedRootPath();
      if (!dirPath) return;
      await promptFilter(dirPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.clearFilter', () => {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        expandStore.clearFilter(f.uri.fsPath);
      }
      updateExpandContext();
      provider.refresh();
    }),

    // --- Item (single directory) ---

    vscode.commands.registerCommand('sparseExplorer.expandDir', async (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      await withTreeOpGuard(async () => {
        expandStore.expand(node.uri.fsPath);
        updateExpandContext();
        provider.refresh();
        await revealExpanded([node]);
      });
    }),

    vscode.commands.registerCommand('sparseExplorer.collapseDir', async (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      await withTreeOpGuard(async () => {
        resetClock();
        log(`collapseDir: start, target=${node.uri.fsPath}`);
        // See the comment in collapseToFiltered: fold rows before mutating state/refreshing
        // to avoid a flash of the new (filtered) children in a still-expanded row.
        await collapseAllRows();
        expandStore.collapse(node.uri.fsPath);
        updateExpandContext();
        provider.refresh();
        await revealActiveFile();
        log('collapseDir: end');
      });
    }),

    vscode.commands.registerCommand('sparseExplorer.filterDir', async (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      await promptFilter(node.uri.fsPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.clearFilterDir', (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      expandStore.clearFilter(node.uri.fsPath);
      updateExpandContext();
      provider.refresh();
    }),

    vscode.commands.registerCommand('sparseExplorer.revealInExplorer', (node: ExplorerNode) => {
      void vscode.commands.executeCommand('revealInExplorer', node.uri);
    }),

    // --- File operations (parity with the built-in Explorer) ---

    vscode.commands.registerCommand('sparseExplorer.copyPath', (node?: ExplorerNode) => {
      if (!node) return;
      void vscode.env.clipboard.writeText(node.uri.fsPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.copyRelativePath', (node?: ExplorerNode) => {
      if (!node) return;
      void vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(node.uri, false));
    }),

    vscode.commands.registerCommand('sparseExplorer.newFile', async (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      await createNewFile(node.uri.fsPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.newFolder', async (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      await createNewFolder(node.uri.fsPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.rename', async (node?: ExplorerNode) => {
      if (!node) return;
      const oldUri = node.uri;
      const dirPath = path.dirname(oldUri.fsPath);
      const oldName = path.basename(oldUri.fsPath);
      const extIndex = !node.isDirectory ? oldName.lastIndexOf('.') : -1;
      const name = await vscode.window.showInputBox({
        prompt: 'New name',
        value: oldName,
        valueSelection: [0, extIndex > 0 ? extIndex : oldName.length],
      });
      if (!name || name === oldName) return;
      const newUri = vscode.Uri.file(path.join(dirPath, name));
      try {
        await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to rename: ${(err as Error).message}`);
        return;
      }
      admittedStore.renamePrefix(oldUri.fsPath, newUri.fsPath);
      expandStore.renamePrefix(oldUri.fsPath, newUri.fsPath);
      updateExpandContext();
      await revealNode({ uri: newUri, isDirectory: node.isDirectory, isWorkspaceRoot: false });
    }),

    vscode.commands.registerCommand('sparseExplorer.delete', async (node?: ExplorerNode) => {
      if (!node) return;
      const fsPath = node.uri.fsPath;
      const label = path.basename(fsPath);
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete '${label}'?`,
        { modal: true },
        'Move to Trash',
      );
      if (confirm !== 'Move to Trash') return;
      try {
        await vscode.workspace.fs.delete(node.uri, { recursive: true, useTrash: true });
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to delete: ${(err as Error).message}`);
        return;
      }
      admittedStore.ejectPrefix(fsPath);
      expandStore.collapsePrefix(fsPath);
      updateExpandContext();
    }),

    // --- Open variants ---

    vscode.commands.registerCommand('sparseExplorer.openToSide', (node?: ExplorerNode) => {
      if (!node || node.isDirectory) return;
      void vscode.commands.executeCommand('vscode.open', node.uri, {
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),

    vscode.commands.registerCommand('sparseExplorer.openWith', (node?: ExplorerNode) => {
      if (!node || node.isDirectory) return;
      void vscode.commands.executeCommand('explorer.openWith', node.uri);
    }),

    // --- Compare ---

    vscode.commands.registerCommand('sparseExplorer.selectForCompare', (node?: ExplorerNode) => {
      if (!node || node.isDirectory) return;
      void vscode.commands.executeCommand('selectForCompare', node.uri);
    }),

    vscode.commands.registerCommand('sparseExplorer.compareWithSelected', (node?: ExplorerNode) => {
      if (!node || node.isDirectory) return;
      void vscode.commands.executeCommand('compareFiles', node.uri);
    }),

    // --- Cut / copy / paste ---

    vscode.commands.registerCommand('sparseExplorer.cut', (node?: ExplorerNode) => {
      if (!node) return;
      clipboard = { uri: node.uri, mode: 'cut' };
      void vscode.commands.executeCommand('setContext', 'sparseExplorer.hasClipboard', true);
    }),

    vscode.commands.registerCommand('sparseExplorer.copy', (node?: ExplorerNode) => {
      if (!node) return;
      clipboard = { uri: node.uri, mode: 'copy' };
      void vscode.commands.executeCommand('setContext', 'sparseExplorer.hasClipboard', true);
    }),

    vscode.commands.registerCommand('sparseExplorer.paste', async (node?: ExplorerNode) => {
      if (!node || !clipboard) return;
      const source = clipboard.uri;
      const targetDir = node.isDirectory ? node.uri.fsPath : path.dirname(node.uri.fsPath);

      let sourceIsDirectory: boolean;
      try {
        const stat = await vscode.workspace.fs.stat(source);
        sourceIsDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to paste: ${(err as Error).message}`);
        clipboard = undefined;
        void vscode.commands.executeCommand('setContext', 'sparseExplorer.hasClipboard', false);
        return;
      }

      const destUri = await uniqueDestUri(targetDir, path.basename(source.fsPath));
      try {
        if (clipboard.mode === 'copy') {
          await vscode.workspace.fs.copy(source, destUri, { overwrite: false });
        } else {
          await vscode.workspace.fs.rename(source, destUri, { overwrite: false });
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to paste: ${(err as Error).message}`);
        return;
      }

      if (clipboard.mode === 'cut') {
        admittedStore.renamePrefix(source.fsPath, destUri.fsPath);
        expandStore.renamePrefix(source.fsPath, destUri.fsPath);
        clipboard = undefined;
        void vscode.commands.executeCommand('setContext', 'sparseExplorer.hasClipboard', false);
      } else {
        admittedStore.admit(destUri.fsPath);
      }
      // A pasted directory would otherwise render as an empty-looking row until the
      // user manually expands it — show its contents immediately, same spirit as
      // newFile/newFolder making new items visible right away.
      if (sourceIsDirectory) {
        expandStore.expand(destUri.fsPath);
      }
      updateExpandContext();
      provider.refresh();
      await revealNode({ uri: destUri, isDirectory: sourceIsDirectory, isWorkspaceRoot: false });
    }),

    // --- OS integration ---

    vscode.commands.registerCommand('sparseExplorer.revealInOSMac', revealInOS),
    vscode.commands.registerCommand('sparseExplorer.revealInOSWindows', revealInOS),
    vscode.commands.registerCommand('sparseExplorer.revealInOSLinux', revealInOS),

    vscode.commands.registerCommand('sparseExplorer.openInIntegratedTerminal', (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      void vscode.commands.executeCommand('openInIntegratedTerminal', node.uri);
    }),

    vscode.commands.registerCommand('sparseExplorer.findInFolder', (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      void vscode.commands.executeCommand('filesExplorer.findInFolder', node.uri);
    }),
  ];

  function revealActiveFileIfAdmitted(): void {
    const uri = activeTabFileUri();
    if (!uri) return;
    if (uri.scheme !== 'file') return;
    if (!vscode.workspace.getWorkspaceFolder(uri)) return;
    if (!admittedStore.has(uri.fsPath)) return;
    if (!treeView.visible) return;
    if (expandStore.hasAnyExpanded()) return;
    void treeView
      .reveal({ uri, isDirectory: false, isWorkspaceRoot: false }, { select: true, focus: false })
      .then(() => undefined, () => undefined);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => revealActiveFileIfAdmitted()),
    vscode.window.tabGroups.onDidChangeTabs(e => {
      if (e.changed.some(t => t.isActive)) revealActiveFileIfAdmitted();
    }),
    // Tab switches while this view isn't visible are dropped by the treeView.visible
    // guard above (VS Code can't reveal into a hidden tree). Re-sync once it's shown
    // again, otherwise the highlight stays stuck on whatever was active last time it
    // was visible.
    treeView.onDidChangeVisibility(e => {
      if (e.visible) revealActiveFileIfAdmitted();
    }),
  );

  context.subscriptions.push(treeView, tabTracker, ...cmds);
}

export function deactivate(): void {}
