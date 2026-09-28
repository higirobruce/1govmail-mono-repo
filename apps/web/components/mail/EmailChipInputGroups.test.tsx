import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { EmailChipInput } from './EmailChipInput';
import { api } from '@/lib/api';
import { toast } from 'sonner';

vi.mock('@/lib/api', () => ({
  api: { contacts: { autocomplete: vi.fn() } },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const autocomplete = api.contacts.autocomplete as unknown as ReturnType<typeof vi.fn>;

const group = (members: Array<{ email: string; name?: string }>) => ({
  kind: 'group' as const,
  groupId: 'g1',
  display: 'Finance Team',
  memberCount: members.length,
  members,
});

function Harness({ initial = [] as string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return <EmailChipInput label="To" value={value} onChange={setValue} placeholder="recipients@example.com" />;
}

// Queried by role, not placeholder: the input's placeholder attribute is
// cleared once any chip is present (`value.length === 0 ? placeholder : ''`),
// which the "drops blank and duplicate members" case below relies on via a
// non-empty `initial`. There is only one textbox in the harness, so this is
// unambiguous regardless of chip state.
const typeQuery = async (text = 'fin') => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });
};

const pickGroup = async () => {
  const opt = await screen.findByText(/Finance Team/);
  fireEvent.mouseDown(opt);
};

describe('EmailChipInput — groups', () => {
  beforeEach(() => {
    autocomplete.mockReset();
    (toast.info as ReturnType<typeof vi.fn>).mockReset();
  });

  it('requests group suggestions', async () => {
    autocomplete.mockResolvedValue([]);
    render(<Harness />);
    await typeQuery();
    expect(autocomplete.mock.calls[0]).toEqual(['fin', { includeGroups: true }]);
  });

  it('shows a group with its member count', async () => {
    autocomplete.mockResolvedValue([group([{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }])]);
    render(<Harness />);
    await typeQuery();
    expect(await screen.findByText(/Finance Team/)).toBeInTheDocument();
    expect(screen.getByText(/2 members/)).toBeInTheDocument();
  });

  it('expands a group into one chip per member', async () => {
    autocomplete.mockResolvedValue([group([{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }])]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    expect(await screen.findByText('a@risa.gov.rw')).toBeInTheDocument();
    expect(screen.getByText('b@risa.gov.rw')).toBeInTheDocument();
  });

  // Review Focus #5 — blanks, duplicates, and case variants must not become chips.
  it('drops blank and duplicate members, case-insensitively', async () => {
    autocomplete.mockResolvedValue([
      group([
        { email: 'a@risa.gov.rw' },
        { email: '  ' },
        { email: 'A@RISA.GOV.RW' },
        { email: 'b@risa.gov.rw' },
      ]),
    ]);
    render(<Harness initial={['b@risa.gov.rw']} />);
    await typeQuery();
    await pickGroup();
    await waitFor(() => expect(screen.getByText('a@risa.gov.rw')).toBeInTheDocument());
    expect(screen.getAllByText(/@risa\.gov\.rw/)).toHaveLength(2); // b (pre-existing) + a
  });

  it('says so when the group is empty instead of doing nothing', async () => {
    autocomplete.mockResolvedValue([group([])]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    expect((toast.info as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/has no members/i);
  });

  it('caps expansion at 50 chips and collapses the rest', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    autocomplete.mockResolvedValue([group(many)]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    expect(await screen.findByText('+10 more')).toBeInTheDocument();
    expect(screen.getByText('u0@risa.gov.rw')).toBeInTheDocument();
    expect(screen.queryByText('u55@risa.gov.rw')).not.toBeInTheDocument();
  });

  it('expands the remainder when the +N more chip is clicked', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `u${i}@risa.gov.rw` }));
    autocomplete.mockResolvedValue([group(many)]);
    render(<Harness />);
    await typeQuery();
    await pickGroup();
    fireEvent.click(await screen.findByText('+10 more'));
    expect(await screen.findByText('u55@risa.gov.rw')).toBeInTheDocument();
    expect(screen.queryByText('+10 more')).not.toBeInTheDocument();
  });
});
