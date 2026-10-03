import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './page';
import { useAuthStore } from '@/stores/auth.store';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

/** The login form's two controls, by their accessible labels. */
const emailField = () => screen.getByLabelText('Email') as HTMLInputElement;
const passwordField = () => screen.getByLabelText('Password') as HTMLInputElement;

function fillCredentials(email = 'xyz@risa.gov.rw', password = 'pw') {
  fireEvent.change(emailField(), { target: { value: email } });
  fireEvent.change(passwordField(), { target: { value: password } });
}

describe('LoginPage', () => {
  let login: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replace.mockClear();
    login = vi.fn(async () => undefined);
    useAuthStore.setState({ login });
  });

  describe('institution', () => {
    it('asks for no institution — there is no picker to wait on or choose from', () => {
      render(<LoginPage />);
      expect(screen.queryByRole('combobox')).toBeNull();
      // No labelled institution control. (The footer copy still mentions "your
      // institution's mail server", which is fine — it is prose, not a field.)
      expect(screen.queryByLabelText(/institution/i)).toBeNull();
      expect(document.getElementById('institution')).toBeNull();
    });

    it('signs in with just the address and password, letting the server derive the institution', async () => {
      render(<LoginPage />);
      fillCredentials('ajs@minaffet.gov.rw', 'secret');
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(login).toHaveBeenCalled());
      expect(login.mock.calls[0]).toEqual(['ajs@minaffet.gov.rw', 'secret']);
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/mail'));
    });

    it('can be submitted the moment the form renders, with nothing to load first', () => {
      render(<LoginPage />);
      expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
    });
  });

  describe('password visibility', () => {
    it('masks the password until the user asks to see it', () => {
      render(<LoginPage />);
      expect(passwordField().type).toBe('password');

      fireEvent.click(screen.getByRole('button', { name: /show password/i }));
      expect(passwordField().type).toBe('text');

      fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
      expect(passwordField().type).toBe('password');
    });

    it('keeps what was already typed when visibility flips', () => {
      render(<LoginPage />);
      fireEvent.change(passwordField(), { target: { value: 'my-secret' } });
      fireEvent.click(screen.getByRole('button', { name: /show password/i }));
      expect(passwordField().value).toBe('my-secret');
    });

    it('does not submit the form — the eye is a toggle, not a second submit', () => {
      render(<LoginPage />);
      fillCredentials();
      fireEvent.click(screen.getByRole('button', { name: /show password/i }));
      expect(login).not.toHaveBeenCalled();
    });
  });

  it('surfaces the server message when the address domain is not registered', async () => {
    login.mockRejectedValue(new Error("minagri.gov.rw isn't set up on 1Gov Mail yet — contact your IT administrator."));
    render(<LoginPage />);
    fillCredentials('joe@minagri.gov.rw', 'pw');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/minagri\.gov\.rw isn't set up/i)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
