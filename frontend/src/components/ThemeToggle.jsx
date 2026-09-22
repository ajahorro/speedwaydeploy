import React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

/**
 * Section 1.3 — Shared tri-state theme selector.
 *
 * Exposes Light / Dark / System Default, backed by useTheme() (ThemeContext),
 * which persists the choice to localStorage and applies it at the document level.
 * Used by the Staff header and the Staff settings page so both mirror the Admin
 * surface. Two visual variants are provided:
 *   - "segmented" (default): a radiogroup of three labelled buttons.
 *   - "icon": a single compact button for tight toolbars (header).
 */
const OPTIONS = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export const ThemeToggle = ({ variant = 'segmented', label = 'Interface theme' }) => {
  const { theme, toggleTheme } = useTheme();

  if (variant === 'icon') {
    // Compact header control: cycles System -> Light -> Dark -> System.
    const order = ['system', 'light', 'dark'];
    const currentIndex = order.indexOf(theme);
    const next = order[(currentIndex + 1) % order.length];
    const active = OPTIONS.find((o) => o.value === theme) || OPTIONS[0];
    const Icon = active.icon;
    return (
      <button
        type="button"
        onClick={() => toggleTheme(next)}
        title={`Theme: ${active.label} (click for ${next})`}
        aria-label={`Interface theme: ${active.label}. Switch to ${next}.`}
        style={{
          background: 'var(--admin-card)',
          border: '1px solid var(--admin-border)',
          color: 'var(--admin-text-secondary)',
          padding: '0.5rem',
          borderRadius: 'var(--admin-radius, 4px)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={18} />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(92px, 1fr))', width: 'min(100%, 390px)', gap: '0.35rem', padding: '0.35rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '10px' }}
    >
      {OPTIONS.map(({ value, label: optionLabel, icon: Icon }) => {
        const isActive = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => toggleTheme(value)}
            style={{
              minHeight: '44px',
              padding: '0.65rem 0.5rem',
              background: isActive ? 'var(--admin-brand)' : 'transparent',
              border: `1px solid ${isActive ? 'var(--admin-brand)' : 'transparent'}`,
              borderRadius: '7px',
              color: isActive ? 'var(--admin-text-on-brand)' : 'var(--admin-text-secondary)',
              fontWeight: '900',
              fontSize: '0.7rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.35rem',
              textTransform: 'uppercase',
            }}
          >
            <Icon size={15} />
            {optionLabel}
          </button>
        );
      })}
    </div>
  );
};

export default ThemeToggle;
