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
  Mail,
  MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { getAttachmentUrl } from '@/lib/attachmentBlobCache';
import { downloadAll } from '@/lib/downloadAll';
import { getPreviewKind } from '@/lib/attachmentPreviewKind';
import { AttachmentPreview } from './AttachmentPreview';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';
import ThreadHeader, { type ThreadParticipant } from './ThreadHeader';
import { MailAvatar } from './MailAvatar';
import { useAIStore } from '@/stores/ai.store';
import { AIClient } from '@/lib/ai/client';
import { summarizeMessage, summarizeThread } from '@/lib/ai/tasks';
import { useCharStream } from '@/lib/ai/useCharStream';
import { Sparkles, X as XIconSmall } from 'lucide-react';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import MailDetail from './MailDetail';
import ComposeModal from './ComposeModal';
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

// Preview classification and rendering are shared with the lightbox — see
// lib/attachmentPreviewKind and components/mail/AttachmentPreview.

function GroupIcon({ group, className }: { group: FileGroup; className?: string }) {
  const cls = cn('w-4 h-4 shrink-0', className);
  switch (group) {
    case 'Images':        return <ImageIcon className={cn(cls, 'text-file-image')} />;
    case 'PDFs':          return <FileText className={cn(cls, 'text-file-pdf')} />;
    case 'Documents':     return <FileText className={cn(cls, 'text-file-doc')} />;
    case 'Spreadsheets':  return <Table2 className={cn(cls, 'text-file-sheet')} />;
    case 'Presentations': return <Presentation className={cn(cls, 'text-file-slides')} />;
    case 'Archives':      return <Archive className={cn(cls, 'text-file-archive')} />;
    default:              return <File className={cn(cls, 'text-file-generic')} />;
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
  /** Called after an inline reply is sent — the parent invalidates lists and
   *  bumps refreshKey so the sent message appears in the thread. */
  onReplySent?: () => void;
  /** Triggered by the thread toolbar's Quick Reply (AI) button. Should open
   *  compose in 'reply' mode and auto-run the suggestReply task. */
  onQuickReply?: (target: any) => void;
  onDelete: () => void;
  onToggleStar: () => void;
  onMoveToInbox?: () => void;
  folders?: any[];
  onMoveToFolder?: (folderId: string) => void;
  /** Increment to force the thread conversation to re-fetch (e.g. after sending a reply). */
  refreshKey?: number;
  onMute?: () => void;
  isMuted?: boolean;
  onSnooze?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ThreadView({
  message,
  loading,
  onClose,
  onComposeWith,
  onReplySent,
  onQuickReply,
  onDelete,
  onToggleStar,
  onMoveToInbox,
  folders,
  onMoveToFolder,
  refreshKey,
  onMute,
  isMuted,
  onSnooze,
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
  const [downloadingAll, setDownloadingAll] = useState(false);

  // ── AI summarize state ───────────────────────────────────────────────────
  const aiEnabled = useAIStore((s) => s.enabled);
  const aiModel = useAIStore((s) => s.model);
  const aiCustomInstructions = useAIStore((s) => s.customInstructions);
  const {
    text: streamedSummary,
    push: pushSummary,
    reset: resetSummary,
    replace: replaceSummary,
  } = useCharStream();
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summaryAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    summaryAbortRef.current?.abort();
    summaryAbortRef.current = null;
    resetSummary();
    setSummarizing(false);
    setSummaryError(null);
    setSummaryOpen(false);
  }, [message?.id, resetSummary]);

  // Hooks below must run on every render — keep above any conditional returns.
  // Reads `threadMessages` from state inside the body so deps stay shallow.
  const handleSummarize = useCallback(async () => {
    const list = threadMessages;
    if (list.length === 0) return;
    summaryAbortRef.current?.abort();
    const abort = new AbortController();
    summaryAbortRef.current = abort;
    resetSummary();
    setSummaryError(null);
    setSummarizing(true);
    setSummaryOpen(true);

    const activeBody =
      message?.bodyText ?? message?.bodyHtml ?? message?.snippet ?? '';
    const concatenated = list
      .map((m) => {
        const sender = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
        const isActive = m.id === message?.id;
        const content = isActive && activeBody ? activeBody : (m.snippet ?? '');
        const tag = isActive && activeBody ? '(opened)' : '(snippet)';
        return `From: ${sender}\nDate: ${m.receivedAt} ${tag}\n\n${content}`;
      })
      .join('\n\n---\n\n');

    try {
      const client = new AIClient();
      const last = list[list.length - 1];
      const isThread = list.length > 1;
      const fn = isThread ? summarizeThread : summarizeMessage;
      const final = await fn(
        client,
        concatenated,
        {
          model: aiModel,
          subject: message?.subject ?? undefined,
          from: isThread
            ? `Email thread with ${list.length} messages, oldest first`
            : (last?.fromName ?? last?.fromEmail ?? ''),
          customInstructions: aiCustomInstructions,
          signal: abort.signal,
        },
        pushSummary,
      );
      if (!abort.signal.aborted) replaceSummary(final);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      const m = err instanceof Error ? err.message : String(err);
      setSummaryError(m);
    } finally {
      setSummarizing(false);
    }
  }, [threadMessages, aiModel, aiCustomInstructions, message, pushSummary, resetSummary, replaceSummary]);

  const closeSummary = useCallback(() => {
    summaryAbortRef.current?.abort();
    summaryAbortRef.current = null;
    setSummaryOpen(false);
    resetSummary();
    setSummaryError(null);
    setSummarizing(false);
  }, [resetSummary]);

  // Overview tab: linked tasks
  const [linkedTasks, setLinkedTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  // Attachment preview — blob URLs come from the shared attachment cache
  // (LRU-revoked), so toggling a preview closed and open again, or previewing
  // then downloading, never re-downloads the file.
  const [previewState, setPreviewState] = useState<{ id: string; filename: string; mimeType: string; url: string } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);

  const router = useRouter();

  const handleAttachmentPreview = useCallback(async (att: AttachmentWithSource) => {
    if (previewState?.id === att.id) {
      setPreviewState(null);
      return;
    }
    setPreviewLoadingId(att.id);
    try {
      const url = await getAttachmentUrl(att.messageId, att.id, () => api.mail.downloadAttachment(att.messageId, att.id));
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

  // ── Inline reply ───────────────────────────────────────────────────────────
  // Replies compose in-flow, directly below the message being answered —
  // the detached floating window is kept for new messages and forwards.
  const [inlineReply, setInlineReply] = useState<{ mode: 'reply' | 'replyAll'; target: any; initialBody?: string } | null>(null);
  useEffect(() => { setInlineReply(null); }, [message?.id]);

  const inlineComposer = inlineReply && (
    <div
      ref={(el) => el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
      className="mt-2 mb-3"
    >
      <ComposeModal
        inline
        open
        mode={inlineReply.mode}
        originalMessage={inlineReply.target}
        initialBody={inlineReply.initialBody}
        onClose={() => setInlineReply(null)}
        onSent={() => { setInlineReply(null); onReplySent?.(); }}
      />
    </div>
  );

  // ── Fallback: single message or conversation not in DB ────────────────────

  const fallback = (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <MailDetail
          message={message}
          loading={loading}
          onClose={onClose}
          onReply={(initialBody) => setInlineReply({ mode: 'reply', target: message, initialBody })}
          onReplyAll={(initialBody) => setInlineReply({ mode: 'replyAll', target: message, initialBody })}
          onForward={() => onComposeWith('forward', message)}
          onDelete={onDelete}
          onToggleStar={onToggleStar}
          onMoveToInbox={onMoveToInbox}
          folders={folders}
          onMoveToFolder={onMoveToFolder}
          onMute={onMute}
          isMuted={isMuted}
          onSnooze={onSnooze}
        />
      </div>
      {inlineReply && inlineReply.target?.id === message?.id && (
        <div className="shrink-0 overflow-y-auto max-h-[60%] px-4 pb-3">{inlineComposer}</div>
      )}
    </div>
  );

  if (!message?.conversationId) return fallback;
  if (loading || (loadingThread && threadMessages.length === 0)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-ink-4" />
      </div>
    );
  }
  if (threadMessages.length === 0) return fallback;

  // ── Derived data ──────────────────────────────────────────────────────────

  // Participants (deduplicated, in appearance order)
  const seenEmails = new Set<string>();
  const participants: ThreadParticipant[] = [];       // from + to
  const ccParticipants: ThreadParticipant[] = [];     // cc-only
  const seenCcEmails = new Set<string>();
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
    m.ccRecipients.forEach((r) => {
      if (!seenEmails.has(r.email) && !seenCcEmails.has(r.email)) {
        seenCcEmails.add(r.email);
        ccParticipants.push({ email: r.email, name: r.name ?? null });
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

  const handleDownloadAll = async () => {
    if (downloadingAll) return;
    setDownloadingAll(true);
    const items = allAttachments.map((a) => ({ messageId: a.messageId, id: a.id, filename: a.filename }));
    const n = await downloadAll(
      items,
      (mid, aid) => getAttachmentUrl(mid, aid, () => api.mail.downloadAttachment(mid, aid)),
      { onError: (f) => toast.error(`Failed to download ${f}`) },
    );
    if (n > 0) toast.success(`Downloaded ${n} file${n === 1 ? '' : 's'}`);
    setDownloadingAll(false);
  };

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
    <div className="flex flex-col h-full overflow-hidden relative">
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
        onReply={() => { setActiveTab('messages'); setInlineReply({ mode: 'reply', target: lastMessage }); }}
        onReplyAll={() => { setActiveTab('messages'); setInlineReply({ mode: 'replyAll', target: lastMessage }); }}
        onForward={() => onComposeWith('forward', lastMessage)}
        onSummarize={aiEnabled ? handleSummarize : undefined}
        summarizing={summarizing}
        onQuickReply={aiEnabled && onQuickReply ? () => onQuickReply(lastMessage) : undefined}
      />

      {/* Tab bar + Expand All */}
      <div className="flex items-center border-b border-border-faint px-4 shrink-0 bg-background">
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
                  'px-3 py-2.5 text-ui font-medium border-b-2 transition-colors',
                  activeTab === tab
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-ink-3 hover:text-foreground',
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
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-micro font-normal text-ink-3 hover:text-foreground hover:bg-muted transition-colors"
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
          <div className="p-4 flex flex-col gap-5 overflow-y-auto">

            {/* Stats row */}
            <div className="flex items-center gap-3 px-1">
              {[
                { value: threadMessages.length, label: 'message' },
                { value: participants.length,   label: 'participant' },
                { value: allAttachments.length, label: 'attachment' },
              ].map(({ value, label }, i, arr) => (
                <div key={label} className="flex items-center gap-3">
                  <div className="text-center">
                    <p className="text-display font-semibold text-foreground tabular-nums leading-none">{value}</p>
                    <p className="text-micro font-normal text-ink-3 mt-0.5">{label}{value !== 1 ? 's' : ''}</p>
                  </div>
                  {i < arr.length - 1 && <div className="w-px h-8 bg-border-faint" />}
                </div>
              ))}
            </div>

            {/* Participants */}
            <div>
              <p className="text-micro font-semibold text-ink-3 uppercase tracking-[0.06em] mb-2">
                Participants
              </p>
              <div className="flex flex-col gap-0.5">
                {participants.map((p) => {
                  const isMe = p.email === user?.email;
                  return (
                    <div key={p.email} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors group">
                      <MailAvatar name={p.name} email={p.email} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-ui font-medium text-foreground truncate">
                          {isMe ? 'You' : (p.name || p.email)}
                        </p>
                        {!isMe && p.name && (
                          <p className="text-micro font-normal text-ink-3 truncate">{p.email}</p>
                        )}
                      </div>
                      {!isMe && (
                        <button
                          onClick={() => onComposeWith('new', { ...message, toRecipients: [{ email: p.email, name: p.name }] })}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded text-ink-4 hover:text-primary hover:bg-primary/10 transition-all shrink-0"
                          title={`New email to ${p.email}`}
                        >
                          <Mail className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {ccParticipants.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 my-1 px-2">
                      <div className="flex-1 h-px bg-border-faint" />
                      <span className="text-micro font-semibold text-ink-4 uppercase tracking-[0.06em]">CC</span>
                      <div className="flex-1 h-px bg-border-faint" />
                    </div>
                    {ccParticipants.map((p) => {
                      const isMe = p.email === user?.email;
                      return (
                        <div key={p.email} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors group">
                          <MailAvatar name={p.name} email={p.email} size="sm" className="opacity-70" />
                          <div className="flex-1 min-w-0">
                            <p className="text-ui text-ink-2 truncate">
                              {isMe ? 'You' : (p.name || p.email)}
                            </p>
                            {!isMe && p.name && (
                              <p className="text-micro font-normal text-ink-3 truncate">{p.email}</p>
                            )}
                          </div>
                          {!isMe && (
                            <button
                              onClick={() => onComposeWith('new', { ...message, toRecipients: [{ email: p.email, name: p.name }] })}
                              className="opacity-0 group-hover:opacity-100 p-1 rounded text-ink-4 hover:text-primary hover:bg-primary/10 transition-all shrink-0"
                              title={`New email to ${p.email}`}
                            >
                              <Mail className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>

            {/* Linked Tasks */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-micro font-semibold text-ink-3 uppercase tracking-[0.06em]">
                  Linked Tasks
                </p>
                <button
                  onClick={() => setTaskModalOpen(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-ui font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New Task
                </button>
              </div>

              {loadingTasks ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-ink-4" />
                </div>
              ) : linkedTasks.length === 0 ? (
                <div className="flex items-center gap-2.5 px-3 py-3 rounded-xl border border-dashed border-border text-ink-4">
                  <ListTodo className="w-4 h-4 shrink-0" />
                  <span className="text-ui">No tasks linked —{' '}
                    <button onClick={() => setTaskModalOpen(true)} className="text-primary hover:underline">create one</button>
                  </span>
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
                          done || cancelled ? 'bg-muted/20 border-border-faint' : 'bg-card border-border-faint',
                        )}
                      >
                        <span className={cn('text-micro font-medium px-1.5 py-0.5 rounded-full shrink-0', pri.cls)}>
                          {pri.label}
                        </span>
                        <span className={cn(
                          'flex-1 text-ui min-w-0 truncate',
                          done || cancelled ? 'line-through text-ink-3' : 'text-foreground',
                        )}>
                          {task.title}
                        </span>
                        <button
                          onClick={() => router.push('/tasks')}
                          className="shrink-0 p-1 rounded-md text-ink-4 hover:text-foreground hover:bg-muted transition-colors"
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

            {/* Quick reply to thread */}
            <div>
              <p className="text-micro font-semibold text-ink-3 uppercase tracking-[0.06em] mb-2">
                Actions
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setActiveTab('messages'); setInlineReply({ mode: 'reply', target: lastMessage }); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-ui text-ink-2 hover:bg-muted/40 hover:text-foreground transition-colors"
                >
                  <Mail className="w-3.5 h-3.5" />
                  Reply
                </button>
                <button
                  onClick={() => { setActiveTab('messages'); setInlineReply({ mode: 'replyAll', target: lastMessage }); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-ui text-ink-2 hover:bg-muted/40 hover:text-foreground transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Reply all
                </button>
                <button
                  onClick={() => onComposeWith('forward', lastMessage)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-ui text-ink-2 hover:bg-muted/40 hover:text-foreground transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Forward
                </button>
              </div>
            </div>

          </div>
        )}

        {/* Task sheet — create from overview */}
        <TaskModal
          open={taskModalOpen}
          task={null}
          prefill={{ linkedMessageId: message.id, linkedSubject: message.subject ?? '' }}
          onClose={() => setTaskModalOpen(false)}
          onSaved={(saved) => {
            setLinkedTasks((prev) => [saved, ...prev]);
            setTaskModalOpen(false);
          }}
        />

        {/* ── Messages tab ─────────────────────────────────────────────────── */}
        {activeTab === 'messages' && (
          <>
            {hiddenCount > 0 && (
              <div className="px-4 py-2.5 text-center text-ui text-ink-3 border-b border-border-faint bg-muted/10">
                Showing {MAX_VISIBLE} most recent messages —{' '}
                <span className="font-medium">{hiddenCount}</span> earlier not shown
              </div>
            )}
            {/* Timeline spine — centered behind the 28px-wide avatars in px-4 rows */}
            <div className="relative py-3">
              <div className="absolute left-[30px] top-0 bottom-0 w-px bg-border-faint pointer-events-none" />
              {visibleMessages.map((msg) => (
              <div key={msg.id}>
              <ThreadMessage
                message={msg}
                isExpanded={!msg.isDraft && (expandAll || expandedId === msg.id)}
                isOnlyMessage={threadMessages.length === 1}
                onToggle={() => { if (!msg.isDraft) toggleMessage(msg.id); }}
                onMarkedRead={() =>
                  setThreadMessages((prev) =>
                    prev.map((m) => (m.id === msg.id ? { ...m, isRead: true } : m)),
                  )
                }
                onReply={(detail) => setInlineReply({ mode: 'reply', target: detail ?? msg })}
                onReplyAll={(detail) => setInlineReply({ mode: 'replyAll', target: detail ?? msg })}
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
                  // Parent onDelete acts on the SELECTED message — only use it
                  // for that row; other rows delete their own message.
                  : msg.id === message.id
                  ? onDelete
                  : async () => {
                      try {
                        await api.mail.delete(msg.id);
                        locallyDeletedDraftIds.current.add(msg.id);
                        setThreadMessages((prev) => prev.filter((m) => m.id !== msg.id));
                        toast.success('Message moved to Trash');
                      } catch {
                        toast.error('Failed to delete message');
                      }
                    }}
                onToggleStar={async () => {
                  if (msg.id === message.id) {
                    onToggleStar();
                    setThreadMessages((prev) =>
                      prev.map((m) => (m.id === msg.id ? { ...m, isStarred: !m.isStarred } : m)),
                    );
                    return;
                  }
                  const newStarred = !msg.isStarred;
                  setThreadMessages((prev) =>
                    prev.map((m) => (m.id === msg.id ? { ...m, isStarred: newStarred } : m)),
                  );
                  try {
                    // Same persistence call the parent's toggleStar uses.
                    await api.mail.markRead(msg.id, msg.isRead);
                  } catch {
                    setThreadMessages((prev) =>
                      prev.map((m) => (m.id === msg.id ? { ...m, isStarred: !newStarred } : m)),
                    );
                  }
                }}
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
              {/* Inline reply card, directly below the message being answered */}
              {inlineReply && (inlineReply.target?.id ?? message.id) === msg.id && (
                <div className="pl-12 pr-2">{inlineComposer}</div>
              )}
              </div>
              ))}
            </div>
          </>
        )}

        {/* ── Attachments tab ───────────────────────────────────────────────── */}
        {activeTab === 'attachments' && (
          <div className="p-4">
            {allAttachments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <Paperclip className="w-8 h-8 text-ink-4" />
                <p className="text-ui text-ink-3">No attachments in this thread</p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {allAttachments.length > 1 && (
                  <div className="flex items-center">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ml-auto text-primary hover:text-primary"
                      onClick={handleDownloadAll}
                      disabled={downloadingAll}
                    >
                      {downloadingAll ? <Loader2 className="animate-spin" /> : <Download />}
                      Download all
                    </Button>
                  </div>
                )}
                {orderedGroups.map((group) => (
                  <div key={group}>
                    {/* Group header */}
                    <div className="flex items-center gap-2 mb-2">
                      <GroupIcon group={group} />
                      <span className="text-ui font-semibold text-ink-2 uppercase tracking-[0.06em]">
                        {group}
                      </span>
                      <span className="text-micro font-normal text-ink-4">
                        ({grouped[group]!.length})
                      </span>
                    </div>

                    {/* Attachment rows */}
                    <div className="flex flex-col gap-1">
                      {grouped[group]!.map((att) => {
                        const pt = getPreviewKind(att.mimeType, att.filename);
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
                                <p className="text-ui text-foreground truncate">{att.filename}</p>
                                <p className="text-micro font-normal text-ink-3 truncate">
                                  {att.fromName ?? att.fromEmail}
                                  {att.size > 0 && ` · ${formatBytes(att.size)}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                                {pt && (
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    onClick={() => handleAttachmentPreview(att)}
                                    disabled={!!previewLoadingId}
                                    className={cn(
                                      'disabled:opacity-30',
                                      isActive ? 'text-primary' : 'text-ink-3 hover:text-foreground',
                                    )}
                                    aria-label={isActive ? 'Close preview' : 'Preview'}
                                  >
                                    {previewLoadingId === att.id
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : pt === 'video' ? <Video className="w-3.5 h-3.5" />
                                      : pt === 'audio' ? <Music className="w-3.5 h-3.5" />
                                      : <Eye className="w-3.5 h-3.5" />}
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() =>
                                    getAttachmentUrl(att.messageId, att.id, () => api.mail.downloadAttachment(att.messageId, att.id))
                                      .then((url) => {
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = att.filename;
                                        a.click();
                                      })
                                      .catch(() => toast.error('Download failed'))
                                  }
                                  className="text-ink-3 hover:text-foreground"
                                  aria-label={`Download ${att.filename}`}
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </div>

                            {/* Inline preview panel */}
                            {isActive && previewState && (
                              <div className="mt-1 mb-2 border border-border rounded-xl overflow-hidden bg-card">
                                <div className="flex items-center justify-between px-4 py-2 border-b border-border-faint bg-muted/20">
                                  <span className="text-ui font-medium text-ink-2 truncate flex-1 mr-3">
                                    {previewState.filename}
                                  </span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() =>
                                        getAttachmentUrl(att.messageId, att.id, () => api.mail.downloadAttachment(att.messageId, att.id)).then((url) => {
                                          const a = document.createElement('a');
                                          a.href = url;
                                          a.download = att.filename;
                                          a.click();
                                        })
                                      }
                                      className="text-ink-3 hover:text-foreground"
                                      aria-label="Download"
                                      title="Download"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => setPreviewState(null)}
                                      className="text-ink-3 hover:text-foreground"
                                      aria-label="Close"
                                      title="Close"
                                    >
                                      <XIconSmall className="w-3.5 h-3.5" />
                                    </Button>
                                  </div>
                                </div>
                                <div className="p-3 bg-muted/10">
                                  <AttachmentPreview
                                    url={previewState.url}
                                    mimeType={previewState.mimeType}
                                    filename={previewState.filename}
                                    variant="inline"
                                  />
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

      {aiEnabled && (
        <aside
          aria-hidden={!summaryOpen}
          className={cn(
            // Below lg the floating top-right card has no room — render as a
            // fixed bottom sheet instead so tapping Summarize on a phone shows
            // the stream rather than spending tokens into an invisible panel.
            // z-[45]: above the AI drawers (z-40/41), below compose (z-50).
            'fixed inset-x-2 bottom-2 z-[45] max-h-[55vh]',
            'lg:absolute lg:inset-x-auto lg:bottom-auto lg:top-3 lg:right-3 lg:w-[340px] xl:w-[380px] lg:z-20',
            'rounded-xl border border-border bg-card shadow-xl',
            'flex flex-col overflow-hidden',
            'transition-all duration-200 ease-out',
            summaryOpen
              ? 'translate-y-0 lg:translate-x-0 opacity-100 scale-100'
              : 'translate-y-[130%] lg:translate-y-0 lg:translate-x-[120%] opacity-0 scale-95 pointer-events-none',
          )}
        >
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border-faint shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <span className="text-ui font-semibold text-foreground">
              {threadMessages.length > 1 ? 'Thread summary' : 'Summary'}
            </span>
            {summarizing && (
              <Loader2 className="w-3 h-3 animate-spin text-ink-3" />
            )}
            <button
              onClick={closeSummary}
              className="ml-auto p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors"
              aria-label="Close summary"
            >
              <XIconSmall className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3.5 py-3">
            {threadMessages.length > 1 && (
              <p className="text-micro font-normal uppercase tracking-[0.06em] text-ink-3 mb-1.5">
                {threadMessages.length} messages
              </p>
            )}
            {summaryError ? (
              <div className="text-ui text-destructive">
                {summaryError}{' '}
                <button onClick={handleSummarize} className="underline ml-1">
                  Retry
                </button>
              </div>
            ) : (
              <p className="text-ui text-foreground leading-relaxed whitespace-pre-wrap">
                {streamedSummary || (summarizing ? 'Thinking…' : '')}
              </p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
