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

  const cmds: vscode.Disposable[] = [
    vscode.commands.registerCommand('sparseExplorer.refresh', () => {
      provider.refresh();
    }),

    vscode.commands.registerCommand('sparseExplorer.ejectItem', (node: ExplorerNode) => {
      admittedStore.eject(node.uri.fsPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.expandAll', (node?: ExplorerNode) => {
      if (node) {
        expandStore.expand(node.uri.fsPath);
      } else {
        for (const f of vscode.workspace.workspaceFolders ?? []) {
          expandStore.expand(f.uri.fsPath);
        }
      }
      updateExpandContext();
      provider.refresh();
    }),

    vscode.commands.registerCommand('sparseExplorer.collapseToFiltered', (node?: ExplorerNode) => {
      if (node) {
        expandStore.collapse(node.uri.fsPath);
      } else {
        expandStore.collapseAll();
      }
      updateExpandContext();
      provider.refresh();
    }),

    vscode.commands.registerCommand(
      'sparseExplorer.filterExpanded',
      async (node?: ExplorerNode) => {
        const dirPath = node?.uri.fsPath ?? _expandedRootPath();
        if (!dirPath) return;
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
      },
    ),

    vscode.commands.registerCommand('sparseExplorer.clearFilter', (node?: ExplorerNode) => {
      if (node) {
        expandStore.clearFilter(node.uri.fsPath);
      } else {
        for (const f of vscode.workspace.workspaceFolders ?? []) {
          expandStore.clearFilter(f.uri.fsPath);
        }
      }
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
          { uri, isDirectory: false, isWorkspaceRoot: false, inExpandedContext: false },
          { select: true, focus: false },
        ),
      ).catch(() => undefined);
    }),
  );

  context.subscriptions.push(treeView, tabTracker, ...cmds);
}

export function deactivate(): void {}
