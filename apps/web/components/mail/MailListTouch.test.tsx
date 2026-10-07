import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import MailList from './MailList';
import { LONG_PRESS_MS } from '@/hooks/useLongPress';

// jsdom has no IntersectionObserver — MailList's infinite-scroll effect
// constructs one on mount regardless of whether there's anything to observe.
beforeAll(() => {
  class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).IntersectionObserver = MockIntersectionObserver;
});

const message = {
  id: 'm1',
  subject: 'Budget review Q3',
  snippet: 'Please find attached…',
  fromName: 'Alice Umutoni',
  fromEmail: 'alice@risa.gov.rw',
  isRead: true,
  isStarred: false,
  hasAttachments: false,
  tags: [],
  receivedAt: new Date().toISOString(),
};

function renderList(onSelect = vi.fn()) {
  const onContextAction = vi.fn();
  render(
    <MailList
      messages={[message]}
      onSelect={onSelect}
      onContextAction={onContextAction}
    />,
  );
  return { onSelect, onContextAction };
}

const row = () => screen.getByText('Alice Umutoni');
const touchAt = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

// A phone fires no `contextmenu`, so every row action — Delete included — was
// unreachable there. Holding a row opens the same menu.
describe('MailList row actions on touch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('opens the row menu after a hold', () => {
    renderList();

    fireEvent.touchStart(row(), touchAt(50, 80));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('does not open the thread as well as the menu', () => {
    const { onSelect } = renderList();

    fireEvent.touchStart(row(), touchAt(50, 80));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fireEvent.touchEnd(row());
    // The browser synthesises a click after the finger lifts.
    fireEvent.click(row());

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('still opens the thread on an ordinary tap', () => {
    const { onSelect } = renderList();

    fireEvent.touchStart(row(), touchAt(50, 80));
    act(() => { vi.advanceTimersByTime(120) });
    fireEvent.touchEnd(row());
    fireEvent.click(row());

    expect(onSelect).toHaveBeenCalledWith('m1');
  });

  it('opens no menu when the finger scrolls instead of holding', () => {
    renderList();

    fireEvent.touchStart(row(), touchAt(50, 80));
    fireEvent.touchMove(row(), touchAt(50, 220));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('reports the action against the held message', () => {
    const { onContextAction } = renderList();

    fireEvent.touchStart(row(), touchAt(50, 80));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    // Menu items must respond to touch, not only to a mouse.
    fireEvent.pointerDown(screen.getByText('Delete'));

    expect(onContextAction).toHaveBeenCalledWith({ type: 'delete', messageId: 'm1' });
  });

  it('closes the menu when the next touch lands outside it', () => {
    renderList();
    fireEvent.touchStart(row(), touchAt(50, 80));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    fireEvent.touchStart(document.body);

    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
