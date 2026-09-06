'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  MessageCircleQuestion, X, Minus, Send, Loader2, CornerUpRight, TriangleAlert, Square,
  Mail, FileText, Calendar, SquarePen,
} from 'lucide-react';
import { splitByCitations, type AnswerSegment } from '@email-client/shared';
import { renderInline, splitBlocks } from './answerFormat';
import { streamAsk, type AskSource, type AskSourceType, type AskDegraded, type AskTurn } from '@/lib/ai/ask';
import { streamAgent, type AgentStep, type AgentProposal, type AgentChartSpec } from '@/lib/ai/agent';
import { sourceHref } from '@/lib/ai/sourceNav';
import { scrubOutput } from '@/lib/ai/prompt';
import { useCharStream } from '@/lib/ai/useCharStream';
import { AIHttpError } from '@/lib/ai/client';
import { cn } from '@/lib/utils';
import { AIWorkingIndicator } from '@/components/ai/AIWorkingIndicator';
import AgentSteps from '@/components/ai/AgentSteps';
import AgentChart from '@/components/ai/AgentChart';
import ProposalCard from '@/components/ai/ProposalCard';
import { useAskStore, type LinkedCommitment } from '@/stores/ask.store';

interface AnswerTurn {
  role: 'assistant';
  content: string;                 // scrubbed final text
  sources: AskSource[];      // THE alias→message map for this answer's chips
  degraded: AskDegraded;
  // Agent-mode extras — absent on scoped (streamAsk) turns.
  steps?: AgentStep[];
  proposals?: AgentProposal[];
  charts?: AgentChartSpec[];
}
interface QuestionTurn { role: 'user'; content: string }
type Turn = QuestionTurn | AnswerTurn;

const MAX_SENT_TURNS = 12; // mirror of the API's ArrayMaxSize — last 6 exchanges
// Agent turns get a shorter history: long transcripts are what push qwen3 into
// answering from context without calling tools (observed live 2026-09-06 —
// fabricated docs/ids/addresses). 6 turns = 3 exchanges is plenty for follow-ups.
const MAX_AGENT_TURNS = 6;

const EXAMPLE_QUESTIONS = [
  'What did finance say about the budget?',
  'Qui attend une réponse de moi?',
  'Any deadlines this week?',
];

const SCOPED_EXAMPLE_QUESTIONS = [
  'Summarize the key decisions',
  'What action items are in here?',
];

const SOURCE_TYPE_ICON: Record<AskSourceType, typeof Mail> = {
  mail: Mail,
  doc: FileText,
  event: Calendar,
};

function DegradedNotice({ degraded }: { degraded: AskDegraded }) {
  const lines: string[] = [];
  if (degraded.vector && degraded.keyword) {
    lines.push('Search backends unavailable — the answer may be incomplete.');
  } else if (degraded.keyword) {
    lines.push('Keyword search unavailable — answered from semantic matches only.');
  } else if (degraded.vector) {
    lines.push('Semantic index unavailable — answered from keyword matches only.');
  }
  if (degraded.docs) {
    lines.push('Document search unavailable — the answer may be missing doc sources.');
  }
  if (degraded.calendar) {
    lines.push('Calendar search unavailable — the answer may be missing event sources.');
  }
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line, i) => (
        <p key={i} className="text-[0.656rem] italic text-muted-foreground/60">{line}</p>
      ))}
    </>
  );
}

const FLAGGED_NOUN: Record<AskSourceType, string> = {
  mail: 'emails',
  doc: 'documents',
  event: 'calendar events',
};

function InjectionBanner({ sources }: { sources: AskSource[] }) {
  const flagged = sources.filter((s) => s.injectionSuspected);
  if (flagged.length === 0) return null;
  // Name the kind only when every flagged source is the same kind — otherwise
  // the generic "sources", never "emails" for a doc or an event.
  const types = new Set(flagged.map((s) => s.type));
  const noun = types.size === 1 ? FLAGGED_NOUN[[...types][0]] : 'sources';
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] leading-relaxed text-amber-800 dark:text-amber-300">
      One of the {noun} used for this answer looks like it may be trying to manipulate the AI.
      Verify against the sources before acting.
    </div>
  );
}

/** Second line under a source row: mail = from/date (unchanged), doc = "Document · updated <date>", event = its meta (When line). */
function sourceSubtitle(s: AskSource): string {
  if (s.type === 'mail') return s.fromName ?? s.fromEmail ?? '';
  if (s.type === 'doc') return `Document · updated ${new Date(s.date).toLocaleDateString()}`;
  return s.meta ?? '';
}

function SourcesRail({
  sources, onOpenSource, onReplyToMessage, openCommitments,
}: {
  sources: AskSource[];
  onOpenSource: (s: AskSource) => void;
  onReplyToMessage: (messageId: string) => void;
  openCommitments: LinkedCommitment[];
}) {
  if (sources.length === 0) return null;
  // The agent can surface the same message under several aliases across
  // repeated searches (observed live: 35 cards, mostly duplicates). Group by
  // identity for display — every alias stays valid for citation chips (those
  // resolve against the flat sources array, not this grouping).
  const groups = new Map<string, AskSource[]>();
  for (const src of sources) {
    const key = `${src.type}:${src.id}`;
    groups.set(key, [...(groups.get(key) ?? []), src]);
  }
  return (
    <ul className="space-y-1.5">
      {[...groups.values()].map((group) => {
        const s = group[0];
        const linked = s.type === 'mail' ? openCommitments.filter((c) => c.messageId === s.id) : [];
        const Icon = SOURCE_TYPE_ICON[s.type];
        return (
          <li key={s.alias} className="rounded-md border border-border/30 p-2 space-y-1">
            <div className="flex items-center gap-1.5">
              {group.map((g) => (
                <span key={g.alias} className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.625rem] font-semibold text-muted-foreground/80">
                  {g.alias}
                </span>
              ))}
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[0.719rem] font-medium text-foreground">
                {sourceSubtitle(s)}
              </span>
              {group.some((g) => g.injectionSuspected) && (
                <TriangleAlert
                  className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-label="This source may contain manipulative instructions"
                />
              )}
            </div>
            {s.title && <p className="truncate text-[0.719rem] text-foreground/90">{s.title}</p>}
            <p className="line-clamp-2 text-[0.6875rem] text-muted-foreground/70">{s.snippet}</p>
            <div className="flex items-center gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => onOpenSource(s)}
                className="text-[0.656rem] font-medium text-primary hover:underline"
              >
                Open
              </button>
              {s.type === 'mail' && (
                <button
                  type="button"
                  onClick={() => onReplyToMessage(s.id)}
                  className="inline-flex items-center gap-0.5 text-[0.656rem] font-medium text-primary hover:underline"
                >
                  <CornerUpRight className="h-3 w-3" />
                  Reply
                </button>
              )}
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
  content, sources, onOpenSource,
}: {
  content: string;
  sources: AskSource[];
  onOpenSource: (s: AskSource) => void;
}) {
  const validAliases = new Set(sources.map((s) => s.alias));
  const renderLine = (text: string, lineKey: string) => {
    const segments: AnswerSegment[] = splitByCitations(text, validAliases);
    return segments.map((seg, i) => {
      if (seg.kind === 'text') return <span key={`${lineKey}-${i}`}>{renderInline(seg.text, `${lineKey}-${i}`)}</span>;
      const source = sources.find((s) => s.alias === seg.alias);
      if (!source) return null; // guarded by splitByCitations, but keep TS/render safe
      return (
        <button
          key={`${lineKey}-${i}`}
          type="button"
          title={source.title ?? source.fromEmail ?? undefined}
          onClick={() => onOpenSource(source)}
          className="mx-0.5 inline-flex items-center rounded bg-primary/10 px-1 text-[0.625rem] font-semibold text-primary hover:bg-primary/20 align-baseline"
        >
          {seg.alias}
        </button>
      );
    });
  };
  const blocks = splitBlocks(content);
  return (
    <div className="text-[0.75rem] leading-relaxed text-foreground">
      {blocks.map((block, i) => (
        <div
          key={i}
          className={`${block.gapBefore ? 'mt-2 ' : ''}${block.kind === 'li' ? 'flex gap-1.5 pl-1' : ''}${block.kind === 'h' ? 'font-semibold' : ''}`}
        >
          {block.kind === 'li' && <span aria-hidden className="select-none text-muted-foreground">•</span>}
          <span>{renderLine(block.text, `b${i}`)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Ask 1Gov — app-wide "ask a question grounded in your own mail/docs/calendar"
 * panel. Fully store-driven (see stores/ask.store.ts): a single instance is
 * mounted by AskLauncher in the app layout, after {children}.
 *
 * Because of that single mount the panel is ALWAYS `fixed inset-y-0 right-0`;
 * it never becomes an in-flow flex child of a page. A page that wants its
 * content to reflow beside it (the mail page) reserves the width with its own
 * padding while the panel is open and expanded — see mail/page.tsx.
 *
 * On the mail page, the page registers `handlers` on the store (an effect, set
 * on mount / cleared on unmount) so mail-source clicks route through its
 * in-page open/reply. Everywhere else (handlers unset) a source-chip click
 * navigates via `router.push(sourceHref(s))` — unless the user is already on
 * that source's route, where a navigation would be a no-op and the click is
 * published as an `openTarget` for that page to consume instead.
 */
export default function AskPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const open = useAskStore((s) => s.open);
  const collapsed = useAskStore((s) => s.collapsed);
  const prefill = useAskStore((s) => s.prefill);
  const scope = useAskStore((s) => s.scope);
  const handlers = useAskStore((s) => s.handlers);
  const collapseStore = useAskStore((s) => s.collapse);
  const closeStore = useAskStore((s) => s.close);
  const clearScope = useAskStore((s) => s.clearScope);
  const setOpenTarget = useAskStore((s) => s.setOpenTarget);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingSources, setPendingSources] = useState<AskSource[]>([]);
  const [pendingDegraded, setPendingDegraded] = useState<AskDegraded>({ vector: false, keyword: false, docs: false, calendar: false });
  const [error, setError] = useState<string | null>(null);
  const stream = useCharStream();
  const abortRef = useRef<AbortController | null>(null);
  // Refs mirror the pending state so the completed turn captures the sources
  // without a stale-closure race (same pattern as the suggest-reply chips).
  const pendingSourcesRef = useRef<AskSource[]>([]);
  const pendingDegradedRef = useRef<AskDegraded>({ vector: false, keyword: false, docs: false, calendar: false });
  // Agent-mode live collection. Same ref-mirrors-state pattern: the refs are
  // what the completed turn captures, the state is what the live bubble renders.
  // Proposals/charts have no live rendering, so they need no state mirror.
  const liveStepsRef = useRef<AgentStep[]>([]);
  const liveProposalsRef = useRef<AgentProposal[]>([]);
  const liveChartsRef = useRef<AgentChartSpec[]>([]);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [liveProposals, setLiveProposals] = useState<AgentProposal[]>([]);

  useEffect(() => { if (open && prefill) setInput(prefill); }, [open, prefill]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Escape closes — consistent with CommitmentsPanel/BriefingPanel.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeStore();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeStore]);

  function onOpenSource(s: AskSource) {
    if (s.type === 'mail' && handlers) { handlers.onOpenMessage(s.id); return; }
    const href = sourceHref(s);
    // Same route: the target page's deep-link effect is consume-once and
    // mount-gated, so pushing the same pathname would do nothing at all.
    if (pathname === href.split('?')[0]) { setOpenTarget({ type: s.type, id: s.id }); return; }
    router.push(href);
  }

  function onReplyToMessage(messageId: string) {
    if (handlers) { handlers.onReplyToMessage(messageId); return; }
    router.push(sourceHref({ type: 'mail', id: messageId }));
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || streaming) return;
    setError(null);
    setInput('');
    const history: AskTurn[] = [...turns.map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })), { role: 'user', content: q }]
      .slice(-(scope ? MAX_SENT_TURNS : MAX_AGENT_TURNS)) as AskTurn[];
    setTurns((prev) => [...prev, { role: 'user', content: q }]);
    setStreaming(true);
    setPendingSources([]);
    setPendingDegraded({ vector: false, keyword: false, docs: false, calendar: false });
    // The agent protocol has no `sources` frame — sources accumulate from each
    // tool_result's refs — so the ref must be cleared here rather than relying
    // on a whole-list overwrite the way the retrieval path does.
    pendingSourcesRef.current = [];
    pendingDegradedRef.current = { vector: false, keyword: false, docs: false, calendar: false };
    liveStepsRef.current = [];
    liveProposalsRef.current = [];
    liveChartsRef.current = [];
    setLiveSteps([]);
    setLiveProposals([]);
    stream.reset();
    // Text streamed since the last tool_start. Iteration narration ("Let me
    // search…") belongs to the step that follows it, not the answer: on each
    // tool_start the accumulated segment folds into that step's `preamble`
    // and the live bubble resets, so only the final segment stands as the
    // answer. This also kills the stacked-newline gaps between iterations.
    const segRef = { current: '' };
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // Routing: "Ask this document" keeps the scoped retrieval path — /ai/agent
      // has no doc-scoped mode in v1. Every unscoped turn goes to the agent.
      const raw = scope
        ? await streamAsk(history, {
            scope: { docId: scope.docId },
            signal: ac.signal,
            onSources: (sources, degraded) => {
              pendingSourcesRef.current = sources;
              pendingDegradedRef.current = degraded;
              setPendingSources(sources);
              setPendingDegraded(degraded);
            },
            onChunk: (delta) => stream.push(delta),
          })
        : await streamAgent(history, {
            signal: ac.signal,
            onChunk: (delta) => {
              segRef.current += delta;
              stream.push(delta);
            },
            onStep: (step) => {
              const preamble = segRef.current.trim();
              if (preamble) {
                segRef.current = '';
                stream.reset();
              }
              liveStepsRef.current = [...liveStepsRef.current, preamble ? { ...step, preamble } : step];
              setLiveSteps(liveStepsRef.current);
            },
            onStepResult: (step) => {
              liveStepsRef.current = liveStepsRef.current.map((s) => (s.id === step.id ? { ...s, ...step } : s));
              setLiveSteps(liveStepsRef.current);
              if (step.refs?.length) {
                // The injection signal is frame-level: the server flags the whole
                // tool_result (agent.service.ts detectInjectionAttempt), while each
                // tool's refs ship a hardcoded `injectionSuspected: false`. Stamp the
                // frame flag onto the refs or InjectionBanner can never fire on the
                // agent path — the warning would survive only as the collapsed ⚠ glyph.
                const stamped = step.refs.map((r) => ({
                  ...r,
                  injectionSuspected: r.injectionSuspected || !!step.injectionSuspected,
                }));
                pendingSourcesRef.current = [...pendingSourcesRef.current, ...stamped];
                setPendingSources(pendingSourcesRef.current);
              }
            },
            onProposal: (p) => {
              // Render proposals live: a Stop after the frame arrives must not
              // discard an approval card the server already proposed.
              liveProposalsRef.current = [...liveProposalsRef.current, p];
              setLiveProposals(liveProposalsRef.current);
            },
            onChart: (c) => { liveChartsRef.current = [...liveChartsRef.current, c]; },
          });
      // Agent turns: the answer is the FINAL segment only — earlier segments
      // were folded into the step timeline above. Scoped turns have no steps,
      // so segRef never resets and this is a no-op there (raw === segment).
      const clean = scrubOutput(scope ? raw : (segRef.current.trim() || raw));
      stream.replace(clean);
      setTurns((prev) => [...prev, {
        role: 'assistant',
        content: clean,
        sources: pendingSourcesRef.current,
        degraded: pendingDegradedRef.current,
        steps: liveStepsRef.current,
        proposals: liveProposalsRef.current,
        charts: liveChartsRef.current,
      }]);
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

  /**
   * Clear the conversation: turns, sources, steps, proposals, charts, errors.
   * A failed turn poisons follow-ups (the model repeats "couldn't find" from
   * history without re-searching) and long histories push the model into
   * fabricating tool results — this is the escape hatch.
   */
  function startNewConversation() {
    setTurns([]);
    setError(null);
    setPendingSources([]);
    setPendingDegraded({ vector: false, keyword: false, docs: false, calendar: false });
    pendingSourcesRef.current = [];
    pendingDegradedRef.current = { vector: false, keyword: false, docs: false, calendar: false };
    liveStepsRef.current = [];
    liveProposalsRef.current = [];
    liveChartsRef.current = [];
    setLiveSteps([]);
    setLiveProposals([]);
    stream.reset();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(input);
    }
  }

  if (!open) return null;

  const exampleQuestions = scope ? SCOPED_EXAMPLE_QUESTIONS : EXAMPLE_QUESTIONS;
  const openCommitments = handlers?.linkedCommitments ?? [];

  return (
    <aside
      role="complementary"
      aria-label="Ask 1Gov"
      aria-hidden={collapsed}
      className={cn(
        // z-[41]: same layer as the other AI drawers — only one is ever open.
        // Always fixed: this panel is mounted once in the app layout, outside
        // any page's flex row, so `xl:static` would drop it below the fold of
        // an h-screen page. Pages reserve the width with padding instead.
        'fixed inset-y-0 right-0 z-[41] w-full max-w-[420px]',
        'border-l border-border/40 bg-card shadow-xl',
        'flex flex-col overflow-hidden',
        'transition-transform duration-200 ease-out',
        // collapsed: slide out of view, state kept (not unmounted)
        collapsed ? 'translate-x-full pointer-events-none' : 'translate-x-0',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 shrink-0">
        <MessageCircleQuestion className="w-4 h-4 text-primary" />
        <span className="text-[0.75rem] font-semibold text-foreground">Ask 1Gov</span>
        <button
          type="button"
          onClick={startNewConversation}
          disabled={streaming}
          className="ml-auto p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40"
          aria-label="New conversation"
          title="New conversation — clears this chat's history"
        >
          <SquarePen className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={collapseStore}
          className="p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors"
          aria-label="Minimize"
          title="Minimize"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={closeStore}
          className="p-1 rounded text-ink-3 hover:text-foreground hover:bg-muted/60 transition-colors"
          aria-label="Close"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Scope chip */}
      {scope && (
        <div className="flex items-center gap-1.5 px-4 pt-2.5 shrink-0">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/40 bg-muted/50 px-2 py-0.5 text-[0.6875rem] text-foreground">
            <span className="truncate">This document: {scope.docTitle}</span>
            <button
              type="button"
              onClick={clearScope}
              aria-label="Clear document scope"
              title="Clear document scope"
              className="shrink-0 text-muted-foreground/70 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[0.75rem]">
        {turns.length === 0 && !streaming && (
          <div className="space-y-3 py-2">
            <p className="text-[0.75rem] leading-relaxed text-muted-foreground/70">
              {scope
                ? 'Ask a question about this document and get an answer grounded in its content.'
                : 'Ask a question about your mail, documents and calendar and get an answer grounded in your own content, with clickable citations back to each source.'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {exampleQuestions.map((q) => (
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
              <AgentSteps steps={t.steps ?? []} />
              <AnswerBody content={t.content} sources={t.sources} onOpenSource={onOpenSource} />
              {t.charts?.map((c, ci) => <AgentChart key={ci} spec={c} />)}
              {t.proposals?.map((p) => <ProposalCard key={p.proposalId} proposal={p} />)}
              <DegradedNotice degraded={t.degraded} />
              <SourcesRail
                sources={t.sources}
                onOpenSource={onOpenSource}
                onReplyToMessage={onReplyToMessage}
                openCommitments={openCommitments}
              />
            </div>
          );
        })}

        {streaming && (
          <div className="space-y-2">
            <InjectionBanner sources={pendingSources} />
            <AgentSteps steps={liveSteps} />
            {liveProposals.map((p) => (
              <ProposalCard key={p.proposalId} proposal={p} />
            ))}
            {stream.text ? (
              <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-foreground">
                {stream.text}
                <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-middle text-muted-foreground/60" />
              </p>
            ) : (
              <AIWorkingIndicator step={scope ? 'Searching this document' : liveSteps.length ? 'Working with your mail, docs and calendar' : 'Thinking'} />
            )}
            <DegradedNotice degraded={pendingDegraded} />
            <SourcesRail
              sources={pendingSources}
              onOpenSource={onOpenSource}
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
            placeholder={scope ? 'Ask about this document…' : 'Ask about your mail, docs or calendar…'}
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
          Answers are AI-generated from your mail, documents and calendar — check the cited sources.
        </p>
      </div>
    </aside>
  );
}
