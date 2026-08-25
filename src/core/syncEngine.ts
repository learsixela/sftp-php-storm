import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config/configManager';
import { SftpManager } from '../client/sftpClient';
import { SyncComparisonItem } from '../config/types';

export class SyncEngine {
  constructor(
    private configManager: ConfigManager,
    private sftpManager: SftpManager
  ) {}

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

          for (const s of toUpload) {
            await this.sftpManager.uploadFile(config, s.item.localPath, s.item.remotePath);
          }
          for (const s of toDownload) {
            await this.sftpManager.downloadFile(config, s.item.remotePath, s.item.localPath);
          }
          vscode.window.showInformationMessage(`Synchronized ${selected.length} file(s) with ${config.name}.`);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Sync analysis failed: ${e.message || e}`);
      }
    });
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
