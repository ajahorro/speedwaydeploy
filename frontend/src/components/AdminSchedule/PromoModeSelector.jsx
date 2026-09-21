import React from 'react';
import { Tag, Package } from 'lucide-react';
import { PROMO_MODE } from '../../domain/promo/promoTypes';
import { promoFieldTokens as T } from './promoFormTokens';

/**
 * PromoModeSelector
 * Top-level segmented switch: Standard Promo vs Package Promo.
 */
const PromoModeSelector = ({ mode, onChange, disabled = false }) => {
  const options = [
    { value: PROMO_MODE.STANDARD, label: 'Standard Promo', icon: Tag },
    { value: PROMO_MODE.PACKAGE, label: 'Package Promo', icon: Package },
  ];

  return (
    <div role="tablist" aria-label="Promo mode" style={{ display: 'inline-flex', gap: '0.5rem', padding: '0.25rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '6px' }}>
      {options.map(({ value, label, icon: Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => !disabled && onChange(value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.5rem 0.9rem',
              border: 'none',
              borderRadius: '4px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontWeight: 950,
              fontSize: T.label,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: active ? 'var(--admin-brand)' : 'transparent',
              color: active ? '#fff' : 'var(--admin-text-secondary)',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        );
      })}
    </div>
  );
};

export default PromoModeSelector;
