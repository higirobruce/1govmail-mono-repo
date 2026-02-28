'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  ChevronLeft, ChevronRight, Plus, X, Loader2,
  Clock, MapPin, Calendar as CalendarIcon, Trash2, Users,
  Video, Repeat, ExternalLink,
} from 'lucide-react';
import {
  format, startOfMonth, endOfMonth,
  startOfWeek, endOfWeek, eachDayOfInterval,
  isSameMonth, isSameDay, isToday,
  addDays, addWeeks, addMonths, addYears,
  subDays, subWeeks, subMonths, subYears,
  startOfDay, endOfDay, startOfYear, endOfYear,
  parseISO, differenceInMinutes,
  getHours, getMinutes,
} from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// ── Types ──────────────────────────────────────────────────────────────────────

interface CalEvent {
  id: string;
  zimbraId: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  isRecurring: boolean;
  organizer: string | null;
  attendees: Array<{ email: string; name?: string }>;
}

type CalView = 'day' | 'workweek' | 'week' | 'month' | 'year';

interface FreeBusyData {
  email: string;
  busy:        Array<{ s: number; e: number }>;
  tentative:   Array<{ s: number; e: number }>;
  unavailable: Array<{ s: number; e: number }>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SLOT_H = 60; // px per hour in timeline views
const DAY_HOURS = 24;

const EVENT_COLORS = [
  'bg-blue-500/80 text-white',
  'bg-emerald-500/80 text-white',
  'bg-violet-500/80 text-white',
  'bg-amber-500/80 text-white',
  'bg-rose-500/80 text-white',
  'bg-cyan-500/80 text-white',
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function eventColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return EVENT_COLORS[Math.abs(h) % EVENT_COLORS.length];
}

function fmtTime(iso: string): string {
  try { return format(parseISO(iso), 'h:mm a'); }
  catch { return ''; }
}

function fmtDate(iso: string): string {
  try { return format(parseISO(iso), 'EEE, MMM d, yyyy'); }
  catch { return ''; }
}

/** Return start/end Date range for a given view anchored to a date. */
function viewRange(date: Date, view: CalView): { start: Date; end: Date } {
  switch (view) {
    case 'day':
      return { start: startOfDay(date), end: endOfDay(date) };
    case 'workweek': {
      const mon = startOfWeek(date, { weekStartsOn: 1 });
      return { start: startOfDay(mon), end: endOfDay(addDays(mon, 4)) };
    }
    case 'week': {
      const mon = startOfWeek(date, { weekStartsOn: 1 });
      return { start: startOfDay(mon), end: endOfDay(addDays(mon, 6)) };
    }
    case 'month':
      return { start: startOfMonth(date), end: endOfMonth(date) };
    case 'year':
      return { start: startOfYear(date), end: endOfYear(date) };
  }
}

/** Navigate anchor date forward/back by one unit appropriate to the view. */
function navigate(date: Date, view: CalView, dir: 1 | -1): Date {
  switch (view) {
    case 'day':      return dir > 0 ? addDays(date, 1)   : subDays(date, 1);
    case 'workweek':
    case 'week':     return dir > 0 ? addWeeks(date, 1)  : subWeeks(date, 1);
    case 'month':    return dir > 0 ? addMonths(date, 1) : subMonths(date, 1);
    case 'year':     return dir > 0 ? addYears(date, 1)  : subYears(date, 1);
  }
}

/** Human-readable header for the current view. */
function viewLabel(date: Date, view: CalView): string {
  switch (view) {
    case 'day':      return format(date, 'EEEE, MMMM d, yyyy');
    case 'workweek': {
      const mon = startOfWeek(date, { weekStartsOn: 1 });
      const fri = addDays(mon, 4);
      return `${format(mon, 'MMM d')} – ${format(fri, 'MMM d, yyyy')}`;
    }
    case 'week': {
      const mon = startOfWeek(date, { weekStartsOn: 1 });
      const sun = addDays(mon, 6);
      return `${format(mon, 'MMM d')} – ${format(sun, 'MMM d, yyyy')}`;
    }
    case 'month':    return format(date, 'MMMM yyyy');
    case 'year':     return format(date, 'yyyy');
  }
}

// ── Create-event modal ─────────────────────────────────────────────────────────

function CreateEventModal({
  initialDate,
  onClose,
  onCreated,
}: {
  initialDate?: Date;
  onClose: () => void;
  onCreated: (event: CalEvent) => void;
}) {
  const base    = initialDate ?? new Date();
  const todayStr = format(base, "yyyy-MM-dd'T'HH:mm");
  const endStr   = format(new Date(base.getTime() + 3_600_000), "yyyy-MM-dd'T'HH:mm");

  const [title, setTitle]       = useState('');
  const [location, setLocation] = useState('');
  const [description, setDesc]  = useState('');
  const [startAt, setStart]     = useState(todayStr);
  const [endAt, setEnd]         = useState(endStr);
  const [allDay, setAllDay]     = useState(false);
  const [saving, setSaving]     = useState(false);

  const handleSave = async () => {
    if (!title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      const startIso = allDay
        ? new Date(startAt.split('T')[0] + 'T00:00:00.000Z').toISOString()
        : new Date(startAt).toISOString();
      const endIso = allDay
        ? new Date(endAt.split('T')[0] + 'T23:59:59.000Z').toISOString()
        : new Date(endAt).toISOString();

      const event = await api.calendar.createEvent({
        title: title.trim(),
        location: location.trim() || undefined,
        description: description.trim() || undefined,
        startAt: startIso,
        endAt: endIso,
        allDay,
      }) as CalEvent;

      toast.success('Event created');
      onCreated(event);
    } catch (err: any) {
      toast.error('Failed to create event', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border/60 rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
          <h2 className="text-sm font-semibold text-foreground">New Event</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event title"
            className="text-base font-medium h-10 bg-transparent border-0 border-b border-border/50 rounded-none px-0 focus-visible:ring-0 focus-visible:border-primary/60"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />
          <div className="flex items-center gap-2">
            <input id="allday" type="checkbox" checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)} className="rounded" />
            <Label htmlFor="allday" className="text-sm text-muted-foreground/70 cursor-pointer">All day</Label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">Start</Label>
              <Input type={allDay ? 'date' : 'datetime-local'}
                value={allDay ? startAt.split('T')[0] : startAt}
                onChange={(e) => setStart(e.target.value)}
                className="h-8 text-xs bg-muted/30 border-border/50" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">End</Label>
              <Input type={allDay ? 'date' : 'datetime-local'}
                value={allDay ? endAt.split('T')[0] : endAt}
                onChange={(e) => setEnd(e.target.value)}
                className="h-8 text-xs bg-muted/30 border-border/50" />
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">Location</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="Add location" className="h-8 text-sm bg-muted/30 border-border/50" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">Description</Label>
            <Input value={description} onChange={(e) => setDesc(e.target.value)}
              placeholder="Add description" className="h-8 text-sm bg-muted/30 border-border/50" />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border/40">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground/60 h-8">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-4 gap-1.5">
            {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : 'Create Event'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Month view ─────────────────────────────────────────────────────────────────

function MonthView({
  currentDate,
  events,
  onSelectEvent,
  onCreateForDay,
}: {
  currentDate: Date;
  events: CalEvent[];
  onSelectEvent: (e: CalEvent) => void;
  onCreateForDay: (d: Date) => void;
}) {
  const gridDays = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 }),
    end:   endOfWeek(endOfMonth(currentDate),    { weekStartsOn: 1 }),
  });
  const eventsForDay = (day: Date) =>
    events.filter((e) => { try { return isSameDay(parseISO(e.startAt), day); } catch { return false; } });

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 border-b border-border/30 shrink-0">
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d) => (
          <div key={d} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
            {d}
          </div>
        ))}
      </div>
      <div className="flex-1 grid grid-cols-7 auto-rows-fr overflow-auto">
        {gridDays.map((day) => {
          const dayEvs = eventsForDay(day);
          const inMonth = isSameMonth(day, currentDate);
          const today   = isToday(day);
          return (
            <div key={day.toISOString()}
              className={cn('border-b border-r border-border/20 p-1.5 min-h-[90px] overflow-hidden group', !inMonth && 'opacity-35')}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={cn('text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full',
                  today ? 'bg-primary text-primary-foreground' : 'text-muted-foreground/70')}>
                  {format(day, 'd')}
                </span>
                <button onClick={() => onCreateForDay(day)}
                  className="w-5 h-5 rounded text-muted-foreground/30 hover:text-primary hover:bg-primary/10 flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
                  title={`Add event on ${format(day, 'MMM d')}`}>
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-0.5">
                {dayEvs.slice(0, 3).map((ev) => (
                  <button key={ev.id} onClick={() => onSelectEvent(ev)}
                    className={cn('w-full text-left px-1.5 py-0.5 rounded text-[11px] font-medium truncate transition-opacity hover:opacity-80', eventColor(ev.id))}>
                    {ev.allDay ? ev.title : `${fmtTime(ev.startAt)} ${ev.title}`}
                  </button>
                ))}
                {dayEvs.length > 3 && (
                  <p className="text-[10px] text-muted-foreground/50 px-1">+{dayEvs.length - 3} more</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Year view ──────────────────────────────────────────────────────────────────

function YearView({
  currentDate,
  events,
  onMonthClick,
}: {
  currentDate: Date;
  events: CalEvent[];
  onMonthClick: (month: Date) => void;
}) {
  const year = currentDate.getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => new Date(year, i, 1));
  const eventDays = new Set(events.map((e) => {
    try { return format(parseISO(e.startAt), 'yyyy-MM-dd'); }
    catch { return ''; }
  }));

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="grid grid-cols-4 gap-4 p-6">
        {months.map((month) => {
          const mDays = eachDayOfInterval({
            start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
            end:   endOfWeek(endOfMonth(month),    { weekStartsOn: 1 }),
          });
          return (
            <div key={month.toISOString()} className="bg-card/50 border border-border/30 rounded-lg p-3 hover:border-primary/30 transition-colors">
              <button onClick={() => onMonthClick(month)}
                className="text-[13px] font-semibold text-foreground mb-2 hover:text-primary transition-colors w-full text-left">
                {format(month, 'MMMM')}
              </button>
              {/* Mini grid */}
              <div className="grid grid-cols-7 gap-px">
                {['M','T','W','T','F','S','S'].map((d, i) => (
                  <div key={i} className="text-[9px] text-center text-muted-foreground/40 font-medium pb-0.5">{d}</div>
                ))}
                {mDays.map((day) => {
                  const inM    = isSameMonth(day, month);
                  const today  = isToday(day);
                  const hasEv  = eventDays.has(format(day, 'yyyy-MM-dd'));
                  return (
                    <div key={day.toISOString()}
                      className={cn('relative text-[10px] text-center h-5 flex items-center justify-center rounded-full',
                        !inM && 'opacity-25',
                        today && 'bg-primary text-primary-foreground font-bold',
                        !today && inM && 'text-muted-foreground/70',
                      )}>
                      {format(day, 'd')}
                      {hasEv && inM && !today && (
                        <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary/60" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ── Timeline view (day / work-week / week) ─────────────────────────────────────

function TimelineView({
  days,
  events,
  freeBusy,
  onSelectEvent,
  onCreateForDay,
}: {
  days: Date[];
  events: CalEvent[];
  freeBusy?: FreeBusyData | null;
  onSelectEvent: (e: CalEvent) => void;
  onCreateForDay: (d: Date) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to 7 AM on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 7 * SLOT_H;
    }
  }, []);

  const totalH = DAY_HOURS * SLOT_H;

  /** All-day events for a specific day */
  const allDayFor = (day: Date) =>
    events.filter((e) => {
      if (!e.allDay) return false;
      try { return isSameDay(parseISO(e.startAt), day); } catch { return false; }
    });

  /** Timed events for a specific day */
  const timedFor = (day: Date) =>
    events.filter((e) => {
      if (e.allDay) return false;
      try { return isSameDay(parseISO(e.startAt), day); } catch { return false; }
    });

  /** Free/busy blocks for a specific day */
  const fbBlocksFor = (day: Date, type: 'busy' | 'tentative' | 'unavailable') => {
    if (!freeBusy) return [];
    const arr = freeBusy[type];
    return arr.filter((b) => isSameDay(new Date(b.s), day));
  };

  const eventTop = (isoStart: string) => {
    try {
      const d = parseISO(isoStart);
      return (getHours(d) + getMinutes(d) / 60) * SLOT_H;
    } catch { return 0; }
  };
  const eventHeight = (isoStart: string, isoEnd: string) => {
    try {
      const mins = differenceInMinutes(parseISO(isoEnd), parseISO(isoStart));
      return Math.max(20, (mins / 60) * SLOT_H);
    } catch { return SLOT_H; }
  };

  const nowTop = (() => {
    const now = new Date();
    return (getHours(now) + getMinutes(now) / 60) * SLOT_H;
  })();
  const todayIdx = days.findIndex((d) => isToday(d));

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Column headers */}
      <div className="flex shrink-0 border-b border-border/30">
        <div className="w-14 shrink-0" /> {/* spacer for hour labels */}
        {days.map((day) => (
          <div key={day.toISOString()} className={cn(
            'flex-1 min-w-0 text-center py-2 border-l border-border/20',
            isToday(day) && 'bg-primary/5',
          )}>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold">
              {format(day, 'EEE')}
            </span>
            <div className={cn('text-sm font-semibold mx-auto mt-0.5 w-7 h-7 flex items-center justify-center rounded-full',
              isToday(day) ? 'bg-primary text-primary-foreground' : 'text-foreground/80')}>
              {format(day, 'd')}
            </div>
            {/* All-day events */}
            {allDayFor(day).length > 0 && (
              <div className="px-1 mt-1 space-y-0.5">
                {allDayFor(day).map((ev) => (
                  <button key={ev.id} onClick={() => onSelectEvent(ev)}
                    className={cn('w-full text-left px-1.5 py-0.5 rounded text-[10px] font-medium truncate', eventColor(ev.id))}>
                    {ev.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="flex" style={{ height: totalH }}>
          {/* Hour labels */}
          <div className="w-14 shrink-0 relative">
            {Array.from({ length: DAY_HOURS }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted-foreground/40 -translate-y-1/2"
                style={{ top: h * SLOT_H }}>
                {h === 0 ? '' : format(new Date(2000, 0, 1, h), 'ha').toLowerCase()}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, colIdx) => (
            <div key={day.toISOString()}
              className={cn('flex-1 min-w-0 relative border-l border-border/15', isToday(day) && 'bg-primary/[0.02]')}
              onClick={() => onCreateForDay(day)}>
              {/* Hour slot lines */}
              {Array.from({ length: DAY_HOURS }, (_, h) => (
                <div key={h} className="absolute left-0 right-0 border-t border-border/15"
                  style={{ top: h * SLOT_H }} />
              ))}

              {/* Free/busy overlay — busy = red, tentative = amber */}
              {freeBusy && (
                <>
                  {fbBlocksFor(day, 'busy').map((b, i) => {
                    const top = ((new Date(b.s).getHours() + new Date(b.s).getMinutes() / 60)) * SLOT_H;
                    const h   = Math.max(4, (b.e - b.s) / 3_600_000 * SLOT_H);
                    const label = `${format(new Date(b.s), 'HH:mm')} – ${format(new Date(b.e), 'HH:mm')}`;
                    return (
                      <Tooltip key={`b${i}`}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute left-0 right-0 bg-rose-500/15 border-l-2 border-rose-500/50 cursor-default z-[5]"
                            style={{ top, height: h }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4} className="bg-background text-foreground border border-border/40 shadow-sm text-xs">
                          <p className="font-semibold text-rose-500">Busy</p>
                          <p className="text-muted-foreground">{label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                  {fbBlocksFor(day, 'tentative').map((b, i) => {
                    const top = ((new Date(b.s).getHours() + new Date(b.s).getMinutes() / 60)) * SLOT_H;
                    const h   = Math.max(4, (b.e - b.s) / 3_600_000 * SLOT_H);
                    const label = `${format(new Date(b.s), 'HH:mm')} – ${format(new Date(b.e), 'HH:mm')}`;
                    return (
                      <Tooltip key={`t${i}`}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute left-0 right-0 bg-amber-400/15 border-l-2 border-amber-400/50 cursor-default z-[5]"
                            style={{ top, height: h }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4} className="bg-background text-foreground border border-border/40 shadow-sm text-xs">
                          <p className="font-semibold text-amber-500">Tentative</p>
                          <p className="text-muted-foreground">{label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </>
              )}

              {/* Timed events */}
              {timedFor(day).map((ev) => {
                const top = eventTop(ev.startAt);
                const h   = eventHeight(ev.startAt, ev.endAt);
                return (
                  <button key={ev.id} onClick={(e) => { e.stopPropagation(); onSelectEvent(ev); }}
                    className={cn('absolute left-0.5 right-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-left overflow-hidden transition-opacity hover:opacity-80 z-10', eventColor(ev.id))}
                    style={{ top, height: h }}>
                    <span className="block truncate leading-tight">{ev.title}</span>
                    {h > 28 && <span className="block text-[10px] opacity-75 leading-tight truncate">{fmtTime(ev.startAt)}</span>}
                  </button>
                );
              })}

              {/* Current-time indicator */}
              {colIdx === todayIdx && (
                <div className="absolute left-0 right-0 flex items-center pointer-events-none z-20"
                  style={{ top: nowTop }}>
                  <div className="w-2 h-2 rounded-full bg-rose-500 -ml-1 shrink-0" />
                  <div className="h-px flex-1 bg-rose-500" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Availability panel ─────────────────────────────────────────────────────────

function AvailabilityPanel({
  viewStart,
  viewEnd,
  freeBusy,
  loading,
  onSearch,
  onClose,
}: {
  viewStart: Date;
  viewEnd: Date;
  freeBusy: FreeBusyData | null;
  loading: boolean;
  onSearch: (email: string) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(freeBusy?.email ?? '');
  const [suggestions, setSuggestions] = useState<Array<{ email: string; display: string }>>([]);
  const [loadingSug, setLoadingSug] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Autocomplete suggestions; clear parent free/busy when field is emptied
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (email.trim().length === 0) { setSuggestions([]); onSearch(''); return; }
    if (email.trim().length < 2) { setSuggestions([]); return; }
    setLoadingSug(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.contacts.autocomplete(email.trim());
        setSuggestions(res.filter((r) => r.email !== email));
      } catch { setSuggestions([]); }
      finally { setLoadingSug(false); }
    }, 300);
  }, [email]); // eslint-disable-line


  return (
    <div className="w-72 shrink-0 border-l border-border/40 flex flex-col h-full bg-card/60">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-sm font-semibold text-foreground">Availability</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0 text-muted-foreground/50">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="px-4 pt-3 pb-2 border-b border-border/30 space-y-2">
        <div className="relative">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setSuggestions([]); onSearch(email.trim()); } }}
            placeholder="Search user email…"
            className="h-8 text-xs bg-muted/30 border-border/50 pr-16"
          />
          <Button size="sm" onClick={() => { setSuggestions([]); onSearch(email.trim()); }}
            disabled={loading || !email.trim()}
            className="absolute right-1 top-1 h-6 px-2 text-xs bg-primary/90 hover:bg-primary text-primary-foreground">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Check'}
          </Button>
          {/* Suggestions dropdown */}
          {(loadingSug || suggestions.length > 0) && (
            <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden">
              {loadingSug ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/50">
                  <Loader2 className="w-3 h-3 animate-spin" /> Searching…
                </div>
              ) : (
                <ul className="max-h-40 overflow-y-auto py-1">
                  {suggestions.map((s) => (
                    <li key={s.email}>
                      <button type="button"
                        onMouseDown={() => { setEmail(s.email); setSuggestions([]); onSearch(s.email); }}
                        className="w-full text-left px-3 py-2 hover:bg-muted/60 flex flex-col gap-0.5">
                        <span className="text-xs font-medium truncate">{s.display !== s.email ? s.display : ''}</span>
                        <span className="text-xs text-muted-foreground/60 truncate">{s.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/40">
          {format(viewStart, 'MMM d')} – {format(viewEnd, 'MMM d, yyyy')}
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {!freeBusy ? (
          <div className="flex flex-col items-center justify-center h-full py-12 text-center gap-2">
            <Users className="w-8 h-8 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground/40">Search a colleague's email to see their availability</p>
          </div>
        ) : (
          <div className="px-4 py-4 space-y-4">
            <p className="text-xs font-medium text-foreground/80 truncate">{freeBusy.email}</p>

            {/* Legend */}
            <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground/60">
              <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-rose-500/60 inline-block" /> Busy</div>
              <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400/60 inline-block" /> Tentative</div>
              <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-500/40 inline-block" /> Unavailable</div>
            </div>

            {/* One row per day in range */}
            {eachDayOfInterval({ start: viewStart, end: viewEnd }).map((day) => {
              const dayStart = startOfDay(day).getTime();
              const dayEnd   = endOfDay(day).getTime();
              const dayDur   = dayEnd - dayStart;
              const blocksIn = (arr: Array<{ s: number; e: number }>) =>
                arr.filter((b) => b.e > dayStart && b.s < dayEnd).map((b) => ({
                  left:  ((Math.max(b.s, dayStart) - dayStart) / dayDur) * 100,
                  width: ((Math.min(b.e, dayEnd) - Math.max(b.s, dayStart)) / dayDur) * 100,
                  label: `${format(new Date(b.s), 'HH:mm')} – ${format(new Date(b.e), 'HH:mm')}`,
                }));

              const busyBlocks = blocksIn(freeBusy.busy);
              const tentBlocks = blocksIn(freeBusy.tentative);
              const unavBlocks = blocksIn(freeBusy.unavailable);
              const hasData    = busyBlocks.length + tentBlocks.length + unavBlocks.length > 0;

              return (
                <div key={day.toISOString()} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className={cn('text-[11px] font-medium', isToday(day) ? 'text-primary' : 'text-muted-foreground/70')}>
                      {format(day, 'EEE, MMM d')}
                    </span>
                    {!hasData && <span className="text-[10px] text-emerald-500/70">Free</span>}
                  </div>
                  {/* Timeline bar — overflow-visible so tooltips aren't clipped */}
                  <div className="relative h-5 bg-emerald-500/10 rounded border border-border/20">
                    {busyBlocks.map((b, i) => (
                      <Tooltip key={`b${i}`}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute h-full bg-rose-500/50 hover:bg-rose-500/70 rounded-sm cursor-default transition-colors"
                            style={{ left: `${b.left}%`, width: `${Math.max(0.5, b.width)}%` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4} className="bg-background text-foreground border border-border/40 shadow-sm text-xs">
                          <p className="font-semibold text-rose-500">Busy</p>
                          <p className="text-muted-foreground">{b.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                    {tentBlocks.map((b, i) => (
                      <Tooltip key={`t${i}`}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute h-full bg-amber-400/50 hover:bg-amber-400/70 rounded-sm cursor-default transition-colors"
                            style={{ left: `${b.left}%`, width: `${Math.max(0.5, b.width)}%` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4} className="bg-background text-foreground border border-border/40 shadow-sm text-xs">
                          <p className="font-semibold text-amber-500">Tentative</p>
                          <p className="text-muted-foreground">{b.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                    {unavBlocks.map((b, i) => (
                      <Tooltip key={`u${i}`}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute h-full bg-slate-500/40 hover:bg-slate-500/60 rounded-sm cursor-default transition-colors"
                            style={{ left: `${b.left}%`, width: `${Math.max(0.5, b.width)}%` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4} className="bg-background text-foreground border border-border/40 shadow-sm text-xs">
                          <p className="font-semibold text-slate-500">Unavailable</p>
                          <p className="text-muted-foreground">{b.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── Event detail panel ─────────────────────────────────────────────────────────

// Detect if a string is a URL (for linkifying text)
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  const links = text.match(URL_RE) ?? [];
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {links[i] && (
            <a
              href={links[i]}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline break-all hover:text-primary/80"
              onClick={(e) => e.stopPropagation()}
            >
              {links[i]}
            </a>
          )}
        </span>
      ))}
    </>
  );
}

function isOnlineMeetingLink(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\/([\w-]+\.)?(zoom\.us|teams\.microsoft\.com|meet\.google\.com|webex\.com|whereby\.com|gotomeeting\.com|bluejeans\.com)/i.test(url);
}

function EventDetailPanel({
  event,
  onClose,
  onDelete,
  deleting,
}: {
  event: CalEvent;
  onClose: () => void;
  onDelete: (e: CalEvent) => void;
  deleting: boolean;
}) {
  const meetingLink = isOnlineMeetingLink(event.location) ? event.location : null;

  return (
    <div className="w-80 shrink-0 border-l border-border/40 flex flex-col h-full bg-card/60 overflow-x-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border/40 shrink-0">
        <h3 className="text-sm font-semibold text-foreground break-words min-w-0 leading-snug">{event.title}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0 text-muted-foreground/50 shrink-0 mt-0.5">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4 overflow-x-hidden">

          {/* Badges row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium gap-1.5', eventColor(event.id))}>
              <CalendarIcon className="w-3 h-3" />
              {event.allDay ? 'All day' : 'Event'}
            </div>
            {event.isRecurring && (
              <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium text-muted-foreground/60 bg-muted/40 border border-border/30">
                <Repeat className="w-3 h-3" />
                Recurring
              </div>
            )}
          </div>

          {/* Join meeting button — shown when location is a video conferencing URL */}
          {meetingLink && (
            <a
              href={meetingLink}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
            >
              <Video className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1">Join meeting</span>
              <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
            </a>
          )}

          {/* Date / time */}
          <div className="space-y-1.5">
            <div className="flex items-start gap-2 text-sm text-foreground/80">
              <Clock className="w-3.5 h-3.5 text-muted-foreground/40 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="break-words">{fmtDate(event.startAt)}</p>
                {!event.allDay && (
                  <p className="text-muted-foreground/60 text-xs mt-0.5">
                    {fmtTime(event.startAt)} – {fmtTime(event.endAt)}
                  </p>
                )}
              </div>
            </div>

            {/* Location */}
            {event.location && (
              <div className="flex items-start gap-2 text-sm text-foreground/80">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground/40 mt-0.5 shrink-0" />
                <span className="break-words min-w-0 text-sm leading-relaxed">
                  <Linkified text={event.location} />
                </span>
              </div>
            )}
          </div>

          {/* Description */}
          {event.description && (
            <div className="text-sm text-foreground/70 leading-relaxed break-words overflow-x-hidden">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium mb-1">Description</p>
              <Linkified text={event.description} />
            </div>
          )}

          {/* Organizer */}
          {event.organizer && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium mb-1">Organizer</p>
              <p className="text-xs text-foreground/70 break-all">{event.organizer}</p>
            </div>
          )}

          {/* Attendees */}
          {event.attendees.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium mb-2">
                Attendees ({event.attendees.length})
              </p>
              <div className="space-y-2">
                {event.attendees.map((a) => (
                  <div key={a.email} className="flex items-start gap-2">
                    <div className="w-5 h-5 rounded-full bg-primary/10 text-primary text-[9px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                      {(a.name ?? a.email).slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      {a.name && <p className="text-xs font-medium text-foreground/80 truncate">{a.name}</p>}
                      <p className="text-[11px] text-muted-foreground/55 break-all">{a.email}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border/40 shrink-0">
        <Button variant="ghost" size="sm" onClick={() => onDelete(event)} disabled={deleting}
          className="w-full text-destructive/70 hover:text-destructive hover:bg-destructive/10 h-8 gap-1.5 text-xs">
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          Delete event
        </Button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

const VIEW_LABELS: Record<CalView, string> = {
  day: 'Day', workweek: 'Work Week', week: 'Week', month: 'Month', year: 'Year',
};

export default function CalendarPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(false);

  const [calView, setCalView]       = useState<CalView>('month');
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [events, setEvents]         = useState<CalEvent[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForDay, setCreateForDay]  = useState<Date | undefined>();
  const [deleting, setDeleting]     = useState(false);

  // Availability
  const [showAvailability, setShowAvailability] = useState(false);
  const [freeBusy, setFreeBusy]     = useState<FreeBusyData | null>(null);
  const [loadingFB, setLoadingFB]   = useState(false);

  // Auth guard
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // Derive the date range for the current view
  const { start: rangeStart, end: rangeEnd } = viewRange(currentDate, calView);

  // Days to display in timeline views
  const timelineDays = (() => {
    if (calView === 'day') return [startOfDay(currentDate)];
    if (calView === 'workweek') {
      const mon = startOfWeek(currentDate, { weekStartsOn: 1 });
      return Array.from({ length: 5 }, (_, i) => addDays(mon, i));
    }
    if (calView === 'week') {
      const mon = startOfWeek(currentDate, { weekStartsOn: 1 });
      return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    }
    return [];
  })();

  // Load events for the current view range
  const loadEvents = useCallback(async (start: Date, end: Date) => {
    setLoading(true);
    try {
      const data = await api.calendar.getEvents(start.toISOString(), end.toISOString());
      setEvents(data as CalEvent[]);
    } catch (err: any) {
      toast.error('Failed to load events', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    loadEvents(rangeStart, rangeEnd);
  }, [hydrated, isAuthenticated, rangeStart.toISOString(), rangeEnd.toISOString()]); // eslint-disable-line

  // Load free/busy for a given email
  const handleFreeBusySearch = useCallback(async (email: string) => {
    if (!email) { setFreeBusy(null); return; }
    setLoadingFB(true);
    try {
      const data = await api.calendar.getFreeBusy(
        email,
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
      );
      setFreeBusy(data);
    } catch (err: any) {
      toast.error('Failed to fetch availability', { description: err?.message });
    } finally {
      setLoadingFB(false);
    }
  }, [rangeStart, rangeEnd]);

  // Clear free/busy when view range changes (stale data)
  useEffect(() => { setFreeBusy(null); }, [rangeStart.toISOString()]); // eslint-disable-line

  const handleDelete = async (e: CalEvent) => {
    if (!window.confirm(`Delete "${e.title}"?`)) return;
    setDeleting(true);
    try {
      await api.calendar.deleteEvent(e.id);
      setEvents((prev) => prev.filter((x) => x.id !== e.id));
      if (selectedEvent?.id === e.id) setSelectedEvent(null);
      toast.success('Event deleted');
    } catch (err: any) {
      toast.error('Failed to delete event', { description: err?.message });
    } finally {
      setDeleting(false);
    }
  };

  if (!hydrated) return null;

  const isTimeline = calView === 'day' || calView === 'workweek' || calView === 'week';

  return (
    <TooltipProvider delayDuration={150}>
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />

      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
        {/* ── Top bar ── */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border/40 shrink-0 gap-4">
          {/* Navigation */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm"
              onClick={() => setCurrentDate((d) => navigate(d, calView, -1))}
              className="h-8 w-8 p-0 text-muted-foreground/60 hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <h1 className="text-sm font-semibold text-foreground min-w-[200px] text-center">
              {viewLabel(currentDate, calView)}
            </h1>
            <Button variant="ghost" size="sm"
              onClick={() => setCurrentDate((d) => navigate(d, calView, 1))}
              className="h-8 w-8 p-0 text-muted-foreground/60 hover:text-foreground">
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm"
              onClick={() => setCurrentDate(new Date())}
              className="h-8 px-3 text-xs text-muted-foreground/60 hover:text-foreground">
              Today
            </Button>
          </div>

          {/* View switcher */}
          <div className="flex items-center rounded-lg border border-border/40 overflow-hidden shrink-0">
            {(Object.keys(VIEW_LABELS) as CalView[]).map((v) => (
              <button key={v} onClick={() => setCalView(v)}
                className={cn('px-3 py-1.5 text-xs font-medium transition-colors border-r border-border/30 last:border-r-0',
                  calView === v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/50')}>
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm"
              onClick={() => setShowAvailability((v) => !v)}
              className={cn('h-8 px-3 text-xs gap-1.5', showAvailability ? 'text-primary bg-primary/10' : 'text-muted-foreground/60 hover:text-foreground')}>
              <Users className="w-3.5 h-3.5" /> Availability
            </Button>
            <Button size="sm"
              onClick={() => { setCreateForDay(undefined); setShowCreate(true); }}
              className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-4 gap-1.5">
              <Plus className="w-3.5 h-3.5" /> New Event
            </Button>
          </div>
        </div>

        {/* ── Main content area ── */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Calendar view area */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
            {loading && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/50">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/40" />
              </div>
            )}

            {calView === 'month' && (
              <MonthView
                currentDate={currentDate}
                events={events}
                onSelectEvent={setSelectedEvent}
                onCreateForDay={(d) => { setCreateForDay(d); setShowCreate(true); }}
              />
            )}

            {isTimeline && (
              <TimelineView
                days={timelineDays}
                events={events}
                freeBusy={isTimeline ? freeBusy : null}
                onSelectEvent={setSelectedEvent}
                onCreateForDay={(d) => { setCreateForDay(d); setShowCreate(true); }}
              />
            )}

            {calView === 'year' && (
              <YearView
                currentDate={currentDate}
                events={events}
                onMonthClick={(month) => {
                  setCurrentDate(month);
                  setCalView('month');
                }}
              />
            )}
          </div>

          {/* Event detail side panel */}
          {selectedEvent && (
            <EventDetailPanel
              event={selectedEvent}
              onClose={() => setSelectedEvent(null)}
              onDelete={handleDelete}
              deleting={deleting}
            />
          )}

          {/* Availability panel */}
          {showAvailability && !selectedEvent && (
            <AvailabilityPanel
              viewStart={rangeStart}
              viewEnd={rangeEnd}
              freeBusy={freeBusy}
              loading={loadingFB}
              onSearch={handleFreeBusySearch}
              onClose={() => setShowAvailability(false)}
            />
          )}
        </div>
      </div>

      {/* ── Create event modal ── */}
      {showCreate && (
        <CreateEventModal
          initialDate={createForDay}
          onClose={() => { setShowCreate(false); setCreateForDay(undefined); }}
          onCreated={(event) => {
            setEvents((prev) => [...prev, event]);
            setShowCreate(false);
            setCreateForDay(undefined);
            setSelectedEvent(event);
          }}
        />
      )}
    </div>
    </TooltipProvider>
  );
}
