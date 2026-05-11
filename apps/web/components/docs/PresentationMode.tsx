'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Editor } from '@tiptap/react';

interface Props {
  editor: Editor;
  title: string;
  onClose: () => void;
}

/** Split editor HTML into slide sections.
 *  Priority: split by <hr> → split by <h1> → single slide. */
function buildSlides(html: string, title: string): string[] {
  const hrSplit = html.split(/<hr\s*\/?>/i).map((s) => s.trim()).filter(Boolean);

  let sections: string[];
  if (hrSplit.length > 1) {
    sections = hrSplit;
  } else {
    // Split before each <h1>
    const h1Split = html.split(/(?=<h1[\s>])/).map((s) => s.trim()).filter(Boolean);
    sections = h1Split.length > 1 ? h1Split : [html];
  }

  // Title slide always first
  const titleSlide = `
    <div class="pres-title-slide">
      <h1>${title || 'Untitled'}</h1>
    </div>`;

  return [titleSlide, ...sections];
}

export function PresentationMode({ editor, title, onClose }: Props) {
  const deckRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<any>(null);

  useEffect(() => {
    if (!deckRef.current) return;

    // Inject reveal.js CSS from public folder (avoids package exports restriction)
    const LINK_ID = 'reveal-css';
    if (!document.getElementById(LINK_ID)) {
      const link = document.createElement('link');
      link.id = LINK_ID;
      link.rel = 'stylesheet';
      link.href = '/reveal.css';
      document.head.appendChild(link);
    }

    let deck: any;

    // Dynamically import Reveal so it never runs on the server
    import('reveal.js').then(({ default: Reveal }) => {
      deck = new Reveal(deckRef.current!, {
        hash: false,
        controls: true,
        controlsLayout: 'bottom-right',
        progress: true,
        slideNumber: 'c/t',
        keyboard: true,
        overview: true,
        touch: true,
        center: true,
        transition: 'slide',
        transitionSpeed: 'fast',
        backgroundTransition: 'fade',
        width: '100%',
        height: '100%',
        margin: 0.08,
        minScale: 0.4,
        maxScale: 2.0,
      });

      deck.initialize().then(() => {
        revealRef.current = deck;
      });
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      try { deck?.destroy(); } catch { /* ignore */ }
      document.removeEventListener('keydown', onKey, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const slides = buildSlides(editor.getHTML(), title);
  const isDark = typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');

  return (
    <div
      className="fixed inset-0 z-200"
      style={{ background: isDark ? '#0f1117' : '#fff' }}
    >
      {/* Exit button */}
      <button
        type="button"
        onClick={onClose}
        title="Exit presentation (Esc)"
        className="fixed top-4 right-4 z-201 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-black/20 hover:bg-black/40 text-white backdrop-blur-sm transition-colors"
      >
        <X className="w-3.5 h-3.5" />
        Exit
      </button>

      {/* Reveal.js deck */}
      <div ref={deckRef} className="reveal" style={{ width: '100%', height: '100%' }}>
        <div className="slides">
          {slides.map((html, i) => (
            <section
              key={i}
              dangerouslySetInnerHTML={{ __html: html }}
              style={{ textAlign: 'left' }}
            />
          ))}
        </div>
      </div>

      {/* Scoped styles for the presentation */}
      <style>{`
        .reveal {
          font-family: var(--font-sans, system-ui, sans-serif);
          color: ${isDark ? '#e8eaf0' : '#1a1a1a'};
        }
        .reveal .slides {
          text-align: left;
        }
        .reveal section {
          padding: 0.5rem 1rem;
        }
        /* Title slide */
        .pres-title-slide {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-height: 60vh;
          padding: 2rem;
        }
        .pres-title-slide h1 {
          font-size: clamp(2rem, 5vw, 4rem);
          font-weight: 700;
          line-height: 1.15;
          letter-spacing: -0.02em;
          margin: 0;
          color: ${isDark ? '#f0f2f8' : '#111'};
        }
        /* Content headings */
        .reveal h1 { font-size: clamp(1.6rem, 4vw, 3rem); font-weight: 700; margin-bottom: 0.6em; }
        .reveal h2 { font-size: clamp(1.3rem, 3vw, 2.2rem); font-weight: 600; margin-bottom: 0.5em; }
        .reveal h3 { font-size: clamp(1.1rem, 2.5vw, 1.6rem); font-weight: 600; margin-bottom: 0.4em; }
        .reveal p  { font-size: clamp(0.9rem, 2vw, 1.2rem); line-height: 1.7; margin-bottom: 0.6em; }
        .reveal ul, .reveal ol { padding-left: 1.5rem; }
        .reveal li { font-size: clamp(0.9rem, 2vw, 1.2rem); line-height: 1.7; margin-bottom: 0.3em; }
        .reveal ul  { list-style-type: disc; }
        .reveal ol  { list-style-type: decimal; }
        .reveal code {
          background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)'};
          padding: 0.1em 0.4em;
          border-radius: 0.3em;
          font-size: 0.85em;
        }
        .reveal pre {
          background: #1e1e2e;
          padding: 1rem;
          border-radius: 0.5rem;
          font-size: 0.8em;
          line-height: 1.5;
          overflow: auto;
          max-height: 50vh;
        }
        .reveal pre code { background: transparent; padding: 0; color: #cdd6f4; }
        .reveal blockquote {
          border-left: 3px solid ${isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'};
          padding-left: 1rem;
          opacity: 0.75;
          font-style: italic;
        }
        .reveal table { border-collapse: collapse; width: 100%; }
        .reveal td, .reveal th { border: 1px solid ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'}; padding: 0.5rem 0.75rem; }
        .reveal th { font-weight: 600; background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'}; }
        .reveal img { max-width: 100%; height: auto; border-radius: 0.5rem; }
        .reveal a { color: ${isDark ? '#89b4fa' : '#2563eb'}; text-decoration: underline; }
        /* Controls */
        .reveal .controls { color: ${isDark ? '#89b4fa' : '#2563eb'}; }
        .reveal .progress { color: ${isDark ? '#89b4fa' : '#2563eb'}; height: 3px; }
        .reveal .slide-number {
          font-size: 11px;
          background: rgba(0,0,0,0.3);
          color: white;
          padding: 4px 8px;
          border-radius: 4px;
        }
        /* Fragments */
        .reveal .fragment { opacity: 0; transition: opacity 0.3s; }
        .reveal .fragment.visible { opacity: 1; }
        /* Background */
        .reveal .backgrounds { background: ${isDark ? '#0f1117' : '#ffffff'}; }
      `}</style>
    </div>
  );
}
