import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { ChangeTracker } from '../core/changeTracker';
import { RemoteMonitor } from '../core/remoteMonitor';

export class StatusBarManager {
  private serverItem: vscode.StatusBarItem;
  private syncItem: vscode.StatusBarItem;
  private remoteItem: vscode.StatusBarItem;

  constructor(
    private configManager: ConfigManager,
    private changeTracker: ChangeTracker,
    private remoteMonitor: RemoteMonitor
  ) {
    this.serverItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.serverItem.command = 'deployment.uploadSelection';
    this.serverItem.tooltip = 'Click to select active deployment server or upload';

    this.syncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    this.syncItem.command = 'deployment.uploadChangedFiles';
    this.syncItem.tooltip = 'Click to upload modified files';

    this.remoteItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    this.remoteItem.command = 'deployment.syncWithRemote';
    this.remoteItem.tooltip = 'Click to review incoming remote changes from server';

    this.configManager.onDidChangeConfig(() => this.update());
    this.changeTracker.onDidChangePending(pending => this.updatePending(pending.length));
    this.remoteMonitor.onDidChangeRemotePending(pending => this.updateRemotePending(pending.length));

    this.update();
  }

  public update(): void {
    const config = this.configManager.getActiveConfig();
    if (!config) {
      this.serverItem.text = '$(circle-slash) Deployment: (Disconnected)';
      this.serverItem.tooltip = 'No active server. Click to configure .vscode/sftp.json';
      this.serverItem.command = 'deployment.editConfig';
      this.serverItem.show();
      this.syncItem.hide();
      this.remoteItem.hide();
      return;
    }

    this.serverItem.text = `$(cloud-upload) ${config.name}`;
    this.serverItem.tooltip = `Active server: ${config.name} (${config.username}@${config.host})`;
    this.serverItem.command = 'deployment.uploadSelection';
    this.serverItem.show();

    this.changeTracker.getPendingChanges().then(pending => {
      this.updatePending(pending.length);
    });
    this.updateRemotePending(this.remoteMonitor.getRemotePending().length);
  }

  public updatePending(count: number): void {
    if (count > 0) {
      this.syncItem.text = `$(sync) ${count} local modified`;
      this.syncItem.tooltip = `${count} file(s) modified locally. Click to upload.`;
      this.syncItem.show();
    } else {
      this.syncItem.text = '$(check) In sync';
      this.syncItem.tooltip = 'All local files match sync baseline.';
      this.syncItem.show();
    }
  }

  public updateRemotePending(count: number): void {
    if (count > 0) {
      this.remoteItem.text = `$(cloud-download) ${count} remote changes`;
      this.remoteItem.tooltip = `${count} file(s) updated on the server. Click to review.`;
      this.remoteItem.show();
    } else {
      this.remoteItem.hide();
    }
  }

  public dispose() {
    this.serverItem.dispose();
    this.syncItem.dispose();
    this.remoteItem.dispose();
  }
}
