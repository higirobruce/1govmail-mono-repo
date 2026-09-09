import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ThreadScopeChip from './ThreadScopeChip';

const base = {
  subject: 'Re: RHEMIS inception report',
  messageCount: 6,
  included: null as number | null,
  locked: false,
  injectionSuspected: false,
  onToggleLock: () => {},
  onClear: () => {},
};

describe('ThreadScopeChip', () => {
  it('shows the subject and the message count', () => {
    render(<ThreadScopeChip {...base} />);
    expect(screen.getByText('Re: RHEMIS inception report')).toBeTruthy();
    expect(screen.getByText('6 messages')).toBeTruthy();
  });

  it('falls back to (no subject)', () => {
    render(<ThreadScopeChip {...base} subject={null} />);
    expect(screen.getByText('(no subject)')).toBeTruthy();
  });

  it('says "N of M messages" when the pin was budget-capped', () => {
    render(<ThreadScopeChip {...base} included={4} />);
    expect(screen.getByText('4 of 6 messages')).toBeTruthy();
  });

  it('does not say "of" when everything was included', () => {
    render(<ThreadScopeChip {...base} included={6} />);
    expect(screen.getByText('6 messages')).toBeTruthy();
  });

  // Review fix I2: the entry points used to hard-code messageCount: 1, so the
  // singular branch was the one users actually saw on two of three paths while
  // being the only branch with no test. Now that the count comes from the
  // gather, a genuine one-message thread is a real default path.
  it('says "1 message", singular', () => {
    render(<ThreadScopeChip {...base} messageCount={1} />);
    expect(screen.getByText('1 message')).toBeTruthy();
  });

  it('keeps the singular noun in the "of" form', () => {
    render(<ThreadScopeChip {...base} messageCount={1} included={0} />);
    expect(screen.getByText('0 of 1 message')).toBeTruthy();
  });

  it('the lock toggle reports its pressed state and calls back', () => {
    const onToggleLock = vi.fn();
    const { rerender } = render(<ThreadScopeChip {...base} onToggleLock={onToggleLock} />);
    const toggle = screen.getByRole('button', { name: /only this thread/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(onToggleLock).toHaveBeenCalledTimes(1);

    rerender(<ThreadScopeChip {...base} locked onToggleLock={onToggleLock} />);
    expect(screen.getByRole('button', { name: /only this thread/i }).getAttribute('aria-pressed')).toBe('true');
  });

  it('clear calls onClear', () => {
    const onClear = vi.fn();
    render(<ThreadScopeChip {...base} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: /remove thread context/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('surfaces an injection warning when flagged', () => {
    render(<ThreadScopeChip {...base} injectionSuspected />);
    expect(screen.getByRole('img', { name: /suspicious content/i })).toBeTruthy();
  });
});
