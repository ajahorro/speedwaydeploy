import React, { useEffect, useMemo, useState } from 'react';
import { Tag, Layers, RefreshCw } from 'lucide-react';
import { fetchActivePromos, isPackageRule, getPackageServicesForVehicle } from '../../data/servicesCatalog';

/**
 * <AvailablePromosByVehicle>
 * ============================================================================
 * A read-only "what's on offer right now" panel that groups every ACTIVE promo
 * (and package) by the vehicle type(s) it applies to.
 *
 * WHY: promos were only ever surfaced inline in the service list (a per-service
 * badge), which meant an admin or customer could never see the full picture —
 * "which vehicles have a promo, and what is it?" This panel answers exactly that,
 * for BOTH the customer booking wizard and the admin walk-in wizard (they share
 * the same Step-1 component, so mounting it there covers both account types).
 *
 * Data source: `fetchActivePromos()` (the same backend/cache source the booking
 * pricing uses), so what is shown here and what is charged can never disagree.
 * Standard promos are listed by vehicle; packages are listed by vehicle with
 * their bundle member services.
 */

const vehicleLabel = (v) => String(v || '').trim() || 'Any vehicle';

const AvailablePromosByVehicle = ({ compact = false }) => {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchActivePromos()
      .then((data) => { if (mounted) setRules(Array.isArray(data) ? data : []); })
      .catch(() => { if (mounted) setRules([]); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  // Group: vehicleType -> [{ rule, isPackage, services }]
  const grouped = useMemo(() => {
    const map = new Map();
    (rules || []).forEach((rule) => {
      const isPkg = isPackageRule(rule);
      // Which vehicles does this rule target? Prefer the explicit matrix keys,
      // fall back to vehicleTypes, and finally to a catch-all bucket.
      const matrixVehicles = rule.vehicleServiceMatrix && typeof rule.vehicleServiceMatrix === 'object'
        ? Object.keys(rule.vehicleServiceMatrix)
        : [];
      const vehicles = matrixVehicles.length
        ? matrixVehicles
        : (Array.isArray(rule.vehicleTypes) && rule.vehicleTypes.length ? rule.vehicleTypes : ['__any__']);

      vehicles.forEach((vehicle) => {
        const key = vehicle === '__any__' ? 'Any vehicle' : vehicleLabel(vehicle);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
          rule,
          isPackage: isPkg,
          services: isPkg && vehicle !== '__any__' ? getPackageServicesForVehicle(rule, vehicle) : [],
        });
      });
    });
    // Stable vehicle order: the shop's canonical order first, then any extras.
    const canonical = ['Sedan', 'SUV', 'Van/L300', 'Regular', 'Bigbike', 'Any vehicle'];
    return [...map.entries()].sort((a, b) => {
      const ia = canonical.indexOf(a[0]);
      const ib = canonical.indexOf(b[0]);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a[0].localeCompare(b[0]);
    });
  }, [rules]);

  const valueLabel = (rule) => {
    if (isPackageRule(rule)) return `₱${Number(rule.value || 0).toLocaleString()} bundle`;
    if (rule.type === 'percentage') return `${rule.value}% off`;
    return `₱${Number(rule.value || 0).toLocaleString()} off`;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: 700 }}>
        <RefreshCw size={14} className="spin" /> Loading available promotions…
      </div>
    );
  }

  if (!grouped.length) {
    return (
      <div style={{ padding: '0.9rem 1rem', background: 'var(--admin-bg)', border: '1px dashed var(--admin-border)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--admin-text-secondary)', fontSize: '0.78rem', fontWeight: 700 }}>
        No promotions are active right now.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      {grouped.map(([vehicle, items]) => (
        <div key={vehicle}>
          <div style={{ fontSize: '0.68rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--admin-text-secondary)', marginBottom: '0.45rem' }}>
            {vehicle}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {items.map(({ rule, isPackage, services }, idx) => (
              <div
                key={`${rule.id || rule.name}-${idx}`}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                  padding: compact ? '0.55rem 0.7rem' : '0.7rem 0.85rem',
                  background: 'var(--admin-bg)',
                  border: '1px solid var(--admin-border)',
                  borderRadius: 'var(--admin-radius-sm)',
                }}
              >
                {isPackage
                  ? <Layers size={15} color="var(--admin-brand)" style={{ flexShrink: 0, marginTop: 2 }} />
                  : <Tag size={15} color="var(--admin-brand)" style={{ flexShrink: 0, marginTop: 2 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: '0.82rem', color: 'var(--admin-text-primary)' }}>{rule.name}</strong>
                    <span style={{ fontSize: '0.72rem', fontWeight: 900, color: 'var(--status-success)' }}>{valueLabel(rule)}</span>
                  </div>
                  {isPackage && services.length > 0 && (
                    <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.68rem', color: 'var(--admin-text-secondary)' }}>
                      Includes: {services.join(', ')}
                    </span>
                  )}
                  {rule.neverExpires ? (
                    <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.64rem', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 800 }}>No expiry</span>
                  ) : rule.validUntil && (
                    <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.64rem', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 800 }}>
                      Until {new Date(rule.validUntil).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <style>{`@keyframes promos-spin { to { transform: rotate(360deg); } } .spin { animation: promos-spin 0.9s linear infinite; }`}</style>
    </div>
  );
};

export default AvailablePromosByVehicle;