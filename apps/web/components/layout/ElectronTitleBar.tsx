'use client';

import { useEffect, useState } from 'react';

/**
 * Renders a native-feeling title bar ONLY when running inside the Electron
 * desktop app on macOS.
 *
 * • macOS  – The window uses `titleBarStyle: 'hiddenInset'`, which keeps the
 *            traffic-light (close/minimise/zoom) buttons but hides the native
 *            title. This component adds a styled drag region with the app name
 *            centred and a 72 px inset on the left so the buttons aren't
 *            obscured. A spacer below the fixed bar keeps content from sliding
 *            under it.
 *
 * • Windows / Linux – The native OS frame is used unchanged; this component
 *   renders nothing on those platforms.
 *
 * • Browser – Always renders nothing.
 */
export function ElectronTitleBar() {
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (api?.isElectron) {
      setPlatform(api.platform);
    }
  }, []);

  // Only macOS needs the custom drag area (Windows/Linux have native frames)
  if (platform !== 'darwin') return null;

  return (
    <>
      {/*
       * Spacer — pushes page content below the fixed overlay bar.
       * Height must match the fixed bar's h-7 (28 px).
       */}
      <div className="h-7 w-full shrink-0" aria-hidden="true" />

      {/*
       * Fixed drag-region overlay.
       * `-webkit-app-region: drag` makes the whole bar a window-drag handle.
       * The left 72 px is explicitly set to `no-drag` so clicks on the
       * traffic-light buttons reach Electron instead of being consumed by the
       * drag handler.
       */}
      <div
        className="fixed top-0 left-0 right-0 h-7 z-[9999] flex items-center
                   bg-sidebar border-b border-sidebar-border/40 select-none"
        // @ts-expect-error — WebkitAppRegion is a Chromium / Electron extension
        style={{ WebkitAppRegion: 'drag' }}
      >
        {/* Traffic-light safe zone (≈72 px on a Retina display) */}
        <div
          className="w-[72px] shrink-0 h-full"
          // @ts-expect-error
          style={{ WebkitAppRegion: 'no-drag' }}
        />

        {/* App name — centred, non-interactive */}
        <div className="flex-1 flex items-center justify-center pointer-events-none">
          <span className="text-[0.6875rem] font-medium text-foreground/30 tracking-wide">
            1Gov Mail
          </span>
        </div>

        {/* Mirror the left inset on the right so the label stays visually centred */}
        <div className="w-[72px] shrink-0" />
      </div>
    </>
  );
}
