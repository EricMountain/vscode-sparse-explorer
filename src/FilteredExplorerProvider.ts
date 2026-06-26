import * as path from 'path';
import * as vscode from 'vscode';
import { AdmittedStore } from './AdmittedStore';
import { ExpandStore } from './ExpandStore';
import { TabTracker } from './TabTracker';
import { hasMatchingDescendant, readDir } from './utils/fsUtils';
import { computeVisiblePaths } from './utils/pathUtils';

export interface ExplorerNode {
  uri: vscode.Uri;
  isDirectory: boolean;
  isWorkspaceRoot: boolean;
  inExpandedContext: boolean;
  propagatedFilter?: string;
}

export class FilteredExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly tabTracker: TabTracker,
    private readonly admittedStore: AdmittedStore,
    private readonly expandStore: ExpandStore,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    if (node.isWorkspaceRoot) return undefined;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

    const parentPath = path.dirname(node.uri.fsPath);

    const parentWsFolder = workspaceFolders.find(f => f.uri.fsPath === parentPath);
    if (parentWsFolder) {
      if (workspaceFolders.length === 1) return undefined;
      return { uri: vscode.Uri.file(parentPath), isDirectory: true, isWorkspaceRoot: true, inExpandedContext: false };
    }

    const { inExpandedContext, propagatedFilter } = this._computeNodeContext(parentPath);
    return { uri: vscode.Uri.file(parentPath), isDirectory: true, isWorkspaceRoot: false, inExpandedContext, propagatedFilter };
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.uri);
    item.id = node.uri.fsPath;

    if (node.isDirectory) {
      const isExpanded = this.expandStore.isExpanded(node.uri.fsPath);
      item.collapsibleState = isExpanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;

      if (node.isWorkspaceRoot) {
        item.contextValue = 'seDir.workspaceRoot';
      } else if (isExpanded) {
        item.contextValue = this.expandStore.hasFilter(node.uri.fsPath)
          ? 'seDir.expandedFiltered'
          : 'seDir.expanded';
        const filter = this.expandStore.getFilter(node.uri.fsPath);
        if (filter) {
          item.description = `filter: ${filter}`;
        }
      } else if (node.inExpandedContext) {
        item.contextValue = 'seDir.inExpanded';
      } else {
        item.contextValue = 'seDir.filtered';
      }
    } else {
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [node.uri],
      };
      item.contextValue = 'seFile';
      if (this.tabTracker.tabPaths.has(node.uri.fsPath)) {
        item.description = 'open';
      }
    }

    return item;
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    if (!node) {
      if (workspaceFolders.length === 1) {
        return this._getFilteredChildren(workspaceFolders[0].uri.fsPath);
      }
      return workspaceFolders.map(f => ({
        uri: f.uri,
        isDirectory: true,
        isWorkspaceRoot: true,
        inExpandedContext: false,
      }));
    }

    const dirPath = node.uri.fsPath;

    if (node.inExpandedContext) {
      return this._getExpandedChildren(dirPath, true, node.propagatedFilter);
    }

    if (this.expandStore.isExpanded(dirPath)) {
      const filter = this.expandStore.getFilter(dirPath);
      return this._getExpandedChildren(dirPath, true, filter);
    }

    return this._getFilteredChildren(dirPath);
  }

  private async _getFilteredChildren(dirPath: string): Promise<ExplorerNode[]> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const visible = computeVisiblePaths(this.admittedStore.paths, roots);

    const entries = await readDir(dirPath);
    const nodes: ExplorerNode[] = [];

    for (const entry of entries) {
      if (visible.has(entry.fullPath)) {
        nodes.push({
          uri: vscode.Uri.file(entry.fullPath),
          isDirectory: entry.isDirectory,
          isWorkspaceRoot: false,
          inExpandedContext: false,
        });
      }
    }

    return nodes.sort(compareNodes);
  }

  private _computeNodeContext(dirPath: string): { inExpandedContext: boolean; propagatedFilter: string | undefined } {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspacePaths = new Set(workspaceFolders.map(f => f.uri.fsPath));

    const parentPath = path.dirname(dirPath);
    if (workspacePaths.has(parentPath) || parentPath === dirPath) {
      return { inExpandedContext: false, propagatedFilter: undefined };
    }

    if (this.expandStore.isExpanded(parentPath)) {
      return { inExpandedContext: true, propagatedFilter: this.expandStore.getFilter(parentPath) };
    }

    return this._computeNodeContext(parentPath);
  }

  private async _getExpandedChildren(
    dirPath: string,
    inExpandedContext: boolean,
    filter: string | undefined,
  ): Promise<ExplorerNode[]> {
    const entries = await readDir(dirPath);
    const nodes: ExplorerNode[] = [];

    for (const entry of entries) {
      if (!filter) {
        nodes.push({
          uri: vscode.Uri.file(entry.fullPath),
          isDirectory: entry.isDirectory,
          isWorkspaceRoot: false,
          inExpandedContext,
          propagatedFilter: filter,
        });
      } else {
        const lowerFilter = filter.toLowerCase();
        if (!entry.isDirectory) {
          if (entry.name.toLowerCase().includes(lowerFilter)) {
            nodes.push({
              uri: vscode.Uri.file(entry.fullPath),
              isDirectory: false,
              isWorkspaceRoot: false,
              inExpandedContext,
              propagatedFilter: filter,
            });
          }
        } else {
          if (await hasMatchingDescendant(entry.fullPath, filter)) {
            nodes.push({
              uri: vscode.Uri.file(entry.fullPath),
              isDirectory: true,
              isWorkspaceRoot: false,
              inExpandedContext,
              propagatedFilter: filter,
            });
          }
        }
      }
    }

    return nodes.sort(compareNodes);
  }
}

function compareNodes(a: ExplorerNode, b: ExplorerNode): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return path.basename(a.uri.fsPath).localeCompare(path.basename(b.uri.fsPath));
}
