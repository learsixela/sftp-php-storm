import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from '../config/configManager';
import { PendingChangeItem } from '../config/types';

interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  hash: string;
}

export class ChangeTracker {
  private _onDidChangePending = new vscode.EventEmitter<PendingChangeItem[]>();
  public readonly onDidChangePending = this._onDidChangePending.event;

  private cachedPending: PendingChangeItem[] = [];
  private fileCache = new Map<string, FileCacheEntry>();
  private isScanning = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private configManager: ConfigManager) {
    this.configManager.onDidChangeConfig(() => this.scheduleRefresh());
    this.initFileWatchers();
  }

  private getManifestPath(): string | null {
    const root = this.configManager.getWorkspaceRoot();
    if (!root) return null;
    
    const toolManifest = path.join(root, 'tools', 'sftp-sync', '.manifest.json');
    if (fs.existsSync(toolManifest)) {
      return toolManifest;
    }

    const dotVscodeDir = path.join(root, '.vscode');
    if (!fs.existsSync(dotVscodeDir)) {
      fs.mkdirSync(dotVscodeDir, { recursive: true });
    }
    return path.join(dotVscodeDir, '.manifest.json');
  }

  public loadManifest(): Record<string, string> | null {
    const mPath = this.getManifestPath();
    if (!mPath || !fs.existsSync(mPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(mPath, 'utf8'));
    } catch {
      return null;
    }
  }

  public saveManifest(manifest: Record<string, string>): void {
    const mPath = this.getManifestPath();
    if (!mPath) return;
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  /**
   * Fast incremental hash retrieval: checks mtime and size in memory cache first.
   */
  public getOrComputeHash(absPath: string, relPath: string): string | null {
    try {
      if (!fs.existsSync(absPath)) return null;
      const stat = fs.statSync(absPath);
      const cached = this.fileCache.get(relPath);

      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.hash;
      }

      const buf = fs.readFileSync(absPath);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      this.fileCache.set(relPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash
      });
      return hash;
    } catch {
      return null;
    }
  }

  /**
   * High performance O(1) incremental update when a single file is saved.
   * If the file is ignored (by .gitignore / .sftpignore / tools / etc.), removes it from pending list.
   */
  public notifyFileSaved(absPath: string): void {
    const rel = this.configManager.getRelativePath(absPath);
    if (!rel) return;

    if (this.configManager.shouldIgnore(rel)) {
      const idx = this.cachedPending.findIndex(p => p.relativePath === rel);
      if (idx >= 0) {
        this.cachedPending.splice(idx, 1);
        this._onDidChangePending.fire(this.cachedPending);
      }
      return;
    }

    const manifest = this.loadManifest();
    if (!manifest) {
      this.scheduleRefresh();
      return;
    }

    const newHash = this.getOrComputeHash(absPath, rel);
    const existingIndex = this.cachedPending.findIndex(p => p.relativePath === rel);

    if (!newHash) {
      if (manifest[rel] && existingIndex === -1) {
        this.cachedPending.push({
          relativePath: rel,
          status: 'deleted',
          localUri: vscode.Uri.file(absPath),
          remotePath: this.configManager.getRemotePath(rel),
          source: 'local'
        });
        this._onDidChangePending.fire(this.cachedPending);
      }
      return;
    }

    const isDifferent = manifest[rel] !== newHash;
    const isNew = !manifest[rel];

    if (isDifferent || isNew) {
      const stat = fs.statSync(absPath);
      const item: PendingChangeItem = {
        relativePath: rel,
        status: isNew ? 'added' : 'modified',
        localUri: vscode.Uri.file(absPath),
        remotePath: this.configManager.getRemotePath(rel),
        hash: newHash,
        size: stat.size,
        mtime: stat.mtimeMs,
        source: 'local'
      };

      if (existingIndex >= 0) {
        this.cachedPending[existingIndex] = item;
      } else {
        this.cachedPending.push(item);
      }
      this._onDidChangePending.fire(this.cachedPending);
    } else if (existingIndex >= 0) {
      this.cachedPending.splice(existingIndex, 1);
      this._onDidChangePending.fire(this.cachedPending);
    }
  }

  public async initBaseline(): Promise<{ count: number }> {
    const root = this.configManager.getWorkspaceRoot();
    if (!root) throw new Error('No workspace open');

    const config = this.configManager.getActiveConfig();
    const ignoreList = config ? config.ignore : [];

    const files = this.walkDirectory(root, ignoreList);
    const hashes: Record<string, string> = {};

    for (const rel of files) {
      const abs = path.join(root, rel);
      const h = this.getOrComputeHash(abs, rel);
      if (h) hashes[rel] = h;
    }

    this.saveManifest(hashes);
    await this.refreshPending();
    return { count: Object.keys(hashes).length };
  }

  public markAsSynced(relPaths: string[]): void {
    const root = this.configManager.getWorkspaceRoot();
    if (!root) return;

    let manifest = this.loadManifest();
    if (!manifest) manifest = {};

    for (const rel of relPaths) {
      const abs = path.join(root, rel);
      if (fs.existsSync(abs)) {
        const h = this.getOrComputeHash(abs, rel);
        if (h) manifest[rel] = h;
      } else {
        delete manifest[rel];
        this.fileCache.delete(rel);
      }
    }

    this.saveManifest(manifest);
    this.cachedPending = this.cachedPending.filter(p => !relPaths.includes(p.relativePath));
    this._onDidChangePending.fire(this.cachedPending);
  }

  public async getPendingChanges(force = false): Promise<PendingChangeItem[]> {
    if (!force && this.cachedPending.length > 0 && !this.isScanning) {
      return this.cachedPending;
    }
    return await this.refreshPending();
  }

  public async refreshPending(): Promise<PendingChangeItem[]> {
    const root = this.configManager.getWorkspaceRoot();
    if (!root) {
      this.cachedPending = [];
      this._onDidChangePending.fire([]);
      return [];
    }

    const config = this.configManager.getActiveConfig();
    if (!config) {
      this.cachedPending = [];
      this._onDidChangePending.fire([]);
      return [];
    }

    this.isScanning = true;
    try {
      let manifest = this.loadManifest();
      const files = this.walkDirectory(root, config.ignore);
      const pending: PendingChangeItem[] = [];

      if (!manifest || Object.keys(manifest).length === 0) {
        // Auto-initialize baseline manifest on first scan so the workspace starts clean (0 pending changes).
        const hashes: Record<string, string> = {};
        for (const rel of files) {
          const abs = path.join(root, rel);
          const h = this.getOrComputeHash(abs, rel);
          if (h) hashes[rel] = h;
        }
        this.saveManifest(hashes);
        manifest = hashes;
      }

      const fileSet = new Set(files);

        for (const rel of files) {
          const abs = path.join(root, rel);
          const h = this.getOrComputeHash(abs, rel);
          const stat = fs.statSync(abs);

          if (!manifest[rel]) {
            pending.push({
              relativePath: rel,
              status: 'added',
              localUri: vscode.Uri.file(abs),
              remotePath: this.configManager.getRemotePath(rel),
              hash: h || undefined,
              size: stat.size,
              mtime: stat.mtimeMs,
              source: 'local'
            });
          } else if (manifest[rel] !== h) {
            pending.push({
              relativePath: rel,
              status: 'modified',
              localUri: vscode.Uri.file(abs),
              remotePath: this.configManager.getRemotePath(rel),
              hash: h || undefined,
              size: stat.size,
              mtime: stat.mtimeMs,
              source: 'local'
            });
          }
        }

        for (const rel of Object.keys(manifest)) {
          if (!this.configManager.shouldIgnore(rel, config.ignore) && !fileSet.has(rel)) {
            pending.push({
              relativePath: rel,
              status: 'deleted',
              localUri: vscode.Uri.file(path.join(root, rel)),
              remotePath: this.configManager.getRemotePath(rel),
              source: 'local'
            });
          }
        }

      // Filter out any ignored files immediately
      this.cachedPending = pending.filter(p => !this.configManager.shouldIgnore(p.relativePath));
      this._onDidChangePending.fire(this.cachedPending);
      return this.cachedPending;
    } finally {
      this.isScanning = false;
    }
  }

  private walkDirectory(dir: string, ignoreList?: string[]): string[] {
    const root = this.configManager.getWorkspaceRoot();
    if (!root) return [];

    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(root, absPath).split(path.sep).join('/');

        if (this.configManager.shouldIgnore(relPath, ignoreList)) {
          continue;
        }

        if (entry.isDirectory()) {
          results.push(...this.walkDirectory(absPath, ignoreList));
        } else if (entry.isFile()) {
          results.push(relPath);
        }
      }
    } catch (e) {
      console.error(`Failed to read dir ${dir}:`, e);
    }
    return results;
  }

  private scheduleRefresh() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.refreshPending();
    }, 400);
  }

  private initFileWatchers() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(e => this.notifyFileSaved(e.fsPath));
    watcher.onDidDelete(e => this.notifyFileSaved(e.fsPath));
  }

  public dispose() {
    this._onDidChangePending.dispose();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
