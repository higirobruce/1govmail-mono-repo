import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const getMessage = vi.fn(async () => ({
  subject: 'Invitation: Digital Skills Workshop',
  fromEmail: 'erick@risa.gov.rw',
  fromName: 'Erick',
  bodyText: 'You are invited to the Digital Skills Workshop on 12 September at RISA HQ.',
  bodyHtml: null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    mail: { getMessage: (...a: unknown[]) => getMessage(...(a as [])) },
    contacts: { autocomplete: vi.fn(async () => []) },
    calendar: {
      createEvent: vi.fn(async () => ({ id: 'e1' })),
      updateEvent: vi.fn(async () => ({ id: 'e1' })),
      getFreeBusyBatch: vi.fn(async () => []),
      getEvents: vi.fn(async () => []),
      getEvent: vi.fn(async () => null),
      deleteEvent: vi.fn(),
      rsvp: vi.fn(),
    },
  },
}));

const chat = vi.fn(async () => '{}');
vi.mock('@/lib/ai/client', () => ({
  AIClient: class {
    chat(...a: unknown[]) { return chat(...(a as [])); }
  },
  AIHttpError: class extends Error {},
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { CreateEventModal } from './page';
import { useAIStore } from '@/stores/ai.store';

const ALL_DAY_PARSE = JSON.stringify({
  title: 'Digital Skills Workshop',
  startAt: '2026-09-12',
  endAt: '2026-09-12',
  allDay: true,
  location: 'RISA HQ',
  attendees: ['erick@risa.gov.rw', 'jean@risa.gov.rw'],
});

const prefill = {
  title: 'Invitation: Digital Skills Workshop',
  linkedMessageId: 'm1',
  linkedSubject: 'Invitation: Digital Skills Workshop',
  aiFillMessageId: 'm1',
};

function fieldButton(label: string): HTMLElement {
  const el = screen.getByText(label);
  const button = el.parentElement?.querySelector('button');
  if (!button) throw new Error(`no picker button under "${label}"`);
  return button;
}

beforeEach(() => {
  useAIStore.setState({ enabled: true, model: 'gemma2:2b' });
  chat.mockReset();
  getMessage.mockClear();
});

describe('CreateEventModal AI live-fill', () => {
  it('applies an all-day parse once and leaves both pickers on a well-formed value', async () => {
    chat.mockResolvedValue(ALL_DAY_PARSE);

    render(<CreateEventModal prefillData={prefill} onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /all day/i })).toBeChecked();
    });

    // All-day pickers render date-only labels — never "Pick a date", which is
    // what an unparseable value (e.g. a half-written datetime) would produce.
    expect(fieldButton('Start')).toHaveTextContent('Sep 12, 2026');
    expect(fieldButton('End')).toHaveTextContent('Sep 12, 2026');
    expect(screen.getByDisplayValue('Digital Skills Workshop')).toBeInTheDocument();
    expect(screen.getByText('erick@risa.gov.rw')).toBeInTheDocument();

    // One fetch, one parse — and the form settles instead of re-rendering on.
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('re-running the fill on a fresh mount reaches the same state (no drift)', async () => {
    chat.mockResolvedValue(ALL_DAY_PARSE);

    const { unmount } = render(
      <CreateEventModal prefillData={prefill} onClose={() => {}} onCreated={() => {}} />,
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /all day/i })).toBeChecked());
    const firstStart = fieldButton('Start').textContent;
    unmount();

    render(<CreateEventModal prefillData={prefill} onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /all day/i })).toBeChecked());
    expect(fieldButton('Start').textContent).toBe(firstStart);
  });

  it('does not touch the form when the parse yields nothing', async () => {
    chat.mockResolvedValue('no json here');

    render(<CreateEventModal prefillData={prefill} onClose={() => {}} onCreated={() => {}} />);

    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText(/Reading the email/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('checkbox', { name: /all day/i })).not.toBeChecked();
    expect(screen.getByDisplayValue('Invitation: Digital Skills Workshop')).toBeInTheDocument();
  });
});
