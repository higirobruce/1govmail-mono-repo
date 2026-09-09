import { ZimbraService } from './zimbra.service';

// Contract test for the body-fetch SOAP call: fetching a message must be a
// pure read. Background jobs (card worker, embed worker, Ask-inbox hydration)
// all fetch bodies through this method — a `read` flag here silently marks a
// user's unread mail as read in Zimbra before they ever see it. Read-marking
// is exclusively the explicit markRead (MsgActionRequest) path.
describe('ZimbraService.getMessage', () => {
  const session = { host: 'mail.example.com', email: 'u@example.com', authToken: 'tok' };

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

    await service.getMessage(session, 'z1');

    const soapBody = post.mock.calls[0][1];
    const m = soapBody.Body.GetMsgRequest.m;
    expect(m.id).toBe('z1');
    expect(m).not.toHaveProperty('read');
  });

  it('still requests the html body and expanded parts', async () => {
    const { service, post } = makeService();

    await service.getMessage(session, 'z1');

    const m = post.mock.calls[0][1].Body.GetMsgRequest.m;
    expect(m.html).toBe(1);
    expect(m.needExp).toBe(1);
  });
});

// galSelfLookup is a narrow, best-effort GAL search used only to seed the
// AI-profile suggestions endpoint. Unlike searchGal, it must request an
// explicit attrs projection (the default GAL search neither asks for nor
// surfaces title/company/department), and it must never throw — any Zimbra
// trouble degrades to an all-null result.
describe('ZimbraService.galSelfLookup', () => {
  function makeService(post: jest.Mock) {
    const service = new ZimbraService();
    jest.spyOn(service as any, 'buildClient').mockReturnValue({ post });
    return service;
  }

  it('requests an explicit title/ou/company/department attrs projection', async () => {
    const post = jest.fn().mockResolvedValue({
      data: { Body: { SearchGalResponse: { cn: [] } } },
    });
    const service = makeService(post);

    await service.galSelfLookup('mail.example.com', 'tok', 'bruce@risa.gov.rw');

    const req = post.mock.calls[0][1].Body.SearchGalRequest;
    expect(req._jsns).toBe('urn:zimbraAccount');
    expect(req.name).toBe('bruce@risa.gov.rw');
    expect(req.type).toBe('account');
    expect(req.limit).toBe(1);
    expect(req.attrs).toBe('title,ou,company,department');
  });

  it('maps _attrs.title/company and falls back ou → department', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        Body: {
          SearchGalResponse: {
            cn: [{ _attrs: { title: 'Director', company: 'MINALOC', department: 'IT' } }],
          },
        },
      },
    });
    const service = makeService(post);

    const result = await service.galSelfLookup('mail.example.com', 'tok', 'bruce@risa.gov.rw');

    expect(result).toEqual({ title: 'Director', department: 'IT', company: 'MINALOC' });
  });

  it('prefers ou over department when both are present', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        Body: {
          SearchGalResponse: {
            cn: [{ _attrs: { ou: 'Ops', department: 'IT' } }],
          },
        },
      },
    });
    const service = makeService(post);

    const result = await service.galSelfLookup('mail.example.com', 'tok', 'bruce@risa.gov.rw');

    expect(result.department).toBe('Ops');
  });

  it('returns an all-null result when there is no GAL hit', async () => {
    const post = jest.fn().mockResolvedValue({
      data: { Body: { SearchGalResponse: {} } },
    });
    const service = makeService(post);

    const result = await service.galSelfLookup('mail.example.com', 'tok', 'nobody@risa.gov.rw');

    expect(result).toEqual({ title: null, department: null, company: null });
  });

  it('swallows Zimbra errors and returns an all-null result instead of throwing', async () => {
    const post = jest.fn().mockRejectedValue(new Error('zimbra down'));
    const service = makeService(post);

    await expect(
      service.galSelfLookup('mail.example.com', 'tok', 'bruce@risa.gov.rw'),
    ).resolves.toEqual({ title: null, department: null, company: null });
  });
});
