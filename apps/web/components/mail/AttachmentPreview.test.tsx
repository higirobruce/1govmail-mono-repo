import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { AttachmentPreview } from './AttachmentPreview';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetchText(text: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: () => Promise.resolve(text) }));
}

describe('AttachmentPreview', () => {
  it('renders an <img> for image attachments', () => {
    render(<AttachmentPreview url="blob:x" mimeType="image/png" filename="photo.png" />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'blob:x');
    expect(img).toHaveAttribute('alt', 'photo.png');
  });

  it('renders fetched text for text attachments', async () => {
    stubFetchText('hello world');
    render(<AttachmentPreview url="blob:t" mimeType="text/plain" filename="notes.txt" />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeInTheDocument());
  });

  it('renders a table with header and body rows for CSV attachments', async () => {
    stubFetchText('name,age\nAnn,31');
    render(<AttachmentPreview url="blob:c" mimeType="text/csv" filename="data.csv" />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ann' })).toBeInTheDocument();
  });

  it('shows the failure message when a text fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('gone')));
    render(<AttachmentPreview url="blob:t" mimeType="text/plain" filename="notes.txt" />);
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it('renders native players for video and audio', () => {
    const { container, rerender } = render(
      <AttachmentPreview url="blob:v" mimeType="video/mp4" filename="clip.mp4" />,
    );
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', 'blob:v');
    rerender(<AttachmentPreview url="blob:a" mimeType="audio/mpeg" filename="song.mp3" />);
    expect(container.querySelector('audio[controls]')).toHaveAttribute('src', 'blob:a');
  });

  it('renders PDFs in an <iframe> — <embed> is dead under the app CSP (object-src none)', () => {
    const { container } = render(
      <AttachmentPreview url="blob:p" mimeType="application/pdf" filename="doc.pdf" />,
    );
    expect(container.querySelector('embed')).toBeNull();
    const frame = container.querySelector('iframe');
    expect(frame).toHaveAttribute('src', 'blob:p');
    expect(frame).toHaveAttribute('title', 'doc.pdf');
    // Chrome's PDF viewer refuses fully-sandboxed frames — must stay unsandboxed.
    expect(frame).not.toHaveAttribute('sandbox');
  });

  it('offers download instead of blind-embedding types with no inline preview', () => {
    const { container } = render(
      <AttachmentPreview url="blob:z" mimeType="application/zip" filename="archive.zip" />,
    );
    expect(container.querySelector('embed')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/no inline preview/i)).toBeInTheDocument();
  });
});
