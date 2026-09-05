import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { parseJsonObject } from '@email-client/shared';
import type { AIClient } from './client';
import { TEMPLATES } from '@/lib/docs/templates';
import {
  UNTRUSTED_CONTENT_RULE,
  customInstructionsBlock,
  fenceUntrusted,
  languageRule,
  scrubOutput,
} from './prompt';
import { markdownToHtml } from './markdownToHtml';

/**
 * Append the user's configured style preferences to the system prompt.
 * Mirrors lib/ai/tasks.ts's withCustomInstructions.
 */
function withCustomInstructions(system: string, customInstructions?: string | null): string {
  const block = customInstructionsBlock(customInstructions ?? undefined);
  return block ? `${system}\n\n${block}` : system;
}

/** Government doc templates a thread can be drafted into — 'blank' excluded (nothing to draft into). */
export const TEMPLATE_CATALOG: Array<{ id: string; name: string; description: string; sections: string[] }> =
  TEMPLATES.filter((t) => t.id !== 'blank').map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    sections: t.sections,
  }));

const TEMPLATE_BY_ID = new Map(TEMPLATE_CATALOG.map((t) => [t.id, t]));
const TEMPLATE_EMOJI_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t.emoji]));

const DEFAULT_TEMPLATE_ID = 'memo';

export interface DraftResult {
  templateId: string;
  title: string;
  markdown: string;
}

function renderCatalog(): string {
  return TEMPLATE_CATALOG
    .map((t) => `- ${t.id}: ${t.name} — ${t.description} (sections: ${t.sections.join(', ')})`)
    .join('\n');
}

const SYSTEM = (catalog: string, source: string) => `${UNTRUSTED_CONTENT_RULE}

You draft a government document from an email thread. Choose the best-fitting template from the catalog and write the document.

Available templates:
${catalog}

Output ONLY a strict JSON object with exactly these keys:
{"templateId": string, "title": string, "markdown": string}

Rules:
- "templateId" must be one of the template ids listed above.
- "title" is a short, descriptive title for the document.
- "markdown" uses "##" for each section you fill, "- " for bullets, and "**bold**" for the names of people who own an action.
- Include only the sections the thread actually supports — do not pad out sections with no content.
- Never invent facts, names, or dates that are not present in the thread.
- No commentary, no preamble — JSON only.

${languageRule(source)}`;

export async function draftFromThread(
  client: Pick<AIClient, 'chat'>,
  threadText: string,
  opts: { model: string; subject: string; customInstructions?: string | null; signal?: AbortSignal },
): Promise<DraftResult> {
  const system = withCustomInstructions(SYSTEM(renderCatalog(), threadText), opts.customInstructions);
  const user = `Thread subject: ${opts.subject}

${fenceUntrusted('EMAIL THREAD', threadText)}

Draft the document now.`;

  const raw = await client.chat({
    model: opts.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    maxTokens: 1200,
    responseFormat: 'json',
    signal: opts.signal,
  });

  const data = parseJsonObject(raw);
  if (!data) throw new Error('draftFromThread: model returned unusable (non-JSON) output');

  const markdown = typeof data.markdown === 'string' ? scrubOutput(data.markdown).trim() : '';
  if (!markdown) throw new Error('draftFromThread: model returned empty markdown');

  const requestedId = typeof data.templateId === 'string' ? data.templateId : '';
  const templateId = TEMPLATE_BY_ID.has(requestedId) ? requestedId : DEFAULT_TEMPLATE_ID;

  const rawTitle = typeof data.title === 'string' ? scrubOutput(data.title).trim() : '';
  const title = rawTitle || opts.subject;

  return { templateId, title, markdown };
}

/** Emoji for a template id, falling back to a generic document icon for unknown ids. */
export function templateEmoji(templateId: string): string {
  return TEMPLATE_EMOJI_BY_ID.get(templateId) ?? '📄';
}

// Minimal extension set needed to represent markdownToHtml's output
// (p/br/strong/em/code/pre/h1-3/ul/ol/li/blockquote/a). StarterKit v3 already
// bundles Link, so its options are passed through StarterKit's `link` key with
// exactly the values DocsEditor.tsx configures — registering a second Link
// instance would only produce a "duplicate extension names" warning.
// DocsEditor disables StarterKit's built-in codeBlock in favour of its own
// CodeBlockLowlight (syntax highlighting — an editor-only UX extension we must
// not pull in here); that extension keeps the `codeBlock` node name, so the
// plain StarterKit codeBlock we keep enabled emits JSON DocsEditor can render.
// Never add Collaboration or editor-only UX extensions here — this runs
// headless, outside any live editor.
const ASSEMBLE_EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
];

/**
 * Turn model-produced markdown into TipTap doc JSON, safely. The markdown is
 * sanitized to HTML first (markdownToHtml escapes then whitelists a small tag
 * set via DOMPurify) — model output NEVER reaches generateJSON directly.
 */
export function assembleDocContent(markdown: string): string {
  const html = markdownToHtml(markdown);
  const json = generateJSON(html, ASSEMBLE_EXTENSIONS);
  return JSON.stringify(json);
}
