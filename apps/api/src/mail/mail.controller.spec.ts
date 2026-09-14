import { MailController } from './mail.controller';
import { MailService } from './mail.service';

// Focused spec for the attachment download/preview handler — header behavior
// only; the streaming plumbing is Zimbra's and Express's.
describe('MailController.downloadAttachment disposition', () => {
  function makeController() {
    const stream = { pipe: jest.fn() };
    const mailService = {
      downloadAttachment: jest.fn().mockResolvedValue({
        stream,
        contentType: 'application/pdf',
        filename: 'report.pdf',
      }),
    } as unknown as MailService;
    const controller = new MailController(mailService);
    const res = { set: jest.fn(), } as any;
    const req = { user: { sub: 'u1' } } as any;
    return { controller, res, req, stream };
  }

  it('defaults to Content-Disposition: attachment (downloads stay downloads)', async () => {
    const { controller, res, req, stream } = makeController();

    await controller.downloadAttachment(req, res, 'm1', '2', undefined);

    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="report.pdf"',
      }),
    );
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });

  it('returns Content-Disposition: inline plus nosniff when ?disposition=inline', async () => {
    const { controller, res, req } = makeController();

    await controller.downloadAttachment(req, res, 'm1', '2', 'inline');

    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': 'inline; filename="report.pdf"',
        'X-Content-Type-Options': 'nosniff',
      }),
    );
  });

  it('treats any value other than "inline" as a download', async () => {
    const { controller, res, req } = makeController();

    await controller.downloadAttachment(req, res, 'm1', '2', 'evil');

    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="report.pdf"',
      }),
    );
  });
});

describe('MailController.searchAdvanced', () => {
  function makeController() {
    const mailService = {
      searchStructured: jest.fn().mockResolvedValue({ messages: [], total: 0, offset: 0, limit: 50, hasMore: false }),
    } as unknown as MailService;
    const controller = new MailController(mailService);
    const req = { user: { sub: 'u1' } } as any;
    return { controller, req, mailService: mailService as any };
  }

  it('splits limit/offset out of the body and forwards the rest as the filter', async () => {
    const { controller, req, mailService } = makeController();

    await controller.searchAdvanced(req, { subject: 'Budget', limit: 10, offset: 20 });

    expect(mailService.searchStructured).toHaveBeenCalledWith('u1', { subject: 'Budget' }, 10, 20);
  });

  it('defaults limit to 50 and offset to 0 when omitted', async () => {
    const { controller, req, mailService } = makeController();

    await controller.searchAdvanced(req, { unread: true });

    expect(mailService.searchStructured).toHaveBeenCalledWith('u1', { unread: true }, 50, 0);
  });

  it('tolerates a missing body', async () => {
    const { controller, req, mailService } = makeController();

    await controller.searchAdvanced(req, undefined as any);

    expect(mailService.searchStructured).toHaveBeenCalledWith('u1', {}, 50, 0);
  });
});
