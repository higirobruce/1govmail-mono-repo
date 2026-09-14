'use client';

import { useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useUIStore } from '@/stores/ui.store';
import { useAIStore } from '@/stores/ai.store';
import { shouldShowAiProfileNudge, type AiProfileNudgeInput } from '@/lib/ai/profileNudge';
import {
  AI_PROFILE_FIELD_MAX_CHARS,
  mergeSuggestions,
  normalizeProfileDraft,
  type AiProfileDraft,
} from '@/lib/ai/profileDraft';
import { CUSTOM_INSTRUCTIONS_MAX_CHARS } from '@/lib/ai/prompt';

interface AiProfileNudgeProps {
  /** The account's AI profile, or undefined while it is still loading. */
  profile?: AiProfileNudgeInput | null;
}

const EMPTY_DRAFT: AiProfileDraft = {
  jobTitle: '', institution: '', department: '', language: '', instructions: '',
};

const LANGUAGES = [
  { value: '',   label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'rw', label: 'Kinyarwanda' },
];

/** Shared input chrome — the panel is narrow, so everything runs small. */
const FIELD_CLASS =
  'w-full rounded border border-border/50 bg-background px-2 py-1 text-[0.75rem] text-foreground ' +
  'placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary/40';

/**
 * A one-line invitation to fill in the AI profile, shown inside the AI panes
 * and nowhere else — someone who never opens AI never sees it.
 *
 * "Add details" expands the line into the form itself rather than sending the
 * user to Settings: the whole point is that they can answer it without leaving
 * the conversation they were in the middle of.
 *
 * Deliberately not a modal and not a toast: it does not block, it does not
 * follow the user around, and waving it away is permanent.
 */
export function AiProfileNudge({ profile }: AiProfileNudgeProps) {
  const dismissed = useUIStore((s) => s.aiProfileNudgeDismissed);
  const dismiss = useUIStore((s) => s.dismissAiProfileNudge);
  const setProfileCard = useAIStore((s) => s.setProfileCard);
  const setCustomInstructions = useAIStore((s) => s.setCustomInstructions);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AiProfileDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  if (!shouldShowAiProfileNudge(profile, dismissed)) return null;

  const field = (key: keyof AiProfileDraft, max: number) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setDraft((d) => ({ ...d, [key]: e.target.value.slice(0, max) }));

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const suggestions = await api.settings.getAiProfileSuggestions();
      // Fills blanks only — anything already typed survives untouched.
      setDraft((current) => mergeSuggestions(current, suggestions));
    } catch (err: any) {
      toast.error('Could not read suggestions from your mail', { description: err?.message });
    } finally {
      setSuggesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = normalizeProfileDraft(draft);
      await api.settings.updateAiProfile(payload);
      // Write the store too, so the very next question in THIS conversation
      // already uses the profile instead of waiting for the next device sync.
      setProfileCard({
        jobTitle: payload.jobTitle || null,
        institution: payload.institution || null,
        department: payload.department || null,
        language: payload.language || null,
      });
      setCustomInstructions(payload.instructions);
      toast.success('AI profile saved');
      setOpen(false);
    } catch (err: any) {
      // The form stays open with everything typed still in it — a failed save
      // must never cost the user their answers.
      toast.error('Could not save your profile', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-border-faint bg-muted/50">
      <div className="flex items-center gap-2 px-3 py-2 text-ui text-ink-2">
        <Sparkles className="w-3.5 h-3.5 shrink-0 text-primary" />
        <span className="flex-1 min-w-0">
          Answers improve when 1Gov knows your role.
        </span>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="shrink-0 font-medium text-primary hover:underline"
          >
            Add details
          </button>
        )}
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 p-0.5 rounded hover:bg-muted text-ink-3 hover:text-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <label className="flex flex-col gap-1 text-[0.6875rem] text-ink-3">
            Job title
            <input
              aria-label="Job title"
              className={FIELD_CLASS}
              value={draft.jobTitle}
              onChange={field('jobTitle', AI_PROFILE_FIELD_MAX_CHARS)}
              placeholder="Director of ICT"
            />
          </label>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-ink-3">
            Institution
            <input
              aria-label="Institution"
              className={FIELD_CLASS}
              value={draft.institution}
              onChange={field('institution', AI_PROFILE_FIELD_MAX_CHARS)}
              placeholder="RISA"
            />
          </label>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-ink-3">
            Department
            <input
              aria-label="Department"
              className={FIELD_CLASS}
              value={draft.department}
              onChange={field('department', AI_PROFILE_FIELD_MAX_CHARS)}
              placeholder="Software Engineering"
            />
          </label>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-ink-3">
            Language
            <select
              aria-label="Language"
              className={FIELD_CLASS}
              value={draft.language}
              onChange={field('language', AI_PROFILE_FIELD_MAX_CHARS)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-ink-3">
            Style instructions
            <textarea
              aria-label="Style instructions"
              rows={2}
              className={`${FIELD_CLASS} resize-none`}
              value={draft.instructions}
              onChange={field('instructions', CUSTOM_INSTRUCTIONS_MAX_CHARS)}
              placeholder="Keep replies short and formal"
            />
          </label>

          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={handleSuggest}
              disabled={suggesting || saving}
              className="inline-flex items-center gap-1 text-[0.6875rem] text-ink-2 hover:text-foreground disabled:opacity-50"
            >
              {suggesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Suggest from my mail
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => { setOpen(false); setDraft(EMPTY_DRAFT); }}
                disabled={saving}
                className="text-[0.6875rem] text-ink-3 hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[0.6875rem] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
