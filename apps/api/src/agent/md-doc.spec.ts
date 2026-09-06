import { mdToDocJson } from '@email-client/shared';

describe('mdToDocJson', () => {
  it('converts headings, paragraphs and lists', () => {
    const doc = JSON.parse(mdToDocJson('# Title\n\nHello **world**\n\n- a\n- b\n\n1. one'));
    expect(doc.type).toBe('doc');
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(doc.content[0].content[0].text).toBe('Title');
    expect(doc.content[1].type).toBe('paragraph');
    expect(doc.content[1].content[1]).toMatchObject({ text: 'world', marks: [{ type: 'bold' }] });
    expect(doc.content[2]).toMatchObject({ type: 'bulletList' });
    expect(doc.content[2].content).toHaveLength(2);
    expect(doc.content[3].type).toBe('orderedList');
  });

  it('handles italic and inline code', () => {
    const doc = JSON.parse(mdToDocJson('*it* and `code`'));
    const nodes = doc.content[0].content;
    expect(nodes[0]).toMatchObject({ text: 'it', marks: [{ type: 'italic' }] });
    expect(nodes[2]).toMatchObject({ text: 'code', marks: [{ type: 'code' }] });
  });

  it('empty input yields one empty paragraph', () => {
    const doc = JSON.parse(mdToDocJson(''));
    expect(doc.content).toEqual([{ type: 'paragraph' }]);
  });
});
