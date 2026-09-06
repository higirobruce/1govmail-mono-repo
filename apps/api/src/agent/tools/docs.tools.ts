import { z } from 'zod';
import { docJsonToText } from '@email-client/shared';
import type { DocsService } from '../../docs/docs.service';
import type { RetrievalService } from '../../chat/retrieval.service';
import type { ToolDef, ToolRef, ToolContext } from '../tool-registry';

function docRef(ctx: ToolContext, d: { id: string; title?: string | null; date?: string; snippet?: string }): ToolRef {
  return {
    alias: ctx.nextAlias(),
    type: 'doc',
    id: String(d.id),
    title: d.title ?? null,
    date: d.date ?? '',
    snippet: (d.snippet ?? '').slice(0, 160),
    injectionSuspected: false,
  };
}

async function readDocText(docs: DocsService, ctx: ToolContext, docId: string) {
  await docs.verifyReadAccess(ctx.userId, docId);
  const doc: any = await docs.findOne(ctx.userId, docId);
  const text = docJsonToText(doc.content ?? '') ?? '';
  return { doc, text };
}

export function buildDocsTools(docs: DocsService, retrieval: RetrievalService): ToolDef[] {
  return [
    {
      name: 'search_documents',
      description:
        'Search the user\'s documents (and docs shared with them) by meaning and by title. Returns doc ids for read_document/compare_documents.',
      mode: 'read',
      resultBudget: 2000,
      schema: z.object({ query: z.string().min(1).max(300) }),
      async execute(args: any, ctx) {
        const [titleHits, semantic] = await Promise.all([
          docs.searchByTitle(ctx.userId, ctx.userEmail, args.query, 8),
          retrieval
            .retrieve(ctx.userId, ctx.userEmail, args.query, { types: ['doc'] })
            .catch(() => ({ sources: [] as any[] })),
        ]);
        const seen = new Set<string>();
        const merged: Array<{ id: string; title: string | null; date: string; snippet: string }> = [];
        for (const d of titleHits) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          merged.push({ id: d.id, title: d.title, date: d.updatedAt?.toISOString?.() ?? '', snippet: '' });
        }
        // RetrievedSource (retrieval.service.ts) carries `context` (not
        // `snippet`) and a native `date: Date` (not an ISO string) — mapped
        // to match that real shape, not the task brief's draft assumption.
        for (const s of (semantic as any).sources ?? []) {
          if (s.type !== 'doc' || seen.has(String(s.id))) continue;
          seen.add(String(s.id));
          const rawDate = s.date;
          const date = rawDate instanceof Date ? rawDate.toISOString() : String(rawDate ?? '');
          merged.push({ id: String(s.id), title: s.title ?? null, date, snippet: s.context ?? '' });
        }
        const refs = merged.slice(0, 8).map((d) => docRef(ctx, d));
        return {
          summary: `${refs.length} document(s) found`,
          content: refs.length
            ? refs.map((r) => `[${r.alias}] "${r.title ?? 'Untitled'}" (id ${r.id})${r.snippet ? ` — ${r.snippet}` : ''}`).join('\n')
            : 'No matching documents.',
          refs,
        };
      },
    },
    {
      name: 'read_document',
      description: 'Read the full text of one document by its id.',
      mode: 'read',
      resultBudget: 4000,
      schema: z.object({ docId: z.string().min(1) }),
      async execute(args: any, ctx) {
        const { doc, text } = await readDocText(docs, ctx, args.docId);
        const ref = docRef(ctx, { id: doc.id, title: doc.title, date: doc.updatedAt?.toISOString?.() ?? '', snippet: text });
        return {
          summary: `Read "${doc.title ?? 'Untitled'}"`,
          content: `[${ref.alias}] DOCUMENT "${doc.title ?? 'Untitled'}"\n\n${text || '(empty document)'}`,
          refs: [ref],
        };
      },
    },
    {
      name: 'compare_documents',
      description: 'Read two documents at once, labeled A and B, so you can compare their contents for the user.',
      mode: 'read',
      resultBudget: 6000,
      schema: z.object({ docIdA: z.string().min(1), docIdB: z.string().min(1) }),
      async execute(args: any, ctx) {
        const [a, b] = await Promise.all([
          readDocText(docs, ctx, args.docIdA),
          readDocText(docs, ctx, args.docIdB),
        ]);
        const refA = docRef(ctx, { id: a.doc.id, title: a.doc.title, snippet: a.text });
        const refB = docRef(ctx, { id: b.doc.id, title: b.doc.title, snippet: b.text });
        return {
          summary: `Compared "${a.doc.title ?? 'A'}" vs "${b.doc.title ?? 'B'}"`,
          content: `DOCUMENT A [${refA.alias}] "${a.doc.title ?? ''}":\n${a.text.slice(0, 2600)}\n\nDOCUMENT B [${refB.alias}] "${b.doc.title ?? ''}":\n${b.text.slice(0, 2600)}`,
          refs: [refA, refB],
        };
      },
    },
  ];
}
