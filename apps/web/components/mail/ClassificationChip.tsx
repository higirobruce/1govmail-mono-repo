'use client';

import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getClassification, pickHighestClassification } from '@/lib/classification';

export interface ClassificationChipProps {
  /** Single label, or null/undefined to render nothing. */
  value?: string | null;
  /** Or pass the message tags array — the highest-severity classification is rendered. */
  tags?: readonly string[] | null;
  size?: 'xs' | 'sm';
  /** Show a lock icon for Restricted/Confidential. */
  withIcon?: boolean;
  className?: string;
}

export function ClassificationChip({ value, tags, size = 'xs', withIcon = false, className }: ClassificationChipProps) {
  const def = value ? getClassification(value) : pickHighestClassification(tags);
  if (!def) return null;

  const sizeCls = size === 'sm'
    ? 'text-[11px] px-2 py-0.5'
    : 'text-[10px] px-1.5 py-0.5';

  const showLock = withIcon && def.severity >= 2;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium leading-none',
        def.cls,
        sizeCls,
        className,
      )}
    >
      {showLock && <Lock className="w-2.5 h-2.5" />}
      {def.label}
    </span>
  );
}
