import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
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

/** Radix's pointer path needs PointerEvent plumbing jsdom lacks; Enter also
 *  proves the trigger stays keyboard-operable. */
function openOverflow() {
  fireEvent.keyDown(screen.getByRole('button', { name: /more actions/i }), { key: 'Enter' });
  return screen.getByRole('menu');
}

// The phone overflow held Reply / Reply all / Forward and the AI actions but no
// Delete, and the desktop toolbar never carried one either — so on a phone
// there was no way to delete a thread at all.
describe('ThreadHeader delete action', () => {
  afterEach(() => cleanup());

  it('offers Delete in the phone overflow menu', () => {
    renderHeader({ onDelete: () => {} });

    expect(within(openOverflow()).getByRole('menuitem', { name: /delete/i })).toBeTruthy();
  });

  it('routes the menu pick to the delete handler', () => {
    const onDelete = vi.fn();
    renderHeader({ onDelete });

    fireEvent.click(within(openOverflow()).getByRole('menuitem', { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('omits Delete when the parent supplies no handler', () => {
    renderHeader();

    expect(within(openOverflow()).queryByRole('menuitem', { name: /delete/i })).toBeNull();
  });

  it('keeps Delete out of the reply group so it cannot be hit by accident', () => {
    renderHeader({ onDelete: () => {} });
    const items = within(openOverflow()).getAllByRole('menuitem').map((i) => i.textContent ?? '');

    // Destructive action goes last, after every constructive one.
    expect(items[items.length - 1]).toMatch(/delete/i);
  });
});
