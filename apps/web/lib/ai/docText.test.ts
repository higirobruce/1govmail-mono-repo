import { describe, it, expect } from 'vitest';
import { docJsonToText } from '@email-client/shared';

const doc = (content: unknown[]) => JSON.stringify({ type: 'doc', content });
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('docJsonToText', () => {
  it('joins paragraphs with blank lines', () => {
    expect(docJsonToText(doc([p('one'), p('two')]))).toBe('one\n\ntwo');
  });
  it('renders headings and blockquotes as blocks', () => {
    const out = docJsonToText(doc([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
      { type: 'blockquote', content: [p('quoted')] },
    ]));
    expect(out).toBe('Decisions\n\nquoted');
  });
  it('renders list items line by line', () => {
    const out = docJsonToText(doc([{
      type: 'bulletList', content: [
        { type: 'listItem', content: [p('alpha')] },
        { type: 'listItem', content: [p('beta')] },
      ],
    }]));
    expect(out).toContain('alpha\nbeta');
  });
  it('flattens tables row-wise with cell separators', () => {
    const cell = (t: string) => ({ type: 'tableCell', content: [p(t)] });
    const out = docJsonToText(doc([{
      type: 'table', content: [
        { type: 'tableRow', content: [cell('a'), cell('b')] },
        { type: 'tableRow', content: [cell('c'), cell('d')] },
      ],
    }]));
    expect(out).toContain('a | b');
    expect(out).toContain('c | d');
  });
  it('skips unknown/image nodes without throwing', () => {
    const out = docJsonToText(doc([p('before'), { type: 'image', attrs: { src: 'x' } }, { type: 'weirdWidget' }, p('after')]));
    expect(out).toBe('before\n\nafter');
  });
  it('returns null on invalid JSON and non-object roots', () => {
    expect(docJsonToText('not json')).toBeNull();
    expect(docJsonToText('42')).toBeNull();
  });
  it('returns empty string for an empty doc', () => {
    expect(docJsonToText(doc([]))).toBe('');
  });
  it('joins two paragraphs nested inside a blockquote with a single newline (no fusion)', () => {
    const out = docJsonToText(doc([{ type: 'blockquote', content: [p('foo'), p('bar')] }]));
    expect(out).toBe('foo\nbar');
  });
  it('renders a bulletList nested inside a listItem with each sub-item on its own line', () => {
    const out = docJsonToText(doc([{
      type: 'bulletList', content: [
        {
          type: 'listItem', content: [
            p('parent'),
            { type: 'bulletList', content: [
              { type: 'listItem', content: [p('child1')] },
              { type: 'listItem', content: [p('child2')] },
            ] },
          ],
        },
      ],
    }]));
    expect(out).toBe('parent\nchild1\nchild2');
  });
  it('renders a list nested inside a table cell without fusing its words', () => {
    const listCell = {
      type: 'tableCell', content: [{
        type: 'bulletList', content: [
          { type: 'listItem', content: [p('x')] },
          { type: 'listItem', content: [p('y')] },
        ],
      }],
    };
    const out = docJsonToText(doc([{
      type: 'table', content: [{ type: 'tableRow', content: [listCell] }],
    }]));
    expect(out).toContain('x\ny');
    expect(out).not.toContain('xy');
  });
  it('never throws on a pathologically deep nested structure', () => {
    // Built as raw JSON text, not via JSON.stringify(nestedObject) — stringify
    // itself is recursive and overflows the stack well before 10,000 levels,
    // which would fail in the test's input construction rather than exercise
    // docJsonToText's own depth guard. JSON.parse (used inside docJsonToText)
    // handles this depth fine; it's the walker's own recursion we're guarding.
    const depth = 10000;
    const json =
      '{"type":"doc","content":[' +
      '{"type":"paragraph","content":['.repeat(depth) +
      '{"type":"text","text":"leaf"}' +
      ']}'.repeat(depth) +
      ']}';
    expect(() => docJsonToText(json)).not.toThrow();
  });
});
