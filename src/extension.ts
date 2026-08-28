import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager, resolveTargetUri } from './config/configManager';
import { SecretsManager } from './config/secretsManager';
import { SftpManager } from './client/sftpClient';
import { ChangeTracker } from './core/changeTracker';
import { RemoteMonitor } from './core/remoteMonitor';
import { UploadManager } from './core/uploadManager';
import { DiffManager } from './core/diffManager';
import { SyncEngine } from './core/syncEngine';
import { RemoteFsProvider } from './providers/remoteFsProvider';
import { StatusBarManager } from './ui/statusBar';
import {
  ServerTreeProvider,
  PendingChangesTreeProvider,
  RemoteExplorerTreeProvider
} from './providers/treeViews';

export function activate(context: vscode.ExtensionContext) {
  console.log('[Deployment & Sync] Extension activating...');

  const secretsManager = new SecretsManager(context.secrets);
  const configManager = new ConfigManager(secretsManager);
  const sftpManager = new SftpManager(secretsManager);
  const changeTracker = new ChangeTracker(configManager);
  const remoteMonitor = new RemoteMonitor(configManager, sftpManager);
  const uploadManager = new UploadManager(configManager, sftpManager, changeTracker);
  const diffManager = new DiffManager(configManager, sftpManager);
  const syncEngine = new SyncEngine(configManager, sftpManager, changeTracker);
  const remoteFsProvider = new RemoteFsProvider(sftpManager, configManager);
  const statusBar = new StatusBarManager(configManager, changeTracker, remoteMonitor);

  // Register FileSystemProvider
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(RemoteFsProvider.SCHEME, remoteFsProvider, {
      isCaseSensitive: true
    })
  );

  // Tree Views
  const serverTreeProvider = new ServerTreeProvider(configManager);
  const pendingTreeProvider = new PendingChangesTreeProvider(changeTracker, remoteMonitor);
  const remoteTreeProvider = new RemoteExplorerTreeProvider(configManager, sftpManager);

  const serverTreeView = vscode.window.createTreeView('deployment-servers', {
    treeDataProvider: serverTreeProvider
  });
  const pendingTreeView = vscode.window.createTreeView('deployment-pending-changes', {
    treeDataProvider: pendingTreeProvider
  });
  const remoteTreeView = vscode.window.createTreeView('deployment-remote-explorer', {
    treeDataProvider: remoteTreeProvider
  });

  context.subscriptions.push(serverTreeView, pendingTreeView, remoteTreeView);

  const updateBadge = async () => {
    try {
      const local = await changeTracker.getPendingChanges();
      const remote = remoteMonitor.getRemotePending();
      const total = local.length + remote.length;
      if (total > 0) {
        pendingTreeView.badge = {
          value: total,
          tooltip: `${local.length} local change(s), ${remote.length} server change(s) pending`
        };
        pendingTreeView.description = `${total} pending`;
      } else {
        pendingTreeView.badge = undefined;
        pendingTreeView.description = undefined;
      }
    } catch {}
  };

  changeTracker.onDidChangePending(() => updateBadge());
  remoteMonitor.onDidChangeRemotePending(() => updateBadge());
  configManager.onDidChangeConfig(() => updateBadge());
  updateBadge();

  // Auto upload on save with incremental O(1) change notification
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (doc.uri.scheme !== 'file') return;

    changeTracker.notifyFileSaved(doc.uri.fsPath);

    const config = configManager.getActiveConfig();
    if (!config) return;

    const extUploadOnSave = vscode.workspace.getConfiguration('deployment').get<boolean>('uploadOnSave', true);
    const shouldUpload = config.uploadOnSave !== false && extUploadOnSave;

    if (shouldUpload) {
      const relPath = configManager.getRelativePath(doc.uri.fsPath);
      if (relPath && !configManager.shouldIgnore(relPath, config.ignore)) {
        await uploadManager.uploadSingleFile(doc.uri.fsPath, relPath, config, false);
      }
    }
  });

  // Commands Registration
  context.subscriptions.push(
    // 1. Upload
    vscode.commands.registerCommand('deployment.upload', async (uri?: any) => {
      await uploadManager.uploadTarget(uri, false);
    }),

    // 2. Upload to... (Select server)
    vscode.commands.registerCommand('deployment.uploadSelection', async (uri?: any) => {
      await uploadManager.uploadTarget(uri, true);
    }),

    // 3. Upload All Open Files
    vscode.commands.registerCommand('deployment.uploadOpenFiles', async () => {
      await uploadManager.uploadOpenFiles();
    }),

    // 4. Upload Changed / Modified Files (Push)
    vscode.commands.registerCommand('deployment.uploadChangedFiles', async () => {
      await uploadManager.uploadChangedFiles();
    }),

    // 5. Download
    vscode.commands.registerCommand('deployment.download', async (uri?: any) => {
      await uploadManager.downloadTarget(uri, false);
    }),

    // 6. Download from... (Select server)
    vscode.commands.registerCommand('deployment.downloadSelection', async (uri?: any) => {
      await uploadManager.downloadTarget(uri, true);
    }),

    // 7. Mirror Download (Delete local orphans)
    vscode.commands.registerCommand('deployment.mirrorDownload', async (uri?: any) => {
      await syncEngine.mirrorRemoteToLocal(uri, false);
    }),

    // 8. Mirror Download from... (Select server)
    vscode.commands.registerCommand('deployment.mirrorDownloadSelection', async (uri?: any) => {
      await syncEngine.mirrorRemoteToLocal(uri, true);
    }),

    // 9. Compare with Remote
    vscode.commands.registerCommand('deployment.compareWithRemote', async (uri?: any) => {
      await diffManager.compareWithRemote(uri);
    }),

    // 10. Sync with Deployed...
    vscode.commands.registerCommand('deployment.syncWithRemote', async (uri?: any) => {
      await syncEngine.syncWithRemote(uri);
    }),

    // 11. Edit Remote File
    vscode.commands.registerCommand('deployment.editRemoteFile', async (uri?: any) => {
      const config = configManager.getActiveConfig();
      if (!config) {
        vscode.window.showErrorMessage('No active deployment server configured.');
        return;
      }

      let remotePath: string | undefined;
      const targetUri = resolveTargetUri(uri);
      if (targetUri) {
        const rel = configManager.getRelativePath(targetUri);
        if (rel) remotePath = configManager.getRemotePath(rel);
      }

      if (!remotePath) {
        remotePath = await vscode.window.showInputBox({
          prompt: 'Enter remote file path to edit',
          value: config.remotePath
        });
      }

      if (remotePath) {
        const remoteUri = RemoteFsProvider.getRemoteUri(config.name, remotePath);
        const doc = await vscode.workspace.openTextDocument(remoteUri);
        await vscode.window.showTextDocument(doc);
      }
    }),

    // 10. Test Connection
    vscode.commands.registerCommand('deployment.testConnection', async () => {
      const config = configManager.getActiveConfig();
      if (!config) {
        vscode.window.showErrorMessage('No active deployment server configured in .vscode/sftp.json.');
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Testing SFTP connection to ${config.name} (${config.host}:${config.port || 22})...`,
        cancellable: false
      }, async () => {
        const res = await sftpManager.testConnection(config);
        if (res.ok) {
          vscode.window.showInformationMessage(
            `✅ ${res.message}\nRemote Root: ${res.rootPath || config.remotePath}`
          );
        } else {
          vscode.window.showErrorMessage(`❌ ${res.message}`);
        }
      });
    }),

    // 11. Check Remote Changes (Poll server now)
    vscode.commands.registerCommand('deployment.checkRemoteChanges', async () => {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Checking for server updates...',
        cancellable: false
      }, async () => {
        await remoteMonitor.checkRemoteChanges(true);
      });
    }),

    // 12. Initialize Baseline
    vscode.commands.registerCommand('deployment.initBaseline', async () => {
      try {
        const res = await changeTracker.initBaseline();
        vscode.window.showInformationMessage(`Baseline manifest initialized with ${res.count} files.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to initialize baseline: ${e.message || e}`);
      }
    }),

    // 13. Edit Config
    vscode.commands.registerCommand('deployment.editConfig', async () => {
      const root = configManager.getWorkspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage('Please open a workspace folder first.');
        return;
      }

      const sftpPath = path.join(root, '.vscode', 'sftp.json');
      if (!fs.existsSync(path.dirname(sftpPath))) {
        fs.mkdirSync(path.dirname(sftpPath), { recursive: true });
      }

      if (!fs.existsSync(sftpPath)) {
        const sampleConfig = {
          name: "MyServer",
          host: "example.com",
          port: 22,
          username: "user",
          password: "password",
          protocol: "sftp",
          remotePath: "/var/www/html",
          uploadOnSave: true,
          useGitIgnore: true,
          ignore: [".vscode", ".git", "node_modules"]
        };
        fs.writeFileSync(sftpPath, JSON.stringify(sampleConfig, null, 2), 'utf8');
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sftpPath));
      await vscode.window.showTextDocument(doc);
    }),

    // 14. Refresh Pending
    vscode.commands.registerCommand('deployment.refreshPending', async () => {
      await changeTracker.refreshPending();
      await remoteMonitor.checkRemoteChanges(false);
      remoteTreeProvider.refresh();
    })
  );

  // Disposables
  context.subscriptions.push(
    configManager,
    changeTracker,
    remoteMonitor,
    statusBar,
    { dispose: () => sftpManager.disconnect() }
  );

  console.log('[Deployment & Sync] Extension activated successfully!');
}

export function deactivate() {}
