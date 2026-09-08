/**
 * Minimal markdown → TipTap JSON converter for agent-created documents.
 * Deliberately dependency-free (the API cannot pull in @tiptap/*).
 * Scope: paragraphs, headings 1-3, bullet/ordered lists, bold/italic/code.
 */
interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: Array<{ type: string }>;
  text?: string;
}

function inline(text: string): TipTapNode[] {
  const nodes: TipTapNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[2]) nodes.push({ type: 'text', text: m[2], marks: [{ type: 'bold' }] });
    else if (m[4]) nodes.push({ type: 'text', text: m[4], marks: [{ type: 'italic' }] });
    else if (m[6]) nodes.push({ type: 'text', text: m[6], marks: [{ type: 'code' }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes.length ? nodes : [{ type: 'text', text: ' ' }];
}

export function mdToDocJson(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: TipTapNode[] = [];
  let list: { type: 'bulletList' | 'orderedList'; items: TipTapNode[] } | null = null;

  const flushList = () => {
    if (list) {
      blocks.push({ type: list.type, content: list.items });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push({ type: 'heading', attrs: { level: heading[1].length }, content: inline(heading[2]) });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const type = bullet ? 'bulletList' : ('orderedList' as const);
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push({
        type: 'listItem',
        content: [{ type: 'paragraph', content: inline((bullet ?? ordered)![1]) }],
      });
      continue;
    }
    flushList();
    blocks.push({ type: 'paragraph', content: inline(line) });
  }
  flushList();
  if (!blocks.length) blocks.push({ type: 'paragraph' });
  return JSON.stringify({ type: 'doc', content: blocks });
}
