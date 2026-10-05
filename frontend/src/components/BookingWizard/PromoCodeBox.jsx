import React, { useEffect, useRef, useState } from 'react';
import { Tag, Loader2, CheckCircle2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { redeemPromoCode } from '../../services/promoCodeService';

/**
 * Optional promo code on the last booking page.
 *
 * `promoRule` (the promotion the code unlocked) lives in the booking data, so it
 * is saved with the draft. A restored draft re-checks the code once, because it
 * may have expired in the meantime.
 */
const PromoCodeBox = ({ promoCode, promoRule, onApplied, onRemoved, disabled = false }) => {
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const revalidated = useRef(false);

  useEffect(() => {
    if (revalidated.current || !promoCode) return;
    revalidated.current = true;
    redeemPromoCode(promoCode).then((result) => {
      if (result.valid) {
        onApplied(result.rule);
      } else {
        onRemoved();
        toast.error(`Your promo code is no longer valid: ${result.message}`);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (checking || disabled) return;
    setChecking(true);
    setMessage('');
    const result = await redeemPromoCode(input);
    setChecking(false);
    if (result.valid) {
      onApplied(result.rule);
      setInput('');
      toast.success(`Promo code applied: ${result.rule.name}`, { id: 'promo-code' });
    } else {
      setMessage(result.message);
    }
  };

  const fieldStyle = {
    flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '0.85rem 1rem',
    background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)',
    border: '1px solid var(--admin-input-border)', borderRadius: '6px',
    fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', outline: 'none'
  };

  return (
    <div style={{ padding: '1rem', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius-md)', background: 'var(--admin-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', fontSize: '0.7rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--admin-text-secondary)' }}>
        <Tag size={14} /> Promo code <span style={{ fontWeight: 700, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
      </div>

      {promoRule ? (
        <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', padding: '0.7rem 0.9rem', background: 'rgba(var(--admin-success-rgb), 0.08)', border: '1px solid var(--status-success-border)', borderRadius: '6px', color: 'var(--status-success)', fontSize: '0.82rem', fontWeight: 800 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <CheckCircle2 size={16} /> {promoRule.code}: {promoRule.name} applied
          </span>
          <button type="button" onClick={onRemoved} disabled={disabled} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'transparent', border: 0, color: 'var(--admin-text-secondary)', fontWeight: 800, fontSize: '0.72rem', cursor: 'pointer' }}>
            <X size={14} /> Remove
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              value={input}
              onChange={(event) => { setInput(event.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24)); setMessage(''); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }}
              placeholder="Enter code"
              aria-label="Promo code"
              disabled={disabled}
              style={fieldStyle}
            />
            <button
              type="button"
              onClick={apply}
              disabled={disabled || checking || !input.trim()}
              style={{ padding: '0 1.1rem', display: 'flex', alignItems: 'center', gap: '0.4rem', background: input.trim() ? 'var(--admin-brand)' : 'var(--admin-bg)', color: input.trim() ? '#fff' : 'var(--admin-text-secondary)', border: '1px solid var(--admin-border)', borderRadius: '6px', fontWeight: 900, fontSize: '0.75rem', textTransform: 'uppercase', cursor: input.trim() && !checking ? 'pointer' : 'not-allowed' }}
            >
              {checking ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null} Apply
            </button>
          </div>
          {message && <div role="alert" style={{ marginTop: '0.5rem', color: 'var(--status-danger)', fontSize: '0.75rem', fontWeight: 800 }}>{message}</div>}
        </>
      )}
    </div>
  );
};

export default PromoCodeBox;
