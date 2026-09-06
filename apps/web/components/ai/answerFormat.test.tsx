import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderInline, splitBlocks } from './answerFormat';

describe('splitBlocks', () => {
  it('separates paragraphs and bullets, collapsing extra blank lines', () => {
    const blocks = splitBlocks('Intro line\n\n\n\n- **TODO**: 1 task\n- DONE: 0 tasks\n\nOutro');
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'li', 'li', 'p']);
    expect(blocks[1].text).toBe('**TODO**: 1 task');
    expect(blocks[0].gapBefore).toBe(false);
    expect(blocks[1].gapBefore).toBe(true); // paragraph gap survives, once
    expect(blocks[2].gapBefore).toBe(false); // consecutive bullets stay tight
    expect(blocks[3].gapBefore).toBe(true);
  });

  it('never emits blocks for pure whitespace', () => {
    expect(splitBlocks('\n\n  \n')).toEqual([]);
  });
});

describe('renderInline', () => {
  const html = (text: string) => renderToStaticMarkup(<>{renderInline(text, 'k')}</>);

  it('renders **bold**, *italic* and `code`', () => {
    expect(html('a **b** c')).toContain('<strong');
    expect(html('a **b** c')).toContain('>b</strong>');
    expect(html('x *y* z')).toContain('<em>y</em>');
    expect(html('run `ls` now')).toContain('>ls</code>');
  });

  it('leaves plain text and unmatched asterisks alone', () => {
    expect(html('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(html('plain')).toBe('plain');
  });
});
