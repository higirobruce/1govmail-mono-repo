import { BadGatewayException } from '@nestjs/common';
import { AiService } from './ai.service';
import { ChatRequestDto } from './dto/chat.dto';

describe('AiService.upstream', () => {
  const service = new AiService();
  const body: ChatRequestDto = {
    model: 'qwen3.5:0.8b',
    messages: [{ role: 'user', content: 'hi' }],
  };

  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  function sentBody(call = 0): Record<string, unknown> {
    return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
  }

  it('disables model thinking by default', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await service.upstream(body, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody()).toMatchObject({ model: 'qwen3.5:0.8b', reasoning_effort: 'none' });
  });

  it('retries without reasoning_effort when the backend rejects it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('{"error":"unknown parameter reasoning_effort"}', { status: 400 }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const res = await service.upstream(body, new AbortController().signal);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0)).toHaveProperty('reasoning_effort', 'none');
    expect(sentBody(1)).not.toHaveProperty('reasoning_effort');
  });

  it('still reports a backend failure when the retry also fails', async () => {
    fetchMock.mockResolvedValue(new Response('bad request', { status: 400 }));

    await expect(service.upstream(body, new AbortController().signal)).rejects.toThrow(
      BadGatewayException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
