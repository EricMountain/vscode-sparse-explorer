export class ExpandStore {
  private _expandedDirs = new Set<string>();
  private _dirFilters = new Map<string, string>();

  isExpanded(dirPath: string): boolean {
    return this._expandedDirs.has(dirPath);
  }

  expand(dirPath: string): void {
    this._expandedDirs.add(dirPath);
  }

  collapse(dirPath: string): void {
    this._expandedDirs.delete(dirPath);
    this._dirFilters.delete(dirPath);
  }

  setFilter(dirPath: string, filter: string): void {
    this._dirFilters.set(dirPath, filter);
  }

  clearFilter(dirPath: string): void {
    this._dirFilters.delete(dirPath);
  }

  getFilter(dirPath: string): string | undefined {
    return this._dirFilters.get(dirPath);
  }

  hasFilter(dirPath: string): boolean {
    return this._dirFilters.has(dirPath);
  }

  collapseAll(): void {
    this._expandedDirs.clear();
    this._dirFilters.clear();
  }

  hasAnyExpanded(): boolean {
    return this._expandedDirs.size > 0;
  }
}
