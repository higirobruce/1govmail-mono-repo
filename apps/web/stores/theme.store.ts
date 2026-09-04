'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';
export type FontSize = 'sm' | 'default' | 'lg' | 'xl';

// Root font-size (rem base). App text uses rem-derived sizes, so this scales
// everything; 'default' matches the web-standard 16px browser default.
export const FONT_SIZE_MAP: Record<FontSize, string> = {
  sm:      '14px',
  default: '16px',
  lg:      '18px',
  xl:      '20px',
};

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  fontSize: FontSize;
  setFontSize: (size: FontSize) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme:       'system',
      setTheme:    (theme) => set({ theme }),
      fontSize:    'default',
      setFontSize: (fontSize) => set({ fontSize }),
    }),
    { name: 'theme' },
  ),
);
