import { readFileSync } from 'fs';
import { join } from 'path';
import { BadGatewayException } from '@nestjs/common';
import { EwsService } from './ews.service';
import { MailSession } from '../provider/mail-session';

/**
 * Task 5 — EWS message mutations, send, drafts, attachments. Each op runs
 * through a fake transport that replays recorded response fixtures in order,
 * recording every outbound envelope so both the request construction and the
 * neutral return value can be asserted.
 */

const KEY = 'test-mail-cred-key-0123456789abcdef';
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const CREATE_DRAFT = fixture('createitem-draft.success.xml');
const CREATE_ATTACH = fixture('createattachment.success.xml');
const SEND_ITEM = fixture('senditem.success.xml');
const GET_CK = fixture('getitem-changekey.success.xml');
const UPDATE_MARKREAD = fixture('updateitem-markread.success.xml');
const UPDATE_DRAFT = fixture('updateitem-draft.success.xml');
const MOVE_ITEM = fixture('moveitem.success.xml');
const GET_ATTACHMENT = fixture('getattachment.success.xml');
const CHANGEKEY_REQUIRED = fixture('error-changekeyrequired.xml');

/** Replays `script` entries in order (last one repeats), recording every
 *  outbound body so envelope construction + call order can be asserted. */
class FakeTransport {
  public calls: Array<{ session: MailSession; body: string }> = [];
  constructor(private script: string[]) {}
  async call(session: MailSession, body: string): Promise<string> {
    this.calls.push({ session, body });
    const idx = Math.min(this.calls.length - 1, this.script.length - 1);
    return this.script[idx];
  }
}

const SESSION: MailSession = {
  host: 'webmail.minaffet.gov.rw',
  email: 'test-risa1@minaffet.gov.rw',
  credentials: { username: 'MINAFFET\\test-risa1', password: 'fake-pw' },
};

const svcWith = (...script: string[]) => {
  const t = new FakeTransport(script);
  const svc = new EwsService(t as any);
  return { t, svc };
};

describe('EwsService mutations, send, drafts, attachments (Task 5)', () => {
  const ORIGINAL = process.env.MAIL_CRED_KEY;
  beforeEach(() => { process.env.MAIL_CRED_KEY = KEY; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL;
  });

  describe('markRead', () => {
    it('fetches a fresh ChangeKey with GetItem BEFORE the UpdateItem write', async () => {
      const { t, svc } = svcWith(GET_CK, UPDATE_MARKREAD);
      await svc.markRead(SESSION, 'ITEM-1==', true);

      expect(t.calls).toHaveLength(2);
      // call order: GetItem (fresh change key) then UpdateItem
      expect(t.calls[0].body).toContain('<m:GetItem>');
      expect(t.calls[0].body).toContain('<t:BaseShape>IdOnly</t:BaseShape>');
      expect(t.calls[0].body).not.toContain('UpdateItem');
      expect(t.calls[1].body).toContain('<m:UpdateItem');
      // the UpdateItem carries the change key just read, never a cached one
      expect(t.calls[1].body).toContain('ChangeKey="FRESH-CK-9"');
    });

    it('sets message:IsRead with SuppressReadReceipts', async () => {
      const { t, svc } = svcWith(GET_CK, UPDATE_MARKREAD);
      await svc.markRead(SESSION, 'ITEM-1==', true);
      const update = t.calls[1].body;
      expect(update).toContain('SuppressReadReceipts="true"');
      expect(update).toContain('<t:FieldURI FieldURI="message:IsRead"/>');
      expect(update).toContain('<t:IsRead>true</t:IsRead>');
    });

    it('writes IsRead false when marking unread', async () => {
      const { t, svc } = svcWith(GET_CK, UPDATE_MARKREAD);
      await svc.markRead(SESSION, 'ITEM-1==', false);
      expect(t.calls[1].body).toContain('<t:IsRead>false</t:IsRead>');
    });
  });

  describe('moveMessage', () => {
    it('issues a MoveItem to the target FolderId', async () => {
      const { t, svc } = svcWith(MOVE_ITEM);
      await expect(svc.moveMessage(SESSION, 'ITEM-1==', 'AAA-Archive=')).resolves.toBeUndefined();
      expect(t.calls[0].body).toContain('<m:MoveItem>');
      expect(t.calls[0].body).toContain('<t:FolderId Id="AAA-Archive="/>');
      expect(t.calls[0].body).toContain('<t:ItemId Id="ITEM-1=="/>');
    });
  });

  describe('deleteMessage', () => {
    it('soft-deletes via MoveItem to deleteditems', async () => {
      const { t, svc } = svcWith(MOVE_ITEM);
      await expect(svc.deleteMessage(SESSION, 'ITEM-1==')).resolves.toBeUndefined();
      expect(t.calls[0].body).toContain('<m:MoveItem>');
      expect(t.calls[0].body).toContain('<t:DistinguishedFolderId Id="deleteditems"/>');
    });
  });

  describe('sendMessage', () => {
    it('runs CreateItem SaveOnly → CreateAttachment → SendItem and returns the id', async () => {
      const { t, svc } = svcWith(CREATE_DRAFT, CREATE_ATTACH, SEND_ITEM);
      const aid = await svc.uploadAttachment(
        SESSION, 'report.pdf', 'application/pdf', Buffer.from('PDFDATA'),
      );
      const result = await svc.sendMessage(
        SESSION,
        { to: ['bob@minaffet.gov.rw'], subject: 'Hi', body: '<p>Body</p>' },
        [aid],
      );

      // three legs: create draft, attach the file, send
      expect(t.calls).toHaveLength(3);
      expect(t.calls[0].body).toContain('<m:CreateItem MessageDisposition="SaveOnly">');
      expect(t.calls[0].body).toContain('<t:DistinguishedFolderId Id="drafts"/>');
      expect(t.calls[0].body).toContain('<t:EmailAddress>bob@minaffet.gov.rw</t:EmailAddress>');

      // the CreateAttachment envelope carries the base64 of the uploaded bytes
      expect(t.calls[1].body).toContain('<m:CreateAttachment>');
      expect(t.calls[1].body).toContain('<t:Name>report.pdf</t:Name>');
      expect(t.calls[1].body).toContain(`<t:Content>${Buffer.from('PDFDATA').toString('base64')}</t:Content>`);
      // it targets the draft with the change key from CreateItem
      expect(t.calls[1].body).toContain('<m:ParentItemId Id="DRAFT-1==" ChangeKey="DCK-0"/>');

      // SendItem uses the refreshed RootItemChangeKey from CreateAttachment
      expect(t.calls[2].body).toContain('<m:SendItem SaveItemToFolder="true">');
      expect(t.calls[2].body).toContain('<t:ItemId Id="DRAFT-1==" ChangeKey="DCK-1"/>');
      expect(t.calls[2].body).toContain('<t:DistinguishedFolderId Id="sentitems"/>');

      expect(result.id).toBe('DRAFT-1==');
      expect(result.conversationId).toBeNull();
    });

    it('inlines images with IsInline + ContentId', async () => {
      const { t, svc } = svcWith(CREATE_DRAFT, CREATE_ATTACH, SEND_ITEM);
      const aid = await svc.uploadAttachment(SESSION, 'inline.png', 'image/png', Buffer.from('IMG'));
      await svc.sendMessage(
        SESSION,
        { to: ['bob@minaffet.gov.rw'], subject: 'Hi', body: '<img src="cid:logo@x">' },
        [],
        [{ aid, cid: 'logo@x', ct: 'image/png' }],
      );
      const attach = t.calls[1].body;
      expect(attach).toContain('<t:ContentId>logo@x</t:ContentId>');
      expect(attach).toContain('<t:IsInline>true</t:IsInline>');
      expect(attach).toContain(`<t:Content>${Buffer.from('IMG').toString('base64')}</t:Content>`);
    });

    it('skips CreateAttachment entirely when there are no attachments', async () => {
      const { t, svc } = svcWith(CREATE_DRAFT, SEND_ITEM);
      await svc.sendMessage(SESSION, { to: ['bob@minaffet.gov.rw'], subject: 'Hi', body: '<p>x</p>' });
      expect(t.calls).toHaveLength(2);
      expect(t.calls[0].body).toContain('<m:CreateItem');
      expect(t.calls[1].body).toContain('<m:SendItem');
      // SendItem uses the CreateItem change key directly (no attachment refresh)
      expect(t.calls[1].body).toContain('ChangeKey="DCK-0"');
    });

    it('builds a ReplyToItem when replyToId is set with replyType r', async () => {
      const { t, svc } = svcWith(CREATE_DRAFT, SEND_ITEM);
      await svc.sendMessage(
        SESSION,
        { to: ['bob@minaffet.gov.rw'], subject: 'Re: Hi', body: '<p>reply</p>', replyToId: 'ORIG==', replyType: 'r' },
      );
      const create = t.calls[0].body;
      expect(create).toContain('<t:ReplyToItem>');
      expect(create).toContain('<t:ReferenceItemId Id="ORIG=="/>');
      expect(create).toContain('<t:NewBodyContent BodyType="HTML">');
    });

    it('builds a ForwardItem when replyType is w', async () => {
      const { t, svc } = svcWith(CREATE_DRAFT, SEND_ITEM);
      await svc.sendMessage(
        SESSION,
        { to: ['bob@minaffet.gov.rw'], subject: 'Fwd: Hi', body: '<p>fwd</p>', replyToId: 'ORIG==', replyType: 'w' },
      );
      expect(t.calls[0].body).toContain('<t:ForwardItem>');
      expect(t.calls[0].body).toContain('<t:ReferenceItemId Id="ORIG=="/>');
    });
  });

  describe('saveDraft', () => {
    it('creates a new draft with CreateItem SaveOnly and returns its id', async () => {
      const { t, svc } = svcWith(CREATE_DRAFT);
      const id = await svc.saveDraft(SESSION, { to: ['bob@minaffet.gov.rw'], subject: 'D', body: '<p>d</p>' });
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0].body).toContain('<m:CreateItem MessageDisposition="SaveOnly">');
      expect(t.calls[0].body).toContain('<t:DistinguishedFolderId Id="drafts"/>');
      expect(id).toBe('DRAFT-1==');
    });

    it('updates an existing draft after a fresh GetItem and returns the FRESH id', async () => {
      const { t, svc } = svcWith(GET_CK, UPDATE_DRAFT);
      const id = await svc.saveDraft(SESSION, { id: 'DRAFT-1==', subject: 'Updated', body: '<p>u</p>' });

      // GetItem (fresh change key) precedes the UpdateItem
      expect(t.calls).toHaveLength(2);
      expect(t.calls[0].body).toContain('<m:GetItem>');
      expect(t.calls[0].body).not.toContain('UpdateItem');
      expect(t.calls[1].body).toContain('<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">');
      expect(t.calls[1].body).toContain('ChangeKey="FRESH-CK-9"');
      expect(t.calls[1].body).toContain('<t:Subject>Updated</t:Subject>');

      // UpdateItem returns a brand-new ItemId — that is what we return
      expect(id).toBe('DRAFT-2-FRESH==');
    });

    it('surfaces ErrorChangeKeyRequiredForWriteOperations as a BadGateway', async () => {
      const { svc } = svcWith(GET_CK, CHANGEKEY_REQUIRED);
      await expect(
        svc.saveDraft(SESSION, { id: 'DRAFT-1==', subject: 'x' }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('attachments', () => {
    it('uploadAttachment buffers the bytes and returns an opaque handle', async () => {
      const { t, svc } = svcWith();
      const handle = await svc.uploadAttachment(SESSION, 'a.txt', 'text/plain', Buffer.from('hi'));
      expect(typeof handle).toBe('string');
      expect(handle.length).toBeGreaterThan(0);
      // buffering is purely local — no transport traffic
      expect(t.calls).toHaveLength(0);
    });

    it('downloadAttachmentBuffer decodes GetAttachment base64 to the right bytes + type', async () => {
      const { t, svc } = svcWith(GET_ATTACHMENT);
      const { data, contentType } = await svc.downloadAttachmentBuffer(SESSION, 'ITEM-1==', 'ATT-1==');
      expect(t.calls[0].body).toContain('<m:GetAttachment>');
      expect(t.calls[0].body).toContain('<t:AttachmentId Id="ATT-1=="/>');
      expect(data.toString('utf8')).toBe('Hello, EWS!\n');
      expect(contentType).toBe('text/plain');
    });

    it('downloadAttachment returns a stream, content type and filename', async () => {
      const { svc } = svcWith(GET_ATTACHMENT);
      const { stream, contentType, filename } = await svc.downloadAttachment(SESSION, 'ITEM-1==', 'ATT-1==');
      expect(contentType).toBe('text/plain');
      expect(filename).toBe('notes.txt');
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      expect(Buffer.concat(chunks).toString('utf8')).toBe('Hello, EWS!\n');
    });
  });
});
