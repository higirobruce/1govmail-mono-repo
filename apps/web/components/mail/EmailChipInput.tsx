'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface ContactSuggestion {
  email: string;
  display: string;
}

export function EmailChipInput({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  label?: string;
  value: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (input.trim().length < 2) {
      setSuggestions([]);
      setActiveIdx(-1);
      setLoadingSuggestions(false);
      return;
    }
    setLoadingSuggestions(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await api.contacts.autocomplete(input.trim());
        setSuggestions(results.filter((r) => !value.includes(r.email)));
      } catch {
        setSuggestions([]);
      } finally {
        setLoadingSuggestions(false);
        setActiveIdx(-1);
      }
    }, 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeSuggestions = () => { setSuggestions([]); setActiveIdx(-1); setLoadingSuggestions(false); };
  const commit = (raw: string) => {
    const email = raw.trim().replace(/,+$/, '');
    if (email && !value.includes(email)) onChange([...value, email]);
    setInput(''); closeSuggestions();
  };
  const selectSuggestion = (s: ContactSuggestion) => {
    if (!value.includes(s.email)) onChange([...value, s.email]);
    setInput(''); closeSuggestions(); inputRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hasSuggestions = suggestions.length > 0;
    if (e.key === 'ArrowDown' && hasSuggestions) { e.preventDefault(); setActiveIdx((p) => (p + 1) % suggestions.length); return; }
    if (e.key === 'ArrowUp' && hasSuggestions) { e.preventDefault(); setActiveIdx((p) => (p <= 0 ? suggestions.length - 1 : p - 1)); return; }
    if (e.key === 'Escape') { closeSuggestions(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && hasSuggestions && activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]); return; }
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') { e.preventDefault(); commit(input); }
    else if (e.key === 'Backspace' && input === '' && value.length > 0) { onChange(value.slice(0, -1)); }
  };

  const showDropdown = loadingSuggestions || suggestions.length > 0;

  const inputEl = (
    <div className="relative flex-1">
      <div
        className="flex flex-wrap gap-1.5 px-3 py-1.5 bg-muted/30 border border-border/50 rounded-lg cursor-text min-h-[36px]"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((email) => (
          <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 border border-primary/20 text-primary text-xs rounded-full">
            {email}
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((v) => v !== email)); }} className="text-primary/60 hover:text-primary leading-none">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => setTimeout(() => {
            if (!dropdownRef.current?.contains(document.activeElement)) {
              if (input.trim()) commit(input); else closeSuggestions();
            }
          }, 150)}
          placeholder={value.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[140px] bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
        />
      </div>
      {showDropdown && (
        <div ref={dropdownRef} className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden">
          {loadingSuggestions && suggestions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground/50">
              <Loader2 className="w-3 h-3 animate-spin" />Searching…
            </div>
          ) : (
            <ul className="max-h-52 overflow-y-auto py-1">
              {suggestions.map((s, i) => (
                <li key={s.email}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
                    className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${i === activeIdx ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60 text-foreground'}`}
                  >
                    <span className="text-xs font-medium leading-tight truncate">{s.display !== s.email ? s.display : ''}</span>
                    <span className={`text-xs leading-tight truncate ${s.display !== s.email ? 'text-muted-foreground/60' : 'font-medium'}`}>{s.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  if (!label) return inputEl;

  return (
    <div className="flex items-start gap-2 min-h-[36px]">
      <Label className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider shrink-0 pt-2 w-14 text-right">{label}</Label>
      {inputEl}
    </div>
  );
}
