import { CardExtractorService } from './card-extractor.service';

const MSG = {
  id: 'm1', conversationId: null, direction: 'received' as const,
  fromEmail: 'a@risa.gov.rw', fromName: 'A', subject: 'Budget',
  receivedAt: '2026-09-03T08:00:00Z', attachments: [],
};
const CARD_JSON = JSON.stringify({ choices: [{ message: { content: '{"gist":"g","asksOfMe":["approve"],"importance":"high"}' } }] });

describe('CardExtractorService', () => {
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as unknown as typeof fetch; });
  afterAll(() => { global.fetch = realFetch; });

  it('sends reasoning_effort none, json mode, temperature 0, max_tokens 300, CARD_MODEL', async () => {
    fetchMock.mockResolvedValue(new Response(CARD_JSON, { status: 200 }));
    const svc = new CardExtractorService();
    const card = await svc.extract(MSG, 'Please approve the budget by Friday.', null);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: svc.model, temperature: 0, max_tokens: 300,
      reasoning_effort: 'none', response_format: { type: 'json_object' },
    });
    expect(card?.asksOfMe).toEqual(['approve']);
  });

  it('retries without response_format on 400, then without json instructions parses fallback output', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('bad param', { status: 400 }))
      .mockResolvedValueOnce(new Response(CARD_JSON, { status: 200 }));
    const card = await new CardExtractorService().extract(MSG, 'body text here', null);
    expect(card).not.toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format).toBeUndefined();
  });

  it('returns null when both attempts yield garbage', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }));
    expect(await new CardExtractorService().extract(MSG, 'body text here', null)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for an empty body without calling the model', async () => {
    expect(await new CardExtractorService().extract(MSG, null, null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
