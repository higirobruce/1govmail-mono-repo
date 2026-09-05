import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MailAvatar, getInitials } from './MailAvatar';

describe('getInitials', () => {
  it('uses first + last name initials', () => {
    expect(getInitials('Ronald Richards', 'r@x.rw')).toBe('RR');
  });
  it('uses first two letters of a single name', () => {
    expect(getInitials('Ronald', 'r@x.rw')).toBe('RO');
  });
  it('falls back to the email local part', () => {
    expect(getInitials(null, 'bruce.higiro@risa.gov.rw')).toBe('BR');
  });
});

describe('MailAvatar', () => {
  it('renders neutral initials for a person', () => {
    const { container } = render(<MailAvatar name="Jane Doe" email="jane@x.rw" />);
    expect(container.textContent).toBe('JD');
  });
  it('renders a mail glyph for system senders', () => {
    const { container } = render(<MailAvatar email="noreply@x.rw" />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.textContent).toBe('');
  });
});
