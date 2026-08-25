import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config/configManager';
import { SftpManager } from '../client/sftpClient';
import { ChangeTracker } from './changeTracker';

export class UploadManager {
  constructor(
    private configManager: ConfigManager,
    private sftpManager: SftpManager,
    private changeTracker: ChangeTracker
  ) {}

  public async uploadTarget(uri?: vscode.Uri, promptServer = false): Promise<void> {
    let targetUri = uri;
    if (!targetUri && vscode.window.activeTextEditor) {
      targetUri = vscode.window.activeTextEditor.document.uri;
    }

    if (!targetUri) {
      vscode.window.showWarningMessage('No file selected to upload.');
      return;
    }

    let config = this.configManager.getActiveConfig();
    if (promptServer || !config) {
      const allConfigs = this.configManager.getAllConfigs();
      if (allConfigs.length === 0) {
        vscode.window.showErrorMessage('No deployment configurations found in .vscode/sftp.json.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        allConfigs.map(c => ({ label: c.name, description: `${c.username}@${c.host}:${c.remotePath}`, config: c })),
        { placeHolder: 'Select server to upload to' }
      );
      if (!picked) return;
      config = picked.config;
    }

    const relPath = this.configManager.getRelativePath(targetUri.fsPath);
    if (!relPath) {
      vscode.window.showErrorMessage('File is outside workspace.');
      return;
    }

    if (this.configManager.isForbidden(relPath)) {
      vscode.window.showErrorMessage(`[Security] Upload blocked: ${relPath} is a protected configuration/secret file.`);
      return;
    }

    const stat = fs.statSync(targetUri.fsPath);
    if (stat.isDirectory()) {
      await this.uploadDirectory(targetUri.fsPath, config);
    } else {
      await this.uploadSingleFile(targetUri.fsPath, relPath, config);
    }
  }

  public async uploadSingleFile(absPath: string, relPath: string, config: any, silent = false): Promise<boolean> {
    if (this.configManager.isForbidden(relPath)) {
      vscode.window.showWarningMessage(`[Security] Skipped protected file: ${relPath}`);
      return false;
    }

    const remotePath = this.configManager.getRemotePath(relPath);
    try {
      await this.sftpManager.uploadFile(config, absPath, remotePath);
      this.changeTracker.markAsSynced([relPath]);

      const showNotif = vscode.workspace.getConfiguration('deployment').get<boolean>('showNotifications', true);
      if (!silent && showNotif) {
        vscode.window.showInformationMessage(`[Deployment] Uploaded: ${relPath} ➔ ${config.name}`);
      }
      return true;
    } catch (error: any) {
      vscode.window.showErrorMessage(`[Deployment] Upload failed for ${relPath}: ${error.message || error}`);
      return false;
    }
  }

  public async uploadDirectory(absDir: string, config: any): Promise<void> {
    const root = this.configManager.getWorkspaceRoot();
    if (!root) return;

    const allFiles: string[] = [];
    const collectFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (this.configManager.shouldIgnore(rel, config.ignore)) continue;
        if (entry.isDirectory()) {
          collectFiles(full);
        } else if (entry.isFile()) {
          allFiles.push(rel);
        }
      }
    };
    collectFiles(absDir);

    if (allFiles.length === 0) {
      vscode.window.showInformationMessage('No files to upload in this directory (all ignored or empty).');
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Uploading ${allFiles.length} files to ${config.name}...`,
      cancellable: true
    }, async (progress, token) => {
      let uploaded = 0;
      let failed = 0;
      const synced: string[] = [];

      for (let i = 0; i < allFiles.length; i++) {
        if (token.isCancellationRequested) break;
        const rel = allFiles[i];
        const abs = path.join(root, rel);
        progress.report({
          message: `(${i + 1}/${allFiles.length}) ${rel}`,
          increment: (1 / allFiles.length) * 100
        });

        try {
          const remotePath = this.configManager.getRemotePath(rel);
          await this.sftpManager.uploadFile(config, abs, remotePath);
          synced.push(rel);
          uploaded++;
        } catch {
          failed++;
        }
      }

      this.changeTracker.markAsSynced(synced);
      vscode.window.showInformationMessage(`[Deployment] Folder upload finished: ${uploaded} uploaded, ${failed} failed.`);
    });
  }

  public async uploadOpenFiles(): Promise<void> {
    const config = this.configManager.getActiveConfig();
    if (!config) {
      vscode.window.showErrorMessage('No active deployment server configured in .vscode/sftp.json.');
      return;
    }

    const root = this.configManager.getWorkspaceRoot();
    if (!root) return;

    const openUris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          openUris.push(tab.input.uri);
        }
      }
    }

    const openFiles: { abs: string; rel: string }[] = [];
    for (const uri of openUris) {
      if (uri.scheme === 'file') {
        const rel = this.configManager.getRelativePath(uri.fsPath);
        if (rel && !this.configManager.shouldIgnore(rel, config.ignore)) {
          openFiles.push({ abs: uri.fsPath, rel });
        }
      }
    }

    if (openFiles.length === 0) {
      vscode.window.showInformationMessage('No open workspace files to upload.');
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Uploading ${openFiles.length} open file(s) to ${config.name}...`,
      cancellable: false
    }, async (progress) => {
      let uploaded = 0;
      let failed = 0;
      const synced: string[] = [];

      for (let i = 0; i < openFiles.length; i++) {
        const item = openFiles[i];
        progress.report({
          message: `(${i + 1}/${openFiles.length}) ${item.rel}`,
          increment: (1 / openFiles.length) * 100
        });

        try {
          const remotePath = this.configManager.getRemotePath(item.rel);
          await this.sftpManager.uploadFile(config, item.abs, remotePath);
          synced.push(item.rel);
          uploaded++;
        } catch {
          failed++;
        }
      }

      this.changeTracker.markAsSynced(synced);
      vscode.window.showInformationMessage(`[Deployment] Uploaded ${uploaded} open file(s) to ${config.name}.`);
    });
  }

  public async uploadChangedFiles(): Promise<void> {
    const config = this.configManager.getActiveConfig();
    if (!config) {
      vscode.window.showErrorMessage('No active deployment server configured in .vscode/sftp.json.');
      return;
    }

    const root = this.configManager.getWorkspaceRoot();
    if (!root) return;

    const pending = await this.changeTracker.getPendingChanges(true);
    const validPending = pending.filter(p => !this.configManager.isForbidden(p.relativePath));

    if (validPending.length === 0) {
      vscode.window.showInformationMessage('No modified files pending sync.');
      return;
    }

    const confirm = vscode.workspace.getConfiguration('deployment').get<boolean>('confirmBeforeSync', true);
    if (confirm) {
      const ans = await vscode.window.showInformationMessage(
        `Upload ${validPending.length} modified file(s) to ${config.name}?`,
        { modal: true, detail: validPending.slice(0, 10).map(p => p.relativePath).join('\n') + (validPending.length > 10 ? `\n...and ${validPending.length - 10} more` : '') },
        'Upload All',
        'Cancel'
      );
      if (ans !== 'Upload All') return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Uploading ${validPending.length} modified file(s) to ${config.name}...`,
      cancellable: true
    }, async (progress, token) => {
      let uploaded = 0;
      let failed = 0;
      const synced: string[] = [];

      for (let i = 0; i < validPending.length; i++) {
        if (token.isCancellationRequested) break;
        const item = validPending[i];
        progress.report({
          message: `(${i + 1}/${validPending.length}) ${item.relativePath}`,
          increment: (1 / validPending.length) * 100
        });

        if (item.status === 'deleted') {
          synced.push(item.relativePath);
          continue;
        }

        try {
          const abs = path.join(root, item.relativePath);
          const remotePath = this.configManager.getRemotePath(item.relativePath);
          await this.sftpManager.uploadFile(config, abs, remotePath);
          synced.push(item.relativePath);
          uploaded++;
        } catch (err: any) {
          failed++;
        }
      }

      this.changeTracker.markAsSynced(synced);
      vscode.window.showInformationMessage(
        `[Deployment] Done: ${uploaded} uploaded, ${failed} failed.`
      );
    });
  }

  public async downloadTarget(uri?: vscode.Uri, promptServer = false): Promise<void> {
    let targetUri = uri;
    if (!targetUri && vscode.window.activeTextEditor) {
      targetUri = vscode.window.activeTextEditor.document.uri;
    }

    if (!targetUri) {
      vscode.window.showWarningMessage('No file selected to download.');
      return;
    }

    let config = this.configManager.getActiveConfig();
    if (promptServer || !config) {
      const allConfigs = this.configManager.getAllConfigs();
      if (allConfigs.length === 0) {
        vscode.window.showErrorMessage('No deployment configurations found.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        allConfigs.map(c => ({ label: c.name, config: c })),
        { placeHolder: 'Select server to download from' }
      );
      if (!picked) return;
      config = picked.config;
    }

    const relPath = this.configManager.getRelativePath(targetUri.fsPath);
    if (!relPath) return;

    const remotePath = this.configManager.getRemotePath(relPath);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${relPath} from ${config.name}...`,
      cancellable: false
    }, async () => {
      try {
        await this.sftpManager.downloadFile(config, remotePath, targetUri!.fsPath);
        this.changeTracker.markAsSynced([relPath]);
        vscode.window.showInformationMessage(`[Deployment] Downloaded: ${relPath} from ${config.name}`);
      } catch (error: any) {
        vscode.window.showErrorMessage(`[Deployment] Download failed for ${relPath}: ${error.message || error}`);
      }
    });
  }
}
