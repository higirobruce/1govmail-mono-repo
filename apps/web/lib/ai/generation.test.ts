import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedDossier, streamDossier, streamMeetingPrep } from './generation';
import { authedFetch } from '../authed-fetch';

vi.mock('../authed-fetch', () => ({ authedFetch: vi.fn() }));
const mockFetch = vi.mocked(authedFetch);

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream({
    start(c) { frames.forEach((f) => c.enqueue(new TextEncoder().encode(f))); c.close(); },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => mockFetch.mockReset());

describe('streamDossier', () => {
  it('POSTs the email and surfaces sources + chunks', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      'event: sources\ndata: {"sources":[{"alias":"s1"}],"degraded":{"mail":false}}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',
    ]));
    const onSources = vi.fn(); const onChunk = vi.fn();
    const full = await streamDossier('JD@gov.rw', { onSources, onChunk });
    expect(mockFetch).toHaveBeenCalledWith('/ai/dossier', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'jd@gov.rw' }),
    }));
    expect(onSources).toHaveBeenCalledWith([{ alias: 's1' }], { mail: false });
    expect(full).toBe('Hi');
  });

  it('throws AIHttpError with the server message on 4xx', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'cannot open a dossier on yourself' }), { status: 400 }));
    await expect(streamDossier('me@x.rw', { onSources: vi.fn(), onChunk: vi.fn() }))
      .rejects.toThrow(/yourself/);
  });
});

describe('streamMeetingPrep', () => {
  it('POSTs the eventId', async () => {
    mockFetch.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    await streamMeetingPrep('e1', { onSources: vi.fn(), onChunk: vi.fn() });
    expect(mockFetch).toHaveBeenCalledWith('/ai/meeting-prep', expect.objectContaining({
      body: JSON.stringify({ eventId: 'e1' }),
    }));
  });
});

describe('getCachedDossier', () => {
  it('GETs with the encoded lowercased email and unwraps { cached }', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ cached: { content: 'x', sources: [], generatedAt: 'g', stale: true } }), { status: 200 }));
    const got = await getCachedDossier('JD+x@gov.rw');
    expect(mockFetch).toHaveBeenCalledWith('/ai/dossier?email=jd%2Bx%40gov.rw');
    expect(got?.stale).toBe(true);
  });
});
