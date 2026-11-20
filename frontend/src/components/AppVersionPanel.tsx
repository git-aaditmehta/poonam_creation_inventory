import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, WifiOff, AlertTriangle } from 'lucide-react';
import { APP_VERSION, applyAppUpdate, checkForUpdate, isUpdateReady, versionLabel, type UpdateCheck } from '../lib/serviceWorker';
import { formatIST } from '../utils/time';

/**
 * App version + "Check for updates" (agreed 2026-11-21). The full card is in Backup & Storage; the compact one is at
 * the bottom of the side menu so staff (who cannot open Backup) can update too.
 */
export const AppVersionPanel: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [ready, setReady] = useState(isUpdateReady());

  useEffect(() => {
    const onReady = () => setReady(true);
    window.addEventListener('app-update-available', onReady);
    return () => window.removeEventListener('app-update-available', onReady);
  }, []);

  const check = async () => {
    setChecking(true);
    setResult(null);
    const r = await checkForUpdate();
    setResult(r);
    if (r.state === 'ready') setReady(true);
    setChecking(false);
  };

  const latestLabel = result && 'latest' in result && result.latest ? versionLabel(result.latest) : null;
  let message: { icon: React.ReactNode; text: string; tone: string } | null = null;
  if (ready) {
    message = {
      icon: <Download size={14} />,
      text: `A new version${latestLabel ? ` (${latestLabel})` : ''} is ready. Tap "Update now" — it takes a few seconds and nothing you saved is lost.`,
      tone: 'var(--teal-deep)',
    };
  } else if (result) {
    switch (result.state) {
      case 'latest':
        message = { icon: <CheckCircle2 size={14} />, text: `You have the latest version (${versionLabel(result.latest)}).`, tone: 'var(--emerald-text)' };
        break;
      case 'downloading':
        message = {
          icon: <Loader2 size={14} className="animate-spin" />,
          text: `Version ${versionLabel(result.latest)} is available and is downloading. Keep the app open — an "Update now" button appears when it is ready (usually under a minute).`,
          tone: 'var(--teal-deep)',
        };
        break;
      case 'offline':
        message = { icon: <WifiOff size={14} />, text: 'You are offline. Connect to the internet to check for updates.', tone: 'var(--amber-text)' };
        break;
      case 'unavailable':
        message = { icon: <AlertTriangle size={14} />, text: 'Updates are checked only in the installed app (not in this test version).', tone: 'var(--text-secondary)' };
        break;
      default:
        message = { icon: <AlertTriangle size={14} />, text: 'Could not check for updates right now. Try again in a minute.', tone: 'var(--amber-text)' };
    }
  }

  if (compact) {
    return (
      <div style={{ margin: '0 12px 8px', fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>App version {versionLabel()}</span>
          {ready ? (
            <button type="button" onClick={applyAppUpdate} style={compactBtn(true)}>Update now</button>
          ) : (
            <button type="button" onClick={check} disabled={checking} style={compactBtn(false)}>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>
        {message && !ready && <div style={{ marginTop: 4, color: 'rgba(255,255,255,0.75)' }}>{message.text}</div>}
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>App version {versionLabel()}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            Commit {APP_VERSION.commit} · built {formatIST(new Date(APP_VERSION.built))}. Every phone and laptop should show the same number.
          </div>
        </div>
        {ready ? (
          <button type="button" className="btn btn-primary" onClick={applyAppUpdate} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Download size={15} /> Update now
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={check} disabled={checking} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>
      {message && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 10, fontSize: 13, color: message.tone }}>
          <span style={{ marginTop: 2, flexShrink: 0 }}>{message.icon}</span>
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
};

function compactBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? '#D4AF37' : 'rgba(255,255,255,0.08)',
    color: primary ? '#000' : 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '3px 8px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}
