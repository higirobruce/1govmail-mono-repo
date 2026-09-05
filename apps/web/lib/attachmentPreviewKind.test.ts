import { describe, it, expect } from 'vitest';
import { getPreviewKind, parseCsv } from './attachmentPreviewKind';

describe('getPreviewKind', () => {
  it('classifies by mime type', () => {
    expect(getPreviewKind('image/png', 'photo.png')).toBe('image');
    expect(getPreviewKind('application/pdf', 'doc.pdf')).toBe('pdf');
    expect(getPreviewKind('text/csv', 'data.csv')).toBe('csv');
    expect(getPreviewKind('text/plain', 'notes.txt')).toBe('text');
    expect(getPreviewKind('video/mp4', 'clip.mp4')).toBe('video');
    expect(getPreviewKind('audio/mpeg', 'song.mp3')).toBe('audio');
  });

  it('falls back to the file extension when the mime type is generic', () => {
    expect(getPreviewKind('application/octet-stream', 'report.pdf')).toBe('pdf');
    expect(getPreviewKind('application/octet-stream', 'data.CSV')).toBe('csv');
    expect(getPreviewKind('application/octet-stream', 'clip.mov')).toBe('video');
    expect(getPreviewKind('application/octet-stream', 'voice.m4a')).toBe('audio');
  });

  it('prefers csv over the generic text bucket for text/csv', () => {
    expect(getPreviewKind('text/csv', 'x.csv')).toBe('csv');
  });

  it('is case-insensitive on mime types', () => {
    expect(getPreviewKind('IMAGE/PNG', 'x.png')).toBe('image');
  });

  it('returns null for types with no inline preview', () => {
    expect(getPreviewKind('application/zip', 'archive.zip')).toBeNull();
    expect(getPreviewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x.docx')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('splits lines and comma cells, stripping wrapping quotes and whitespace', () => {
    expect(parseCsv('name,age\n"Ann", 31\nBob,42\n')).toEqual([
      ['name', 'age'],
      ['Ann', '31'],
      ['Bob', '42'],
    ]);
  });

  it('returns an empty array for blank content', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('  \n ')).toEqual([]);
  });
});
