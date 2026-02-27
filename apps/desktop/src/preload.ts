import { contextBridge, ipcRenderer } from 'electron';

// ─── Expose a narrow, typed API to the renderer via the context bridge ─────────
// Nothing from Node/Electron leaks into the page — only these explicit methods.
contextBridge.exposeInMainWorld('electronAPI', {
  /** Always `true` — lets the web app know it is running inside Electron. */
  isElectron: true as const,

  /** The host OS: 'darwin' | 'win32' | 'linux' */
  platform: process.platform as 'darwin' | 'win32' | 'linux',

  /**
   * Ask the main process to show a native OS notification.
   * Works even when the window is hidden in the system tray.
   */
  sendNotification(title: string, body: string) {
    ipcRenderer.send('notify', { title, body });
  },

  /**
   * Update the macOS Dock badge with the current unread email count.
   * Pass 0 to clear the badge. No-op on Windows/Linux.
   */
  setBadgeCount(count: number) {
    ipcRenderer.send('badge-count', count);
  },
});

// ─── Inject platform data attributes before the first paint ───────────────────
// The web app reads [data-electron] and [data-platform] from <html> to:
//   • Apply Electron-specific CSS (titlebar height offset)
//   • Show the macOS drag region component
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.electron = 'true';
  document.documentElement.dataset.platform = process.platform;
});
