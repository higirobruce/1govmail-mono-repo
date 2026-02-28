'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Plus, Loader2, ListTodo, Pencil, Trash2, Check,
  Calendar, User, Link, List, Columns, ChevronDown, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import TaskModal, {
  type Task,
  type TaskStatus,
  type TaskPriority,
  PRIORITY_META,
  STATUS_META,
} from '@/components/tasks/TaskModal';

// ── Types ──────────────────────────────────────────────────────────────────────

type FilterTab = 'ALL' | 'TODAY' | TaskStatus;
type ViewMode  = 'list' | 'board';
type SortKey   = 'due_asc' | 'due_desc' | 'priority_high' | 'priority_low' | 'newest' | 'oldest';

const PRIORITY_ORDER: Record<TaskPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// ── Helpers ────────────────────────────────────────────────────────────────────

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'ALL',         label: 'All' },
  { key: 'TODAY',       label: 'My Day' },
  { key: 'TODO',        label: 'To Do' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'DONE',        label: 'Done' },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'newest',       label: 'Newest' },
  { key: 'oldest',       label: 'Oldest' },
  { key: 'due_asc',      label: 'Due date ↑' },
  { key: 'due_desc',     label: 'Due date ↓' },
  { key: 'priority_high', label: 'Priority high→low' },
  { key: 'priority_low',  label: 'Priority low→high' },
];

const BOARD_COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: 'TODO',        label: 'To Do',       color: 'border-t-slate-400' },
  { status: 'IN_PROGRESS', label: 'In Progress',  color: 'border-t-blue-500' },
  { status: 'DONE',        label: 'Done',         color: 'border-t-green-500' },
  { status: 'CANCELLED',   label: 'Cancelled',    color: 'border-t-rose-400' },
];

function isOverdue(task: Task): boolean {
  if (!task.dueDate) return false;
  if (task.status === 'DONE' || task.status === 'CANCELLED') return false;
  return new Date(task.dueDate) < new Date(new Date().toDateString());
}

function sortTasks(tasks: Task[], sort: SortKey): Task[] {
  return [...tasks].sort((a, b) => {
    switch (sort) {
      case 'newest': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'oldest': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      case 'due_asc': {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      }
      case 'due_desc': {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime();
      }
      case 'priority_high': return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      case 'priority_low':  return PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
      default: return 0;
    }
  });
}

function formatDueDate(iso: string): { text: string; overdue: boolean } {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = d < today;
  const text = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  return { text, overdue };
}

// ── Task card ──────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  onToggle,
  onEdit,
  onDelete,
  draggable,
  onDragStart,
  selectable,
  selected,
  onSelect,
}: {
  task: Task;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const done = task.status === 'DONE';
  const cancelled = task.status === 'CANCELLED';
  const pri = PRIORITY_META[task.priority];
  const due = task.dueDate ? formatDueDate(task.dueDate) : null;
  const subtasksDone = (task.subtasks ?? []).filter((s) => s.completed).length;
  const subtasksTotal = (task.subtasks ?? []).length;

  return (
    <div
      className={cn(
        'group flex items-start gap-3 px-4 py-3 rounded-xl border transition-all',
        done || cancelled
          ? 'bg-muted/20 border-border/20'
          : 'bg-card border-border/30 hover:border-border/50 shadow-sm',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
      draggable={draggable}
      onDragStart={onDragStart}
    >
      {/* Selection checkbox */}
      {selectable && (
        <button
          onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
          className={cn(
            'mt-0.5 w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center transition-all',
            selected
              ? 'bg-primary border-primary'
              : 'border-border/50 opacity-0 group-hover:opacity-100',
          )}
        >
          {selected && <Check className="w-3 h-3 text-primary-foreground" />}
        </button>
      )}

      {/* Status checkbox */}
      <button
        onClick={onToggle}
        className={cn(
          'mt-0.5 w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center transition-all',
          done
            ? 'bg-primary border-primary'
            : 'border-border/50 hover:border-primary/50',
        )}
        title={done ? 'Mark as To Do' : 'Mark as Done'}
      >
        {done && <Check className="w-3 h-3 text-primary-foreground" />}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <span className={cn(
            'text-sm font-medium leading-snug',
            done || cancelled ? 'line-through text-muted-foreground/50' : 'text-foreground',
          )}>
            {task.title}
          </span>
        </div>

        {task.description && (
          <p className="text-xs text-muted-foreground/55 mt-0.5 line-clamp-2">{task.description}</p>
        )}

        {/* Meta chips */}
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full', pri.cls)}>
            {pri.label}
          </span>

          {due && (
            <span className={cn(
              'text-[10px] flex items-center gap-1 px-1.5 py-0.5 rounded-full',
              due.overdue && !done
                ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
                : 'bg-muted/60 text-muted-foreground/70',
            )}>
              <Calendar className="w-2.5 h-2.5" />
              {due.text}
            </span>
          )}

          {task.assignedToEmail && (
            <span className="text-[10px] flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              <User className="w-2.5 h-2.5" />
              {task.assignedToName ?? task.assignedToEmail}
            </span>
          )}

          {task.linkedSubject && (
            <span className="text-[10px] flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 max-w-[160px]">
              <Link className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">{task.linkedSubject}</span>
            </span>
          )}

          {subtasksTotal > 0 && (
            <span className="text-[10px] text-muted-foreground/50 px-1.5 py-0.5">
              {subtasksDone}/{subtasksTotal} subtasks
            </span>
          )}
        </div>
      </div>

      {/* Actions (show on hover) */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5">
        <button
          onClick={onEdit}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground/50 hover:bg-muted/60 hover:text-foreground transition-colors"
          title="Edit"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground/50 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function TasksPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [modalTask, setModalTask] = useState<Task | null | 'new'>('new');
  const [showModal, setShowModal] = useState(false);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

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

  // Load tasks
  const loadTasks = useCallback(async (status?: string) => {
    setLoading(true);
    try {
      const data = await api.tasks.getAll(status === 'ALL' ? undefined : status);
      setTasks(data as Task[]);
    } catch (err: any) {
      toast.error('Failed to load tasks', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    // TODAY is a client-side filter — load all tasks and filter locally
    const statusParam = filter === 'ALL' || filter === 'TODAY' ? undefined : filter;
    loadTasks(statusParam);
  }, [hydrated, isAuthenticated, filter, loadTasks]);

  // Clear selection when filter changes
  useEffect(() => { setSelectedIds(new Set()); }, [filter]);

  const handleToggle = async (task: Task) => {
    const newStatus: TaskStatus = task.status === 'DONE' ? 'TODO' : 'DONE';
    try {
      const updated = (await api.tasks.update(task.id, { status: newStatus })) as Task;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? { ...updated, subtasks: t.subtasks, comments: t.comments } : t)));
    } catch (err: any) {
      toast.error('Failed to update task', { description: err?.message });
    }
  };

  const handleDelete = async (task: Task) => {
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await api.tasks.delete(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      toast.success('Task deleted');
    } catch (err: any) {
      toast.error('Failed to delete task', { description: err?.message });
    }
  };

  // Kanban drag-and-drop
  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('taskId', taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = async (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault();
    setDragOverColumn(null);
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === status) return;
    try {
      const updated = (await api.tasks.update(taskId, { status })) as Task;
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...updated, subtasks: t.subtasks, comments: t.comments } : t));
    } catch (err: any) {
      toast.error('Failed to move task', { description: err?.message });
    }
  };

  const openCreate = () => { setModalTask('new'); setShowModal(true); };
  const openEdit   = (t: Task) => { setModalTask(t); setShowModal(true); };
  const closeModal = () => setShowModal(false);

  const handleSaved = (saved: Task) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [saved, ...prev];
    });
  };

  // TODAY client-side filter
  const isTodayTask = (task: Task): boolean => {
    if (!task.dueDate) return false;
    const due = new Date(task.dueDate);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
    return due >= todayStart && due <= todayEnd;
  };

  const todayCount = tasks.filter(isTodayTask).length;

  const filteredByTab = filter === 'TODAY' ? tasks.filter(isTodayTask) : tasks;

  // Apply overdue filter + sort
  const displayedTasks = sortTasks(
    overdueOnly ? filteredByTab.filter(isOverdue) : filteredByTab,
    sortKey,
  );

  // ── Bulk actions ───────────────────────────────────────────────────────────

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleBulkDone = async () => {
    if (!selectedIds.size || bulkLoading) return;
    setBulkLoading(true);
    const ids = Array.from(selectedIds);
    let failures = 0;
    for (const id of ids) {
      try {
        const updated = (await api.tasks.update(id, { status: 'DONE' })) as Task;
        setTasks((prev) => prev.map((t) => t.id === id ? { ...updated, subtasks: t.subtasks, comments: t.comments } : t));
      } catch { failures++; }
    }
    if (failures) toast.error(`${failures} task(s) could not be updated`);
    else toast.success(`${ids.length} task(s) marked as done`);
    setSelectedIds(new Set());
    setBulkLoading(false);
  };

  const handleBulkDelete = async () => {
    if (!selectedIds.size || bulkLoading) return;
    if (!window.confirm(`Delete ${selectedIds.size} task(s)?`)) return;
    setBulkLoading(true);
    const ids = Array.from(selectedIds);
    let failures = 0;
    for (const id of ids) {
      try {
        await api.tasks.delete(id);
        setTasks((prev) => prev.filter((t) => t.id !== id));
      } catch { failures++; }
    }
    if (failures) toast.error(`${failures} task(s) could not be deleted`);
    else toast.success(`${ids.length} task(s) deleted`);
    setSelectedIds(new Set());
    setBulkLoading(false);
  };

  if (!hydrated) return null;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />

      <div className="flex-1 min-w-0 flex flex-col h-full">
        {/* Top bar */}
        <div className="px-6 py-4 border-b border-border/40 flex items-center gap-3 shrink-0">
          <h1 className="text-sm font-semibold text-foreground">Tasks</h1>
          <div className="flex-1" />
          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-border/40 overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={cn(
                'w-8 h-8 flex items-center justify-center transition-colors',
                viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground/50 hover:bg-muted/50',
              )}
              title="List view"
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('board')}
              className={cn(
                'w-8 h-8 flex items-center justify-center transition-colors',
                viewMode === 'board' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground/50 hover:bg-muted/50',
              )}
              title="Board view"
            >
              <Columns className="w-3.5 h-3.5" />
            </button>
          </div>
          <Button
            size="sm"
            onClick={openCreate}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Task
          </Button>
        </div>

        {/* Filter tabs (list view only) */}
        {viewMode === 'list' && (
          <div className="px-6 pt-3 pb-0 border-b border-border/30 flex gap-1 shrink-0">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={cn(
                  'px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors flex items-center gap-1.5',
                  filter === tab.key
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground/60 hover:text-foreground',
                )}
              >
                {tab.label}
                {tab.key === 'TODAY' && todayCount > 0 && (
                  <span className="text-[10px] bg-primary/15 text-primary rounded-full px-1.5 py-0.5 min-w-[18px] text-center leading-none">
                    {todayCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Sort / filter bar */}
        <div className="px-6 py-2 flex items-center gap-3 shrink-0 border-b border-border/20 bg-muted/10">
          {/* Sort */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">Sort</span>
            <div className="relative">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="h-7 text-xs bg-background border border-border/40 rounded-md pl-2 pr-6 appearance-none focus:outline-none focus:border-primary/50 text-foreground"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/40 pointer-events-none" />
            </div>
          </div>

          {/* Overdue filter chip */}
          <button
            onClick={() => setOverdueOnly((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
              overdueOnly
                ? 'bg-red-100 border-red-300 text-red-700 dark:bg-red-900/40 dark:border-red-700 dark:text-red-400'
                : 'bg-transparent border-border/40 text-muted-foreground/50 hover:border-border/70 hover:text-foreground',
            )}
          >
            {overdueOnly && <Check className="w-2.5 h-2.5" />}
            Overdue
          </button>

          <div className="flex-1" />
          <span className="text-[11px] text-muted-foreground/40">
            {displayedTasks.length} task{displayedTasks.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* ── List view ── */}
        {viewMode === 'list' && (
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
                </div>
              ) : displayedTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-muted/40 flex items-center justify-center">
                    <ListTodo className="w-7 h-7 text-muted-foreground/25" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground/60">No tasks yet</p>
                    <p className="text-xs text-muted-foreground/40 mt-1">
                      <button onClick={openCreate} className="text-primary hover:underline">
                        Create your first task
                      </button>
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 max-w-2xl">
                  {displayedTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onToggle={() => handleToggle(task)}
                      onEdit={() => openEdit(task)}
                      onDelete={() => handleDelete(task)}
                      selectable
                      selected={selectedIds.has(task.id)}
                      onSelect={() => toggleSelect(task.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        )}

        {/* ── Board view ── */}
        {viewMode === 'board' && (
          <div className="flex-1 min-h-0 overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
              </div>
            ) : (
              <div className="flex gap-4 px-6 py-4 h-full min-w-max">
                {BOARD_COLUMNS.map((col) => {
                  const colTasks = displayedTasks.filter((t) => t.status === col.status);
                  const isOver = dragOverColumn === col.status;
                  return (
                    <div
                      key={col.status}
                      className={cn(
                        'flex flex-col w-72 shrink-0 rounded-xl border border-border/30 border-t-4 transition-colors',
                        col.color,
                        isOver && 'bg-muted/30 border-border/50',
                      )}
                      onDragOver={(e) => { e.preventDefault(); setDragOverColumn(col.status); }}
                      onDragLeave={() => setDragOverColumn(null)}
                      onDrop={(e) => handleDrop(e, col.status)}
                    >
                      {/* Column header */}
                      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20">
                        <span className="text-xs font-semibold text-foreground/70">{col.label}</span>
                        <span className="text-[11px] bg-muted/60 text-muted-foreground/60 rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
                          {colTasks.length}
                        </span>
                      </div>

                      {/* Column cards */}
                      <ScrollArea className="flex-1 min-h-0">
                        <div className="p-2 space-y-2">
                          {colTasks.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/30">
                              <ListTodo className="w-6 h-6 mb-1" />
                              <span className="text-[11px]">Drop tasks here</span>
                            </div>
                          ) : (
                            colTasks.map((task) => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                onToggle={() => handleToggle(task)}
                                onEdit={() => openEdit(task)}
                                onDelete={() => handleDelete(task)}
                                draggable
                                onDragStart={(e) => handleDragStart(e, task.id)}
                                selectable
                                selected={selectedIds.has(task.id)}
                                onSelect={() => toggleSelect(task.id)}
                              />
                            ))
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2.5 bg-background border border-border/50 rounded-2xl shadow-2xl">
          <span className="text-xs text-muted-foreground/70 mr-1">
            {selectedIds.size} selected
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleBulkDone}
            disabled={bulkLoading}
            className="h-7 text-xs gap-1.5 text-green-700 border-green-300 hover:bg-green-50 dark:text-green-400 dark:border-green-700 dark:hover:bg-green-900/30"
          >
            {bulkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Mark done
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleBulkDelete}
            disabled={bulkLoading}
            className="h-7 text-xs gap-1.5 text-red-700 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/30"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </Button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-1 w-6 h-6 flex items-center justify-center rounded-lg text-muted-foreground/50 hover:bg-muted/60"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <TaskModal
          task={modalTask === 'new' ? null : modalTask}
          onClose={closeModal}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
