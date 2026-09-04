import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let mockEditor: any = null;
vi.mock('@tiptap/react', () => ({
  useEditor: () => mockEditor,
  EditorContent: (props: any) => <div data-testid="editor" {...props} />,
}));
vi.mock('@/lib/api', () => ({ api: { mail: { send: vi.fn(async () => ({})) } } }));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: any) => sel({ user: { email: 'me@risa.gov.rw', displayName: 'Me' } }),
}));

import { QuickReplyBar } from './QuickReplyBar';

const message = {
  id: 'm1',
  subject: 'Budget review',
  fromEmail: 'alice@risa.gov.rw',
  fromName: 'Alice',
  toRecipients: [{ email: 'me@risa.gov.rw' }, { email: 'carol@risa.gov.rw', name: 'Carol' }],
  ccRecipients: [{ email: 'dan@risa.gov.rw', name: 'Dan' }],
};

describe('QuickReplyBar mini-composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEditor = null;
  });

  it('shows the reply recipient as a chip after focusing', () => {
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={() => {}} />);
    fireEvent.focus(screen.getByTestId('editor'));
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('Carol')).toBeNull();
  });

  it('switching to Reply all adds the other recipients', () => {
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={() => {}} />);
    fireEvent.focus(screen.getByTestId('editor'));
    fireEvent.click(screen.getByRole('button', { name: /reply all/i }));
    expect(screen.getByText('Carol')).toBeTruthy();
    expect(screen.getByText('Dan')).toBeTruthy();
  });

  it('expand hands the current mode to onExpand', () => {
    const onExpand = vi.fn();
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={onExpand} />);
    fireEvent.focus(screen.getByTestId('editor'));
    fireEvent.click(screen.getByRole('button', { name: /reply all/i }));
    fireEvent.click(screen.getByRole('button', { name: /open full editor/i }));
    expect(onExpand).toHaveBeenCalledWith('', 'replyAll');
  });

  it('expand carries the typed draft HTML', () => {
    mockEditor = {
      isEmpty: false,
      getHTML: () => '<p>draft text</p>',
      isActive: () => false,
      commands: { clearContent: vi.fn() },
      chain: () => ({ focus: () => ({ toggleBold: () => ({ run: vi.fn() }), toggleItalic: () => ({ run: vi.fn() }), toggleBulletList: () => ({ run: vi.fn() }), insertContent: () => ({ run: vi.fn() }) }) }),
    };
    const onExpand = vi.fn();
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={onExpand} />);
    fireEvent.focus(screen.getByTestId('editor'));
    fireEvent.click(screen.getByRole('button', { name: /open full editor/i }));
    expect(onExpand).toHaveBeenCalledWith('<p>draft text</p>', 'reply');
  });
});
