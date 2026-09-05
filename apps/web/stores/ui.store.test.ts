import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './ui.store';

describe('useUIStore sidebar collapse', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false });
  });

  it('starts expanded', () => {
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar flips the collapsed state', () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});
