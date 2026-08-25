import * as vscode from 'vscode';

export interface ServerConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  protocol?: 'sftp' | 'ftp';
  remotePath: string;
  uploadOnSave?: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  useGitIgnore?: boolean;
  ignore?: string[];
  webServerUrl?: string;
  algorithms?: any;
  connectTimeout?: number;
  remotePollingInterval?: number; // seconds
}

export interface PendingChangeItem {
  relativePath: string;
  status: 'modified' | 'added' | 'deleted' | 'remote_newer' | 'remote_added';
  localUri: vscode.Uri;
  remotePath: string;
  hash?: string;
  size?: number;
  mtime?: number;
  remoteMtime?: number;
  remoteSize?: number;
  source: 'local' | 'remote';
}

export interface SyncComparisonItem {
  relativePath: string;
  localPath: string;
  remotePath: string;
  status: 'local_newer' | 'remote_newer' | 'local_only' | 'remote_only' | 'same' | 'different';
  localSize?: number;
  remoteSize?: number;
  localMtime?: number;
  remoteMtime?: number;
}
