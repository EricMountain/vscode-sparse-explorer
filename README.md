# VSCode Sparse Explorer

A VS Code extension that cuts through the noise of a full file tree with a focused view showing only the files you've touched. Files appear automatically when you open a tab and stay visible until you explicitly remove them — no pinning required.

A dedicated activity bar icon opens the view alongside the default Explorer — both coexist, so you can switch freely.

---

## Features

- **Automatic admission** — files appear when you open a tab and stay visible after the tab closes
- **Explicit removal** — remove a file from the view with one click; it returns if you open it again
- **Expand a directory** — temporarily reveal all its descendants to browse or open files
- **Filter within an expanded directory** — type a string to recursively narrow the expanded view by filename
- **Multi-root workspace support** — works with both single-folder and `.code-workspace` multi-root setups

---

## Usage

Open the **Sparse Explorer** view from the activity bar (funnel icon).

### Files

| Action | How |
|---|---|
| Open a file | Click it |
| Remove a file from the view | Hover → click `×`, or right-click → **Remove from View** |

Files removed from the view will reappear automatically the next time you open a tab for them.

### Directories

| Action | How |
|---|---|
| Show all files in a directory | Hover → click **Show All Files**, or right-click → **Show All Files** |
| Filter within an expanded directory | Hover → click the search icon, or right-click → **Filter Files...** |
| Clear an active filter | Hover → click **Clear Filter**, or right-click → **Clear Filter** |
| Return to the sparse view | Hover → click **Collapse to Filtered View**, or right-click → **Collapse to Filtered View** |

Admitted file paths are persisted to workspace state. Expanded directories and active filters reset when VS Code closes.

---

## Installation from GitHub

### Option 1 — Download a release (easiest)

1. Go to the [Releases](../../releases) page and download `vscode-sparse-explorer-x.x.x.vsix`
2. Install it:

   ```bash
   code --install-extension vscode-sparse-explorer-x.x.x.vsix
   ```

   Or: Extensions sidebar → `···` → **Install from VSIX...**

### Option 2 — Clone and build

Requires Node.js 18+.

```bash
git clone https://github.com/YOUR_USERNAME/VSCode-ExplorerFilter
cd VSCode-ExplorerFilter
npm install
npm run package
code --install-extension vscode-sparse-explorer-0.0.1.vsix
```

---

## Local Development

Requires Node.js 18+ and VS Code.

```bash
git clone https://github.com/YOUR_USERNAME/VSCode-ExplorerFilter
cd VSCode-ExplorerFilter
npm install
npm run compile
```

Press `F5` in VS Code to open an **Extension Development Host** — a second VS Code window with the extension loaded. Changes to TypeScript require recompiling; use `npm run watch` to rebuild automatically on save, then reload the development host window (`Ctrl+R` / `Cmd+R`).

### Project structure

```
src/
  extension.ts                  — entry point, command registration
  TabTracker.ts                 — reads open tabs from vscode.window.tabGroups; emits newly-opened paths
  AdmittedStore.ts              — persists admitted paths to workspaceState; handles eject
  ExpandStore.ts                — session-only expanded dirs and per-dir filters
  FilteredExplorerProvider.ts   — TreeDataProvider: the core tree rendering logic
  utils/
    pathUtils.ts                — computes which ancestor dirs are visible
    fsUtils.ts                  — async readdir and recursive descendant matching
resources/
  sparse-explorer.svg           — activity bar icon
```

### Scripts

| Command | Description |
|---|---|
| `npm run compile` | One-shot TypeScript build |
| `npm run watch` | Rebuild on file changes |
| `npm run package` | Compile and produce a `.vsix` installable package |

## Credits

The activity bar icon (`resources/sparse-explorer.svg`) is derived from the
**files** icon in Microsoft's [VS Code codicons](https://github.com/microsoft/vscode-codicons),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), with a
funnel added to indicate the filtered view.
