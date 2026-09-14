import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ThreadHeader from './ThreadHeader';
import { TooltipProvider } from '@/components/ui/tooltip';

const base = {
  subject: 'Re: RHEMIS inception report',
  participants: [{ email: 'a@risa.gov.rw', name: 'A' }],
  messageCount: 6,
  unreadCount: 0,
  lastReceivedAt: '2026-09-08T10:00:00.000Z',
  onClose: () => {},
  onReply: () => {},
  onReplyAll: () => {},
  onForward: () => {},
};

function renderHeader(props: Partial<React.ComponentProps<typeof ThreadHeader>> = {}) {
  return render(
    <TooltipProvider>
      <ThreadHeader {...base} {...props} />
    </TooltipProvider>,
  );
}

/**
 * Open the phone overflow via the keyboard. Radix's pointer path needs
 * PointerEvent plumbing jsdom does not provide, and opening with Enter has the
 * side benefit of proving the trigger is keyboard-operable — which a menu
 * holding every thread action has to be.
 */
function openOverflow() {
  const trigger = screen.getByRole('button', { name: /more actions/i });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('ThreadHeader status pill', () => {
  it('is gone — the toolbar no longer derives or renders a thread status', () => {
    renderHeader({ unreadCount: 2, onSummarize: () => {} });
    expect(screen.queryByText('Awaiting reply')).toBeNull();
    expect(screen.queryByText('You replied')).toBeNull();
    // "2 unread" still belongs to the meta line under the title, not a pill.
    const meta = screen.getByText(/6 messages/);
    expect(meta.textContent).toContain('2 unread');
  });
});

describe('ThreadHeader desktop row', () => {
  it('renders every provided action as its own control', () => {
    renderHeader({ onSummarize: () => {}, onDraftDoc: () => {}, onAskThread: () => {}, onQuickReply: () => {} });
    for (const name of [/^reply$/i, /reply all/i, /forward/i, /summarize/i, /draft doc/i, /ask about this thread/i, /quick reply/i]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('shows the AI labels rather than hiding them behind a sm: breakpoint', () => {
    // The whole row is now hidden below sm, so the per-label icon-only trick is gone.
    renderHeader({ onSummarize: () => {}, onDraftDoc: () => {} });
    for (const label of ['Summarize', 'Draft doc']) {
      expect(screen.getByText(label).className).not.toContain('hidden');
    }
  });

  it('separates the mail actions from the AI actions', () => {
    const { container } = renderHeader({ onSummarize: () => {} });
    expect(container.querySelector('[data-testid="thread-action-divider"]')).not.toBeNull();
  });

  it('omits the divider when no AI actions are provided', () => {
    const { container } = renderHeader();
    expect(container.querySelector('[data-testid="thread-action-divider"]')).toBeNull();
  });
});

describe('ThreadHeader phone overflow menu', () => {
  it('reveals every action as a labeled option', () => {
    renderHeader({ onSummarize: () => {}, onDraftDoc: () => {}, onAskThread: () => {}, onQuickReply: () => {} });
    const menu = openOverflow();
    for (const name of [/^reply$/i, /reply all/i, /forward/i, /summarize/i, /draft doc/i, /ask about this thread/i, /quick reply/i]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeTruthy();
    }
  });

  it('routes a menu pick to the same handler as the toolbar', () => {
    const onForward = vi.fn();
    renderHeader({ onForward });
    fireEvent.click(within(openOverflow()).getByRole('menuitem', { name: /forward/i }));
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it('omits an action that was not provided', () => {
    renderHeader({ onSummarize: () => {} });
    const menu = openOverflow();
    expect(within(menu).queryByRole('menuitem', { name: /draft doc/i })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /ask about this thread/i })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: /summarize/i })).toBeTruthy();
  });

  it('carries a disabled state into the menu', () => {
    renderHeader({ onSummarize: () => {}, summarizing: true });
    const item = within(openOverflow()).getByRole('menuitem', { name: /summarize/i });
    expect(item.getAttribute('data-disabled')).not.toBeNull();
  });
});
