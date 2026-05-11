'use client';

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { cn } from '@/lib/utils';

interface HeadingItem {
  level: number;
  text: string;
  pos: number;
}

interface TableOfContentsProps {
  editor: Editor | null;
}

export function TableOfContents({ editor }: TableOfContentsProps) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);

  useEffect(() => {
    if (!editor) return;

    const extract = () => {
      const items: HeadingItem[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          items.push({
            level: node.attrs.level as number,
            text: node.textContent,
            pos,
          });
        }
      });
      setHeadings(items);
    };

    extract();
    editor.on('update', extract);
    return () => { editor.off('update', extract); };
  }, [editor]);

  const scrollToHeading = (text: string) => {
    const editorDom = document.querySelector('.tiptap');
    if (!editorDom) return;
    const all = editorDom.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const h of all) {
      if (h.textContent?.trim() === text.trim()) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
    }
  };

  if (headings.length === 0) {
    return (
      <div className="p-4">
        <p className="text-xs text-muted-foreground">No headings in this document. Add headings to generate a table of contents.</p>
      </div>
    );
  }

  return (
    <div className="py-2 px-1">
      {headings.map((h, i) => (
        <button
          key={i}
          type="button"
          className={cn(
            'block w-full text-left text-xs py-1 px-2 hover:bg-muted rounded text-muted-foreground hover:text-foreground truncate transition-colors',
            h.level === 1 && 'font-semibold text-foreground/80',
            h.level === 2 && 'pl-4',
            h.level === 3 && 'pl-6',
            h.level >= 4 && 'pl-8',
          )}
          onClick={() => scrollToHeading(h.text)}
          title={h.text}
        >
          {h.text || '(untitled heading)'}
        </button>
      ))}
    </div>
  );
}
