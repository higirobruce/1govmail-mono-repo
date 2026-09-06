import { beforeEach, describe, expect, it } from 'vitest';
import { usePeopleStore } from './people.store';
import { useAskStore } from './ask.store';

beforeEach(() => {
  usePeopleStore.setState({ open: false, target: null });
  useAskStore.getState().close();
});

describe('people store', () => {
  it('openDossier lowercases the email and opens', () => {
    usePeopleStore.getState().openDossier({ email: 'JD@Gov.RW', name: 'J D' });
    expect(usePeopleStore.getState()).toMatchObject({ open: true, target: { email: 'jd@gov.rw', name: 'J D' } });
  });

  it('openDossier closes the Ask panel (mutual exclusion, dossier side)', () => {
    useAskStore.getState().openAsk();
    usePeopleStore.getState().openDossier({ email: 'a@b.c' });
    expect(useAskStore.getState().open).toBe(false);
  });

  it('close clears the target', () => {
    usePeopleStore.getState().openDossier({ email: 'a@b.c' });
    usePeopleStore.getState().close();
    expect(usePeopleStore.getState()).toMatchObject({ open: false, target: null });
  });
});
