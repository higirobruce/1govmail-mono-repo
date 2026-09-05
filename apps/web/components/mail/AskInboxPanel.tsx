'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion, X, Minus, Send, Loader2, CornerUpRight, TriangleAlert, Square } from 'lucide-react';
import { splitByCitations, type AnswerSegment } from '@email-client/shared';
import { streamInboxChat, type InboxChatSource, type InboxChatDegraded, type InboxChatTurn } from '@/lib/ai/inboxChat';
import { scrubOutput } from '@/lib/ai/prompt';
import { useCharStream } from '@/lib/ai/useCharStream';
import { AIHttpError } from '@/lib/ai/client';
import { cn } from '@/lib/utils';

interface AnswerTurn {
  role: 'assistant';
  content: string;                 // scrubbed final text
  sources: InboxChatSource[];      // THE alias→message map for this answer's chips
  degraded: InboxChatDegraded;
}
interface QuestionTurn { role: 'user'; content: string }
type Turn = QuestionTurn | AnswerTurn;

const MAX_SENT_TURNS = 12; // mirror of the API's ArrayMaxSize — last 6 exchanges

const EXAMPLE_QUESTIONS = [
  'What did finance say about the budget?',
  'Qui attend une réponse de moi?',
  'Any deadlines this week?',
];

interface LinkedCommitment { id: string; messageId: string; text: string }

function DegradedNotice({ degraded }: { degraded: InboxChatDegraded }) {
  if (!degraded.vector && !degraded.keyword) return null;
  if (degraded.vector && degraded.keyword) {
    return (
      <p className="text-[0.656rem] italic text-muted-foreground/60">
        Search backends unavailable — the answer may be incomplete.
      </p>
    );
  }
  return (
    <p className="text-[0.656rem] italic text-muted-foreground/60">
      {degraded.keyword
        ? 'Keyword search unavailable — answered from semantic matches only.'
        : 'Semantic index unavailable — answered from keyword matches only.'}
    </p>
  );
}

function InjectionBanner({ sources }: { sources: InboxChatSource[] }) {
  if (!sources.some((s) => s.injectionSuspected)) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] leading-relaxed text-amber-800 dark:text-amber-300">
      One of the emails used for this answer looks like it may be trying to manipulate the AI.
      Verify against the sources before acting.
    </div>
  );
}

function SourcesRail({
  sources, onOpenMessage, onReplyToMessage, openCommitments,
}: {
  sources: InboxChatSource[];
  onOpenMessage: (messageId: string) => void;
  onReplyToMessage: (messageId: string) => void;
  openCommitments: LinkedCommitment[];
}) {
  if (sources.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {sources.map((s) => {
        const linked = openCommitments.filter((c) => c.messageId === s.messageId);
        return (
          <li key={s.alias} className="rounded-md border border-border/30 p-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.625rem] font-semibold text-muted-foreground/80">
                {s.alias}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.719rem] font-medium text-foreground">
                {s.fromName ?? s.fromEmail}
              </span>
              {s.injectionSuspected && (
                <TriangleAlert
                  className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-label="This source may contain manipulative instructions"
                />
              )}
            </div>
            {s.subject && <p className="truncate text-[0.719rem] text-foreground/90">{s.subject}</p>}
            <p className="line-clamp-2 text-[0.6875rem] text-muted-foreground/70">{s.snippet}</p>
            <div className="flex items-center gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => onOpenMessage(s.messageId)}
                className="text-[0.656rem] font-medium text-primary hover:underline"
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => onReplyToMessage(s.messageId)}
                className="inline-flex items-center gap-0.5 text-[0.656rem] font-medium text-primary hover:underline"
              >
                <CornerUpRight className="h-3 w-3" />
                Reply
              </button>
            </div>
            {linked.map((c) => (
              <p key={c.id} className="text-[0.656rem] text-muted-foreground/60">
                Linked commitment: {c.text}
              </p>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

function AnswerBody({
  content, sources, onOpenMessage,
}: {
  content: string;
  sources: InboxChatSource[];
  onOpenMessage: (messageId: string) => void;
}) {
  const validAliases = new Set(sources.map((s) => s.alias));
  const segments: AnswerSegment[] = splitByCitations(content, validAliases);
  return (
    <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-foreground">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
        const source = sources.find((s) => s.alias === seg.alias);
        if (!source) return null; // guarded by splitByCitations, but keep TS/render safe
        return (
          <button
            key={i}
            type="button"
            title={source.subject ?? source.fromEmail}
            onClick={() => onOpenMessage(source.messageId)}
            className="mx-0.5 inline-flex items-center rounded bg-primary/10 px-1 text-[0.625rem] font-semibold text-primary hover:bg-primary/20 align-baseline"
          >
            {seg.alias}
          </button>
        );
      })}
    </p>
  );
}

export default function AskInboxPanel({
  open, collapsed = false, onCollapse, onClose, onOpenMessage, onReplyToMessage, prefill, openCommitments = [],
}: {
  open: boolean;
  /** Slide the panel away while keeping it mounted (conversation preserved). */
  collapsed?: boolean;
  onCollapse?: () => void;
  onClose: () => void;
  onOpenMessage: (messageId: string) => void;
  onReplyToMessage: (messageId: string) => void;
  prefill?: string | null;
  openCommitments?: LinkedCommitment[];
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingSources, setPendingSources] = useState<InboxChatSource[]>([]);
  const [pendingDegraded, setPendingDegraded] = useState<InboxChatDegraded>({ vector: false, keyword: false });
  const [error, setError] = useState<string | null>(null);
  const stream = useCharStream();
  const abortRef = useRef<AbortController | null>(null);
  // Refs mirror the pending state so the completed turn captures the sources
  // without a stale-closure race (same pattern as the suggest-reply chips).
  const pendingSourcesRef = useRef<InboxChatSource[]>([]);
  const pendingDegradedRef = useRef<InboxChatDegraded>({ vector: false, keyword: false });

  useEffect(() => { if (open && prefill) setInput(prefill); }, [open, prefill]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Escape closes — consistent with CommitmentsPanel/BriefingPanel.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || streaming) return;
    setError(null);
    setInput('');
    const history: InboxChatTurn[] = [...turns.map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })), { role: 'user', content: q }]
      .slice(-MAX_SENT_TURNS) as InboxChatTurn[];
    setTurns((prev) => [...prev, { role: 'user', content: q }]);
    setStreaming(true);
    setPendingSources([]);
    setPendingDegraded({ vector: false, keyword: false });
    pendingDegradedRef.current = { vector: false, keyword: false };
    stream.reset();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const raw = await streamInboxChat(history, {
        signal: ac.signal,
        onSources: (sources, degraded) => {
          pendingSourcesRef.current = sources;
          pendingDegradedRef.current = degraded;
          setPendingSources(sources);
          setPendingDegraded(degraded);
        },
        onChunk: (delta) => stream.push(delta),
      });
      const clean = scrubOutput(raw);
      stream.replace(clean);
      setTurns((prev) => [...prev, { role: 'assistant', content: clean, sources: pendingSourcesRef.current, degraded: pendingDegradedRef.current }]);
    } catch (err) {
      if (!ac.signal.aborted) {
        setError(err instanceof AIHttpError && err.status === 429
          ? 'The AI backend is busy — wait a moment and try again.'
          : (err as Error).message);
      }
    } finally {
      setStreaming(false);
      stream.reset();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(input);
    }
  }

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label="Ask your inbox"
      aria-hidden={collapsed}
      className={cn(
        // z-[41]: same layer as the other AI drawers — only one is ever open.
        'fixed inset-y-0 right-0 z-[41] w-full max-w-[420px]',
        'border-l border-border/40 bg-card shadow-xl',
        'flex flex-col overflow-hidden',
        'transition-transform duration-200 ease-out',
        collapsed ? 'translate-x-full pointer-events-none' : 'translate-x-0',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 shrink-0">
        <MessageCircleQuestion className="w-4 h-4 text-primary" />
        <span className="text-[0.75rem] font-semibold text-foreground">Ask your inbox</span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="ml-auto p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors"
            aria-label="Minimize"
            title="Minimize"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={cn('p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors', !onCollapse && 'ml-auto')}
          aria-label="Close"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[0.75rem]">
        {turns.length === 0 && !streaming && (
          <div className="space-y-3 py-2">
            <p className="text-[0.75rem] leading-relaxed text-muted-foreground/70">
              Ask a question about your mailbox and get an answer grounded in your own messages,
              with clickable citations back to the source emails.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void ask(q)}
                  className="rounded-full border border-border/40 px-2.5 py-1 text-[0.6875rem] text-muted-foreground/80 hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => {
          if (t.role === 'user') {
            return (
              <div key={i} className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[0.75rem] text-foreground">
                {t.content}
              </div>
            );
          }
          return (
            <div key={i} className="space-y-2">
              <InjectionBanner sources={t.sources} />
              <AnswerBody content={t.content} sources={t.sources} onOpenMessage={onOpenMessage} />
              <DegradedNotice degraded={t.degraded} />
              <SourcesRail
                sources={t.sources}
                onOpenMessage={onOpenMessage}
                onReplyToMessage={onReplyToMessage}
                openCommitments={openCommitments}
              />
            </div>
          );
        })}

        {streaming && (
          <div className="space-y-2">
            <InjectionBanner sources={pendingSources} />
            <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-foreground">
              {stream.text}
              <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-middle text-muted-foreground/60" />
            </p>
            <DegradedNotice degraded={pendingDegraded} />
            <SourcesRail
              sources={pendingSources}
              onOpenMessage={onOpenMessage}
              onReplyToMessage={onReplyToMessage}
              openCommitments={openCommitments}
            />
          </div>
        )}

        {!streaming && error && (
          <div className="space-y-2.5">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] leading-relaxed text-amber-800 dark:text-amber-300">
              {error}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border/30 px-4 py-2.5 space-y-1.5">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder="Ask about your mail…"
            rows={2}
            className={cn(
              'flex-1 resize-none rounded-md border border-border/40 bg-background px-2.5 py-1.5 text-[0.75rem]',
              'text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40',
              streaming && 'opacity-60',
            )}
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              title="Stop"
              aria-label="Stop"
              className="p-1.5 rounded-md bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void ask(input)}
              disabled={!input.trim()}
              title="Send"
              aria-label="Send"
              className={cn(
                'p-1.5 rounded-md bg-primary text-primary-foreground transition-colors',
                !input.trim() ? 'opacity-40 cursor-not-allowed' : 'hover:bg-primary/90',
              )}
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="text-[0.625rem] text-muted-foreground/45">
          Answers are AI-generated from your mail — check the cited sources.
        </p>
      </div>
    </aside>
  );
}
