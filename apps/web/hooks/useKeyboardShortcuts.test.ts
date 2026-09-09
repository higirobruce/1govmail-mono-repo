import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts, SHORTCUTS } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts — q (ask about this thread)', () => {
  it('fires the q handler on an unmodified q press', () => {
    const q = vi.fn();
    renderHook(() => useKeyboardShortcuts({ q }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('does not fire q while typing in an input', () => {
    const q = vi.fn();
    renderHook(() => useKeyboardShortcuts({ q }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }));
    expect(q).not.toHaveBeenCalled();
    input.remove();
  });

  it('does not fire q on cmd+q', () => {
    const q = vi.fn();
    renderHook(() => useKeyboardShortcuts({ q }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', metaKey: true }));
    expect(q).not.toHaveBeenCalled();
  });

  it('advertises q in the SHORTCUTS table', () => {
    expect(SHORTCUTS.find((s) => s.key === 'q')).toEqual({
      key: 'q', label: 'Q', description: 'Ask about this thread',
    });
  });
});
