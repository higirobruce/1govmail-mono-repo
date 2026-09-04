'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  /** Desktop sidebar collapsed to an icon rail. Persisted per device. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: 'ui' },
  ),
);
