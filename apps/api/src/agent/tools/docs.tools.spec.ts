import { buildDocsTools } from './docs.tools';
import type { ToolContext } from '../tool-registry';

function makeCtx(): ToolContext {
  let n = 0;
  return { userId: 'u1', userEmail: 'u1@x.rw', nextAlias: () => `s${++n}`, emitChart: jest.fn() };
}

const tiptap = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Policy body' }] }] });

const docs = {
  searchByTitle: jest.fn().mockResolvedValue([{ id: 'd1', title: 'Policy', emoji: null, updatedAt: new Date('2026-09-01') }]),
  verifyReadAccess: jest.fn().mockResolvedValue({ id: 'd1' }),
  findOne: jest.fn().mockResolvedValue({ id: 'd1', title: 'Policy', content: tiptap, updatedAt: new Date('2026-09-01') }),
} as any;

// RetrievedSource (apps/api/src/chat/retrieval.service.ts ~19-30) carries
// `context` (not `snippet`) and a native `date: Date` (not an ISO string) —
// matched here to the real shape rather than the task brief's draft mock.
const retrieval = {
  retrieve: jest.fn().mockResolvedValue({
    sources: [{ type: 'doc', id: 'd2', title: 'Budget doc', context: 'money', date: new Date('2026-08-01T00:00:00Z') }],
    degraded: { vector: false, keyword: false, docs: false, calendar: false },
  }),
} as any;

const tools = buildDocsTools(docs, retrieval);
const byName = (n: string) => tools.find((t) => t.name === n)!;

describe('docs tools', () => {
  it('search_documents merges title and vector hits, deduped by id', async () => {
    retrieval.retrieve.mockResolvedValueOnce({
      sources: [
        { type: 'doc', id: 'd1', title: 'Policy', context: 'dup', date: new Date('2026-09-01T00:00:00Z') },
        { type: 'doc', id: 'd2', title: 'Budget doc', context: 'money', date: new Date('2026-08-01T00:00:00Z') },
      ],
      degraded: { vector: false, keyword: false, docs: false, calendar: false },
    });
    const res = await byName('search_documents').execute({ query: 'policy' }, makeCtx());
    expect(docs.searchByTitle).toHaveBeenCalledWith('u1', 'u1@x.rw', 'policy', 8);
    const ids = res.refs!.map((r) => r.id);
    expect(ids).toEqual(['d1', 'd2']); // d1 not duplicated
  });

  it('read_document verifies access then extracts text', async () => {
    const res = await byName('read_document').execute({ docId: 'd1' }, makeCtx());
    expect(docs.verifyReadAccess).toHaveBeenCalledWith('u1', 'd1');
    expect(res.content).toContain('Policy body');
  });

  it('compare_documents reads both and labels A/B', async () => {
    const res = await byName('compare_documents').execute({ docIdA: 'd1', docIdB: 'd1' }, makeCtx());
    expect(res.content).toContain('DOCUMENT A');
    expect(res.content).toContain('DOCUMENT B');
    expect(res.refs).toHaveLength(2);
  });
});
