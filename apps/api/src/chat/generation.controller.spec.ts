import { BadRequestException, NotFoundException } from '@nestjs/common';
import { extractSseText } from '@email-client/shared';
import { GenerationController } from './generation.controller';

function fakeRes() {
  const writes: string[] = [];
  const res: any = {
    writableEnded: false,
    headers: {} as Record<string, string>,
    on: jest.fn(),
    setHeader: jest.fn((k: string, v: string) => { res.headers[k] = v; }),
    flushHeaders: jest.fn(),
    status: jest.fn().mockReturnThis(),
    write: jest.fn((chunk: any) => { writes.push(String(chunk)); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
    once: jest.fn(),
  };
  return { res, writes };
}

const req: any = { user: { sub: 'u1' } };

function sseUpstream(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
      }),
    },
  };
}

function makeController(overrides: {
  dossier?: any; meetingPrep?: any; cache?: any; aiService?: any;
} = {}) {
  const dossier = overrides.dossier ?? { prepare: jest.fn(), chatModel: 'x' };
  const meetingPrep = overrides.meetingPrep ?? { prepare: jest.fn(), chatModel: 'x' };
  const cache = overrides.cache ?? { get: jest.fn(), upsert: jest.fn() };
  const aiService = overrides.aiService ?? { upstream: jest.fn() };
  const controller = new GenerationController(dossier as any, meetingPrep as any, cache as any, aiService as any);
  return { controller, dossier, meetingPrep, cache, aiService };
}

describe('GenerationController', () => {
  describe('POST /ai/dossier', () => {
    it('propagates a BadRequestException from prepare() (own email) BEFORE any SSE headers are set', async () => {
      const dossier = { prepare: jest.fn().mockRejectedValue(new BadRequestException('cannot open a dossier on yourself')), chatModel: 'x' };
      const { controller, cache, aiService } = makeController({ dossier });
      const { res } = fakeRes();

      await expect(
        controller.streamDossier(req, res, { email: 'me@gov.rw' } as any),
      ).rejects.toThrow(BadRequestException);

      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(aiService.upstream).not.toHaveBeenCalled();
      expect(cache.upsert).not.toHaveBeenCalled();
    });

    it('writes the sources event first, pipes upstream bytes, and caches the finished transcript', async () => {
      const prepared = {
        kind: 'dossier', targetKey: 'jd@gov.rw',
        sources: [{ alias: 's1', type: 'mail', id: 'm1' }],
        degraded: { mail: false, commitments: false, events: false },
        upstreamBody: { model: 'x', messages: [], stream: true },
        fallbackReply: null,
        sourceAnchor: new Date('2026-09-01T00:00:00Z'),
      };
      const dossier = { prepare: jest.fn().mockResolvedValue(prepared), chatModel: 'x' };
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const aiService = { upstream: jest.fn().mockResolvedValue(sseUpstream(chunks)) };
      const { controller, cache } = makeController({ dossier, aiService });
      const { res, writes } = fakeRes();

      await controller.streamDossier(req, res, { email: 'jd@gov.rw' } as any);

      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(writes[0]).toContain('event: sources');
      expect(writes[0]).toContain('"alias":"s1"');
      expect(writes.join('')).toContain('[DONE]');
      expect(res.end).toHaveBeenCalled();

      const expectedContent = extractSseText(chunks.join(''));
      expect(cache.upsert).toHaveBeenCalledWith('u1', 'dossier', 'jd@gov.rw', {
        content: expectedContent,
        sources: prepared.sources,
        model: 'x',
        sourceAnchor: prepared.sourceAnchor,
      });
    });

    it('fallback path (upstreamBody null): writes fallbackReply + [DONE], does not call upstream or cache.upsert', async () => {
      const prepared = {
        kind: 'dossier', targetKey: 'jd@gov.rw',
        sources: [], degraded: { mail: false, commitments: false, events: false },
        upstreamBody: null, fallbackReply: 'There is nothing on file with this person yet.',
        sourceAnchor: new Date(),
      };
      const dossier = { prepare: jest.fn().mockResolvedValue(prepared), chatModel: 'x' };
      const { controller, cache, aiService } = makeController({ dossier });
      const { res, writes } = fakeRes();

      await controller.streamDossier(req, res, { email: 'jd@gov.rw' } as any);

      expect(aiService.upstream).not.toHaveBeenCalled();
      const all = writes.join('');
      expect(all).toContain('There is nothing on file with this person yet.');
      expect(all).toContain('[DONE]');
      expect(cache.upsert).not.toHaveBeenCalled();
    });

    it('client abort before upstream ends: no cache.upsert', async () => {
      const prepared = {
        kind: 'dossier', targetKey: 'jd@gov.rw',
        sources: [{ alias: 's1', type: 'mail', id: 'm1' }],
        degraded: { mail: false, commitments: false, events: false },
        upstreamBody: { model: 'x', messages: [], stream: true },
        fallbackReply: null,
        sourceAnchor: new Date(),
      };
      const dossier = { prepare: jest.fn().mockResolvedValue(prepared), chatModel: 'x' };
      let closeCb: (() => void) | undefined;
      const aiService = {
        upstream: jest.fn(async () => {
          closeCb?.(); // simulate client disconnect, which aborts the controller's signal
          throw new Error('The operation was aborted');
        }),
      };
      const { controller, cache } = makeController({ dossier, aiService });
      const { res } = fakeRes();
      res.on = jest.fn((event: string, cb: () => void) => { if (event === 'close') closeCb = cb; });

      await controller.streamDossier(req, res, { email: 'jd@gov.rw' } as any);

      expect(cache.upsert).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('GET /ai/dossier', () => {
    it('returns { cached } straight from cache.get', async () => {
      const cached = { content: 'x', sources: [], generatedAt: new Date().toISOString(), stale: false };
      const cache = { get: jest.fn().mockResolvedValue(cached), upsert: jest.fn() };
      const { controller } = makeController({ cache });

      const result = await controller.cachedDossier(req, { email: 'JD@Gov.rw' } as any);

      expect(cache.get).toHaveBeenCalledWith('u1', 'dossier', 'jd@gov.rw');
      expect(result).toEqual({ cached });
    });
  });

  describe('POST /ai/meeting-prep', () => {
    it('propagates a NotFoundException from prepare() BEFORE any SSE headers are set', async () => {
      const meetingPrep = { prepare: jest.fn().mockRejectedValue(new NotFoundException('event not found')), chatModel: 'x' };
      const { controller, aiService, cache } = makeController({ meetingPrep });
      const { res } = fakeRes();

      await expect(
        controller.streamMeetingPrep(req, res, { eventId: 'e1' } as any),
      ).rejects.toThrow(NotFoundException);

      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(aiService.upstream).not.toHaveBeenCalled();
      expect(cache.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /ai/meeting-prep', () => {
    it('returns { cached: null } when cache.get resolves null', async () => {
      const cache = { get: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
      const { controller } = makeController({ cache });

      const result = await controller.cachedMeetingPrep(req, { eventId: 'e1' } as any);

      expect(cache.get).toHaveBeenCalledWith('u1', 'meeting_prep', 'e1');
      expect(result).toEqual({ cached: null });
    });
  });
});
