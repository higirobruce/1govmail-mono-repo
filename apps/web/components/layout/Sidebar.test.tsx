import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: { mail: { getFolders: vi.fn(async () => []) } } }));
vi.mock('@/lib/offline/provider', () => ({
  useOffline: () => ({ status: { online: true, pending: 0, failed: 0 } }),
}));
vi.mock('@/stores/auth.store', () => {
  const state = {
    user: { email: 'me@risa.gov.rw', displayName: 'Me' },
    isAuthenticated: true,
    logout: vi.fn(),
  };
  return { useAuthStore: (sel?: any) => (sel ? sel(state) : state) };
});
vi.mock('@/hooks/useResizable', () => ({
  useResizable: () => ({ width: 220, dragging: false, startDrag: vi.fn(), reset: vi.fn() }),
}));

import Sidebar from './Sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/ui.store';

function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <TooltipProvider>
      <Sidebar onFolderSelect={() => {}} {...props} />
    </TooltipProvider>,
  );
}

// jsdom has no matchMedia — pretend we're a phone (below the tablet band).
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as any;
});

describe('Sidebar in the mobile sheet (forceExpanded)', () => {
  it('renders expanded even when the device has a persisted collapsed state', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    const { container } = renderSidebar({ forceExpanded: true });
    expect(container.querySelector('[data-collapsed="true"]')).toBeNull();
    // Labels are visible in expanded mode.
    expect(screen.getByText('Compose')).toBeTruthy();
  });

  it('hides the desktop collapse toggle and resize handle in the sheet', () => {
    useUIStore.setState({ sidebarCollapsed: false });
    renderSidebar({ forceExpanded: true });
    expect(screen.queryByLabelText('Collapse sidebar')).toBeNull();
    expect(screen.queryByLabelText('Resize sidebar')).toBeNull();
  });

  it('still collapses to the icon rail on desktop without forceExpanded', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    const { container } = renderSidebar();
    expect(container.querySelector('[data-collapsed="true"]')).toBeTruthy();
  });
});
