'use client';

import { useState, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from 'sonner';
import {
  Loader2, Check, X, User, Mail,
  Plus, Trash2, Square, CheckSquare, MessageSquare, ExternalLink,
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

export interface TaskAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
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
  assignees: { email: string; name?: string }[] | null;
  attachments: TaskAttachment[] | null;
  recurrence: string | null;
  recurrenceEndDate: string | null;
  reminderAt: string | null;
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
  recurrence: string;
  recurrenceEndDate: string;
  reminderOffset: string; // '' | '15' | '30' | '60' | '1440' (minutes before due)
}

export const EMPTY_FORM: TaskForm = {
  title: '',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  dueDate: '',
  linkedMessageId: '',
  linkedSubject: '',
  recurrence: '',
  recurrenceEndDate: '',
  reminderOffset: '',
};

const REMINDER_PRESETS = ['15', '30', '60', '1440'] as const;

export const PRIORITY_META: Record<TaskPriority, { label: string; cls: string }> = {
  LOW:    { label: 'Low',    cls: 'bg-muted text-ink-2' },
  MEDIUM: { label: 'Medium', cls: 'bg-primary/10 text-primary' },
  HIGH:   { label: 'High',   cls: 'bg-warning/15 text-warning-strong' },
  URGENT: { label: 'Urgent', cls: 'bg-destructive/10 text-destructive' },
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
  open,
  task,
  onClose,
  onSaved,
  prefill,
  onCreateOverride,
}: {
  open: boolean;
  task: Task | null;
  onClose: () => void;
  onSaved: (t: Task) => void;
  prefill?: {
    linkedMessageId?: string;
    linkedSubject?: string;
    title?: string;
    description?: string;
    dueDate?: string; // ISO or YYYY-MM-DD
    priority?: TaskPriority;
  };
  /** When set, create-mode save goes through this instead of api.tasks.create.
   *  (Edit mode ignores it.) Caller returns the created Task. */
  onCreateOverride?: (payload: Record<string, unknown>) => Promise<Task>;
}) {
  const currentUser = useAuthStore((s) => s.user);

  const [form, setForm] = useState<TaskForm>(() => {
    if (task) {
      // Reverse-compute reminderOffset from task.reminderAt and task.dueDate
      let reminderOffset = '';
      if (task.reminderAt && task.dueDate) {
        const offsetMin = Math.round(
          (new Date(task.dueDate).getTime() - new Date(task.reminderAt).getTime()) / 60000,
        );
        if ((REMINDER_PRESETS as readonly string[]).includes(String(offsetMin))) {
          reminderOffset = String(offsetMin);
        }
      }
      return {
        title: task.title,
        description: task.description ?? '',
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
        linkedMessageId: task.linkedMessageId ?? '',
        linkedSubject: task.linkedSubject ?? '',
        recurrence: task.recurrence ?? '',
        recurrenceEndDate: task.recurrenceEndDate ? task.recurrenceEndDate.slice(0, 10) : '',
        reminderOffset,
      };
    }
    return {
      ...EMPTY_FORM,
      ...(prefill?.linkedMessageId ? { linkedMessageId: prefill.linkedMessageId } : {}),
      ...(prefill?.linkedSubject ? { linkedSubject: prefill.linkedSubject } : {}),
      ...(prefill?.title ? { title: prefill.title } : {}),
      ...(prefill?.description ? { description: prefill.description } : {}),
      ...(prefill?.dueDate ? { dueDate: prefill.dueDate.slice(0, 10) } : {}),
      ...(prefill?.priority ? { priority: prefill.priority } : {}),
    };
  });
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // ── Multi-assignee state ──────────────────────────────────────────────────────
  const [assignees, setAssignees] = useState<{ email: string; name?: string }[]>(
    () => task?.assignees ?? [],
  );
  const [assigneeInput, setAssigneeInput] = useState('');
  const [autocomplete, setAutocomplete] = useState<Array<{ email: string; display: string }>>([]);
  const [showAc, setShowAc] = useState(false);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Attachment state ─────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<TaskAttachment[]>(task?.attachments ?? []);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleAssigneeInputChange = (v: string) => {
    setAssigneeInput(v);
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

  const addAssignee = (email: string, name?: string) => {
    const clean = email.trim().toLowerCase();
    if (!clean || assignees.some((a) => a.email.toLowerCase() === clean)) return;
    setAssignees((prev) => [...prev, { email: clean, name: name || undefined }]);
    setAssigneeInput('');
    setAutocomplete([]);
    setShowAc(false);
  };

  const removeAssignee = (email: string) => {
    setAssignees((prev) => prev.filter((a) => a.email !== email));
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

  // ── Attachment actions ──────────────────────────────────────────────────────

  const handleFileUpload = useCallback(async (files: FileList | null) => {
    if (!task || !files?.length) return;
    const arr = Array.from(files);
    if (arr.length + attachments.length > 5) {
      toast.error('Maximum 5 attachments per task');
      return;
    }
    const oversized = arr.filter((f) => f.size > 5 * 1024 * 1024);
    if (oversized.length) {
      toast.error('Each file must be under 5 MB');
      return;
    }
    setUploadingFiles(true);
    try {
      const updated = await api.tasks.uploadAttachments(task.id, arr) as Task;
      setAttachments(updated.attachments ?? []);
      toast.success(`${arr.length} file${arr.length > 1 ? 's' : ''} attached`);
    } catch (err: any) {
      toast.error('Failed to upload', { description: err?.message });
    } finally {
      setUploadingFiles(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [task, attachments.length]);

  const handleDeleteAttachment = async (attId: string) => {
    if (!task) return;
    try {
      await api.tasks.deleteAttachment(task.id, attId);
      setAttachments((prev) => prev.filter((a) => a.id !== attId));
    } catch (err: any) {
      toast.error('Failed to delete attachment', { description: err?.message });
    }
  };

  const handleDownloadAttachment = async (att: TaskAttachment) => {
    if (!task) return;
    try {
      const url = await api.tasks.downloadAttachment(task.id, att.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      toast.error('Failed to download', { description: err?.message });
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    if (form.reminderOffset && !form.dueDate) {
      toast.error('Set a due date before adding a reminder');
      return;
    }
    setSaving(true);
    try {
      // Compute reminderAt from dueDate - reminderOffset
      let reminderAt: string | undefined;
      if (form.reminderOffset && form.dueDate) {
        const dueMs = new Date(form.dueDate).getTime();
        const offsetMs = parseInt(form.reminderOffset, 10) * 60 * 1000;
        reminderAt = new Date(dueMs - offsetMs).toISOString();
      } else if (!form.reminderOffset) {
        reminderAt = undefined; // will not be sent unless field was present
      }

      const payload = {
        title: form.title.trim(),
        description: form.description || undefined,
        status: form.status,
        priority: form.priority,
        dueDate: form.dueDate || undefined,
        linkedMessageId: form.linkedMessageId || undefined,
        linkedSubject: form.linkedSubject || undefined,
        recurrence: form.recurrence || undefined,
        recurrenceEndDate: form.recurrenceEndDate || undefined,
        ...(reminderAt !== undefined ? { reminderAt } : {}),
      };

      // Compute newly added assignees for email notification
      const oldAssignees = task?.assignees ?? [];
      const oldEmails = new Set(oldAssignees.map((a) => a.email.toLowerCase()));
      const newlyAdded = assignees.filter((a) => !oldEmails.has(a.email.toLowerCase()));

      let saved: Task;
      if (task) {
        // assign() is called BEFORE update so it can diff against the old DB state
        const assigneesChanged =
          assignees.length !== oldAssignees.length ||
          newlyAdded.length > 0 ||
          oldAssignees.some((a) => !assignees.find((b) => b.email === a.email));
        if (assigneesChanged) {
          setAssigning(true);
          try {
            await api.tasks.assign(task.id, assignees);
          } catch (err: any) {
            toast.warning('Task saved, but notification emails failed', { description: err?.message });
          } finally {
            setAssigning(false);
          }
        }
        saved = (await api.tasks.update(task.id, payload)) as Task;
        toast.success(newlyAdded.length > 0 ? 'Task updated and assignees notified' : 'Task updated');
        saved = { ...saved, subtasks, comments, assignees };
      } else {
        saved = (await (onCreateOverride ?? api.tasks.create)(payload)) as Task;
        // Create buffered subtasks
        const createdSubtasks: Subtask[] = [];
        for (const title of pendingSubtasks) {
          try {
            const s = await api.tasks.createSubtask(saved.id, title) as Subtask;
            createdSubtasks.push(s);
          } catch { /* non-fatal */ }
        }
        saved = { ...saved, subtasks: createdSubtasks, comments: [], assignees };

        if (assignees.length > 0) {
          setAssigning(true);
          try {
            const withAssign = (await api.tasks.assign(saved.id, assignees)) as Task;
            saved = { ...saved, ...withAssign, subtasks: createdSubtasks, comments: [], assignees };
            toast.success('Task created and assignees notified');
          } catch (err: any) {
            toast.warning('Task created, but notification emails failed', { description: err?.message });
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
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="sm:max-w-[480px] p-0 gap-0 flex flex-col"
      >
        {/* Header */}
        <SheetHeader className="flex-row items-center justify-between px-5 py-4 border-b border-border/40 space-y-0 gap-0">
          <SheetTitle className="text-sm font-semibold">
            {task ? 'Edit Task' : 'New Task'}
          </SheetTitle>
          <SheetClose asChild>
            <button className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </SheetClose>
        </SheetHeader>

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
                <Select value={form.status} onValueChange={(v) => set('status')(v as TaskStatus)}>
                  <SelectTrigger size="sm" className="h-9 text-sm bg-muted/30 border-border/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STATUS_META) as TaskStatus[]).map((s) => (
                      <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Priority">
                <Select value={form.priority} onValueChange={(v) => set('priority')(v as TaskPriority)}>
                  <SelectTrigger size="sm" className="h-9 text-sm bg-muted/30 border-border/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PRIORITY_META) as TaskPriority[]).map((p) => (
                      <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field label="Due date">
              <DateTimePicker
                value={form.dueDate}
                onChange={set('dueDate')}
                dateOnly
                className="h-9 text-sm"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Recurrence">
                <Select value={form.recurrence || '__none__'} onValueChange={(v) => set('recurrence')(v === '__none__' ? '' : v)}>
                  <SelectTrigger size="sm" className="h-9 text-sm bg-muted/30 border-border/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    <SelectItem value="DAILY">Daily</SelectItem>
                    <SelectItem value="WEEKLY">Weekly</SelectItem>
                    <SelectItem value="MONTHLY">Monthly</SelectItem>
                    <SelectItem value="YEARLY">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Reminder">
                <Select
                  value={form.reminderOffset || '__none__'}
                  onValueChange={(v) => set('reminderOffset')(v === '__none__' ? '' : v)}
                  disabled={!form.dueDate}
                >
                  <SelectTrigger size="sm" className="h-9 text-sm bg-muted/30 border-border/50 disabled:opacity-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    <SelectItem value="15">15 min before</SelectItem>
                    <SelectItem value="30">30 min before</SelectItem>
                    <SelectItem value="60">1 hour before</SelectItem>
                    <SelectItem value="1440">1 day before</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {form.recurrence && (
              <Field label="Repeat until (optional)">
                <DateTimePicker
                  value={form.recurrenceEndDate}
                  onChange={set('recurrenceEndDate')}
                  dateOnly
                  className="h-9 text-sm"
                />
              </Field>
            )}

            {/* Subtasks section */}
            <div className="pt-1 border-t border-border/30 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Subtasks {subtasks.length > 0 && `(${subtasks.filter((s) => s.completed).length}/${subtasks.length})`}
                </p>
                <button
                  type="button"
                  onClick={() => setShowSubtaskInput(true)}
                  className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground/50 hover:text-primary transition-colors"
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

            <Field label="Linked email">
              <div className="flex items-center gap-2">
                <Input
                  value={form.linkedSubject}
                  onChange={(e) => set('linkedSubject')(e.target.value)}
                  placeholder="Paste or type the email subject…"
                  className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20 flex-1 min-w-0"
                />
                {form.linkedMessageId && (
                  <a
                    href={`/mail?open=${encodeURIComponent(form.linkedMessageId)}`}
                    title="Open linked email"
                    className="shrink-0 h-9 w-9 flex items-center justify-center rounded-md border border-border/50 bg-muted/30 text-muted-foreground/60 hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </Field>

            {/* Assignee section */}
            <div className="pt-1 border-t border-border/30 space-y-3">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Assignees
              </p>

              {/* Existing assignee chips */}
              {assignees.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {assignees.map((a) => (
                    <span
                      key={a.email}
                      className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs text-foreground/80"
                    >
                      <User className="w-3 h-3 text-primary/60 shrink-0" />
                      <span className="truncate max-w-[140px]" title={a.email}>
                        {a.name ?? a.email}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAssignee(a.email)}
                        className="ml-0.5 text-muted-foreground/50 hover:text-destructive transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Add assignee input */}
              <div className="relative">
                <Input
                  value={assigneeInput}
                  onChange={(e) => handleAssigneeInputChange(e.target.value)}
                  onBlur={() => setTimeout(() => setShowAc(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addAssignee(assigneeInput);
                    }
                  }}
                  placeholder="Add colleague email…"
                  type="email"
                  className="h-9 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                />
                {showAc && (
                  <div className="absolute top-full left-0 right-0 z-10 mt-1 bg-popover border border-border/50 rounded-lg shadow-lg overflow-hidden">
                    {autocomplete.map((c) => (
                      <button
                        key={c.email}
                        type="button"
                        onMouseDown={() => addAssignee(c.email, c.display)}
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

              {assignees.length > 0 && (
                <p className="text-[0.6875rem] text-muted-foreground/55 flex items-center gap-1.5">
                  <Mail className="w-3 h-3" />
                  Notification emails will be sent to new assignees
                </p>
              )}
            </div>

            {/* Attachments — only in edit mode (needs a task ID) */}
            {task && (
              <div className="pt-1 border-t border-border/30 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    Attachments{attachments.length > 0 && ` (${attachments.length}/5)`}
                  </p>
                  {attachments.length < 5 && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingFiles}
                      className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      {uploadingFiles
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Plus className="w-3 h-3" />}
                      Attach
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileUpload(e.target.files)}
                />
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {attachments.map((att) => (
                      <div
                        key={att.id}
                        className="group flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/40 border border-border/40 text-xs max-w-[200px]"
                      >
                        <button
                          type="button"
                          onClick={() => handleDownloadAttachment(att)}
                          className="text-foreground/70 hover:text-primary truncate"
                          title={att.filename}
                        >
                          {att.filename}
                        </button>
                        <span className="text-muted-foreground/40 text-[0.625rem] shrink-0">
                          {(att.size / 1024).toFixed(0)}KB
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeleteAttachment(att.id)}
                          className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Comments — only in edit mode */}
            {task && (
              <div className="pt-1 border-t border-border/30 space-y-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-3.5 h-3.5 text-muted-foreground/50" />
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    Comments {comments.length > 0 && `(${comments.length})`}
                  </p>
                </div>

                {comments.length > 0 && (
                  <div className="space-y-3">
                    {comments.map((c) => (
                      <div key={c.id} className="group flex gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                          <span className="text-[0.625rem] font-semibold text-primary">
                            {c.authorName.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-medium text-foreground">{c.authorName}</span>
                            <span className="text-[0.625rem] text-muted-foreground/40">
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
                          <p className="text-sm text-foreground/80 mt-0.5 wrap-break-word">{c.body}</p>
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
        <SheetFooter className="flex-row items-center justify-end gap-2 px-5 py-3 border-t border-border/40 space-y-0">
          <SheetClose asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={isLoading}
              className="text-muted-foreground/60 hover:text-foreground h-8 text-xs"
            >
              Cancel
            </Button>
          </SheetClose>
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
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
