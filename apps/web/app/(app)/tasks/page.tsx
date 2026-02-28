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
  Plus, Loader2, ListTodo, Pencil, Trash2, Check,
  Calendar, User, Mail, Link, X, ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

type TaskStatus   = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  completedAt: string | null;
  linkedMessageId: string | null;
  linkedSubject: string | null;
  assignedToEmail: string | null;
  assignedToName: string | null;
  assignedAt: string | null;
  createdAt: string;
}

type FilterTab = 'ALL' | TaskStatus;

interface TaskForm {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  linkedSubject: string;
  assignedToEmail: string;
  assignedToName: string;
}

const EMPTY_FORM: TaskForm = {
  title: '',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  dueDate: '',
  linkedSubject: '',
  assignedToEmail: '',
  assignedToName: '',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const PRIORITY_META: Record<TaskPriority, { label: string; cls: string }> = {
  LOW:    { label: 'Low',    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  MEDIUM: { label: 'Medium', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' },
  HIGH:   { label: 'High',   cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300' },
  URGENT: { label: 'Urgent', cls: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300' },
};

const STATUS_META: Record<TaskStatus, { label: string }> = {
  TODO:        { label: 'To Do' },
  IN_PROGRESS: { label: 'In Progress' },
  DONE:        { label: 'Done' },
  CANCELLED:   { label: 'Cancelled' },
};

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

// ── Form field helpers ─────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">{label}</Label>
      {children}
    </div>
  );
}

// ── Task modal ─────────────────────────────────────────────────────────────────

function TaskModal({
  task,
  onClose,
  onSaved,
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: (t: Task) => void;
}) {
  const [form, setForm] = useState<TaskForm>(
    task
      ? {
          title: task.title,
          description: task.description ?? '',
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
          linkedSubject: task.linkedSubject ?? '',
          assignedToEmail: task.assignedToEmail ?? '',
          assignedToName: task.assignedToName ?? '',
        }
      : { ...EMPTY_FORM },
  );
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [autocomplete, setAutocomplete] = useState<Array<{ email: string; display: string }>>([]);
  const [showAc, setShowAc] = useState(false);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = <K extends keyof TaskForm>(k: K) => (v: TaskForm[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  // Contact autocomplete for assignee email
  const handleAssigneeChange = (v: string) => {
    set('assignedToEmail')(v);
    if (acTimer.current) clearTimeout(acTimer.current);
    if (v.length < 2) { setAutocomplete([]); setShowAc(false); return; }
    acTimer.current = setTimeout(async () => {
      try {
        const results = await api.contacts.autocomplete(v);
        setAutocomplete(results);
        setShowAc(results.length > 0);
      } catch { /* ignore */ }
    }, 250);
  };

  const handleSave = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description || undefined,
        status: form.status,
        priority: form.priority,
        dueDate: form.dueDate || undefined,
        linkedSubject: form.linkedSubject || undefined,
        assignedToEmail: form.assignedToEmail || undefined,
        assignedToName: form.assignedToName || undefined,
      };

      let saved: Task;
      if (task) {
        saved = (await api.tasks.update(task.id, payload)) as Task;

        // If assignee changed and email is set, send notification
        const assigneeChanged = form.assignedToEmail && form.assignedToEmail !== task.assignedToEmail;
        if (assigneeChanged) {
          setAssigning(true);
          try {
            saved = (await api.tasks.assign(saved.id, form.assignedToEmail, form.assignedToName || undefined)) as Task;
            toast.success('Task updated and assignee notified');
          } catch (err: any) {
            toast.warning('Task saved, but notification email failed', { description: err?.message });
          } finally {
            setAssigning(false);
          }
        } else {
          toast.success('Task updated');
        }
      } else {
        saved = (await api.tasks.create(payload)) as Task;

        // Send assignment notification for new tasks if assignee is set
        if (form.assignedToEmail) {
          setAssigning(true);
          try {
            saved = (await api.tasks.assign(saved.id, form.assignedToEmail, form.assignedToName || undefined)) as Task;
            toast.success('Task created and assignee notified');
          } catch (err: any) {
            toast.warning('Task created, but notification email failed', { description: err?.message });
          } finally {
            setAssigning(false);
          }
        } else {
          toast.success('Task created');
        }
      }

      onSaved(saved);
      onClose();
    } catch (err: any) {
      toast.error('Failed to save task', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  const isLoading = saving || assigning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md bg-background border border-border/50 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
          <h2 className="text-sm font-semibold">{task ? 'Edit Task' : 'New Task'}</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-4 space-y-4">
            <Field label="Title *">
              <Input
                value={form.title}
                onChange={(e) => set('title')(e.target.value)}
                placeholder="What needs to be done?"
                className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                autoFocus
              />
            </Field>

            <Field label="Description">
              <textarea
                value={form.description}
                onChange={(e) => set('description')(e.target.value)}
                placeholder="Add details…"
                rows={3}
                className="w-full text-sm bg-muted/30 border border-border/50 rounded-md px-3 py-2 resize-none focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 text-foreground placeholder:text-muted-foreground/40"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">
                <div className="relative">
                  <select
                    value={form.status}
                    onChange={(e) => set('status')(e.target.value as TaskStatus)}
                    className="w-full h-9 text-sm bg-muted/30 border border-border/50 rounded-md px-3 pr-8 appearance-none focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 text-foreground"
                  >
                    {(Object.keys(STATUS_META) as TaskStatus[]).map((s) => (
                      <option key={s} value={s}>{STATUS_META[s].label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40 pointer-events-none" />
                </div>
              </Field>

              <Field label="Priority">
                <div className="relative">
                  <select
                    value={form.priority}
                    onChange={(e) => set('priority')(e.target.value as TaskPriority)}
                    className="w-full h-9 text-sm bg-muted/30 border border-border/50 rounded-md px-3 pr-8 appearance-none focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 text-foreground"
                  >
                    {(Object.keys(PRIORITY_META) as TaskPriority[]).map((p) => (
                      <option key={p} value={p}>{PRIORITY_META[p].label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40 pointer-events-none" />
                </div>
              </Field>
            </div>

            <Field label="Due date">
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => set('dueDate')(e.target.value)}
                className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
              />
            </Field>

            <Field label="Linked email subject">
              <Input
                value={form.linkedSubject}
                onChange={(e) => set('linkedSubject')(e.target.value)}
                placeholder="Paste or type the email subject…"
                className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
              />
            </Field>

            {/* Assignee section */}
            <div className="pt-1 border-t border-border/30 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Assign to colleague
              </p>
              <Field label="Email">
                <div className="relative">
                  <Input
                    value={form.assignedToEmail}
                    onChange={(e) => handleAssigneeChange(e.target.value)}
                    onBlur={() => setTimeout(() => setShowAc(false), 150)}
                    placeholder="colleague@company.com"
                    type="email"
                    className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                  />
                  {showAc && (
                    <div className="absolute top-full left-0 right-0 z-10 mt-1 bg-popover border border-border/50 rounded-lg shadow-lg overflow-hidden">
                      {autocomplete.map((c) => (
                        <button
                          key={c.email}
                          type="button"
                          onMouseDown={() => {
                            set('assignedToEmail')(c.email);
                            set('assignedToName')(c.display);
                            setShowAc(false);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                        >
                          <User className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                          <span className="text-sm text-foreground truncate">{c.display}</span>
                          <span className="text-xs text-muted-foreground/50 truncate ml-auto">{c.email}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              <Field label="Name (optional)">
                <Input
                  value={form.assignedToName}
                  onChange={(e) => set('assignedToName')(e.target.value)}
                  placeholder="Colleague name"
                  className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                />
              </Field>
              {form.assignedToEmail && (
                <p className="text-[11px] text-muted-foreground/55 flex items-center gap-1.5">
                  <Mail className="w-3 h-3" />
                  A notification email will be sent to {form.assignedToEmail}
                </p>
              )}
            </div>
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/40">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isLoading}
            className="text-muted-foreground/60 hover:text-foreground h-8 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isLoading}
            className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs gap-1.5"
          >
            {isLoading
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />{assigning ? 'Sending…' : 'Saving…'}</>
              : <><Check className="w-3.5 h-3.5" />{task ? 'Save' : 'Create'}</>}
          </Button>
        </div>
      </div>
    </div>
  );
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
  const [modalTask, setModalTask] = useState<Task | null | 'new'>('new'); // 'new' = create, Task = edit, null = closed
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

  // Toggle done / todo
  const handleToggle = async (task: Task) => {
    const newStatus: TaskStatus = task.status === 'DONE' ? 'TODO' : 'DONE';
    try {
      const updated = (await api.tasks.update(task.id, { status: newStatus })) as Task;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err: any) {
      toast.error('Failed to update task', { description: err?.message });
    }
  };

  // Delete
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

  // Filter tasks client-side for "ALL" tab (server already filters when status passed)
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
