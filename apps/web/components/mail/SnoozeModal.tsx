'use client';

import { useState } from 'react';
import { X, Clock, AlarmClock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SnoozeOption {
  label: string;
  sublabel: string;
  getDate: () => Date;
}

function getSnoozeOptions(): SnoozeOption[] {
  const now = new Date();
  const today = new Date(now);

  // "Later today" = 3 hours from now, capped at 6 PM
  const laterToday = new Date(now);
  laterToday.setHours(Math.min(laterToday.getHours() + 3, 18), 0, 0, 0);

  // "Tonight" = today at 9 PM
  const tonight = new Date(today);
  tonight.setHours(21, 0, 0, 0);

  // "Tomorrow morning" = tomorrow at 8 AM
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);

  // "Next week" = next Monday at 8 AM
  const nextMonday = new Date(today);
  const daysUntilMonday = (8 - nextMonday.getDay()) % 7 || 7;
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(8, 0, 0, 0);

  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return [
    { label: 'Later today', sublabel: fmt(laterToday), getDate: () => laterToday },
    { label: 'Tonight', sublabel: fmt(tonight), getDate: () => tonight },
    { label: 'Tomorrow morning', sublabel: fmt(tomorrow), getDate: () => tomorrow },
    { label: 'Next week', sublabel: fmt(nextMonday), getDate: () => nextMonday },
  ];
}

interface SnoozeModalProps {
  open: boolean;
  onClose: () => void;
  onSnooze: (until: Date) => void;
}

export default function SnoozeModal({ open, onClose, onSnooze }: SnoozeModalProps) {
  const [customDate, setCustomDate] = useState('');
  const [customTime, setCustomTime] = useState('08:00');

  if (!open) return null;

  const options = getSnoozeOptions();

  const handleCustom = () => {
    if (!customDate) return;
    const [h, m] = customTime.split(':').map(Number);
    const d = new Date(customDate);
    d.setHours(h, m, 0, 0);
    if (d > new Date()) {
      onSnooze(d);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative bg-card border border-border/50 rounded-2xl shadow-2xl w-[340px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/30">
          <div className="flex items-center gap-2">
            <AlarmClock className="w-4 h-4 text-primary" />
            <span className="text-[14px] font-semibold text-foreground">Snooze until…</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Preset options */}
        <div className="p-2 space-y-0.5">
          {options.map((opt) => (
            <button
              key={opt.label}
              onClick={() => { onSnooze(opt.getDate()); onClose(); }}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-muted/50 transition-colors group text-left"
            >
              <div className="flex items-center gap-3">
                <Clock className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0" />
                <span className="text-[13px] font-medium text-foreground">{opt.label}</span>
              </div>
              <span className="text-[11px] text-muted-foreground/50 shrink-0">{opt.sublabel}</span>
            </button>
          ))}
        </div>

        {/* Custom date/time */}
        <div className="px-4 pb-4 pt-1 border-t border-border/20 mt-1">
          <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-2">Custom time</p>
          <div className="flex gap-2 items-center">
            <input
              type="date"
              value={customDate}
              min={new Date().toISOString().split('T')[0]}
              onChange={(e) => setCustomDate(e.target.value)}
              className="flex-1 h-8 text-[12px] bg-muted/30 border border-border/50 rounded-lg px-2 text-foreground focus:outline-none focus:border-primary/50"
            />
            <input
              type="time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              className="w-20 h-8 text-[12px] bg-muted/30 border border-border/50 rounded-lg px-2 text-foreground focus:outline-none focus:border-primary/50"
            />
            <button
              onClick={handleCustom}
              disabled={!customDate}
              className={cn(
                'h-8 px-3 rounded-lg text-[12px] font-medium transition-colors',
                customDate
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
            >
              Set
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
