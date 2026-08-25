import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config/configManager';
import { SftpManager } from '../client/sftpClient';
import { ServerConfig, SyncComparisonItem } from '../config/types';
import { ChangeTracker } from './changeTracker';

export interface MirrorFileItem {
  relativePath: string;
  localPath: string;
  remotePath: string;
  reason: string;
  type: 'download' | 'delete';
}

export class SyncEngine {
  constructor(
    private configManager: ConfigManager,
    private sftpManager: SftpManager,
    private changeTracker?: ChangeTracker
  ) {}

  /**
   * Interactive bidirectional sync with PhpStorm style selection dialog.
   */
  public async syncWithRemote(folderUri?: vscode.Uri): Promise<void> {
    const config = this.configManager.getActiveConfig();
    if (!config) {
      vscode.window.showErrorMessage('No active deployment server configured in .vscode/sftp.json.');
      return;
    }

    const root = this.configManager.getWorkspaceRoot();
    if (!root) return;

    const targetDir = folderUri ? folderUri.fsPath : root;
    const relDir = path.relative(root, targetDir).split(path.sep).join('/');
    const remoteBase = relDir ? this.configManager.getRemotePath(relDir) : config.remotePath;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Analyzing files between Local and ${config.name}...`,
      cancellable: true
    }, async (progress, token) => {
      try {
        const comparisons = await this.compareDirectory(targetDir, remoteBase, config, token, progress);
        if (comparisons.length === 0) {
          vscode.window.showInformationMessage('Everything is in sync between Local and Remote!');
          return;
        }

        const items = comparisons.map(item => {
          let icon = '↔️';
          let desc = 'Identical';
          if (item.status === 'local_newer') {
            icon = '⬆️';
            desc = 'Local newer (Upload recommended)';
          } else if (item.status === 'remote_newer') {
            icon = '⬇️';
            desc = 'Remote newer (Download recommended)';
          } else if (item.status === 'local_only') {
            icon = '➕';
            desc = 'Only on Local (Upload)';
          } else if (item.status === 'remote_only') {
            icon = '☁️';
            desc = 'Only on Remote (Download)';
          } else if (item.status === 'different') {
            icon = '⚡';
            desc = 'Different sizes';
          }

          return {
            label: `${icon} ${item.relativePath}`,
            description: desc,
            item,
            picked: item.status === 'local_newer' || item.status === 'local_only'
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select files to Synchronize or press Esc to cancel'
        });

        if (selected && selected.length > 0) {
          const toUpload = selected.filter(s => s.item.status === 'local_newer' || s.item.status === 'local_only');
          const toDownload = selected.filter(s => s.item.status === 'remote_newer' || s.item.status === 'remote_only');
          const syncedPaths: string[] = [];

          for (const s of toUpload) {
            await this.sftpManager.uploadFile(config, s.item.localPath, s.item.remotePath);
            syncedPaths.push(s.item.relativePath);
          }
          for (const s of toDownload) {
            await this.sftpManager.downloadFile(config, s.item.remotePath, s.item.localPath);
            syncedPaths.push(s.item.relativePath);
          }

          if (this.changeTracker) {
            this.changeTracker.markAsSynced(syncedPaths);
          }

          vscode.window.showInformationMessage(`Synchronized ${selected.length} file(s) with ${config.name}.`);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Sync analysis failed: ${e.message || e}`);
      }
    });
  }

  /**
   * Mirror Remote to Local:
   * Downloads files that are new/modified on the remote server, and safely removes
   * local orphaned files/folders that were deleted or moved on the server (sending them to Trash).
   */
  public async mirrorRemoteToLocal(folderUri?: vscode.Uri, promptServer = false): Promise<void> {
    let config = this.configManager.getActiveConfig();
    if (promptServer || !config) {
      const allConfigs = this.configManager.getAllConfigs();
      if (allConfigs.length === 0) {
        vscode.window.showErrorMessage('No deployment configurations found in .vscode/sftp.json.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        allConfigs.map(c => ({ label: c.name, config: c })),
        { placeHolder: 'Select server to mirror from' }
      );
      if (!picked) return;
      config = picked.config;
    }

    const root = this.configManager.getWorkspaceRoot();
    if (!root) return;

    const targetLocalDir = folderUri ? folderUri.fsPath : root;
    const relDir = path.relative(root, targetLocalDir).split(path.sep).join('/');
    const remoteBase = relDir ? this.configManager.getRemotePath(relDir) : config.remotePath;

    let scanResult: { toDownload: MirrorFileItem[]; toDeleteLocally: MirrorFileItem[] } = {
      toDownload: [],
      toDeleteLocally: []
    };

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Scanning for mirror differences with ${config.name}...`,
      cancellable: true
    }, async (progress, token) => {
      try {
        scanResult = await this.scanForMirror(targetLocalDir, remoteBase, config!, token, progress);
      } catch (err: any) {
        vscode.window.showErrorMessage(`[Deployment] Mirror scan failed: ${err.message || err}`);
      }
    });

    if (scanResult.toDownload.length === 0 && scanResult.toDeleteLocally.length === 0) {
      vscode.window.showInformationMessage(
        `[Deployment] '${relDir || '.'}' is already 100% identical to ${config.name}. No changes detected.`
      );
      return;
    }

    const summaryMsg =
      `Target: '${relDir || 'workspace root'}'\n` +
      `• ⬇️ ${scanResult.toDownload.length} file(s) to download (new/updated on server)\n` +
      `• 🗑️ ${scanResult.toDeleteLocally.length} local file(s) to move to Trash (removed/moved on server)\n\n` +
      `Protected files (.git, .vscode, .env, .gitignore) will never be touched.`;

    const choice = await vscode.window.showWarningMessage(
      `Mirror from ${config.name}: ${scanResult.toDownload.length} download(s), ${scanResult.toDeleteLocally.length} local deletion(s).`,
      { modal: true, detail: summaryMsg },
      'Proceed (Move Orphans to Trash)',
      'Review File List'
    );

    if (!choice) return;

    let selectedToDownload = scanResult.toDownload;
    let selectedToDelete = scanResult.toDeleteLocally;

    if (choice === 'Review File List') {
      const pickItems = [
        ...scanResult.toDownload.map(d => ({
          label: `⬇️ ${d.relativePath}`,
          description: d.reason,
          item: d,
          picked: true
        })),
        ...scanResult.toDeleteLocally.map(del => ({
          label: `🗑️ ${del.relativePath}`,
          description: del.reason,
          item: del,
          picked: true
        }))
      ];

      const picked = await vscode.window.showQuickPick(pickItems, {
        canPickMany: true,
        placeHolder: 'Select files to synchronize/delete (Esc to cancel)'
      });

      if (!picked || picked.length === 0) {
        vscode.window.showInformationMessage('Mirror operation cancelled.');
        return;
      }

      selectedToDownload = picked.filter(p => p.item.type === 'download').map(p => p.item);
      selectedToDelete = picked.filter(p => p.item.type === 'delete').map(p => p.item);
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Mirroring from ${config.name}...`,
      cancellable: true
    }, async (progress, token) => {
      let downloaded = 0;
      let deleted = 0;
      let failed = 0;
      const syncedPaths: string[] = [];
      const totalOps = selectedToDownload.length + selectedToDelete.length;

      // 1. Download new and updated files from remote
      for (let i = 0; i < selectedToDownload.length; i++) {
        if (token.isCancellationRequested) break;
        const item = selectedToDownload[i];
        progress.report({
          message: `⬇️ (${i + 1}/${selectedToDownload.length}) ${item.relativePath}`,
          increment: totalOps > 0 ? (1 / totalOps) * 100 : 0
        });

        try {
          await this.sftpManager.downloadFile(config!, item.remotePath, item.localPath);
          syncedPaths.push(item.relativePath);
          downloaded++;
        } catch (err: any) {
          console.error(`Download failed for ${item.relativePath}:`, err);
          failed++;
        }
      }

      // 2. Delete local orphaned files safely (to Trash)
      for (let i = 0; i < selectedToDelete.length; i++) {
        if (token.isCancellationRequested) break;
        const item = selectedToDelete[i];
        progress.report({
          message: `🗑️ (${i + 1}/${selectedToDelete.length}) ${item.relativePath}`,
          increment: totalOps > 0 ? (1 / totalOps) * 100 : 0
        });

        try {
          // Double safety check against blacklists/ignores
          if (!this.configManager.shouldIgnore(item.relativePath, config!.ignore)) {
            if (fs.existsSync(item.localPath)) {
              await vscode.workspace.fs.delete(vscode.Uri.file(item.localPath), {
                recursive: false,
                useTrash: true
              });
              syncedPaths.push(item.relativePath);
              deleted++;
            }
          }
        } catch (err: any) {
          console.error(`Delete failed for ${item.relativePath}:`, err);
          failed++;
        }
      }

      // 3. Clean up empty local directories
      this.cleanEmptyDirectories(targetLocalDir, root);

      // 4. Update change tracker & baseline
      if (this.changeTracker) {
        this.changeTracker.markAsSynced(syncedPaths);
      }

      vscode.window.showInformationMessage(
        `[Deployment] Mirror from ${config!.name} finished: ${downloaded} downloaded, ${deleted} moved to trash${failed > 0 ? `, ${failed} errors` : ''}.`
      );
    });
  }

  private async scanForMirror(
    localDir: string,
    remoteDir: string,
    config: ServerConfig,
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<{ toDownload: MirrorFileItem[]; toDeleteLocally: MirrorFileItem[] }> {
    const root = this.configManager.getWorkspaceRoot()!;
    const toDownload: MirrorFileItem[] = [];
    const toDeleteLocally: MirrorFileItem[] = [];

    const localEntries = fs.existsSync(localDir) ? fs.readdirSync(localDir, { withFileTypes: true }) : [];
    const localMap = new Map<string, fs.Dirent>();
    for (const e of localEntries) {
      const rel = path.relative(root, path.join(localDir, e.name)).split(path.sep).join('/');
      if (!this.configManager.shouldIgnore(rel, config.ignore)) {
        localMap.set(e.name, e);
      }
    }

    let remoteEntries: any[] = [];
    try {
      remoteEntries = await this.sftpManager.list(config, remoteDir);
    } catch {
      remoteEntries = [];
    }

    const remoteMap = new Map<string, any>();
    for (const r of remoteEntries) {
      if (r.name !== '.' && r.name !== '..') {
        const rel = path.relative(root, path.join(localDir, r.name)).split(path.sep).join('/');
        if (!this.configManager.shouldIgnore(rel, config.ignore)) {
          remoteMap.set(r.name, r);
        }
      }
    }

    const allNames = new Set([...localMap.keys(), ...remoteMap.keys()]);
    for (const name of allNames) {
      if (token.isCancellationRequested) break;
      const localE = localMap.get(name);
      const remoteE = remoteMap.get(name);
      const localPath = path.join(localDir, name);
      const remotePath = path.posix.join(remoteDir, name);
      const relPath = path.relative(root, localPath).split(path.sep).join('/');

      if (this.configManager.shouldIgnore(relPath, config.ignore)) continue;

      if (localE?.isDirectory() || remoteE?.type === 'd') {
        const sub = await this.scanForMirror(localPath, remotePath, config, token, progress);
        toDownload.push(...sub.toDownload);
        toDeleteLocally.push(...sub.toDeleteLocally);
        continue;
      }

      if (localE && !remoteE) {
        toDeleteLocally.push({
          relativePath: relPath,
          localPath,
          remotePath,
          reason: 'Removed / moved on server',
          type: 'delete'
        });
      } else if (!localE && remoteE) {
        toDownload.push({
          relativePath: relPath,
          localPath,
          remotePath,
          reason: 'New file on server',
          type: 'download'
        });
      } else if (localE && remoteE) {
        const stat = fs.statSync(localPath);
        const localMtime = stat.mtimeMs;
        const remoteMtime = (remoteE.modifyTime || 0) * 1000;
        const sizeDiff = Math.abs(stat.size - remoteE.size);
        const timeDiff = remoteMtime - localMtime;

        if (sizeDiff > 0 || timeDiff > 3000) {
          toDownload.push({
            relativePath: relPath,
            localPath,
            remotePath,
            reason: sizeDiff > 0 ? 'File size differs' : 'Newer on server',
            type: 'download'
          });
        }
      }
    }

    return { toDownload, toDeleteLocally };
  }

  private cleanEmptyDirectories(currentDir: string, rootDir: string): boolean {
    if (!fs.existsSync(currentDir)) return true;
    const stat = fs.statSync(currentDir);
    if (!stat.isDirectory()) return false;

    if (path.resolve(currentDir) === path.resolve(rootDir)) {
      try {
        const entries = fs.readdirSync(currentDir);
        for (const entry of entries) {
          const full = path.join(currentDir, entry);
          if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            this.cleanEmptyDirectories(full, rootDir);
          }
        }
      } catch {}
      return false;
    }

    const rel = path.relative(rootDir, currentDir).split(path.sep).join('/');
    if (this.configManager.isForbidden(rel)) {
      return false;
    }

    let isEmpty = true;
    try {
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        const full = path.join(currentDir, entry);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
          const childEmpty = this.cleanEmptyDirectories(full, rootDir);
          if (!childEmpty) {
            isEmpty = false;
          }
        } else {
          isEmpty = false;
        }
      }

      if (isEmpty) {
        fs.rmdirSync(currentDir);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async compareDirectory(
    localDir: string,
    remoteDir: string,
    config: any,
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<SyncComparisonItem[]> {
    const root = this.configManager.getWorkspaceRoot()!;
    const results: SyncComparisonItem[] = [];

    const localEntries = fs.existsSync(localDir) ? fs.readdirSync(localDir, { withFileTypes: true }) : [];
    const localMap = new Map<string, fs.Dirent>();
    for (const e of localEntries) {
      const rel = path.relative(root, path.join(localDir, e.name)).split(path.sep).join('/');
      if (!this.configManager.shouldIgnore(rel, config.ignore)) {
        localMap.set(e.name, e);
      }
    }

    let remoteEntries: any[] = [];
    try {
      remoteEntries = await this.sftpManager.list(config, remoteDir);
    } catch {
      remoteEntries = [];
    }
    const remoteMap = new Map<string, any>();
    for (const r of remoteEntries) {
      if (r.name !== '.' && r.name !== '..') {
        const rel = path.relative(root, path.join(localDir, r.name)).split(path.sep).join('/');
        if (!this.configManager.shouldIgnore(rel, config.ignore)) {
          remoteMap.set(r.name, r);
        }
      }
    }

    const allNames = new Set([...localMap.keys(), ...remoteMap.keys()]);
    for (const name of allNames) {
      if (token.isCancellationRequested) break;
      const localE = localMap.get(name);
      const remoteE = remoteMap.get(name);
      const localPath = path.join(localDir, name);
      const remotePath = path.posix.join(remoteDir, name);
      const relPath = path.relative(root, localPath).split(path.sep).join('/');

      if (localE?.isDirectory() || remoteE?.type === 'd') {
        const sub = await this.compareDirectory(localPath, remotePath, config, token, progress);
        results.push(...sub);
        continue;
      }

      if (localE && !remoteE) {
        const stat = fs.statSync(localPath);
        results.push({
          relativePath: relPath,
          localPath,
          remotePath,
          status: 'local_only',
          localSize: stat.size,
          localMtime: stat.mtimeMs
        });
      } else if (!localE && remoteE) {
        results.push({
          relativePath: relPath,
          localPath,
          remotePath,
          status: 'remote_only',
          remoteSize: remoteE.size,
          remoteMtime: remoteE.modifyTime
        });
      } else if (localE && remoteE) {
        const stat = fs.statSync(localPath);
        const localMtime = stat.mtimeMs;
        const remoteMtime = (remoteE.modifyTime || 0) * 1000;
        const sizeDiff = Math.abs(stat.size - remoteE.size);
        const timeDiff = localMtime - remoteMtime;

        let status: SyncComparisonItem['status'] = 'same';
        if (sizeDiff > 0) {
          status = timeDiff > 3000 ? 'local_newer' : timeDiff < -3000 ? 'remote_newer' : 'different';
        } else if (timeDiff > 3000) {
          status = 'local_newer';
        } else if (timeDiff < -3000) {
          status = 'remote_newer';
        }

        if (status !== 'same') {
          results.push({
            relativePath: relPath,
            localPath,
            remotePath,
            status,
            localSize: stat.size,
            remoteSize: remoteE.size,
            localMtime,
            remoteMtime
          });
        }
      }
    }

    return results;
  }
}

