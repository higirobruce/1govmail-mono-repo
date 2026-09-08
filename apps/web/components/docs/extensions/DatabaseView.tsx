'use client';

import { useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import {
  LayoutGrid, LayoutList, GalleryHorizontal, GanttChart, CalendarDays,
  Plus, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type Status = 'todo' | 'in-progress' | 'done';

interface DbRecord {
  id: string;
  name: string;
  status: Status;
  date: string;       // 'YYYY-MM-DD' used by Calendar & List
  startDate: string;  // 'YYYY-MM-DD' used by Timeline
  endDate: string;    // 'YYYY-MM-DD' used by Timeline
}

interface DbData {
  records: DbRecord[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

function parseData(raw?: string): DbData {
  if (!raw) return { records: [] };
  try { return JSON.parse(raw) as DbData; } catch { return { records: [] }; }
}

function blankRecord(): DbRecord {
  return { id: uid(), name: 'Untitled', status: 'todo', date: '', startDate: '', endDate: '' };
}

const STATUS_META: Record<Status, { label: string; dot: string; bar: string; badge: string }> = {
  'todo':        { label: 'Todo',        dot: 'bg-zinc-400',  bar: 'bg-zinc-400/60',  badge: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300' },
  'in-progress': { label: 'In Progress', dot: 'bg-blue-500',  bar: 'bg-blue-500/70',  badge: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
  'done':        { label: 'Done',        dot: 'bg-green-500', bar: 'bg-green-500/70', badge: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' },
};

const STATUSES: Status[] = ['todo', 'in-progress', 'done'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Shared sub-components ─────────────────────────────────────────────────────

function StatusSelect({ status, onChange }: { status: Status; onChange: (s: Status) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_META[status].dot)} />
      <select
        value={status}
        onChange={(e) => onChange(e.target.value as Status)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="text-[0.625rem] bg-transparent border-none outline-none cursor-pointer"
      >
        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
      </select>
    </div>
  );
}

function NameInput({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <input
      defaultValue={value}
      onBlur={(e) => onChange(e.target.value.trim() || 'Untitled')}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      placeholder="Untitled"
      className={cn('bg-transparent outline-none placeholder:text-muted-foreground/40 min-w-0', className)}
    />
  );
}

// ── Board View ────────────────────────────────────────────────────────────────

function BoardView({ data, update }: { data: DbData; update: (d: DbData) => void }) {
  const patch = (id: string, p: Partial<DbRecord>) =>
    update({ records: data.records.map((r) => r.id === id ? { ...r, ...p } : r) });

  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {STATUSES.map((status) => {
        const cards = data.records.filter((r) => r.status === status);
        const { dot, label } = STATUS_META[status];
        return (
          <div key={status} className="w-52 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <span className={cn('w-2 h-2 rounded-full', dot)} />
              <span className="text-xs font-medium">{label}</span>
              <span className="text-[0.625rem] text-muted-foreground ml-auto tabular-nums">{cards.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {cards.map((c) => (
                <div key={c.id} className="rounded-md border border-border bg-background p-2.5 shadow-sm">
                  <NameInput value={c.name} onChange={(name) => patch(c.id, { name })} className="text-sm w-full" />
                  <div className="mt-2">
                    <StatusSelect status={c.status} onChange={(s) => patch(c.id, { status: s })} />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => update({ records: [...data.records, { ...blankRecord(), status }] })}
                onKeyDown={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground py-0.5 transition-colors"
              >
                <Plus className="w-3 h-3" /> New
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── List View ─────────────────────────────────────────────────────────────────

function ListView({ data, update }: { data: DbData; update: (d: DbData) => void }) {
  const patch = (id: string, p: Partial<DbRecord>) =>
    update({ records: data.records.map((r) => r.id === id ? { ...r, ...p } : r) });

  return (
    <div className="w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            {['Name', 'Status', 'Date'].map((h) => (
              <th key={h} className="text-left px-2 py-1.5 text-[0.6875rem] font-semibold text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.records.map((r) => (
            <tr key={r.id} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
              <td className="px-2 py-1.5 w-full">
                <NameInput value={r.name} onChange={(name) => patch(r.id, { name })} className="text-sm w-full" />
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <StatusSelect status={r.status} onChange={(s) => patch(r.id, { status: s })} />
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <input
                  type="date"
                  defaultValue={r.date}
                  onBlur={(e) => patch(r.id, { date: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="text-[0.6875rem] bg-transparent outline-none cursor-pointer text-muted-foreground"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() => update({ records: [...data.records, blankRecord()] })}
        onKeyDown={(e) => e.stopPropagation()}
        className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground mt-2 px-2 py-0.5 transition-colors"
      >
        <Plus className="w-3 h-3" /> New record
      </button>
    </div>
  );
}

// ── Gallery View ──────────────────────────────────────────────────────────────

function GalleryView({ data, update }: { data: DbData; update: (d: DbData) => void }) {
  const patch = (id: string, p: Partial<DbRecord>) =>
    update({ records: data.records.map((r) => r.id === id ? { ...r, ...p } : r) });

  return (
    <div className="grid grid-cols-3 gap-3">
      {data.records.map((r) => (
        <div key={r.id} className="rounded-lg border border-border bg-background flex flex-col overflow-hidden">
          <div className="h-20 bg-muted/50 flex items-center justify-center text-3xl select-none">📄</div>
          <div className="p-2.5 flex flex-col gap-1.5">
            <NameInput value={r.name} onChange={(name) => patch(r.id, { name })} className="text-sm font-medium w-full" />
            <StatusSelect status={r.status} onChange={(s) => patch(r.id, { status: s })} />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => update({ records: [...data.records, blankRecord()] })}
        onKeyDown={(e) => e.stopPropagation()}
        className="rounded-lg border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors min-h-[120px]"
      >
        <Plus className="w-4 h-4" />
        <span className="text-xs">New card</span>
      </button>
    </div>
  );
}

// ── Timeline View ─────────────────────────────────────────────────────────────

function TimelineView({ data, update }: { data: DbData; update: (d: DbData) => void }) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());

  // 4-month window
  const months = Array.from({ length: 4 }, (_, i) => {
    const t = viewMonth + i;
    return { year: viewYear + Math.floor(t / 12), month: t % 12 };
  });

  const spanStart = new Date(months[0].year, months[0].month, 1);
  const spanEndExcl = new Date(months[3].year, months[3].month + 1, 1);
  const totalMs = spanEndExcl.getTime() - spanStart.getTime();
  const totalDays = months.reduce((a, { year, month }) => a + new Date(year, month + 1, 0).getDate(), 0);

  const leftPct = (dateStr: string): number => {
    if (!dateStr) return 0;
    const ms = new Date(dateStr + 'T00:00:00').getTime() - spanStart.getTime();
    return Math.min(100, Math.max(0, (ms / totalMs) * 100));
  };

  const rightPct = (dateStr: string): number => {
    if (!dateStr) return 0;
    const ms = new Date(dateStr + 'T00:00:00').getTime() + 86_400_000 - spanStart.getTime();
    return Math.min(100, Math.max(0, 100 - (ms / totalMs) * 100));
  };

  const shift = (delta: number) => {
    const t = viewMonth + delta;
    setViewYear(viewYear + Math.floor(t / 12));
    setViewMonth(((t % 12) + 12) % 12);
  };

  const patch = (id: string, p: Partial<DbRecord>) =>
    update({ records: data.records.map((r) => r.id === id ? { ...r, ...p } : r) });

  const addRow = () => {
    const { year: y, month: m } = months[0];
    const mm = String(m + 1).padStart(2, '0');
    const last = new Date(y, m + 1, 0).getDate();
    update({ records: [...data.records, { ...blankRecord(), startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-${last}` }] });
  };

  return (
    <div>
      {/* Month header */}
      <div className="flex items-center mb-1.5">
        <div className="w-36 shrink-0" />
        <div className="flex-1 flex">
          {months.map(({ year, month }, i) => {
            const days = new Date(year, month + 1, 0).getDate();
            return (
              <div
                key={i}
                style={{ flex: days / totalDays }}
                className="text-[0.625rem] text-muted-foreground font-medium border-l border-border/30 first:border-l-0 px-1 truncate"
              >
                {MONTH_NAMES[month]} {year}
              </div>
            );
          })}
        </div>
        <div className="flex ml-1 shrink-0">
          <button type="button" onClick={() => shift(-1)} onKeyDown={(e) => e.stopPropagation()} className="p-0.5 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => shift(1)} onKeyDown={(e) => e.stopPropagation()} className="p-0.5 text-muted-foreground hover:text-foreground">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-1.5">
        {data.records.length === 0 && (
          <p className="text-[0.6875rem] text-muted-foreground/50 text-center py-4">No items yet — add one below</p>
        )}
        {data.records.map((r) => {
          const l = leftPct(r.startDate);
          const rr = rightPct(r.endDate);
          return (
            <div key={r.id} className="flex items-center h-8">
              <div className="w-36 shrink-0 pr-3">
                <NameInput value={r.name} onChange={(name) => patch(r.id, { name })} className="text-xs w-full truncate" />
              </div>
              <div className="flex-1 relative h-5">
                {/* Month grid lines */}
                <div className="absolute inset-0 flex pointer-events-none">
                  {months.map(({ year, month }, i) => {
                    const days = new Date(year, month + 1, 0).getDate();
                    return <div key={i} style={{ flex: days / totalDays }} className="border-l border-border/20 first:border-l-0 h-full" />;
                  })}
                </div>
                {/* Bar */}
                <div
                  className={cn('absolute top-0 bottom-0 rounded overflow-hidden', STATUS_META[r.status].bar)}
                  style={{ left: `${l}%`, right: `${rr}%`, minWidth: '0.5rem' }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Date range inputs */}
      {data.records.length > 0 && (
        <div className="mt-3 border-t border-border/40 pt-2">
          <p className="text-[0.625rem] text-muted-foreground font-medium mb-1.5">Date ranges</p>
          <div className="flex flex-col gap-1">
            {data.records.map((r) => (
              <div key={r.id} className="flex items-center gap-2">
                <span className="w-36 shrink-0 truncate text-[0.6875rem] text-muted-foreground">{r.name}</span>
                <input
                  type="date"
                  defaultValue={r.startDate}
                  onBlur={(e) => patch(r.id, { startDate: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="bg-transparent outline-none text-[0.6875rem] text-muted-foreground cursor-pointer"
                />
                <span className="text-muted-foreground/40 text-[0.6875rem]">→</span>
                <input
                  type="date"
                  defaultValue={r.endDate}
                  onBlur={(e) => patch(r.id, { endDate: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="bg-transparent outline-none text-[0.6875rem] text-muted-foreground cursor-pointer"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={addRow}
        onKeyDown={(e) => e.stopPropagation()}
        className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground mt-2 transition-colors"
      >
        <Plus className="w-3 h-3" /> New item
      </button>
    </div>
  );
}

// ── Calendar View ─────────────────────────────────────────────────────────────

function CalendarView({ data, update }: { data: DbData; update: (d: DbData) => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const shift = (delta: number) => {
    const t = month + delta;
    setYear(year + Math.floor(t / 12));
    setMonth(((t % 12) + 12) % 12);
  };

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();

  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay: Record<number, DbRecord[]> = {};
  data.records.forEach((r) => {
    if (!r.date) return;
    const d = new Date(r.date + 'T00:00:00');
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      (byDay[day] ??= []).push(r);
    }
  });

  const isToday = (d: number) =>
    d === now.getDate() && month === now.getMonth() && year === now.getFullYear();

  const addOnDay = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    update({ records: [...data.records, { ...blankRecord(), date: dateStr }] });
  };

  return (
    <div>
      {/* Navigation */}
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={() => shift(-1)} onKeyDown={(e) => e.stopPropagation()} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="text-sm font-semibold">{MONTH_NAMES[month]} {year}</span>
        <button type="button" onClick={() => shift(1)} onKeyDown={(e) => e.stopPropagation()} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-0.5">
        {DAY_LABELS.map((d) => (
          <div key={d} className="text-[0.625rem] text-muted-foreground text-center py-0.5 font-medium">{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 border-l border-t border-border">
        {cells.map((day, idx) => (
          <div
            key={idx}
            className={cn(
              'border-r border-b border-border min-h-[72px] p-1 flex flex-col gap-0.5 group',
              day === null && 'bg-muted/20',
            )}
          >
            {day !== null && (
              <>
                <span className={cn(
                  'text-[0.625rem] w-5 h-5 flex items-center justify-center rounded-full font-medium self-end',
                  isToday(day) ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                )}>
                  {day}
                </span>
                {(byDay[day] ?? []).map((r) => (
                  <div
                    key={r.id}
                    className={cn('text-[0.5625rem] rounded px-1 py-px truncate leading-tight', STATUS_META[r.status].badge)}
                  >
                    {r.name}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addOnDay(day)}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="mt-auto text-[0.625rem] text-muted-foreground/40 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity self-start leading-none"
                >
                  +
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main node view ────────────────────────────────────────────────────────────

const VIEW_ICONS = {
  board:    { Icon: LayoutGrid,        label: 'Board View' },
  list:     { Icon: LayoutList,        label: 'List View' },
  gallery:  { Icon: GalleryHorizontal, label: 'Gallery' },
  timeline: { Icon: GanttChart,        label: 'Timeline' },
  calendar: { Icon: CalendarDays,      label: 'Calendar' },
} as const;

type ViewType = keyof typeof VIEW_ICONS;

function DatabaseNodeView({
  node,
  updateAttributes,
}: {
  node: { attrs: Record<string, string> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
}) {
  const view = (node.attrs.view ?? 'board') as ViewType;
  const { Icon, label } = VIEW_ICONS[view] ?? VIEW_ICONS.board;

  const data = parseData(node.attrs.data);
  const update = (d: DbData) => updateAttributes({ data: JSON.stringify(d) });

  return (
    <NodeViewWrapper contentEditable={false} className="my-2">
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold text-muted-foreground">{node.attrs.title || label}</span>
          <span className="ml-auto text-[0.625rem] text-muted-foreground/50 tabular-nums">{data.records.length} items</span>
        </div>

        {/* View */}
        <div className="p-4">
          {view === 'board'    && <BoardView    data={data} update={update} />}
          {view === 'list'     && <ListView     data={data} update={update} />}
          {view === 'gallery'  && <GalleryView  data={data} update={update} />}
          {view === 'timeline' && <TimelineView data={data} update={update} />}
          {view === 'calendar' && <CalendarView data={data} update={update} />}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

// ── TipTap node ───────────────────────────────────────────────────────────────

export const DatabaseView = Node.create({
  name: 'databaseView',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      view:  { default: 'board' },
      title: { default: '' },
      data:  { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="database-view"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'database-view' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DatabaseNodeView);
  },
});
