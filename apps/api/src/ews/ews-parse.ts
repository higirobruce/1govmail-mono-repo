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
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
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
