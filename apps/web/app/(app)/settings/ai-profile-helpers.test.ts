import { describe, it, expect } from 'vitest';
import { normalizeProfileDraft, mergeSuggestions, type AiProfileDraft } from './ai-profile-helpers';

function draft(overrides: Partial<AiProfileDraft> = {}): AiProfileDraft {
  return {
    jobTitle: '',
    institution: '',
    department: '',
    language: '',
    instructions: '',
    ...overrides,
  };
}

describe('normalizeProfileDraft', () => {
  it('trims whitespace from every field', () => {
    const result = normalizeProfileDraft(draft({
      jobTitle: '  Registrar  ',
      institution: '  MINEDUC  ',
      department: '  IT  ',
      language: ' en ',
      instructions: '  Be concise.  ',
    }));
    expect(result).toEqual({
      jobTitle: 'Registrar',
      institution: 'MINEDUC',
      department: 'IT',
      language: 'en',
      instructions: 'Be concise.',
    });
  });

  it('caps jobTitle/institution/department at 80 chars', () => {
    const long = 'x'.repeat(120);
    const result = normalizeProfileDraft(draft({ jobTitle: long, institution: long, department: long }));
    expect(result.jobTitle.length).toBe(80);
    expect(result.institution.length).toBe(80);
    expect(result.department.length).toBe(80);
  });

  it('caps instructions at CUSTOM_INSTRUCTIONS_MAX_CHARS (500)', () => {
    const long = 'y'.repeat(600);
    const result = normalizeProfileDraft(draft({ instructions: long }));
    expect(result.instructions.length).toBe(500);
  });

  it('preserves empty strings so PATCH can clear a field', () => {
    const result = normalizeProfileDraft(draft());
    expect(result).toEqual({
      jobTitle: '',
      institution: '',
      department: '',
      language: '',
      instructions: '',
    });
  });

  it('trims a whitespace-only field down to empty string, not a blank string', () => {
    const result = normalizeProfileDraft(draft({ jobTitle: '   ' }));
    expect(result.jobTitle).toBe('');
  });
});

describe('mergeSuggestions', () => {
  it('fills a blank field from the suggestion', () => {
    const result = mergeSuggestions(draft(), {
      displayName: 'Jane Doe',
      jobTitle: 'Data Analyst',
      institution: 'RISA',
      department: 'ICT',
    });
    expect(result.jobTitle).toBe('Data Analyst');
    expect(result.institution).toBe('RISA');
    expect(result.department).toBe('ICT');
  });

  it('never overwrites a field the user already filled in, even when the suggestion differs', () => {
    const current = draft({ jobTitle: 'Senior Registrar' });
    const result = mergeSuggestions(current, {
      displayName: null,
      jobTitle: 'Data Analyst',
      institution: null,
      department: null,
    });
    expect(result.jobTitle).toBe('Senior Registrar');
  });

  it('leaves a blank field blank when the suggestion is null', () => {
    const result = mergeSuggestions(draft(), {
      displayName: null,
      jobTitle: null,
      institution: null,
      department: null,
    });
    expect(result.jobTitle).toBe('');
    expect(result.institution).toBe('');
    expect(result.department).toBe('');
  });

  it('treats a whitespace-only current field as blank and fills it', () => {
    const current = draft({ department: '   ' });
    const result = mergeSuggestions(current, {
      displayName: null,
      jobTitle: null,
      institution: null,
      department: 'Finance',
    });
    expect(result.department).toBe('Finance');
  });

  it('does not touch language or instructions (suggestions carry no such fields)', () => {
    const current = draft({ language: 'fr', instructions: 'Keep it short.' });
    const result = mergeSuggestions(current, {
      displayName: null, jobTitle: 'X', institution: null, department: null,
    });
    expect(result.language).toBe('fr');
    expect(result.instructions).toBe('Keep it short.');
  });
});
