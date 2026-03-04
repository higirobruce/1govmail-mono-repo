'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Mail, Lock, Building2, ShieldCheck } from 'lucide-react';

// ── Institution registry ───────────────────────────────────────────────────────
// Add new institutions here — they will appear in the sign-in dropdown.
const INSTITUTIONS = [
  { label: 'RISA', host: 'mail.risa.gov.rw:8443' },
  { label: 'MINICT', host: 'mail.minict.gov.rw' },
];

export default function LoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const twoFactor = useAuthStore((s) => s.twoFactor);

  // ── Credentials step ──────────────────────────────────────────────────────
  const [form, setForm] = useState({
    email: '',
    password: '',
    zimbraHost: INSTITUTIONS[0].host,
  });

  // ── 2FA step ──────────────────────────────────────────────────────────────
  const [twoFactorToken, setTwoFactorToken] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Step 1: credentials ───────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await login(form.email, form.password, form.zimbraHost);
      if (result?.requiresTwoFactor) {
        // Transition to OTP step — store the challenge token in local state
        setTwoFactorToken(result.twoFactorToken);
      } else {
        router.replace('/mail');
      }
    } catch (err: any) {
      setError(err.message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: TOTP code ─────────────────────────────────────────────────────
  const handleTwoFactor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactorToken) return;
    setError(null);
    setLoading(true);
    try {
      await twoFactor(twoFactorToken, otpCode.trim());
      router.replace('/mail');
    } catch (err: any) {
      setError(err.message ?? '2FA verification failed');
      setOtpCode('');
    } finally {
      setLoading(false);
    }
  };

  const isTwoFactorStep = twoFactorToken !== null;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute top-1/4 left-1/3 w-[300px] h-[300px] rounded-full bg-primary/3 blur-2xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-12 h-12 rounded-2xl bg-primary/15 border border-primary/20 flex items-center justify-center mb-4">
            {isTwoFactorStep
              ? <ShieldCheck className="w-6 h-6 text-primary" />
              : <Mail className="w-6 h-6 text-primary" />
            }
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            1Gov Mail
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isTwoFactorStep
              ? 'Enter your authenticator code'
              : 'Sign in to your Zimbra account'}
          </p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl shadow-black/40">

          {/* ── 2FA step ── */}
          {isTwoFactorStep ? (
            <form onSubmit={handleTwoFactor} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="otp" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Authenticator Code
                </Label>
                <div className="relative">
                  <ShieldCheck className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                  <Input
                    id="otp"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="123456"
                    className="pl-10 bg-muted/50 border-border/60 focus-visible:border-primary/60 focus-visible:ring-primary/20 tracking-[0.3em] text-center text-lg"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                    required
                    disabled={loading}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Open your Authenticator app and enter the 6-digit code for{' '}
                  <span className="text-foreground font-medium">{form.email}</span>.
                </p>
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-medium h-10 rounded-lg transition-all duration-150"
                disabled={loading || otpCode.length < 6}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  'Verify'
                )}
              </Button>

              <button
                type="button"
                onClick={() => { setTwoFactorToken(null); setError(null); setOtpCode(''); }}
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Back to sign in
              </button>
            </form>

          ) : (

            /* ── Credentials step ── */
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Institution */}
              <div className="space-y-1.5">
                <Label htmlFor="institution" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Institution
                </Label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none z-10" />
                  <select
                    id="institution"
                    className="flex h-10 w-full rounded-md border border-border/60 bg-muted/50 pl-10 pr-4 py-2 text-sm text-foreground focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
                    value={form.zimbraHost}
                    onChange={(e) => setForm((f) => ({ ...f, zimbraHost: e.target.value }))}
                    required
                    disabled={loading}
                  >
                    {INSTITUTIONS.map((inst) => (
                      <option key={inst.host} value={inst.host}>
                        {inst.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Email */}
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Email
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@company.com"
                    className="pl-10 bg-muted/50 border-border/60 focus-visible:border-primary/60 focus-visible:ring-primary/20"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    required
                    disabled={loading}
                  />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    className="pl-10 bg-muted/50 border-border/60 focus-visible:border-primary/60 focus-visible:ring-primary/20"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    required
                    disabled={loading}
                  />
                </div>
              </div>

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-medium h-10 rounded-lg transition-all duration-150"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  'Sign in'
                )}
              </Button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground/50 mt-6">
          Your credentials are used only to authenticate with your Zimbra server.
        </p>

        <p className="text-center text-[11px] text-muted-foreground/30 mt-3 tracking-wide">
          Powered by{' '}
          <span className="font-semibold tracking-wider text-muted-foreground/45">RISA</span>
        </p>
      </div>
    </div>
  );
}
