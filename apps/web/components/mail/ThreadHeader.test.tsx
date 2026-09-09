import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ThreadHeader from './ThreadHeader';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderHeader() {
  return render(
    <TooltipProvider>
      <ThreadHeader
        subject="Budget review"
        participants={[{ email: 'alice@risa.gov.rw', name: 'Alice' }]}
        messageCount={3}
        unreadCount={0}
        lastReceivedAt={new Date().toISOString()}
        lastSenderEmail="alice@risa.gov.rw"
        currentUserEmail="me@risa.gov.rw"
        onClose={() => {}}
        onReply={() => {}}
        onReplyAll={() => {}}
        onForward={() => {}}
        onSummarize={() => {}}
        onDraftDoc={() => {}}
        onQuickReply={() => {}}
      />
    </TooltipProvider>,
  );
}

describe('ThreadHeader toolbar on narrow screens', () => {
  it('AI pill labels collapse to icon-only below sm so the row cannot overflow', () => {
    renderHeader();
    for (const label of ['Summarize', 'Draft doc']) {
      const span = screen.getByText(label);
      expect(span.className).toContain('hidden');
      expect(span.className).toContain('sm:inline');
    }
  });

  it('status pill can shrink and truncate instead of pushing buttons out', () => {
    renderHeader();
    const pill = screen.getByText('Awaiting reply');
    expect(pill.className).not.toContain('shrink-0');
    expect(pill.className).toContain('truncate');
  });
});

const base = {
  subject: 'Re: RHEMIS inception report',
  participants: [{ email: 'a@risa.gov.rw', name: 'A' }],
  messageCount: 6,
  unreadCount: 0,
  lastReceivedAt: '2026-09-08T10:00:00.000Z',
  lastSenderEmail: 'a@risa.gov.rw',
  currentUserEmail: 'bruce.higiro@risa.gov.rw',
  onClose: () => {},
  onReply: () => {},
  onReplyAll: () => {},
  onForward: () => {},
};

describe('ThreadHeader ask-thread action', () => {
  it('renders nothing when onAskThread is undefined (AI off)', () => {
    render(<TooltipProvider><ThreadHeader {...base} /></TooltipProvider>);
    expect(screen.queryByRole('button', { name: /ask about this thread/i })).toBeNull();
  });

  it('renders the pill and calls back when provided', () => {
    const onAskThread = vi.fn();
    render(<TooltipProvider><ThreadHeader {...base} onAskThread={onAskThread} /></TooltipProvider>);
    fireEvent.click(screen.getByRole('button', { name: /ask about this thread/i }));
    expect(onAskThread).toHaveBeenCalledTimes(1);
  });
});
