import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdvancedSearchPanel from './AdvancedSearchPanel';

const folders = [
  { id: 'f1', name: 'Inbox' },
  { id: 'f2', name: 'Archive' },
];

describe('AdvancedSearchPanel', () => {
  it('omits empty fields and fires onSearch with only the filled-in ones', () => {
    const onSearch = vi.fn();
    render(<AdvancedSearchPanel folders={folders} onSearch={onSearch} />);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: ' alice@risa.gov.rw ' } });
    fireEvent.change(screen.getByLabelText('Date from'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByLabelText('Has attachment'));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith({
      from: 'alice@risa.gov.rw',
      dateFrom: '2026-09-01',
      hasAttachment: true,
    });
  });

  it('compiles every field type into the right MailSearchFilter', () => {
    const onSearch = vi.fn();
    render(<AdvancedSearchPanel folders={folders} onSearch={onSearch} />);

    fireEvent.change(screen.getByLabelText('Keyword'), { target: { value: 'budget' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Q3 report' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'bob@risa.gov.rw' } });
    fireEvent.change(screen.getByLabelText('Date to'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'f2' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Unread' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Unflagged' }));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).toHaveBeenCalledWith({
      keyword: 'budget',
      subject: 'Q3 report',
      to: 'bob@risa.gov.rw',
      dateTo: '2026-09-10',
      folderId: 'f2',
      unread: true,
      flagged: false,
    });
  });

  it('a whitespace-only field is treated as absent', () => {
    const onSearch = vi.fn();
    render(<AdvancedSearchPanel folders={folders} onSearch={onSearch} />);

    fireEvent.change(screen.getByLabelText('Keyword'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).toHaveBeenCalledWith({});
  });

  it('Clear resets every field back to empty and calls onClear', () => {
    const onSearch = vi.fn();
    const onClear = vi.fn();
    render(<AdvancedSearchPanel folders={folders} onSearch={onSearch} onClear={onClear} />);

    fireEvent.change(screen.getByLabelText('Keyword'), { target: { value: 'budget' } });
    fireEvent.click(screen.getByLabelText('Has attachment'));
    fireEvent.click(screen.getByRole('radio', { name: 'Flagged' }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenCalledWith({});
    expect((screen.getByLabelText('Keyword') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Has attachment') as HTMLInputElement).checked).toBe(false);
  });

  it('hides the Flagged control when hideFlagged is set', () => {
    render(<AdvancedSearchPanel folders={folders} onSearch={vi.fn()} hideFlagged />);
    expect(screen.queryByText('Flagged')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Flagged' })).toBeNull();
    // Read status tri-state is unaffected
    expect(screen.getByRole('radio', { name: 'Unread' })).toBeTruthy();
  });

  it('shows the Flagged control by default', () => {
    render(<AdvancedSearchPanel folders={folders} onSearch={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Flagged' })).toBeTruthy();
  });
});
