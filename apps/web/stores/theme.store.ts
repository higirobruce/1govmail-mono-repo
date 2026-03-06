'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';
export type FontSize = 'sm' | 'default' | 'lg' | 'xl';

export const FONT_SIZE_MAP: Record<FontSize, string> = {
  sm:      '13px',
  default: '15px',
  lg:      '17px',
  xl:      '19px',
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
