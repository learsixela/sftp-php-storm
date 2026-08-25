const SftpClient = require('ssh2-sftp-client');
import * as fs from 'fs';
import * as path from 'path';
import { ServerConfig } from '../config/types';
import { SecretsManager } from '../config/secretsManager';

export class SftpManager {
  private client: any = null;
  private currentConfig: ServerConfig | null = null;
  private isConnecting = false;

  constructor(private secretsManager: SecretsManager) {}

  public isConnected(): boolean {
    return this.client !== null;
  }

  public async getClient(config: ServerConfig): Promise<any> {
    if (this.client && this.currentConfig && this.isSameConfig(this.currentConfig, config)) {
      try {
        await this.client.realPath('.');
        return this.client;
      } catch {
        await this.disconnect();
      }
    }

    if (this.isConnecting) {
      await new Promise(r => setTimeout(r, 500));
      if (this.client) return this.client;
    }

    this.isConnecting = true;
    try {
      this.client = new SftpClient();
      this.currentConfig = config;

      let password = config.password;
      if (!password && !config.privateKeyPath && !config.agent) {
        password = await this.secretsManager.getPassword(config.name);
        if (!password) {
          password = await this.secretsManager.promptForPassword(config.name, config.username, config.host);
        }
      }

      let passphrase = config.passphrase;
      if (config.privateKeyPath && !passphrase) {
        passphrase = await this.secretsManager.getPassphrase(config.name);
      }

      const connectOptions: any = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: config.connectTimeout || 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3
      };

      if (password) {
        connectOptions.password = password;
      }

      if (config.privateKeyPath) {
        let keyPath = config.privateKeyPath;
        if (keyPath.startsWith('~')) {
          const home = process.env.HOME || process.env.USERPROFILE || '';
          keyPath = path.join(home, keyPath.slice(1));
        }
        if (fs.existsSync(keyPath)) {
          connectOptions.privateKey = fs.readFileSync(keyPath);
        }
        if (passphrase) {
          connectOptions.passphrase = passphrase;
        }
      }

      // Windows OpenSSH agent support
      if (config.agent || process.env.SSH_AUTH_SOCK) {
        connectOptions.agent = config.agent || process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
      }

      if (config.algorithms) {
        connectOptions.algorithms = config.algorithms;
      }

      await this.client.connect(connectOptions);
      this.isConnecting = false;
      return this.client;
    } catch (err) {
      this.isConnecting = false;
      this.client = null;
      this.currentConfig = null;
      throw err;
    }
  }

  public async testConnection(config: ServerConfig): Promise<{ ok: boolean; message: string; latencyMs: number; rootPath?: string }> {
    const startTime = Date.now();
    try {
      const client = await this.getClient(config);
      const latencyMs = Date.now() - startTime;
      const realRoot = await client.realPath(config.remotePath || '/');

      return {
        ok: true,
        message: `Connected successfully to ${config.name || config.host} in ${latencyMs}ms!`,
        latencyMs,
        rootPath: realRoot
      };
    } catch (error: any) {
      return {
        ok: false,
        message: `Connection failed: ${error.message || error}`,
        latencyMs: Date.now() - startTime
      };
    }
  }

  public async uploadFile(config: ServerConfig, localPath: string, remotePath: string): Promise<void> {
    const client = await this.getClient(config);
    const remoteDir = path.posix.dirname(remotePath);
    
    const exists = await client.exists(remoteDir);
    if (!exists) {
      await client.mkdir(remoteDir, true);
    }

    await client.fastPut(localPath, remotePath);
  }

  public async downloadFile(config: ServerConfig, remotePath: string, localPath: string): Promise<void> {
    const client = await this.getClient(config);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    await client.fastGet(remotePath, localPath);
  }

  public async readFile(config: ServerConfig, remotePath: string): Promise<Buffer> {
    const client = await this.getClient(config);
    const buf = await client.get(remotePath);
    if (Buffer.isBuffer(buf)) {
      return buf;
    } else if (typeof buf === 'string') {
      return Buffer.from(buf);
    } else {
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        (buf as any).on('data', (c: Buffer) => chunks.push(c));
        (buf as any).on('end', () => resolve(Buffer.concat(chunks)));
        (buf as any).on('error', reject);
      });
    }
  }

  public async writeFile(config: ServerConfig, remotePath: string, data: Buffer | string): Promise<void> {
    const client = await this.getClient(config);
    const remoteDir = path.posix.dirname(remotePath);
    const exists = await client.exists(remoteDir);
    if (!exists) {
      await client.mkdir(remoteDir, true);
    }
    await client.put(Buffer.isBuffer(data) ? data : Buffer.from(data), remotePath);
  }

  public async mkdir(config: ServerConfig, remotePath: string, recursive = true): Promise<void> {
    const client = await this.getClient(config);
    await client.mkdir(remotePath, recursive);
  }

  public async delete(config: ServerConfig, remotePath: string, recursive = false): Promise<void> {
    const client = await this.getClient(config);
    const type = await client.exists(remotePath);
    if (!type) return;

    if (type === 'd') {
      await client.rmdir(remotePath, recursive);
    } else {
      await client.delete(remotePath);
    }
  }

  public async rename(config: ServerConfig, oldRemotePath: string, newRemotePath: string): Promise<void> {
    const client = await this.getClient(config);
    const targetDir = path.posix.dirname(newRemotePath);
    const exists = await client.exists(targetDir);
    if (!exists) {
      await client.mkdir(targetDir, true);
    }
    await client.rename(oldRemotePath, newRemotePath);
  }

  public async stat(config: ServerConfig, remotePath: string): Promise<any> {
    const client = await this.getClient(config);
    return await client.stat(remotePath);
  }

  public async list(config: ServerConfig, remotePath: string): Promise<any[]> {
    const client = await this.getClient(config);
    return await client.list(remotePath);
  }

  public async exists(config: ServerConfig, remotePath: string): Promise<boolean | string> {
    const client = await this.getClient(config);
    return await client.exists(remotePath);
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.end();
      } catch {}
      this.client = null;
      this.currentConfig = null;
    }
  }

  private isSameConfig(a: ServerConfig, b: ServerConfig): boolean {
    return a.host === b.host && a.port === b.port && a.username === b.username && a.remotePath === b.remotePath;
  }
}
