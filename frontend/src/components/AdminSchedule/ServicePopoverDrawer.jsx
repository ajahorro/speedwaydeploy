import React from 'react';
import { X, CheckCircle2, Circle } from 'lucide-react';
import { PROMO_SERVICE_OPTIONS } from '../../domain/promo/promoTypes';

/**
 * ServicePopoverDrawer
 * Inline overlay opened when an admin clicks a vehicle type in a Package Promo.
 * It permits granular service mapping for that specific vehicle type.
 *
 * The bundle is stored as a per-vehicle map ({ serviceName: true }) so different
 * vehicle types can carry different bundles, matching the spec's example
 * ("Full Detail + Paint Correction for SUV").
 */
const ServicePopoverDrawer = ({ vehicleType, selected = [], onToggle, onClose, priceFor = () => 0 }) => {
  if (!vehicleType) return null;

  return (
    <div
      role="dialog"
      aria-label={`Services for ${vehicleType}`}
      style={{
        position: 'relative',
        marginTop: '0.75rem',
        background: 'var(--admin-card)',
        border: '1px solid var(--admin-brand)',
        borderRadius: '6px',
        padding: '1rem',
        boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <strong style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--admin-text-primary)' }}>
          {vehicleType} bundle
        </strong>
        <button type="button" onClick={onClose} aria-label="Close service popover" style={{ background: 'none', border: 'none', color: 'var(--admin-text-secondary)', cursor: 'pointer', display: 'flex' }}>
          <X size={16} />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.5rem' }}>
        {PROMO_SERVICE_OPTIONS.map((service) => {
          const isSelected = selected.includes(service);
          const price = Number(priceFor(service, vehicleType) || 0);
          return (
            <button
              key={service}
              type="button"
              onClick={() => onToggle(service)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.6rem 0.75rem',
                textAlign: 'left',
                borderRadius: '4px',
                cursor: 'pointer',
                background: isSelected ? 'rgba(var(--admin-brand-rgb), .08)' : 'var(--admin-bg)',
                border: `1px solid ${isSelected ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                color: 'var(--admin-text-primary)',
              }}
            >
              {isSelected ? <CheckCircle2 size={17} color="var(--admin-brand)" /> : <Circle size={17} color="var(--admin-text-secondary)" />}
              <span style={{ flex: 1, fontWeight: 800, fontSize: '0.78rem' }}>{service}</span>
              <small style={{ color: 'var(--admin-text-secondary)', fontWeight: 800 }}>₱{price.toLocaleString()}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ServicePopoverDrawer;
