/**
 * Walk a TipTap document's JSON representation and flatten it to plain text,
 * for feeding into embeddings/summarization pipelines. The input is
 * untrusted-shape: it comes from a stored `content` column that may be
 * stale, hand-edited, or from a future/older editor version, so every node
 * access is guarded and nothing here throws — worst case we return less
 * text than expected, never an exception.
 *
 * Layout rules:
 * - Block nodes (paragraph, heading, blockquote, codeBlock, and by default
 *   any node whose content isn't otherwise handled specially) each become
 *   one text block. Top-level blocks are joined with a blank line ("\n\n");
 *   nested block children (e.g. two paragraphs inside a blockquote, or a
 *   sub-list inside a listItem) are joined with a single newline ("\n") so
 *   distinct blocks never fuse into one run-on line, however deep they're
 *   nested.
 * - `listItem`s within a list are joined one-per-line ("\n"), recursively —
 *   a list nested inside a listItem renders as further lines, not glued
 *   onto its parent's text.
 * - Tables flatten row-wise: cells within a row join with " | ", rows join
 *   with "\n". A cell's own content (including a nested list) uses the same
 *   nested block rendering as everywhere else.
 * - Marks (bold/italic/link/etc.) are ignored — only `text` fields count.
 * - Unknown node types and leaf nodes with no text (image, embed, etc.) are
 *   skipped silently.
 * - Recursion depth is capped (~200) as a safety net against pathological
 *   input; `docJsonToText` also wraps the whole walk in try/catch so a
 *   surprising shape degrades to `null` rather than throwing.
 */

type JsonNode = { type?: unknown; content?: unknown; attrs?: unknown; text?: unknown };

const MAX_DEPTH = 200;

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const CELL_TYPES = new Set(['tableCell', 'tableHeader']);

function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null;
}

function childArray(node: JsonNode): JsonNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

/**
 * Render one node as text, dispatching structurally-distinct node types
 * (table, list) to their specialized renderers at ANY depth, not just at
 * the top level — this is what keeps a nested list or table (inside a
 * blockquote, listItem, or table cell) from being flattened into a single
 * glued-together run of words.
 */
function renderNode(node: JsonNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'table') return renderTable(node, depth);
  if (typeof node.type === 'string' && LIST_TYPES.has(node.type)) return renderList(node, depth);
  return renderChildren(node, depth, '\n');
}

/**
 * Render a node's children in order. Consecutive `text` children are
 * concatenated directly (they're one inline run, e.g. bold + plain text
 * within the same paragraph); any other child type is rendered as its own
 * block via `renderNode` and joined to its neighbors with `separator`.
 */
function renderChildren(node: JsonNode, depth: number, separator: string): string {
  if (depth > MAX_DEPTH) return '';
  const segments: string[] = [];
  let inline = '';
  for (const child of childArray(node)) {
    if (child.type === 'text') {
      inline += typeof child.text === 'string' ? child.text : '';
      continue;
    }
    if (inline) {
      segments.push(inline);
      inline = '';
    }
    const rendered = renderNode(child, depth + 1);
    if (rendered) segments.push(rendered);
  }
  if (inline) segments.push(inline);
  return segments.join(separator);
}

/** Render a table as row-joined, cell-separated text. */
function renderTable(table: JsonNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  const rows = childArray(table)
    .filter((row) => row.type === 'tableRow')
    .map((row) =>
      childArray(row)
        .filter((cell) => typeof cell.type === 'string' && CELL_TYPES.has(cell.type))
        .map((cell) => renderChildren(cell, depth + 1, '\n'))
        .join(' | '),
    );
  return rows.join('\n');
}

/** Render a list as one line per `listItem`, recursively. */
function renderList(list: JsonNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  return childArray(list)
    .filter((item) => item.type === 'listItem')
    .map((item) => renderChildren(item, depth + 1, '\n'))
    .join('\n');
}

/**
 * Collect the top-level block strings from a doc's content array. Nodes
 * that produce no text (images, unknown leaves, empty blocks) are dropped.
 */
function collectBlocks(nodes: JsonNode[]): string[] {
  const blocks: string[] = [];
  for (const node of nodes) {
    const block = renderNode(node, 0);
    if (block) blocks.push(block);
  }
  return blocks;
}

export function docJsonToText(contentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (!isNode(parsed)) return null;

  try {
    const blocks = collectBlocks(childArray(parsed));
    return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return null;
  }
}
