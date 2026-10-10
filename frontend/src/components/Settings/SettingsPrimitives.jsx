import React from 'react';
import { Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

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

/* ── Toggle switch (shadcn Switch; same props as before) ──────────────────────── */
export const ToggleSwitch = ({ checked, onChange, disabled = false, loading = false, label }) => (
  <span className="inline-flex items-center gap-2">
    {loading && <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden="true" />}
    <Switch
      checked={Boolean(checked)}
      disabled={disabled || loading}
      aria-label={label}
      onCheckedChange={(next) => onChange?.(next)}
    />
  </span>
);

/* ── Segmented selector ─────────────────── */
export const SegmentedControl = ({ options, value, onChange, ariaLabel, disabled = false }) => (
  <div role="radiogroup" aria-label={ariaLabel} className="flex max-w-full flex-wrap gap-1 rounded-md border bg-muted/40 p-1">
    {options.map(({ value: optValue, label, icon: Icon }) => {
      const isActive = optValue === value;
      return (
        <Button
          key={optValue}
          type="button"
          role="radio"
          aria-checked={isActive}
          variant={isActive ? 'default' : 'ghost'}
          size="sm"
          disabled={disabled}
          onClick={() => !disabled && onChange?.(optValue)}
          className="min-h-9 text-xs uppercase tracking-wide"
        >
          {Icon && <Icon size={14} />}
          {label}
        </Button>
      );
    })}
  </div>
);

/* ── Inline action button (right-aligned row controls) ──────────────────── */
export const SettingButton = ({ children, onClick, variant = 'default', disabled = false, type = 'button' }) => (
  <Button
    type={type}
    onClick={onClick}
    disabled={disabled}
    variant={variant === 'primary' ? 'default' : 'outline'}
    className={`min-h-10 text-xs uppercase tracking-wide ${variant === 'danger' ? 'border-destructive/40 text-destructive hover:text-destructive' : ''}`}
  >
    {children}
  </Button>
);

/* ── Read-only tag (e.g. designation, version) ──────────────────────────── */
export const SettingTag = ({ children, tone = 'neutral' }) => (
  <Badge variant={tone === 'brand' ? 'default' : 'outline'} className={`gap-1.5 uppercase ${tone === 'brand' ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
    {children}
  </Badge>
);

/* ── Small text field used in the staff profile section ─────────────────── */
export const SettingField = ({ value, onChange, placeholder, type = 'text', readOnly = false }) => (
  <Input
    type={type}
    value={value}
    onChange={(e) => onChange?.(e.target.value)}
    placeholder={placeholder}
    readOnly={readOnly}
    className={`w-[min(100%,320px)] text-right ${readOnly ? 'border-transparent bg-transparent text-muted-foreground shadow-none' : ''}`}
  />
);
