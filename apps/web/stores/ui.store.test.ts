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

describe('useUIStore AI-profile nudge', () => {
  beforeEach(() => {
    useUIStore.setState({ aiProfileNudgeDismissed: false });
  });

  it('starts undismissed, so a new user is asked once', () => {
    expect(useUIStore.getState().aiProfileNudgeDismissed).toBe(false);
  });

  it('dismissAiProfileNudge is one-way — the prompt never comes back', () => {
    useUIStore.getState().dismissAiProfileNudge();
    expect(useUIStore.getState().aiProfileNudgeDismissed).toBe(true);
    useUIStore.getState().dismissAiProfileNudge();
    expect(useUIStore.getState().aiProfileNudgeDismissed).toBe(true);
  });
});

