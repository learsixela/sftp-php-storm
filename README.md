# Deployment & Sync (PhpStorm Style) for Antigravity & VS Code

Una extensión profesional de despliegue, comparación y sincronización SFTP/SSH para Antigravity y VS Code, diseñada para ofrecer la misma experiencia ágil, visual y potente de **PhpStorm Deployment**.

---

## ✨ Características Principales

- ⬆️ **Menús Contextuales (Estilo PhpStorm):** Clic derecho en cualquier archivo, pestaña o carpeta para subir, descargar, comparar o sincronizar.
- ⬆️ **Upload All Opened Files:** Sube simultáneamente todas las pestañas de archivos abiertas en el editor (`Ctrl+Alt+Shift+U`).
- 🔄 **Upload Changed / Modified Files:** Detección de archivos modificados por hash SHA-256 baseline para subir sólo lo que cambió.
- ↔️ **Compare with Deployed Version:** Visor de diferencias nativo lado a lado (`vscode.diff`) en memoria (`deployment-remote://`) sin generar archivos temporales en disco (`Ctrl+Alt+D`).
- 📁 **Panel Lateral Completo:** Lista de servidores, lista de cambios pendientes en tiempo real y explorador de archivos remotos.
- 🔒 **Seguridad Blindada:**
  - Bloqueo físico en el núcleo para evitar subir `.vscode`, `sftp.json`, `.git`, `.env` o archivos de claves.
  - Almacenamiento seguro de contraseñas y frases de paso en el **Llavero de Windows / VS Code SecretStorage** (no requiere contraseñas en texto plano).
  - Soporte nativo para `.gitignore`, `.sftpignore` y variables de entorno.
- ⚡ **Caché Incremental O(1):** Rendimiento instantáneo al guardar archivos sin bloqueos en proyectos grandes.
- 📡 **Monitoreo Remoto en Segundo Plano:** Sondeo periódico configurable que detecta si otros desarrolladores o procesos modificaron archivos en el servidor.

---

## 🚀 Guía Paso a Paso para Conectar a un Servidor SFTP

### Paso 1: Abrir o Crear la Configuración
1. Abre tu proyecto en Antigravity / VS Code.
2. Presiona `Ctrl + Shift + P` y selecciona:
   **`Deployment: Open Deployment Configuration (.vscode/sftp.json)`**
   *(O haz clic en el icono de engranaje ⚙️ en el panel lateral de Deployment).*
3. Esto creará y abrirá automáticamente el archivo `.vscode/sftp.json`.

---

### Paso 2: Configurar los Parámetros de tu Servidor

Edita tu archivo `.vscode/sftp.json` con los datos de tu servidor:

```json
{
  "name": "MiServidor",
  "host": "sftp.ejemplo.com",
  "port": 22,
  "username": "usuario",
  "remotePath": "/var/www/html",
  "uploadOnSave": true,
  "useGitIgnore": true,
  "ignore": [
    ".vscode",
    ".git",
    "node_modules"
  ]
}
```

#### 📖 Explicación de los Campos:
| Campo | Descripción |
|---|---|
| `name` | Nombre descriptivo del servidor (ej. `"Producción"`, `"Staging"`, `"Kultrun"`). |
| `host` | Dirección IP o dominio del servidor (ej. `"192.168.1.100"` o `"servidor.empresa.cl"`). |
| `port` | Puerto SSH/SFTP (por defecto `22`). |
| `username` | Nombre de usuario en el servidor. |
| `password` | *(Opcional)* Contraseña del usuario. **Recomendación:** Déjala vacía; la extensión te la pedirá de forma segura y la guardará en el llavero de Windows. |
| `privateKeyPath` | *(Opcional)* Ruta a tu clave SSH privada (ej. `"~/.ssh/id_rsa"` o `"C:/Users/TuUsuario/.ssh/id_ed25519"`). |
| `passphrase` | *(Opcional)* Frase de paso si tu clave SSH está cifrada. |
| `remotePath` | Ruta absoluta en el servidor donde se alojará el proyecto (ej. `"/var/www/html"` o `"/home/usuario/public_html"`). |
| `uploadOnSave` | `true` para subir automáticamente el archivo cada vez que pulses `Ctrl + S`. |
| `useGitIgnore` | `true` para excluir automáticamente del despliegue todos los archivos y carpetas listados en tu `.gitignore`. |
| `ignore` | Lista adicional de patrones o carpetas a excluir (ej. `["node_modules", "cache/**", "*.log"]`). |
| `remotePollingInterval` | *(Opcional)* Intervalo en segundos para comprobar cambios en el servidor en segundo plano (por defecto `60`, o `0` para desactivar). |

---

### Paso 3: Métodos de Autenticación Soportados

#### Opción A: Contraseña Segura con Llavero de Windows (Recomendada)
No escribas tu contraseña en el archivo JSON. Déjalo sin el campo `password`. La primera vez que conectes o subas un archivo:
1. Aparecerá un cuadro emergente: *"Enter password for usuario@host"*.
2. Escribe tu contraseña (se mostrará con asteriscos `***`).
3. La extensión la guardará de forma cifrada en el **Administrador de Credenciales de Windows (DPAPI)**.
4. **¡Listo!** No tendrás que volver a escribirla y tu repositorio jamás expondrá tu contraseña en texto plano.

#### Opción B: Clave SSH Privada (Con o sin Passphrase)
```json
{
  "name": "ServidorClaveSSH",
  "host": "192.168.1.50",
  "port": 22,
  "username": "ubuntu",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/var/www/proyecto"
}
```
*Si tu clave SSH requiere contraseña (passphrase), la extensión te la solicitará una sola vez y la guardará de forma segura.*

#### Opción C: Variables de Entorno
Puedes referenciar variables de tu sistema operativo:
```json
{
  "name": "ServidorVariables",
  "host": "${env:DEPLOY_HOST}",
  "username": "${env:DEPLOY_USER}",
  "password": "${env:DEPLOY_PASSWORD}",
  "remotePath": "/var/www/app"
}
```

#### Opción D: Múltiples Servidores (Desarrollo y Producción)
Puedes definir múltiples servidores usando un array o la clave `"profiles"`:
```json
[
  {
    "name": "Desarrollo",
    "host": "dev.ejemplo.com",
    "port": 22,
    "username": "devuser",
    "remotePath": "/var/www/dev"
  },
  {
    "name": "Produccion",
    "host": "prod.ejemplo.com",
    "port": 22,
    "username": "produser",
    "remotePath": "/var/www/prod",
    "uploadOnSave": false
  }
]
```

---

### Paso 4: Probar la Conexión
1. Presiona `Ctrl + Shift + P` y selecciona **`Deployment: Test Connection`**.
   *(O ve al panel lateral de Deployment ➔ **Servers** ➔ icono de enchufe 🔌).*
2. La extensión se conectará al servidor, verificará la ruta remota y te mostrará una notificación:
   > ✅ *Connected successfully to MiServidor in 142ms! Remote Root: /var/www/html*

---

### Paso 5: ¡Comenzar a Desplegar y Sincronizar!

- **Subir un archivo o carpeta:** Clic derecho sobre el archivo ➔ `Deployment` ➔ `Upload to Deployed Server` (o `Ctrl+Alt+U`).
- **Subir todas las pestañas abiertas:** `Ctrl+Alt+Shift+U` o menú contextual `Upload All Opened Files`.
- **Comparar archivo local con el servidor:** Clic derecho ➔ `Compare with Deployed Version` (o `Ctrl+Alt+D`).
- **Sincronizar cambios modificados:** Presiona `Ctrl+Alt+S` o haz clic en el botón de la barra de estado inferior.

---

## ⌨️ Atajos de Teclado

| Atajo | Acción |
|---|---|
| `Ctrl + Alt + U` | Subir archivo activo al servidor |
| `Ctrl + Alt + Shift + U` | Subir todas las pestañas abiertas |
| `Ctrl + Alt + D` | Comparar archivo activo con el servidor (Diff lado a lado) |
| `Ctrl + Alt + S` | Sincronizar archivos modificados con el servidor |

---

## 🛡️ Exclusiones y Seguridad por Defecto

1. **Archivos estrictamente bloqueados (Hardcoded Blacklist):**
   La extensión jamás subirá al servidor los siguientes archivos, incluso si se selecciona la carpeta raíz:
   - `.vscode/**`, `sftp.json`, `sftp.local.json`
   - `.git/**`, `.gitignore`, `.manifest.json`
   - `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`
   - `node_modules/**`, `.idea/**`
2. **Archivos de exclusión personalizados:**
   - La extensión respeta automáticamente tu `.gitignore`.
   - Puedes crear un archivo `.sftpignore` en la raíz de tu proyecto con reglas idénticas a gitignore.

---

## 📦 Instalación

1. En Antigravity / VS Code presiona `Ctrl + Shift + P`.
2. Escribe y selecciona: **`Extensions: Install from VSIX...`**
3. Selecciona el archivo `phpstorm-deployment-sync-1.0.0.vsix`.
