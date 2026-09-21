import React from 'react';
import { Lock, Package as PackageIcon, Tag } from 'lucide-react';
import { PROMO_MODE, isNeverExpiring } from '../../domain/promo/promoTypes';
import { describeStandardDiscount } from '../../domain/promo/standardPromo';
import { describePackage } from '../../domain/promo/packagePromo';

/** Format an ISO date for the rule list; never-expiring and blanks render as text. */
const formatDate = (isoDate) => {
  if (isNeverExpiring(isoDate)) return isoDate === null || isoDate === 'never' ? 'Never' : '—';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** Classify a rule relative to now for the active/upcoming/expired grouping. */
const ruleStatus = (rule) => {
  if (rule.active === false) return 'deactivated';
  const now = new Date();
  const from = rule.validFrom || rule.valid_from;
  const until = (rule.validUntil ?? rule.valid_until);
  if (from && new Date(from) > now) return 'upcoming';
  if (!isNeverExpiring(until) && new Date(until) < now) return 'expired';
  return 'active';
};

// Theme-aware status colours: --status-* resolves to Emerald 500 on dark and
// Emerald 700 on light so the ONGOING PROMO badge clears WCAG AA in both.
const STATUS_STYLE = {
  active: { label: 'Ongoing promo', color: 'var(--status-success)' },
  upcoming: { label: 'Scheduled', color: 'var(--status-warning)' },
  expired: { label: 'Expired', color: 'var(--admin-text-secondary)' },
  deactivated: { label: 'Deactivated', color: 'var(--status-danger)' },
};

/**
 * PromoRuleList
 * Renders active, upcoming, and expired promos. Per the immutability rules an
 * ONGOING PROMO cannot be edited: its Edit button renders disabled with
 * pointer-events:none and tabindex="-1". Delete/deactivation stays available.
 */
const PromoRuleList = ({ rules = [], editingId, onEdit, onDelete }) => {
  const grouped = { active: [], upcoming: [], expired: [], deactivated: [] };
  rules.forEach((rule) => grouped[ruleStatus(rule)].push(rule));
  const ordered = [...grouped.active, ...grouped.upcoming, ...grouped.expired, ...grouped.deactivated];

  if (!ordered.length) {
    return (
      <p style={{ margin: '1rem 0', textAlign: 'center', fontSize: '0.68rem', fontWeight: 950, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', opacity: 0.6 }}>
        No promo rules yet
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {ordered.map((rule) => {
        const status = ruleStatus(rule);
        const statusMeta = STATUS_STYLE[status];
        const isOngoing = status === 'active';
        const isPackage = rule.mode === PROMO_MODE.PACKAGE;
        const Icon = isPackage ? PackageIcon : Tag;

        return (
          <div
            key={rule.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.75rem',
              background: 'var(--admin-bg)',
              border: '1px solid var(--admin-border)',
              borderRadius: '4px',
              padding: '0.9rem 1rem',
              boxShadow: rule.id === editingId ? '0 0 0 2px rgba(230,30,42,0.18)' : 'none',
              fontFamily: 'inherit',
              opacity: status === 'deactivated' ? 0.65 : 1,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 950, fontSize: 'clamp(0.98rem, 0.6vw + 0.82rem, 1.18rem)' }}>
                <Icon size={15} color="var(--admin-brand)" />
                {rule.name}
                {isPackage && (
                  <span style={{ fontSize: '0.6rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--admin-brand)', border: '1px solid var(--admin-border)', borderRadius: '3px', padding: '0.1rem 0.35rem' }}>
                    Package
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--admin-text-secondary)', fontSize: 'clamp(0.76rem, 0.5vw + 0.64rem, 0.9rem)', marginTop: '0.18rem' }}>
                {isPackage
                  ? `${describePackage(rule)} · ${(rule.vehicleTypes || []).join(', ')} · ${(rule.bundledServices || []).join(', ')}`
                  : `${describeStandardDiscount(rule)} · ${(rule.vehicleTypes || []).join(', ')} · ${(rule.serviceMatches || []).join(', ')}`}
              </div>
              <div style={{ fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.78rem)', color: statusMeta.color, marginTop: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 900 }}>
                {statusMeta.label} · Valid: {formatDate(rule.validFrom)} to {rule.neverExpires || isNeverExpiring(rule.validUntil) ? 'Never' : formatDate(rule.validUntil)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={isOngoing}
                aria-disabled={isOngoing}
                tabIndex={isOngoing ? -1 : 0}
                title={isOngoing ? 'Active promotions cannot be edited while ongoing.' : 'Edit promo'}
                onClick={() => !isOngoing && onEdit(rule)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  border: '1px solid var(--admin-border)',
                  background: 'transparent',
                  color: isOngoing ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)',
                  padding: '0.5rem 0.8rem',
                  borderRadius: '4px',
                  fontWeight: 900,
                  fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)',
                  cursor: isOngoing ? 'not-allowed' : 'pointer',
                  pointerEvents: isOngoing ? 'none' : 'auto',
                  opacity: isOngoing ? 0.5 : 1,
                }}
              >
                {isOngoing && <Lock size={13} />}
                EDIT
              </button>
              <button
                type="button"
                onClick={() => onDelete(rule.id)}
                style={{ border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', padding: '0.5rem 0.8rem', borderRadius: '4px', fontWeight: 900, cursor: 'pointer', fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)' }}
              >
                DELETE
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default PromoRuleList;
