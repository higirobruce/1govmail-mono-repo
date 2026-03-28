'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string | null;
  docTitle: string;
  docEmoji: string | null;
  onSaved: () => void;
}

export function SaveAsTemplateDialog({ open, onOpenChange, docId, docTitle, docEmoji, onSaved }: Props) {
  const [name, setName] = useState(docTitle);
  const [emoji, setEmoji] = useState(docEmoji ?? '📄');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState<string | null>(null);

  // Reset fields when dialog opens with a new doc
  useEffect(() => {
    if (open) {
      setName(docTitle);
      setEmoji(docEmoji ?? '📄');
      setDescription('');
      setContent(null);
    }
  }, [open, docTitle, docEmoji]);

  // Fetch full content when dialog opens
  useEffect(() => {
    if (!open || !docId) return;
    api.docs.getOne(docId).then((doc) => {
      setContent(doc.content ?? null);
    }).catch(() => {
      setContent(null);
    });
  }, [open, docId]);

  function handleSave() {
    const existing: object[] = (() => {
      try {
        const raw = localStorage.getItem('user_templates');
        return raw ? (JSON.parse(raw) as object[]) : [];
      } catch {
        return [];
      }
    })();

    const entry = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Untitled',
      emoji: emoji.slice(0, 2) || '📄',
      description: description.trim(),
      content,
      createdAt: new Date().toISOString(),
    };

    localStorage.setItem('user_templates', JSON.stringify([...existing, entry]));
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Emoji + name row */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value.slice(0, 2))}
              maxLength={2}
              className="w-12 text-center text-xl border border-border rounded-md px-1 py-1.5 bg-background outline-none focus:border-primary/60"
              aria-label="Emoji"
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
              className="flex-1 border border-border rounded-md px-3 py-1.5 text-sm bg-background outline-none focus:border-primary/60"
              aria-label="Template name"
            />
          </div>

          {/* Description */}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background outline-none focus:border-primary/60 resize-none"
            aria-label="Description"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
