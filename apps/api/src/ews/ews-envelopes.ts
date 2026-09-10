/**
 * SOAP envelope construction for EWS requests.
 *
 * Every EWS call is a POST of a SOAP envelope declaring the same three
 * namespaces and pinning the server version in the header — Exchange2013_SP1
 * is the floor version whose schema covers everything Phase 3 needs
 * (folders, messages, calendar). `soapEnvelope` is the one place that
 * skeleton is assembled so every op (Task 3+) just supplies its `<m:...>`
 * body fragment.
 */

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const TYPES_NS = 'http://schemas.microsoft.com/exchange/services/2006/types';
const MESSAGES_NS = 'http://schemas.microsoft.com/exchange/services/2006/messages';

/** Escapes the five XML-significant characters. Every value interpolated
 *  into a hand-built envelope (folder ids, search terms, free text) must be
 *  escaped through this — none of it is safe to trust verbatim. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wraps `bodyXml` (an already-built `<m:...>` fragment, escaped by its
 * caller) in the standard EWS SOAP envelope: the three namespaces on the
 * root, and `t:RequestServerVersion` in the header.
 */
export function soapEnvelope(bodyXml: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:t="${TYPES_NS}" xmlns:m="${MESSAGES_NS}">` +
    '<soap:Header>' +
    '<t:RequestServerVersion Version="Exchange2013_SP1"/>' +
    '</soap:Header>' +
    `<soap:Body>${bodyXml}</soap:Body>` +
    '</soap:Envelope>'
  );
}

/**
 * GetFolder request for a single well-known (`DistinguishedFolderId`)
 * folder, e.g. `inbox`, `calendar`, `contacts`. First concrete op — used by
 * Task 3's `authenticate` probe (a cheap, side-effect-free call that proves
 * the credentials work) and later by folder sync.
 */
export function getFolderEnvelope(distinguishedId: string): string {
  const id = xmlEscape(distinguishedId);
  const body =
    '<m:GetFolder>' +
    '<m:FolderShape>' +
    '<t:BaseShape>Default</t:BaseShape>' +
    '</m:FolderShape>' +
    '<m:FolderIds>' +
    `<t:DistinguishedFolderId Id="${id}"/>` +
    '</m:FolderIds>' +
    '</m:GetFolder>';
  return soapEnvelope(body);
}
