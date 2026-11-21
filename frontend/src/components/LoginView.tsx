import React, { useState } from 'react';
import { Shield, Sparkles, KeyRound, User as UserIcon, Loader2, ArrowRight } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';
import { useToast } from '../context/ToastContext';
import { errorText } from '../utils/friendlyErrors';
import { PasswordInput } from './PasswordInput';
import { loadLastUsername, saveLastUsername } from '../lib/lastUser';

interface LoginViewProps {
  onLoginSuccess: (user: User) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const { showToast } = useToast();
  // Never a built-in account: only the username last used on THIS device (no password is ever filled in)
  const [identifier, setIdentifier] = useState(() => loadLastUsername());
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setErrorMessage('Please enter your username (or email) and your password.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await api.auth.login(identifier.trim(), password);
      saveLastUsername(identifier.trim());
      showToast('success', 'Welcome back', `Signed in as ${res.user.role === 'owner' ? 'Owner' : 'Staff'}`);
      onLoginSuccess(res.user);
    } catch (err: any) {
      // On the login screen a 401 means "wrong username or password", not "login expired"
      const msg = err?.status === 401
        ? 'Wrong username or password. Please check and try again.'
        : err?.status === 429
          ? err.message || 'Too many attempts. Please wait a few minutes and try again.'
          : errorText(err);
      setErrorMessage(msg);
      showToast('error', 'Sign-in failed', msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base)',
        padding: '24px 16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          background: 'var(--bg-surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '40px 32px 28px',
            textAlign: 'center',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 14,
              background: 'var(--teal-deep)',
              color: 'var(--text-inverse)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 18px',
              boxShadow: '0 4px 16px rgba(27, 58, 75, 0.25)',
            }}
          >
            <Sparkles size={24} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            Poonam Creation
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Inventory Management System
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '28px 32px' }}>
          {errorMessage && (
            <div
              style={{
                background: 'var(--rose-bg)',
                border: '1px solid var(--rose-border)',
                color: 'var(--rose-text)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                fontSize: 13,
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Shield size={16} />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="login-identifier">
              Email or Username
            </label>
            <div style={{ position: 'relative' }}>
              <UserIcon
                size={16}
                color="var(--text-muted)"
                style={{ position: 'absolute', left: 12, top: 12 }}
              />
              <input
                id="login-identifier"
                type="text"
                className="input"
                style={{ paddingLeft: 38 }}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Email or username"
                required
                autoComplete="username"
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="login-password">
              Password
            </label>
            <div style={{ position: 'relative' }}>
              <KeyRound
                size={16}
                color="var(--text-muted)"
                style={{ position: 'absolute', left: 12, top: 12 }}
              />
              <PasswordInput
                id="login-password"
                className="input"
                leftPadding={38}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading}
            style={{ width: '100%', marginTop: 12, padding: '11px', fontSize: 14 }}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Signing In...
              </>
            ) : (
              <>
                Sign In <ArrowRight size={16} />
              </>
            )}
          </button>

        </form>
      </div>
    </div>
  );
};
