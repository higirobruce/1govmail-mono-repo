'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  /** Desktop sidebar collapsed to an icon rail. Persisted per device. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /**
   * Drag-resized panel widths in px, keyed by panel id (e.g. 'sidebar',
   * 'mailList', 'aiPanel', 'calendarDetail'). Absent key = use the panel's
   * default width. Persisted per device.
   */
  panelWidths: Record<string, number>;
  setPanelWidth: (key: string, width: number) => void;
  resetPanelWidth: (key: string) => void;
  /**
   * The AI-profile prompt has been waved away on this device. One-way: it is
   * an invitation, and re-asking someone who already said no is nagging.
   * Filling the profile hides the prompt on its own, everywhere.
   */
  aiProfileNudgeDismissed: boolean;
  dismissAiProfileNudge: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      panelWidths: {},
      setPanelWidth: (key, width) =>
        set((s) => ({ panelWidths: { ...s.panelWidths, [key]: width } })),
      resetPanelWidth: (key) =>
        set((s) => {
          const next = { ...s.panelWidths };
          delete next[key];
          return { panelWidths: next };
        }),
      aiProfileNudgeDismissed: false,
      dismissAiProfileNudge: () => set({ aiProfileNudgeDismissed: true }),
    }),
    { name: 'ui' },
  ),
);
