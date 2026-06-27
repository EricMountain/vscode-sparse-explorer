# Sparse Explorer — Architecture and Code Walkthrough

## What it does

Sparse Explorer is a VS Code tree-view extension that shows a focused subset of the workspace: only files you have opened (or that were open at startup), plus the ancestor directories needed to reach them. Files stay in the view after their tab is closed. You can remove them explicitly, or temporarily reveal an entire directory's contents.

---

## Component map

```
extension.ts          — activation, event wiring, command registration
TabTracker            — watches vscode.window.tabGroups; emits newly-opened paths
AdmittedStore         — the persisted set of file paths shown in filtered mode
ExpandStore           — session-only set of expanded directories + per-dir filters
FilteredExplorerProvider — TreeDataProvider; the single source of truth for what the tree shows
utils/pathUtils.ts    — derives visible ancestor dirs from admitted file paths
utils/fsUtils.ts      — async readdir + recursive filter-match helper
```

There is no database or back-end. All state lives in memory during the session, except for `AdmittedStore` which writes to `workspaceState` so it survives restarts.

---

## State model

### AdmittedStore (`src/AdmittedStore.ts`)

A `Set<string>` of absolute file paths. A path is added when a tab opens; it is only removed by the user clicking "Remove from View."

```
_admittedPaths: Set<string>
  admit(path)     — add path, persist, fire onDidChange
  admitAll(paths) — batch add, only fires if the set actually grew
  eject(path)     — remove path, persist, fire onDidChange
  has(path)       — synchronous membership check
```

`onDidChange` is the signal to rebuild the tree; `extension.ts` wires it to `provider.refresh()`.

### ExpandStore (`src/ExpandStore.ts`)

Session-only. Tracks which directories the user has expanded beyond the filtered view, and any per-directory filename filter.

```
_expandedDirs: Set<string>
_dirFilters:   Map<string, string>

  expand(dir)          — add dir to expanded set
  collapse(dir)        — remove dir + its filter
  collapseAll()        — clear both structures
  setFilter/getFilter  — per-dir filter string
  hasAnyExpanded()     — any directory expanded at all?
  isExpanded(dir)      — is this specific dir expanded?
```

`ExpandStore` never fires events; callers always follow an expand/collapse with `provider.refresh()` and `updateExpandContext()` themselves.

---

## Activation and wiring (`src/extension.ts`)

`activate()` instantiates the four objects, connects them with events, and registers commands. Key wiring:

```
tabTracker.onDidOpenTabs  → admittedStore.admitAll(paths)
tabTracker.onDidChange    → provider.refresh()   (refreshes "open" description badges)
admittedStore.onDidChange → provider.refresh()

onDidChangeActiveTextEditor → treeView.reveal(activeFile)
                              (skipped when any dir is expanded — see below)
```

`updateExpandContext()` writes two VS Code context variables that drive toolbar button visibility:

| Context variable             | Meaning                                   |
|------------------------------|-------------------------------------------|
| `sparseExplorer.hasExpanded` | At least one directory is in expand mode  |
| `sparseExplorer.rootHasFilter` | The workspace root has an active filter  |

These are re-evaluated after every expand/collapse/filter operation and whenever the workspace folders change.

---

## Tree rendering (`src/FilteredExplorerProvider.ts`)

`FilteredExplorerProvider` implements `vscode.TreeDataProvider<ExplorerNode>`.

### The node type

```typescript
interface ExplorerNode {
  uri: vscode.Uri
  isDirectory: boolean
  isWorkspaceRoot: boolean
  inExpandedContext: boolean   // true → node lives inside a "show all files" subtree
  propagatedFilter?: string    // active filename filter flowing down from an ancestor
}
```

`inExpandedContext` is the key flag that separates the two rendering modes.

### `getChildren` — the routing logic

```
getChildren(undefined)          // asking for the root level
  ├─ single workspace, root expanded → _getExpandedChildren(root)
  └─ single workspace, not expanded  → _getFilteredChildren(root)

getChildren(node)               // asking for a directory's children
  ├─ node.inExpandedContext     → _getExpandedChildren(dir)   [inherits expand state]
  ├─ expandStore.isExpanded(dir)→ _getExpandedChildren(dir)   [this dir itself was expanded]
  └─ otherwise                  → _getFilteredChildren(dir)
```

### Filtered mode — `_getFilteredChildren`

Calls `computeVisiblePaths(admittedStore.paths, roots)` (from `pathUtils.ts`) to build the set of paths that should exist in the tree: each admitted file plus every ancestor directory between it and the workspace root. Then reads the directory with `readDir()` and returns only entries whose `fullPath` is in that visible set.

```
_getFilteredChildren('/workspace')
  computeVisiblePaths({'/workspace/src/foo.ts', '/workspace/lib/bar.ts'}, ['/workspace'])
  → visible = { /workspace/src, /workspace/src/foo.ts, /workspace/lib, /workspace/lib/bar.ts }
  readDir('/workspace') → [src/, lib/, README.md, ...]
  keep only entries in visible → [src/, lib/]
```

Result: a minimal tree. Only the paths you need to reach your files appear.

### Expanded mode — `_getExpandedChildren`

Reads the directory from disk with `readDir()` and returns **all** entries, ignoring `admittedStore` entirely. If a filter string is active, directories are only included if `hasMatchingDescendant` finds at least one filename containing the filter string (case-insensitive), and files are only included if their name contains the filter.

`inExpandedContext: true` propagates down through directory nodes so that nested `getChildren` calls also use `_getExpandedChildren`.

### `getTreeItem` — visual representation

| Node type | `collapsibleState` | `contextValue` |
|-----------|--------------------|----------------|
| Workspace root, expanded | `Expanded` | `seDir.workspaceRoot.expanded` or `seDir.workspaceRoot.expandedFiltered` |
| Workspace root, not expanded | `Collapsed` | `seDir.workspaceRoot` |
| Directory, expanded | `Expanded` | `seDir.expanded` or `seDir.expandedFiltered` |
| Directory, in-expanded context | `Collapsed` | `seDir.inExpanded` |
| Directory, filtered | `Collapsed` | `seDir.filtered` |
| File | `None` | `seFile` |

The `contextValue` strings drive all toolbar and context-menu `when` conditions in `package.json`.

---

## Key flows

### A tab opens for the first time

1. `vscode.window.tabGroups.onDidChangeTabs` fires in `TabTracker`
2. `TabTracker` calls `_update()` to refresh its `tabPaths` set, fires `onDidChange` (→ `provider.refresh()`), then fires `onDidOpenTabs([path])`
3. `admittedStore.admitAll([path])` adds the path; because the set grew, it fires `onDidChange` → `provider.refresh()`
4. `onDidChangeActiveTextEditor` fires; the file is now in `admittedStore`, so `treeView.reveal()` is called to select it in the tree (unless `expandStore.hasAnyExpanded()` — see below)

### Selecting the active file in the tree (`treeView.reveal`)

The reveal call keeps the tree selection in sync with the active editor. It is skipped when any directory is in "show all files" mode because revealing in that state causes VS Code to internally mark the file's parent directory as "user-expanded." That internal state survives the tree refresh triggered by "Collapse to Filtered View," leaving parent directories visually open even though `ExpandStore` is clear — and since `sparseExplorer.hasExpanded` has been set to `false`, the collapse button is gone.

```typescript
// extension.ts — onDidChangeActiveTextEditor
if (expandStore.hasAnyExpanded()) return;   // ← skip reveal in expanded mode
treeView.reveal({ uri, isDirectory: false, isWorkspaceRoot: false, inExpandedContext: false },
                { select: true, focus: false });
```

### "Show All Files" on the workspace root

`sparseExplorer.expandAll` → `expandStore.expand(rootPath)` → `updateExpandContext()` → `provider.refresh()`.

On the next `getChildren(undefined)` call, `expandStore.isExpanded(rootPath)` is true, so `_getExpandedChildren` is used for the root and all its descendants.

### "Collapse to Filtered View"

`sparseExplorer.collapseToFiltered` → `expandStore.collapseAll()` → `updateExpandContext()` → `provider.refresh()`.

On the next `getChildren(undefined)`, `expandStore.isExpanded(rootPath)` is false, so `_getFilteredChildren` is used. The tree returns to showing only admitted paths.

### "Remove from View"

`sparseExplorer.ejectItem(node)` → `admittedStore.eject(node.uri.fsPath)` → `onDidChange` → `provider.refresh()`.

Because `ejectItem` removes a path from `admittedStore`, `_getFilteredChildren` will no longer include it in the `computeVisiblePaths` result. The item disappears from the tree.

"Remove from View" is hidden when `sparseExplorer.hasExpanded` is true (the `when` condition in `package.json` includes `!sparseExplorer.hasExpanded`). In expanded mode, `_getExpandedChildren` reads from disk and ignores `admittedStore`, so ejecting a file would be a silent no-op.

---

## `getParent` and tree reveal

`FilteredExplorerProvider` implements `getParent()` so that `treeView.reveal()` works. VS Code calls `getParent()` repeatedly to walk from a leaf node up to the root, then expands each node in the chain to make the target visible.

`_computeNodeContext(dirPath)` is the helper that determines whether a given directory is inside an "expanded" subtree by walking up the ancestor chain and checking `expandStore.isExpanded()` at each level.

---

## `computeVisiblePaths` (`src/utils/pathUtils.ts`)

Takes the set of admitted file paths and returns a flat `Set` of every path that needs a row in the tree:

```
for each admitted path:
  add the file itself
  add each ancestor directory up to (but not including) the workspace root
```

This is called on every `_getFilteredChildren` invocation, so it always reflects the current `admittedStore` state.

---

## `readDir` and `hasMatchingDescendant` (`src/utils/fsUtils.ts`)

`readDir` wraps `fs.readdir` and filters out dotfiles (except `.env`). Returns `{ name, fullPath, isDirectory }` entries.

`hasMatchingDescendant(dir, filter)` recursively walks the filesystem from `dir` to find any file whose name contains `filter` (case-insensitive). It is used by `_getExpandedChildren` to decide whether to include a subdirectory when a filter is active.
