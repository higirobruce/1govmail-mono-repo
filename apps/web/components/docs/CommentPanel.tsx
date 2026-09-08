'use client';

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { X, Check, Trash2, CornerDownRight, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

interface CommentAuthor {
  id: string;
  displayName: string | null;
  email: string;
}

interface Reaction {
  emoji: string;
  count: number;
  users: string[];
  selfReacted: boolean;
}

interface CommentReply {
  id: string;
  content: string;
  authorName: string | null;
  author: CommentAuthor | null;
  createdAt: string;
  reactions: Reaction[];
}

export interface DocComment {
  id: string;
  anchorId: string;
  content: string;
  authorName: string | null;
  author: CommentAuthor | null;
  resolvedAt: string | null;
  createdAt: string;
  replies: CommentReply[];
  reactions: Reaction[];
}

interface Member {
  id: string;
  displayName: string | null;
  email: string;
}

interface Props {
  docId: string;
  editor: Editor;
  onClose: () => void;
  pendingAnchorId: string | null;
  onPendingResolved: () => void;
  focusAnchorId?: string | null;
  onFocusConsumed?: () => void;
}

const QUICK_REACTIONS = ['👍', '✅', '❤️', '😄', '🎉', '👀'];

function initials(name: string | null | undefined, email: string) {
  if (name) return name.slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Textarea that shows @mention autocomplete */
function MentionTextarea({
  docId,
  value,
  onChange,
  onKeyDown,
  rows = 3,
  placeholder,
  autoFocus,
  textareaRef,
  className,
}: {
  docId: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  className?: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [suggestions, setSuggestions] = useState<Member[]>([]);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  useEffect(() => {
    api.docs.members.list(docId).then(setMembers).catch(() => {});
  }, [docId]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    const cursor = e.target.selectionStart ?? text.length;
    onChange(text);

    // Detect @trigger
    const textBefore = text.slice(0, cursor);
    const match = textBefore.match(/@([\w ]*)$/);
    if (match) {
      const query = match[1].toLowerCase();
      setMentionStart(cursor - match[0].length);
      setSuggestions(
        members.filter((m) => {
          const name = (m.displayName ?? m.email).toLowerCase();
          return name.startsWith(query) || name.includes(query);
        }).slice(0, 5),
      );
      setHighlightIdx(0);
    } else {
      setSuggestions([]);
      setMentionStart(null);
    }
  };

  const insertMention = (member: Member, textareaEl: HTMLTextAreaElement) => {
    const name = member.displayName ?? member.email;
    const before = value.slice(0, mentionStart!);
    const after = value.slice(textareaEl.selectionStart ?? value.length);
    onChange(`${before}@${name} ${after}`);
    setSuggestions([]);
    setMentionStart(null);
    // Move cursor after inserted mention
    setTimeout(() => {
      const pos = before.length + name.length + 2;
      textareaEl.setSelectionRange(pos, pos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(suggestions[highlightIdx], e.currentTarget);
        return;
      }
      if (e.key === 'Escape') { setSuggestions([]); setMentionStart(null); return; }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        autoFocus={autoFocus}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={rows}
        placeholder={placeholder}
        className={className}
      />
      {suggestions.length > 0 && (
        <div className="absolute z-50 left-0 bottom-full mb-1 w-48 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
          {suggestions.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                const ta = textareaRef?.current ?? document.activeElement as HTMLTextAreaElement;
                insertMention(m, ta);
              }}
              className={cn(
                'w-full text-left px-2.5 py-1.5 text-xs flex flex-col',
                i === highlightIdx ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50',
              )}
            >
              <span className="font-medium">{m.displayName ?? m.email}</span>
              {m.displayName && <span className="text-[0.625rem] text-muted-foreground">{m.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentPanel({ docId, editor, onClose, pendingAnchorId, onPendingResolved, focusAnchorId, onFocusConsumed }: Props) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const threadRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const pendingInputRef = useRef<HTMLTextAreaElement>(null);
  const [pendingText, setPendingText] = useState('');

  const load = async () => {
    try {
      const data = await api.docs.comments.list(docId);
      setComments(data);
    } catch {
      /* silently ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pendingAnchorId) {
      setPendingText('');
      setTimeout(() => pendingInputRef.current?.focus({ preventScroll: true }), 80);
    }
  }, [pendingAnchorId]);

  // Scroll to and highlight a comment when opened via mark click
  useEffect(() => {
    if (!focusAnchorId || loading) return;
    setActiveAnchor(focusAnchorId);
    const el = threadRefs.current[focusAnchorId];
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    onFocusConsumed?.();
  }, [focusAnchorId, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const highlightAnchor = (anchorId: string) => {
    setActiveAnchor(anchorId);
    const mark = document.querySelector<HTMLElement>(`[data-cid="${anchorId}"]`);
    mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const submitPending = async () => {
    if (!pendingAnchorId || !pendingText.trim()) return;
    setSubmitting('pending');
    try {
      const created = await api.docs.comments.create(docId, {
        anchorId: pendingAnchorId,
        content: pendingText.trim(),
      });
      setComments((prev) => [...prev, created]);
      setPendingText('');
      onPendingResolved();
    } catch {
      /* show nothing for now */
    } finally {
      setSubmitting(null);
    }
  };

  const cancelPending = () => {
    editor.chain().unsetComment(pendingAnchorId!).run();
    onPendingResolved();
  };

  const submitReply = async (parentComment: DocComment) => {
    const text = replyInputs[parentComment.id]?.trim();
    if (!text) return;
    setSubmitting(parentComment.id);
    try {
      const reply = await api.docs.comments.create(docId, {
        anchorId: parentComment.anchorId,
        content: text,
        parentId: parentComment.id,
      });
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentComment.id ? { ...c, replies: [...c.replies, reply] } : c,
        ),
      );
      setReplyInputs((prev) => ({ ...prev, [parentComment.id]: '' }));
    } catch {
      /* silently ignore */
    } finally {
      setSubmitting(null);
    }
  };

  const resolve = async (comment: DocComment) => {
    try {
      const updated = await api.docs.comments.update(docId, comment.id, { resolved: !comment.resolvedAt });
      setComments((prev) => prev.map((c) => c.id === comment.id ? { ...c, ...updated } : c));
    } catch { /* ignore */ }
  };

  const remove = async (comment: DocComment) => {
    try {
      await api.docs.comments.delete(docId, comment.id);
      editor.chain().unsetComment(comment.anchorId).run();
      setComments((prev) => prev.filter((c) => c.id !== comment.id));
    } catch { /* ignore */ }
  };

  const toggleReaction = async (commentId: string, emoji: string) => {
    try {
      const reactions = await api.docs.comments.toggleReaction(docId, commentId, emoji);
      setComments((prev) =>
        prev.map((c) => {
          if (c.id === commentId) return { ...c, reactions };
          // Check replies
          const inReply = c.replies.find((r) => r.id === commentId);
          if (inReply) return { ...c, replies: c.replies.map((r) => r.id === commentId ? { ...r, reactions } : r) };
          return c;
        }),
      );
    } catch { /* ignore */ }
  };

  const open = comments.filter((c) => !c.resolvedAt);
  const resolved = comments.filter((c) => c.resolvedAt);

  return (
    <div className="w-72 border-l border-border shrink-0 flex flex-col bg-background print:hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold">Comments</span>
          {open.length > 0 && (
            <span className="text-[0.625rem] bg-primary/10 text-primary rounded-full px-1.5 py-0.5 font-medium">
              {open.length}
            </span>
          )}
        </div>
        <button type="button" onClick={onClose} className="p-0.5 rounded hover:bg-muted text-muted-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Pending new comment */}
        {pendingAnchorId && (
          <div className="m-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5">
            <p className="text-[0.625rem] text-primary font-medium mb-1.5">New comment</p>
            <MentionTextarea
              docId={docId}
              value={pendingText}
              onChange={setPendingText}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitPending(); }
                if (e.key === 'Escape') cancelPending();
              }}
              rows={3}
              placeholder="Add a comment… use @ to mention"
              textareaRef={pendingInputRef}
              className="w-full text-xs bg-transparent outline-none resize-none placeholder:text-muted-foreground/50"
            />
            <div className="flex justify-end gap-1.5 mt-1.5">
              <button
                type="button"
                onClick={cancelPending}
                className="text-[0.6875rem] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!pendingText.trim() || submitting === 'pending'}
                onClick={submitPending}
                className="text-[0.6875rem] bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {loading && (
          <p className="text-xs text-muted-foreground text-center py-8">Loading…</p>
        )}

        {!loading && open.length === 0 && !pendingAnchorId && (
          <div className="flex flex-col items-center justify-center py-12 text-center gap-2 text-muted-foreground">
            <MessageSquare className="w-6 h-6 opacity-30" />
            <p className="text-xs">No comments yet.<br />Select text to add one.</p>
          </div>
        )}

        {open.map((comment) => (
          <CommentThread
            key={comment.id}
            threadRef={(el) => { threadRefs.current[comment.anchorId] = el; }}
            docId={docId}
            comment={comment}
            active={activeAnchor === comment.anchorId}
            onClick={() => highlightAnchor(comment.anchorId)}
            replyText={replyInputs[comment.id] ?? ''}
            onReplyChange={(v) => setReplyInputs((p) => ({ ...p, [comment.id]: v }))}
            onReply={() => submitReply(comment)}
            onResolve={() => resolve(comment)}
            onDelete={() => remove(comment)}
            onReaction={(emoji) => toggleReaction(comment.id, emoji)}
            submitting={submitting === comment.id}
          />
        ))}

        {resolved.length > 0 && (
          <div className="mt-2">
            <p className="text-[0.625rem] text-muted-foreground font-medium px-3 py-1.5 uppercase tracking-wide">
              Resolved ({resolved.length})
            </p>
            {resolved.map((comment) => (
              <CommentThread
                key={comment.id}
                docId={docId}
                comment={comment}
                active={false}
                onClick={() => {}}
                replyText=""
                onReplyChange={() => {}}
                onReply={() => {}}
                onResolve={() => resolve(comment)}
                onDelete={() => remove(comment)}
                onReaction={(emoji) => toggleReaction(comment.id, emoji)}
                submitting={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ThreadProps {
  docId: string;
  threadRef?: (el: HTMLDivElement | null) => void;
  comment: DocComment;
  active: boolean;
  onClick: () => void;
  replyText: string;
  onReplyChange: (v: string) => void;
  onReply: () => void;
  onResolve: () => void;
  onDelete: () => void;
  onReaction: (emoji: string) => void;
  submitting: boolean;
}

function ReactionBar({ reactions, onReaction }: { reactions: Reaction[]; onReaction: (emoji: string) => void }) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          title={r.users.join(', ')}
          onClick={(e) => { e.stopPropagation(); onReaction(r.emoji); }}
          className={cn(
            'flex items-center gap-0.5 text-[0.6875rem] px-1.5 py-0.5 rounded-full border transition-colors',
            r.selfReacted
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-muted/30 text-muted-foreground hover:border-border/80',
          )}
        >
          <span>{r.emoji}</span>
          <span>{r.count}</span>
        </button>
      ))}
      <div className="relative">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowPicker((v) => !v); }}
          className="text-[0.6875rem] px-1.5 py-0.5 rounded-full border border-dashed border-border text-muted-foreground hover:border-border/60 hover:text-foreground transition-colors"
        >
          +
        </button>
        {showPicker && (
          <div
            className="absolute bottom-full mb-1 left-0 flex gap-1 bg-popover border border-border rounded-lg p-1.5 shadow-lg z-50"
            onClick={(e) => e.stopPropagation()}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onReaction(emoji); setShowPicker(false); }}
                className="text-base hover:scale-125 transition-transform leading-none"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentThread({
  docId, threadRef, comment, active, onClick, replyText, onReplyChange, onReply, onResolve, onDelete, onReaction, submitting,
}: ThreadProps) {
  const [showReply, setShowReply] = useState(false);
  const resolved = !!comment.resolvedAt;

  return (
    <div
      ref={threadRef}
      onClick={onClick}
      className={cn(
        'mx-2 mb-2 rounded-lg border p-2.5 cursor-pointer transition-colors',
        active ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-border/80 hover:bg-muted/30',
        resolved && 'opacity-60',
      )}
    >
      {/* Root comment */}
      <div className="flex items-start gap-2">
        <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
          <span className="text-[0.5625rem] font-bold text-primary">
            {initials(comment.authorName, comment.author?.email ?? '?')}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[0.6875rem] font-semibold truncate">
              {comment.authorName ?? comment.author?.email ?? 'Unknown'}
            </span>
            <span className="text-[0.625rem] text-muted-foreground shrink-0">
              {relativeTime(comment.createdAt)}
            </span>
          </div>
          <p className="text-xs mt-0.5 break-words">{renderMentions(comment.content)}</p>
        </div>
      </div>

      {/* Reactions on root comment */}
      {((comment.reactions?.length ?? 0) > 0 || !resolved) && (
        <div onClick={(e) => e.stopPropagation()}>
          <ReactionBar reactions={comment.reactions ?? []} onReaction={onReaction} />
        </div>
      )}

      {/* Replies */}
      {comment.replies.map((reply) => (
        <div key={reply.id} className="flex items-start gap-2 mt-2 pl-1 border-l border-border/60 ml-2.5">
          <CornerDownRight className="w-3 h-3 text-muted-foreground/40 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-[0.625rem] font-semibold">{reply.authorName ?? reply.author?.email ?? 'Unknown'}</span>
              <span className="text-[0.625rem] text-muted-foreground">{relativeTime(reply.createdAt)}</span>
            </div>
            <p className="text-xs mt-0.5 break-words">{renderMentions(reply.content)}</p>
            {(reply.reactions?.length ?? 0) > 0 && (
              <ReactionBar reactions={reply.reactions ?? []} onReaction={(emoji) => onReaction(emoji)} />
            )}
          </div>
        </div>
      ))}

      {/* Actions */}
      {!resolved && (
        <div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-border/40">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowReply((v) => !v); }}
            className="text-[0.625rem] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted transition-colors"
          >
            Reply
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onResolve(); }}
            className="text-[0.625rem] text-muted-foreground hover:text-green-600 px-1.5 py-0.5 rounded hover:bg-muted transition-colors flex items-center gap-0.5"
          >
            <Check className="w-2.5 h-2.5" /> Resolve
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto text-[0.625rem] text-muted-foreground hover:text-destructive p-0.5 rounded hover:bg-muted transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      )}

      {resolved && (
        <div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-border/40">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onResolve(); }}
            className="text-[0.625rem] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
          >
            Reopen
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto text-[0.625rem] text-muted-foreground hover:text-destructive p-0.5 rounded hover:bg-muted"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      )}

      {showReply && !resolved && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <MentionTextarea
            docId={docId}
            value={replyText}
            onChange={onReplyChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onReply(); setShowReply(false); }
              if (e.key === 'Escape') setShowReply(false);
            }}
            rows={2}
            placeholder="Reply… use @ to mention"
            autoFocus
            className="w-full text-xs bg-muted/40 rounded p-1.5 outline-none resize-none placeholder:text-muted-foreground/50"
          />
          <div className="flex justify-end gap-1.5 mt-1">
            <button type="button" onClick={() => setShowReply(false)} className="text-[0.625rem] text-muted-foreground px-2 py-0.5 rounded hover:bg-muted">Cancel</button>
            <button
              type="button"
              disabled={!replyText.trim() || submitting}
              onClick={() => { onReply(); setShowReply(false); }}
              className="text-[0.625rem] bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-40"
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Highlight @mentions in rendered comment text */
function renderMentions(text: string): React.ReactNode {
  const parts = text.split(/(@[\w][\w\s]{0,30}?)(?=\s|$|[^a-zA-Z\s])/g);
  return parts.map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className="text-primary font-medium">{part}</span>
    ) : (
      part
    ),
  );
}
