import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager, resolveTargetUri } from '../config/configManager';
import { RemoteFsProvider } from '../providers/remoteFsProvider';
import { SftpManager } from '../client/sftpClient';

export class DiffManager {
  constructor(
    private configManager: ConfigManager,
    private sftpManager: SftpManager
  ) {}

  public async compareWithRemote(targetUri?: any): Promise<void> {
    const uri = resolveTargetUri(targetUri);
    if (!uri) {
      vscode.window.showWarningMessage('No active file to compare.');
      return;
    }

    const config = this.configManager.getActiveConfig();
    if (!config) {
      vscode.window.showErrorMessage('No active deployment server configured in .vscode/sftp.json.');
      return;
    }

    const relPath = this.configManager.getRelativePath(uri.fsPath);
    if (!relPath) {
      vscode.window.showWarningMessage('The file is outside the workspace.');
      return;
    }

    const remotePath = this.configManager.getRemotePath(relPath);
    const fileName = path.basename(uri.fsPath);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Fetching ${fileName} from ${config.name}...`,
      cancellable: false
    }, async () => {
      try {
        const exists = await this.sftpManager.exists(config, remotePath);
        if (!exists) {
          vscode.window.showWarningMessage(`Remote file does not exist on ${config.name}: ${remotePath}`);
          return;
        }

        const remoteUri = RemoteFsProvider.getRemoteUri(config.name, remotePath);
        const title = `${fileName} (${config.name} Deployed) ↔ ${fileName} (Local)`;

        await vscode.commands.executeCommand('vscode.diff', remoteUri, uri, title, {
          preview: true
        });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to compare with remote: ${error.message || error}`);
      }
    });
  }
}
