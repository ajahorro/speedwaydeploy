import React, { useState } from 'react';
import { Package, CheckCircle2 } from 'lucide-react';
import { PROMO_VEHICLE_OPTIONS } from '../../domain/promo/promoTypes';
import { allBundledServices, bundledServicesForVehicle } from '../../domain/promo/packagePromo';
import { inputStyle, labelStyle, sectionHeaderStyle, promoFieldTokens } from './promoFormTokens';
import ServicePopoverDrawer from './ServicePopoverDrawer';

/**
 * PackagePromoForm
 * Compact form for bundle promos: Fixed Package Price replaces the discount
 * inputs, and each selected vehicle type opens a service popover to build its
 * bundle. Displays the live standalone comparison so the admin sees the
 * PackagePrice < Σ standalone constraint in real time.
 */
const PackagePromoForm = ({
  draft,
  isMobile,
  onChange,
  onToggleVehicle,
  onToggleBundledService,
  getStandalonePrice,
  minStandalone,
}) => {
  const [openVehicle, setOpenVehicle] = useState(null);
  const bundleCount = allBundledServices(draft).length;
  const packagePrice = Number(draft.packagePrice || 0);
  const savings = Math.max(0, minStandalone - packagePrice);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <div style={sectionHeaderStyle}>Basic Details</div>
        <div className="promo-field-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: '0.75rem' }}>
          <div>
            <label style={labelStyle}>Package Name</label>
            <input type="text" value={draft.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Weekend Bundle" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Fixed Package Price</label>
            <input type="number" min="0" value={draft.packagePrice} onChange={(e) => onChange({ packagePrice: Number(e.target.value) || 0 })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Bundle Threshold</label>
            <input type="text" value={`Min ${Math.max(2, bundleCount)} bundled`} readOnly disabled style={inputStyle} aria-label="Minimum bundled services" />
          </div>
        </div>
      </div>

      <div>
        <div style={sectionHeaderStyle}>Duration &amp; Schedule</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <label style={labelStyle}>Valid From</label>
            <input type="datetime-local" value={draft.validFrom} onChange={(e) => onChange({ validFrom: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ opacity: draft.neverExpires ? 0.65 : 1 }}>
            <label style={labelStyle}>Valid Until</label>
            <input
              type="datetime-local"
              value={draft.validUntil}
              disabled={draft.neverExpires}
              onChange={(e) => onChange({ validUntil: e.target.value })}
              style={{ ...inputStyle, background: draft.neverExpires ? 'var(--admin-input-bg)' : 'var(--admin-bg)', opacity: draft.neverExpires ? 0.6 : 1 }}
            />
            <label style={{ marginTop: '0.65rem', display: 'flex', alignItems: 'center', gap: '0.55rem', color: 'var(--admin-text-primary)', fontSize: promoFieldTokens.control, fontWeight: 500 }}>
              <input type="checkbox" checked={draft.neverExpires} onChange={(e) => onChange({ neverExpires: e.target.checked })} />
              Never Expires
            </label>
          </div>
        </div>
      </div>

      <div>
        <div style={sectionHeaderStyle}>Vehicle Types &amp; Bundled Services</div>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.72rem', color: 'var(--admin-text-secondary)', fontWeight: 700 }}>
          Click a vehicle type to choose the services bundled into this package. Minimum 2 services per bundle.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {PROMO_VEHICLE_OPTIONS.map((vehicle) => {
            const included = draft.vehicleTypes.includes(vehicle);
            const bundled = bundledServicesForVehicle(draft, vehicle);
            return (
              <div key={vehicle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: promoFieldTokens.control, fontWeight: 500, color: 'var(--admin-text-primary)', minWidth: '110px' }}>
                    <input type="checkbox" checked={included} onChange={() => onToggleVehicle(vehicle)} />
                    {vehicle}
                  </label>
                  <button
                    type="button"
                    disabled={!included}
                    onClick={() => setOpenVehicle(openVehicle === vehicle ? null : vehicle)}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.45rem',
                      padding: '0.5rem 0.75rem',
                      minHeight: '36px',
                      background: 'var(--admin-bg)',
                      border: `1px solid ${bundled.length >= 2 ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                      borderRadius: '4px',
                      color: included ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)',
                      fontWeight: 600,
                      fontSize: promoFieldTokens.control,
                      cursor: included ? 'pointer' : 'not-allowed',
                      opacity: included ? 1 : 0.55,
                      textAlign: 'left',
                    }}
                  >
                    <Package size={15} color="var(--admin-brand)" />
                    {bundled.length ? `${bundled.length} service${bundled.length === 1 ? '' : 's'}: ${bundled.join(', ')}` : 'Select bundled services…'}
                    {bundled.length >= 2 && <CheckCircle2 size={15} color="var(--status-success)" style={{ marginLeft: 'auto' }} />}
                  </button>
                </div>
                {openVehicle === vehicle && included && (
                  <ServicePopoverDrawer
                    vehicleType={vehicle}
                    selected={bundled}
                    priceFor={getStandalonePrice}
                    onToggle={(service) => onToggleBundledService(vehicle, service)}
                    onClose={() => setOpenVehicle(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '0.85rem 1rem', background: 'rgba(var(--admin-brand-rgb), .05)', border: '1px solid var(--admin-border)', borderRadius: '6px', display: 'flex', flexWrap: 'wrap', gap: '1.25rem', fontSize: '0.76rem', fontWeight: 800 }}>
        <span style={{ color: 'var(--admin-text-secondary)' }}>Bundled services: <strong style={{ color: 'var(--admin-text-primary)' }}>{bundleCount}</strong></span>
        <span style={{ color: 'var(--admin-text-secondary)' }}>Lowest standalone total: <strong style={{ color: 'var(--admin-text-primary)' }}>₱{minStandalone.toLocaleString()}</strong></span>
        <span style={{ color: 'var(--admin-text-secondary)' }}>Package price: <strong style={{ color: 'var(--admin-text-primary)' }}>₱{packagePrice.toLocaleString()}</strong></span>
        <span style={{ color: savings > 0 ? 'var(--status-success)' : 'var(--status-danger)' }}>Savings: ₱{savings.toLocaleString()}</span>
      </div>
    </div>
  );
};

export default PackagePromoForm;
