# CLAUDE.md

Guidance for working in this repo. For a full component walkthrough see `ARCHITECTURE.md`.

## What this is

A VS Code extension ("Sparse Explorer") providing a tree view that shows only open
tabs + explicitly-admitted files, with a per-directory "Show All Files" (expanded)
mode and a recursive filename filter. State lives in:

- `AdmittedStore` — persisted set of file paths shown in filtered mode (`workspaceState`).
- `ExpandStore` — session-only set of expanded directories + per-dir filters.
- `FilteredExplorerProvider` — the `TreeDataProvider`; the single source of truth for what renders.

## Build / test workflow

- `npm run compile` — one-shot `tsc` build to `out/`. Always run this after edits to check types.
- `npm run watch` — rebuild on save.
- `npm run package` — produce a `.vsix`.
- **There is no automated test suite and the UI cannot be driven from the CLI.** To verify
  behavior, the change must be loaded into an **Extension Development Host** (launch via `F5`,
  then `Cmd+R` to reload after a recompile). Don't claim a UI behavior is fixed from reasoning
  alone — confirm it in the running host.

### Debugging the tree at runtime

When tree behavior is wrong, reasoning about VS Code internals is unreliable — instrument
instead. Add a temporary `vscode.window.createOutputChannel('...')` and log command
invocations (with their `node` arg), `getChildren` calls (path + computed scope + item count),
and refresh/reveal/collapse calls. Ask the user to reproduce and paste the Output panel. This
found root causes in minutes that hours of theorizing got wrong. Remove the logging once fixed.

## CI / automated releases

Three GitHub Actions workflows live in `.github/workflows/`:

- **`ci.yml`** — runs `npm test` on every push to `main` and every PR. On a `v*` tag push it additionally runs `npm run package` and creates a GitHub Release with the `.vsix` attached.
- **`auto-merge.yml`** — when Dependabot opens or updates a PR, approves it and enables GitHub's native auto-merge (squash). Auto-merge only fires once all required status checks pass, so tests must be green first.
- **`auto-release.yml`** — when a Dependabot PR is merged, bumps the patch version in `package.json` / `package-lock.json`, commits it as `chore: release vX.Y.Z`, creates a `vX.Y.Z` tag, and pushes both. That tag push triggers the release job in `ci.yml`.

Dependabot is configured in `.github/dependabot.yml` to open a single grouped npm PR each Monday.

**Required one-time setup**: **Settings → Actions → General** → enable "Allow GitHub Actions to create and approve pull requests". Without this `auto-merge.yml` cannot merge PRs.

**Optional but recommended**: **Settings → Branches → Add branch protection rule** for `main`, enable "Require status checks to pass before merging", and select the `test` job. The `auto-merge.yml` workflow already gates on CI passing (it fires from `workflow_run` after CI succeeds), but branch protection adds a second line of defence against direct pushes bypassing CI.

**Branch protection caveat**: if you later enable strict branch protection that blocks direct pushes, the `auto-release` workflow's `git push origin main` will fail. The workflow file contains a comment explaining how to swap in a PAT (`secrets.GH_PAT`) to work around this.

To cut a manual release, tag any commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.

## VS Code TreeView gotchas (learned the hard way)

These caused a long debugging session; respect them.

1. **`TreeItem.collapsibleState` is only honored on an item's *first* render.** Once VS Code
   knows an item (by `id`), it tracks expansion itself and ignores later `collapsibleState`
   changes. So you cannot expand/collapse a row just by changing `collapsibleState` + firing
   `onDidChangeTreeData`.
   - To **expand** a row programmatically: `treeView.reveal(node, { expand: true })`.
   - To **collapse**: there is *no* per-node API. Use the built-in command
     `workbench.actions.treeView.<viewId>.collapseAll` (here:
     `workbench.actions.treeView.sparseExplorer.view.collapseAll`), which requires
     `showCollapseAll: true` on the `createTreeView` call.

2. **Title-bar (`view/title`) commands receive the tree's current selection as their first
   argument.** A title-bar action invoked while a file is selected gets that *file* as `node`.
   You therefore **cannot** distinguish "title-bar, act on everything" from "inline icon on a
   specific item" by argument presence. The fix is **separate command ids**: whole-tree commands
   (`expandAll`, `collapseToFiltered`, `filterExpanded`, `clearFilter`) ignore the arg and act on
   roots; per-item commands (`expandDir`, `collapseDir`, `filterDir`, `clearFilterDir`) act on the
   node. `view/title` menus point at the former, `view/item/context` at the latter.

3. **Don't store render-context flags on the node object.** VS Code caches elements by `id` and
   may hand back stale node instances on refresh, so a flag like `inExpandedContext` carried on
   the node goes out of sync. Derive context from the stores at render time instead — see
   `FilteredExplorerProvider._scopeFor(path)`, which walks ancestors against `ExpandStore`.

4. **Keep `TreeItem.id` stable** (here: `id = fsPath`). Changing ids across refreshes to try to
   force re-rendering breaks reveal/selection and expansion persistence. Use the reveal /
   collapseAll APIs above instead.

## Conventions

- `contextValue` strings (`seDir.filtered`, `seDir.expanded`, `seDir.inExpanded`,
  `seDir.workspaceRoot*`, `seFile`) drive all menu `when` clauses in `package.json`. Keep the two
  in sync when adding states.
- Eject ("Remove from View") both de-admits the path *and* closes its tab, so an ejected file
  isn't silently re-admitted when it regains focus.
- `readDir` (in `utils/fsUtils.ts`) hides dotfiles except `.env`.

## Git

Work is committed in small steps as features/fixes land. Don't commit unless asked.
