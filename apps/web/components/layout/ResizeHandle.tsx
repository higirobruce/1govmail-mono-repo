'use client';

import { cn } from '@/lib/utils';
import type { ResizeEdge, UseResizable } from '@/hooks/useResizable';

/**
 * Thin drag strip on a panel edge. Absolutely positioned, so the panel it
 * belongs to must be `relative`. Desktop-only (panels stack/overlay on mobile).
 * Double-click resets the panel to its default width.
 */
export function ResizeHandle({
  edge,
  resizable,
  label,
  className,
}: {
  edge: ResizeEdge;
  resizable: UseResizable;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={resizable.width}
      tabIndex={0}
      onPointerDown={resizable.onPointerDown}
      onKeyDown={resizable.onKeyDown}
      onDoubleClick={resizable.reset}
      title="Drag to resize · double-click to reset"
      className={cn(
        'group hidden md:block absolute inset-y-0 z-20 w-2 cursor-col-resize select-none touch-none outline-none',
        edge === 'right' ? '-right-1' : '-left-1',
        className,
      )}
    >
      {/* visible hairline, thickens on hover / focus / drag */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent transition-colors',
          'group-hover:bg-primary/40 group-focus-visible:bg-primary/60',
          resizable.dragging && 'bg-primary/60',
        )}
      />
    </div>
  );
}
