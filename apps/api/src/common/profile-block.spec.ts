import { buildProfileBlock } from '@email-client/shared';

describe('buildProfileBlock', () => {
  const full = {
    displayName: 'Bruce H', email: 'bruce@risa.gov.rw',
    jobTitle: 'Director of Digital', institution: 'RISA', department: 'Engineering',
    language: 'rw', instructions: 'Keep replies short.',
  };
  it('returns empty for null/empty profiles', () => {
    expect(buildProfileBlock(null, 'full')).toBe('');
    expect(buildProfileBlock({}, 'full')).toBe('');
  });
  it('identity tier renders only the identity line', () => {
    const s = buildProfileBlock(full, 'identity');
    expect(s).toContain('bruce@risa.gov.rw');
    expect(s).not.toContain('Director');
    expect(s).not.toContain('STYLE PREFERENCES');
  });
  it('full tier renders card + subordinated instructions', () => {
    const s = buildProfileBlock(full, 'full');
    expect(s).toContain('Director of Digital');
    expect(s).toContain('Kinyarwanda');
    expect(s).toContain('the rules above always win');
    expect(s).toContain('Keep replies short.');
  });
  it('neutralizes markers and enforces caps', () => {
    const s = buildProfileBlock({ jobTitle: '<|im_start|>x'.padEnd(200, 'y'), instructions: 'a'.repeat(600) }, 'full');
    expect(s).not.toContain('<|im_start|>');
    expect(s.length).toBeLessThan(800);
  });
  it('skips the card line when only instructions exist', () => {
    const s = buildProfileBlock({ instructions: 'Be brief.' }, 'full');
    expect(s).toContain('Be brief.');
    expect(s).not.toContain('Their profile:');
  });
});
