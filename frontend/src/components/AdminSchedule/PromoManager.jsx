import React, { useEffect, useMemo, useState } from 'react';
import { Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import { getServiceCatalog } from '../../data/servicesCatalog';
import {
  fetchPromoRules,
  upsertPromoRule,
  removePromoRule as removePromoRuleFromStore,
  deactivatePromoRule,
  getCachedPromoRules,
} from '../../services/promoService';
import {
  PROMO_MODE,
  PROMO_VEHICLE_OPTIONS,
  PROMO_SERVICE_OPTIONS,
  createStandardPromoDraft,
  standardRuleToDraft,
  standardDraftToRule,
  createPackagePromoDraft,
  packageRuleToDraft,
  packageDraftToRule,
  evaluatePromoLock,
  minimumStandaloneSum,
  allBundledServices,
} from '../../domain/promo';
import PromoModeSelector from './PromoModeSelector';
import StandardPromoForm from './StandardPromoForm';
import PackagePromoForm from './PackagePromoForm';
import PromoRuleList from './PromoRuleList';

/** Resolve the standalone price of a catalog service for a vehicle type. */
const buildServicePriceResolver = () => {
  const catalog = getServiceCatalog();
  const flat = [];
  Object.values(catalog).forEach((list) => list.forEach((service) => flat.push(service)));
  return (serviceName, vehicleType) => {
    const target = String(serviceName || '').trim().toLowerCase();
    const match = flat.find((service) => String(service.name || '').trim().toLowerCase() === target);
    return Number(match?.prices?.[vehicleType] || 0);
  };
};

/**
 * PromoManager
 * Container component owning promo mode state, the active draft, persistence
 * calls, and the overall layout. Presentation is delegated to mode-specific
 * forms and the rule list; validation is delegated to the domain layer.
 */
const PromoManager = ({ isMobile }) => {
  const [rules, setRules] = useState(() => getCachedPromoRules());
  const [mode, setMode] = useState(PROMO_MODE.STANDARD);
  const [standardDraft, setStandardDraft] = useState(createStandardPromoDraft);
  const [packageDraft, setPackageDraft] = useState(createPackagePromoDraft);
  const [editingId, setEditingId] = useState(null);
  const [publishing, setPublishing] = useState(false);

  const resolvePrice = useMemo(buildServicePriceResolver, []);
  const validationContext = useMemo(() => ({ resolvePrice }), [resolvePrice]);

  // Hydrate authoritative rules from Supabase, falling back to cache.
  useEffect(() => {
    let cancelled = false;
    fetchPromoRules().then((remote) => {
      if (!cancelled && Array.isArray(remote)) setRules(remote);
    });
    return () => { cancelled = true; };
  }, []);

  const draft = mode === PROMO_MODE.PACKAGE ? packageDraft : standardDraft;
  const lock = useMemo(
    () => evaluatePromoLock({ ...draft, mode }, validationContext),
    [draft, mode, validationContext]
  );
  const minStandalone = useMemo(
    () => minimumStandaloneSum(allBundledServices(packageDraft), packageDraft.vehicleTypes, { resolvePrice }),
    [packageDraft, resolvePrice]
  );

  const resetDrafts = () => {
    setStandardDraft(createStandardPromoDraft());
    setPackageDraft(createPackagePromoDraft());
    setEditingId(null);
  };

  const patchStandard = (updates) => setStandardDraft((prev) => ({ ...prev, ...updates }));

  const toggleStandard = (field, item) => {
    setStandardDraft((prev) => {
      const selected = new Set(prev[field]);
      selected.has(item) ? selected.delete(item) : selected.add(item);
      return { ...prev, [field]: [...selected] };
    });
  };

  const bulkToggleStandard = (field, bulkMode) => {
    const options = field === 'vehicleTypes' ? PROMO_VEHICLE_OPTIONS : PROMO_SERVICE_OPTIONS;
    setStandardDraft((prev) => ({ ...prev, [field]: bulkMode === 'all' ? [...options] : [] }));
  };

  const patchPackage = (updates) => setPackageDraft((prev) => ({ ...prev, ...updates }));

  const togglePackageVehicle = (vehicle) => {
    setPackageDraft((prev) => {
      const has = prev.vehicleTypes.includes(vehicle);
      const vehicleTypes = has ? prev.vehicleTypes.filter((v) => v !== vehicle) : [...prev.vehicleTypes, vehicle];
      const vehicleBundles = { ...prev.vehicleBundles };
      if (has) delete vehicleBundles[vehicle];
      else vehicleBundles[vehicle] = vehicleBundles[vehicle] || {};
      return { ...prev, vehicleTypes, vehicleBundles };
    });
  };

  const togglePackageService = (vehicle, service) => {
    setPackageDraft((prev) => {
      const bundle = { ...(prev.vehicleBundles[vehicle] || {}) };
      if (bundle[service]) delete bundle[service];
      else bundle[service] = true;
      return { ...prev, vehicleBundles: { ...prev.vehicleBundles, [vehicle]: bundle } };
    });
  };

  const handleCommit = async () => {
    if (lock.isConfirmLocked) return;
    setPublishing(true);
    try {
      const rule = mode === PROMO_MODE.PACKAGE
        ? packageDraftToRule(packageDraft, editingId, { resolvePrice })
        : standardDraftToRule(standardDraft, editingId);

      const nextRules = await upsertPromoRule(rule, rules);
      setRules(nextRules);
      toast.success(`Promo "${rule.name}" published successfully!`);
      resetDrafts();
    } catch (err) {
      toast.error('Failed to publish promo. Please retry.');
    } finally {
      setPublishing(false);
    }
  };

  const handleEdit = (rule) => {
    if (rule.mode === PROMO_MODE.PACKAGE) {
      setMode(PROMO_MODE.PACKAGE);
      setPackageDraft(packageRuleToDraft(rule));
    } else {
      setMode(PROMO_MODE.STANDARD);
      setStandardDraft(standardRuleToDraft(rule));
    }
    setEditingId(rule.id);
  };

  const handleDelete = (ruleId) => {
    const target = rules.find((rule) => rule.id === ruleId);
    if (!target) return;
    // Deactivate first (revokes availability immediately), then remove.
    deactivatePromoRule(ruleId, rules)
      .then((afterDeactivate) => {
        setRules(afterDeactivate);
        return removePromoRuleFromStore(ruleId, afterDeactivate);
      })
      .then((nextRules) => {
        setRules(nextRules);
        if (editingId === ruleId) resetDrafts();
        toast.success(`Promo "${target.name}" removed.`);
      })
      .catch(() => toast.error('Failed to remove promo.'));
  };

  return (
    <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.25rem', marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
        <Tag size={16} color="var(--admin-brand)" />
        <h4 style={{ margin: 0, fontSize: '0.7rem', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '1px' }}>Promo Management</h4>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <PromoModeSelector mode={mode} onChange={(next) => { setMode(next); setEditingId(null); }} disabled={publishing} />
      </div>

      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.5rem', marginBottom: '1.5rem', fontFamily: 'inherit', fontSize: 'clamp(0.9rem, 0.8vw + 0.7rem, 1.05rem)' }}>
        <div style={{ fontSize: 'clamp(1.15rem, 0.8vw + 0.9rem, 1.45rem)', fontWeight: 900, color: 'var(--admin-text-primary)', marginBottom: '1.5rem' }}>
          {editingId ? 'Edit Promo Rule' : (mode === PROMO_MODE.PACKAGE ? 'Create New Package Promo' : 'Create New Promo Rule')}
        </div>

        {mode === PROMO_MODE.PACKAGE ? (
          <PackagePromoForm
            draft={packageDraft}
            isMobile={isMobile}
            onChange={patchPackage}
            onToggleVehicle={togglePackageVehicle}
            onToggleBundledService={togglePackageService}
            getStandalonePrice={resolvePrice}
            minStandalone={minStandalone}
          />
        ) : (
          <StandardPromoForm
            draft={standardDraft}
            isMobile={isMobile}
            onChange={patchStandard}
            onToggle={toggleStandard}
            onBulkToggle={bulkToggleStandard}
          />
        )}

        {lock.firstError && (
          <div style={{ color: '#fca5a5', fontSize: 'clamp(0.72rem, 0.45vw + 0.62rem, 0.8rem)', fontWeight: 800, marginTop: '1rem' }}>
            {lock.firstError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
          {editingId && (
            <button type="button" onClick={resetDrafts} style={{ background: 'transparent', border: '1px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: '4px', padding: '0.8rem 1.2rem', fontWeight: 900, cursor: 'pointer', textTransform: 'uppercase', fontSize: 'clamp(0.72rem, 0.45vw + 0.62rem, 0.8rem)' }}>
              Cancel Edit
            </button>
          )}
          <button
            type="button"
            disabled={lock.isConfirmLocked || publishing}
            aria-disabled={lock.isConfirmLocked || publishing}
            tabIndex={lock.isConfirmLocked ? -1 : 0}
            onClick={handleCommit}
            title={lock.isConfirmLocked ? lock.firstError : ''}
            style={{
              background: (lock.isConfirmLocked || publishing) ? '#374151' : '#059669',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 950,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontSize: 'clamp(0.72rem, 0.45vw + 0.62rem, 0.8rem)',
              cursor: (lock.isConfirmLocked || publishing) ? 'not-allowed' : 'pointer',
              padding: '0.8rem 1.2rem',
              minWidth: '200px',
              boxShadow: '0 0 0 1px rgba(5,150,105,0.3)',
              opacity: (lock.isConfirmLocked || publishing) ? 0.6 : 1,
            }}
          >
            {publishing ? 'Publishing…' : (mode === PROMO_MODE.PACKAGE ? 'Confirm Package' : 'Create Promo Rule')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
        <div style={{ fontSize: 'clamp(0.76rem, 0.45vw + 0.67rem, 0.86rem)', fontWeight: 950, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--admin-text-secondary)' }}>
          Active Promo Rules ({rules.length})
        </div>
      </div>

      <PromoRuleList rules={rules} editingId={editingId} onEdit={handleEdit} onDelete={handleDelete} />
    </div>
  );
};

export default PromoManager;
