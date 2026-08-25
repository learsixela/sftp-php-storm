import * as vscode from 'vscode';

export class SecretsManager {
  constructor(private secrets: vscode.SecretStorage) {}

  public async getPassword(serverName: string): Promise<string | undefined> {
    return await this.secrets.get(`deployment.password.${serverName}`);
  }

  public async setPassword(serverName: string, password: string): Promise<void> {
    await this.secrets.store(`deployment.password.${serverName}`, password);
  }

  public async deletePassword(serverName: string): Promise<void> {
    await this.secrets.delete(`deployment.password.${serverName}`);
  }

  public async getPassphrase(serverName: string): Promise<string | undefined> {
    return await this.secrets.get(`deployment.passphrase.${serverName}`);
  }

  public async setPassphrase(serverName: string, passphrase: string): Promise<void> {
    await this.secrets.store(`deployment.passphrase.${serverName}`, passphrase);
  }

  public async promptForPassword(serverName: string, username: string, host: string): Promise<string | undefined> {
    const password = await vscode.window.showInputBox({
      title: `SFTP Password for ${serverName}`,
      prompt: `Enter password for ${username}@${host} (will be saved securely in Windows Credential Manager / VS Code SecretStorage)`,
      password: true,
      ignoreFocusOut: true
    });

    if (password !== undefined && password.length > 0) {
      await this.setPassword(serverName, password);
    }
    return password;
  }

  public async promptForPassphrase(serverName: string, keyPath: string): Promise<string | undefined> {
    const passphrase = await vscode.window.showInputBox({
      title: `SSH Key Passphrase for ${serverName}`,
      prompt: `Enter passphrase for SSH private key (${keyPath})`,
      password: true,
      ignoreFocusOut: true
    });

    if (passphrase !== undefined && passphrase.length > 0) {
      await this.setPassphrase(serverName, passphrase);
    }
    return passphrase;
  }
}
