/** Plain text → escaped paragraph HTML. Model output must NEVER be inserted
 *  as raw HTML — `<` is escaped so nothing the model emits becomes markup. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p>`)
    .join('');
}
