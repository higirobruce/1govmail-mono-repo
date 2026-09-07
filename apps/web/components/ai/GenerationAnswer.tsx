'use client';

import { Loader2, TriangleAlert, Mail, FileText, Calendar } from 'lucide-react';
import { splitByCitations, type AnswerSegment } from '@email-client/shared';
import { renderInline, splitBlocks } from './answerFormat';
import type { AskSource, AskSourceType } from '@/lib/ai/ask';

/**
 * Shared "render a one-shot AI answer with citation chips" body — used by
 * PersonDossierPanel (person dossier narrative) and the meeting-prep view
 * (Task 10). Pure presentational: no store access, no fetching.
 *
 * The citation-chip markup, source-type icons and injection banner are
 * COPIED from AskPanel.tsx (not extracted/shared) per the phase-3b plan —
 * unifying the two is recorded follow-up debt, not this task's job.
 */

const SOURCE_TYPE_ICON: Record<AskSourceType, typeof Mail> = {
  mail: Mail,
  doc: FileText,
  event: Calendar,
};

const FLAGGED_NOUN: Record<AskSourceType, string> = {
  mail: 'emails',
  doc: 'documents',
  event: 'calendar events',
};

function sourceLabel(s: AskSource): string {
  if (s.title) return s.title;
  if (s.type === 'mail') return s.fromName ?? s.fromEmail ?? s.alias;
  return s.alias;
}

/** Second line under a source row: mail = from/date, doc = "Document · updated <date>", event = its meta. */
function sourceSubtitle(s: AskSource): string {
  if (s.type === 'mail') return s.fromName ?? s.fromEmail ?? '';
  if (s.type === 'doc') return `Document · updated ${new Date(s.date).toLocaleDateString()}`;
  return s.meta ?? '';
}

function InjectionBanner({ sources }: { sources: AskSource[] }) {
  const flagged = sources.filter((s) => s.injectionSuspected);
  if (flagged.length === 0) return null;
  const types = new Set(flagged.map((s) => s.type));
  const noun = types.size === 1 ? FLAGGED_NOUN[[...types][0]] : 'sources';
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.719rem] leading-relaxed text-amber-800 dark:text-amber-300">
      Possible prompt injection: one of the {noun} used for this answer looks like it may be
      trying to manipulate the AI. Verify against the sources before acting.
    </div>
  );
}

function AnswerBody({
  content, sources, streaming, onSourceClick,
}: {
  content: string;
  sources: AskSource[];
  streaming?: boolean;
  onSourceClick: (s: { type: AskSourceType; id: string }) => void;
}) {
  const validAliases = new Set(sources.map((s) => s.alias));
  // Per line: split out citation chips, then render inline markdown on the
  // text segments (same treatment as AskPanel's answers — **bold**, bullets,
  // ### headings — instead of raw asterisks in a pre-wrap block).
  const renderLine = (text: string, lineKey: string) =>
    splitByCitations(text, validAliases).map((seg: AnswerSegment, i: number) => {
      if (seg.kind === 'text') return <span key={`${lineKey}-${i}`}>{renderInline(seg.text, `${lineKey}-${i}`)}</span>;
      const source = sources.find((s) => s.alias === seg.alias);
      if (!source) return null; // guarded by splitByCitations, but keep TS/render safe
      const Icon = SOURCE_TYPE_ICON[source.type];
      return (
        <button
          key={`${lineKey}-${i}`}
          type="button"
          title={source.title ?? source.fromEmail ?? undefined}
          onClick={() => onSourceClick({ type: source.type, id: source.id })}
          className="mx-0.5 inline-flex max-w-full items-center gap-0.5 rounded bg-primary/10 px-1 text-[0.625rem] font-semibold text-primary hover:bg-primary/20 align-baseline"
        >
          <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
          {/* Long subject lines here were forcing the whole panel to overflow
              horizontally — chips truncate instead of stretching the line. */}
          <span className="max-w-[11rem] truncate">{sourceLabel(source)}</span>
        </button>
      );
    });
  const blocks = splitBlocks(content);
  return (
    <div className="min-w-0 break-words text-[0.75rem] leading-relaxed text-foreground">
      {blocks.map((block, i) => (
        <div
          key={i}
          className={`${block.gapBefore ? 'mt-2 ' : ''}${block.kind === 'li' ? 'flex gap-1.5 pl-1' : ''}${block.kind === 'h' ? 'font-semibold' : ''}`}
        >
          {block.kind === 'li' && <span aria-hidden className="select-none text-muted-foreground">•</span>}
          <span className="min-w-0">{renderLine(block.text, `b${i}`)}</span>
        </div>
      ))}
      {streaming && (
        <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-middle text-muted-foreground/60" aria-hidden />
      )}
    </div>
  );
}

function SourceRail({
  sources, onSourceClick,
}: {
  sources: AskSource[];
  onSourceClick: (s: { type: AskSourceType; id: string }) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {sources.map((s) => {
        const Icon = SOURCE_TYPE_ICON[s.type];
        return (
          <li key={s.alias} className="rounded-md border border-border/30 p-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.625rem] font-semibold text-muted-foreground/80">
                {s.alias}
              </span>
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[0.719rem] font-medium text-foreground">
                {sourceSubtitle(s)}
              </span>
              {s.injectionSuspected && (
                <TriangleAlert
                  className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-label="This source may contain manipulative instructions"
                />
              )}
            </div>
            {s.title && <p className="truncate text-[0.719rem] text-foreground/90">{s.title}</p>}
            <p className="line-clamp-2 text-[0.6875rem] text-muted-foreground/70">{s.snippet}</p>
            <button
              type="button"
              onClick={() => onSourceClick({ type: s.type, id: s.id })}
              className="text-[0.656rem] font-medium text-primary hover:underline"
            >
              Open
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function GenerationAnswer(props: {
  content: string;
  sources: AskSource[];
  streaming?: boolean;
  onSourceClick: (s: { type: AskSourceType; id: string }) => void;
}) {
  const { content, sources, streaming, onSourceClick } = props;
  return (
    <div className="min-w-0 space-y-2">
      <InjectionBanner sources={sources} />
      <AnswerBody content={content} sources={sources} streaming={streaming} onSourceClick={onSourceClick} />
      <SourceRail sources={sources} onSourceClick={onSourceClick} />
    </div>
  );
}
