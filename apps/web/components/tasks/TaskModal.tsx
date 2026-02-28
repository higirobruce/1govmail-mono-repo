'use client';

import { useState, useRef } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Loader2, Check, X, User, Mail, ChevronDown,
  Plus, Trash2, Square, CheckSquare, MessageSquare,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskStatus   = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  userId: string;
  authorName: string;
  authorEmail: string;
  body: string;
  createdAt: string;
}

export interface Task {
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
  subtasks: Subtask[];
  comments: TaskComment[];
}

export interface TaskForm {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  linkedMessageId: string;
  linkedSubject: string;
  assignedToEmail: string;
  assignedToName: string;
}

export const EMPTY_FORM: TaskForm = {
  title: '',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  dueDate: '',
  linkedMessageId: '',
  linkedSubject: '',
  assignedToEmail: '',
  assignedToName: '',
};

export const PRIORITY_META: Record<TaskPriority, { label: string; cls: string }> = {
  LOW:    { label: 'Low',    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  MEDIUM: { label: 'Medium', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' },
  HIGH:   { label: 'High',   cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300' },
  URGENT: { label: 'Urgent', cls: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300' },
};

export const STATUS_META: Record<TaskStatus, { label: string }> = {
  TODO:        { label: 'To Do' },
  IN_PROGRESS: { label: 'In Progress' },
  DONE:        { label: 'Done' },
  CANCELLED:   { label: 'Cancelled' },
};

// ── Field helper ───────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">{label}</Label>
      {children}
    </div>
  );
}

// ── TaskModal ──────────────────────────────────────────────────────────────────

export default function TaskModal({
  task,
  onClose,
  onSaved,
  prefill,
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: (t: Task) => void;
  prefill?: { linkedMessageId?: string; linkedSubject?: string };
}) {
  const currentUser = useAuthStore((s) => s.user);

  const [form, setForm] = useState<TaskForm>(
    task
      ? {
          title: task.title,
          description: task.description ?? '',
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
          linkedMessageId: task.linkedMessageId ?? '',
          linkedSubject: task.linkedSubject ?? '',
          assignedToEmail: task.assignedToEmail ?? '',
          assignedToName: task.assignedToName ?? '',
        }
      : {
          ...EMPTY_FORM,
          ...(prefill?.linkedMessageId ? { linkedMessageId: prefill.linkedMessageId } : {}),
          ...(prefill?.linkedSubject ? { linkedSubject: prefill.linkedSubject } : {}),
        },
  );
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [autocomplete, setAutocomplete] = useState<Array<{ email: string; display: string }>>([]);
  const [showAc, setShowAc] = useState(false);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Subtasks state ──────────────────────────────────────────────────────────
  const [subtasks, setSubtasks] = useState<Subtask[]>(task?.subtasks ?? []);
  // pending subtasks for new tasks (not yet saved)
  const [pendingSubtasks, setPendingSubtasks] = useState<string[]>([]);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [showSubtaskInput, setShowSubtaskInput] = useState(false);

  // ── Comments state ──────────────────────────────────────────────────────────
  const [comments, setComments] = useState<TaskComment[]>(task?.comments ?? []);
  const [commentBody, setCommentBody] = useState('');
  const [postingComment, setPostingComment] = useState(false);

  const set = <K extends keyof TaskForm>(k: K) => (v: TaskForm[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

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

  // ── Subtask actions ─────────────────────────────────────────────────────────

  const handleAddSubtask = async () => {
    const title = newSubtaskTitle.trim();
    if (!title) return;
    setNewSubtaskTitle('');
    setShowSubtaskInput(false);

    if (task) {
      // Existing task — create immediately
      try {
        const s = await api.tasks.createSubtask(task.id, title) as Subtask;
        setSubtasks((prev) => [...prev, s]);
      } catch (err: any) {
        toast.error('Failed to add subtask', { description: err?.message });
      }
    } else {
      // New task — buffer locally
      setPendingSubtasks((prev) => [...prev, title]);
      setSubtasks((prev) => [
        ...prev,
        { id: `pending-${Date.now()}`, taskId: '', title, completed: false, createdAt: new Date().toISOString() },
      ]);
    }
  };

  const handleToggleSubtask = async (s: Subtask) => {
    if (!task) {
      // For new tasks, just toggle locally (they'll be created on save)
      setSubtasks((prev) => prev.map((x) => x.id === s.id ? { ...x, completed: !x.completed } : x));
      return;
    }
    try {
      const updated = await api.tasks.updateSubtask(task.id, s.id, { completed: !s.completed }) as Subtask;
      setSubtasks((prev) => prev.map((x) => x.id === s.id ? updated : x));
    } catch (err: any) {
      toast.error('Failed to update subtask', { description: err?.message });
    }
  };

  const handleDeleteSubtask = async (s: Subtask) => {
    if (!task || s.id.startsWith('pending-')) {
      setPendingSubtasks((prev) => prev.filter((t) => t !== s.title));
      setSubtasks((prev) => prev.filter((x) => x.id !== s.id));
      return;
    }
    try {
      await api.tasks.deleteSubtask(task.id, s.id);
      setSubtasks((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err: any) {
      toast.error('Failed to delete subtask', { description: err?.message });
    }
  };

  // ── Comment actions ─────────────────────────────────────────────────────────

  const handlePostComment = async () => {
    if (!task || !commentBody.trim()) return;
    setPostingComment(true);
    try {
      const c = await api.tasks.createComment(task.id, commentBody.trim()) as TaskComment;
      setComments((prev) => [...prev, c]);
      setCommentBody('');
    } catch (err: any) {
      toast.error('Failed to post comment', { description: err?.message });
    } finally {
      setPostingComment(false);
    }
  };

  const handleDeleteComment = async (c: TaskComment) => {
    if (!task) return;
    try {
      await api.tasks.deleteComment(task.id, c.id);
      setComments((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err: any) {
      toast.error('Failed to delete comment', { description: err?.message });
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────

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
        linkedMessageId: form.linkedMessageId || undefined,
        linkedSubject: form.linkedSubject || undefined,
        assignedToEmail: form.assignedToEmail || undefined,
        assignedToName: form.assignedToName || undefined,
      };

      let saved: Task;
      if (task) {
        saved = (await api.tasks.update(task.id, payload)) as Task;
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
        // Attach current subtasks/comments so parent state is up to date
        saved = { ...saved, subtasks, comments };
      } else {
        saved = (await api.tasks.create(payload)) as Task;
        // Create buffered subtasks
        const createdSubtasks: Subtask[] = [];
        for (const title of pendingSubtasks) {
          try {
            const s = await api.tasks.createSubtask(saved.id, title) as Subtask;
            createdSubtasks.push(s);
          } catch { /* non-fatal */ }
        }
        saved = { ...saved, subtasks: createdSubtasks, comments: [] };

        if (form.assignedToEmail) {
          setAssigning(true);
          try {
            const withAssign = (await api.tasks.assign(saved.id, form.assignedToEmail, form.assignedToName || undefined)) as Task;
            saved = { ...saved, ...withAssign, subtasks: createdSubtasks, comments: [] };
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

            {/* Subtasks section */}
            <div className="pt-1 border-t border-border/30 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Subtasks {subtasks.length > 0 && `(${subtasks.filter((s) => s.completed).length}/${subtasks.length})`}
                </p>
                <button
                  type="button"
                  onClick={() => setShowSubtaskInput(true)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-primary transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>

              {subtasks.length > 0 && (
                <div className="space-y-1">
                  {subtasks.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 group">
                      <button
                        type="button"
                        onClick={() => handleToggleSubtask(s)}
                        className="shrink-0 text-muted-foreground/50 hover:text-primary transition-colors"
                      >
                        {s.completed
                          ? <CheckSquare className="w-4 h-4 text-primary" />
                          : <Square className="w-4 h-4" />}
                      </button>
                      <span className={`flex-1 text-sm ${s.completed ? 'line-through text-muted-foreground/40' : 'text-foreground'}`}>
                        {s.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteSubtask(s)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {showSubtaskInput && (
                <div className="flex items-center gap-2">
                  <Input
                    value={newSubtaskTitle}
                    onChange={(e) => setNewSubtaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddSubtask(); }
                      if (e.key === 'Escape') { setShowSubtaskInput(false); setNewSubtaskTitle(''); }
                    }}
                    placeholder="Subtask title…"
                    autoFocus
                    className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                  />
                  <button
                    type="button"
                    onClick={handleAddSubtask}
                    className="shrink-0 text-primary hover:text-primary/70 transition-colors"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowSubtaskInput(false); setNewSubtaskTitle(''); }}
                    className="shrink-0 text-muted-foreground/50 hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

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

            {/* Comments — only in edit mode */}
            {task && (
              <div className="pt-1 border-t border-border/30 space-y-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-3.5 h-3.5 text-muted-foreground/50" />
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    Comments {comments.length > 0 && `(${comments.length})`}
                  </p>
                </div>

                {comments.length > 0 && (
                  <div className="space-y-3">
                    {comments.map((c) => (
                      <div key={c.id} className="group flex gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                          <span className="text-[10px] font-semibold text-primary">
                            {c.authorName.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-medium text-foreground">{c.authorName}</span>
                            <span className="text-[10px] text-muted-foreground/40">
                              {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                            </span>
                            {currentUser?.id === c.userId && (
                              <button
                                type="button"
                                onClick={() => handleDeleteComment(c)}
                                className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          <p className="text-sm text-foreground/80 mt-0.5 break-words">{c.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <textarea
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder="Add a comment…"
                    rows={2}
                    className="w-full text-sm bg-muted/30 border border-border/50 rounded-md px-3 py-2 resize-none focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 text-foreground placeholder:text-muted-foreground/40"
                  />
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handlePostComment}
                      disabled={!commentBody.trim() || postingComment}
                      className="h-7 text-xs gap-1"
                    >
                      {postingComment ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      Post
                    </Button>
                  </div>
                </div>
              </div>
            )}
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
