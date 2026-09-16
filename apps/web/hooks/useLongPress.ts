'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Touch-hold as a stand-in for right-click.
 *
 * Touch devices never fire `contextmenu`, so any action that lives only in a
 * context menu is unreachable on a phone. A hold opens the same menu — which
 * means telling a deliberate hold apart from a tap and, more importantly, from
 * the first moments of a scroll.
 */

/** Hold duration before the menu opens. Matches the platform convention
 *  (iOS ~500ms); shorter starts firing during flick-scrolls. */
export const LONG_PRESS_MS = 500;

/** Finger travel that reclassifies the gesture as a scroll. Fingers always
 *  drift a pixel or two during a real hold, so this cannot be 0. */
export const LONG_PRESS_SLOP_PX = 10;

interface TouchLike {
  touches: ArrayLike<{ clientX: number; clientY: number }>;
}

export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  // Set when a press fires, so the click the browser synthesises after the
  // finger lifts can be swallowed — otherwise a hold opens the menu AND the
  // thread behind it.
  const fired = useRef(false);
  // Held in a ref so the handlers below stay stable across renders while the
  // pending timer still fires the latest callback. Synced in an effect, not
  // during render — callers pass an inline arrow, so this reassigns every
  // render, and a render-phase ref write is not safe under concurrent React.
  const callback = useRef(onLongPress);
  useEffect(() => { callback.current = onLongPress; }, [onLongPress]);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  // A pending timer outliving the component would fire a menu open against
  // unmounted state (React warns, and the coordinates are meaningless).
  useEffect(() => cancel, [cancel]);

  const onTouchStart = useCallback((e: TouchLike) => {
    const t = e.touches?.[0];
    if (!t) return;
    const { clientX: x, clientY: y } = t;
    origin.current = { x, y };
    fired.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fired.current = true;
      callback.current(x, y);
    }, LONG_PRESS_MS);
  }, []);

  const onTouchMove = useCallback((e: TouchLike) => {
    const t = e.touches?.[0];
    const start = origin.current;
    if (!t || !start) return;
    const travelled =
      Math.abs(t.clientX - start.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(t.clientY - start.y) > LONG_PRESS_SLOP_PX;
    if (travelled) cancel();
  }, [cancel]);

  /** True exactly once after a press fired: the row calls this from its click
   *  handler and skips opening when it returns true. */
  const consumeClick = useCallback(() => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  }, []);

  return {
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: cancel,
      onTouchCancel: cancel,
    },
    consumeClick,
  };
}
