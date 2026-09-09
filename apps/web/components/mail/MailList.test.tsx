import { describe, expect, it, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MailList from './MailList';

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

function openContextMenu() {
  fireEvent.contextMenu(screen.getByText('Alice Umutoni'));
}

describe('MailList context-menu "Ask about this thread" gate', () => {
  it('omits the row entirely when aiEnabled is false', () => {
    render(<MailList messages={[message]} onSelect={() => {}} onContextAction={() => {}} aiEnabled={false} />);
    openContextMenu();
    expect(screen.queryByText('Ask about this thread')).toBeNull();
  });

  it('shows the row when aiEnabled is true', () => {
    render(<MailList messages={[message]} onSelect={() => {}} onContextAction={() => {}} aiEnabled={true} />);
    openContextMenu();
    expect(screen.getByText('Ask about this thread')).not.toBeNull();
  });
});
