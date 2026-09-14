'use client';

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useContactSuggestions, type ContactSuggestion } from '@/hooks/useContactSuggestions';

/**
 * Single-address field with contact/GAL type-ahead, for search filters.
 *
 * Unlike the compose recipient field this holds ONE value and never turns it
 * into a chip: a search filter is a contains-match, so a partial name or a bare
 * domain (`@minaffet.gov.rw`) is a legitimate query. Suggestions are an
 * accelerator for typing an exact address, never a constraint on what can be
 * searched.
 */
export function EmailAutocompleteInput({
  id,
  value,
  onChange,
  placeholder,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Only query while the dropdown is open, so selecting a suggestion (which
  // sets `value` to a full address) does not immediately search for it again.
  const { suggestions, loading, clear } = useContactSuggestions(open ? value : '');

  const close = () => {
    setOpen(false);
    setActiveIdx(-1);
    clear();
  };

  const select = (s: ContactSuggestion) => {
    onChange(s.email);
    close();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const has = suggestions.length > 0;
    if (e.key === 'ArrowDown' && has) {
      e.preventDefault();
      setActiveIdx((p) => (p + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp' && has) {
      e.preventDefault();
      setActiveIdx((p) => (p <= 0 ? suggestions.length - 1 : p - 1));
      return;
    }
    if (e.key === 'Escape') {
      close();
      return;
    }
    // Enter only commits a highlighted suggestion; otherwise it is left alone so
    // the typed text stands as the filter value.
    if ((e.key === 'Enter' || e.key === 'Tab') && has && activeIdx >= 0) {
      e.preventDefault();
      select(suggestions[activeIdx]);
    }
  };

  const showDropdown = open && (loading || suggestions.length > 0);

  return (
    <div className="relative">
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActiveIdx(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKey}
        onBlur={() =>
          setTimeout(() => {
            if (!dropdownRef.current?.contains(document.activeElement)) close();
          }, 150)
        }
        placeholder={placeholder}
        className={className}
        autoComplete="off"
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
      />
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden"
        >
          {loading && suggestions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground/50">
              <Loader2 className="w-3 h-3 animate-spin" />
              Searching…
            </div>
          ) : (
            <ul className="max-h-52 overflow-y-auto py-1" role="listbox">
              {suggestions.map((s, i) => (
                <li key={s.email} role="option" aria-selected={i === activeIdx}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      select(s);
                    }}
                    className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${
                      i === activeIdx ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60 text-foreground'
                    }`}
                  >
                    {s.display !== s.email && (
                      <span className="text-xs font-medium leading-tight truncate">{s.display}</span>
                    )}
                    <span
                      className={`text-xs leading-tight truncate ${
                        s.display !== s.email ? 'text-muted-foreground/60' : 'font-medium'
                      }`}
                    >
                      {s.email}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
