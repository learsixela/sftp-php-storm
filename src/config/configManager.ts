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

    // Traverse upwards from root to find .gitignore and .sftpignore files in parent folders
    const gitIgnoreFiles: string[] = [];
    const sftpIgnoreFiles: string[] = [];

    let currentDir = root;
    while (currentDir) {
      const gitIgnorePath = path.join(currentDir, '.gitignore');
      if (fs.existsSync(gitIgnorePath) && !gitIgnoreFiles.includes(gitIgnorePath)) {
        gitIgnoreFiles.unshift(gitIgnorePath);
      }

      const sftpIgnorePath = path.join(currentDir, '.sftpignore');
      const deploymentIgnorePath = path.join(currentDir, '.deploymentignore');
      const ignorePath = fs.existsSync(sftpIgnorePath) ? sftpIgnorePath : fs.existsSync(deploymentIgnorePath) ? deploymentIgnorePath : null;
      if (ignorePath && !sftpIgnoreFiles.includes(ignorePath)) {
        sftpIgnoreFiles.unshift(ignorePath);
      }

      const gitDir = path.join(currentDir, '.git');
      if (fs.existsSync(gitDir) && currentDir !== root) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    for (const gPath of gitIgnoreFiles) {
      try {
        const lines = fs.readFileSync(gPath, 'utf8').split(/\r?\n/);
        const rules = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        this.gitIgnoreRules.push(...rules);
      } catch {}
    }

    for (const sPath of sftpIgnoreFiles) {
      try {
        const lines = fs.readFileSync(sPath, 'utf8').split(/\r?\n/);
        const rules = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        this.sftpIgnoreRules.push(...rules);
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
      remotePollingInterval: raw.remotePollingInterval !== undefined ? Number(raw.remotePollingInterval) : 0,
      timeOffset: raw.timeOffset !== undefined ? Number(raw.timeOffset) : vscode.workspace.getConfiguration('deployment').get<number>('timeOffset', 0),
      timestampTolerance: raw.timestampTolerance !== undefined ? Number(raw.timestampTolerance) : vscode.workspace.getConfiguration('deployment').get<number>('timestampTolerance', 3)
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

    // 1. Never upload VCS, editor settings or heavy build/package folders
    if (segments.includes('.vscode') || posixPath.startsWith('.vscode/')) return true;
    if (segments.includes('.idea') || posixPath.startsWith('.idea/')) return true;
    if (segments.includes('.git') || posixPath.startsWith('.git/')) return true;
    if (segments.includes('node_modules') || posixPath.startsWith('node_modules/')) return true;
    if (segments.includes('.angular') || posixPath.startsWith('.angular/')) return true;
    if (segments.includes('.next') || posixPath.startsWith('.next/')) return true;

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

  public shouldIgnore(relativePath?: string | null, customIgnore?: string[]): boolean {
    if (!relativePath || typeof relativePath !== 'string') return false;
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
    for (let item of rules) {
      item = item.trim();
      if (!item || item.startsWith('#')) continue;

      let norm = item.split(path.sep).join('/').replace(/^\//, '').replace(/\/$/, '');
      if (!norm) continue;

      // Handle glob wildcard stripping for folder matches, e.g. "vendor/**", "vendor/*", "dist/**"
      const cleanPrefix = norm.replace(/(\/\*+)+$/, '');

      if (posixPath === norm || posixPath.startsWith(norm + '/')) return true;
      if (cleanPrefix && (posixPath === cleanPrefix || posixPath.startsWith(cleanPrefix + '/'))) return true;
      if (segments.includes(norm) || (cleanPrefix && segments.includes(cleanPrefix))) return true;
      if (basename === norm || basename === cleanPrefix) return true;

      // Handle **/ prefix, e.g. "**/vendor/**", "**/dist"
      if (norm.startsWith('**/')) {
        const afterGlob = norm.slice(3).replace(/(\/\*+)+$/, '');
        if (afterGlob) {
          if (segments.includes(afterGlob) || posixPath.includes('/' + afterGlob) || posixPath.startsWith(afterGlob)) {
            return true;
          }
        }
      }

      if (norm.includes('*')) {
        const regexStr = '^' + norm
          .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
          .replace(/\\\*\\\*/g, '.*')
          .replace(/(?<!\.)\\\*/g, '[^/]*') + '$';
        try {
          const regex = new RegExp(regexStr);
          if (regex.test(posixPath) || regex.test(basename) || segments.some(s => regex.test(s))) {
            return true;
          }
        } catch {}
      }
    }
    return false;
  }

  public getRemotePath(relativePath?: string | null): string {
    const base = this.activeConfig ? this.activeConfig.remotePath.replace(/\/$/, '') : '';
    if (!relativePath || typeof relativePath !== 'string') {
      return base || '/';
    }
    const posixRel = relativePath.split(path.sep).join('/').replace(/^\//, '');
    return `${base}/${posixRel}`;
  }

  public getRelativePath(absolutePathOrItem?: any): string | null {
    if (!absolutePathOrItem) return null;

    let absPath = '';
    if (typeof absolutePathOrItem === 'string') {
      absPath = absolutePathOrItem;
    } else if (absolutePathOrItem instanceof vscode.Uri || absolutePathOrItem.fsPath) {
      absPath = absolutePathOrItem.fsPath;
    } else if (absolutePathOrItem.resourceUri?.fsPath) {
      absPath = absolutePathOrItem.resourceUri.fsPath;
    } else if (absolutePathOrItem.changeItem?.localUri?.fsPath) {
      absPath = absolutePathOrItem.changeItem.localUri.fsPath;
    } else {
      return null;
    }

    if (!absPath || typeof absPath !== 'string') return null;

    const root = this.getWorkspaceRoot();
    if (!root) return null;

    try {
      const rel = path.relative(root, absPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join('/');
    } catch {
      return null;
    }
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

/**
 * Universal URI resolver that extracts a valid vscode.Uri from various inputs
 * passed by VS Code (TreeItems, command arguments, active editor, etc.)
 */
export function resolveTargetUri(arg?: any): vscode.Uri | undefined {
  if (!arg) {
    return vscode.window.activeTextEditor?.document.uri;
  }

  // 1. Direct vscode.Uri
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (arg && typeof arg === 'object' && typeof arg.fsPath === 'string' && arg.fsPath.length > 0) {
    return vscode.Uri.file(arg.fsPath);
  }

  // 2. TreeItem with resourceUri
  if (arg.resourceUri && (arg.resourceUri instanceof vscode.Uri || typeof arg.resourceUri.fsPath === 'string')) {
    return arg.resourceUri instanceof vscode.Uri ? arg.resourceUri : vscode.Uri.file(arg.resourceUri.fsPath);
  }

  // 3. TreeItem with changeItem.localUri
  if (arg.changeItem?.localUri) {
    const lUri = arg.changeItem.localUri;
    return lUri instanceof vscode.Uri ? lUri : vscode.Uri.file(lUri.fsPath || String(lUri));
  }

  // 4. String path
  if (typeof arg === 'string' && arg.trim().length > 0) {
    return vscode.Uri.file(arg);
  }

  return vscode.window.activeTextEditor?.document.uri;
}

