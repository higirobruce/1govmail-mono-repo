import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AiProfileNudge } from './AiProfileNudge';
import { useUIStore } from '@/stores/ui.store';

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

  it('offers a way to go and fill it in', () => {
    const onOpenSettings = vi.fn();
    render(<AiProfileNudge profile={EMPTY} onOpenSettings={onOpenSettings} />);

    fireEvent.click(screen.getByText('Add details'));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
