'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';
import ThreadHeader, { type ThreadParticipant } from './ThreadHeader';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import MailDetail from './MailDetail';

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

  // Tab: 'messages' | 'attachments'
  const [activeTab, setActiveTab] = useState<'messages' | 'attachments'>('messages');

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
          {(['messages', 'attachments'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'px-3 py-2.5 text-[12px] font-medium border-b-2 transition-colors capitalize',
                activeTab === tab
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground/60 hover:text-foreground',
              )}
            >
              {tab === 'attachments' && allAttachments.length > 0
                ? `Attachments (${allAttachments.length})`
                : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
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

        {/* ── Messages tab ─────────────────────────────────────────────────── */}
        {activeTab === 'messages' && (
          <>
            {hiddenCount > 0 && (
              <div className="px-4 py-2.5 text-center text-[12px] text-muted-foreground/50 border-b border-border/20 bg-muted/10">
                Showing {MAX_VISIBLE} most recent messages —{' '}
                <span className="font-medium">{hiddenCount}</span> earlier not shown
              </div>
            )}
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
                      {grouped[group]!.map((att) => (
                        <div
                          key={`${att.messageId}-${att.id}`}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/30 hover:bg-muted/60 transition-colors group"
                        >
                          <GroupIcon group={group} className="opacity-60" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] text-foreground truncate">{att.filename}</p>
                            <p className="text-[11px] text-muted-foreground/50 truncate">
                              {att.fromName ?? att.fromEmail}
                              {att.size > 0 && ` · ${formatBytes(att.size)}`}
                            </p>
                          </div>
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
                            className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-all"
                            aria-label={`Download ${att.filename}`}
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
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
