/**
 * Type declarations for the Electron context-bridge API.
 * `window.electronAPI` is only defined when the web app is running inside
 * the 1Gov Mail desktop app — it is `undefined` in a regular browser.
 */
export {};

declare global {
  interface Window {
    electronAPI?: {
      /** Always `true` — used to detect the Electron environment. */
      readonly isElectron: true;

      /** Host operating system. */
      readonly platform: 'darwin' | 'win32' | 'linux';

      /**
       * Ask the main process to show a native OS notification.
       * Safe to call even when the window is hidden in the system tray.
       */
      sendNotification(title: string, body: string): void;

      /**
       * Set the macOS Dock badge to the given unread count.
       * Pass `0` to clear the badge. No-op on Windows/Linux.
       */
      setBadgeCount(count: number): void;
    };
  }
}
