import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ClarifyCard from './ClarifyCard';

const clarify = {
  clarifyId: 'q1',
  question: 'Which document did you mean?',
  options: ['VAPT Contract (Docs)', 'VAPT-final.pdf (email attachment)'],
};

describe('ClarifyCard', () => {
  it('renders the question and one chip per option', () => {
    render(<ClarifyCard clarify={clarify} onPick={() => {}} disabled={false} />);
    expect(screen.getByText('Which document did you mean?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'VAPT Contract (Docs)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'VAPT-final.pdf (email attachment)' })).toBeTruthy();
  });

  it('clicking a chip calls onPick with that option text', () => {
    const onPick = vi.fn();
    render(<ClarifyCard clarify={clarify} onPick={onPick} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'VAPT Contract (Docs)' }));
    expect(onPick).toHaveBeenCalledWith('VAPT Contract (Docs)');
  });

  it('disabled chips do not fire onPick', () => {
    const onPick = vi.fn();
    render(<ClarifyCard clarify={clarify} onPick={onPick} disabled />);
    const chip = screen.getByRole('button', { name: 'VAPT Contract (Docs)' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onPick).not.toHaveBeenCalled();
  });
});
