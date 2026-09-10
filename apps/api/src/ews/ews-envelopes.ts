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

/**
 * FindFolder with a Deep traversal rooted at `msgfolderroot` — the whole mail
 * folder tree in one call (spec §5.3, `getFolders`). Default shape carries the
 * `DisplayName` / `UnreadCount` / `TotalCount` the mapping needs; the caller
 * maps well-known DisplayNames → the app's folder `type`.
 */
export function findFolderEnvelope(): string {
  const body =
    '<m:FindFolder Traversal="Deep">' +
    '<m:FolderShape>' +
    '<t:BaseShape>Default</t:BaseShape>' +
    '</m:FolderShape>' +
    '<m:ParentFolderIds>' +
    '<t:DistinguishedFolderId Id="msgfolderroot"/>' +
    '</m:ParentFolderIds>' +
    '</m:FindFolder>';
  return soapEnvelope(body);
}

/** The AdditionalProperties block shared by the two FindItem envelopes
 *  (`getMessages`, `searchMessages`) — the message-summary field set from
 *  spec §5.3 (subject, from/to, date, size, IsRead, HasAttachments, flags,
 *  ConversationId, preview). */
const FINDITEM_SUMMARY_FIELDS =
  '<t:AdditionalProperties>' +
  '<t:FieldURI FieldURI="item:Subject"/>' +
  '<t:FieldURI FieldURI="message:From"/>' +
  '<t:FieldURI FieldURI="message:ToRecipients"/>' +
  '<t:FieldURI FieldURI="item:DateTimeReceived"/>' +
  '<t:FieldURI FieldURI="item:Size"/>' +
  '<t:FieldURI FieldURI="message:IsRead"/>' +
  '<t:FieldURI FieldURI="item:HasAttachments"/>' +
  '<t:FieldURI FieldURI="item:Flag"/>' +
  '<t:FieldURI FieldURI="conversation:ConversationId"/>' +
  '<t:FieldURI FieldURI="item:Preview"/>' +
  '</t:AdditionalProperties>';

/** The ItemShape + IndexedPageItemView + SortOrder prelude common to both
 *  FindItem envelopes: IdOnly + the summary fields, a page window, and a
 *  DateTimeReceived-descending sort. */
function findItemPrelude(offset: number, max: number): string {
  const off = Math.max(0, Math.trunc(offset));
  const cap = Math.max(1, Math.trunc(max));
  return (
    '<m:ItemShape>' +
    '<t:BaseShape>IdOnly</t:BaseShape>' +
    FINDITEM_SUMMARY_FIELDS +
    '</m:ItemShape>' +
    `<m:IndexedPageItemView MaxEntriesReturned="${cap}" Offset="${off}" BasePoint="Beginning"/>` +
    '<m:SortOrder>' +
    '<t:FieldOrder Order="Descending">' +
    '<t:FieldURI FieldURI="item:DateTimeReceived"/>' +
    '</t:FieldOrder>' +
    '</m:SortOrder>'
  );
}

/**
 * FindItem over one folder, paged and sorted newest-first (spec §5.3,
 * `getMessages`). `folderId` is the opaque EWS FolderId returned by
 * `getFolders`.
 */
export function findItemEnvelope(folderId: string, offset: number, max: number): string {
  const id = xmlEscape(folderId);
  const body =
    '<m:FindItem Traversal="Shallow">' +
    findItemPrelude(offset, max) +
    '<m:ParentFolderIds>' +
    `<t:FolderId Id="${id}"/>` +
    '</m:ParentFolderIds>' +
    '</m:FindItem>';
  return soapEnvelope(body);
}

/**
 * FindItem with an AQS `QueryString` across the mailbox (spec §5.3,
 * `searchMessages`). Same shape/paging as `findItemEnvelope`; the plain-text
 * query passes straight through (AQS handles bare words). Scoped to the whole
 * mail tree via `msgfolderroot`.
 */
export function searchItemEnvelope(query: string, offset: number, max: number): string {
  const q = xmlEscape(query);
  const body =
    '<m:FindItem Traversal="Shallow">' +
    findItemPrelude(offset, max) +
    `<m:QueryString>${q}</m:QueryString>` +
    '<m:ParentFolderIds>' +
    '<t:DistinguishedFolderId Id="msgfolderroot"/>' +
    '</m:ParentFolderIds>' +
    '</m:FindItem>';
  return soapEnvelope(body);
}

/**
 * GetItem for a single message (spec §5.3, `getMessage`): Default shape with
 * the HTML body and no MIME content. `IncludeMimeContent=false` keeps the
 * payload small; ConversationId is requested explicitly because Default shape
 * does not always carry it. No read-flag side effect — the app marks read
 * explicitly (current contract).
 */
export function getItemEnvelope(itemId: string): string {
  const id = xmlEscape(itemId);
  const body =
    '<m:GetItem>' +
    '<m:ItemShape>' +
    '<t:BaseShape>Default</t:BaseShape>' +
    '<t:IncludeMimeContent>false</t:IncludeMimeContent>' +
    '<t:BodyType>HTML</t:BodyType>' +
    '<t:AdditionalProperties>' +
    '<t:FieldURI FieldURI="conversation:ConversationId"/>' +
    '</t:AdditionalProperties>' +
    '</m:ItemShape>' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${id}"/>` +
    '</m:ItemIds>' +
    '</m:GetItem>';
  return soapEnvelope(body);
}

/**
 * CreateFolder for a new mail folder (spec §5.3, `createFolder`). Parent is
 * `msgfolderroot` unless a concrete `parentId` (opaque EWS FolderId) is given.
 */
export function createFolderEnvelope(name: string, parentId?: string): string {
  const parent = parentId
    ? `<t:FolderId Id="${xmlEscape(parentId)}"/>`
    : '<t:DistinguishedFolderId Id="msgfolderroot"/>';
  const body =
    '<m:CreateFolder>' +
    '<m:ParentFolderId>' +
    parent +
    '</m:ParentFolderId>' +
    '<m:Folders>' +
    '<t:Folder>' +
    `<t:DisplayName>${xmlEscape(name)}</t:DisplayName>` +
    '</t:Folder>' +
    '</m:Folders>' +
    '</m:CreateFolder>';
  return soapEnvelope(body);
}

/** DeleteFolder with a HardDelete (spec §5.3, `deleteFolder`). */
export function deleteFolderEnvelope(folderId: string): string {
  const id = xmlEscape(folderId);
  const body =
    '<m:DeleteFolder DeleteType="HardDelete">' +
    '<m:FolderIds>' +
    `<t:FolderId Id="${id}"/>` +
    '</m:FolderIds>' +
    '</m:DeleteFolder>';
  return soapEnvelope(body);
}

/** UpdateFolder setting `folder:DisplayName` (spec §5.3, `renameFolder`). */
export function renameFolderEnvelope(folderId: string, name: string): string {
  const id = xmlEscape(folderId);
  const body =
    '<m:UpdateFolder>' +
    '<m:FolderChanges>' +
    '<t:FolderChange>' +
    `<t:FolderId Id="${id}"/>` +
    '<t:Updates>' +
    '<t:SetFolderField>' +
    '<t:FieldURI FieldURI="folder:DisplayName"/>' +
    '<t:Folder>' +
    `<t:DisplayName>${xmlEscape(name)}</t:DisplayName>` +
    '</t:Folder>' +
    '</t:SetFolderField>' +
    '</t:Updates>' +
    '</t:FolderChange>' +
    '</m:FolderChanges>' +
    '</m:UpdateFolder>';
  return soapEnvelope(body);
}

/** EmptyFolder — move contents to Deleted Items, keep subfolders (spec §5.3,
 *  `emptyFolder`). */
export function emptyFolderEnvelope(folderId: string): string {
  const id = xmlEscape(folderId);
  const body =
    '<m:EmptyFolder DeleteType="MoveToDeletedItems" DeleteSubFolders="false">' +
    '<m:FolderIds>' +
    `<t:FolderId Id="${id}"/>` +
    '</m:FolderIds>' +
    '</m:EmptyFolder>';
  return soapEnvelope(body);
}
