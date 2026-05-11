'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Palette, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const COVER_OPTIONS = [
  { id: 'slate',  label: 'Slate',   cls: 'bg-slate-500',   value: 'slate'  },
  { id: 'blue',   label: 'Blue',    cls: 'bg-blue-600',    value: 'blue'   },
  { id: 'indigo', label: 'Indigo',  cls: 'bg-indigo-600',  value: 'indigo' },
  { id: 'violet', label: 'Violet',  cls: 'bg-violet-600',  value: 'violet' },
  { id: 'green',  label: 'Green',   cls: 'bg-green-600',   value: 'green'  },
  { id: 'teal',   label: 'Teal',    cls: 'bg-teal-600',    value: 'teal'   },
  { id: 'amber',  label: 'Amber',   cls: 'bg-amber-500',   value: 'amber'  },
  { id: 'red',    label: 'Red',     cls: 'bg-red-600',     value: 'red'    },
] as const;

export type CoverColorValue = typeof COVER_OPTIONS[number]['value'];

export function getCoverClass(color: string | null): string {
  return COVER_OPTIONS.find((c) => c.value === color)?.cls ?? '';
}

interface DocCoverPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
}

export function DocCoverPicker({ value, onChange }: DocCoverPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground h-7 px-2">
          <Palette className="w-3.5 h-3.5" />
          Cover
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-3" align="end">
        <p className="text-xs font-medium mb-2.5 text-muted-foreground">Cover color</p>
        <div className="grid grid-cols-4 gap-1.5">
          {COVER_OPTIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              title={c.label}
              onClick={() => { onChange(c.value); setOpen(false); }}
              className={cn(
                'w-9 h-9 rounded-md border-2 transition-all',
                c.cls,
                value === c.value ? 'border-foreground scale-110 shadow-sm' : 'border-transparent hover:scale-105',
              )}
            />
          ))}
        </div>
        {value && (
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground w-full"
          >
            <X className="w-3 h-3" />
            Remove cover
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
