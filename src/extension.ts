import * as vscode from 'vscode';
import { AdmittedStore } from './AdmittedStore';
import { ExpandStore } from './ExpandStore';
import { ExplorerNode, FilteredExplorerProvider } from './FilteredExplorerProvider';
import { TabTracker } from './TabTracker';

export function activate(context: vscode.ExtensionContext): void {
  const tabTracker = new TabTracker();
  const admittedStore = new AdmittedStore(context);
  const expandStore = new ExpandStore();
  const provider = new FilteredExplorerProvider(tabTracker, admittedStore, expandStore);

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
      updateExpandContext();
      provider.refresh();
    }),
  );

  const treeView = vscode.window.createTreeView('sparseExplorer.view', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

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

  async function collapseAllRows(): Promise<void> {
    await vscode.commands
      .executeCommand('workbench.actions.treeView.sparseExplorer.view.collapseAll')
      .then(
        () => undefined,
        () => undefined,
      );
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

    vscode.commands.registerCommand('sparseExplorer.expandAll', async () => {
      await revealExpanded(expandRoots());
    }),

    vscode.commands.registerCommand('sparseExplorer.collapseToFiltered', async () => {
      expandStore.collapseAll();
      updateExpandContext();
      provider.refresh();
      await collapseAllRows();
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
      expandStore.expand(node.uri.fsPath);
      updateExpandContext();
      provider.refresh();
      await revealExpanded([node]);
    }),

    vscode.commands.registerCommand('sparseExplorer.collapseDir', async (node?: ExplorerNode) => {
      if (!node || !node.isDirectory) return;
      expandStore.collapse(node.uri.fsPath);
      updateExpandContext();
      provider.refresh();
      await collapseAllRows();
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
  ];

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return;
      const uri = editor.document.uri;
      if (uri.scheme !== 'file') return;
      if (!vscode.workspace.getWorkspaceFolder(uri)) return;
      if (!admittedStore.has(uri.fsPath)) return;
      if (expandStore.hasAnyExpanded()) return;
      void Promise.resolve(
        treeView.reveal(
          { uri, isDirectory: false, isWorkspaceRoot: false },
          { select: true, focus: false },
        ),
      ).catch(() => undefined);
    }),
  );

  context.subscriptions.push(treeView, tabTracker, ...cmds);
}

export function deactivate(): void {}
