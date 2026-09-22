import React, { useState, useEffect } from 'react';
import { Tag, Layers, ChevronDown, ChevronUp, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { getServiceCatalog } from '../../data/servicesCatalog';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useUI } from '../../context/UIContext';

/**
 * PromoManager (System A)
 *
 * Canonical promo authoring surface for the promo layer introduced on
 * origin/main. It was extracted verbatim from the AdminSchedule promo engine so
 * both the Studio Calendar page and the Business Hub "Promos" tab share one
 * implementation.
 *
 * Persistence: posts the validated rule to the backend endpoint
 * `POST /api/admin/promos`, which stores it inside
 * `business_config.promo_rules` (JSONB array, discriminated by `mode`).
 * The legacy System B client-side domain modules (domain/promo/*,
 * services/promoService.js) have been retired — this component must never
 * import them.
 */
const promoVehicleOptions = ['Sedan', 'SUV', 'Van/L300', 'Motorcycle Regular', 'Bigbike'];

const getAvailableServicesForVehicle = (vehicleType) => {
  const catalog = getServiceCatalog();
  const result = [];
  Object.values(catalog).forEach(categoryServices => {
    categoryServices.forEach(service => {
      const prices = service.prices || {};
      let price = 0;
      if (vehicleType === 'Motorcycle Regular') {
        price = prices.Regular ?? prices['Motorcycle Regular'] ?? 0;
      } else if (vehicleType === 'Bigbike') {
        price = prices.Bigbike ?? 0;
      } else {
        price = prices[vehicleType] ?? 0;
      }
      if (Number(price) > 0) {
        result.push({
          id: service.id,
          name: service.name,
          price: Number(price)
        });
      }
    });
  });
  return result;
};

const defaultPromoRules = [
  {
    id: 'winter-wash',
    name: 'Winter Wash',
    mode: 'standard',
    type: 'percentage',
    value: 10,
    validFrom: '2026-09-21T00:00',
    validUntil: '2026-09-30T23:59',
    vehicleTypes: ['Sedan'],
    serviceMatches: ['Full Detail', 'Regular Wash'],
    vehicleServiceMatrix: {
      Sedan: ['Full Detail', 'Regular Wash']
    },
    isOngoing: true
  },
  {
    id: 'vip-detailing',
    name: 'VIP Detailing',
    mode: 'package',
    type: 'fixed_package',
    value: 500,
    validFrom: '2026-09-21T00:00',
    validUntil: '2026-09-30T23:59',
    vehicleTypes: ['SUV'],
    serviceMatches: ['Paint Correction', 'Supreme Wash'],
    vehicleServiceMatrix: {
      SUV: ['Paint Correction', 'Supreme Wash']
    },
    isOngoing: true
  }
];

const defaultPromoDraft = {
  name: '',
  mode: 'standard', // 'standard' | 'package'
  type: 'percentage', // 'percentage' | 'fixed' | 'fixed_package'
  value: 10,
  validFrom: new Date().toISOString().slice(0, 16),
  validUntil: '',
  neverExpires: false,
  vehicleServiceMatrix: {
    Sedan: ['Supreme Wash', 'Regular Wash']
  }
};

const PromoManager = ({ isMobile: isMobileProp = false }) => {
  const isMobileQuery = useMediaQuery('(max-width: 1024px)');
  const isMobile = isMobileProp || isMobileQuery;
  const { openModal } = useUI();

  const [promoRules, setPromoRules] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('speedway_promo_rules') || '[]');
      return Array.isArray(saved) && saved.length ? saved : defaultPromoRules;
    } catch {
      return defaultPromoRules;
    }
  });

  const [promoDraft, setPromoDraft] = useState(defaultPromoDraft);
  const [promoValidationError, setPromoValidationError] = useState('');
  const [promoPublishing, setPromoPublishing] = useState(false);
  const [promoEditingId, setPromoEditingId] = useState(null);
  const [activeVehiclePopover, setActiveVehiclePopover] = useState(null);

  // Continuous promotion state evaluation ticker based on system/server time
  const [currentPromoTime, setCurrentPromoTime] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentPromoTime(new Date());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // Status Condition:
  // UPCOMING: Current Time < Start Time
  // ONGOING PROMO: Start Time <= Current Time <= End Time
  // EXPIRED: Current Time > End Time
  const getPromoStatus = (rule) => {
    if (!rule) return 'EXPIRED';
    const now = currentPromoTime.getTime();
    const start = rule.validFrom ? new Date(rule.validFrom).getTime() : NaN;
    const isNever = rule.neverExpires === true || rule.validUntil === 'never';
    const end = isNever ? Infinity : (rule.validUntil ? new Date(rule.validUntil).getTime() : NaN);

    if (!isNaN(start) && now < start) {
      return 'UPCOMING';
    }
    if (!isNaN(end) && now > end) {
      return 'EXPIRED';
    }
    return 'ONGOING PROMO';
  };

  const formatPromoDate = (isoDate) => {
    if (!isoDate) return '—';
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return isoDate;
    return date.toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  const syncPromoRules = (nextRules) => {
    setPromoRules(nextRules);
    localStorage.setItem('speedway_promo_rules', JSON.stringify(nextRules));
  };

  const resetPromoDraft = () => {
    setPromoDraft(defaultPromoDraft);
    setPromoEditingId(null);
    setPromoValidationError('');
    setActiveVehiclePopover(null);
  };

  // Interactive Target Binding Helpers
  const toggleVehicleScope = (vehicle) => {
    setPromoDraft(prev => {
      const matrix = { ...(prev.vehicleServiceMatrix || {}) };
      if (matrix[vehicle]) {
        delete matrix[vehicle];
        if (activeVehiclePopover === vehicle) {
          setActiveVehiclePopover(null);
        }
      } else {
        const avail = getAvailableServicesForVehicle(vehicle).map(s => s.name);
        matrix[vehicle] = avail;
        setActiveVehiclePopover(vehicle);
      }
      return { ...prev, vehicleServiceMatrix: matrix };
    });
    setPromoValidationError('');
  };

  const toggleServiceForVehicle = (vehicle, serviceName) => {
    setPromoDraft(prev => {
      const matrix = { ...(prev.vehicleServiceMatrix || {}) };
      const currentServices = new Set(matrix[vehicle] || []);
      if (currentServices.has(serviceName)) {
        currentServices.delete(serviceName);
      } else {
        currentServices.add(serviceName);
      }
      matrix[vehicle] = Array.from(currentServices);
      return { ...prev, vehicleServiceMatrix: matrix };
    });
    setPromoValidationError('');
  };

  const setAllServicesForVehicle = (vehicle, mode) => {
    setPromoDraft(prev => {
      const matrix = { ...(prev.vehicleServiceMatrix || {}) };
      if (mode === 'all') {
        const avail = getAvailableServicesForVehicle(vehicle).map(s => s.name);
        matrix[vehicle] = avail;
      } else {
        matrix[vehicle] = [];
      }
      return { ...prev, vehicleServiceMatrix: matrix };
    });
    setPromoValidationError('');
  };

  // Confirmation Lock Engine: Evaluates pre-conditions
  const hasValidVehicleServiceMapping = Object.values(promoDraft.vehicleServiceMatrix || {}).some(
    services => Array.isArray(services) && services.length > 0
  );

  const isDatesValid = Boolean(
    promoDraft.validFrom &&
    (promoDraft.neverExpires || (promoDraft.validUntil && new Date(promoDraft.validUntil) > new Date(promoDraft.validFrom)))
  );

  const isConfirmUnlocked = Boolean(
    promoDraft.name.trim() &&
    Number(promoDraft.value) > 0 &&
    isDatesValid &&
    hasValidVehicleServiceMapping
  );

  const handleCommitPromo = async () => {
    // Intercept and reject any direct API put/patch edit requests originating from client side for active or expired promo IDs
    if (promoEditingId) {
      const existing = promoRules.find(r => r.id === promoEditingId);
      if (existing) {
        const existingStatus = getPromoStatus(existing);
        if (existingStatus === 'ONGOING PROMO') {
          const msg = 'Active promotions cannot be edited while ongoing. Deactivate or wait for expiry.';
          setPromoValidationError(msg);
          toast.error(msg);
          return;
        }
        if (existingStatus === 'EXPIRED') {
          const msg = 'Expired promotions cannot transition back into an editable state.';
          setPromoValidationError(msg);
          toast.error(msg);
          return;
        }
      }
    }

    if (!promoDraft.name.trim()) {
      setPromoValidationError('Please enter a promo name.');
      return;
    }
    if (!promoDraft.value || Number(promoDraft.value) <= 0) {
      setPromoValidationError('Please enter a valid discount value or package price.');
      return;
    }
    if (!promoDraft.validFrom || (!promoDraft.neverExpires && !promoDraft.validUntil)) {
      setPromoValidationError('Please set valid dates.');
      return;
    }
    if (!promoDraft.neverExpires && new Date(promoDraft.validUntil) <= new Date(promoDraft.validFrom)) {
      setPromoValidationError('Valid Until must be later than Valid From.');
      return;
    }

    const boundVehicles = Object.keys(promoDraft.vehicleServiceMatrix || {}).filter(
      v => Array.isArray(promoDraft.vehicleServiceMatrix[v]) && promoDraft.vehicleServiceMatrix[v].length > 0
    );
    if (!boundVehicles.length) {
      setPromoValidationError('Please select at least 1 vehicle type and bind applicable services.');
      return;
    }

    setPromoPublishing(true);
    setPromoValidationError('');

    const nextRule = {
      id: promoEditingId || `promo-${Date.now()}`,
      name: promoDraft.name.trim(),
      mode: promoDraft.mode || 'standard',
      type: promoDraft.mode === 'package' ? 'fixed_package' : promoDraft.type,
      value: Number(promoDraft.value),
      validFrom: promoDraft.validFrom,
      validUntil: promoDraft.neverExpires ? 'never' : promoDraft.validUntil,
      neverExpires: Boolean(promoDraft.neverExpires),
      vehicleServiceMatrix: promoDraft.vehicleServiceMatrix,
      vehicleTypes: boundVehicles,
      serviceMatches: Array.from(new Set(Object.values(promoDraft.vehicleServiceMatrix).flat())),
      isOngoing: true
    };

    try {
      const BACKEND_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) || 'http://localhost:3000';
      const response = await fetch(`${BACKEND_URL}/api/admin/promos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextRule)
      });

      if (response.ok) {
        const result = await response.json();
        if (result.promoRules) {
          syncPromoRules(result.promoRules);
        } else {
          const nextRules = promoEditingId
            ? promoRules.map(rule => rule.id === promoEditingId ? nextRule : rule)
            : [nextRule, ...promoRules];
          syncPromoRules(nextRules);
        }
      } else {
        const errJson = await response.json().catch(() => ({}));
        if (errJson.error) {
          toast.error(errJson.error);
          setPromoValidationError(errJson.error);
          setPromoPublishing(false);
          return;
        }
        const nextRules = promoEditingId
          ? promoRules.map(rule => rule.id === promoEditingId ? nextRule : rule)
          : [nextRule, ...promoRules];
        syncPromoRules(nextRules);
      }
    } catch {
      const nextRules = promoEditingId
        ? promoRules.map(rule => rule.id === promoEditingId ? nextRule : rule)
        : [nextRule, ...promoRules];
      syncPromoRules(nextRules);
    }

    toast.success(
      promoEditingId
        ? `Promo "${nextRule.name}" updated successfully!`
        : promoDraft.mode === 'package'
          ? `Package Promo "${nextRule.name}" confirmed successfully!`
          : `Promo "${nextRule.name}" created successfully!`
    );
    resetPromoDraft();
    setPromoPublishing(false);
  };

  const handleEditPromo = (rule) => {
    const status = getPromoStatus(rule);
    // Immutability Enforcement: Active and expired promotions cannot be edited
    if (status === 'ONGOING PROMO') {
      toast.error('Active promotions cannot be edited while ongoing. Deactivate or wait for expiry.');
      return;
    }
    if (status === 'EXPIRED') {
      toast.error('Expired promotions cannot transition back into an editable state.');
      return;
    }
    setPromoEditingId(rule.id);

    // Reconstruct vehicleServiceMatrix if legacy format
    let matrix = rule.vehicleServiceMatrix;
    if (!matrix || typeof matrix !== 'object' || !Object.keys(matrix).length) {
      matrix = {};
      const vTypes = Array.isArray(rule.vehicleTypes) && rule.vehicleTypes.length ? rule.vehicleTypes : ['Sedan'];
      const sMatches = Array.isArray(rule.serviceMatches) ? rule.serviceMatches : [];
      vTypes.forEach(v => {
        matrix[v] = [...sMatches];
      });
    }

    setPromoDraft({
      name: rule.name || '',
      mode: rule.mode || (rule.type === 'fixed_package' ? 'package' : 'standard'),
      type: rule.type || 'percentage',
      value: rule.value || 0,
      validFrom: rule.validFrom || '',
      validUntil: rule.neverExpires ? '' : (rule.validUntil || ''),
      vehicleServiceMatrix: matrix,
      neverExpires: Boolean(rule.neverExpires)
    });
    setPromoValidationError('');
    setActiveVehiclePopover(Object.keys(matrix)[0] || null);
  };

  const handleRemovePromo = (promoId) => {
    const target = promoRules.find(rule => rule.id === promoId);
    if (!target) return;

    openModal({
      title: 'Remove Promo Campaign?',
      message: `Remove "${target.name}" from the active campaign list? If currently active, this immediately revokes its application across all uncommitted cart checkout sessions.`,
      confirmText: 'Delete Promo',
      cancelText: 'Cancel',
      type: 'danger',
      onConfirm: () => {
        if (promoEditingId === promoId) {
          resetPromoDraft();
        }
        const nextRules = promoRules.filter(rule => rule.id !== promoId);
        syncPromoRules(nextRules);
        toast.success(`Promo "${target.name}" removed.`);
      }
    });
  };

  return (
    <div style={{ background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.25rem', marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
        <Tag size={16} color="var(--admin-brand)" />
        <h4 style={{ margin: 0, fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1px' }}>Promo Management</h4>
      </div>

      {/* Compact Promotion Engine Panel */}
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--admin-border)', borderRadius: '8px', padding: '1.25rem', marginBottom: '1.5rem', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ fontSize: '15px', fontWeight: '900', color: 'var(--admin-text-primary)' }}>
            {promoEditingId ? 'Edit Promo Rule' : 'Promotion Engine & Dynamic Binding'}
          </div>

          {/* Top-Level Workflow Mode Switcher */}
          <div style={{ display: 'inline-flex', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '6px', padding: '2px' }}>
            <button
              type="button"
              onClick={() => {
                setPromoDraft(prev => ({
                  ...prev,
                  mode: 'standard',
                  type: prev.type === 'fixed_package' ? 'percentage' : prev.type
                }));
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.85rem',
                borderRadius: '4px',
                border: 'none',
                background: promoDraft.mode !== 'package' ? 'var(--admin-brand)' : 'transparent',
                color: promoDraft.mode !== 'package' ? '#fff' : 'var(--admin-text-secondary)',
                fontWeight: '800',
                fontSize: '12px',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              <Tag size={13} />
              <span>Standard Promo</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setPromoDraft(prev => ({
                  ...prev,
                  mode: 'package',
                  type: 'fixed_package'
                }));
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.85rem',
                borderRadius: '4px',
                border: 'none',
                background: promoDraft.mode === 'package' ? 'var(--admin-brand)' : 'transparent',
                color: promoDraft.mode === 'package' ? '#fff' : 'var(--admin-text-secondary)',
                fontWeight: '800',
                fontSize: '12px',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              <Layers size={13} />
              <span>Package Promo</span>
            </button>
          </div>
        </div>

        {/* Compact 3-Column Responsive Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1.3fr', gap: '1rem', alignItems: 'start' }}>
          {/* Column 1: Basic Details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--admin-text-primary)' }}>Basic Details</div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Promo Name</label>
              <input
                type="text"
                value={promoDraft.name}
                onChange={(e) => setPromoDraft(prev => ({ ...prev, name: e.target.value }))}
                placeholder={promoDraft.mode === 'package' ? 'VIP Detailing Bundle' : 'Weekend Special'}
                style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>
                  {promoDraft.mode === 'package' ? 'Package Type' : 'Discount Type'}
                </label>
                <select
                  value={promoDraft.type}
                  disabled={promoDraft.mode === 'package'}
                  onChange={(e) => setPromoDraft(prev => ({ ...prev, type: e.target.value }))}
                  style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%', opacity: promoDraft.mode === 'package' ? 0.7 : 1 }}
                >
                  {promoDraft.mode === 'package' ? (
                    <option value="fixed_package">Fixed Bundle Price</option>
                  ) : (
                    <>
                      <option value="percentage">Percentage (%)</option>
                      <option value="fixed">Fixed Amount (₱)</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>
                  {promoDraft.mode === 'package' ? 'Package Price (₱)' : promoDraft.type === 'percentage' ? 'Discount (%)' : 'Discount (₱)'}
                </label>
                <input
                  type="number"
                  min="1"
                  value={promoDraft.value}
                  onChange={(e) => setPromoDraft(prev => ({ ...prev, value: Number(e.target.value) || 0 }))}
                  style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%' }}
                />
              </div>
            </div>
          </div>

          {/* Column 2: Duration & Schedule */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--admin-text-primary)' }}>Duration & Schedule</div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Valid From</label>
              <input
                type="datetime-local"
                value={promoDraft.validFrom}
                onChange={(e) => setPromoDraft(prev => ({ ...prev, validFrom: e.target.value }))}
                style={{ height: '36px', fontSize: '13px', fontWeight: '400', border: '1px solid var(--admin-border)', borderRadius: '4px', padding: '0 0.65rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', boxSizing: 'border-box', width: '100%' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '12px', fontWeight: '500', color: 'var(--admin-text-secondary)', display: 'block', marginBottom: '0.25rem' }}>Valid Until</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--admin-text-secondary)', fontSize: '11px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={promoDraft.neverExpires}
                    onChange={(e) => setPromoDraft(prev => ({ ...prev, neverExpires: e.target.checked }))}
                  />
                  Never Expires
                </label>
              </div>
              <input
                type="datetime-local"
                value={promoDraft.validUntil}
                disabled={promoDraft.neverExpires}
                onChange={(e) => setPromoDraft(prev => ({ ...prev, validUntil: e.target.value }))}
                style={{
                  height: '36px',
                  fontSize: '13px',
                  fontWeight: '400',
                  border: '1px solid var(--admin-border)',
                  borderRadius: '4px',
                  padding: '0 0.65rem',
                  background: promoDraft.neverExpires ? 'rgba(255,255,255,0.03)' : 'var(--admin-bg)',
                  color: promoDraft.neverExpires ? 'var(--admin-text-secondary)' : 'var(--admin-text-primary)',
                  boxSizing: 'border-box',
                  width: '100%',
                  opacity: promoDraft.neverExpires ? 0.6 : 1
                }}
              />
            </div>
          </div>

          {/* Column 3: Dynamic Vehicle-Service Binding Scope */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--admin-text-primary)' }}>Vehicle & Service Binding</div>
              <span style={{ fontSize: '11px', color: 'var(--admin-text-secondary)' }}>
                {Object.keys(promoDraft.vehicleServiceMatrix || {}).length} vehicle(s) bound
              </span>
            </div>

            <div style={{ maxHeight: '260px', overflowY: 'auto', paddingRight: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {promoVehicleOptions.map(vehicle => {
                const isVehicleSelected = Boolean(promoDraft.vehicleServiceMatrix?.[vehicle]);
                const boundServices = promoDraft.vehicleServiceMatrix?.[vehicle] || [];
                const availableServices = getAvailableServicesForVehicle(vehicle);
                const isPopoverOpen = activeVehiclePopover === vehicle;

                return (
                  <div
                    key={vehicle}
                    style={{
                      border: isVehicleSelected ? '1px solid var(--admin-brand)' : '1px solid var(--admin-border)',
                      background: isVehicleSelected ? 'rgba(230, 30, 42, 0.03)' : 'var(--admin-bg)',
                      borderRadius: '4px',
                      padding: '0.5rem 0.65rem',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '12px', fontWeight: '700', color: 'var(--admin-text-primary)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isVehicleSelected}
                          onChange={() => toggleVehicleScope(vehicle)}
                        />
                        <span>{vehicle}</span>
                      </label>

                      {isVehicleSelected && (
                        <button
                          type="button"
                          onClick={() => setActiveVehiclePopover(isPopoverOpen ? null : vehicle)}
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--admin-border)',
                            borderRadius: '3px',
                            color: isPopoverOpen ? 'var(--admin-brand)' : 'var(--admin-text-secondary)',
                            fontSize: '11px',
                            fontWeight: '800',
                            padding: '0.2rem 0.5rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem'
                          }}
                        >
                          <span>{boundServices.length}/{availableServices.length} Services</span>
                          {isPopoverOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      )}
                    </div>

                    {/* Inline Service Popover Panel / Nested Accordion */}
                    {isVehicleSelected && isPopoverOpen && (
                      <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--admin-border)', background: 'rgba(0,0,0,0.15)', borderRadius: '4px', padding: '0.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                          <span style={{ fontSize: '11px', fontWeight: '800', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>
                            Available Services for {vehicle}
                          </span>
                          <div style={{ display: 'flex', gap: '0.35rem' }}>
                            <button
                              type="button"
                              onClick={() => setAllServicesForVehicle(vehicle, 'all')}
                              style={{ background: 'transparent', border: 'none', color: 'var(--admin-brand)', fontSize: '11px', fontWeight: '800', cursor: 'pointer', padding: 0 }}
                            >
                              Select All
                            </button>
                            <span style={{ color: 'var(--admin-border)' }}>·</span>
                            <button
                              type="button"
                              onClick={() => setAllServicesForVehicle(vehicle, 'none')}
                              style={{ background: 'transparent', border: 'none', color: 'var(--admin-text-secondary)', fontSize: '11px', fontWeight: '800', cursor: 'pointer', padding: 0 }}
                            >
                              Clear All
                            </button>
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '140px', overflowY: 'auto' }}>
                          {availableServices.map(svc => {
                            const isBound = boundServices.includes(svc.name);
                            return (
                              <label
                                key={svc.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: '0.5rem',
                                  fontSize: '11px',
                                  color: isBound ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)',
                                  cursor: 'pointer',
                                  padding: '0.2rem 0.25rem',
                                  borderRadius: '3px',
                                  background: isBound ? 'rgba(255,255,255,0.04)' : 'transparent'
                                }}
                              >
                                <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <input
                                    type="checkbox"
                                    checked={isBound}
                                    onChange={() => toggleServiceForVehicle(vehicle, svc.name)}
                                  />
                                  <span>{svc.name}</span>
                                </span>
                                <span style={{ fontWeight: '700', color: 'var(--admin-brand)', fontSize: '11px' }}>
                                  ₱{svc.price.toLocaleString()}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {promoValidationError && (
          <div style={{ color: '#fca5a5', fontSize: '12px', fontWeight: '700', marginTop: '0.5rem' }}>
            {promoValidationError}
          </div>
        )}

        {/* Actions & Confirmation Lock Engine */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: '1px solid var(--admin-border)' }}>
          {promoEditingId && (
            <button
              type="button"
              onClick={resetPromoDraft}
              style={{
                background: 'transparent',
                border: '1px solid var(--admin-border)',
                color: 'var(--admin-text-secondary)',
                borderRadius: '4px',
                fontWeight: '800',
                padding: '0.5rem 1rem',
                fontSize: '12px',
                cursor: 'pointer'
              }}
            >
              Cancel Edit
            </button>
          )}
          <button
            type="button"
            disabled={!isConfirmUnlocked || promoPublishing}
            onClick={handleCommitPromo}
            title={!isConfirmUnlocked ? 'Enter name, discount value, valid dates, and bind at least 1 vehicle-service mapping to unlock' : undefined}
            style={{
              background: isConfirmUnlocked ? '#059669' : '#374151',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontWeight: '900',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontSize: '12px',
              cursor: isConfirmUnlocked ? 'pointer' : 'not-allowed',
              padding: '0.55rem 1.25rem',
              minWidth: '180px',
              opacity: isConfirmUnlocked ? 1 : 0.5,
              pointerEvents: isConfirmUnlocked ? 'auto' : 'none',
              boxShadow: isConfirmUnlocked ? '0 0 0 1px rgba(5,150,105,0.4)' : 'none',
              transition: 'all 0.15s ease'
            }}
          >
            {promoPublishing ? 'Publishing...' : (promoEditingId ? 'Save Changes' : promoDraft.mode === 'package' ? 'Confirm Package' : 'Create Promo Rule')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', borderBottom: '1px solid var(--admin-border)', paddingBottom: '0.75rem' }}>
        <div style={{ fontSize: 'clamp(0.76rem, 0.45vw + 0.67rem, 0.86rem)', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--admin-text-secondary)' }}>
          Campaign Promo Rules ({promoRules.length})
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {promoRules.map(rule => {
          const status = getPromoStatus(rule);
          const isOngoing = status === 'ONGOING PROMO';
          const isExpired = status === 'EXPIRED';

          return (
            <div
              key={rule.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.75rem',
                background: 'var(--admin-bg)',
                border: isOngoing
                  ? '1px solid rgba(16, 185, 129, 0.4)'
                  : '1px solid var(--admin-border)',
                borderRadius: '4px',
                padding: '0.9rem 1rem',
                boxShadow: rule.id === promoEditingId ? '0 0 0 2px rgba(230,30,42,0.18)' : 'none',
                animation: 'promoCardPulse 0.7s ease',
                fontFamily: 'inherit'
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: '950', fontSize: 'clamp(0.98rem, 0.6vw + 0.82rem, 1.18rem)' }}>
                    {rule.name}
                  </div>
                  {/* Dynamic Status Badge */}
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      fontSize: 'clamp(0.62rem, 0.35vw + 0.55rem, 0.72rem)',
                      padding: '0.2rem 0.55rem',
                      borderRadius: '4px',
                      fontWeight: '950',
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: isOngoing ? '#10b981' : status === 'UPCOMING' ? '#3b82f6' : '#94a3b8',
                      background: isOngoing ? 'rgba(16, 185, 129, 0.12)' : status === 'UPCOMING' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(148, 163, 184, 0.12)',
                      border: `1px solid ${isOngoing ? 'rgba(16, 185, 129, 0.35)' : status === 'UPCOMING' ? 'rgba(59, 130, 246, 0.35)' : 'rgba(148, 163, 184, 0.3)'}`
                    }}
                  >
                    <span
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: isOngoing ? '#10b981' : status === 'UPCOMING' ? '#3b82f6' : '#94a3b8'
                      }}
                    />
                    {status}
                  </span>
                </div>

                <div style={{ color: 'var(--admin-text-secondary)', fontSize: 'clamp(0.76rem, 0.5vw + 0.64rem, 0.9rem)', marginTop: '0.25rem' }}>
                  <span style={{ fontWeight: '800', color: rule.mode === 'package' ? '#818cf8' : '#10b981', marginRight: '0.5rem' }}>
                    {rule.mode === 'package' ? `[PACKAGE: ₱${Number(rule.value || 0).toLocaleString()}]` : rule.type === 'percentage' ? `[${rule.value}% OFF]` : `[₱${Number(rule.value || 0).toLocaleString()} OFF]`}
                  </span>
                  · {rule.vehicleServiceMatrix
                    ? Object.entries(rule.vehicleServiceMatrix).map(([v, svcs]) => `${v} (${svcs.length} svcs)`).join(' · ')
                    : `${(rule.vehicleTypes || []).join(', ')} · ${(rule.serviceMatches || []).join(', ')}`}
                </div>
                <div style={{ fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.78rem)', color: 'var(--admin-text-secondary)', marginTop: '0.35rem', fontWeight: '700' }}>
                  Valid: {formatPromoDate(rule.validFrom)} to {rule.neverExpires ? 'Never' : formatPromoDate(rule.validUntil)}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {isOngoing ? (
                  <span
                    title="Active promotions cannot be edited while ongoing. Deactivate or wait for expiry."
                    style={{ display: 'inline-block', cursor: 'not-allowed' }}
                  >
                    <button
                      type="button"
                      disabled
                      tabIndex={-1}
                      title="Active promotions cannot be edited while ongoing. Deactivate or wait for expiry."
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'var(--admin-text-secondary)',
                        padding: '0.5rem 0.8rem',
                        borderRadius: '4px',
                        fontWeight: '900',
                        fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)',
                        cursor: 'not-allowed',
                        opacity: 0.45,
                        pointerEvents: 'none'
                      }}
                    >
                      <Lock size={12} />
                      Edit
                    </button>
                  </span>
                ) : isExpired ? (
                  <span
                    title="Expired promotions cannot transition back into an editable state."
                    style={{ display: 'inline-block', cursor: 'not-allowed' }}
                  >
                    <button
                      type="button"
                      disabled
                      tabIndex={-1}
                      title="Expired promotions cannot transition back into an editable state."
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'var(--admin-text-secondary)',
                        padding: '0.5rem 0.8rem',
                        borderRadius: '4px',
                        fontWeight: '900',
                        fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)',
                        cursor: 'not-allowed',
                        opacity: 0.45,
                        pointerEvents: 'none'
                      }}
                    >
                      <Lock size={12} />
                      Edit
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleEditPromo(rule)}
                    style={{
                      border: '1px solid var(--admin-border)',
                      background: 'transparent',
                      color: 'var(--admin-text-primary)',
                      padding: '0.5rem 0.8rem',
                      borderRadius: '4px',
                      fontWeight: '900',
                      cursor: 'pointer',
                      fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)'
                    }}
                  >
                    Edit
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleRemovePromo(rule.id)}
                  style={{
                    border: '1px solid #ef4444',
                    background: 'transparent',
                    color: '#ef4444',
                    padding: '0.5rem 0.8rem',
                    borderRadius: '4px',
                    fontWeight: '900',
                    cursor: 'pointer',
                    fontSize: 'clamp(0.68rem, 0.35vw + 0.58rem, 0.8rem)'
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PromoManager;
