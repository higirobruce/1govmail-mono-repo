'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useState } from 'react';
import { Globe, Youtube, Figma, Map, X, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── URL detection ─────────────────────────────────────────────────────────────

export interface EmbedInfo {
  embedUrl: string;
  embedType: 'youtube' | 'figma' | 'maps' | 'loom' | 'generic';
  label: string;
}

export function getEmbedInfo(url: string): EmbedInfo | null {
  try { new URL(url); } catch { return null; }

  // YouTube
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (yt) return { embedUrl: `https://www.youtube.com/embed/${yt[1]}?rel=0`, embedType: 'youtube', label: 'YouTube' };

  // Figma
  if (url.includes('figma.com/') && (url.includes('/file/') || url.includes('/design/'))) {
    return {
      embedUrl: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`,
      embedType: 'figma',
      label: 'Figma',
    };
  }

  // Loom
  const loom = url.match(/loom\.com\/share\/([a-zA-Z0-9]+)/);
  if (loom) return { embedUrl: `https://www.loom.com/embed/${loom[1]}`, embedType: 'loom', label: 'Loom' };

  // Google Maps
  if (url.includes('google.com/maps') || url.includes('maps.google.com')) {
    const embedUrl = url.includes('output=embed')
      ? url
      : url + (url.includes('?') ? '&' : '?') + 'output=embed';
    return { embedUrl, embedType: 'maps', label: 'Google Maps' };
  }

  return null;
}

const TYPE_ICON: Record<string, React.ElementType> = {
  youtube: Youtube,
  figma: Figma,
  maps: Map,
  loom: Globe,
  generic: Globe,
};

// ── Node view ─────────────────────────────────────────────────────────────────

function EmbedView({ node, updateAttributes, deleteNode }: any) {
  const [inputUrl, setInputUrl] = useState('');
  const [error, setError] = useState('');

  const { url, embedUrl, embedType, label } = node.attrs as {
    url: string;
    embedUrl: string;
    embedType: string;
    label: string;
  };

  const handleEmbed = () => {
    const info = getEmbedInfo(inputUrl.trim());
    if (!info) {
      setError('URL not supported. Try YouTube, Figma, Loom, or Google Maps.');
      return;
    }
    setError('');
    updateAttributes({ url: inputUrl.trim(), embedUrl: info.embedUrl, embedType: info.embedType, label: info.label });
  };

  if (!embedUrl) {
    return (
      <NodeViewWrapper>
        <div contentEditable={false} className="my-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Globe className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Embed</span>
          </div>
          <div className="flex gap-2">
            <input
              type="url"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleEmbed(); if (e.key === 'Escape') deleteNode(); }}
              placeholder="Paste a YouTube, Figma, Loom, or Google Maps URL…"
              className="flex-1 text-sm bg-background border border-border rounded-md px-3 py-1.5 outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <button
              type="button"
              onClick={handleEmbed}
              className="text-sm bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90 transition-colors"
            >
              Embed
            </button>
          </div>
          {error && <p className="text-xs text-destructive mt-1.5">{error}</p>}
          <p className="text-[0.6875rem] text-muted-foreground mt-2">
            Supports: YouTube · Figma · Loom · Google Maps
          </p>
        </div>
      </NodeViewWrapper>
    );
  }

  const Icon = TYPE_ICON[embedType] ?? Globe;

  return (
    <NodeViewWrapper>
      <div contentEditable={false} className="my-3 group relative rounded-lg overflow-hidden border border-border">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/50 border-b border-border">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{label ?? embedType}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[0.625rem] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
          >
            <Link2 className="w-3 h-3" /> Open
          </a>
          <button
            type="button"
            onClick={deleteNode}
            className="text-muted-foreground/50 hover:text-destructive transition-colors"
            title="Remove embed"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className={cn('w-full', embedType === 'maps' ? 'h-80' : 'aspect-video')}>
          <iframe
            src={embedUrl}
            className="w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
            loading="lazy"
            title={label ?? 'Embed'}
          />
        </div>
      </div>
    </NodeViewWrapper>
  );
}

// ── TipTap Node ───────────────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: {
      insertEmbed: (attrs?: { url?: string; embedUrl?: string; embedType?: string; label?: string }) => ReturnType;
    };
  }
}

export const EmbedNode = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url:       { default: '' },
      embedUrl:  { default: '' },
      embedType: { default: 'generic' },
      label:     { default: 'Embed' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-embed]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-embed': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },

  addCommands() {
    return {
      insertEmbed:
        (attrs = {}) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
