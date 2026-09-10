import {
  parseEws, responseClassOf, responseCodeOf, messageTextOf, toArray, toBool, textOf,
} from './ews-parse';

const GET_FOLDER_SUCCESS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header>
    <h:ServerVersionInfo xmlns:h="http://schemas.microsoft.com/exchange/services/2006/types" Version="Exchange2013_SP1"/>
  </s:Header>
  <s:Body>
    <m:GetFolderResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
      <m:ResponseMessages>
        <m:GetFolderResponseMessage ResponseClass="Success">
          <m:ResponseCode>NoError</m:ResponseCode>
          <m:Folders>
            <t:Folder>
              <t:FolderId Id="AAA=" ChangeKey="BBB"/>
              <t:DisplayName>Inbox</t:DisplayName>
              <t:UnreadCount>5</t:UnreadCount>
              <t:TotalCount>42</t:TotalCount>
            </t:Folder>
          </m:Folders>
        </m:GetFolderResponseMessage>
      </m:ResponseMessages>
    </m:GetFolderResponse>
  </s:Body>
</s:Envelope>`;

const GET_FOLDER_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <m:GetFolderResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
      <m:ResponseMessages>
        <m:GetFolderResponseMessage ResponseClass="Error">
          <m:MessageText>Id is malformed.</m:MessageText>
          <m:ResponseCode>ErrorInvalidIdMalformed</m:ResponseCode>
        </m:GetFolderResponseMessage>
      </m:ResponseMessages>
    </m:GetFolderResponse>
  </s:Body>
</s:Envelope>`;

describe('parseEws', () => {
  it('parses a GetFolderResponse down to the folder fields', () => {
    const doc = parseEws(GET_FOLDER_SUCCESS);
    const folder =
      doc.Envelope.Body.GetFolderResponse.ResponseMessages.GetFolderResponseMessage.Folders
        .Folder;

    expect(folder.DisplayName).toBe('Inbox');
    expect(folder.UnreadCount).toBe(5);
    expect(folder.TotalCount).toBe(42);
  });

  it('strips namespace prefixes from element names', () => {
    const doc = parseEws(GET_FOLDER_SUCCESS);
    expect(doc.Envelope).toBeDefined();
    expect(doc.Envelope.Body.GetFolderResponse).toBeDefined();
  });

  it('keeps attributes readable (ignoreAttributes: false)', () => {
    const doc = parseEws(GET_FOLDER_SUCCESS);
    const msg =
      doc.Envelope.Body.GetFolderResponse.ResponseMessages.GetFolderResponseMessage;
    expect(msg['@_ResponseClass']).toBe('Success');
  });
});

describe('responseClassOf / responseCodeOf / messageTextOf', () => {
  it('reads Success + NoError off a success message, with no MessageText', () => {
    const doc = parseEws(GET_FOLDER_SUCCESS);
    const msg =
      doc.Envelope.Body.GetFolderResponse.ResponseMessages.GetFolderResponseMessage;

    expect(responseClassOf(msg)).toBe('Success');
    expect(responseCodeOf(msg)).toBe('NoError');
    expect(messageTextOf(msg)).toBeUndefined();
  });

  it('reads Error + code + message text off an error message', () => {
    const doc = parseEws(GET_FOLDER_ERROR);
    const msg =
      doc.Envelope.Body.GetFolderResponse.ResponseMessages.GetFolderResponseMessage;

    expect(responseClassOf(msg)).toBe('Error');
    expect(responseCodeOf(msg)).toBe('ErrorInvalidIdMalformed');
    expect(messageTextOf(msg)).toBe('Id is malformed.');
  });
});

describe('toArray', () => {
  it('wraps a lone object, passes an array through, and empties null/undefined', () => {
    expect(toArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toArray([1, 2])).toEqual([1, 2]);
    expect(toArray(undefined)).toEqual([]);
    expect(toArray(null)).toEqual([]);
  });
});

describe('toBool', () => {
  it('treats the string "true", boolean true and 1 as true; everything else false', () => {
    expect(toBool('true')).toBe(true);
    expect(toBool(true)).toBe(true);
    expect(toBool(1)).toBe(true);
    expect(toBool('false')).toBe(false);
    expect(toBool(false)).toBe(false);
    expect(toBool(undefined)).toBe(false);
  });
});

describe('textOf', () => {
  it('reads a bare value or the #text of an attributed node, undefined when absent', () => {
    expect(textOf('hello')).toBe('hello');
    expect(textOf(42)).toBe('42');
    expect(textOf({ '@_BodyType': 'HTML', '#text': '<p>hi</p>' })).toBe('<p>hi</p>');
    expect(textOf(undefined)).toBeUndefined();
    expect(textOf({ '@_BodyType': 'HTML' })).toBeUndefined();
  });
});
