# Deployment & Sync (PhpStorm Style) for Antigravity & VS Code

Una extensión profesional de despliegue, comparación y sincronización SFTP/SSH para Antigravity y VS Code, diseñada para ofrecer la misma experiencia ágil y potente de **PhpStorm Deployment**.

---

## ✨ Características Principales

### 1. Menús Contextuales Idénticos a PhpStorm
- **En el Explorador de Archivos (clic derecho en archivos o carpetas):**
  - `Deployment` ➔ `Upload to Deployed Server`
  - `Deployment` ➔ `Upload to...` (elegir servidor de la lista)
  - `Deployment` ➔ `Upload All Opened Files` (sube todas las pestañas abiertas)
  - `Deployment` ➔ `Upload Changed / Modified Files` (sube sólo los archivos con cambios pendientes)
  - `Deployment` ➔ `Download from Deployed Server`
  - `Deployment` ➔ `Compare with Deployed Version` (visor diff lado a lado)
  - `Deployment` ➔ `Sync with Deployed...` (análisis comparativo interactivo)
  - `Deployment` ➔ `Edit Remote File` (editar archivos directamente en el servidor)

- **En el Editor de Código y Pestañas:**
  - Mismas opciones contextuales accesibles directamente al programar.

### 2. Comparación Lado a Lado (`vscode.diff`)
- Descarga el archivo remoto en un buffer virtual en memoria (`deployment-remote://`) sin generar archivos temporales en tu disco.
- Abre la vista de diferencias nativa: **Servidor Remoto (Izquierda)** ↔ **Local (Derecha)** con resaltado exacto de líneas modificadas.

### 3. Sincronización Inteligente de Archivos Modificados
- Rastreo automático por hash SHA-256 (compatible con `.manifest.json` y herramientas como `sync.js`).
- Comando de subida por lotes con barra de progreso y resumen de archivos sincronizados.
- Soporte para **Upload on Save** automático (activable/desactivable en configuración).

### 4. Panel Lateral de Deployment
En la barra de actividad lateral (Activity Bar):
- 🖥️ **Servers**: Lista de servidores configurados con botón para probar conexión (`Test Connection`) y editar configuración.
- 📝 **Pending Changes**: Lista de archivos modificados/añadidos/eliminados respecto a la línea base, con acciones directas para subir o comparar.
- 📁 **Remote File Explorer**: Navegador de archivos remoto para explorar carpetas en el servidor y abrir archivos remotos con un clic.

### 5. Barra de Estado Interactiva
- Indicador en la barra inferior con el servidor activo (ej: `$(cloud-upload) MyServer`).
- Contador de cambios pendientes (ej: `$(sync) 3 changed`). Al hacer clic, sube inmediatamente los archivos modificados.

---

## ⚙️ Configuración (`.vscode/sftp.json`)

La extensión es 100% compatible con el formato estándar de `.vscode/sftp.json`:

```json
{
  "name": "MyServer",
  "host": "example.com",
  "port": 22,
  "username": "user",
  "password": "password",
  "protocol": "sftp",
  "remotePath": "/var/www/html",
  "uploadOnSave": true,
  "ignore": [
    ".vscode",
    ".git",
    "node_modules"
  ]
}
```

También soporta múltiples servidores usando un array o la propiedad `"profiles"`.

---

## ⌨️ Atajos de Teclado

| Atajo | Acción |
|---|---|
| `Ctrl + Alt + U` | Subir archivo activo |
| `Ctrl + Alt + Shift + U` | Subir todos los archivos abiertos |
| `Ctrl + Alt + D` | Comparar archivo activo con el servidor |
| `Ctrl + Alt + S` | Sincronizar archivos con el servidor |

---

## 📦 Instalación

1. En Antigravity / VS Code: Abre la paleta de comandos (`Ctrl+Shift+P`).
2. Selecciona **Extensions: Install from VSIX...**
3. Selecciona el archivo `phpstorm-deployment-sync-1.0.0.vsix`.
