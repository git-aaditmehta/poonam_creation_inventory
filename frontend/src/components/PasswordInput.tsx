import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Password box with a show/hide button at the end (requested 2026-11-20). Hidden by default; the button switches
 * between showing and hiding what was typed. Used for every password field in the app.
 */
type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { leftPadding?: number };

export const PasswordInput: React.FC<Props> = ({ style, leftPadding, ...rest }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        {...rest}
        type={visible ? 'text' : 'password'}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{ ...style, ...(leftPadding ? { paddingLeft: leftPadding } : {}), paddingRight: 42 }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 34,
          height: 34,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-muted)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
};
