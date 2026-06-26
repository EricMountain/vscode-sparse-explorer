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

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  );

  const treeView = vscode.window.createTreeView('sparseExplorer.view', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const cmds: vscode.Disposable[] = [
    vscode.commands.registerCommand('sparseExplorer.refresh', () => {
      provider.refresh();
    }),

    vscode.commands.registerCommand('sparseExplorer.ejectItem', (node: ExplorerNode) => {
      admittedStore.eject(node.uri.fsPath);
    }),

    vscode.commands.registerCommand('sparseExplorer.expandAll', (node: ExplorerNode) => {
      expandStore.expand(node.uri.fsPath);
      provider.refresh();
    }),

    vscode.commands.registerCommand('sparseExplorer.collapseToFiltered', (node: ExplorerNode) => {
      expandStore.collapse(node.uri.fsPath);
      provider.refresh();
    }),

    vscode.commands.registerCommand(
      'sparseExplorer.filterExpanded',
      async (node: ExplorerNode) => {
        const current = expandStore.getFilter(node.uri.fsPath);
        const filter = await vscode.window.showInputBox({
          placeHolder: 'Filter files recursively...',
          value: current ?? '',
          prompt: 'Type to filter files within this directory (leave empty to show all)',
        });
        if (filter === undefined) return;
        if (filter === '') {
          expandStore.clearFilter(node.uri.fsPath);
        } else {
          expandStore.setFilter(node.uri.fsPath, filter);
        }
        provider.refresh();
      },
    ),

    vscode.commands.registerCommand('sparseExplorer.clearFilter', (node: ExplorerNode) => {
      expandStore.clearFilter(node.uri.fsPath);
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
