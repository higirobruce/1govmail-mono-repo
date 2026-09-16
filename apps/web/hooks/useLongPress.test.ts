import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from './useLongPress';

/**
 * Touch devices never fire `contextmenu`, so the mail list's row menu — the
 * only route to Delete / Move / Mark read from the list — was unreachable on a
 * phone. A hold opens it instead, which means distinguishing a deliberate hold
 * from a tap and from the start of a scroll.
 */
const touch = (x: number, y: number) =>
  ({ touches: [{ clientX: x, clientY: y }], cancelable: true, preventDefault: () => {} }) as any;

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after the hold threshold with the touch coordinates', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.handlers.onTouchStart(touch(120, 340)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(onLongPress).toHaveBeenCalledWith(120, 340);
  });

  it('does not fire for a tap that ends before the threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 50); });
    act(() => result.current.handlers.onTouchEnd());
    act(() => { vi.advanceTimersByTime(200); });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when the finger travels far enough to be a scroll', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchMove(touch(10, 10 + LONG_PRESS_SLOP_PX + 5)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('tolerates the small finger drift that happens during a real hold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchMove(touch(12, 13)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('reports a just-fired press so the row can swallow the click that follows', () => {
    const { result } = renderHook(() => useLongPress(vi.fn()));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    // Without this the hold would open the menu AND open the thread behind it.
    expect(result.current.consumeClick()).toBe(true);
  });

  it('consumes the suppression once, so the next genuine tap still opens', () => {
    const { result } = renderHook(() => useLongPress(vi.fn()));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    result.current.consumeClick();

    expect(result.current.consumeClick()).toBe(false);
  });

  it('never suppresses a click when no long press happened', () => {
    const { result } = renderHook(() => useLongPress(vi.fn()));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchEnd());

    expect(result.current.consumeClick()).toBe(false);
  });

  it('cancels a pending press when the gesture is interrupted', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchCancel());
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('stays inert with no handler, so a hold cannot swallow the tap that follows', () => {
    // MailRow is exported and rendered without onLongPress in other contexts.
    // Arming the timer anyway marked a press as "fired" and consumeClick then
    // ate the click — the row silently stopped opening after a long press.
    const { result } = renderHook(() => useLongPress(undefined));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(result.current.consumeClick()).toBe(false);
  });

  it('drops a pending timer on unmount instead of firing into a dead component', () => {
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    unmount();
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

    expect(onLongPress).not.toHaveBeenCalled();
  });
});
