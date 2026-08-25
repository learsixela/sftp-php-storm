import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../config/configManager';
import { ChangeTracker } from '../core/changeTracker';
import { RemoteMonitor } from '../core/remoteMonitor';
import { SftpManager } from '../client/sftpClient';
import { ServerConfig, PendingChangeItem } from '../config/types';
import { RemoteFsProvider } from './remoteFsProvider';

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private configManager: ConfigManager) {
    this.configManager.onDidChangeConfig(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ServerTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<ServerTreeItem[]> {
    const configs = this.configManager.getAllConfigs();
    const active = this.configManager.getActiveConfig();

    if (configs.length === 0) {
      const empty = new ServerTreeItem('No servers configured in .vscode/sftp.json', vscode.TreeItemCollapsibleState.None);
      empty.iconPath = new vscode.ThemeIcon('info');
      empty.command = { command: 'deployment.editConfig', title: 'Open Config' };
      return Promise.resolve([empty]);
    }

    return Promise.resolve(
      configs.map(c => {
        const isActive = active && active.name === c.name;
        const item = new ServerTreeItem(
          `${c.name} ${isActive ? '(Active)' : ''}`,
          vscode.TreeItemCollapsibleState.None,
          c
        );
        item.description = `${c.username}@${c.host}:${c.port || 22}`;
        item.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'server');
        item.contextValue = 'serverItem';
        return item;
      })
    );
  }
}

export class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly config?: ServerConfig
  ) {
    super(label, collapsibleState);
  }
}

export class PendingChangesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private changeTracker: ChangeTracker,
    private remoteMonitor: RemoteMonitor
  ) {
    this.changeTracker.onDidChangePending(() => this.refresh());
    this.remoteMonitor.onDidChangeRemotePending(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const localChanges = await this.changeTracker.getPendingChanges();
      const remoteChanges = this.remoteMonitor.getRemotePending();

      const items: vscode.TreeItem[] = [];

      const localHeader = new vscode.TreeItem(`Local Pending Changes (${localChanges.length})`, vscode.TreeItemCollapsibleState.Expanded);
      localHeader.iconPath = new vscode.ThemeIcon('cloud-upload');
      (localHeader as any).category = 'local';
      items.push(localHeader);

      if (remoteChanges.length > 0) {
        const remoteHeader = new vscode.TreeItem(`Incoming Server Changes (${remoteChanges.length})`, vscode.TreeItemCollapsibleState.Expanded);
        remoteHeader.iconPath = new vscode.ThemeIcon('cloud-download');
        (remoteHeader as any).category = 'remote';
        items.push(remoteHeader);
      }

      return items;
    }

    if ((element as any).category === 'local') {
      const localChanges = await this.changeTracker.getPendingChanges();
      if (localChanges.length === 0) {
        const empty = new vscode.TreeItem('No local changes', vscode.TreeItemCollapsibleState.None);
        empty.iconPath = new vscode.ThemeIcon('check');
        return [empty];
      }

      return localChanges.map(item => {
        const treeItem = new PendingTreeItem(
          path.basename(item.relativePath),
          vscode.TreeItemCollapsibleState.None,
          item
        );
        treeItem.description = path.dirname(item.relativePath) === '.' ? '' : path.dirname(item.relativePath);
        treeItem.tooltip = `${item.relativePath} (${item.status})`;

        if (item.status === 'modified') {
          treeItem.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        } else if (item.status === 'added') {
          treeItem.iconPath = new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
        } else {
          treeItem.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
        }

        treeItem.resourceUri = item.localUri;
        treeItem.command = {
          command: 'deployment.compareWithRemote',
          title: 'Compare with Remote',
          arguments: [item.localUri]
        };
        treeItem.contextValue = 'pendingItem';
        return treeItem;
      });
    }

    if ((element as any).category === 'remote') {
      const remoteChanges = this.remoteMonitor.getRemotePending();
      return remoteChanges.map(item => {
        const treeItem = new PendingTreeItem(
          path.basename(item.relativePath),
          vscode.TreeItemCollapsibleState.None,
          item
        );
        treeItem.description = `Server: ${path.dirname(item.relativePath) === '.' ? '' : path.dirname(item.relativePath)}`;
        treeItem.tooltip = `Updated on server: ${item.relativePath}`;
        treeItem.iconPath = new vscode.ThemeIcon('arrow-down', new vscode.ThemeColor('charts.blue'));
        treeItem.resourceUri = item.localUri;
        treeItem.command = {
          command: 'deployment.compareWithRemote',
          title: 'Compare with Remote',
          arguments: [item.localUri]
        };
        treeItem.contextValue = 'remotePendingItem';
        return treeItem;
      });
    }

    return [];
  }
}

export class PendingTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly changeItem?: PendingChangeItem
  ) {
    super(label, collapsibleState);
  }
}

export class RemoteExplorerTreeProvider implements vscode.TreeDataProvider<RemoteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RemoteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private configManager: ConfigManager,
    private sftpManager: SftpManager
  ) {
    this.configManager.onDidChangeConfig(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RemoteTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteTreeItem): Promise<RemoteTreeItem[]> {
    const config = this.configManager.getActiveConfig();
    if (!config) {
      const empty = new RemoteTreeItem('No active server', vscode.TreeItemCollapsibleState.None);
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }

    const remotePath = element ? element.remotePath : config.remotePath;

    try {
      const entries = await this.sftpManager.list(config, remotePath);
      const sorted = entries
        .filter((e: any) => e.name !== '.' && e.name !== '..')
        .sort((a: any, b: any) => {
          if (a.type === 'd' && b.type !== 'd') return -1;
          if (a.type !== 'd' && b.type === 'd') return 1;
          return a.name.localeCompare(b.name);
        });

      return sorted.map((e: any) => {
        const itemPath = path.posix.join(remotePath, e.name);
        const isDir = e.type === 'd';
        const item = new RemoteTreeItem(
          e.name,
          isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          itemPath,
          isDir
        );

        item.iconPath = isDir ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
        if (!isDir) {
          item.command = {
            command: 'vscode.open',
            title: 'Open Remote File',
            arguments: [RemoteFsProvider.getRemoteUri(config.name, itemPath)]
          };
        }
        item.contextValue = isDir ? 'remoteDir' : 'remoteFile';
        return item;
      });
    } catch (err: any) {
      const errorItem = new RemoteTreeItem(`Error: ${err.message || err}`, vscode.TreeItemCollapsibleState.None);
      errorItem.iconPath = new vscode.ThemeIcon('error');
      return [errorItem];
    }
  }
}

export class RemoteTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly remotePath: string = '/',
    public readonly isDirectory: boolean = false
  ) {
    super(label, collapsibleState);
  }
}
