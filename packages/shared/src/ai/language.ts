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
