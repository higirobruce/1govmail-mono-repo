'use client';

import { useCallback, useRef, useState } from 'react';
import { useUIStore } from '@/stores/ui.store';

/** Which edge of the panel the drag handle sits on. */
export type ResizeEdge = 'left' | 'right';

export function clampWidth(width: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(width)));
}

/**
 * New panel width given a horizontal drag delta. For a right-edge handle,
 * dragging right (+dx) widens the panel; for a left-edge handle (panel sits to
 * the right of the handle), dragging right (+dx) narrows it. Result is clamped.
 */
export function nextWidth(
  startWidth: number,
  dx: number,
  edge: ResizeEdge,
  min: number,
  max: number,
): number {
  const raw = edge === 'right' ? startWidth + dx : startWidth - dx;
  return clampWidth(raw, min, max);
}

export interface UseResizable {
  /** Current width in px, always clamped to [min, max]. */
  width: number;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  reset: () => void;
}

/**
 * Drag-to-resize a panel. Width is stored in the persisted ui store under
 * `key`, so it survives reloads and stays consistent across pages that share
 * the same panel (e.g. the sidebar on /mail and /calendar). Falls back to
 * `defaultWidth` when nothing is stored.
 */
export function useResizable(opts: {
  key: string;
  defaultWidth: number;
  min: number;
  max: number;
  edge: ResizeEdge;
}): UseResizable {
  const { key, defaultWidth, min, max, edge } = opts;
  const stored = useUIStore((s) => s.panelWidths[key]);
  const setPanelWidth = useUIStore((s) => s.setPanelWidth);
  const resetPanelWidth = useUIStore((s) => s.resetPanelWidth);
  const width = clampWidth(stored ?? defaultWidth, min, max);
  const [dragging, setDragging] = useState(false);
  const rafRef = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      setDragging(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const move = (ev: PointerEvent) => {
        // rAF-throttle: coalesce a burst of pointermove events into one
        // width update per frame so dragging stays smooth.
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          setPanelWidth(key, nextWidth(startWidth, ev.clientX - startX, edge, min, max));
        });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [width, key, edge, min, max, setPanelWidth],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 16;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPanelWidth(key, nextWidth(width, step, edge, min, max));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPanelWidth(key, nextWidth(width, -step, edge, min, max));
      }
    },
    [width, key, edge, min, max, setPanelWidth],
  );

  const reset = useCallback(() => resetPanelWidth(key), [key, resetPanelWidth]);

  return { width, dragging, onPointerDown, onKeyDown, reset };
}
