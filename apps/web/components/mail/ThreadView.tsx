'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  ChevronsDownUp,
  ChevronsUpDown,
  Paperclip,
  FileText,
  Image as ImageIcon,
  File,
  Table2,
  Presentation,
  Archive,
  Download,
  Plus,
  ListTodo,
  ExternalLink,
  Eye,
  Video,
  Music,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';
import ThreadHeader, { type ThreadParticipant } from './ThreadHeader';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import MailDetail from './MailDetail';
import TaskModal, { type Task, PRIORITY_META } from '@/components/tasks/TaskModal';

const MAX_VISIBLE = 50;

// ─── File-type grouping ───────────────────────────────────────────────────────

type FileGroup = 'Images' | 'PDFs' | 'Documents' | 'Spreadsheets' | 'Presentations' | 'Archives' | 'Other';

interface AttachmentWithSource {
  messageId: string;
  fromName: string | null;
  fromEmail: string;
  receivedAt: string;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

function getFileGroup(mimeType: string, filename: string): FileGroup {
  const mt = mimeType.toLowerCase();
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mt.startsWith('image/')) return 'Images';
  if (mt === 'application/pdf') return 'PDFs';
  if (mt.includes('word') || mt.includes('opendocument.text') || ['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'Documents';
  if (mt.includes('spreadsheet') || mt.includes('excel') || mt.includes('csv') || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'Spreadsheets';
  if (mt.includes('presentation') || mt.includes('powerpoint') || ['ppt', 'pptx', 'odp'].includes(ext)) return 'Presentations';
  if (mt.includes('zip') || mt.includes('tar') || mt.includes('gzip') || mt.includes('rar') || ['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'Archives';
  return 'Other';
}

const GROUP_ORDER: FileGroup[] = ['Images', 'PDFs', 'Documents', 'Spreadsheets', 'Presentations', 'Archives', 'Other'];

type PreviewType = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'csv';

function getPreviewType(mimeType: string, filename: string): PreviewType | null {
  const mt = mimeType.toLowerCase();
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mt.startsWith('image/')) return 'image';
  if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mt === 'text/csv' || ext === 'csv') return 'csv';
  if (mt.startsWith('text/')) return 'text';
  if (mt.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov'].includes(ext)) return 'video';
  if (mt.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'aac', 'm4a'].includes(ext)) return 'audio';
  return null;
}

// Fetches a text blob URL and returns the raw text for rendering
function TextFetcher({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch(url).then((r) => r.text()).then(setText).catch(() => setText('Failed to load file'));
  }, [url]);
  if (text === null) return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40 mx-auto" />;
  return <>{text}</>;
}

// Renders a CSV blob URL as a simple table
function CsvPreview({ url }: { url: string }) {
  const [rows, setRows] = useState<string[][]>([]);
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then((text) => {
        const parsed = text.trim().split('\n').map((line) =>
          line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim()),
        );
        setRows(parsed);
      })
      .catch(() => setRows([['Failed to load CSV']]));
  }, [url]);

  if (rows.length === 0) return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40 mx-auto" />;
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto max-h-80 rounded-lg border border-border/30 text-[12px]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/50">
            {header.map((cell, i) => (
              <th key={i} className="px-3 py-1.5 text-left font-semibold text-foreground/70 border-b border-border/30 whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, 200).map((row, ri) => (
            <tr key={ri} className="even:bg-muted/20 hover:bg-muted/40 transition-colors">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5 text-foreground/80 border-b border-border/10 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupIcon({ group, className }: { group: FileGroup; className?: string }) {
  const cls = cn('w-4 h-4 shrink-0', className);
  switch (group) {
    case 'Images':        return <ImageIcon className={cn(cls, 'text-violet-400')} />;
    case 'PDFs':          return <FileText className={cn(cls, 'text-red-400')} />;
    case 'Documents':     return <FileText className={cn(cls, 'text-blue-400')} />;
    case 'Spreadsheets':  return <Table2 className={cn(cls, 'text-emerald-400')} />;
    case 'Presentations': return <Presentation className={cn(cls, 'text-orange-400')} />;
    case 'Archives':      return <Archive className={cn(cls, 'text-amber-400')} />;
    default:              return <File className={cn(cls, 'text-muted-foreground/60')} />;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  message: any | null;
  loading?: boolean;
  onClose: () => void;
  onComposeWith: (mode: 'reply' | 'replyAll' | 'forward' | 'new', target: any) => void;
  onDelete: () => void;
  onToggleStar: () => void;
  onMoveToInbox?: () => void;
  folders?: any[];
  onMoveToFolder?: (folderId: string) => void;
  /** Increment to force the thread conversation to re-fetch (e.g. after sending a reply). */
  refreshKey?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ThreadView({
  message,
  loading,
  onClose,
  onComposeWith,
  onDelete,
  onToggleStar,
  onMoveToInbox,
  folders,
  onMoveToFolder,
  refreshKey,
}: Props) {
  const user = useAuthStore((s) => s.user);

  const [threadMessages, setThreadMessages] = useState<ThreadMessageMeta[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);

  // Accordion: only one message expanded at a time (null = all collapsed)
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Expand-all override
  const [expandAll, setExpandAll] = useState(false);

  // Tab: 'overview' | 'messages' | 'attachments'
  const [activeTab, setActiveTab] = useState<'overview' | 'messages' | 'attachments'>('messages');

  // Overview tab: linked tasks
  const [linkedTasks, setLinkedTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  // Attachment preview
  const [previewState, setPreviewState] = useState<{ id: string; filename: string; mimeType: string; url: string } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const router = useRouter();

  const handleAttachmentPreview = useCallback(async (att: AttachmentWithSource) => {
    if (previewState?.id === att.id) {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      setPreviewState(null);
      return;
    }
    setPreviewLoadingId(att.id);
    try {
      const url = await api.mail.downloadAttachment(att.messageId, att.id);
      previewUrlRef.current = url;
      setPreviewState({ id: att.id, filename: att.filename, mimeType: att.mimeType, url });
    } catch {
      toast.error('Failed to load preview');
    } finally {
      setPreviewLoadingId(null);
    }
  }, [previewState]);

  // Track IDs of drafts deleted locally so they are filtered out of subsequent
  // server re-fetches (e.g. triggered by refreshKey after sending a reply).
  // Cleared whenever we navigate to a different conversation.
  const locallyDeletedDraftIds = useRef<Set<string>>(new Set());
  const prevConversationMessageId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!message?.id) return;
    if (!message.conversationId) {
      setThreadMessages([]);
      return;
    }

    // Switching to a new conversation — reset the locally-deleted draft tracker.
    if (prevConversationMessageId.current !== message.id) {
      locallyDeletedDraftIds.current.clear();
      prevConversationMessageId.current = message.id;
    }

    setLoadingThread(true);
    setExpandedId(null);
    setExpandAll(false);
    setActiveTab('messages');
    setLinkedTasks([]);

    api.mail
      .getConversation(message.id)
      .then((data) => {
        // Filter out drafts the user already deleted in this session so a
        // refreshKey-triggered re-fetch doesn't bring them back.
        const msgs: ThreadMessageMeta[] = (data.messages as ThreadMessageMeta[]).filter(
          (m) => !locallyDeletedDraftIds.current.has(m.id),
        );
        if (msgs.length === 0) return;
        setThreadMessages(msgs);
        // Default: expand the newest (chronologically last = visually first)
        setExpandedId(msgs[msgs.length - 1].id);
      })
      .catch((err: any) => {
        toast.error('Could not load thread', { description: err?.message });
      })
      .finally(() => setLoadingThread(false));
  }, [message?.id, message?.conversationId, refreshKey]);

  // Load linked tasks when the Overview tab is active
  useEffect(() => {
    if (activeTab !== 'overview' || !message?.id) return;
    setLoadingTasks(true);
    api.tasks
      .getAll(undefined, message.id)
      .then((data) => setLinkedTasks(data as Task[]))
      .catch(() => { /* non-critical */ })
      .finally(() => setLoadingTasks(false));
  }, [activeTab, message?.id]);

  // Accordion toggle: clicking an open message closes it; clicking a closed one
  // opens it and closes whatever was open before.
  const toggleMessage = useCallback((id: string) => {
    setExpandAll(false);
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandAll((prev) => !prev);
    setExpandedId(null);
  }, []);

  // ── Fallback: single message or conversation not in DB ────────────────────

  const fallback = (
    <MailDetail
      message={message}
      loading={loading}
      onClose={onClose}
      onReply={() => onComposeWith('reply', message)}
      onReplyAll={() => onComposeWith('replyAll', message)}
      onForward={() => onComposeWith('forward', message)}
      onDelete={onDelete}
      onToggleStar={onToggleStar}
      onMoveToInbox={onMoveToInbox}
      folders={folders}
      onMoveToFolder={onMoveToFolder}
    />
  );

  if (!message?.conversationId) return fallback;
  if (loading || (loadingThread && threadMessages.length === 0)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  }
  if (threadMessages.length === 0) return fallback;

  // ── Derived data ──────────────────────────────────────────────────────────

  // Participants (deduplicated, in appearance order)
  const seenEmails = new Set<string>();
  const participants: ThreadParticipant[] = [];
  threadMessages.forEach((m) => {
    if (!seenEmails.has(m.fromEmail)) {
      seenEmails.add(m.fromEmail);
      participants.push({ email: m.fromEmail, name: m.fromName });
    }
    m.toRecipients.forEach((r) => {
      if (!seenEmails.has(r.email)) {
        seenEmails.add(r.email);
        participants.push({ email: r.email, name: r.name ?? null });
      }
    });
  });

  // All attachments with source message info, deduplicated by filename+size
  const seenAtts = new Set<string>();
  const allAttachments: AttachmentWithSource[] = threadMessages.flatMap((m) =>
    (m.attachments ?? [])
      .filter((a) => {
        const key = `${a.filename}:${a.size}`;
        if (seenAtts.has(key)) return false;
        seenAtts.add(key);
        return true;
      })
      .map((a) => ({
        ...a,
        messageId: m.id,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        receivedAt: m.receivedAt,
      })),
  );

  // Group attachments by file type
  const grouped: Partial<Record<FileGroup, AttachmentWithSource[]>> = {};
  allAttachments.forEach((a) => {
    const g = getFileGroup(a.mimeType, a.filename);
    if (!grouped[g]) grouped[g] = [];
    grouped[g]!.push(a);
  });
  const orderedGroups = GROUP_ORDER.filter((g) => grouped[g]?.length);

  // Chronologically last message for header status
  const lastMessage = threadMessages[threadMessages.length - 1];
  const unreadCount = threadMessages.filter((m) => !m.isRead).length;

  // Display order: newest → oldest (reverse of API order)
  const displayMessages = [...threadMessages].reverse();
  const visibleMessages =
    displayMessages.length > MAX_VISIBLE
      ? displayMessages.slice(0, MAX_VISIBLE)
      : displayMessages;
  const hiddenCount = displayMessages.length - visibleMessages.length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Thread header */}
      <ThreadHeader
        subject={message.subject}
        participants={participants}
        messageCount={threadMessages.length}
        unreadCount={unreadCount}
        lastReceivedAt={lastMessage.receivedAt}
        lastSenderEmail={lastMessage.fromEmail}
        currentUserEmail={user?.email ?? ''}
        onClose={onClose}
        onReply={() => onComposeWith('reply', lastMessage)}
        onReplyAll={() => onComposeWith('replyAll', lastMessage)}
        onForward={() => onComposeWith('forward', lastMessage)}
      />

      {/* Tab bar + Expand All */}
      <div className="flex items-center border-b border-border/30 px-4 shrink-0 bg-background">
        {/* Tabs */}
        <div className="flex gap-0 flex-1">
          {(['overview', 'messages', 'attachments'] as const).map((tab) => {
            let label: string;
            if (tab === 'attachments' && allAttachments.length > 0) label = `Attachments (${allAttachments.length})`;
            else if (tab === 'overview') label = 'Overview';
            else label = tab.charAt(0).toUpperCase() + tab.slice(1);
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-3 py-2.5 text-[12px] font-medium border-b-2 transition-colors',
                  activeTab === tab
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground/60 hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Expand All — only on Messages tab */}
        {activeTab === 'messages' && (
          <button
            onClick={handleExpandAll}
            title={expandAll ? 'Collapse all' : 'Expand all'}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
          >
            {expandAll
              ? <><ChevronsDownUp className="w-3.5 h-3.5" /> Collapse all</>
              : <><ChevronsUpDown className="w-3.5 h-3.5" /> Expand all</>
            }
          </button>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Overview tab ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="p-4 flex flex-col gap-4">
            {/* Header row */}
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                Linked Tasks
              </p>
              <button
                onClick={() => setTaskModalOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New Task
              </button>
            </div>

            {loadingTasks ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/30" />
              </div>
            ) : linkedTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
                <ListTodo className="w-7 h-7 text-muted-foreground/20" />
                <p className="text-[13px] text-muted-foreground/50">No tasks linked to this email</p>
                <button
                  onClick={() => setTaskModalOpen(true)}
                  className="mt-1 text-[12px] text-primary hover:underline"
                >
                  Create one
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {linkedTasks.map((task) => {
                  const pri = PRIORITY_META[task.priority];
                  const done = task.status === 'DONE';
                  const cancelled = task.status === 'CANCELLED';
                  return (
                    <div
                      key={task.id}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors',
                        done || cancelled ? 'bg-muted/20 border-border/20' : 'bg-card border-border/30',
                      )}
                    >
                      <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0', pri.cls)}>
                        {pri.label}
                      </span>
                      <span className={cn(
                        'flex-1 text-[13px] min-w-0 truncate',
                        done || cancelled ? 'line-through text-muted-foreground/50' : 'text-foreground',
                      )}>
                        {task.title}
                      </span>
                      <button
                        onClick={() => router.push('/tasks')}
                        className="shrink-0 p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted transition-colors"
                        title="Open in Tasks"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Task modal — create from overview */}
        {taskModalOpen && (
          <TaskModal
            task={null}
            prefill={{ linkedMessageId: message.id, linkedSubject: message.subject ?? '' }}
            onClose={() => setTaskModalOpen(false)}
            onSaved={(saved) => {
              setLinkedTasks((prev) => [saved, ...prev]);
              setTaskModalOpen(false);
            }}
          />
        )}

        {/* ── Messages tab ─────────────────────────────────────────────────── */}
        {activeTab === 'messages' && (
          <>
            {hiddenCount > 0 && (
              <div className="px-4 py-2.5 text-center text-[12px] text-muted-foreground/50 border-b border-border/20 bg-muted/10">
                Showing {MAX_VISIBLE} most recent messages —{' '}
                <span className="font-medium">{hiddenCount}</span> earlier not shown
              </div>
            )}
            {/* Timeline spine — centered behind the 28px-wide avatars in px-4 rows */}
            <div className="relative py-3">
              <div className="absolute left-[30px] top-0 bottom-0 w-px bg-border/25 pointer-events-none" />
              {visibleMessages.map((msg) => (
              <ThreadMessage
                key={msg.id}
                message={msg}
                isExpanded={!msg.isDraft && (expandAll || expandedId === msg.id)}
                onToggle={() => { if (!msg.isDraft) toggleMessage(msg.id); }}
                onReply={(detail) => onComposeWith('reply', detail ?? msg)}
                onReplyAll={(detail) => onComposeWith('replyAll', detail ?? msg)}
                onForward={(detail) => onComposeWith('forward', detail ?? msg)}
                onDelete={msg.isDraft
                  ? async () => {
                      try {
                        await api.mail.discardDraft(msg.zimbraId);
                        locallyDeletedDraftIds.current.add(msg.id);
                        setThreadMessages((prev) => prev.filter((m) => m.id !== msg.id));
                        toast.success('Draft deleted');
                      } catch {
                        toast.error('Failed to delete draft');
                      }
                    }
                  : onDelete}
                onToggleStar={onToggleStar}
                onOpenDraft={msg.isDraft
                  ? (draftMsg) => {
                      // Build a ComposeMessage-compatible object so ComposeModal can pre-fill
                      onComposeWith('new', {
                        ...draftMsg,
                        bodyHtml: null,
                        bodyText: draftMsg.snippet,
                        // Signal this is a draft edit so ComposeModal picks it up
                        _isDraftEdit: true,
                      });
                    }
                  : undefined}
              />
              ))}
            </div>
          </>
        )}

        {/* ── Attachments tab ───────────────────────────────────────────────── */}
        {activeTab === 'attachments' && (
          <div className="p-4">
            {allAttachments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <Paperclip className="w-8 h-8 text-muted-foreground/20" />
                <p className="text-[13px] text-muted-foreground/50">No attachments in this thread</p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {orderedGroups.map((group) => (
                  <div key={group}>
                    {/* Group header */}
                    <div className="flex items-center gap-2 mb-2">
                      <GroupIcon group={group} />
                      <span className="text-[12px] font-semibold text-foreground/70 uppercase tracking-wide">
                        {group}
                      </span>
                      <span className="text-[11px] text-muted-foreground/40">
                        ({grouped[group]!.length})
                      </span>
                    </div>

                    {/* Attachment rows */}
                    <div className="flex flex-col gap-1">
                      {grouped[group]!.map((att) => {
                        const pt = getPreviewType(att.mimeType, att.filename);
                        const isActive = previewState?.id === att.id;
                        return (
                          <div key={`${att.messageId}-${att.id}`}>
                            <div
                              className={cn(
                                'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors group',
                                isActive ? 'bg-primary/5 border border-primary/20' : 'bg-muted/30 hover:bg-muted/60 border border-transparent',
                              )}
                            >
                              <GroupIcon group={group} className="opacity-60" />
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] text-foreground truncate">{att.filename}</p>
                                <p className="text-[11px] text-muted-foreground/50 truncate">
                                  {att.fromName ?? att.fromEmail}
                                  {att.size > 0 && ` · ${formatBytes(att.size)}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                                {pt && (
                                  <button
                                    onClick={() => handleAttachmentPreview(att)}
                                    disabled={!!previewLoadingId}
                                    className={cn(
                                      'p-1.5 rounded-md transition-colors disabled:opacity-30',
                                      isActive ? 'text-primary' : 'text-muted-foreground/40 hover:text-foreground hover:bg-muted',
                                    )}
                                    aria-label={isActive ? 'Close preview' : 'Preview'}
                                  >
                                    {previewLoadingId === att.id
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : pt === 'video' ? <Video className="w-3.5 h-3.5" />
                                      : pt === 'audio' ? <Music className="w-3.5 h-3.5" />
                                      : <Eye className="w-3.5 h-3.5" />}
                                  </button>
                                )}
                                <button
                                  onClick={() =>
                                    api.mail
                                      .downloadAttachment(att.messageId, att.id)
                                      .then((url) => {
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = att.filename;
                                        a.click();
                                        setTimeout(() => URL.revokeObjectURL(url), 5_000);
                                      })
                                      .catch(() => toast.error('Download failed'))
                                  }
                                  className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted transition-all"
                                  aria-label={`Download ${att.filename}`}
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {/* Inline preview panel */}
                            {isActive && previewState && (
                              <div className="mt-1 mb-2 border border-border/40 rounded-xl overflow-hidden bg-card">
                                <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-muted/20">
                                  <span className="text-[12px] font-medium text-foreground/70 truncate flex-1 mr-3">
                                    {previewState.filename}
                                  </span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      onClick={() =>
                                        api.mail.downloadAttachment(att.messageId, att.id).then((url) => {
                                          const a = document.createElement('a');
                                          a.href = url;
                                          a.download = att.filename;
                                          a.click();
                                          setTimeout(() => URL.revokeObjectURL(url), 5_000);
                                        })
                                      }
                                      className="p-1 rounded text-muted-foreground/45 hover:text-foreground transition-colors"
                                      title="Download"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => {
                                        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
                                        previewUrlRef.current = null;
                                        setPreviewState(null);
                                      }}
                                      className="p-1 rounded text-muted-foreground/45 hover:text-foreground transition-colors"
                                      title="Close"
                                    >
                                      <Download className="w-3.5 h-3.5 rotate-180" />
                                    </button>
                                  </div>
                                </div>
                                <div className="p-3 bg-muted/10">
                                  {(() => {
                                    const pt2 = getPreviewType(previewState.mimeType, previewState.filename);
                                    if (pt2 === 'image') return (
                                      <img src={previewState.url} alt={previewState.filename} className="max-w-full h-auto rounded-lg block mx-auto" style={{ maxHeight: 480 }} />
                                    );
                                    if (pt2 === 'video') return (
                                      <video controls src={previewState.url} className="w-full rounded-lg" style={{ maxHeight: 400 }} />
                                    );
                                    if (pt2 === 'audio') return (
                                      <audio controls src={previewState.url} className="w-full mt-2" />
                                    );
                                    if (pt2 === 'csv') return <CsvPreview url={previewState.url} />;
                                    if (pt2 === 'text') return (
                                      <pre className="text-[12px] text-foreground/80 whitespace-pre-wrap font-mono overflow-auto max-h-80 bg-muted/20 rounded-lg p-3">
                                        <TextFetcher url={previewState.url} />
                                      </pre>
                                    );
                                    return (
                                      <embed src={previewState.url} type={previewState.mimeType} className="w-full rounded-lg border-0" style={{ height: 500 }} />
                                    );
                                  })()}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
