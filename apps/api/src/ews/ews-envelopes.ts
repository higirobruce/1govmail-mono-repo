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
 */
export function createReplyForwardEnvelope(
  referenceItemId: string, replyType: 'r' | 'w', fields: EwsMessageFields,
): string {
  const tag = replyType === 'w' ? 'ForwardItem' : 'ReplyToItem';
  let inner = '';
  if (fields.subject !== undefined) inner += `<t:Subject>${xmlEscape(fields.subject)}</t:Subject>`;
  inner += recipientsXml('ToRecipients', fields.to);
  inner += recipientsXml('CcRecipients', fields.cc);
  inner += recipientsXml('BccRecipients', fields.bcc);
  inner += `<t:ReferenceItemId Id="${xmlEscape(referenceItemId)}"/>`;
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
