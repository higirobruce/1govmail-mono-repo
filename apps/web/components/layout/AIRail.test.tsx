import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AIRail } from './AIRail';

// AIRail's Settings button calls useRouter() — mock it the same way
// Sidebar.test.tsx does, since jsdom has no app router mounted.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/components/layout/NotificationsBell', () => ({
  NotificationsBell: () => <div data-testid="bell" />,
}));

const props = {
  aiEnabled: true, briefingOpen: false, commitmentsOpen: false, askOpen: false,
  onBriefing: vi.fn(), onCommitments: vi.fn(), onAsk: vi.fn(),
};

describe('AIRail', () => {
  it('carries the notification bell', () => {
    // The rail's buttons are Radix Tooltips, which need a provider — the same
    // wrapper ThreadHeader.test.tsx and Sidebar.test.tsx already use.
    render(
      <TooltipProvider>
        <AIRail {...props} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('bell')).toBeTruthy();
  });
});
