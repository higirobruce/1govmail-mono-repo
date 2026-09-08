import { ZimbraService } from './zimbra.service';

// Contract test for the body-fetch SOAP call: fetching a message must be a
// pure read. Background jobs (card worker, embed worker, Ask-inbox hydration)
// all fetch bodies through this method — a `read` flag here silently marks a
// user's unread mail as read in Zimbra before they ever see it. Read-marking
// is exclusively the explicit markRead (MsgActionRequest) path.
describe('ZimbraService.getMessage', () => {
  function makeService() {
    const service = new ZimbraService();
    const post = jest.fn().mockResolvedValue({
      data: { Body: { GetMsgResponse: { m: [{ id: 'z1' }] } } },
    });
    jest.spyOn(service as any, 'buildClient').mockReturnValue({ post });
    return { service, post };
  }

  it('does not mark the message as read (no read flag in GetMsgRequest)', async () => {
    const { service, post } = makeService();

    await service.getMessage('mail.example.com', 'tok', 'z1');

    const soapBody = post.mock.calls[0][1];
    const m = soapBody.Body.GetMsgRequest.m;
    expect(m.id).toBe('z1');
    expect(m).not.toHaveProperty('read');
  });

  it('still requests the html body and expanded parts', async () => {
    const { service, post } = makeService();

    await service.getMessage('mail.example.com', 'tok', 'z1');

    const m = post.mock.calls[0][1].Body.GetMsgRequest.m;
    expect(m.html).toBe(1);
    expect(m.needExp).toBe(1);
  });
});
