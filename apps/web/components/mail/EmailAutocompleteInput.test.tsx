import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { EmailAutocompleteInput } from './EmailAutocompleteInput';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { contacts: { autocomplete: vi.fn() } },
}));

const autocomplete = api.contacts.autocomplete as unknown as ReturnType<typeof vi.fn>;

/** Controlled wrapper so the field behaves as it does in the panel. */
function Harness({ onValue }: { onValue?: (v: string) => void } = {}) {
  const [value, setValue] = useState('');
  return (
    <EmailAutocompleteInput
      id="f"
      value={value}
      onChange={(v) => { setValue(v); onValue?.(v); }}
      placeholder="Sender"
    />
  );
}

describe('EmailAutocompleteInput', () => {
  beforeEach(() => {
    autocomplete.mockReset();
    autocomplete.mockResolvedValue([
      { email: 'alice.umutoni@risa.gov.rw', display: 'Alice Umutoni' },
      { email: 'alex@risa.gov.rw', display: 'alex@risa.gov.rw' },
    ]);
  });

  it('suggests contacts once the query is long enough', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('Sender'), { target: { value: 'al' } });

    await waitFor(() => expect(autocomplete).toHaveBeenCalledWith('al'), { timeout: 2000 });
    expect(await screen.findByText('Alice Umutoni')).toBeInTheDocument();
  });

  it('does not query on a single character', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('Sender'), { target: { value: 'a' } });

    await new Promise((r) => setTimeout(r, 600));
    expect(autocomplete).not.toHaveBeenCalled();
  });

  it('fills the field with the exact address when a suggestion is picked', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByPlaceholderText('Sender') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'al' } });

    const option = await screen.findByText('Alice Umutoni', {}, { timeout: 2000 });
    fireEvent.mouseDown(option);

    await waitFor(() => expect(input.value).toBe('alice.umutoni@risa.gov.rw'));
    // dropdown closes after selection
    expect(screen.queryByText('Alice Umutoni')).not.toBeInTheDocument();
  });

  it('keeps free text as the filter value — suggestions never constrain the search', async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('Sender') as HTMLInputElement;

    // a partial name or bare domain is a legitimate contains-search
    fireEvent.change(input, { target: { value: '@minaffet.gov.rw' } });
    await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });

    expect(input.value).toBe('@minaffet.gov.rw');
  });

  it('survives a failing lookup without clearing what was typed', async () => {
    autocomplete.mockRejectedValue(new Error('offline'));
    render(<Harness />);
    const input = screen.getByPlaceholderText('Sender') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'alice' } });
    await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });

    expect(input.value).toBe('alice');
  });
});
