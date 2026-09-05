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
 *   one text block; blocks are joined with a blank line ("\n\n").
 * - `listItem`s within a list are joined one-per-line ("\n").
 * - Tables flatten row-wise: cells within a row join with " | ", rows join
 *   with "\n".
 * - Marks (bold/italic/link/etc.) are ignored — only `text` fields count.
 * - Unknown node types and leaf nodes with no text (image, embed, etc.) are
 *   skipped silently.
 */

type JsonNode = { type?: unknown; content?: unknown; attrs?: unknown; text?: unknown };

function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null;
}

function childArray(node: JsonNode): JsonNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

/** Depth-first concatenation of `text` fields within a subtree (marks ignored). */
function collectInlineText(node: JsonNode): string {
  let text = typeof node.text === 'string' ? node.text : '';
  for (const child of childArray(node)) {
    text += collectInlineText(child);
  }
  return text;
}

/** Render a table as row-joined, cell-separated text. */
function renderTable(table: JsonNode): string {
  const rows = childArray(table)
    .filter((row) => row.type === 'tableRow')
    .map((row) =>
      childArray(row)
        .map((cell) => collectInlineText(cell))
        .join(' | '),
    );
  return rows.join('\n');
}

/** Render a list as one line per `listItem`. */
function renderList(list: JsonNode): string {
  return childArray(list)
    .filter((item) => item.type === 'listItem')
    .map((item) => collectInlineText(item))
    .join('\n');
}

/**
 * Collect the top-level block strings from a doc's content array. Table and
 * list nodes get their specialized rendering; everything else (paragraph,
 * heading, blockquote, codeBlock, and any other block-ish node) falls back
 * to a plain inline-text concat. Nodes that produce no text (images, unknown
 * leaves, empty blocks) are dropped.
 */
function collectBlocks(nodes: JsonNode[]): string[] {
  const blocks: string[] = [];
  for (const node of nodes) {
    let block: string;
    if (node.type === 'table') {
      block = renderTable(node);
    } else if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
      block = renderList(node);
    } else {
      block = collectInlineText(node);
    }
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

  const blocks = collectBlocks(childArray(parsed));
  const joined = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return joined;
}
