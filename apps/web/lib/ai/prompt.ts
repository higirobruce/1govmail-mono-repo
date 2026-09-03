import { neutralizeMarkers } from '@email-client/shared';
export { UNTRUSTED_CONTENT_RULE, fenceUntrusted, neutralizeMarkers, detectInjectionAttempt } from '@email-client/shared';

/**
 * Generic fallback, used only when the language could not be identified.
 *
 * On its own this does NOT work: gemma2:2b answered a French email in English
 * whether the rule came before the task, after it, or not at all. Naming the
 * language explicitly is what actually holds — hence `languageRule` below.
 */
export const LANGUAGE_RULE = `Write your output in the SAME language as the email you were given (English, French and Kinyarwanda all occur here). Never translate into another language unless you are explicitly asked to.`;

export type DetectedLanguage = 'English' | 'French' | 'Kinyarwanda';

/**
 * Function words that are common in one of the three languages the app serves
 * and rare in the other two. Matched whole-word against a lowercased sample.
 */
const LANGUAGE_MARKERS: Record<DetectedLanguage, readonly string[]> = {
  English: ['the', 'and', 'is', 'are', 'you', 'we', 'for', 'that', 'with', 'this', 'please',
    'thanks', 'regards', 'hello', 'would', 'have', 'from', 'your', 'our', 'can'],
  French: ['le', 'la', 'les', 'des', 'du', 'est', 'sont', 'vous', 'nous', 'pour', 'que', 'qui',
    'dans', 'avec', 'sur', 'une', 'aux', 'merci', 'bonjour', 'cordialement', 'nest', 'pas', 'plus'],
  Kinyarwanda: ['muraho', 'urakoze', 'murakoze', 'kandi', 'ariko', 'cyangwa', 'kuri', 'mu', 'ku',
    'na', 'ni', 'ubu', 'byose', 'gukora', 'nshuti', 'neza', 'bwana', 'madamu', 'yanditse'],
};

/**
 * Best-effort language identification for the three languages in use at RISA.
 * Returns null when the sample is too short or no language clearly wins —
 * callers then fall back to the generic rule rather than asserting a wrong one.
 */
export function detectLanguage(text: string): DetectedLanguage | null {
  const words = (text || '').toLowerCase().match(/[\p{L}']+/gu);
  if (!words || words.length < 8) return null;

  const sample = words.slice(0, 400);
  const scores = (Object.keys(LANGUAGE_MARKERS) as DetectedLanguage[]).map((lang) => {
    const markers = new Set(LANGUAGE_MARKERS[lang]);
    return { lang, hits: sample.reduce((n, w) => (markers.has(w) ? n + 1 : n), 0) };
  });
  scores.sort((a, b) => b.hits - a.hits);

  const [best, runnerUp] = scores;
  // Require a real signal and a clear margin, so mixed or unknown text is
  // reported as null instead of guessed.
  if (best.hits < 3 || best.hits < runnerUp.hits * 1.5) return null;
  return best.lang;
}

/**
 * Language instruction for a prompt, keyed to the source text.
 *
 * Naming the language is load-bearing — measured against gemma2:2b, "write in
 * the same language as the email" is ignored, while "the email is in French,
 * so you MUST answer in French" is obeyed.
 */
export function languageRule(sourceText: string): string {
  const lang = detectLanguage(sourceText);
  if (!lang) return LANGUAGE_RULE;
  return `CRITICAL: Your entire output MUST be written in ${lang}. The email below is in ${lang}, so you MUST answer in ${lang}. Do not answer in any other language.`;
}

/**
 * Hard cap on the user's custom instructions. Small local models degrade as
 * the system prompt grows, and the base rules must stay dominant — a short
 * preferences block is the point, not an essay.
 */
export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 500;

/**
 * Format the user's own "custom AI instructions" (from Settings) for
 * appending to a task's system prompt. The text is the account owner's and
 * therefore trusted — it is NOT fenced like email content — but it is still
 * defanged of chat-template structure so a pasted snippet cannot break the
 * prompt, and explicitly subordinated to the rules that precede it.
 */
export function customInstructionsBlock(raw: string | null | undefined): string {
  let text = neutralizeMarkers(raw ?? '').trim();
  if (!text) return '';
  if (text.length > CUSTOM_INSTRUCTIONS_MAX_CHARS) {
    text = text.slice(0, CUSTOM_INSTRUCTIONS_MAX_CHARS).trim();
  }
  return `USER STYLE PREFERENCES — the account owner configured these writing preferences. Apply them only where they do not conflict with the rules above; the rules above always win.
${text}`;
}

/** A fence boundary that leaked into the model's own output. */
const LEAKED_FENCE =
  /<{2,}[A-Za-z0-9_]{1,32}[ \t]*:[ \t]*[0-9a-f]{4,}|[A-Za-z0-9_]{1,32}[ \t]*:[ \t]*[0-9a-f]{4,}>{2,}/gi;

const FENCE_ONLY_LINE = /^[ \t]*[<>]{2,}[ \t]*$/gm;

const CODE_FENCE = /^```[a-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/i;

const PREAMBLE_NOUN =
  'summar(?:y|ies)|repl(?:y|ies)|response|draft|rewrite|rewritten|revised|version|text|paraphrase|translation|message|e-?mail|paragraph|output';

const INTERJECTION = '(?:sure|certainly|of course|okay|ok|absolutely|no problem|got it)';

/** "Sure!" / "Certainly," alone on the first line. */
const INTERJECTION_LINE = new RegExp(`^[ \\t]*${INTERJECTION}\\b[,.!]?[ \\t]*\\r?\\n+`, 'i');

/**
 * "Here is the rewritten draft:" and friends — only when the line names the
 * deliverable and ends in a colon, so "Here is the report you asked for:" in
 * a genuine reply is left alone.
 */
const PREAMBLE_LINE = new RegExp(
  `^[ \\t]*(?:${INTERJECTION}\\b[,.!]?[ \\t]*)?` +
    `(?:here(?:['’]s| is| are)|below is|the following is|this is|i(?:['’]ve| have) (?:written|drafted|rewritten|revised))\\b` +
    `[^\\n]{0,80}?\\b(?:${PREAMBLE_NOUN})\\b[^\\n]{0,24}:[ \\t]*\\r?\\n+`,
  'i',
);

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
];

function stripPreamble(text: string): string {
  const withoutPreamble = text.replace(PREAMBLE_LINE, '');
  if (withoutPreamble !== text) return withoutPreamble;
  const withoutInterjection = text.replace(INTERJECTION_LINE, '');
  return withoutInterjection.trim() ? withoutInterjection : text;
}

function unwrapCodeFence(text: string): string {
  const m = CODE_FENCE.exec(text);
  return m ? m[1] : text;
}

/**
 * Drop quotes wrapping the whole output. Skipped when the same quote occurs
 * inside, so dialogue like `"Yes," he said, "we agree."` survives intact.
 */
function unwrapQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length);
      if (!inner.includes(close) && !inner.includes(open)) return inner.trim();
    }
  }
  return text;
}

/**
 * Clean up model output before it reaches a draft: leaked fence markers, the
 * "Here is…" preamble small models emit despite being told not to, and code
 * fences or quotes wrapping the whole answer. Normal output comes back
 * unchanged apart from trimming.
 */
export function scrubOutput(output: string): string {
  if (!output) return '';
  let text = output.replace(LEAKED_FENCE, '').replace(FENCE_ONLY_LINE, '').trim();
  text = stripPreamble(text).trim();
  text = unwrapCodeFence(text).trim();
  text = stripPreamble(text).trim();
  text = unwrapQuotes(text).trim();
  return text;
}
