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

interface CommentReply {
  id: string;
  content: string;
  authorName: string | null;
  author: CommentAuthor | null;
  createdAt: string;
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
}

interface Props {
  docId: string;
  editor: Editor;
  onClose: () => void;
  pendingAnchorId: string | null;      // set when user clicked "Add comment" in bubble menu
  onPendingResolved: () => void;        // clear pending anchor
}

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

export function CommentPanel({ docId, editor, onClose, pendingAnchorId, onPendingResolved }: Props) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
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

  // Focus the pending input when a new comment anchor is set
  useEffect(() => {
    if (pendingAnchorId) {
      setPendingText('');
      setTimeout(() => pendingInputRef.current?.focus({ preventScroll: true }), 80);
    }
  }, [pendingAnchorId]);

  const highlightAnchor = (anchorId: string) => {
    setActiveAnchor(anchorId);
    // Scroll the mark into view in the editor
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
    // Remove the mark that was applied speculatively
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
      await api.docs.comments.update(docId, comment.id, { resolved: !comment.resolvedAt });
      setComments((prev) =>
        prev.map((c) =>
          c.id === comment.id
            ? { ...c, resolvedAt: comment.resolvedAt ? null : new Date().toISOString() }
            : c,
        ),
      );
    } catch { /* ignore */ }
  };

  const remove = async (comment: DocComment) => {
    try {
      await api.docs.comments.delete(docId, comment.id);
      editor.chain().unsetComment(comment.anchorId).run();
      setComments((prev) => prev.filter((c) => c.id !== comment.id));
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
            <span className="text-[10px] bg-primary/10 text-primary rounded-full px-1.5 py-0.5 font-medium">
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
            <p className="text-[10px] text-primary font-medium mb-1.5">New comment</p>
            <textarea
              ref={pendingInputRef}
              value={pendingText}
              onChange={(e) => setPendingText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitPending(); }
                if (e.key === 'Escape') cancelPending();
              }}
              rows={3}
              placeholder="Add a comment…"
              className="w-full text-xs bg-transparent outline-none resize-none placeholder:text-muted-foreground/50"
            />
            <div className="flex justify-end gap-1.5 mt-1.5">
              <button
                type="button"
                onClick={cancelPending}
                className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!pendingText.trim() || submitting === 'pending'}
                onClick={submitPending}
                className="text-[11px] bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-40"
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

        {/* Open threads */}
        {open.map((comment) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            active={activeAnchor === comment.anchorId}
            onClick={() => highlightAnchor(comment.anchorId)}
            replyText={replyInputs[comment.id] ?? ''}
            onReplyChange={(v) => setReplyInputs((p) => ({ ...p, [comment.id]: v }))}
            onReply={() => submitReply(comment)}
            onResolve={() => resolve(comment)}
            onDelete={() => remove(comment)}
            submitting={submitting === comment.id}
          />
        ))}

        {/* Resolved section */}
        {resolved.length > 0 && (
          <div className="mt-2">
            <p className="text-[10px] text-muted-foreground font-medium px-3 py-1.5 uppercase tracking-wide">
              Resolved ({resolved.length})
            </p>
            {resolved.map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                active={false}
                onClick={() => {}}
                replyText=""
                onReplyChange={() => {}}
                onReply={() => {}}
                onResolve={() => resolve(comment)}
                onDelete={() => remove(comment)}
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
  comment: DocComment;
  active: boolean;
  onClick: () => void;
  replyText: string;
  onReplyChange: (v: string) => void;
  onReply: () => void;
  onResolve: () => void;
  onDelete: () => void;
  submitting: boolean;
}

function CommentThread({
  comment, active, onClick, replyText, onReplyChange, onReply, onResolve, onDelete, submitting,
}: ThreadProps) {
  const [showReply, setShowReply] = useState(false);
  const resolved = !!comment.resolvedAt;

  return (
    <div
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
          <span className="text-[9px] font-bold text-primary">
            {initials(comment.authorName, comment.author?.email ?? '?')}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[11px] font-semibold truncate">
              {comment.authorName ?? comment.author?.email ?? 'Unknown'}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {relativeTime(comment.createdAt)}
            </span>
          </div>
          <p className="text-xs mt-0.5 break-words">{comment.content}</p>
        </div>
      </div>

      {/* Replies */}
      {comment.replies.map((reply) => (
        <div key={reply.id} className="flex items-start gap-2 mt-2 pl-1 border-l border-border/60 ml-2.5">
          <CornerDownRight className="w-3 h-3 text-muted-foreground/40 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-semibold">{reply.authorName ?? reply.author?.email ?? 'Unknown'}</span>
              <span className="text-[10px] text-muted-foreground">{relativeTime(reply.createdAt)}</span>
            </div>
            <p className="text-xs mt-0.5 break-words">{reply.content}</p>
          </div>
        </div>
      ))}

      {/* Actions */}
      {!resolved && (
        <div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-border/40">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowReply((v) => !v); }}
            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted transition-colors"
          >
            Reply
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onResolve(); }}
            className="text-[10px] text-muted-foreground hover:text-green-600 px-1.5 py-0.5 rounded hover:bg-muted transition-colors flex items-center gap-0.5"
          >
            <Check className="w-2.5 h-2.5" /> Resolve
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto text-[10px] text-muted-foreground hover:text-destructive p-0.5 rounded hover:bg-muted transition-colors"
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
            className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
          >
            Reopen
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto text-[10px] text-muted-foreground hover:text-destructive p-0.5 rounded hover:bg-muted"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      )}

      {showReply && !resolved && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            value={replyText}
            onChange={(e) => onReplyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onReply(); setShowReply(false); }
              if (e.key === 'Escape') setShowReply(false);
            }}
            rows={2}
            placeholder="Reply…"
            className="w-full text-xs bg-muted/40 rounded p-1.5 outline-none resize-none placeholder:text-muted-foreground/50"
          />
          <div className="flex justify-end gap-1.5 mt-1">
            <button type="button" onClick={() => setShowReply(false)} className="text-[10px] text-muted-foreground px-2 py-0.5 rounded hover:bg-muted">Cancel</button>
            <button
              type="button"
              disabled={!replyText.trim() || submitting}
              onClick={() => { onReply(); setShowReply(false); }}
              className="text-[10px] bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-40"
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
