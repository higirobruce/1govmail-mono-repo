import {
  soapEnvelope, xmlEscape, getFolderEnvelope,
  findFolderEnvelope, findItemEnvelope, searchItemEnvelope, getItemEnvelope,
  createFolderEnvelope, deleteFolderEnvelope, renameFolderEnvelope, emptyFolderEnvelope,
  getItemChangeKeyEnvelope, markReadEnvelope, moveItemEnvelope, deleteItemEnvelope,
  createMessageEnvelope, createReplyForwardEnvelope, createAttachmentEnvelope,
  sendItemEnvelope, updateDraftEnvelope, getAttachmentEnvelope,
} from './ews-envelopes';

describe('xmlEscape', () => {
  it('escapes & < > " \'', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('leaves ordinary text untouched', () => {
    expect(xmlEscape('hello world 123')).toBe('hello world 123');
  });
});

describe('soapEnvelope', () => {
  const xml = soapEnvelope('<m:GetFolder/>');

  it('declares the three EWS namespaces', () => {
    expect(xml).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(xml).toContain(
      'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"',
    );
    expect(xml).toContain(
      'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"',
    );
  });

  it('sets RequestServerVersion to Exchange2013_SP1 in the SOAP header', () => {
    expect(xml).toContain('<t:RequestServerVersion Version="Exchange2013_SP1"/>');
    // Header must precede Body.
    expect(xml.indexOf('soap:Header')).toBeLessThan(xml.indexOf('soap:Body'));
  });

  it('wraps the given body inside soap:Body', () => {
    expect(xml).toContain('<m:GetFolder/>');
    const bodyStart = xml.indexOf('<soap:Body>');
    const bodyEnd = xml.indexOf('</soap:Body>');
    const inner = xml.indexOf('<m:GetFolder/>');
    expect(inner).toBeGreaterThan(bodyStart);
    expect(inner).toBeLessThan(bodyEnd);
  });
});

describe('getFolderEnvelope', () => {
  it('builds a GetFolder request for the given DistinguishedFolderId', () => {
    const xml = getFolderEnvelope('inbox');
    expect(xml).toContain('<m:GetFolder');
    expect(xml).toContain('<t:DistinguishedFolderId Id="inbox"/>');
  });

  it('escapes the distinguished id', () => {
    const xml = getFolderEnvelope('a&b');
    expect(xml).toContain('<t:DistinguishedFolderId Id="a&amp;b"/>');
  });
});

describe('findFolderEnvelope', () => {
  const xml = findFolderEnvelope();
  it('is a Deep FindFolder rooted at msgfolderroot', () => {
    expect(xml).toContain('<m:FindFolder Traversal="Deep">');
    expect(xml).toContain('<t:DistinguishedFolderId Id="msgfolderroot"/>');
    expect(xml).toContain('<t:BaseShape>Default</t:BaseShape>');
  });
});

describe('findItemEnvelope', () => {
  const xml = findItemEnvelope('FOLDER-1==', 50, 25);
  it('pages with IndexedPageItemView (Offset/MaxEntriesReturned) over the folder', () => {
    expect(xml).toContain('<m:FindItem Traversal="Shallow">');
    expect(xml).toContain('<m:IndexedPageItemView MaxEntriesReturned="25" Offset="50" BasePoint="Beginning"/>');
    expect(xml).toContain('<t:FolderId Id="FOLDER-1=="/>');
  });
  it('sorts item:DateTimeReceived descending', () => {
    expect(xml).toContain('<t:FieldOrder Order="Descending">');
    expect(xml).toContain('<t:FieldURI FieldURI="item:DateTimeReceived"/>');
  });
  it('requests IdOnly + the summary AdditionalProperties', () => {
    expect(xml).toContain('<t:BaseShape>IdOnly</t:BaseShape>');
    for (const fu of [
      'item:Subject', 'message:From', 'message:ToRecipients', 'item:DateTimeReceived',
      'item:Size', 'message:IsRead', 'item:HasAttachments', 'item:Flag',
      'conversation:ConversationId', 'item:Preview',
    ]) {
      expect(xml).toContain(`<t:FieldURI FieldURI="${fu}"/>`);
    }
  });
  it('clamps a negative offset and zero max to safe values', () => {
    const clamped = findItemEnvelope('F', -5, 0);
    expect(clamped).toContain('Offset="0"');
    expect(clamped).toContain('MaxEntriesReturned="1"');
  });
});

describe('searchItemEnvelope', () => {
  it('carries an escaped AQS QueryString and scopes to msgfolderroot', () => {
    const xml = searchItemEnvelope('budget & "Q3"', 0, 20);
    expect(xml).toContain('<m:QueryString>budget &amp; &quot;Q3&quot;</m:QueryString>');
    expect(xml).toContain('<t:DistinguishedFolderId Id="msgfolderroot"/>');
    expect(xml).toContain('<m:IndexedPageItemView MaxEntriesReturned="20" Offset="0" BasePoint="Beginning"/>');
  });
});

describe('getItemEnvelope', () => {
  const xml = getItemEnvelope('ITEM-1==');
  it('requests an HTML body with no MIME content for the given ItemId', () => {
    expect(xml).toContain('<m:GetItem>');
    expect(xml).toContain('<t:BodyType>HTML</t:BodyType>');
    expect(xml).toContain('<t:IncludeMimeContent>false</t:IncludeMimeContent>');
    expect(xml).toContain('<t:ItemId Id="ITEM-1=="/>');
  });
});

describe('createFolderEnvelope', () => {
  it('creates under msgfolderroot by default', () => {
    const xml = createFolderEnvelope('Reports');
    expect(xml).toContain('<m:CreateFolder>');
    expect(xml).toContain('<t:DistinguishedFolderId Id="msgfolderroot"/>');
    expect(xml).toContain('<t:DisplayName>Reports</t:DisplayName>');
  });
  it('creates under a concrete parent FolderId when given, escaping the name', () => {
    const xml = createFolderEnvelope('A & B', 'PARENT==');
    expect(xml).toContain('<t:FolderId Id="PARENT=="/>');
    expect(xml).toContain('<t:DisplayName>A &amp; B</t:DisplayName>');
  });
});

describe('deleteFolderEnvelope', () => {
  it('is a HardDelete for the FolderId', () => {
    const xml = deleteFolderEnvelope('F==');
    expect(xml).toContain('<m:DeleteFolder DeleteType="HardDelete">');
    expect(xml).toContain('<t:FolderId Id="F=="/>');
  });
});

describe('renameFolderEnvelope', () => {
  it('sets folder:DisplayName via UpdateFolder', () => {
    const xml = renameFolderEnvelope('F==', 'Archive');
    expect(xml).toContain('<m:UpdateFolder>');
    expect(xml).toContain('<t:FieldURI FieldURI="folder:DisplayName"/>');
    expect(xml).toContain('<t:DisplayName>Archive</t:DisplayName>');
    expect(xml).toContain('<t:FolderId Id="F=="/>');
  });
});

describe('emptyFolderEnvelope', () => {
  it('moves contents to Deleted Items and keeps subfolders', () => {
    const xml = emptyFolderEnvelope('F==');
    expect(xml).toContain('<m:EmptyFolder DeleteType="MoveToDeletedItems" DeleteSubFolders="false">');
    expect(xml).toContain('<t:FolderId Id="F=="/>');
  });
});

describe('getItemChangeKeyEnvelope', () => {
  it('is an IdOnly GetItem for the item (the fresh-change-key probe)', () => {
    const xml = getItemChangeKeyEnvelope('ITEM-1==');
    expect(xml).toContain('<m:GetItem>');
    expect(xml).toContain('<t:BaseShape>IdOnly</t:BaseShape>');
    expect(xml).toContain('<t:ItemId Id="ITEM-1=="/>');
  });
});

describe('markReadEnvelope', () => {
  it('sets message:IsRead with SuppressReadReceipts and the given change key', () => {
    const xml = markReadEnvelope('ITEM-1==', 'CK9', true);
    expect(xml).toContain('<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite" SuppressReadReceipts="true">');
    expect(xml).toContain('<t:ItemId Id="ITEM-1==" ChangeKey="CK9"/>');
    expect(xml).toContain('<t:FieldURI FieldURI="message:IsRead"/>');
    expect(xml).toContain('<t:IsRead>true</t:IsRead>');
  });
  it('writes false when clearing the read flag', () => {
    expect(markReadEnvelope('I', 'C', false)).toContain('<t:IsRead>false</t:IsRead>');
  });
});

describe('moveItemEnvelope / deleteItemEnvelope', () => {
  it('moveItem targets a concrete FolderId', () => {
    const xml = moveItemEnvelope('ITEM-1==', 'FOLDER==');
    expect(xml).toContain('<m:MoveItem>');
    expect(xml).toContain('<t:FolderId Id="FOLDER=="/>');
    expect(xml).toContain('<t:ItemId Id="ITEM-1=="/>');
  });
  it('deleteItem moves to the deleteditems distinguished folder', () => {
    const xml = deleteItemEnvelope('ITEM-1==');
    expect(xml).toContain('<t:DistinguishedFolderId Id="deleteditems"/>');
    expect(xml).toContain('<t:ItemId Id="ITEM-1=="/>');
  });
});

describe('createMessageEnvelope', () => {
  it('creates a SaveOnly draft into drafts with subject/body/recipients in schema order', () => {
    const xml = createMessageEnvelope({
      subject: 'Hi', body: '<p>x</p>', to: ['a@x.rw'], cc: ['b@x.rw'],
    });
    expect(xml).toContain('<m:CreateItem MessageDisposition="SaveOnly">');
    expect(xml).toContain('<t:DistinguishedFolderId Id="drafts"/>');
    expect(xml).toContain('<t:Subject>Hi</t:Subject>');
    expect(xml).toContain('<t:Body BodyType="HTML">&lt;p&gt;x&lt;/p&gt;</t:Body>');
    expect(xml.indexOf('<t:Subject>')).toBeLessThan(xml.indexOf('<t:Body'));
    expect(xml.indexOf('<t:Body')).toBeLessThan(xml.indexOf('<t:ToRecipients>'));
    expect(xml).toContain('<t:ToRecipients><t:Mailbox><t:EmailAddress>a@x.rw</t:EmailAddress></t:Mailbox></t:ToRecipients>');
  });
  it('omits empty recipient containers', () => {
    const xml = createMessageEnvelope({ subject: 'Hi', body: 'x', to: ['a@x.rw'] });
    expect(xml).not.toContain('<t:CcRecipients>');
    expect(xml).not.toContain('<t:BccRecipients>');
  });
});

describe('createReplyForwardEnvelope', () => {
  it('builds a ReplyToItem referencing the original', () => {
    const xml = createReplyForwardEnvelope('ORIG==', 'r', { body: '<p>re</p>', to: ['a@x.rw'] });
    expect(xml).toContain('<t:ReplyToItem>');
    expect(xml).toContain('<t:ReferenceItemId Id="ORIG=="/>');
    expect(xml).toContain('<t:NewBodyContent BodyType="HTML">&lt;p&gt;re&lt;/p&gt;</t:NewBodyContent>');
  });
  it('builds a ForwardItem for replyType w', () => {
    const xml = createReplyForwardEnvelope('ORIG==', 'w', { body: 'x' });
    expect(xml).toContain('<t:ForwardItem>');
  });
});

describe('createAttachmentEnvelope', () => {
  it('attaches a FileAttachment with base64 content to the parent + change key', () => {
    const xml = createAttachmentEnvelope('DRAFT==', 'CK0', {
      name: 'a.pdf', contentType: 'application/pdf', contentBase64: 'QUJD',
    });
    expect(xml).toContain('<m:CreateAttachment>');
    expect(xml).toContain('<m:ParentItemId Id="DRAFT==" ChangeKey="CK0"/>');
    expect(xml).toContain('<t:Name>a.pdf</t:Name>');
    expect(xml).toContain('<t:Content>QUJD</t:Content>');
  });
  it('marks inline images with ContentId before IsInline (schema order)', () => {
    const xml = createAttachmentEnvelope('D', 'C', {
      name: 'l.png', contentType: 'image/png', contentBase64: 'QQ==', isInline: true, contentId: 'cid1',
    });
    expect(xml).toContain('<t:ContentId>cid1</t:ContentId>');
    expect(xml).toContain('<t:IsInline>true</t:IsInline>');
    expect(xml.indexOf('<t:ContentId>')).toBeLessThan(xml.indexOf('<t:IsInline>'));
  });
});

describe('sendItemEnvelope', () => {
  it('sends the staged item saving a copy to sentitems', () => {
    const xml = sendItemEnvelope('DRAFT==', 'CK1');
    expect(xml).toContain('<m:SendItem SaveItemToFolder="true">');
    expect(xml).toContain('<t:ItemId Id="DRAFT==" ChangeKey="CK1"/>');
    expect(xml).toContain('<t:DistinguishedFolderId Id="sentitems"/>');
  });
});

describe('updateDraftEnvelope', () => {
  it('overwrites only the provided fields, carrying the fresh change key', () => {
    const xml = updateDraftEnvelope('D==', 'CK9', { subject: 'New', body: '<p>b</p>' });
    expect(xml).toContain('<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">');
    expect(xml).toContain('<t:ItemId Id="D==" ChangeKey="CK9"/>');
    expect(xml).toContain('<t:FieldURI FieldURI="item:Subject"/>');
    expect(xml).toContain('<t:Subject>New</t:Subject>');
    expect(xml).toContain('<t:FieldURI FieldURI="item:Body"/>');
  });
  it('does not emit a SetItemField for an absent field', () => {
    const xml = updateDraftEnvelope('D==', 'CK9', { subject: 'Only' });
    expect(xml).not.toContain('item:Body');
    expect(xml).not.toContain('message:ToRecipients');
  });
});

describe('getAttachmentEnvelope', () => {
  it('requests one attachment by AttachmentId', () => {
    const xml = getAttachmentEnvelope('ATT-1==');
    expect(xml).toContain('<m:GetAttachment>');
    expect(xml).toContain('<t:AttachmentId Id="ATT-1=="/>');
  });
});
