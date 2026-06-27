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
}

interface Scope {
  expanded: boolean;
  filter: string | undefined;
}

export class FilteredExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly tabTracker: TabTracker,
    private readonly admittedStore: AdmittedStore,
    private readonly expandStore: ExpandStore,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  refresh(): void {
    this.log('refresh() -> fire onDidChangeTreeData(undefined)');
    this._onDidChangeTreeData.fire();
  }

  /**
   * Walk from `p` up to (and including) the nearest workspace root, returning the
   * expansion scope governing it: whether some ancestor (or itself) is expanded,
   * and the filter of the nearest such expanded ancestor.
   *
   * This is the single source of truth for "is this path shown in expanded mode".
   * It is derived from ExpandStore on every render so it never goes stale, unlike
   * a flag carried on the node object (which VS Code may hand back from its cache).
   */
  private _scopeFor(p: string): Scope {
    const roots = new Set((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath));
    let cur = p;
    for (;;) {
      if (this.expandStore.isExpanded(cur)) {
        return { expanded: true, filter: this.expandStore.getFilter(cur) };
      }
      if (roots.has(cur)) return { expanded: false, filter: undefined };
      const parent = path.dirname(cur);
      if (parent === cur) return { expanded: false, filter: undefined };
      cur = parent;
    }
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    if (node.isWorkspaceRoot) return undefined;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

    const parentPath = path.dirname(node.uri.fsPath);

    const parentWsFolder = workspaceFolders.find(f => f.uri.fsPath === parentPath);
    if (parentWsFolder) {
      if (workspaceFolders.length === 1) return undefined;
      return { uri: vscode.Uri.file(parentPath), isDirectory: true, isWorkspaceRoot: true };
    }

    return { uri: vscode.Uri.file(parentPath), isDirectory: true, isWorkspaceRoot: false };
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.uri);
    const fsPath = node.uri.fsPath;
    const scope = this._scopeFor(fsPath);

    // Stable id: VS Code keys an item's identity (and its remembered expansion
    // state) on this. Keeping it stable lets an expanded directory survive a refresh
    // and re-fetch its children in the new scope — that's what makes "Show All Files"
    // reveal everything under an already-open directory. Collapsing is handled
    // separately via the built-in collapse-all command (see collapseToFiltered).
    item.id = fsPath;

    if (node.isDirectory) {
      const ownExpanded = this.expandStore.isExpanded(fsPath);
      item.collapsibleState = ownExpanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;

      if (ownExpanded) {
        const hasFilter = this.expandStore.hasFilter(fsPath);
        if (node.isWorkspaceRoot) {
          item.contextValue = hasFilter
            ? 'seDir.workspaceRoot.expandedFiltered'
            : 'seDir.workspaceRoot.expanded';
        } else {
          item.contextValue = hasFilter ? 'seDir.expandedFiltered' : 'seDir.expanded';
        }
        const filter = this.expandStore.getFilter(fsPath);
        if (filter) item.description = `filter: ${filter}`;
      } else if (node.isWorkspaceRoot) {
        item.contextValue = 'seDir.workspaceRoot';
      } else if (scope.expanded) {
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
      if (this.tabTracker.tabPaths.has(fsPath)) {
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
        return this._childrenOf(workspaceFolders[0].uri.fsPath);
      }
      return workspaceFolders.map(f => ({
        uri: f.uri,
        isDirectory: true,
        isWorkspaceRoot: true,
      }));
    }

    return this._childrenOf(node.uri.fsPath);
  }

  private async _childrenOf(dirPath: string): Promise<ExplorerNode[]> {
    const scope = this._scopeFor(dirPath);
    const nodes = scope.expanded
      ? await this._getExpandedChildren(dirPath, scope.filter)
      : await this._getFilteredChildren(dirPath);
    this.log(
      `getChildren(${path.basename(dirPath)}) scope=${scope.expanded ? 'EXPANDED' : 'filtered'} -> ${nodes.length} items`,
    );
    return nodes;
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
        });
      }
    }

    return nodes.sort(compareNodes);
  }

  private async _getExpandedChildren(
    dirPath: string,
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
        });
      } else if (!entry.isDirectory) {
        if (entry.name.toLowerCase().includes(filter.toLowerCase())) {
          nodes.push({
            uri: vscode.Uri.file(entry.fullPath),
            isDirectory: false,
            isWorkspaceRoot: false,
          });
        }
      } else if (await hasMatchingDescendant(entry.fullPath, filter)) {
        nodes.push({
          uri: vscode.Uri.file(entry.fullPath),
          isDirectory: true,
          isWorkspaceRoot: false,
        });
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
