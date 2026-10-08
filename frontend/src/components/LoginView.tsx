import React, { useState } from 'react';
import { Shield, Sparkles, KeyRound, User as UserIcon, Loader2, ArrowRight } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';
import { useToast } from '../context/ToastContext';

interface LoginViewProps {
  onLoginSuccess: (user: User) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const { showToast } = useToast();
  const [identifier, setIdentifier] = useState('nimrocks@gmail.com');
  const [password, setPassword] = useState('admin123456');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setErrorMessage('Please enter both your identifier and password');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await api.auth.login(identifier.trim(), password);
      showToast('success', 'Welcome back', `Signed in as ${res.user.role === 'owner' ? 'Owner' : 'Staff'}`);
      onLoginSuccess(res.user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Login failed. Please verify credentials.');
      showToast('error', 'Login Failed', err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const setPreset = (emailOrUser: string, pass: string) => {
    setIdentifier(emailOrUser);
    setPassword(pass);
    setErrorMessage(null);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(ellipse at 50% 20%, #1a1e2b 0%, #0b0d11 70%)',
        padding: '24px 16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '440px',
          background: 'var(--bg-surface-1)',
          border: '1px solid var(--border-medium)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Header Banner */}
        <div
          style={{
            padding: '36px 32px 24px',
            textAlign: 'center',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'linear-gradient(180deg, rgba(212, 163, 89, 0.08) 0%, transparent 100%)',
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: 'linear-gradient(135deg, #d4a359 0%, #b8863d 100%)',
              color: '#0b0d11',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              boxShadow: '0 4px 20px rgba(212, 163, 89, 0.4)',
            }}
          >
            <Sparkles size={28} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
            Poonam Creation
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
            Inventory Atelier & Manufacturing Management
          </p>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} style={{ padding: '32px' }}>
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
                placeholder="nimrocks@gmail.com"
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
              <input
                id="login-password"
                type="password"
                className="input"
                style={{ paddingLeft: 38 }}
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
            style={{ width: '100%', marginTop: 12, padding: '12px', fontSize: 14 }}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Signing In...
              </>
            ) : (
              <>
                Sign In to Atelier <ArrowRight size={16} />
              </>
            )}
          </button>

          {/* Quick Credential Switcher for Development */}
          <div
            style={{
              marginTop: 28,
              paddingTop: 20,
              borderTop: '1px solid var(--border-subtle)',
              textAlign: 'center',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Quick Credentials
            </span>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1, fontSize: 12, padding: '7px 10px' }}
                onClick={() => setPreset('nimrocks@gmail.com', 'admin123456')}
              >
                👑 Owner Account
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1, fontSize: 12, padding: '7px 10px' }}
                onClick={() => setPreset('staff1', 'staff123')}
              >
                👷 Staff Account
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
