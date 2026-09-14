/**
 * The one Zimbra-only extra this helper needs, as a structural type rather
 * than the provider class itself: `downloadZimbraPath` is deliberately OFF the
 * MailProvider interface (it is a Briefcase/REST path fetch no other backend
 * has), so callers reach it via `MailProviderResolver.zimbra()` after
 * checking `user.provider === 'zimbra'`. Typing the parameter structurally is
 * what keeps this shared helper free of a provider import.
 */
export interface ZimbraPathReader {
  downloadZimbraPath(
    host: string,
    authToken: string,
    relativePath: string,
  ): Promise<{ data: Buffer; contentType: string }>;
}

/**
 * Replace `src="/home/..."` Zimbra Briefcase image paths with inline base64
 * data URIs so the recipient (or the client) can display them without
 * needing a Zimbra auth token.
 *
 * Shared by SettingsService (GET /settings, used by compose) and
 * MailService.getDefaultSignatureHtml (used by agent drafts/sends) so both
 * paths ship signatures with images recipients can actually load.
 *
 * Zimbra-only: callers gate on the user's provider and skip the enrichment
 * for any other backend (the signature HTML is returned untouched).
 */
export async function inlineSignatureImages(
  zimbra: ZimbraPathReader,
  user: { zimbraHost: string; authToken: string | null },
  html: string,
): Promise<string> {
  if (!user.authToken) return html;
  const regex = /src="(\/home\/[^"]+)"/gi;
  const matches = [...html.matchAll(regex)];
  if (!matches.length) return html;

  let processed = html;
  await Promise.all(
    matches.map(async ([full, path]) => {
      try {
        const { data, contentType } = await zimbra.downloadZimbraPath(
          user.zimbraHost, user.authToken!, path,
        );
        const dataUri = `data:${contentType};base64,${data.toString('base64')}`;
        // Keep the original Zimbra path in data-zimbra-src so the editor can
        // round-trip it back when saving (avoids the 10 KB signature size limit).
        processed = processed.split(full).join(`src="${dataUri}" data-zimbra-src="${path}"`);
      } catch {
        // Leave original path — image will be missing but the rest renders
      }
    }),
  );
  return processed;
}
