'use client';

import { generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Callout } from '@/components/docs/extensions/Callout';
import { Toggle } from '@/components/docs/extensions/Toggle';
import { DatabaseView } from '@/components/docs/extensions/DatabaseView';
import { CodeBlockLowlight } from '@/components/docs/extensions/CodeBlockLowlight';
import { EmbedNode } from '@/components/docs/extensions/EmbedNode';
import { MathBlock } from '@/components/docs/extensions/MathBlock';
import { MermaidBlock } from '@/components/docs/extensions/MermaidBlock';
import { CommentMark } from '@/components/docs/CommentMark';

// Extensions must mirror every node/mark used in DocsEditor — generateHTML()
// throws "Unknown node type" on the first unknown node, which silently fails
// the whole export. Collaboration and Placeholder are intentionally omitted
// (irrelevant for rendering).
const RENDER_EXTENSIONS = [
  StarterKit.configure({ codeBlock: false }),
  Underline,
  Link,
  TaskList,
  TaskItem,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  CodeBlockLowlight,
  Callout,
  Toggle,
  DatabaseView,
  Image.configure({ inline: false, allowBase64: true }),
  EmbedNode,
  MathBlock,
  MermaidBlock,
  CommentMark,
];

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  // Firefox requires the anchor to be in the document for click() to fire a
  // download, and revoking the object URL synchronously after click() races
  // with the browser kicking off the download — both silently produce "nothing
  // happens." Attach first, then revoke on the next tick.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function contentToHtml(content: string | null | undefined, title: string): string {
  const json = content ? JSON.parse(content) : { type: 'doc', content: [] };
  // Replace TipTap's <input type="checkbox"> with plain <span> boxes so
  // html2canvas never encounters UA stylesheet lab()/oklch() colours on form
  // elements, which it cannot parse.
  let body = generateHTML(json, RENDER_EXTENSIONS);
  const checkedBox   = '<span style="display:inline-block;width:12px;height:12px;background-color:#555555;border:2px solid #555555;vertical-align:middle;border-radius:2px;color:#000000"></span>';
  const uncheckedBox = '<span style="display:inline-block;width:12px;height:12px;background-color:#ffffff;border:2px solid #555555;vertical-align:middle;border-radius:2px;color:#000000"></span>';
  body = body
    .replace(/<input[^>]*type=["']checkbox["'][^>]*checked[^>]*\/?>/gi, checkedBox)
    .replace(/<input[^>]*checked[^>]*type=["']checkbox["'][^>]*\/?>/gi, checkedBox)
    .replace(/<input[^>]*type=["']checkbox["'][^>]*\/?>/gi, uncheckedBox);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="color-scheme" content="light" />
<title>${title}</title>
<style>
  /* Pin all colours to plain hex so html2canvas never sees oklch/lab values
     from the browser user-agent stylesheet. */
  *, *::before, *::after { box-sizing: border-box; color: inherit; background-color: transparent; border-color: #cccccc; }
  :root { color-scheme: light; }
  html, body { background-color: #ffffff; color: #1a1a1a; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 800px; margin: 40px auto; line-height: 1.6; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #111111; }
  h2 { font-size: 1.4rem; margin-top: 2rem; color: #111111; }
  h3 { font-size: 1.15rem; margin-top: 1.5rem; color: #111111; }
  pre { background-color: #f4f4f4; color: #1a1a1a; padding: 12px; border-radius: 4px; overflow-x: auto; }
  code { font-family: monospace; font-size: 0.9em; color: #1a1a1a; }
  blockquote { border-left: 3px solid #cccccc; margin: 0; padding-left: 1rem; color: #555555; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #cccccc; padding: 8px 12px; text-align: left; color: #1a1a1a; }
  th { background-color: #f5f5f5; font-weight: 600; color: #111111; }
  a { color: #1155cc; }
  ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
}

// PDF generation is server-side (puppeteer-core) to avoid html2canvas's
// inability to parse modern CSS color functions (oklch/lab) from the
// browser UA stylesheet.
export async function generateDocPdfBlob(
  title: string,
  content: string | null | undefined,
): Promise<Blob> {
  const html = contentToHtml(content, title);
  const res = await fetch('/export/docs/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, title }),
  });
  if (!res.ok) throw new Error(await res.text().catch(() => 'PDF export failed'));
  return res.blob();
}

export async function exportAsPdf(title: string, content: string | null | undefined) {
  const blob = await generateDocPdfBlob(title, content);
  triggerDownload(blob, `${title}.pdf`);
}

/**
 * TipTap emits tables with <th> inside <tbody> (no <thead>) and wraps columns
 * in <colgroup>/<col> elements.  The GFM Turndown plugin requires a standard
 * <thead>/<tbody> split and chokes on <colgroup>, so we fix the structure in
 * the DOM before handing it to Turndown.
 */
function normaliseTipTapTables(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  doc.querySelectorAll('table').forEach((table) => {
    // Drop colgroup — meaningless in Markdown
    table.querySelectorAll('colgroup').forEach((cg) => cg.remove());

    // Unwrap <p> elements inside cells.  The GFM Turndown plugin processes each
    // cell's innerHTML in an isolated context (parentElement = BODY), so a
    // Turndown rule checking parentElement won't fire.  We must flatten here.
    // <td><p>text</p></td> → <td>text</td>; empty <p></p> becomes nothing.
    table.querySelectorAll('td, th').forEach((cell) => {
      cell.querySelectorAll('p').forEach((p) => {
        const frag = doc.createDocumentFragment();
        p.childNodes.forEach((child) => frag.appendChild(child.cloneNode(true)));
        p.replaceWith(frag);
      });
      // Strip bare <br> elements left behind by empty paragraphs
      cell.querySelectorAll('br').forEach((br) => {
        if (!br.nextSibling && !br.previousSibling) br.remove();
      });
    });

    // If the table already has a <thead> we have nothing to do
    if (table.querySelector('thead')) return;

    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    // Promote the first row to <thead> when every cell is a <th>
    const firstRow = tbody.querySelector('tr');
    if (!firstRow) return;
    const allTh = Array.from(firstRow.children).every((c) => c.tagName === 'TH');
    if (!allTh) return;

    const thead = doc.createElement('thead');
    tbody.removeChild(firstRow);
    thead.appendChild(firstRow);
    table.insertBefore(thead, tbody);
  });

  return doc.body.innerHTML;
}

export async function exportAsMarkdown(title: string, content: string | null | undefined) {
  const TurndownService = (await import('turndown')).default;
  const { gfm, taskListItems } = await import('turndown-plugin-gfm');
  const json = content ? JSON.parse(content) : { type: 'doc', content: [] };
  const rawHtml = generateHTML(json, RENDER_EXTENSIONS);
  const bodyHtml = normaliseTipTapTables(rawHtml);

  const td = new TurndownService({
    headingStyle:    'atx',
    codeBlockStyle:  'fenced',
    bulletListMarker: '-',
    hr: '---',
  });

  // Turndown escapes [ and ] because they're special in Markdown link syntax,
  // producing \[Name\] instead of [Name].  Undo that — square brackets in
  // plain prose and template placeholders are not link syntax.
  const originalEscape = td.escape.bind(td);
  td.escape = (str: string) => originalEscape(str).replace(/\\\[/g, '[').replace(/\\\]/g, ']');

  // GFM: proper pipe tables + strikethrough
  td.use(gfm);
  // Task list items: convert <li data-checked> to - [ ] / - [x]
  td.use(taskListItems);

  // Strip checkbox inputs inside task-list labels (the <label><input/><span/></label>
  // pattern TipTap emits) so they don't bleed into the text.
  td.addRule('taskListLabel', {
    filter: (node) =>
      node.nodeName === 'LABEL' &&
      node.parentElement?.nodeName === 'LI' &&
      node.parentElement?.parentElement?.getAttribute('data-type') === 'taskList',
    replacement: () => '',
  });

  const markdown = `## ${title}\n\n${td.turndown(bodyHtml)}`;
  triggerDownload(new Blob([markdown], { type: 'text/markdown' }), `${title}.md`);
}

export async function exportAsDocx(title: string, content: string | null | undefined) {
  // html-to-docx uses Node.js built-ins, so generation happens in a Next.js
  // Route Handler (/export/docs/docx) which runs server-side only.
  const html = contentToHtml(content, title);
  const res = await fetch('/export/docs/docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, title }),
  });
  if (!res.ok) throw new Error('Docx export failed');
  const blob = await res.blob();
  triggerDownload(blob, `${title}.docx`);
}