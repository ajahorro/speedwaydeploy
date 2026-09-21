import React from 'react';
import { PROMO_VEHICLE_OPTIONS, PROMO_SERVICE_OPTIONS, DISCOUNT_TYPE } from '../../domain/promo/promoTypes';
import { inputStyle, labelStyle, sectionHeaderStyle, promoFieldTokens } from './promoFormTokens';

/**
 * StandardPromoForm
 * Three-section compact form for percentage / fixed-amount promos.
 * Fully controlled: it owns no state and delegates every change to the parent
 * via onChange(patch), so the draft lifecycle lives in one place.
 */
const StandardPromoForm = ({ draft, isMobile, onChange, onToggle, onBulkToggle }) => {
  const patch = (updates) => onChange(updates);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <div style={sectionHeaderStyle}>Basic Details</div>
        <div className="promo-field-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: '0.75rem' }}>
          <div>
            <label style={labelStyle}>Promo Name</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Weekend Special"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Discount Type</label>
            <select value={draft.type} onChange={(e) => patch({ type: e.target.value })} style={inputStyle}>
              <option value={DISCOUNT_TYPE.PERCENTAGE}>Percentage</option>
              <option value={DISCOUNT_TYPE.FIXED}>Fixed Amount</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Discount Value</label>
            <input
              type="number"
              min="1"
              value={draft.value}
              onChange={(e) => patch({ value: Number(e.target.value) || 0 })}
              style={inputStyle}
            />
          </div>
        </div>
      </div>

      <div>
        <div style={sectionHeaderStyle}>Duration &amp; Schedule</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <label style={labelStyle}>Valid From</label>
            <input type="datetime-local" value={draft.validFrom} onChange={(e) => patch({ validFrom: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ opacity: draft.neverExpires ? 0.65 : 1 }}>
            <label style={labelStyle}>Valid Until</label>
            <input
              type="datetime-local"
              value={draft.validUntil}
              disabled={draft.neverExpires}
              onChange={(e) => patch({ validUntil: e.target.value })}
              style={{ ...inputStyle, background: draft.neverExpires ? 'var(--admin-input-bg)' : 'var(--admin-bg)', opacity: draft.neverExpires ? 0.6 : 1 }}
            />
            <label style={{ marginTop: '0.65rem', display: 'flex', alignItems: 'center', gap: '0.55rem', color: 'var(--admin-text-primary)', fontSize: '0.82rem', fontWeight: 700 }}>
              <input type="checkbox" checked={draft.neverExpires} onChange={(e) => patch({ neverExpires: e.target.checked })} />
              Never Expires
            </label>
          </div>
        </div>
      </div>

      <div>
        <div style={sectionHeaderStyle}>Target Scope</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Vehicle Types</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(110px, 1fr))', gap: '0.7rem 1.25rem', padding: '0.25rem 0' }}>
              {PROMO_VEHICLE_OPTIONS.map((vehicle) => (
                <label key={vehicle} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: promoFieldTokens.control, fontWeight: 500, color: 'var(--admin-text-primary)' }}>
                  <input type="checkbox" checked={draft.vehicleTypes.includes(vehicle)} onChange={() => onToggle('vehicleTypes', vehicle)} />
                  {vehicle}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.45rem' }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Service Match</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => onBulkToggle('serviceMatches', 'all')} style={bulkBtnStyle}>Select All</button>
                <button type="button" onClick={() => onBulkToggle('serviceMatches', 'none')} style={bulkBtnStyle}>Clear All</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.7rem', padding: '0.25rem 0' }}>
              {PROMO_SERVICE_OPTIONS.map((service) => (
                <label key={service} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: promoFieldTokens.control, fontWeight: 500, color: 'var(--admin-text-primary)' }}>
                  <input type="checkbox" checked={draft.serviceMatches.includes(service)} onChange={() => onToggle('serviceMatches', service)} />
                  {service}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const bulkBtnStyle = {
  border: '1px solid var(--admin-border)',
  background: 'transparent',
  color: 'var(--admin-text-primary)',
  borderRadius: '4px',
  padding: '0.25rem 0.5rem',
  fontSize: promoFieldTokens.controlSm,
  fontWeight: 700,
  cursor: 'pointer',
};

export default StandardPromoForm;
