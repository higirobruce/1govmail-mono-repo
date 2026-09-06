import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GenerationAnswer } from './GenerationAnswer';

const SOURCES = [
  { alias: 's1', type: 'mail' as const, id: 'm1', title: 'Budget', fromEmail: 'jd@gov.rw',
    fromName: 'J D', date: '2026-09-01T00:00:00Z', meta: null, injectionSuspected: false, snippet: 'x' },
];

describe('GenerationAnswer', () => {
  it('renders cite segments as chips and fires onSourceClick', () => {
    const onClick = vi.fn();
    render(<GenerationAnswer content="See [s1] for detail." sources={SOURCES} onSourceClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Budget/ }));
    expect(onClick).toHaveBeenCalledWith({ type: 'mail', id: 'm1' });
  });

  it('never renders a chip for an alias the server did not vouch for', () => {
    render(<GenerationAnswer content="Fake [s9] citation." sources={SOURCES} onSourceClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /s9/ })).toBeNull();
    expect(screen.getByText(/\[s9\]/)).toBeTruthy(); // stays literal text
  });

  it('shows the injection banner when any source is flagged', () => {
    render(<GenerationAnswer content="x" sources={[{ ...SOURCES[0], injectionSuspected: true }]} onSourceClick={vi.fn()} />);
    expect(screen.getByText(/injection/i)).toBeTruthy();
  });
});
