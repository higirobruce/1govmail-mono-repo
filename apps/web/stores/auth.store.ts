'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/lib/api';

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true';

const MOCK_USER = {
  id: 'u1',
  email: 'alex@company.com',
  displayName: 'Alex Morgan',
  zimbraHost: 'mail.company.com',
};

interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  zimbraHost: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (
    email: string,
    password: string,
    zimbraHost: string,
  ) => Promise<{ requiresTwoFactor: true; twoFactorToken: string } | void>;
  twoFactor: (twoFactorToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      // In mock mode, start pre-authenticated so the mail shell renders immediately
      user: USE_MOCK ? MOCK_USER : null,
      token: USE_MOCK ? 'mock-token' : null,
      isAuthenticated: USE_MOCK,

      login: async (email, password, zimbraHost) => {
        const result = await api.auth.login(email, password, zimbraHost);
        // 2FA required — return the challenge token so the UI can prompt for OTP
        if ('requiresTwoFactor' in result && result.requiresTwoFactor) {
          return { requiresTwoFactor: true as const, twoFactorToken: result.twoFactorToken };
        }
        const { accessToken, user } = result as { accessToken: string; user: AuthUser };
        set({ user, token: accessToken, isAuthenticated: true });
      },

      twoFactor: async (twoFactorToken, code) => {
        const { accessToken, user } = await api.auth.twoFactor(twoFactorToken, code);
        set({ user, token: accessToken, isAuthenticated: true });
      },

      logout: async () => {
        await api.auth.logout().catch(() => {});
        set({ user: null, token: null, isAuthenticated: false });
        // Persist middleware will write the cleared state; also wipe legacy key.
        localStorage.removeItem('access_token');
      },

      setUser: (user) => set({ user }),
    }),
    {
      name: 'auth',
      partialize: (state) => ({ user: state.user, token: state.token, isAuthenticated: state.isAuthenticated }),
    },
  ),
);
