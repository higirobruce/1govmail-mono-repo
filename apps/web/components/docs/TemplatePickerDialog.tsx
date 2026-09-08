'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { TEMPLATES, CATEGORIES, type Template } from '@/lib/docs/templates';

interface UserTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  content: string | null;
  createdAt: string;
}

interface TemplatePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: { title: string; emoji: string; content: string }) => void;
}

export function TemplatePickerDialog({ open, onOpenChange, onSelect }: TemplatePickerDialogProps) {
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);

  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem('user_templates');
      setUserTemplates(raw ? (JSON.parse(raw) as UserTemplate[]) : []);
    } catch {
      setUserTemplates([]);
    }
  }, [open]);

  function deleteUserTemplate(id: string) {
    const next = userTemplates.filter((t) => t.id !== id);
    setUserTemplates(next);
    localStorage.setItem('user_templates', JSON.stringify(next));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] sm:max-w-[92vw] max-h-[88vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>New page</DialogTitle>
          <p className="text-sm text-muted-foreground mt-0.5">Choose a template to get started quickly</p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* My Templates section */}
          {userTemplates.length > 0 && (
            <div className="mb-7">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">My Templates</p>
              <div className="grid grid-cols-3 gap-3">
                {userTemplates.map((template) => (
                  <div key={template.id} className="relative group/card">
                    <button
                      type="button"
                      className={cn(
                        'w-full flex flex-col gap-2.5 p-3.5 rounded-lg border border-border text-left',
                        'hover:bg-muted/50 hover:border-primary/40 transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                      onClick={() => {
                        onSelect({
                          title: template.name,
                          emoji: template.emoji,
                          content: template.content ?? JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
                        });
                        onOpenChange(false);
                      }}
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="text-xl shrink-0 leading-tight">{template.emoji}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold leading-tight">{template.name}</p>
                          {template.description && (
                            <p className="text-[0.6875rem] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{template.description}</p>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      title="Delete template"
                      className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded text-muted-foreground/50 hover:text-destructive hover:bg-muted opacity-0 group-hover/card:opacity-100 transition-opacity text-xs leading-none"
                      onClick={() => deleteUserTemplate(template.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {CATEGORIES.map((category) => (
            <div key={category} className="mb-7">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">{category}</p>
              <div className="grid grid-cols-3 gap-3">
                {TEMPLATES.filter((t) => t.category === category).map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={cn(
                      'flex flex-col gap-2.5 p-3.5 rounded-lg border border-border text-left',
                      'hover:bg-muted/50 hover:border-primary/40 transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                    onClick={() => {
                      onSelect({
                        title: template.id === 'blank' ? 'Untitled' : template.name,
                        emoji: template.emoji,
                        content: JSON.stringify(template.content),
                      });
                      onOpenChange(false);
                    }}
                  >
                    {/* Header row */}
                    <div className="flex items-start gap-2.5">
                      <span className="text-xl shrink-0 leading-tight">{template.emoji}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight">{template.name}</p>
                        <p className="text-[0.6875rem] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{template.description}</p>
                      </div>
                    </div>

                    {/* Section skeleton */}
                    {template.sections.length > 0 && (
                      <div className="flex flex-col gap-1 pt-2 border-t border-border/60">
                        {template.sections.slice(0, 6).map((section) => (
                          <div key={section} className="flex items-center gap-1.5">
                            <div className="w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0" />
                            <span className="text-[0.625rem] text-muted-foreground/70 leading-tight truncate">{section}</span>
                          </div>
                        ))}
                        {template.sections.length > 6 && (
                          <span className="text-[0.625rem] text-muted-foreground/40 pl-2.5">
                            +{template.sections.length - 6} more sections
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
