'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { api } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { MobileSidebarSheet } from '@/components/layout/MobileSidebarSheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { toast } from 'sonner';
import {
  ChevronLeft, ChevronRight, Plus, X, Loader2,
  Clock, MapPin, Calendar as CalendarIcon, Trash2, Users,
  Video, Repeat, ExternalLink, Pencil, CheckCircle2,
  HelpCircle, XCircle, Menu, Mail, Sparkles,
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
  attendees: Array<{ email: string; name?: string; ptst?: string }>;
  linkedMessageId?: string | null;
  linkedSubject?: string | null;
}

type CalView = 'day' | 'workweek' | 'week' | 'month' | 'year' | 'agenda';

interface FreeBusyData {
  email: string;
  busy:        Array<{ s: number; e: number }>;
  tentative:   Array<{ s: number; e: number }>;
  unavailable: Array<{ s: number; e: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Assigns side-by-side column positions to overlapping events.
 * Returns a map of event id → { col, totalCols } so the renderer can
 * split the column width and offset each event horizontally.
 */
function layoutOverlapping(events: CalEvent[]): Map<string, { col: number; totalCols: number }> {
  const sorted = [...events].sort((a, b) => {
    const diff = parseISO(a.startAt).getTime() - parseISO(b.startAt).getTime();
    if (diff !== 0) return diff;
    return parseISO(b.endAt).getTime() - parseISO(a.endAt).getTime();
  });

  // colEndTimes[c] = end time of the last event placed in column c
  const colEndTimes: number[] = [];
  const assigned: Array<{ ev: CalEvent; col: number }> = [];

  for (const ev of sorted) {
    const start = parseISO(ev.startAt).getTime();
    const end   = parseISO(ev.endAt).getTime();
    let placed = false;
    for (let c = 0; c < colEndTimes.length; c++) {
      if (colEndTimes[c] <= start) {
        colEndTimes[c] = end;
        assigned.push({ ev, col: c });
        placed = true;
        break;
      }
    }
    if (!placed) {
      colEndTimes.push(end);
      assigned.push({ ev, col: colEndTimes.length - 1 });
    }
  }

  // totalCols for each event = max column index among all time-overlapping events + 1
  const result = new Map<string, { col: number; totalCols: number }>();
  for (const { ev, col } of assigned) {
    const start = parseISO(ev.startAt).getTime();
    const end   = parseISO(ev.endAt).getTime();
    let maxCol = col;
    for (const { ev: other, col: otherCol } of assigned) {
      if (other.id === ev.id) continue;
      const os = parseISO(other.startAt).getTime();
      const oe = parseISO(other.endAt).getTime();
      if (os < end && oe > start) maxCol = Math.max(maxCol, otherCol);
    }
    result.set(ev.id, { col, totalCols: maxCol + 1 });
  }
  return result;
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
    case 'agenda':
      return { start: startOfDay(date), end: endOfDay(addDays(date, 29)) };
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
    case 'agenda':   return dir > 0 ? addDays(date, 30)  : subDays(date, 30);
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
    case 'agenda':   return `${format(date, 'MMM d')} – ${format(addDays(date, 29), 'MMM d, yyyy')}`;
  }
}

// ── Attendee picker (shared by Create + Edit modal) ───────────────────────────

function AttendeePicker({
  attendees,
  onChange,
}: {
  attendees: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery]           = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ email: string; display: string }>>([]);
  const [loading, setLoading]       = useState(false);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    if (query.trim().length < 2) { setSuggestions([]); return; }
    setLoading(true);
    debRef.current = setTimeout(async () => {
      try {
        const res = await api.contacts.autocomplete(query.trim());
        setSuggestions(res.filter((r) => !attendees.includes(r.email)));
      } catch { setSuggestions([]); }
      finally { setLoading(false); }
    }, 300);
  }, [query]); // eslint-disable-line

  const add = (email: string) => {
    if (!attendees.includes(email)) onChange([...attendees, email]);
    setQuery('');
    setSuggestions([]);
  };

  const addByInput = () => {
    const e = query.trim().toLowerCase();
    if (e && e.includes('@')) { add(e); }
  };

  const remove = (email: string) => onChange(attendees.filter((a) => a !== email));

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">Attendees</Label>
      {/* Chip list */}
      {attendees.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1">
          {attendees.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs rounded-full pl-2 pr-1 py-0.5">
              <span className="truncate max-w-[140px]">{a}</span>
              <button type="button" onClick={() => remove(a)}
                className="w-3.5 h-3.5 rounded-full flex items-center justify-center hover:bg-primary/20">
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Input */}
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addByInput(); } }}
          placeholder="Add attendee email…"
          className="h-8 text-xs bg-muted/30 border-border/50 pr-10"
        />
        <button type="button" onClick={addByInput}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-primary transition-colors">
          <Plus className="w-3.5 h-3.5" />
        </button>
        {(loading || suggestions.length > 0) && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/50">
                <Loader2 className="w-3 h-3 animate-spin" /> Searching…
              </div>
            ) : (
              <ul className="max-h-36 overflow-y-auto py-1">
                {suggestions.map((s) => (
                  <li key={s.email}>
                    <button type="button" onMouseDown={() => add(s.email)}
                      className="w-full text-left px-3 py-1.5 hover:bg-muted/60 flex flex-col gap-0.5">
                      {s.display !== s.email && (
                        <span className="text-xs font-medium truncate">{s.display}</span>
                      )}
                      <span className="text-xs text-muted-foreground/60 truncate">{s.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Create / Edit event modal ──────────────────────────────────────────────────

function CreateEventModal({
  initialDate,
  initialData,
  prefillData,
  isEdit,
  onClose,
  onCreated,
  onUpdated,
}: {
  initialDate?: Date;
  initialData?: CalEvent;
  prefillData?: { title?: string; description?: string; linkedMessageId?: string; linkedSubject?: string };
  isEdit?: boolean;
  onClose: () => void;
  onCreated: (event: CalEvent) => void;
  onUpdated?: (event: CalEvent) => void;
}) {
  const base    = initialDate ?? (initialData ? parseISO(initialData.startAt) : new Date());
  const todayStr = format(base, "yyyy-MM-dd'T'HH:mm");
  const endStr   = format(new Date(base.getTime() + 3_600_000), "yyyy-MM-dd'T'HH:mm");

  const [title, setTitle]       = useState(initialData?.title ?? prefillData?.title ?? '');
  const [location, setLocation] = useState(initialData?.location ?? '');
  const [description, setDesc]  = useState(initialData?.description ?? prefillData?.description ?? '');
  const [startAt, setStart]     = useState(
    initialData ? format(parseISO(initialData.startAt), "yyyy-MM-dd'T'HH:mm") : todayStr,
  );
  const [endAt, setEnd]         = useState(
    initialData ? format(parseISO(initialData.endAt), "yyyy-MM-dd'T'HH:mm") : endStr,
  );
  const [allDay, setAllDay]     = useState(initialData?.allDay ?? false);
  const [attendees, setAttendees] = useState<string[]>(
    initialData?.attendees?.map((a) => a.email) ?? [],
  );
  const [saving, setSaving]     = useState(false);

  // ── Find-a-time (scheduling assistant inline in the event modal) ────────
  const [showFindTime, setShowFindTime] = useState(false);
  const [fbLoading, setFbLoading]       = useState(false);
  const [fbResults, setFbResults]       = useState<FreeBusyData[]>([]);

  const handleFindTime = async () => {
    if (attendees.length === 0) {
      toast.error('Add at least one attendee first');
      return;
    }
    setFbLoading(true);
    try {
      const from = new Date();
      const until = addDays(from, 30);
      const res = await api.calendar.getFreeBusyBatch(
        attendees,
        from.toISOString(),
        until.toISOString(),
      );
      setFbResults(res as FreeBusyData[]);
      setShowFindTime(true);
    } catch (err: any) {
      toast.error('Failed to check availability', { description: err?.message });
    } finally {
      setFbLoading(false);
    }
  };

  // Preserve the current event duration when applying a suggested slot so the
  // user's start/end stay in sync with the slot length they picked above.
  const durationMs = (() => {
    const s = new Date(startAt).getTime();
    const e = new Date(endAt).getTime();
    const d = e - s;
    return Number.isFinite(d) && d > 0 ? d : 60 * 60_000;
  })();

  const suggestedSlots = showFindTime && fbResults.length > 0
    ? findFreeSlots(fbResults, new Date(), durationMs, 6)
    : [];

  const applySlot = (slot: SuggestedSlot) => {
    setStart(format(slot.start, "yyyy-MM-dd'T'HH:mm"));
    setEnd(format(slot.end, "yyyy-MM-dd'T'HH:mm"));
    setShowFindTime(false);
  };

  // Linked email (from email context action or existing event)
  const linkedMessageId = prefillData?.linkedMessageId ?? initialData?.linkedMessageId ?? null;
  const linkedSubject   = prefillData?.linkedSubject   ?? initialData?.linkedSubject   ?? null;

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

      const payload = {
        title: title.trim(),
        location: location.trim() || undefined,
        description: description.trim() || undefined,
        startAt: startIso,
        endAt: endIso,
        allDay,
        attendees: attendees.length > 0 ? attendees : undefined,
        linkedMessageId: linkedMessageId ?? undefined,
        linkedSubject:   linkedSubject   ?? undefined,
      };

      if (isEdit && initialData) {
        const updated = await api.calendar.updateEvent(initialData.id, payload) as CalEvent;
        toast.success('Event updated');
        onUpdated?.(updated);
      } else {
        const event = await api.calendar.createEvent(payload) as CalEvent;
        toast.success('Event created');
        onCreated(event);
      }
    } catch (err: any) {
      toast.error(isEdit ? 'Failed to update event' : 'Failed to create event', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border/60 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40 shrink-0">
          <h2 className="text-sm font-semibold text-foreground">{isEdit ? 'Edit Event' : 'New Event'}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="w-4 h-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
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
              <Checkbox
                id="allday"
                checked={allDay}
                onCheckedChange={(v) => setAllDay(v === true)}
              />
              <Label htmlFor="allday" className="text-sm text-muted-foreground/70 cursor-pointer">All day</Label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">Start</Label>
                <DateTimePicker
                  value={allDay ? startAt.split('T')[0] : startAt}
                  onChange={setStart}
                  dateOnly={allDay}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">End</Label>
                <DateTimePicker
                  value={allDay ? endAt.split('T')[0] : endAt}
                  onChange={setEnd}
                  dateOnly={allDay}
                />
              </div>
            </div>
            {!allDay && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleFindTime}
                  disabled={fbLoading || attendees.length === 0}
                  className="h-7 px-2 text-[11px] gap-1.5 text-muted-foreground/70 hover:text-primary"
                  title={attendees.length === 0 ? 'Add attendees below first' : 'Find a time that works for everyone'}
                >
                  {fbLoading
                    ? <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</>
                    : <><Sparkles className="w-3 h-3" /> Find a time</>}
                </Button>
                {showFindTime && (
                  <button
                    type="button"
                    onClick={() => setShowFindTime(false)}
                    className="text-[10px] text-muted-foreground/50 hover:text-foreground"
                  >
                    hide
                  </button>
                )}
              </div>
            )}
            {showFindTime && !allDay && (
              <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                  Suggested slots ({Math.round(durationMs / 60_000)} min, weekdays 9–5)
                </p>
                {suggestedSlots.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 italic">
                    No common free time in the next 30 weekdays.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {suggestedSlots.map((slot, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-emerald-500/8 border border-emerald-500/20 hover:bg-emerald-500/12 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-[11px] font-medium text-foreground/80 truncate">
                            {format(slot.start, 'EEE, MMM d')}
                          </p>
                          <p className="text-[10px] text-muted-foreground/60">
                            {format(slot.start, 'h:mm a')} – {format(slot.end, 'h:mm a')}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => applySlot(slot)}
                          className="h-6 px-2 text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/15 shrink-0 gap-1"
                        >
                          Use <ChevronRight className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
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
            <AttendeePicker attendees={attendees} onChange={setAttendees} />
            {linkedMessageId && linkedSubject && (
              <div>
                <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1 block">Linked email</Label>
                <a
                  href={`/mail?open=${encodeURIComponent(linkedMessageId)}`}
                  className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs hover:bg-amber-100 dark:hover:bg-amber-800/30 transition-colors"
                >
                  <Mail className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1 truncate">{linkedSubject}</span>
                  <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                </a>
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border/40 shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground/60 h-8">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-4 gap-1.5">
            {saving
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
              : isEdit ? 'Save Changes' : 'Create Event'}
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
    events.filter((e) => {
      try {
        const d = startOfDay(day);
        return d >= startOfDay(parseISO(e.startAt)) && d <= startOfDay(parseISO(e.endAt));
      } catch { return false; }
    });

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
  const eventDays = new Set<string>();
  events.forEach((e) => {
    try {
      eachDayOfInterval({ start: parseISO(e.startAt), end: parseISO(e.endAt) })
        .forEach((d) => eventDays.add(format(d, 'yyyy-MM-dd')));
    } catch {}
  });

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
      try {
        const d = startOfDay(day);
        return d >= startOfDay(parseISO(e.startAt)) && d <= startOfDay(parseISO(e.endAt));
      } catch { return false; }
    });

  /** Timed events for a specific day */
  const timedFor = (day: Date) =>
    events.filter((e) => {
      if (e.allDay) return false;
      try {
        return parseISO(e.startAt) < endOfDay(day) && parseISO(e.endAt) > startOfDay(day);
      } catch { return false; }
    });

  /** Free/busy blocks for a specific day */
  const fbBlocksFor = (day: Date, type: 'busy' | 'tentative' | 'unavailable') => {
    if (!freeBusy) return [];
    const arr = freeBusy[type];
    return arr.filter((b) => isSameDay(new Date(b.s), day));
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

              {/* Timed events — side-by-side when overlapping */}
              {(() => {
                const dayEvents = timedFor(day);
                const layout    = layoutOverlapping(dayEvents);
                return dayEvents.map((ev) => {
                  const evStart   = parseISO(ev.startAt);
                  const evEnd     = parseISO(ev.endAt);
                  // Use the original start/end time on every spanned day
                  const startHour = getHours(evStart) + getMinutes(evStart) / 60;
                  const endHour   = getHours(evEnd)   + getMinutes(evEnd)   / 60;
                  const top = startHour * SLOT_H;
                  const h   = Math.max(20, (endHour - startHour) * SLOT_H);
                  const { col, totalCols } = layout.get(ev.id) ?? { col: 0, totalCols: 1 };
                  const widthPct = 100 / totalCols;
                  const leftPct  = col * widthPct;
                  return (
                    <button key={ev.id} onClick={(e) => { e.stopPropagation(); onSelectEvent(ev); }}
                      className={cn('absolute rounded px-1.5 py-0.5 text-[11px] font-medium text-left overflow-hidden transition-opacity hover:opacity-80 z-10', eventColor(ev.id))}
                      style={{ top, height: h, left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)` }}>
                      <span className="block truncate leading-tight">{ev.title}</span>
                      {h > 28 && <span className="block text-[10px] opacity-75 leading-tight truncate">{fmtTime(ev.startAt)}</span>}
                    </button>
                  );
                });
              })()}

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

// ── Agenda view ────────────────────────────────────────────────────────────────

function AgendaView({
  currentDate,
  events,
  onSelectEvent,
}: {
  currentDate: Date;
  events: CalEvent[];
  onSelectEvent: (e: CalEvent) => void;
}) {
  const days = eachDayOfInterval({
    start: startOfDay(currentDate),
    end:   endOfDay(addDays(currentDate, 29)),
  });

  const eventsForDay = (day: Date) => {
    const allDay: CalEvent[] = [];
    const timed:  CalEvent[] = [];
    for (const e of events) {
      try {
        if (!isSameDay(parseISO(e.startAt), day)) continue;
        (e.allDay ? allDay : timed).push(e);
      } catch { /* skip */ }
    }
    timed.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return [...allDay, ...timed];
  };

  const daysWithEvents = days.filter((d) => eventsForDay(d).length > 0);

  return (
    <ScrollArea className="flex-1 min-h-0">
      {daysWithEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <CalendarIcon className="w-10 h-10 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/40">No events in the next 30 days</p>
        </div>
      ) : (
        <div className="divide-y divide-border/20">
          {daysWithEvents.map((day) => {
            const dayEvs = eventsForDay(day);
            const today  = isToday(day);
            return (
              <div key={day.toISOString()} className="flex">
                {/* Sticky date label */}
                <div className={cn(
                  'w-28 shrink-0 px-4 py-3 text-right sticky left-0 bg-background/95 border-r border-border/20',
                  today && 'bg-primary/5',
                )}>
                  <p className={cn('text-xs font-semibold', today ? 'text-primary' : 'text-muted-foreground/70')}>
                    {format(day, 'EEE')}
                  </p>
                  <p className={cn(
                    'text-lg font-bold leading-tight',
                    today ? 'text-primary' : 'text-foreground/80',
                  )}>
                    {format(day, 'd')}
                  </p>
                  <p className="text-[10px] text-muted-foreground/40">{format(day, 'MMM')}</p>
                </div>

                {/* Events for the day */}
                <div className="flex-1 min-w-0 py-2 px-3 space-y-1.5">
                  {dayEvs.map((ev) => (
                    <button
                      key={ev.id}
                      onClick={() => onSelectEvent(ev)}
                      className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors group"
                    >
                      {/* Color strip */}
                      <div className={cn('w-1 self-stretch rounded-full shrink-0', eventColor(ev.id).replace(/text-\S+/, '').trim())} />

                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground/90 truncate group-hover:text-foreground">
                          {ev.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {ev.allDay ? (
                            <span className="text-xs text-muted-foreground/50">All day</span>
                          ) : (
                            <span className="text-xs text-muted-foreground/50 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {fmtTime(ev.startAt)} – {fmtTime(ev.endAt)}
                            </span>
                          )}
                          {ev.location && (
                            <span className="text-xs text-muted-foreground/40 flex items-center gap-1 truncate">
                              <MapPin className="w-3 h-3 shrink-0" />
                              <span className="truncate">{ev.location}</span>
                            </span>
                          )}
                          {ev.isRecurring && (
                            <span className="text-[10px] text-muted-foreground/40 flex items-center gap-0.5">
                              <Repeat className="w-3 h-3" /> Recurring
                            </span>
                          )}
                        </div>
                      </div>

                      {ev.attendees.length > 0 && (
                        <span className="text-[10px] text-muted-foreground/40 flex items-center gap-1 shrink-0">
                          <Users className="w-3 h-3" /> {ev.attendees.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ScrollArea>
  );
}

// ── Availability panel ─────────────────────────────────────────────────────────

const ATTENDEE_COLORS: Array<{ dot: string; busy: string; tent: string }> = [
  { dot: 'bg-blue-500',   busy: 'bg-blue-500/55',   tent: 'bg-blue-400/35'   },
  { dot: 'bg-violet-500', busy: 'bg-violet-500/55', tent: 'bg-violet-400/35' },
  { dot: 'bg-amber-500',  busy: 'bg-amber-500/55',  tent: 'bg-amber-400/35'  },
  { dot: 'bg-rose-500',   busy: 'bg-rose-500/55',   tent: 'bg-rose-400/35'   },
  { dot: 'bg-cyan-500',   busy: 'bg-cyan-500/55',   tent: 'bg-cyan-400/35'   },
  { dot: 'bg-pink-500',   busy: 'bg-pink-500/55',   tent: 'bg-pink-400/35'   },
];

type FBDuration = 60 | 90 | 120; // minutes

/** Merge overlapping intervals and return sorted non-overlapping array. */
function mergeIntervals(intervals: Array<{ s: number; e: number }>): Array<{ s: number; e: number }> {
  const sorted = [...intervals].sort((a, b) => a.s - b.s);
  const merged: Array<{ s: number; e: number }> = [];
  for (const iv of sorted) {
    if (merged.length > 0 && iv.s <= merged[merged.length - 1].e) {
      merged[merged.length - 1].e = Math.max(merged[merged.length - 1].e, iv.e);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** Subtract busy intervals from a free window [wStart, wEnd]. Returns free sub-intervals. */
function subtractIntervals(
  wStart: number,
  wEnd: number,
  busy: Array<{ s: number; e: number }>,
): Array<{ s: number; e: number }> {
  const clipped = mergeIntervals(
    busy
      .filter((b) => b.e > wStart && b.s < wEnd)
      .map((b) => ({ s: Math.max(b.s, wStart), e: Math.min(b.e, wEnd) })),
  );
  const free: Array<{ s: number; e: number }> = [];
  let cursor = wStart;
  for (const b of clipped) {
    if (b.s > cursor) free.push({ s: cursor, e: b.s });
    cursor = b.e;
  }
  if (cursor < wEnd) free.push({ s: cursor, e: wEnd });
  return free;
}

/** Snap ms timestamp to the next :00 or :30 boundary (on or after). */
function snapToHalfHour(ms: number): number {
  const d = new Date(ms);
  const mins = d.getMinutes();
  if (mins === 0) return ms;
  const next = mins <= 30 ? 30 : 60;
  d.setMinutes(next, 0, 0);
  return d.getTime();
}

interface SuggestedSlot { start: Date; end: Date }

function findFreeSlots(
  results: FreeBusyData[],
  fromDate: Date,
  durationMs: number,
  maxSlots = 5,
): SuggestedSlot[] {
  const slots: SuggestedSlot[] = [];
  const now = new Date();
  // Never suggest slots in the past — start from whichever is later
  const effectiveFrom = fromDate > now ? fromDate : now;
  const days = eachDayOfInterval({ start: startOfDay(effectiveFrom), end: addDays(effectiveFrom, 29) });

  for (const day of days) {
    if (slots.length >= maxSlots) break;
    // Skip weekends
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue;

    const wStart = new Date(day); wStart.setHours(9, 0, 0, 0);
    const wEnd   = new Date(day); wEnd.setHours(17, 0, 0, 0);
    // For today: don't look at hours already past
    if (wEnd <= effectiveFrom) continue;
    if (wStart < effectiveFrom) wStart.setTime(effectiveFrom.getTime());

    // Combine all busy + tentative from all attendees
    const allBusy: Array<{ s: number; e: number }> = results.flatMap((r) => [
      ...r.busy,
      ...r.tentative,
    ]);

    const freeWindows = subtractIntervals(wStart.getTime(), wEnd.getTime(), allBusy);

    for (const fw of freeWindows) {
      if (slots.length >= maxSlots) break;
      let t = snapToHalfHour(fw.s);
      while (t + durationMs <= fw.e && slots.length < maxSlots) {
        slots.push({ start: new Date(t), end: new Date(t + durationMs) });
        t += 30 * 60_000; // advance 30 min to find more slots in same window
      }
    }
  }
  return slots;
}

function AvailabilityPanel({
  viewStart,
  viewEnd,
  results,
  loading,
  onFetch,
  onClose,
  onSuggestTime,
}: {
  viewStart: Date;
  viewEnd: Date;
  results: FreeBusyData[];
  loading: boolean;
  onFetch: (emails: string[]) => void;
  onClose: () => void;
  onSuggestTime: (start: Date, end: Date, attendees: string[]) => void;
}) {
  const [attendees, setAttendees]   = useState<string[]>([]);
  const [query, setQuery]           = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ email: string; display: string }>>([]);
  const [loadingSug, setLoadingSug] = useState(false);
  const [duration, setDuration]     = useState<FBDuration>(60);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Autocomplete
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) { setSuggestions([]); return; }
    setLoadingSug(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.contacts.autocomplete(query.trim());
        setSuggestions(res.filter((r) => !attendees.includes(r.email)));
      } catch { setSuggestions([]); }
      finally { setLoadingSug(false); }
    }, 300);
  }, [query]); // eslint-disable-line

  const addAttendee = (email: string) => {
    const e = email.trim().toLowerCase();
    if (!e || attendees.includes(e)) return;
    setAttendees((prev) => [...prev, e]);
    setQuery('');
    setSuggestions([]);
  };

  const removeAttendee = (email: string) => {
    setAttendees((prev) => prev.filter((a) => a !== email));
  };

  const suggestedSlots = results.length > 0
    ? findFreeSlots(results, viewStart, duration * 60_000)
    : [];

  // Per-day timeline helpers
  const dayDur = endOfDay(viewStart).getTime() - startOfDay(viewStart).getTime();

  const blocksForAttendee = (
    fb: FreeBusyData,
    day: Date,
  ): Array<{ left: number; width: number; label: string; type: 'busy' | 'tent' | 'unav' }> => {
    const ds = startOfDay(day).getTime();
    const de = endOfDay(day).getTime();
    const dur = de - ds;
    const toBlocks = (arr: Array<{ s: number; e: number }>, type: 'busy' | 'tent' | 'unav') =>
      arr
        .filter((b) => b.e > ds && b.s < de)
        .map((b) => ({
          left:  ((Math.max(b.s, ds) - ds) / dur) * 100,
          width: ((Math.min(b.e, de) - Math.max(b.s, ds)) / dur) * 100,
          label: `${format(new Date(b.s), 'HH:mm')} – ${format(new Date(b.e), 'HH:mm')}`,
          type,
        }));
    return [
      ...toBlocks(fb.busy,        'busy'),
      ...toBlocks(fb.tentative,   'tent'),
      ...toBlocks(fb.unavailable, 'unav'),
    ];
  };

  const freeForAllBlocks = (day: Date): Array<{ left: number; width: number }> => {
    if (results.length < 2) return [];
    const ds = startOfDay(day).getTime();
    const de = endOfDay(day).getTime();
    const dur = de - ds;
    const wStart = new Date(day); wStart.setHours(8, 0, 0, 0);
    const wEnd   = new Date(day); wEnd.setHours(18, 0, 0, 0);
    const allBusy = results.flatMap((r) => [...r.busy, ...r.tentative]);
    return subtractIntervals(wStart.getTime(), wEnd.getTime(), allBusy).map((fw) => ({
      left:  ((fw.s - ds) / dur) * 100,
      width: ((fw.e - fw.s) / dur) * 100,
    }));
  };

  const days = eachDayOfInterval({ start: viewStart, end: viewEnd });

  return (
    <div className="w-80 shrink-0 border-l border-border/40 flex flex-col h-full bg-card/60">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-sm font-semibold text-foreground">Availability</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0 text-muted-foreground/50">
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* ── Attendee manager ── */}
      <div className="px-4 pt-3 pb-2 border-b border-border/30 space-y-2 shrink-0">
        {/* Chips */}
        {attendees.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attendees.map((a, i) => {
              const color = ATTENDEE_COLORS[i % ATTENDEE_COLORS.length];
              return (
                <span key={a} className="inline-flex items-center gap-1 bg-muted/50 border border-border/40 text-xs rounded-full pl-1.5 pr-1 py-0.5">
                  <span className={cn('w-2 h-2 rounded-full shrink-0', color.dot)} />
                  <span className="truncate max-w-[120px] text-foreground/70">{a}</span>
                  <button type="button" onClick={() => removeAttendee(a)}
                    className="w-3.5 h-3.5 rounded-full flex items-center justify-center hover:bg-muted/80 text-muted-foreground/50 hover:text-foreground">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* Email input */}
        <div className="relative">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setSuggestions([]);
                if (query.includes('@')) addAttendee(query);
              }
            }}
            placeholder="Add person by email…"
            className="h-8 text-xs bg-muted/30 border-border/50 pr-7"
          />
          <button type="button" onClick={() => { if (query.includes('@')) addAttendee(query); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-primary">
            <Plus className="w-3.5 h-3.5" />
          </button>
          {(loadingSug || suggestions.length > 0) && (
            <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden">
              {loadingSug ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/50">
                  <Loader2 className="w-3 h-3 animate-spin" /> Searching…
                </div>
              ) : (
                <ul className="max-h-36 overflow-y-auto py-1">
                  {suggestions.map((s) => (
                    <li key={s.email}>
                      <button type="button" onMouseDown={() => addAttendee(s.email)}
                        className="w-full text-left px-3 py-1.5 hover:bg-muted/60 flex flex-col gap-0.5">
                        {s.display !== s.email && (
                          <span className="text-xs font-medium truncate">{s.display}</span>
                        )}
                        <span className="text-xs text-muted-foreground/60 truncate">{s.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <Button
          size="sm"
          onClick={() => { if (attendees.length > 0) onFetch(attendees); }}
          disabled={loading || attendees.length === 0}
          className="w-full h-8 text-xs bg-primary/90 hover:bg-primary text-primary-foreground gap-1.5">
          {loading
            ? <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</>
            : <><Users className="w-3 h-3" /> Check availability</>}
        </Button>

        <p className="text-[10px] text-muted-foreground/40">
          {format(viewStart, 'MMM d')} – {format(viewEnd, 'MMM d, yyyy')}
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-12 text-center gap-2 px-4">
            <Users className="w-8 h-8 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground/40">Add people above and click "Check availability"</p>
          </div>
        ) : (
          <div className="pb-4">

            {/* ── Find a time ── */}
            <div className="px-4 pt-4 pb-3 border-b border-border/20 space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-foreground/80">Find a time</p>
                {/* Duration chips */}
                <div className="flex items-center gap-1">
                  {([60, 90, 120] as FBDuration[]).map((d) => (
                    <button key={d} onClick={() => setDuration(d)}
                      className={cn(
                        'px-2 py-0.5 rounded text-[10px] font-medium transition-colors border',
                        duration === d
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border/40 text-muted-foreground/60 hover:border-primary/40 hover:text-foreground',
                      )}>
                      {d === 60 ? '1h' : d === 90 ? '1.5h' : '2h'}
                    </button>
                  ))}
                </div>
              </div>

              {suggestedSlots.length === 0 ? (
                <p className="text-xs text-muted-foreground/40 italic">No common free slots found in the next 30 days</p>
              ) : (
                <div className="space-y-1">
                  {suggestedSlots.map((slot, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-emerald-500/8 border border-emerald-500/20 hover:bg-emerald-500/12 transition-colors">
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium text-foreground/80 truncate">{format(slot.start, 'EEE, MMM d')}</p>
                        <p className="text-[10px] text-muted-foreground/60">
                          {format(slot.start, 'h:mm a')} – {format(slot.end, 'h:mm a')}
                        </p>
                      </div>
                      <Button size="sm" variant="ghost"
                        onClick={() => onSuggestTime(slot.start, slot.end, attendees)}
                        className="h-6 px-2 text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/15 shrink-0 gap-1">
                        Use <ChevronRight className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Per-day stacked rows ── */}
            <div className="divide-y divide-border/15">
              {days.map((day) => {
                const freeAll = freeForAllBlocks(day);
                const ds      = startOfDay(day).getTime();
                const dur     = endOfDay(day).getTime() - ds;

                return (
                  <div key={day.toISOString()} className="px-4 py-2.5 space-y-1.5">
                    {/* Date header */}
                    <span className={cn('text-[11px] font-semibold', isToday(day) ? 'text-primary' : 'text-muted-foreground/60')}>
                      {format(day, 'EEE, MMM d')}
                    </span>

                    {/* One row per attendee */}
                    {results.map((fb, idx) => {
                      const color  = ATTENDEE_COLORS[idx % ATTENDEE_COLORS.length];
                      const blocks = blocksForAttendee(fb, day);
                      return (
                        <div key={fb.email} className="flex items-center gap-2">
                          {/* Label */}
                          <div className="flex items-center gap-1 w-24 shrink-0">
                            <span className={cn('w-2 h-2 rounded-full shrink-0', color.dot)} />
                            <span className="text-[10px] text-muted-foreground/60 truncate">{fb.email.split('@')[0]}</span>
                          </div>
                          {/* Timeline bar */}
                          <div className="relative flex-1 h-4 bg-muted/20 rounded border border-border/20">
                            {/* Non-working hours overlay: before 8am and after 6pm */}
                            <div className="absolute inset-y-0 left-0 bg-muted/40 rounded-l-sm pointer-events-none" style={{ width: `${(8/24)*100}%` }} />
                            <div className="absolute inset-y-0 right-0 bg-muted/40 rounded-r-sm pointer-events-none" style={{ width: `${(6/24)*100}%` }} />
                            {blocks.map((b, bi) => (
                              <Tooltip key={bi}>
                                <TooltipTrigger asChild>
                                  <div
                                    className={cn(
                                      'absolute h-full rounded-sm cursor-default transition-opacity hover:opacity-80',
                                      b.type === 'busy' ? color.busy : b.type === 'tent' ? color.tent : 'bg-slate-500/30',
                                    )}
                                    style={{ left: `${b.left}%`, width: `${Math.max(1, b.width)}%` }}
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={4} className="bg-background text-foreground border border-border/40 shadow-sm text-xs">
                                  <p className="font-semibold capitalize">{b.type === 'busy' ? 'Busy' : b.type === 'tent' ? 'Tentative' : 'Unavailable'}</p>
                                  <p className="text-muted-foreground">{b.label}</p>
                                </TooltipContent>
                              </Tooltip>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {/* Free for all row (≥2 attendees) */}
                    {results.length >= 2 && (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 w-24 shrink-0">
                          <span className="w-2 h-2 rounded-full shrink-0 bg-emerald-500/70" />
                          <span className="text-[10px] text-emerald-600/70 font-medium truncate">Free for all</span>
                        </div>
                        <div className="relative flex-1 h-4 bg-muted/20 rounded border border-border/20">
                          {freeAll.map((fw, fi) => (
                            <div key={fi}
                              className="absolute h-full bg-emerald-500/35 rounded-sm"
                              style={{ left: `${fw.left}%`, width: `${Math.max(1, fw.width)}%` }}
                            />
                          ))}
                          {/* Non-working hours overlay */}
                          <div className="absolute inset-y-0 left-0 bg-muted/40 rounded-l-sm pointer-events-none" style={{ width: `${(8/24)*100}%` }} />
                          <div className="absolute inset-y-0 right-0 bg-muted/40 rounded-r-sm pointer-events-none" style={{ width: `${(6/24)*100}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
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
  currentUserEmail,
  onClose,
  onDelete,
  onEdit,
  onRsvp,
  deleting,
  attendeesLoading,
}: {
  event: CalEvent;
  currentUserEmail: string | null | undefined;
  onClose: () => void;
  onDelete: (e: CalEvent) => void;
  onEdit: (e: CalEvent) => void;
  onRsvp: (e: CalEvent, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE') => void;
  deleting: boolean;
  attendeesLoading?: boolean;
}) {
  const meetingLink = isOnlineMeetingLink(event.location) ? event.location : null;
  const isOrganizer = event.organizer && currentUserEmail
    ? event.organizer.toLowerCase() === currentUserEmail.toLowerCase()
    : true;
  const isAttendee = event.attendees.some(
    (a) => a.email.toLowerCase() === currentUserEmail?.toLowerCase(),
  );
  const showRsvp = !isOrganizer && (isAttendee || event.attendees.length === 0);

  const [rsvping, setRsvping] = useState<'ACCEPT' | 'DECLINE' | 'TENTATIVE' | null>(null);

  const handleRsvp = async (verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE') => {
    setRsvping(verb);
    await onRsvp(event, verb);
    setRsvping(null);
  };

  return (
    <div className="w-80 shrink-0 border-l border-border/40 flex flex-col h-full bg-card/60 overflow-x-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border/40 shrink-0">
        <h3 className="text-sm font-semibold text-foreground wrap-break-word min-w-0 leading-snug">{event.title}</h3>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          <Button variant="ghost" size="sm" onClick={() => onEdit(event)}
            className="h-6 w-6 p-0 text-muted-foreground/50 hover:text-foreground" title="Edit event">
            <Pencil className="w-3 h-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0 text-muted-foreground/50">
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
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

          {/* RSVP buttons — shown for attendees who are not the organizer */}
          {showRsvp && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium">RSVP</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline"
                  onClick={() => handleRsvp('ACCEPT')}
                  disabled={!!rsvping}
                  className="flex-1 h-8 text-xs gap-1.5 border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600">
                  {rsvping === 'ACCEPT'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Accept
                </Button>
                <Button size="sm" variant="outline"
                  onClick={() => handleRsvp('TENTATIVE')}
                  disabled={!!rsvping}
                  className="flex-1 h-8 text-xs gap-1.5 border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600">
                  {rsvping === 'TENTATIVE'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <HelpCircle className="w-3.5 h-3.5" />}
                  Maybe
                </Button>
                <Button size="sm" variant="outline"
                  onClick={() => handleRsvp('DECLINE')}
                  disabled={!!rsvping}
                  className="flex-1 h-8 text-xs gap-1.5 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600">
                  {rsvping === 'DECLINE'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <XCircle className="w-3.5 h-3.5" />}
                  Decline
                </Button>
              </div>
            </div>
          )}

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
                <p className="wrap-break-word">{fmtDate(event.startAt)}</p>
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
                <span className="wrap-break-word min-w-0 text-sm leading-relaxed">
                  <Linkified text={event.location} />
                </span>
              </div>
            )}
          </div>

          {/* Description */}
          {event.description && (
            <div className="text-sm text-foreground/70 leading-relaxed wrap-break-word overflow-x-hidden">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium mb-1">Description</p>
              <Linkified text={event.description} />
            </div>
          )}

          {/* Linked source email */}
          {event.linkedMessageId && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium mb-1">Source email</p>
              <a
                href={`/mail?open=${encodeURIComponent(event.linkedMessageId)}`}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs hover:bg-amber-100 dark:hover:bg-amber-800/30 transition-colors"
              >
                <Mail className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 truncate">{event.linkedSubject ?? 'View email'}</span>
                <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
              </a>
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
          {(attendeesLoading || event.attendees.length > 0) && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/40 font-medium mb-2">
                {attendeesLoading
                  ? 'Attendees'
                  : `Attendees (${event.attendees.length})`}
              </p>
              <div className="space-y-2">
                {attendeesLoading
                  ? /* skeleton rows while Zimbra fetch is in-flight */
                    [0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center gap-2 animate-pulse">
                        <div className="w-5 h-5 rounded-full bg-muted/60 shrink-0" />
                        <div className="flex-1 space-y-1">
                          <div className="h-2.5 bg-muted/60 rounded w-2/3" />
                          <div className="h-2 bg-muted/40 rounded w-1/2" />
                        </div>
                      </div>
                    ))
                  : event.attendees.map((a) => {
                      const ptst = a.ptst;
                      const ptstLabel =
                        ptst === 'AC' ? 'Accepted'
                        : ptst === 'DE' ? 'Declined'
                        : ptst === 'TE' ? 'Tentative'
                        : null;
                      const ptstColor =
                        ptst === 'AC' ? 'text-emerald-500'
                        : ptst === 'DE' ? 'text-rose-500'
                        : ptst === 'TE' ? 'text-amber-500'
                        : 'text-muted-foreground/40';
                      return (
                        <div key={a.email} className="flex items-start gap-2">
                          <div className="w-5 h-5 rounded-full bg-primary/10 text-primary text-[9px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                            {(a.name ?? a.email).slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {a.name && (
                                <p className="text-xs font-medium text-foreground/80 truncate">{a.name}</p>
                              )}
                              {ptstLabel && (
                                <span className={cn('text-[10px] font-medium', ptstColor)}>
                                  · {ptstLabel}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground/55 break-all">{a.email}</p>
                          </div>
                        </div>
                      );
                    })}
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
  day: 'Day', workweek: 'Work Week', week: 'Week', month: 'Month', year: 'Year', agenda: 'Agenda',
};

export default function CalendarPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const currentUser     = useAuthStore((s) => s.user);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [calView, setCalView]       = useState<CalView>('agenda');
  const confirm = useConfirmStore((s) => s.confirm);
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [events, setEvents]         = useState<CalEvent[]>([]);
  const [loading, setLoading]       = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null);
  const [selectedEventLoading, setSelectedEventLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForDay, setCreateForDay]  = useState<Date | undefined>();
  const [editingEvent, setEditingEvent]  = useState<CalEvent | null>(null);
  const [dragPrefill, setDragPrefill] = useState<{ title?: string; description?: string; linkedMessageId?: string; linkedSubject?: string } | null>(null);
  const [deleting, setDeleting]     = useState(false);

  // Availability
  const [showAvailability, setShowAvailability] = useState(false);
  const [freeBusyList, setFreeBusyList] = useState<FreeBusyData[]>([]);
  const [loadingFB, setLoadingFB]       = useState(false);
  const [suggestSlot, setSuggestSlot]   = useState<{ start: Date; end: Date; attendees: string[] } | null>(null);

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

  // Open create modal when navigating from mail with ?createFromEmail=<id>&subject=<subject>
  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    const params = new URLSearchParams(window.location.search);
    const createFromEmail = params.get('createFromEmail');
    if (!createFromEmail) return;
    window.history.replaceState({}, '', window.location.pathname);
    const subject = params.get('subject') ?? '';
    setDragPrefill({ title: subject, linkedMessageId: createFromEmail, linkedSubject: subject });
    setShowCreate(true);
  }, [hydrated, isAuthenticated]); // eslint-disable-line

  // When an event is selected, fetch full details from Zimbra (complete attendee list)
  useEffect(() => {
    if (!selectedEvent) return;
    let cancelled = false;
    setSelectedEventLoading(true);
    api.calendar.getEvent(selectedEvent.id)
      .then((full) => {
        if (cancelled || !full) return;
        // Update the panel and also patch the event in the list
        setSelectedEvent((prev) => prev?.id === full.id ? { ...prev, ...full } : prev);
        setEvents((prev) => prev.map((e) => e.id === full.id ? { ...e, ...full } : e));
      })
      .catch(() => { /* non-fatal — panel already shows cached data */ })
      .finally(() => { if (!cancelled) setSelectedEventLoading(false); });
    return () => { cancelled = true; };
  }, [selectedEvent?.id]); // eslint-disable-line

  // Open create modal with prefill if navigated here via email drag-and-drop
  useEffect(() => {
    if (!hydrated) return;
    const raw = sessionStorage.getItem('govmail-prefill-calendar');
    if (!raw) return;
    sessionStorage.removeItem('govmail-prefill-calendar');
    try {
      const msg = JSON.parse(raw);
      setDragPrefill({
        title: msg.subject ?? '',
        description: msg.snippet ? `From: ${msg.from}\n\n${msg.snippet}` : `From: ${msg.from}`,
      });
      setShowCreate(true);
    } catch { /* ignore */ }
  }, [hydrated]); // eslint-disable-line

  // Fetch free/busy for a list of emails in one batch call
  const handleFreeBusyFetch = useCallback(async (emails: string[]) => {
    if (!emails.length) { setFreeBusyList([]); return; }
    setLoadingFB(true);
    try {
      const data = await api.calendar.getFreeBusyBatch(
        emails,
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
      );
      setFreeBusyList(data as FreeBusyData[]);
    } catch (err: any) {
      toast.error('Failed to fetch availability', { description: err?.message });
    } finally {
      setLoadingFB(false);
    }
  }, [rangeStart, rangeEnd]);

  // Clear free/busy when view range changes (stale data)
  useEffect(() => { setFreeBusyList([]); }, [rangeStart.toISOString()]); // eslint-disable-line

  const handleDelete = (e: CalEvent) => {
    confirm({
      title: `Delete "${e.title}"?`,
      description: 'This event will be permanently removed from your calendar.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
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
      },
    });
  };

  const handleRsvp = useCallback(async (event: CalEvent, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE') => {
    try {
      await api.calendar.rsvp(event.id, verb);
      const label = verb === 'ACCEPT' ? 'Accepted' : verb === 'DECLINE' ? 'Declined' : 'Marked as tentative';
      toast.success(label);
    } catch (err: any) {
      toast.error('RSVP failed', { description: err?.message });
    }
  }, []);

  const handleMailDrop = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const raw = e.dataTransfer.getData('application/x-govmail-msg');
      if (!raw) return;
      const msg = JSON.parse(raw);
      setDragPrefill({
        title: msg.subject ?? '',
        description: msg.snippet ? `From: ${msg.from}\n\n${msg.snippet}` : `From: ${msg.from}`,
      });
      setShowCreate(true);
    } catch { /* ignore */ }
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
      <MobileSidebarSheet
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />

      <div
        className="flex-1 min-w-0 flex flex-col h-full overflow-hidden"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleMailDrop}
      >
        {/* ── Top bar ── */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between px-3 lg:px-6 py-2 lg:py-3 border-b border-border/40 shrink-0 gap-2">
          {/* Row 1: navigation + New Event (mobile) */}
          <div className="flex items-center justify-between gap-1 lg:gap-2">
            <div className="flex items-center gap-1 lg:gap-2">
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-1.5 rounded-md text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground transition-colors"
                aria-label="Open navigation"
              >
                <Menu className="w-4 h-4" />
              </button>
              <Button variant="ghost" size="sm"
                onClick={() => setCurrentDate((d) => navigate(d, calView, -1))}
                className="h-8 w-8 p-0 text-muted-foreground/60 hover:text-foreground">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <h1 className="text-xs lg:text-sm font-semibold text-foreground min-w-[100px] lg:min-w-[200px] text-center">
                {viewLabel(currentDate, calView)}
              </h1>
              <Button variant="ghost" size="sm"
                onClick={() => setCurrentDate((d) => navigate(d, calView, 1))}
                className="h-8 w-8 p-0 text-muted-foreground/60 hover:text-foreground">
                <ChevronRight className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm"
                onClick={() => setCurrentDate(new Date())}
                className="h-8 px-2 lg:px-3 text-xs text-muted-foreground/60 hover:text-foreground">
                Today
              </Button>
            </div>
            {/* New Event — shown on mobile right side of row 1 */}
            <Button size="sm"
              onClick={() => { setCreateForDay(undefined); setShowCreate(true); }}
              className="lg:hidden bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-3 gap-1.5">
              <Plus className="w-3.5 h-3.5" /> New
            </Button>
          </div>

          {/* Row 2 on mobile / middle+right on desktop: view switcher + actions */}
          <div className="flex items-center justify-between gap-2">
            {/* View switcher — scrollable; mobile shows only day + agenda */}
            <div className="flex items-center rounded-lg border border-border/40 overflow-x-auto shrink-0 min-w-0">
              {(Object.keys(VIEW_LABELS) as CalView[]).map((v) => (
                <button key={v} onClick={() => setCalView(v)}
                  className={cn(
                    'px-2 lg:px-3 py-1.5 text-xs font-medium transition-colors border-r border-border/30 last:border-r-0 whitespace-nowrap',
                    v !== 'day' && v !== 'agenda' && 'hidden lg:block',
                    calView === v
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/50')}>
                  {VIEW_LABELS[v]}
                </button>
              ))}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="sm"
                onClick={() => setShowAvailability((v) => !v)}
                className={cn('h-8 px-3 text-xs gap-1.5', showAvailability ? 'text-primary bg-primary/10' : 'text-muted-foreground/60 hover:text-foreground')}>
                <Users className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Availability</span>
              </Button>
              <Button size="sm"
                onClick={() => { setCreateForDay(undefined); setShowCreate(true); }}
                className="hidden lg:flex bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-4 gap-1.5">
                <Plus className="w-3.5 h-3.5" /> New Event
              </Button>
            </div>
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
                freeBusy={null}
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

            {calView === 'agenda' && (
              <AgendaView
                currentDate={currentDate}
                events={events}
                onSelectEvent={setSelectedEvent}
              />
            )}
          </div>

          {/* Event detail side panel */}
          {selectedEvent && (
            <EventDetailPanel
              event={selectedEvent}
              currentUserEmail={currentUser?.email}
              onClose={() => setSelectedEvent(null)}
              onDelete={handleDelete}
              onEdit={(e) => { setEditingEvent(e); setSelectedEvent(null); }}
              onRsvp={handleRsvp}
              deleting={deleting}
              attendeesLoading={selectedEventLoading}
            />
          )}

          {/* Availability panel */}
          {showAvailability && !selectedEvent && (
            <AvailabilityPanel
              viewStart={rangeStart}
              viewEnd={rangeEnd}
              results={freeBusyList}
              loading={loadingFB}
              onFetch={handleFreeBusyFetch}
              onClose={() => setShowAvailability(false)}
              onSuggestTime={(start, end, attendees) => setSuggestSlot({ start, end, attendees })}
            />
          )}
        </div>
      </div>

      {/* ── Create event modal ── */}
      {showCreate && (
        <CreateEventModal
          initialDate={createForDay}
          prefillData={dragPrefill ?? undefined}
          onClose={() => { setShowCreate(false); setCreateForDay(undefined); setDragPrefill(null); }}
          onCreated={(event) => {
            setEvents((prev) => [...prev, event]);
            setShowCreate(false);
            setCreateForDay(undefined);
            setDragPrefill(null);
            setSelectedEvent(event);
          }}
        />
      )}

      {/* ── Suggested-time event modal (from Find a time) ── */}
      {suggestSlot && (
        <CreateEventModal
          initialDate={suggestSlot.start}
          initialData={{
            id: '', zimbraId: '', title: '', description: null, location: null,
            startAt: suggestSlot.start.toISOString(),
            endAt:   suggestSlot.end.toISOString(),
            allDay: false, isRecurring: false, organizer: null,
            attendees: suggestSlot.attendees.map((email) => ({ email })),
          }}
          onClose={() => setSuggestSlot(null)}
          onCreated={(event) => {
            setEvents((prev) => [...prev, event]);
            setSuggestSlot(null);
            setSelectedEvent(event);
          }}
        />
      )}

      {/* ── Edit event modal ── */}
      {editingEvent && (
        <CreateEventModal
          isEdit
          initialData={editingEvent}
          onClose={() => setEditingEvent(null)}
          onCreated={() => {}}
          onUpdated={(updated) => {
            setEvents((prev) => prev.map((e) => e.id === updated.id ? updated : e));
            setEditingEvent(null);
            setSelectedEvent(updated);
          }}
        />
      )}
    </div>
    </TooltipProvider>
  );
}
