'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import type { MailSearchFilter } from '@/lib/api';

interface FolderOption {
  id: string;
  name: string;
}

type TriState = boolean | undefined;

interface AdvancedSearchPanelProps {
  /** Folder list already loaded on the mail page — same `id`/`name` shape it renders elsewhere. */
  folders: FolderOption[];
  onSearch: (filter: MailSearchFilter) => void;
  /** Hidden for EWS accounts — the backend intentionally ignores `flagged` there. */
  hideFlagged?: boolean;
  /** Called after the internal fields are reset (Clear). Optional — the page decides what "clear" means for search mode. */
  onClear?: () => void;
}

const EMPTY_STATE = {
  keyword: '',
  from: '',
  to: '',
  subject: '',
  dateFrom: '',
  dateTo: '',
  hasAttachment: false,
  folderId: '',
  unread: undefined as TriState,
  flagged: undefined as TriState,
};

type PanelState = typeof EMPTY_STATE;

/** Assemble a MailSearchFilter from the panel's local field state, omitting
 *  every empty/absent field (whitespace-only text counts as empty). */
export function buildFilterFromState(state: PanelState): MailSearchFilter {
  const filter: MailSearchFilter = {};
  if (state.keyword.trim()) filter.keyword = state.keyword.trim();
  if (state.from.trim()) filter.from = state.from.trim();
  if (state.to.trim()) filter.to = state.to.trim();
  if (state.subject.trim()) filter.subject = state.subject.trim();
  if (state.dateFrom) filter.dateFrom = state.dateFrom;
  if (state.dateTo) filter.dateTo = state.dateTo;
  if (state.hasAttachment) filter.hasAttachment = true;
  if (state.folderId) filter.folderId = state.folderId;
  if (state.unread !== undefined) filter.unread = state.unread;
  if (state.flagged !== undefined) filter.flagged = state.flagged;
  return filter;
}

function TriStateControl({
  label,
  value,
  onChange,
  yesLabel = 'Yes',
  noLabel = 'No',
}: {
  label: string;
  value: TriState;
  onChange: (v: TriState) => void;
  yesLabel?: string;
  noLabel?: string;
}) {
  const options: { key: string; value: TriState; text: string }[] = [
    { key: 'any', value: undefined, text: 'Any' },
    { key: 'yes', value: true, text: yesLabel },
    { key: 'no', value: false, text: noLabel },
  ];
  return (
    <div>
      <div className="block text-[0.6875rem] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-muted/60"
      >
        {options.map((opt) => (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'px-3 py-1 rounded-full text-[0.75rem] font-medium transition-all',
              value === opt.value
                ? 'bg-card text-foreground shadow-pill'
                : 'text-muted-foreground/60 hover:text-foreground',
            )}
          >
            {opt.text}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AdvancedSearchPanel({
  folders,
  onSearch,
  hideFlagged = false,
  onClear,
}: AdvancedSearchPanelProps) {
  const [state, setState] = useState<PanelState>({ ...EMPTY_STATE });

  const set = <K extends keyof PanelState>(key: K, value: PanelState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const handleSearch = () => {
    onSearch(buildFilterFromState(state));
  };

  const handleClear = () => {
    setState({ ...EMPTY_STATE });
    onClear?.();
  };

  const fieldLabelCls = 'block text-[0.6875rem] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-1';
  const inputCls = 'h-8 text-[0.75rem]';

  return (
    <div className="w-full space-y-3">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={fieldLabelCls} htmlFor="adv-search-keyword">Keyword</label>
          <Input
            id="adv-search-keyword"
            value={state.keyword}
            onChange={(e) => set('keyword', e.target.value)}
            placeholder="Any field"
            className={inputCls}
          />
        </div>
        <div>
          <label className={fieldLabelCls} htmlFor="adv-search-subject">Subject</label>
          <Input
            id="adv-search-subject"
            value={state.subject}
            onChange={(e) => set('subject', e.target.value)}
            placeholder="Subject contains…"
            className={inputCls}
          />
        </div>
        <div>
          <label className={fieldLabelCls} htmlFor="adv-search-from">From</label>
          <Input
            id="adv-search-from"
            value={state.from}
            onChange={(e) => set('from', e.target.value)}
            placeholder="Sender"
            className={inputCls}
          />
        </div>
        <div>
          <label className={fieldLabelCls} htmlFor="adv-search-to">To</label>
          <Input
            id="adv-search-to"
            value={state.to}
            onChange={(e) => set('to', e.target.value)}
            placeholder="Recipient"
            className={inputCls}
          />
        </div>
        <div>
          <label className={fieldLabelCls} htmlFor="adv-search-date-from">Date from</label>
          <Input
            id="adv-search-date-from"
            type="date"
            value={state.dateFrom}
            onChange={(e) => set('dateFrom', e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={fieldLabelCls} htmlFor="adv-search-date-to">Date to</label>
          <Input
            id="adv-search-date-to"
            type="date"
            value={state.dateTo}
            onChange={(e) => set('dateTo', e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <label className={fieldLabelCls} htmlFor="adv-search-folder">Folder</label>
        <select
          id="adv-search-folder"
          value={state.folderId}
          onChange={(e) => set('folderId', e.target.value)}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[0.75rem] text-foreground outline-none focus-visible:border-ring/60 focus-visible:ring-1 focus-visible:ring-ring/20"
        >
          <option value="">All folders</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-[0.75rem] text-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={state.hasAttachment}
          onChange={(e) => set('hasAttachment', e.target.checked)}
          className="h-3.5 w-3.5 rounded border-input"
        />
        Has attachment
      </label>

      <div className="flex flex-wrap items-start gap-4">
        <TriStateControl
          label="Read status"
          value={state.unread}
          onChange={(v) => set('unread', v)}
          yesLabel="Unread"
          noLabel="Read"
        />
        {!hideFlagged && (
          <TriStateControl
            label="Flagged"
            value={state.flagged}
            onChange={(v) => set('flagged', v)}
            yesLabel="Flagged"
            noLabel="Unflagged"
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/20">
        <button
          type="button"
          onClick={handleClear}
          className="h-8 px-3 rounded-lg text-[0.75rem] font-medium text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleSearch}
          className="h-8 px-3.5 rounded-lg text-[0.75rem] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Search
        </button>
      </div>
    </div>
  );
}
