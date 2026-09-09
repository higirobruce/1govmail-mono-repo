import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  EditorContent: () => <div data-testid="editor" />,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/docExport', () => ({ generateDocPdfBlob: vi.fn() }));
vi.mock('./DocPickerDialog', () => ({ DocPickerDialog: () => null }));
vi.mock('@/lib/api', () => ({
  api: {
    settings: { get: vi.fn(async () => ({})) },
    mail: { getTemplates: vi.fn(async () => []) },
  },
}));
vi.mock('@/stores/auth.store', () => {
  const state = {
    user: { email: 'me@risa.gov.rw', displayName: 'Me' },
    isAuthenticated: true,
  };
  return { useAuthStore: (sel?: any) => (sel ? sel(state) : state) };
});

import ComposeModal from './ComposeModal';
import { useAIStore } from '@/stores/ai.store';

function renderCompose() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ComposeModal open mode="new" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAIStore.setState({ enabled: true });
});

describe('ComposeModal on phone widths', () => {
  it('is a full-screen sheet below sm (floating card only from sm up)', () => {
    const { container } = renderCompose();
    const root = container.querySelector('.fixed.z-50') as HTMLElement;
    expect(root.className).toContain('inset-0');
    expect(root.className).toContain('sm:inset-auto');
    expect(root.className).toContain('rounded-none');
    expect(root.className).toContain('sm:rounded-2xl');
  });

  it('hides the From row and the keyboard hint below sm', () => {
    renderCompose();
    const fromRow = screen.getByText('From').parentElement as HTMLElement;
    expect(fromRow.className).toContain('hidden');
    expect(fromRow.className).toContain('sm:flex');
    const hint = screen.getByText(/Enter to send/);
    expect(hint.className).toContain('hidden');
    expect(hint.className).toContain('sm:block');
  });

  it('hides font family/size, colour and strikethrough from the toolbar below sm', () => {
    renderCompose();
    expect((screen.getByTitle('Font family') as HTMLElement).className).toContain('hidden');
    expect((screen.getByTitle('Font size') as HTMLElement).className).toContain('hidden');
    expect((screen.getByTitle('Text colour') as HTMLElement).className).toContain('hidden');
    expect((screen.getByTitle('Strikethrough') as HTMLElement).className).toContain('hidden');
    for (const kept of ['Bold (⌘B)', 'Italic (⌘I)', 'Attach file']) {
      expect((screen.getByTitle(kept) as HTMLElement).className).not.toContain('hidden');
    }
  });

  it('anchors the AI panel as a bottom sheet below sm', () => {
    const { container } = renderCompose();
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside).toBeTruthy();
    expect(aside.className).toContain('inset-x-0');
    expect(aside.className).toContain('bottom-0');
    expect(aside.className).toContain('sm:w-[340px]');
    expect(aside.className).toContain('sm:inset-x-auto');
  });

  it('hides the minimise control below sm', () => {
    renderCompose();
    const minimise = screen.getByTitle('Minimise');
    expect(minimise.className).toContain('hidden');
    expect(minimise.className).toContain('sm:inline-flex');
  });
});
