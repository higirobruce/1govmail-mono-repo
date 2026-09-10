import { soapEnvelope, xmlEscape, getFolderEnvelope } from './ews-envelopes';

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
