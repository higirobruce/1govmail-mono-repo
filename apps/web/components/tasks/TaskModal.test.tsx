import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    tasks: {
      create: vi.fn(async () => ({ id: 't1' })),
      update: vi.fn(),
      createSubtask: vi.fn(),
      assign: vi.fn(),
    },
    contacts: { autocomplete: vi.fn() },
  },
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: any) => sel({ user: { id: 'u1', email: 'me@risa.gov.rw', displayName: 'Me' } }),
}));

import { api } from '@/lib/api';
import TaskModal from './TaskModal';

const prefill = {
  title: 'Chase TOR',
  dueDate: '2026-09-11',
  priority: 'HIGH' as const,
  linkedMessageId: 'm1',
  linkedSubject: 'Re: TOR',
};

describe('TaskModal prefill', () => {
  it('seeds the create-mode form from prefill (title, due date, priority)', () => {
    render(
      <TaskModal open task={null} onClose={() => {}} onSaved={() => {}} prefill={prefill} />,
    );

    expect(screen.getByPlaceholderText('What needs to be done?')).toHaveValue('Chase TOR');

    // Due date picker (button, not a native input) shows the seeded date, formatted.
    const dueDateLabel = screen.getByText('Due date');
    const dueDateButton = dueDateLabel.parentElement?.querySelector('button');
    expect(dueDateButton).toHaveTextContent('Sep 11, 2026');

    // Priority select's trigger (radix Select renders the selected item's
    // label into the trigger's value span, even while the listbox is closed).
    const priorityLabel = screen.getByText('Priority');
    const priorityTrigger = priorityLabel.parentElement?.querySelector('[role="combobox"]');
    expect(priorityTrigger).toHaveTextContent('High');
  });

  it('links the message id/subject from prefill', () => {
    render(
      <TaskModal open task={null} onClose={() => {}} onSaved={() => {}} prefill={prefill} />,
    );
    expect(screen.getByPlaceholderText('Paste or type the email subject…')).toHaveValue('Re: TOR');
    expect(screen.getByTitle('Open linked email')).toHaveAttribute('href', '/mail?open=m1');
  });
});

describe('TaskModal onCreateOverride', () => {
  it('routes create-mode save through onCreateOverride instead of api.tasks.create', async () => {
    const created = { id: 'override-1' };
    const onCreateOverride = vi.fn(async () => created as any);
    const onSaved = vi.fn();

    render(
      <TaskModal
        open
        task={null}
        onClose={() => {}}
        onSaved={onSaved}
        prefill={{ title: 'Chase TOR' }}
        onCreateOverride={onCreateOverride}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(onCreateOverride).toHaveBeenCalledTimes(1));
    expect(onCreateOverride).toHaveBeenCalledWith(expect.objectContaining({ title: 'Chase TOR' }));
    expect(api.tasks.create).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'override-1' })));
  });
});
