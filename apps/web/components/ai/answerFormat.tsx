import type { ReactNode } from 'react';

/**
 * Minimal, safe formatting for AI answer text: inline markdown (bold,
 * italic, code) and block structure (paragraphs, "-"/"•" bullets).
 * Builds React nodes directly — no HTML strings, so nothing to sanitize —
 * and stays composable with the [sN] citation-chip splitting, which runs
 * per line before this inline pass.
 */

export interface AnswerBlock {
  kind: 'p' | 'li' | 'h';
  text: string;
  /** true when this block starts a new paragraph group (adds top margin) */
  gapBefore: boolean;
}

export function splitBlocks(content: string): AnswerBlock[] {
  const lines = content.replace(/\n{3,}/g, '\n\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let pendingGap = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      pendingGap = blocks.length > 0;
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line.trim());
    if (heading) {
      blocks.push({ kind: 'h', text: heading[1].replace(/:$/, '') + ':', gapBefore: blocks.length > 0 });
      pendingGap = false;
      continue;
    }
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    blocks.push({
      kind: bullet ? 'li' : 'p',
      text: bullet ? bullet[1] : line.trim(),
      gapBefore: pendingGap,
    });
    pendingGap = false;
  }
  return blocks;
}

const INLINE_RE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;

export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-${i++}`} className="font-semibold">
          {m[2]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${i++}`}>{m[4]}</em>);
    } else if (m[6] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="rounded bg-muted px-1 font-mono text-[0.7em]">
          {m[6]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
