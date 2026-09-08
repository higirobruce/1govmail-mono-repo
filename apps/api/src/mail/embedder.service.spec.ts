import { EmbedderService } from './embedder.service';

describe('EmbedderService', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  function mockFetch(status: number, body: unknown) {
    const fn = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300, status,
      json: async () => body, text: async () => JSON.stringify(body),
    });
    global.fetch = fn as any;
    return fn;
  }

  it('POSTs the native /api/embed endpoint with the /v1 suffix stripped from OLLAMA_BASE_URL', async () => {
    const vec = Array.from({ length: 1024 }, () => 0.1);
    const fn = mockFetch(200, { embeddings: [vec, vec] });
    const svc = new EmbedderService();
    const out = await svc.embed(['a', 'b']);
    expect(fn).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/embed$/),
      expect.objectContaining({ method: 'POST' }),
    );
    const url: string = fn.mock.calls[0][0];
    expect(url).not.toContain('/v1/');             // native API lives at the server root
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body).toEqual({ model: svc.model, input: ['a', 'b'] });
    expect(out).toHaveLength(2);
  });

  it('returns [] without calling fetch for empty input', async () => {
    const fn = mockFetch(200, {});
    const out = await new EmbedderService().embed([]);
    expect(out).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws on a non-OK response', async () => {
    mockFetch(500, {});
    await expect(new EmbedderService().embed(['a'])).rejects.toThrow('Ollama embed 500');
  });

  it('throws when the payload shape or dimension count is wrong', async () => {
    mockFetch(200, { embeddings: [[0.1, 0.2]] }); // wrong dims
    await expect(new EmbedderService().embed(['a'])).rejects.toThrow('unexpected');
    mockFetch(200, { embeddings: [Array(1024).fill(0)] }); // 1 vector for 2 inputs
    await expect(new EmbedderService().embed(['a', 'b'])).rejects.toThrow('unexpected');
  });
});
