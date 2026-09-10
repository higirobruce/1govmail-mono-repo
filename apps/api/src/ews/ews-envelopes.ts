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

import { MailSearchFilter, quoteAqs } from '../provider/mail-search-filter';

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

/**
 * PidTagConversationTopic (property tag 0x0070, PtypString) requested as an
 * extended MAPI property. Exchange's `FindItem` refuses to return the
 * strongly-typed `conversation:ConversationId` even when it is asked for
 * (verified live against MINAFFET: every other requested field comes back, that
 * one never does), which left every EWS message with a null conversationId and
 * so stuck on the single-message layout. The store keeps ConversationTopic
 * prefix-stripped ("Re:"/"Fwd:" removed) and identical across a reply chain, and
 * extended properties are NOT subject to the FindItem ConversationId limitation
 * — so it is a reliable grouping key. Shared by the FindItem summary set and the
 * GetItem shape so both list and single-open paths group the same way.
 */
export const CONVERSATION_TOPIC_TAG = 0x0070;
const CONVERSATION_TOPIC_FIELD =
  '<t:ExtendedFieldURI PropertyTag="0x0070" PropertyType="String"/>';

/** The AdditionalProperties block shared by the two FindItem envelopes
 *  (`getMessages`, `searchMessages`) — the message-summary field set from
 *  spec §5.3 (subject, from/to, date, size, IsRead, HasAttachments, flags,
 *  ConversationId, ConversationTopic, preview). */
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
  CONVERSATION_TOPIC_FIELD +
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
 * Translates a neutral `MailSearchFilter` into an Exchange AQS query string
 * (spec §5.3, structured search). Every user-supplied text value (keyword,
 * from, to, subject) is wrapped through `quoteAqs` so it can never break out
 * of its clause or inject a bare AQS operator. `folderId` is deliberately
 * NOT part of the query — folder scope is carried by `ParentFolderIds` in
 * `structuredSearchEnvelope`, never by an AQS token.
 *
 * `flagged` is intentionally omitted: AQS's flag-query syntax is unverified
 * against live Exchange, and the web search panel hides the Flagged control
 * for EWS accounts (approved scope decision — see task-3 brief).
 */
export function buildAqsQuery(f: MailSearchFilter): string {
  const parts: string[] = [];
  if (f.keyword?.trim()) parts.push(quoteAqs(f.keyword.trim()));
  if (f.from?.trim()) parts.push(`from:${quoteAqs(f.from.trim())}`);
  if (f.to?.trim()) parts.push(`to:${quoteAqs(f.to.trim())}`);
  if (f.subject?.trim()) parts.push(`subject:${quoteAqs(f.subject.trim())}`);

  const from = f.dateFrom?.trim();
  const to = f.dateTo?.trim();
  if (from && to) parts.push(`received:${from}..${to}`);
  else if (from) parts.push(`received:>=${from}`);
  else if (to) parts.push(`received:<=${to}`);

  if (f.hasAttachment) parts.push('hasattachment:yes');
  if (f.unread === true) parts.push('isread:no');
  else if (f.unread === false) parts.push('isread:yes');

  return parts.join(' ');
}

/**
 * FindItem with a translated-AQS `QueryString`, scoped via `ParentFolderIds`
 * to a single folder (`t:FolderId`) when one is given, else the whole mail
 * tree (`msgfolderroot`) — the folder is NEVER embedded in the query string
 * itself. Same paging/sort prelude as the other FindItem envelopes.
 */
export function structuredSearchEnvelope(
  aqs: string, folderId: string | undefined, offset: number, max: number,
): string {
  const scope = folderId
    ? `<t:FolderId Id="${xmlEscape(folderId)}"/>`
    : '<t:DistinguishedFolderId Id="msgfolderroot"/>';
  const body =
    '<m:FindItem Traversal="Shallow">' +
    findItemPrelude(offset, max) +
    `<m:QueryString>${xmlEscape(aqs)}</m:QueryString>` +
    '<m:ParentFolderIds>' +
    scope +
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
    CONVERSATION_TOPIC_FIELD +
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

// ── message mutations, send, drafts, attachments (Task 5) ───────────────────

/** The message fields an outgoing message / draft carries, in EWS schema order.
 *  `to`/`cc`/`bcc` are bare SMTP addresses. */
export interface EwsMessageFields {
  subject?: string;
  body?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

/** A single file to attach via `CreateAttachment`. `contentBase64` is the raw
 *  base64 of the bytes (already encoded by the caller). Inline images set
 *  `isInline` + `contentId` so the HTML body's `cid:` references resolve. */
export interface EwsFileAttachment {
  name: string;
  contentType: string;
  contentBase64: string;
  isInline?: boolean;
  contentId?: string;
}

/** One `<t:Mailbox>` from a bare SMTP address. */
function mailboxXml(email: string): string {
  return `<t:Mailbox><t:EmailAddress>${xmlEscape(email)}</t:EmailAddress></t:Mailbox>`;
}

/** A `<t:ToRecipients>`/`<t:CcRecipients>`/`<t:BccRecipients>` container, or the
 *  empty string when the list is absent/empty (EWS rejects an empty container). */
function recipientsXml(tag: 'ToRecipients' | 'CcRecipients' | 'BccRecipients', emails?: string[]): string {
  if (!emails || emails.length === 0) return '';
  return `<t:${tag}>${emails.map(mailboxXml).join('')}</t:${tag}>`;
}

/** The `<t:Message>` child sequence for a create — Subject, Body (from ItemType)
 *  then To/Cc/Bcc (from MessageType), which is the schema's required order. */
function messageFieldsXml(fields: EwsMessageFields): string {
  let xml = '';
  if (fields.subject !== undefined) xml += `<t:Subject>${xmlEscape(fields.subject)}</t:Subject>`;
  if (fields.body !== undefined) xml += `<t:Body BodyType="HTML">${xmlEscape(fields.body)}</t:Body>`;
  xml += recipientsXml('ToRecipients', fields.to);
  xml += recipientsXml('CcRecipients', fields.cc);
  xml += recipientsXml('BccRecipients', fields.bcc);
  return xml;
}

/**
 * GetItem returning only the ItemId (IdOnly shape) — the cheap call made
 * *immediately before* every UpdateItem to read the current ChangeKey fresh
 * (spec §5.3: fetch-fresh, never cache change keys). Used by `markRead` and the
 * draft-update path.
 */
export function getItemChangeKeyEnvelope(itemId: string): string {
  const id = xmlEscape(itemId);
  const body =
    '<m:GetItem>' +
    '<m:ItemShape>' +
    '<t:BaseShape>IdOnly</t:BaseShape>' +
    '</m:ItemShape>' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${id}"/>` +
    '</m:ItemIds>' +
    '</m:GetItem>';
  return soapEnvelope(body);
}

/**
 * UpdateItem toggling `message:IsRead` (spec §5.3, `markRead`). Carries the
 * freshly-read `changeKey`, `SuppressReadReceipts="true"` so flipping the flag
 * never fires a read receipt, and `MessageDisposition="SaveOnly"` (required for
 * message updates).
 */
export function markReadEnvelope(itemId: string, changeKey: string, read: boolean): string {
  const id = xmlEscape(itemId);
  const ck = xmlEscape(changeKey);
  const body =
    '<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite" SuppressReadReceipts="true">' +
    '<m:ItemChanges>' +
    '<t:ItemChange>' +
    `<t:ItemId Id="${id}" ChangeKey="${ck}"/>` +
    '<t:Updates>' +
    '<t:SetItemField>' +
    '<t:FieldURI FieldURI="message:IsRead"/>' +
    `<t:Message><t:IsRead>${read ? 'true' : 'false'}</t:IsRead></t:Message>` +
    '</t:SetItemField>' +
    '</t:Updates>' +
    '</t:ItemChange>' +
    '</m:ItemChanges>' +
    '</m:UpdateItem>';
  return soapEnvelope(body);
}

/** MoveItem to a concrete destination folder (spec §5.3, `moveMessage`). */
export function moveItemEnvelope(itemId: string, folderId: string): string {
  const body =
    '<m:MoveItem>' +
    '<m:ToFolderId>' +
    `<t:FolderId Id="${xmlEscape(folderId)}"/>` +
    '</m:ToFolderId>' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${xmlEscape(itemId)}"/>` +
    '</m:ItemIds>' +
    '</m:MoveItem>';
  return soapEnvelope(body);
}

/** MoveItem to the well-known `deleteditems` folder — the soft-delete that
 *  matches Zimbra's `op:'trash'` (spec §5.3, `deleteMessage`). */
export function deleteItemEnvelope(itemId: string): string {
  const body =
    '<m:MoveItem>' +
    '<m:ToFolderId>' +
    '<t:DistinguishedFolderId Id="deleteditems"/>' +
    '</m:ToFolderId>' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${xmlEscape(itemId)}"/>` +
    '</m:ItemIds>' +
    '</m:MoveItem>';
  return soapEnvelope(body);
}

/**
 * CreateItem `MessageDisposition="SaveOnly"` saving a fresh message into a
 * distinguished folder (`drafts` for both the send flow's staging draft and
 * `saveDraft`'s create). The returned ItemId+ChangeKey feed the CreateAttachment
 * / SendItem steps.
 */
export function createMessageEnvelope(fields: EwsMessageFields, savedFolder: 'drafts' | 'sentitems' = 'drafts'): string {
  const body =
    '<m:CreateItem MessageDisposition="SaveOnly">' +
    '<m:SavedItemFolderId>' +
    `<t:DistinguishedFolderId Id="${savedFolder}"/>` +
    '</m:SavedItemFolderId>' +
    '<m:Items>' +
    '<t:Message>' +
    messageFieldsXml(fields) +
    '</t:Message>' +
    '</m:Items>' +
    '</m:CreateItem>';
  return soapEnvelope(body);
}

/**
 * CreateItem building a `ReplyToItem` (replyType 'r') or `ForwardItem`
 * ('w') response object against `referenceItemId`, saved as a draft
 * (`MessageDisposition="SaveOnly"`). EWS sets the `References`/`In-Reply-To`
 * headers off the referenced item, which is what carries the thread — so the
 * app supplies only the new recipients + body (spec §5.3, reply/forward).
 *
 * Exchange REQUIRES the `ReferenceItemId` to carry the referenced item's CURRENT
 * `ChangeKey` for a ReplyToItem/ForwardItem create — without it the server
 * rejects the operation with `ErrorChangeKeyRequiredForWriteOperations`. The
 * caller reads that key fresh (GetItem IdOnly) immediately before this call, the
 * same fetch-fresh discipline every UpdateItem uses.
 */
export function createReplyForwardEnvelope(
  referenceItemId: string, referenceChangeKey: string, replyType: 'r' | 'w', fields: EwsMessageFields,
): string {
  const tag = replyType === 'w' ? 'ForwardItem' : 'ReplyToItem';
  let inner = '';
  if (fields.subject !== undefined) inner += `<t:Subject>${xmlEscape(fields.subject)}</t:Subject>`;
  inner += recipientsXml('ToRecipients', fields.to);
  inner += recipientsXml('CcRecipients', fields.cc);
  inner += recipientsXml('BccRecipients', fields.bcc);
  inner += `<t:ReferenceItemId Id="${xmlEscape(referenceItemId)}" ChangeKey="${xmlEscape(referenceChangeKey)}"/>`;
  if (fields.body !== undefined) inner += `<t:NewBodyContent BodyType="HTML">${xmlEscape(fields.body)}</t:NewBodyContent>`;
  const body =
    '<m:CreateItem MessageDisposition="SaveOnly">' +
    '<m:Items>' +
    `<t:${tag}>` + inner + `</t:${tag}>` +
    '</m:Items>' +
    '</m:CreateItem>';
  return soapEnvelope(body);
}

/**
 * CreateAttachment adding one `FileAttachment` to the staging draft (spec §5.3,
 * send flow). `parentChangeKey` MUST be the latest change key (CreateItem's, or
 * the previous CreateAttachment's `RootItemChangeKey`). Child order follows the
 * schema: Name, ContentType, ContentId, IsInline, Content.
 */
export function createAttachmentEnvelope(
  parentItemId: string, parentChangeKey: string, file: EwsFileAttachment,
): string {
  let att =
    '<t:FileAttachment>' +
    `<t:Name>${xmlEscape(file.name)}</t:Name>` +
    `<t:ContentType>${xmlEscape(file.contentType)}</t:ContentType>`;
  if (file.contentId) att += `<t:ContentId>${xmlEscape(file.contentId)}</t:ContentId>`;
  if (file.isInline) att += '<t:IsInline>true</t:IsInline>';
  att += `<t:Content>${file.contentBase64}</t:Content>`;
  att += '</t:FileAttachment>';
  const body =
    '<m:CreateAttachment>' +
    `<m:ParentItemId Id="${xmlEscape(parentItemId)}" ChangeKey="${xmlEscape(parentChangeKey)}"/>` +
    '<m:Attachments>' +
    att +
    '</m:Attachments>' +
    '</m:CreateAttachment>';
  return soapEnvelope(body);
}

/** SendItem for the staged draft, saving a copy to Sent Items (spec §5.3, send
 *  flow, final step). `changeKey` is the latest after the CreateAttachment run. */
export function sendItemEnvelope(itemId: string, changeKey: string): string {
  const body =
    '<m:SendItem SaveItemToFolder="true">' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${xmlEscape(itemId)}" ChangeKey="${xmlEscape(changeKey)}"/>` +
    '</m:ItemIds>' +
    '<m:SavedItemFolderId>' +
    '<t:DistinguishedFolderId Id="sentitems"/>' +
    '</m:SavedItemFolderId>' +
    '</m:SendItem>';
  return soapEnvelope(body);
}

/**
 * UpdateItem overwriting a draft's fields (spec §5.3, `saveDraft` update).
 * `ConflictResolution="AlwaysOverwrite"` + `MessageDisposition="SaveOnly"`;
 * only the fields present in `fields` are set. `changeKey` is freshly read.
 */
export function updateDraftEnvelope(itemId: string, changeKey: string, fields: EwsMessageFields): string {
  const setField = (fieldUri: string, inner: string): string =>
    '<t:SetItemField>' +
    `<t:FieldURI FieldURI="${fieldUri}"/>` +
    `<t:Message>${inner}</t:Message>` +
    '</t:SetItemField>';

  let updates = '';
  if (fields.subject !== undefined) {
    updates += setField('item:Subject', `<t:Subject>${xmlEscape(fields.subject)}</t:Subject>`);
  }
  if (fields.body !== undefined) {
    updates += setField('item:Body', `<t:Body BodyType="HTML">${xmlEscape(fields.body)}</t:Body>`);
  }
  if (fields.to && fields.to.length > 0) {
    updates += setField('message:ToRecipients', recipientsXml('ToRecipients', fields.to));
  }
  if (fields.cc && fields.cc.length > 0) {
    updates += setField('message:CcRecipients', recipientsXml('CcRecipients', fields.cc));
  }
  if (fields.bcc && fields.bcc.length > 0) {
    updates += setField('message:BccRecipients', recipientsXml('BccRecipients', fields.bcc));
  }

  const body =
    '<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">' +
    '<m:ItemChanges>' +
    '<t:ItemChange>' +
    `<t:ItemId Id="${xmlEscape(itemId)}" ChangeKey="${xmlEscape(changeKey)}"/>` +
    `<t:Updates>${updates}</t:Updates>` +
    '</t:ItemChange>' +
    '</m:ItemChanges>' +
    '</m:UpdateItem>';
  return soapEnvelope(body);
}

/** GetAttachment for one attachment part (spec §5.3, download). The response
 *  carries base64 `Content` + name/content-type metadata. */
export function getAttachmentEnvelope(attachmentId: string): string {
  const body =
    '<m:GetAttachment>' +
    '<m:AttachmentIds>' +
    `<t:AttachmentId Id="${xmlEscape(attachmentId)}"/>` +
    '</m:AttachmentIds>' +
    '</m:GetAttachment>';
  return soapEnvelope(body);
}

// ── contacts + GAL (Task 6) ─────────────────────────────────────────────────

/** The subset of ProviderContact fields that cross the wire on a create/update.
 *  `emails`/`phones` carry the same role vocabulary the read path emits, so a
 *  round-trip preserves them (see mapContact ↔ the EmailAddress1..3 / *Phone
 *  key mapping below). */
export interface EwsContactFields {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  notes?: string | null;
  emails?: Array<{ email: string; type?: string; primary?: boolean }>;
  phones?: Array<{ number: string; type?: string }>;
}

/** EWS keys the three contact email slots `EmailAddress1..3`. The read path
 *  maps 1→work/primary, 2→personal, 3→other; on write we assign by position
 *  (primary first) so the same round-trip holds. */
const CONTACT_EMAIL_KEYS = ['EmailAddress1', 'EmailAddress2', 'EmailAddress3'];

/** ProviderContact phone `type` → the EWS PhoneNumbers Entry key. Unknown types
 *  fall back to the business slot (the read path's `work`). */
function contactPhoneKey(type?: string): string {
  switch (type) {
    case 'mobile': return 'MobilePhone';
    case 'home': return 'HomePhone';
    default: return 'BusinessPhone';
  }
}

/** Primary email first, then declaration order, capped at the three EWS slots. */
function orderedContactEmails(emails?: EwsContactFields['emails']): Array<{ email: string }> {
  const list = (emails ?? []).filter((e) => e && e.email);
  const primaryFirst = [...list].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  return primaryFirst.slice(0, CONTACT_EMAIL_KEYS.length);
}

/** `<t:EmailAddresses>` block for a create, or '' when there are none. */
function contactEmailsXml(emails?: EwsContactFields['emails']): string {
  const ordered = orderedContactEmails(emails);
  if (ordered.length === 0) return '';
  const entries = ordered
    .map((e, i) => `<t:Entry Key="${CONTACT_EMAIL_KEYS[i]}">${xmlEscape(e.email)}</t:Entry>`)
    .join('');
  return `<t:EmailAddresses>${entries}</t:EmailAddresses>`;
}

/** `<t:PhoneNumbers>` block for a create, or '' when there are none. */
function contactPhonesXml(phones?: EwsContactFields['phones']): string {
  const list = (phones ?? []).filter((p) => p && p.number);
  if (list.length === 0) return '';
  const entries = list
    .map((p) => `<t:Entry Key="${contactPhoneKey(p.type)}">${xmlEscape(p.number)}</t:Entry>`)
    .join('');
  return `<t:PhoneNumbers>${entries}</t:PhoneNumbers>`;
}

/** The `<t:Contact>` child sequence, in EWS schema order (inherited ItemType
 *  `Body` first, then the ContactItemType-specific fields). Only present fields
 *  are emitted. */
function contactFieldsXml(c: EwsContactFields): string {
  let xml = '';
  if (c.notes != null) xml += `<t:Body BodyType="Text">${xmlEscape(c.notes)}</t:Body>`;
  if (c.displayName != null) xml += `<t:DisplayName>${xmlEscape(c.displayName)}</t:DisplayName>`;
  if (c.firstName != null) xml += `<t:GivenName>${xmlEscape(c.firstName)}</t:GivenName>`;
  if (c.nickname != null) xml += `<t:Nickname>${xmlEscape(c.nickname)}</t:Nickname>`;
  if (c.company != null) xml += `<t:CompanyName>${xmlEscape(c.company)}</t:CompanyName>`;
  xml += contactEmailsXml(c.emails);
  xml += contactPhonesXml(c.phones);
  if (c.jobTitle != null) xml += `<t:JobTitle>${xmlEscape(c.jobTitle)}</t:JobTitle>`;
  if (c.lastName != null) xml += `<t:Surname>${xmlEscape(c.lastName)}</t:Surname>`;
  return xml;
}

/**
 * FindItem over the well-known `contacts` folder, paged (spec §5.3,
 * `getContacts`). Default shape carries the contact properties the mapper
 * reads (GivenName/Surname/DisplayName/EmailAddresses/PhoneNumbers/CompanyName).
 */
export function findContactsEnvelope(offset: number, max: number): string {
  const off = Math.max(0, Math.trunc(offset));
  const cap = Math.max(1, Math.trunc(max));
  const body =
    '<m:FindItem Traversal="Shallow">' +
    '<m:ItemShape>' +
    '<t:BaseShape>Default</t:BaseShape>' +
    '</m:ItemShape>' +
    `<m:IndexedPageItemView MaxEntriesReturned="${cap}" Offset="${off}" BasePoint="Beginning"/>` +
    '<m:ParentFolderIds>' +
    '<t:DistinguishedFolderId Id="contacts"/>' +
    '</m:ParentFolderIds>' +
    '</m:FindItem>';
  return soapEnvelope(body);
}

/** CreateItem building one `<t:Contact>` in the `contacts` folder (spec §5.3,
 *  `createContact`). */
export function createContactEnvelope(fields: EwsContactFields): string {
  const body =
    '<m:CreateItem>' +
    '<m:SavedItemFolderId>' +
    '<t:DistinguishedFolderId Id="contacts"/>' +
    '</m:SavedItemFolderId>' +
    '<m:Items>' +
    '<t:Contact>' +
    contactFieldsXml(fields) +
    '</t:Contact>' +
    '</m:Items>' +
    '</m:CreateItem>';
  return soapEnvelope(body);
}

/** One SetItemField for a scalar `contacts:`/`item:` field. */
function setContactField(fieldUri: string, inner: string): string {
  return (
    '<t:SetItemField>' +
    `<t:FieldURI FieldURI="${fieldUri}"/>` +
    `<t:Contact>${inner}</t:Contact>` +
    '</t:SetItemField>'
  );
}

/** One SetItemField for an indexed contact field (email/phone slot). */
function setIndexedContactField(fieldUri: string, index: string, inner: string): string {
  return (
    '<t:SetItemField>' +
    `<t:IndexedFieldURI FieldURI="${fieldUri}" FieldIndex="${index}"/>` +
    `<t:Contact>${inner}</t:Contact>` +
    '</t:SetItemField>'
  );
}

/**
 * UpdateItem overwriting the present fields of a contact (spec §5.3,
 * `modifyContact`). `changeKey` is freshly read immediately before this call.
 * Only the fields carried on `fields` are set.
 */
export function updateContactEnvelope(itemId: string, changeKey: string, fields: EwsContactFields): string {
  let updates = '';
  if (fields.notes != null) {
    updates += setContactField('item:Body', `<t:Body BodyType="Text">${xmlEscape(fields.notes)}</t:Body>`);
  }
  if (fields.displayName != null) {
    updates += setContactField('contacts:DisplayName', `<t:DisplayName>${xmlEscape(fields.displayName)}</t:DisplayName>`);
  }
  if (fields.firstName != null) {
    updates += setContactField('contacts:GivenName', `<t:GivenName>${xmlEscape(fields.firstName)}</t:GivenName>`);
  }
  if (fields.lastName != null) {
    updates += setContactField('contacts:Surname', `<t:Surname>${xmlEscape(fields.lastName)}</t:Surname>`);
  }
  if (fields.nickname != null) {
    updates += setContactField('contacts:Nickname', `<t:Nickname>${xmlEscape(fields.nickname)}</t:Nickname>`);
  }
  if (fields.company != null) {
    updates += setContactField('contacts:CompanyName', `<t:CompanyName>${xmlEscape(fields.company)}</t:CompanyName>`);
  }
  if (fields.jobTitle != null) {
    updates += setContactField('contacts:JobTitle', `<t:JobTitle>${xmlEscape(fields.jobTitle)}</t:JobTitle>`);
  }
  orderedContactEmails(fields.emails).forEach((e, i) => {
    const key = CONTACT_EMAIL_KEYS[i];
    updates += setIndexedContactField(
      'contacts:EmailAddress', key,
      `<t:EmailAddresses><t:Entry Key="${key}">${xmlEscape(e.email)}</t:Entry></t:EmailAddresses>`,
    );
  });
  for (const p of (fields.phones ?? []).filter((x) => x && x.number)) {
    const key = contactPhoneKey(p.type);
    updates += setIndexedContactField(
      'contacts:PhoneNumber', key,
      `<t:PhoneNumbers><t:Entry Key="${key}">${xmlEscape(p.number)}</t:Entry></t:PhoneNumbers>`,
    );
  }

  const body =
    '<m:UpdateItem ConflictResolution="AlwaysOverwrite">' +
    '<m:ItemChanges>' +
    '<t:ItemChange>' +
    `<t:ItemId Id="${xmlEscape(itemId)}" ChangeKey="${xmlEscape(changeKey)}"/>` +
    `<t:Updates>${updates}</t:Updates>` +
    '</t:ItemChange>' +
    '</m:ItemChanges>' +
    '</m:UpdateItem>';
  return soapEnvelope(body);
}

/**
 * ResolveNames (spec §5.3) — the single EWS op behind BOTH `autoCompleteContacts`
 * and `searchGal`. `ReturnFullContactData="true"` so a resolved entry carries a
 * contact record, `SearchScope="ActiveDirectoryContacts"` to reach the GAL plus
 * the user's contacts. The query is the unresolved entry.
 */
export function resolveNamesEnvelope(query: string): string {
  const body =
    '<m:ResolveNames ReturnFullContactData="true" SearchScope="ActiveDirectoryContacts">' +
    `<m:UnresolvedEntry>${xmlEscape(query)}</m:UnresolvedEntry>` +
    '</m:ResolveNames>';
  return soapEnvelope(body);
}

// ── calendar (Task 6) ───────────────────────────────────────────────────────

/**
 * An EWS calendar dateTime, always UTC. An all-day boundary is the date at
 * UTC midnight (no time-of-day carried by the event); a timed value keeps
 * minute granularity with seconds zeroed.
 */
export function formatEwsCalDateTime(d: Date, allDay: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (allDay) return `${date}T00:00:00Z`;
  return `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00Z`;
}

/** The fields a calendar create/update carries. */
export interface EwsCalendarFields {
  title: string;
  location?: string | null;
  description?: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  attendees?: string[];
}

/** `<t:RequiredAttendees>` block, or '' when there are none. */
function requiredAttendeesXml(attendees?: string[]): string {
  const list = (attendees ?? []).filter(Boolean);
  if (list.length === 0) return '';
  const entries = list.map((a) => `<t:Attendee>${mailboxXml(a)}</t:Attendee>`).join('');
  return `<t:RequiredAttendees>${entries}</t:RequiredAttendees>`;
}

/** The `<t:CalendarItem>` child sequence, in schema order (inherited Subject/
 *  Body first, then Start/End/IsAllDayEvent/Location/RequiredAttendees). */
function calendarFieldsXml(f: EwsCalendarFields): string {
  let xml = `<t:Subject>${xmlEscape(f.title)}</t:Subject>`;
  if (f.description != null) xml += `<t:Body BodyType="HTML">${xmlEscape(f.description)}</t:Body>`;
  xml += `<t:Start>${formatEwsCalDateTime(f.startAt, f.allDay)}</t:Start>`;
  xml += `<t:End>${formatEwsCalDateTime(f.endAt, f.allDay)}</t:End>`;
  if (f.allDay) xml += '<t:IsAllDayEvent>true</t:IsAllDayEvent>';
  if (f.location != null) xml += `<t:Location>${xmlEscape(f.location)}</t:Location>`;
  xml += requiredAttendeesXml(f.attendees);
  return xml;
}

/**
 * FindItem with a `CalendarView` over the well-known `calendar` folder (spec
 * §5.3, `getCalendarEvents`). CalendarView expands recurrences server-side, so
 * the window `[startIso, endIso)` yields concrete occurrences.
 */
export function findCalendarEnvelope(startIso: string, endIso: string): string {
  const body =
    '<m:FindItem Traversal="Shallow">' +
    '<m:ItemShape>' +
    '<t:BaseShape>Default</t:BaseShape>' +
    '</m:ItemShape>' +
    `<m:CalendarView StartDate="${xmlEscape(startIso)}" EndDate="${xmlEscape(endIso)}"/>` +
    '<m:ParentFolderIds>' +
    '<t:DistinguishedFolderId Id="calendar"/>' +
    '</m:ParentFolderIds>' +
    '</m:FindItem>';
  return soapEnvelope(body);
}

/**
 * GetItem for one appointment (spec §5.3, `getAppointment`). Default shape plus
 * the attendee lists (each `Attendee` carries a `ResponseType` → the app's
 * `ptst`) and the organizer.
 */
export function getAppointmentEnvelope(itemId: string): string {
  const body =
    '<m:GetItem>' +
    '<m:ItemShape>' +
    '<t:BaseShape>Default</t:BaseShape>' +
    '<t:AdditionalProperties>' +
    '<t:FieldURI FieldURI="calendar:RequiredAttendees"/>' +
    '<t:FieldURI FieldURI="calendar:OptionalAttendees"/>' +
    '<t:FieldURI FieldURI="calendar:Organizer"/>' +
    '</t:AdditionalProperties>' +
    '</m:ItemShape>' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${xmlEscape(itemId)}"/>` +
    '</m:ItemIds>' +
    '</m:GetItem>';
  return soapEnvelope(body);
}

/**
 * CreateItem building a `<t:CalendarItem>` and mailing invitations (spec §5.3,
 * `createCalendarEvent`). `SendMeetingInvitations="SendToAllAndSaveCopy"` sends
 * the invite to every attendee and saves the organizer's copy. The authenticated
 * mailbox is the organizer — EWS does not accept a foreign Organizer on create.
 */
export function createCalendarEventEnvelope(fields: EwsCalendarFields): string {
  const body =
    '<m:CreateItem SendMeetingInvitations="SendToAllAndSaveCopy">' +
    '<m:SavedItemFolderId>' +
    '<t:DistinguishedFolderId Id="calendar"/>' +
    '</m:SavedItemFolderId>' +
    '<m:Items>' +
    '<t:CalendarItem>' +
    calendarFieldsXml(fields) +
    '</t:CalendarItem>' +
    '</m:Items>' +
    '</m:CreateItem>';
  return soapEnvelope(body);
}

/** One SetItemField wrapping a CalendarItem field. */
function setCalendarField(fieldUri: string, inner: string): string {
  return (
    '<t:SetItemField>' +
    `<t:FieldURI FieldURI="${fieldUri}"/>` +
    `<t:CalendarItem>${inner}</t:CalendarItem>` +
    '</t:SetItemField>'
  );
}

/**
 * UpdateItem overwriting an appointment and re-sending invitations (spec §5.3,
 * `modifyCalendarEvent`). `SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy"`;
 * `changeKey` is freshly read immediately before this call. An appointment
 * update resends the whole component, so title/start/end are always set.
 */
export function updateCalendarEventEnvelope(itemId: string, changeKey: string, fields: EwsCalendarFields): string {
  let updates = '';
  updates += setCalendarField('item:Subject', `<t:Subject>${xmlEscape(fields.title)}</t:Subject>`);
  if (fields.description != null) {
    updates += setCalendarField('item:Body', `<t:Body BodyType="HTML">${xmlEscape(fields.description)}</t:Body>`);
  }
  updates += setCalendarField('calendar:Start', `<t:Start>${formatEwsCalDateTime(fields.startAt, fields.allDay)}</t:Start>`);
  updates += setCalendarField('calendar:End', `<t:End>${formatEwsCalDateTime(fields.endAt, fields.allDay)}</t:End>`);
  updates += setCalendarField('calendar:IsAllDayEvent', `<t:IsAllDayEvent>${fields.allDay ? 'true' : 'false'}</t:IsAllDayEvent>`);
  if (fields.location != null) {
    updates += setCalendarField('calendar:Location', `<t:Location>${xmlEscape(fields.location)}</t:Location>`);
  }
  if ((fields.attendees ?? []).filter(Boolean).length > 0) {
    updates += setCalendarField('calendar:RequiredAttendees', requiredAttendeesXml(fields.attendees));
  }

  const body =
    '<m:UpdateItem ConflictResolution="AlwaysOverwrite" SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">' +
    '<m:ItemChanges>' +
    '<t:ItemChange>' +
    `<t:ItemId Id="${xmlEscape(itemId)}" ChangeKey="${xmlEscape(changeKey)}"/>` +
    `<t:Updates>${updates}</t:Updates>` +
    '</t:ItemChange>' +
    '</m:ItemChanges>' +
    '</m:UpdateItem>';
  return soapEnvelope(body);
}

/** DeleteItem moving an appointment to Deleted Items and cancelling it for the
 *  attendees (spec §5.3, `deleteCalendarEvent`). */
export function deleteCalendarEventEnvelope(itemId: string): string {
  const body =
    '<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToAllAndSaveCopy">' +
    '<m:ItemIds>' +
    `<t:ItemId Id="${xmlEscape(itemId)}"/>` +
    '</m:ItemIds>' +
    '</m:DeleteItem>';
  return soapEnvelope(body);
}

/**
 * CreateItem building an `AcceptItem`/`DeclineItem`/`TentativelyAcceptItem`
 * response object against the invite's ItemId (spec §5.3, `sendInviteReply`).
 * `MessageDisposition="SendAndSaveCopy"` fires the RSVP mail.
 */
export function inviteReplyEnvelope(inviteId: string, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE'): string {
  const tag =
    verb === 'DECLINE' ? 'DeclineItem'
      : verb === 'TENTATIVE' ? 'TentativelyAcceptItem'
        : 'AcceptItem';
  const body =
    '<m:CreateItem MessageDisposition="SendAndSaveCopy">' +
    '<m:Items>' +
    `<t:${tag}>` +
    `<t:ReferenceItemId Id="${xmlEscape(inviteId)}"/>` +
    `</t:${tag}>` +
    '</m:Items>' +
    '</m:CreateItem>';
  return soapEnvelope(body);
}

/**
 * Format an epoch-ms instant as an UNQUALIFIED local datetime
 * `YYYY-MM-DDTHH:MM:SS` — no trailing `Z`, no milliseconds, no offset.
 * `GetUserAvailability`'s `TimeWindow` boundaries are read against the request's
 * declared `TimeZone`; the fixed-offset zero-bias UTC `TimeZone` in
 * `getUserAvailabilityEnvelope` makes this bare UTC wall-clock resolve to the
 * exact instants the caller passed. (The generic `0x80131500` fault seen in live
 * testing came from an invalid TimeZone declaration, not this datetime format.)
 */
export function toUnqualifiedUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * GetUserAvailabilityRequest for one mailbox over `[startTime, endTime)` (spec
 * §5.3, `getFreeBusy`). `RequestedView="FreeBusy"` returns the per-slot
 * CalendarEventArray the mapper folds into the {busy,tentative,unavailable}
 * triple. A zero-bias UTC TimeZone is declared so the window is interpreted as
 * the UTC instants the caller passed. `startTime`/`endTime` MUST be unqualified
 * `YYYY-MM-DDTHH:MM:SS` (see `toUnqualifiedUtc`) — a `Z`/millisecond-bearing
 * value faults the request generically.
 */
export function getUserAvailabilityEnvelope(email: string, startTime: string, endTime: string): string {
  const body =
    '<m:GetUserAvailabilityRequest>' +
    // Fixed-offset UTC zone. StandardTime/DaylightTime MUST express "no DST
    // transition" via Month=0/DayOrder=0 — declaring two real transitions (e.g.
    // both on the Jan first-Sunday) makes Exchange's Availability service reject
    // the request with faultstring "The specified time zone isn't valid."
    // (HRESULT -2146233088 / 0x80131500). With no transition and every Bias=0,
    // the window boundaries are read as the UTC instants the caller passed.
    '<t:TimeZone>' +
    '<t:Bias>0</t:Bias>' +
    '<t:StandardTime><t:Bias>0</t:Bias><t:Time>00:00:00</t:Time><t:DayOrder>0</t:DayOrder><t:Month>0</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:StandardTime>' +
    '<t:DaylightTime><t:Bias>0</t:Bias><t:Time>00:00:00</t:Time><t:DayOrder>0</t:DayOrder><t:Month>0</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:DaylightTime>' +
    '</t:TimeZone>' +
    '<m:MailboxDataArray>' +
    '<t:MailboxData>' +
    `<t:Email><t:Address>${xmlEscape(email)}</t:Address></t:Email>` +
    '<t:AttendeeType>Required</t:AttendeeType>' +
    '<t:ExcludeConflicts>false</t:ExcludeConflicts>' +
    '</t:MailboxData>' +
    '</m:MailboxDataArray>' +
    '<t:FreeBusyViewOptions>' +
    '<t:TimeWindow>' +
    `<t:StartTime>${xmlEscape(startTime)}</t:StartTime>` +
    `<t:EndTime>${xmlEscape(endTime)}</t:EndTime>` +
    '</t:TimeWindow>' +
    '<t:MergedFreeBusyIntervalInMinutes>30</t:MergedFreeBusyIntervalInMinutes>' +
    '<t:RequestedView>FreeBusy</t:RequestedView>' +
    '</t:FreeBusyViewOptions>' +
    '</m:GetUserAvailabilityRequest>';
  return soapEnvelope(body);
}
