import {
  soapEnvelope, xmlEscape, getFolderEnvelope,
  findFolderEnvelope, findItemEnvelope, searchItemEnvelope, getItemEnvelope,
  createFolderEnvelope, deleteFolderEnvelope, renameFolderEnvelope, emptyFolderEnvelope,
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
