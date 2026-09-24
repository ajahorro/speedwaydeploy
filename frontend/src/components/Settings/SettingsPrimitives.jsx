import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * SHARED SETTINGS PRIMITIVES — the flat, line-divided look used by every
 * Settings screen (Admin / Staff / Customer).
 *
 * STYLE CONTRACT (mirrors the directive's Tailwind spec, expressed with the
 * app's CSS-variable tokens so it works in both themes and matches the rest of
 * the shell):
 *   - NO nested background cards. Sections are just headers + rows separated by
 *     hairline dividers.
 *   - Section header: small, subtle, uppercase, muted, tracked.
 *   - Row: title (bold, primary) on top, subtitle (muted) below, control on the
 *     far right.
 *
 * Any settings screen that composes these is visually consistent by construction.
 */

/* ── Section header ─────────────────────── */
export const SettingsSection = ({ title, description, children, style }) => (
  <section style={{ display: 'flex', flexDirection: 'column', ...style }}>
    <div
      style={{
        fontSize: '0.7rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.09em',
        color: 'var(--admin-text-secondary)',
        marginTop: '2rem',
        marginBottom: '0.5rem',
      }}
    >
      {title}
    </div>
    {description && (
      <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', fontWeight: 500, color: 'var(--admin-text-secondary)', opacity: 0.85, lineHeight: 1.5 }}>
        {description}
      </p>
    )}
    <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
  </section>
);

/* ── A single line-divided row ──────────────────────────── */
export const SettingRow = ({ title, subtitle, children, onClick, align = 'center' }) => {
  const interactive = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: align === 'start' ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '1rem 0',
        borderBottom: '1px solid var(--admin-border)',
        cursor: interactive ? 'pointer' : 'default',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)' }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--admin-text-secondary)', marginTop: '0.2rem', maxWidth: '60ch', lineHeight: 1.5 }}>
            {subtitle}
          </div>
        )}
      </div>
      {children != null && <div style={{ flexShrink: 0, marginLeft: 'auto' }}>{children}</div>}
    </div>
  );
};

/* ── Toggle switch ──────────────────────── */
export const ToggleSwitch = ({ checked, onChange, disabled = false, loading = false, label }) => (
  <div
    role="switch"
    aria-checked={Boolean(checked)}
    aria-label={label}
    tabIndex={disabled ? -1 : 0}
    onClick={() => !disabled && !loading && onChange?.(!checked)}
    onKeyDown={(e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !disabled && !loading) {
        e.preventDefault();
        onChange?.(!checked);
      }
    }}
    style={{
      position: 'relative',
      width: '50px',
      height: '26px',
      flexShrink: 0,
      background: checked ? 'var(--admin-brand)' : 'var(--admin-border)',
      borderRadius: '25px',
      cursor: disabled || loading ? 'default' : 'pointer',
      padding: '4px',
      transition: 'background 0.3s ease',
      opacity: disabled || loading ? 0.6 : 1,
    }}
  >
    <div
      style={{
        width: '18px',
        height: '18px',
        background: 'white',
        borderRadius: '50%',
        position: 'absolute',
        top: '4px',
        left: checked ? 'calc(100% - 22px)' : '4px',
        transition: 'left 0.3s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {loading && <Loader2 size={12} className="animate-spin" color="var(--admin-brand)" />}
    </div>
  </div>
);

/* ── Segmented selector ─────────────────── */
export const SegmentedControl = ({ options, value, onChange, ariaLabel, disabled = false }) => (
  <div
    role="radiogroup"
    aria-label={ariaLabel}
    style={{
      display: 'flex',
      gap: '0.25rem',
      padding: '0.25rem',
      background: 'var(--admin-input-bg)',
      border: '1px solid var(--admin-border)',
      borderRadius: '9px',
      flexWrap: 'wrap',
      maxWidth: '100%',
    }}
  >
    {options.map(({ value: optValue, label, icon: Icon }) => {
      const isActive = optValue === value;
      return (
        <button
          key={optValue}
          type="button"
          role="radio"
          aria-checked={isActive}
          disabled={disabled}
          onClick={() => !disabled && onChange?.(optValue)}
          style={{
            minHeight: '36px',
            padding: '0.5rem 0.8rem',
            background: isActive ? 'var(--admin-brand)' : 'transparent',
            border: `1px solid ${isActive ? 'var(--admin-brand)' : 'transparent'}`,
            borderRadius: '7px',
            color: isActive ? '#fff' : 'var(--admin-text-secondary)',
            fontWeight: 700,
            fontSize: '0.68rem',
            cursor: disabled ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.35rem',
            textTransform: 'uppercase',
            letterSpacing: '0.03em',
            whiteSpace: 'nowrap',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          {Icon && <Icon size={14} />}
          {label}
        </button>
      );
    })}
  </div>
);

/* ── Inline action button (right-aligned row controls) ──────────────────── */
export const SettingButton = ({ children, onClick, variant = 'default', disabled = false, type = 'button' }) => {
  const danger = variant === 'danger';
  const primary = variant === 'primary';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        padding: '0.55rem 1rem',
        background: primary ? 'var(--admin-brand)' : 'transparent',
        border: `1px solid ${danger ? 'rgba(239, 68, 68, 0.3)' : primary ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
        borderRadius: '8px',
        color: danger ? 'var(--status-danger)' : primary ? '#fff' : 'var(--admin-text-primary)',
        fontWeight: 700,
        fontSize: '0.7rem',
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
};

/* ── Read-only tag (e.g. designation, version) ──────────────────────────── */
export const SettingTag = ({ children, tone = 'neutral' }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.35rem',
      padding: '0.35rem 0.7rem',
      borderRadius: '6px',
      fontSize: '0.7rem',
      fontWeight: 800,
      letterSpacing: '0.03em',
      textTransform: 'uppercase',
      background: tone === 'brand' ? 'rgba(var(--admin-brand-rgb), 0.12)' : 'var(--admin-input-bg)',
      color: tone === 'brand' ? 'var(--admin-brand)' : 'var(--admin-text-secondary)',
      border: '1px solid var(--admin-border)',
    }}
  >
    {children}
  </span>
);

/* ── Small text field used in the staff profile section ─────────────────── */
export const SettingField = ({ value, onChange, placeholder, type = 'text', readOnly = false }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange?.(e.target.value)}
    placeholder={placeholder}
    readOnly={readOnly}
    style={{
      width: 'min(100%, 320px)',
      padding: '0.6rem 0.85rem',
      background: readOnly ? 'transparent' : 'var(--admin-input-bg)',
      border: '1px solid var(--admin-border)',
      borderRadius: '8px',
      color: readOnly ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)',
      fontSize: '0.85rem',
      fontWeight: 600,
      outline: 'none',
      textAlign: 'right',
    }}
  />
);