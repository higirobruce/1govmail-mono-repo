import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiProfileNudge } from './AiProfileNudge';
import { useUIStore } from '@/stores/ui.store';
import { useAIStore } from '@/stores/ai.store';
import { api } from '@/lib/api';

const EMPTY = { jobTitle: null, institution: null, department: null, instructions: null, language: null };
const FILLED = { ...EMPTY, jobTitle: 'Director of ICT' };

describe('AiProfileNudge', () => {
  beforeEach(() => {
    useUIStore.setState({ aiProfileNudgeDismissed: false });
  });

  it('invites the user when the profile is empty', () => {
    render(<AiProfileNudge profile={EMPTY} />);
    expect(screen.getByText(/knows your role/i)).toBeTruthy();
  });

  it('renders nothing once the profile has been filled in', () => {
    const { container } = render(<AiProfileNudge profile={FILLED} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing while the profile is still loading', () => {
    const { container } = render(<AiProfileNudge profile={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('disappears for good when waved away', () => {
    const { container } = render(<AiProfileNudge profile={EMPTY} />);
    fireEvent.click(screen.getByLabelText('Dismiss'));

    expect(container.textContent).toBe('');
    expect(useUIStore.getState().aiProfileNudgeDismissed).toBe(true);
  });

  it('opens the form in place — the chat is never left behind', () => {
    render(<AiProfileNudge profile={EMPTY} />);

    fireEvent.click(screen.getByText('Add details'));

    expect(screen.getByLabelText('Job title')).toBeTruthy();
    expect(screen.getByLabelText('Institution')).toBeTruthy();
    expect(screen.getByLabelText('Department')).toBeTruthy();
    expect(screen.getByLabelText('Language')).toBeTruthy();
    expect(screen.getByLabelText('Style instructions')).toBeTruthy();
  });
});

describe('AiProfileNudge inline form', () => {
  beforeEach(() => {
    useUIStore.setState({ aiProfileNudgeDismissed: false });
    useAIStore.setState({ profileCard: { jobTitle: null, institution: null, department: null, language: null }, customInstructions: '' });
    vi.restoreAllMocks();
  });

  const open = () => {
    render(<AiProfileNudge profile={EMPTY} />);
    fireEvent.click(screen.getByText('Add details'));
  };

  it('saves the typed profile and reflects it in the AI store immediately', async () => {
    // Writing the store here is what makes the NEXT question in this same
    // conversation use the profile, instead of waiting for a device sync.
    const update = vi.spyOn(api.settings, 'updateAiProfile').mockResolvedValue({} as any);
    open();

    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Director of ICT' } });
    fireEvent.change(screen.getByLabelText('Style instructions'), { target: { value: 'Be brief' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      jobTitle: 'Director of ICT', institution: '', department: '', language: '', instructions: 'Be brief',
    }));
    await waitFor(() => {
      expect(useAIStore.getState().profileCard.jobTitle).toBe('Director of ICT');
      expect(useAIStore.getState().customInstructions).toBe('Be brief');
    });
  });

  it('fills only the blanks when asked to suggest from mail', async () => {
    vi.spyOn(api.settings, 'getAiProfileSuggestions').mockResolvedValue({
      jobTitle: 'Suggested Title', institution: 'RISA', department: 'Software',
    } as any);
    open();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Typed by hand' } });

    fireEvent.click(screen.getByText('Suggest from my mail'));

    await waitFor(() => {
      expect((screen.getByLabelText('Institution') as HTMLInputElement).value).toBe('RISA');
    });
    // what the user typed is never overwritten by a suggestion
    expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('Typed by hand');
  });

  it('keeps the typing on screen when the save fails', async () => {
    vi.spyOn(api.settings, 'updateAiProfile').mockRejectedValue(new Error('offline'));
    open();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Director of ICT' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('Director of ICT');
    });
  });

  it('cancel closes the form without saving anything', async () => {
    const update = vi.spyOn(api.settings, 'updateAiProfile').mockResolvedValue({} as any);
    open();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Director of ICT' } });

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByLabelText('Job title')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
