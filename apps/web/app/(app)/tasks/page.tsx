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
  Calendar, User, Link,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import TaskModal, {
  type Task,
  type TaskStatus,
  type TaskPriority,
  PRIORITY_META,
} from '@/components/tasks/TaskModal';

// ── Types ──────────────────────────────────────────────────────────────────────

type FilterTab = 'ALL' | TaskStatus;

// ── Helpers ────────────────────────────────────────────────────────────────────

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'ALL',        label: 'All' },
  { key: 'TODO',       label: 'To Do' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'DONE',       label: 'Done' },
];

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
}: {
  task: Task;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const done = task.status === 'DONE';
  const cancelled = task.status === 'CANCELLED';
  const pri = PRIORITY_META[task.priority];
  const due = task.dueDate ? formatDueDate(task.dueDate) : null;

  return (
    <div className={cn(
      'group flex items-start gap-3 px-4 py-3 rounded-xl border transition-all',
      done || cancelled
        ? 'bg-muted/20 border-border/20'
        : 'bg-card border-border/30 hover:border-border/50 shadow-sm',
    )}>
      {/* Checkbox */}
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
  const [modalTask, setModalTask] = useState<Task | null | 'new'>('new');
  const [showModal, setShowModal] = useState(false);

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
    loadTasks(filter === 'ALL' ? undefined : filter);
  }, [hydrated, isAuthenticated, filter, loadTasks]);

  const handleToggle = async (task: Task) => {
    const newStatus: TaskStatus = task.status === 'DONE' ? 'TODO' : 'DONE';
    try {
      const updated = (await api.tasks.update(task.id, { status: newStatus })) as Task;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
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

  const visibleTasks = tasks;

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
        <div className="px-6 py-4 border-b border-border/40 flex items-center gap-4 shrink-0">
          <h1 className="text-sm font-semibold text-foreground">Tasks</h1>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={openCreate}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Task
          </Button>
        </div>

        {/* Filter tabs */}
        <div className="px-6 pt-3 pb-0 border-b border-border/30 flex gap-1 shrink-0">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={cn(
                'px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors',
                filter === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground/60 hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Task list */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
              </div>
            ) : visibleTasks.length === 0 ? (
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
                {visibleTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onToggle={() => handleToggle(task)}
                    onEdit={() => openEdit(task)}
                    onDelete={() => handleDelete(task)}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

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
