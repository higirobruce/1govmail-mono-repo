import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  resolveCapabilities, ALL_CAPABILITIES, type SettingsCapabilities,
} from './capabilities';

// ── Module mocks ──────────────────────────────────────────────────────────────
// The settings page pulls in the router, the persisted auth store, the app
// sidebar and the API client on mount. Only the settings payload matters here,
// so the rest is stubbed to the minimum the page reads.

const settingsGet = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/stores/auth.store', () => {
  const useAuthStore: any = (selector: any) => selector({ isAuthenticated: true });
  useAuthStore.persist = {
    hasHydrated: () => true,
    onFinishHydration: () => () => {},
  };
  return { useAuthStore };
});

vi.mock('@/components/layout/Sidebar', () => ({
  default: () => <div data-testid="sidebar" />,
}));

vi.mock('@/lib/api', () => ({
  api: {
    settings: {
      get: (...args: any[]) => settingsGet(...args),
      updateIdentity: vi.fn(),
      updatePrefs: vi.fn(),
      changePassword: vi.fn(),
    },
    auth: { getSessions: vi.fn().mockResolvedValue([]) },
    mail: { getSenderRules: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import SettingsPage from './page';

const payload = (capabilities?: Partial<SettingsCapabilities>) => ({
  email: 'bruce@risa.gov.rw',
  zimbraHost: 'zimbra.example.com',
  displayName: 'Bruce H.',
  prefs: {},
  identities: [{ id: 'i1', name: 'DEFAULT', attrs: {} }],
  signatures: [],
  ...(capabilities ? { capabilities } : {}),
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

// ── resolveCapabilities ───────────────────────────────────────────────────────

describe('resolveCapabilities', () => {
  it('treats a missing capabilities object as everything supported', () => {
    expect(resolveCapabilities(undefined)).toEqual(ALL_CAPABILITIES);
    expect(resolveCapabilities(null)).toEqual(ALL_CAPABILITIES);
  });

  it('defaults each absent flag to true, so a partial object still renders the rest', () => {
    expect(resolveCapabilities({ signatures: false })).toEqual({
      ...ALL_CAPABILITIES,
      signatures: false,
    });
  });

  it('passes explicit false through', () => {
    expect(resolveCapabilities(ALL_CAPABILITIES).signatures).toBe(true);
    expect(resolveCapabilities({ signatures: false, changePassword: false })).toEqual({
      signatures: false,
      identities: true,
      serverPrefs: true,
      changePassword: false,
      twoFactor: true,
    });
  });
});

// ── Section gating ────────────────────────────────────────────────────────────

describe('settings page capability gating', () => {
  beforeEach(() => {
    settingsGet.mockReset();
  });

  it('hides the Signatures section when the provider does not support signatures', async () => {
    settingsGet.mockResolvedValue(payload({ signatures: false }));

    renderPage();

    // Wait for the load to settle on a section that is always rendered.
    await waitFor(() => expect(screen.getByText('Profile')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /signatures/i })).toBeNull();
  });

  it('renders every provider-backed section when the field is absent entirely', async () => {
    settingsGet.mockResolvedValue(payload());

    renderPage();

    await waitFor(() => expect(screen.getByText('Profile')).toBeInTheDocument());
    for (const label of [/signatures/i, /vacation reply/i, /preferences/i, /security/i]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('renders every provider-backed section when all flags are true (Zimbra)', async () => {
    settingsGet.mockResolvedValue(payload(ALL_CAPABILITIES));

    renderPage();

    await waitFor(() => expect(screen.getByText('Profile')).toBeInTheDocument());
    for (const label of [/signatures/i, /vacation reply/i, /preferences/i, /security/i]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('keeps the local-only Profile and Preferences content when the provider serves neither', async () => {
    settingsGet.mockResolvedValue(payload({ identities: false, serverPrefs: false }));

    renderPage();

    // Profile keeps the read-only mailbox info but loses the identity editor.
    await waitFor(() => expect(screen.getByText('bruce@risa.gov.rw')).toBeInTheDocument());
    expect(screen.queryByText('Display name')).toBeNull();
    expect(screen.queryByRole('button', { name: /vacation reply/i })).toBeNull();

    // Preferences keeps theme/font size (localStorage) and the local
    // email-normalisation toggle, and drops the server-pref rows.
    fireEvent.click(screen.getByRole('button', { name: /preferences/i }));
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Consistent email display')).toBeInTheDocument();
    expect(screen.queryByText('Display messages as HTML')).toBeNull();
    expect(screen.queryByText('Composing')).toBeNull();
  });

  it('keeps the local session list in Security when the provider cannot change passwords', async () => {
    settingsGet.mockResolvedValue(payload({ changePassword: false }));

    renderPage();

    await waitFor(() => expect(screen.getByText('Profile')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /security/i }));

    await waitFor(() => expect(screen.getByText('Active sessions')).toBeInTheDocument());
    expect(screen.queryByText('Current password')).toBeNull();
  });

  it('renders the password form and every server-pref row when all flags are true', async () => {
    settingsGet.mockResolvedValue(payload(ALL_CAPABILITIES));

    renderPage();

    await waitFor(() => expect(screen.getByText('Profile')).toBeInTheDocument());
    expect(screen.getByText('Display name')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /preferences/i }));
    expect(screen.getByText('Display messages as HTML')).toBeInTheDocument();
    expect(screen.getByText('Consistent email display')).toBeInTheDocument();
    expect(screen.getByText('Composing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /security/i }));
    await waitFor(() => expect(screen.getByText('Current password')).toBeInTheDocument());
    expect(screen.getByText('Active sessions')).toBeInTheDocument();
  });
});
