import * as vscode from 'vscode';
import * as path from 'path';
import { SftpManager } from '../client/sftpClient';
import { ConfigManager } from '../config/configManager';

export class RemoteFsProvider implements vscode.FileSystemProvider {
  public static readonly SCHEME = 'deployment-remote';

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  constructor(
    private sftpManager: SftpManager,
    private configManager: ConfigManager
  ) {}

  public static getRemoteUri(serverName: string, remotePath: string): vscode.Uri {
    const cleanPath = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
    return vscode.Uri.from({
      scheme: RemoteFsProvider.SCHEME,
      authority: serverName,
      path: cleanPath
    });
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const config = this.getServerConfig(uri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      const remotePath = uri.path;
      const stat = await this.sftpManager.stat(config, remotePath);
      return {
        type: stat.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: (stat.accessTime || Date.now() / 1000) * 1000,
        mtime: (stat.modifyTime || Date.now() / 1000) * 1000,
        size: stat.size || 0
      };
    } catch (e: any) {
      if (e.code === 2 || e.message?.includes('No such file')) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP stat failed');
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const config = this.getServerConfig(uri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      const list = await this.sftpManager.list(config, uri.path);
      return list
        .filter((item: any) => item.name !== '.' && item.name !== '..')
        .map((item: any) => [
          item.name,
          item.type === 'd' ? vscode.FileType.Directory : vscode.FileType.File
        ]);
    } catch (e: any) {
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP readDirectory failed');
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const config = this.getServerConfig(uri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      await this.sftpManager.mkdir(config, uri.path, true);
      this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    } catch (e: any) {
      if (e.message?.includes('Permission denied')) {
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP mkdir failed');
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const config = this.getServerConfig(uri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      const buf = await this.sftpManager.readFile(config, uri.path);
      return new Uint8Array(buf);
    } catch (e: any) {
      if (e.code === 2 || e.message?.includes('No such file')) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP readFile failed');
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
    const config = this.getServerConfig(uri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      await this.sftpManager.writeFile(config, uri.path, Buffer.from(content));
      this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      vscode.window.showInformationMessage(`Remote file saved on ${config.name}: ${path.posix.basename(uri.path)}`);
    } catch (e: any) {
      if (e.message?.includes('Permission denied')) {
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP writeFile failed');
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const config = this.getServerConfig(uri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      await this.sftpManager.delete(config, uri.path, options.recursive);
      this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (e: any) {
      if (e.message?.includes('Permission denied')) {
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP delete failed');
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, _options: { overwrite: boolean }): Promise<void> {
    const config = this.getServerConfig(oldUri);
    if (!config) throw vscode.FileSystemError.Unavailable('No server configuration active');

    try {
      await this.sftpManager.rename(config, oldUri.path, newUri.path);
      this._emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
    } catch (e: any) {
      if (e.message?.includes('Permission denied')) {
        throw vscode.FileSystemError.NoPermissions(oldUri);
      }
      throw vscode.FileSystemError.Unavailable(e.message || 'SFTP rename failed');
    }
  }

  private getServerConfig(uri: vscode.Uri) {
    const serverName = uri.authority;
    if (serverName) {
      const found = this.configManager.getAllConfigs().find(c => c.name === serverName);
      if (found) return found;
    }
    return this.configManager.getActiveConfig();
  }
}
