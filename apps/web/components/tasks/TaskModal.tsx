'use client';

import { useState, useRef } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { Loader2, Check, X, User, Mail, ChevronDown } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskStatus   = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

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
      } else {
        saved = (await api.tasks.create(payload)) as Task;
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
