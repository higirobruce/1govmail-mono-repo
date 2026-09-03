import { BadRequestException } from '@nestjs/common';
import { SemanticSearchController } from './semantic-search.controller';

const req: any = { user: { sub: 'u1' } };

describe('SemanticSearchController', () => {
  it('rejects a missing or too-short query', async () => {
    const controller = new SemanticSearchController({ semantic: jest.fn() } as any);
    await expect(controller.semantic(req, undefined as any, undefined)).rejects.toThrow(BadRequestException);
    await expect(controller.semantic(req, 'a', undefined)).rejects.toThrow(BadRequestException);
  });

  it('returns search-shaped results from the vector leg, clamping limit to 1..20', async () => {
    const rows = [{ id: 'm1', subject: 's' }];
    const retrieval = { semantic: jest.fn().mockResolvedValue(rows) };
    const controller = new SemanticSearchController(retrieval as any);

    const out = await controller.semantic(req, 'budget report', '50');

    expect(retrieval.semantic).toHaveBeenCalledWith('u1', 'budget report', 20);
    expect(out).toEqual({ messages: rows, total: 1, offset: 0, limit: 20, hasMore: false });
  });
});
