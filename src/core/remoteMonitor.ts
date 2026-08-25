import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config/configManager';
import { SftpManager } from '../client/sftpClient';
import { PendingChangeItem } from '../config/types';

export class RemoteMonitor {
  private _onDidChangeRemotePending = new vscode.EventEmitter<PendingChangeItem[]>();
  public readonly onDidChangeRemotePending = this._onDidChangeRemotePending.event;

  private timer: NodeJS.Timeout | null = null;
  private remotePending: PendingChangeItem[] = [];
  private isChecking = false;

  constructor(
    private configManager: ConfigManager,
    private sftpManager: SftpManager
  ) {
    this.configManager.onDidChangeConfig(() => this.restartTimer());
    this.restartTimer();
  }

  public getRemotePending(): PendingChangeItem[] {
    return this.remotePending;
  }

  public restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const config = this.configManager.getActiveConfig();
    if (!config) return;

    const intervalSec = config.remotePollingInterval !== undefined ? config.remotePollingInterval : 60;
    if (intervalSec > 0) {
      this.timer = setInterval(() => {
        this.checkRemoteChanges(false);
      }, intervalSec * 1000);
    }
  }

  public async checkRemoteChanges(showToast = false): Promise<PendingChangeItem[]> {
    const config = this.configManager.getActiveConfig();
    const root = this.configManager.getWorkspaceRoot();
    if (!config || !root || this.isChecking) return [];

    this.isChecking = true;
    try {
      const changes = await this.scanRemote(root, config.remotePath, config);
      this.remotePending = changes;
      this._onDidChangeRemotePending.fire(changes);

      if (showToast) {
        if (changes.length === 0) {
          vscode.window.showInformationMessage(`[Deployment] Server ${config.name} is completely up to date with local workspace.`);
        } else {
          vscode.window.showInformationMessage(
            `[Deployment] Detected ${changes.length} incoming change(s) on ${config.name}.`,
            'Review Changes'
          ).then(action => {
            if (action === 'Review Changes') {
              vscode.commands.executeCommand('deployment.syncWithRemote');
            }
          });
        }
      }
      return changes;
    } catch (err: any) {
      console.warn('Remote check skipped:', err.message);
      return [];
    } finally {
      this.isChecking = false;
    }
  }

  private async scanRemote(root: string, remoteDir: string, config: any): Promise<PendingChangeItem[]> {
    const results: PendingChangeItem[] = [];
    try {
      const list = await this.sftpManager.list(config, remoteDir);
      for (const item of list) {
        if (item.name === '.' || item.name === '..') continue;

        const remoteItemPath = path.posix.join(remoteDir, item.name);
        const relPath = path.posix.relative(config.remotePath, remoteItemPath);
        
        if (this.configManager.shouldIgnore(relPath, config.ignore)) {
          continue;
        }

        const localAbs = path.join(root, relPath.split('/').join(path.sep));

        if (item.type === 'd') {
          const sub = await this.scanRemote(root, remoteItemPath, config);
          results.push(...sub);
        } else {
          const remoteMtimeMs = (item.modifyTime || 0) * 1000;
          if (!fs.existsSync(localAbs)) {
            results.push({
              relativePath: relPath,
              status: 'remote_added',
              localUri: vscode.Uri.file(localAbs),
              remotePath: remoteItemPath,
              remoteMtime: remoteMtimeMs,
              remoteSize: item.size,
              source: 'remote'
            });
          } else {
            const localStat = fs.statSync(localAbs);
            if (remoteMtimeMs - localStat.mtimeMs > 3000) {
              results.push({
                relativePath: relPath,
                status: 'remote_newer',
                localUri: vscode.Uri.file(localAbs),
                remotePath: remoteItemPath,
                mtime: localStat.mtimeMs,
                size: localStat.size,
                remoteMtime: remoteMtimeMs,
                remoteSize: item.size,
                source: 'remote'
              });
            }
          }
        }
      }
    } catch {}
    return results;
  }

  public dispose() {
    if (this.timer) clearInterval(this.timer);
    this._onDidChangeRemotePending.dispose();
  }
}
