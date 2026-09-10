import { XMLParser } from 'fast-xml-parser';

/**
 * Shared fast-xml-parser configuration for EWS SOAP responses.
 *
 * - `ignoreAttributes: false` — EWS puts load-bearing data on attributes
 *   (`ResponseClass`, `Id`, `ChangeKey`), not just element text.
 * - `removeNSPrefix: true` — EWS responses namespace-qualify every element
 *   (`s:Envelope`, `m:GetFolderResponse`, `t:DisplayName`, ...). The prefix
 *   itself carries no information once the document has exactly one
 *   namespace per role, so stripping it lets callers navigate the parsed
 *   tree by the plain local name instead of duplicating the namespace
 *   bookkeeping.
 * - `attributeNamePrefix: '@_'` — fast-xml-parser default; kept explicit so
 *   the extractors below don't depend on the library's default changing.
 * - `numberParseOptions.skipLike` — fast-xml-parser's default tag-value number
 *   coercion silently drops a leading `+` (`+250788...` → `250788...`, since
 *   `Number('+x')` and `String(that)` don't round-trip the sign) and a leading
 *   `0` before more digits (`0788...` → `788...`). Both shapes only ever occur
 *   on phone-ish text (E.164 numbers, national numbers with a trunk zero) —
 *   genuine EWS counts/sizes never do — so we skip coercion for exactly those
 *   two shapes and leave every other numeric tag (UnreadCount, TotalCount,
 *   Size, ...) coerced as before.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  numberParseOptions: {
    hex: true,
    leadingZeros: true,
    skipLike: /^\+\d+$|^0\d+$/,
  },
});

/** Parses an EWS SOAP response into a plain object tree. */
export function parseEws(xml: string): any {
  return parser.parse(xml);
}

/** `ResponseClass` ('Success' | 'Warning' | 'Error') off a ResponseMessage
 *  node (e.g. `GetFolderResponseMessage`). */
export function responseClassOf(messageNode: any): 'Success' | 'Warning' | 'Error' {
  return messageNode?.['@_ResponseClass'];
}

/** `ResponseCode` text (e.g. 'NoError', 'ErrorItemNotFound') off a
 *  ResponseMessage node. */
export function responseCodeOf(messageNode: any): string | undefined {
  return messageNode?.ResponseCode;
}

/** `MessageText` — the human-readable error detail — off a ResponseMessage
 *  node. Only present on Warning/Error responses. */
export function messageTextOf(messageNode: any): string | undefined {
  return messageNode?.MessageText;
}

/**
 * Normalise a repeated-element slot into an array. fast-xml-parser collapses a
 * single occurrence to the bare object and drops the key entirely when absent,
 * so `Folders.Folder` / `Items.Message` / `ToRecipients.Mailbox` are variously
 * `undefined`, one object, or an array. Callers that iterate must funnel
 * through this.
 */
export function toArray<T = any>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Coerce an EWS boolean text/attribute (`true`/`false`, already possibly a
 *  JS boolean after tag-value parsing) to a real boolean. */
export function toBool(value: any): boolean {
  return value === true || value === 'true' || value === 1;
}

/** Read the text content of a node that may be either a bare string/number or
 *  an object carrying `#text` (present when the element also has attributes,
 *  e.g. `<t:Body BodyType="HTML">…</t:Body>`). */
export function textOf(node: any): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'object') {
    const t = node['#text'];
    return t === undefined || t === null ? undefined : String(t);
  }
  return String(node);
}
