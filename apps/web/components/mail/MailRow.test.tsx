import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MailRow } from './MailList';

const base = {
  id: 'm1',
  subject: 'Budget review Q3',
  snippet: 'Please find attached…',
  fromName: 'Alice Umutoni',
  fromEmail: 'alice@risa.gov.rw',
  isStarred: false,
  hasAttachments: false,
  tags: [],
  receivedAt: new Date().toISOString(),
};

function renderRow(isRead: boolean) {
  return render(
    <MailRow
      message={{ ...base, isRead }}
      active={false}
      onClick={() => {}}
      onContextMenu={() => {}}
    />,
  );
}

describe('MailRow read/unread differentiation', () => {
  it('unread: sender and subject are semibold, row has no read tint', () => {
    const { container } = renderRow(false);
    const sender = screen.getByText('Alice Umutoni');
    const subject = screen.getByText('Budget review Q3');
    expect(sender.className).toContain('font-semibold');
    expect(subject.className).toContain('font-semibold');
    expect(container.querySelector('[data-read="true"]')).toBeNull();
  });

  it('read: sender and subject drop to regular weight and the row is tinted', () => {
    const { container } = renderRow(true);
    const sender = screen.getByText('Alice Umutoni');
    const subject = screen.getByText('Budget review Q3');
    expect(sender.className).not.toContain('font-semibold');
    expect(subject.className).not.toContain('font-semibold');
    expect(subject.className).toContain('font-normal');
    const row = container.querySelector('[data-read="true"]');
    expect(row).toBeTruthy();
    expect((row as HTMLElement).className).toContain('bg-muted');
  });
});
