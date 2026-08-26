import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { ServerConfig } from './types';
import { SecretsManager } from './secretsManager';

export class ConfigManager {
  private _onDidChangeConfig = new vscode.EventEmitter<ServerConfig | null>();
  public readonly onDidChangeConfig = this._onDidChangeConfig.event;

  private activeConfig: ServerConfig | null = null;
  private allConfigs: ServerConfig[] = [];
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private gitIgnoreRules: string[] = [];
  private sftpIgnoreRules: string[] = [];

  constructor(private secretsManager: SecretsManager) {
    this.reloadConfig();
    this.initWatcher();
  }

  public getActiveConfig(): ServerConfig | null {
    return this.activeConfig;
  }

  public getAllConfigs(): ServerConfig[] {
    return this.allConfigs;
  }

  public setActiveConfig(name: string): boolean {
    const found = this.allConfigs.find(c => c.name === name);
    if (found) {
      this.activeConfig = found;
      this._onDidChangeConfig.fire(this.activeConfig);
      return true;
    }
    return false;
  }

  public getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
  }

  public reloadConfig(): ServerConfig | null {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.activeConfig = null;
      this.allConfigs = [];
      this.gitIgnoreRules = [];
      this.sftpIgnoreRules = [];
      this._onDidChangeConfig.fire(null);
      return null;
    }

    this.loadIgnoreFiles(root);

    const sftpPath = path.join(root, '.vscode', 'sftp.json');
    const sftpLocalPath = path.join(root, '.vscode', 'sftp.local.json');
    const deploymentPath = path.join(root, '.vscode', 'deployment.json');

    let targetPath: string | null = null;
    if (fs.existsSync(sftpLocalPath)) {
      targetPath = sftpLocalPath;
    } else if (fs.existsSync(sftpPath)) {
      targetPath = sftpPath;
    } else if (fs.existsSync(deploymentPath)) {
      targetPath = deploymentPath;
    }

    if (!targetPath) {
      this.activeConfig = null;
      this.allConfigs = [];
      this._onDidChangeConfig.fire(null);
      return null;
    }

    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const errors: any[] = [];
      const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });

      if (errors.length > 0) {
        console.warn('JSONC parse warnings in config:', errors);
      }

      if (Array.isArray(parsed)) {
        this.allConfigs = parsed.map((item, idx) => this.normalizeConfig(item, item.name || `Server ${idx + 1}`, root));
      } else if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.profiles && Array.isArray(parsed.profiles)) {
          this.allConfigs = parsed.profiles.map((item: any, idx: number) => this.normalizeConfig(item, item.name || `Server ${idx + 1}`, root));
        } else {
          this.allConfigs = [this.normalizeConfig(parsed, parsed.name || 'Default', root)];
        }
      }

      if (this.allConfigs.length > 0) {
        if (!this.activeConfig || !this.allConfigs.find(c => c.name === this.activeConfig!.name)) {
          this.activeConfig = this.allConfigs[0];
        } else {
          this.activeConfig = this.allConfigs.find(c => c.name === this.activeConfig!.name) || this.allConfigs[0];
        }
      } else {
        this.activeConfig = null;
      }

      this._onDidChangeConfig.fire(this.activeConfig);
      return this.activeConfig;
    } catch (e) {
      console.error('Error parsing deployment config:', e);
      vscode.window.showErrorMessage(`Error loading .vscode/sftp.json: ${(e as Error).message}`);
      return null;
    }
  }

  private loadIgnoreFiles(root: string) {
    this.gitIgnoreRules = [];
    this.sftpIgnoreRules = [];

    const gitIgnorePath = path.join(root, '.gitignore');
    if (fs.existsSync(gitIgnorePath)) {
      try {
        const lines = fs.readFileSync(gitIgnorePath, 'utf8').split(/\r?\n/);
        this.gitIgnoreRules = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      } catch {}
    }

    const sftpIgnorePath = path.join(root, '.sftpignore');
    const deploymentIgnorePath = path.join(root, '.deploymentignore');
    const ignorePath = fs.existsSync(sftpIgnorePath) ? sftpIgnorePath : fs.existsSync(deploymentIgnorePath) ? deploymentIgnorePath : null;

    if (ignorePath) {
      try {
        const lines = fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/);
        this.sftpIgnoreRules = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      } catch {}
    }
  }

  private substituteEnvVars(val: string, root: string): string {
    if (!val || typeof val !== 'string') return val;
    let res = val.replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] || '');
    res = res.replace(/\$\{workspaceFolder\}/g, root);
    return res;
  }

  private normalizeConfig(raw: any, defaultName: string, root: string): ServerConfig {
    return {
      name: raw.name || defaultName,
      host: this.substituteEnvVars(raw.host || '', root),
      port: Number(raw.port) || 22,
      username: this.substituteEnvVars(raw.username || '', root),
      password: raw.password ? this.substituteEnvVars(raw.password, root) : undefined,
      privateKeyPath: raw.privateKeyPath ? this.substituteEnvVars(raw.privateKeyPath, root) : undefined,
      passphrase: raw.passphrase ? this.substituteEnvVars(raw.passphrase, root) : undefined,
      agent: raw.agent ? this.substituteEnvVars(raw.agent, root) : undefined,
      protocol: raw.protocol || 'sftp',
      remotePath: this.substituteEnvVars(raw.remotePath || '/', root),
      uploadOnSave: raw.uploadOnSave !== undefined ? Boolean(raw.uploadOnSave) : true,
      useTempFile: Boolean(raw.useTempFile),
      openSsh: Boolean(raw.openSsh),
      useGitIgnore: raw.useGitIgnore !== undefined ? Boolean(raw.useGitIgnore) : true,
      ignore: Array.isArray(raw.ignore) ? raw.ignore : [],
      webServerUrl: this.substituteEnvVars(raw.webServerUrl || '', root),
      algorithms: raw.algorithms,
      connectTimeout: raw.connectTimeout || 15000,
      remotePollingInterval: raw.remotePollingInterval !== undefined ? Number(raw.remotePollingInterval) : 0
    };
  }

  /**
   * Hardcoded, un-bypassable blacklist for critical security, configuration, and tools files.
   * Under NO circumstances will these files ever be uploaded to SFTP/FTP.
   */
  public isForbidden(relativePath: string): boolean {
    const posixPath = relativePath.split(path.sep).join('/').replace(/^\//, '');
    const basename = path.posix.basename(posixPath).toLowerCase();
    const segments = posixPath.toLowerCase().split('/');

    // 1. Never upload .vscode configuration or credentials
    if (segments.includes('.vscode') || posixPath.startsWith('.vscode/')) return true;
    if (segments.includes('.idea') || posixPath.startsWith('.idea/')) return true;
    if (segments.includes('.git') || posixPath.startsWith('.git/')) return true;
    if (segments.includes('node_modules')) return true;

    // 2. Base omission of tools folder (local helper scripts, sftp-sync CLI, etc.)
    if (segments.includes('tools') || posixPath === 'tools' || posixPath.startsWith('tools/')) return true;

    // 3. Sensitive configuration files
    if (basename === 'sftp.json' || basename === 'sftp.local.json' || basename === 'deployment.json') return true;
    if (basename === '.manifest.json' || basename === '.sftpignore' || basename === '.deploymentignore' || basename === '.gitignore') return true;

    // 4. Security keys and secrets
    if (basename.startsWith('.env')) return true;
    if (basename.endsWith('.pem') || basename.endsWith('.key') || basename.startsWith('id_rsa') || basename.startsWith('id_ed25519')) return true;

    return false;
  }

  public shouldIgnore(relativePath: string, customIgnore?: string[]): boolean {
    const posixPath = relativePath.split(path.sep).join('/').replace(/^\//, '');
    
    // Check hardcoded blacklist first (including tools, .vscode, .git, etc.)
    if (this.isForbidden(posixPath)) return true;

    const segments = posixPath.split('/');
    const basename = path.posix.basename(posixPath);

    // Check .sftpignore rules
    if (this.matchRules(posixPath, segments, basename, this.sftpIgnoreRules)) {
      return true;
    }

    // Check .gitignore rules (if enabled)
    const useGit = this.activeConfig ? this.activeConfig.useGitIgnore !== false : true;
    if (useGit && this.matchRules(posixPath, segments, basename, this.gitIgnoreRules)) {
      return true;
    }

    // Check config ignore list
    const ignoreList = customIgnore || (this.activeConfig ? this.activeConfig.ignore || [] : []);
    if (this.matchRules(posixPath, segments, basename, ignoreList)) {
      return true;
    }

    return false;
  }

  private matchRules(posixPath: string, segments: string[], basename: string, rules: string[]): boolean {
    for (const item of rules) {
      const norm = item.split(path.sep).join('/').replace(/^\//, '').replace(/\/$/, '');
      if (!norm) continue;

      if (posixPath === norm || posixPath.startsWith(norm + '/')) return true;
      if (segments.includes(norm)) return true;
      if (basename === norm) return true;

      if (norm.includes('*')) {
        const regexStr = '^' + norm.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
        const regex = new RegExp(regexStr);
        if (regex.test(posixPath) || regex.test(basename) || segments.some(s => regex.test(s))) {
          return true;
        }
      }
    }
    return false;
  }

  public getRemotePath(relativePath: string): string {
    if (!this.activeConfig) return '/' + relativePath.split(path.sep).join('/');
    const base = this.activeConfig.remotePath.replace(/\/$/, '');
    const posixRel = relativePath.split(path.sep).join('/').replace(/^\//, '');
    return `${base}/${posixRel}`;
  }

  public getRelativePath(absolutePath: string): string | null {
    const root = this.getWorkspaceRoot();
    if (!root) return null;
    const rel = path.relative(root, absolutePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  }

  private initWatcher() {
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/{.vscode/{sftp,sftp.local,deployment}.json,.gitignore,.sftpignore,.deploymentignore}');
    this.fileWatcher.onDidChange(() => this.reloadConfig());
    this.fileWatcher.onDidCreate(() => this.reloadConfig());
    this.fileWatcher.onDidDelete(() => this.reloadConfig());
  }

  public dispose() {
    if (this.fileWatcher) this.fileWatcher.dispose();
    this._onDidChangeConfig.dispose();
  }
}
