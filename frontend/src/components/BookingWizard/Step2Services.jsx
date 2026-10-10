import React, { useEffect, useMemo, useState } from 'react';
import { Car, Check, Layers, Lock, Plus, Trash2, X } from 'lucide-react';
import { getServiceCatalog, getBestPromoForService, fetchActivePromos, priceVehicleServices, calculateBookingDiscountSummary, isPackageRule, isPromoActiveForNow, getPackageServicesForVehicle, getPackageStandaloneSum } from '../../data/servicesCatalog';
import { fetchUserGarage, fetchFleetGroups } from '../../services/garageService';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import toast from '@/lib/toast';
import { sanitizeVehiclePlate, sanitizeVehicleText, SHOP_CONFIG } from '../../config/constants';
import { useConfig } from '../../context/ConfigContext';
import { calculateBayUsage } from '../../utils/schedulingUtils';
import { appendNewGarageVehicles, uniqueGarageVehicles } from '../../utils/fleetVehicleUtils';
import { getBayCapacity } from '../../config/shopConfig';
import PromoCodeBox from './PromoCodeBox';

const newId = () => crypto.randomUUID ? crypto.randomUUID() : `v_${Math.random().toString(36).slice(2)}`;
const emptyVehicle = (manual = false) => ({ id: newId(), type: '', brand: '', model: '', plateNumber: '', services: [], locked: false, manual });
const vehicleServiceNetPrice = (service) => Number(service.price_at_booking ?? service.price ?? 0);
// A package is a whole-vehicle flat price: when one applies, the unit subtotal is
// that single figure (NOT the sum of its member services, which are meant to be
// shown as "included").
const unitSubtotal = (vehicle) => {
  if (vehicle?.package_applied && Number.isFinite(Number(vehicle.package_price))) {
    return Number(vehicle.package_price);
  }
  return (vehicle.services || []).reduce((total, service) => total + vehicleServiceNetPrice(service), 0);
};
const unitGrossSubtotal = (vehicle) => (vehicle.services || []).reduce((total, service) => total + Number(service.original_price || service.price || service.price_at_booking || 0), 0);
// Package promos live behind ONE service type in column A. It is listed only when the vehicle has a live
// package promo, so every new package promo lands there with no other change. A promo that discounts a
// single service is shown on that service itself, not in a type of its own.
const PACKAGE_CATEGORY = 'Package Promos';
const inputStyle = { width: '100%', padding: '.75rem', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-input-border)', borderRadius: '6px', fontWeight: '700' };
// Strips everything except A-Z and 0-9 for collision-proof plate comparison
const normalizePlate = (plate) => String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const Step2Services = ({ bookingData, setBookingData, adminMode = false, onNext, onCancel, onCancelNewVehicle }) => {
  const { user } = useAuth();
  // Vehicle categories configured in the Business Hub.
  const { settings: { VEHICLE_TYPES: vehicleTypeOptions, MAX_BAYS: configuredMaxBays } } = useConfig();
  // useMemo so the identity is STABLE. A bare `|| []` produced a NEW array on
  // every render whenever bookingData.vehicles was unset, which made every hook
  // depending on `vehicles` (the `units` memo below) recompute constantly.
  const vehicles = useMemo(() => bookingData.vehicles || [], [bookingData.vehicles]);
  const [garageVehicles, setGarageVehicles] = useState([]);
  const [fleetGroups, setFleetGroups] = useState([]);
  const [fleetToAddId, setFleetToAddId] = useState('');
  const fleetMutationRef = React.useRef(false);
  // 🛠️ HOTFIX Fix 1 (UX Separation) — TABBED ADDITION MODE.
  // The user asked for a CLEAN separation between choosing a FLEET and choosing
  // INDIVIDUAL vehicles. Previously fleets, garage cars and the "Add New Vehicle"
  // card were all dumped into one dense grid, blurring the fleet/individual
  // boundary. "Book by Fleet" now shows ONLY fleet cards; "Individual Vehicles"
  // shows ONLY saved cars + Add New Vehicle.
  const [additionMode, setAdditionMode] = useState('individual');
  const [activeCategories, setActiveCategories] = useState({});
  const [maxBays, setMaxBays] = useState(configuredMaxBays);
  const [activePromos, setActivePromos] = useState([]);
  const SERVICE_CATALOG = getServiceCatalog();

  useEffect(() => {
    fetchActivePromos()
      .then(promos => setActivePromos(promos || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ownerId = bookingData.customerId || user?.id;
    if (!ownerId) return;
    Promise.all([
      fetchUserGarage(ownerId),
      fetchFleetGroups(ownerId),
      getBayCapacity()
    ])
      .then(([savedVehicles, groups, bayCapacity]) => { setGarageVehicles(savedVehicles); setFleetGroups(groups); setMaxBays(bayCapacity); })
      .catch((error) => console.error('Failed to load garage:', error));
  }, [user, bookingData.customerId]);

  const updateVehicles = (updater) => setBookingData((current) => ({
    ...current,
    vehicles: typeof updater === 'function' ? updater(current.vehicles || []) : updater
  }));
  const isUntouchedUnit = (vehicle) => !vehicle.type && !vehicle.brand && !vehicle.model && !vehicle.plateNumber && !(vehicle.services || []).length;
  const garageVehicleToBookingVehicle = (vehicle, fleetUnitKey = null) => ({
    id: newId(),
    garageVehicleId: vehicle.id,
    fleetGroupId: vehicle.fleet_group_id || null,
    fleetUnitKey,
    locked: true,
    type: vehicle.type,
    brand: vehicle.brand,
    model: vehicle.model,
    plateNumber: vehicle.plate_number,
    services: []
  });

  // A fleet type is one editor unit, but each original vehicle remains in the
  // booking so bay usage, service rows, and payment totals remain accurate.
  const units = useMemo(() => {
    const map = new Map();
    vehicles.forEach((vehicle) => {
      const key = vehicle.fleetUnitKey || vehicle.id;
      const current = map.get(key) || { id: key, vehicles: [], locked: Boolean(vehicle.locked), type: vehicle.type };
      current.vehicles.push(vehicle);
      current.locked = current.locked && Boolean(vehicle.locked);
      map.set(key, current);
    });
    return [...map.values()];
  }, [vehicles]);

  // Build a map of unitId -> { conflictUnitIndex, conflictPlate } for every unit whose
  // normalized plate collides with another unit in the same session.
  const plateDuplicateMap = useMemo(() => {
    const result = {};
    // Flatten all (normalized) plates with their owning unit info
    const allEntries = [];
    units.forEach((unit, idx) => {
      unit.vehicles.forEach((v) => {
        const norm = normalizePlate(v.plateNumber);
        if (norm) allEntries.push({ unitId: unit.id, unitIndex: idx + 1, plate: norm });
      });
    });
    // For each unit, look for a cross-unit collision
    units.forEach((unit) => {
      unit.vehicles.forEach((v) => {
        const norm = normalizePlate(v.plateNumber);
        if (!norm || result[unit.id]) return;
        const conflict = allEntries.find((e) => e.plate === norm && e.unitId !== unit.id);
        if (conflict) result[unit.id] = { conflictUnitIndex: conflict.unitIndex, conflictPlate: norm };
      });
    });
    return result;
  }, [units]);
  const hasPlateDuplicates = Object.keys(plateDuplicateMap).length > 0;

  const addGarageVehicle = (savedVehicle) => {
    if (vehicles.some((vehicle) => vehicle.garageVehicleId === savedVehicle.id)) {
      toast.error('This saved vehicle is already included in the booking.', { id: 'garage-dup-error' });
      return;
    }
    const committedVehicles = vehicles.filter((vehicle) => !isUntouchedUnit(vehicle));
    if (calculateBayUsage([...committedVehicles, savedVehicle]) > maxBays) {
      toast.error(`This booking cannot exceed the ${maxBays}-bay business limit.`);
      return;
    }
    updateVehicles((current) => current.length === 1 && isUntouchedUnit(current[0])
      ? [garageVehicleToBookingVehicle(savedVehicle)]
      : [...current, garageVehicleToBookingVehicle(savedVehicle)]);
    toast.success('Vehicle added successfully', { id: 'vehicle-added' });
  };
  const toggleGarageVehicle = (savedVehicle) => {
    if (isGarageVehicleSelected(savedVehicle)) {
      updateVehicles((current) => current.length === 1
        ? [emptyVehicle()]
        : current.filter((vehicle) => vehicle.garageVehicleId !== savedVehicle.id));
      return;
    }
    addGarageVehicle(savedVehicle);
  };

  const addManualVehicle = () => {
    const committedVehicles = vehicles.filter((vehicle) => !isUntouchedUnit(vehicle));
    if (committedVehicles.length && calculateBayUsage([...committedVehicles, { type: 'Sedan' }]) > maxBays) {
      toast.error(`This booking cannot exceed the ${maxBays}-bay business limit.`);
      return;
    }
    // B4: adding a standalone unit must release the current fleet selection.
    // Leaving fleetGroupId set kept the old fleet card highlighted and made a
    // later "add fleet" collide with it, producing a spurious
    // "Every vehicle in this fleet is already included." toast. The fleet is a
    // unit set, so mixing a manual unit into it is an inconsistent state.
    setBookingData((current) => (current.fleetGroupId ? { ...current, fleetGroupId: null } : current));
    updateVehicles((current) => current.length === 1 && isUntouchedUnit(current[0]) ? [emptyVehicle(true)] : [...current, emptyVehicle(true)]);
    toast.success('Vehicle added successfully', { id: 'vehicle-added' });
  };
  const isGarageVehicleSelected = (savedVehicle) => vehicles.some((vehicle) => vehicle.garageVehicleId === savedVehicle.id);

  // ── FLEET TOGGLE (HOTFIX 1) ────────────────────────────────────────────
  // True when this fleet is the ACTIVE selection. Used for the card outline, so
  // the red border reflects real toggle state instead of a stale .some() check.
  const isFleetSelected = (fleetId) => bookingData.fleetGroupId === fleetId;

  /**
   * Deselect a fleet: remove exactly the vehicles that belong to it (matched by
   * their `fleet:${fleetId}:...` unit key) and clear fleetGroupId. Leaves any
   * independently-added vehicles untouched.
   */
  const removeFleet = (fleetId) => {
    const selectedFleet = fleetGroups.find((group) => group.id === fleetId);
    const fleetVehicleIds = new Set((selectedFleet?.vehicles || []).map((vehicle) => vehicle.id));
    updateVehicles((current) => {
      const remaining = current.filter((vehicle) => !(vehicle.fleetGroupId === fleetId || fleetVehicleIds.has(vehicle.garageVehicleId)));
      return remaining.length ? remaining : [emptyVehicle()];
    });
    setBookingData((current) => ({ ...current, fleetGroupId: null }));
    toast.success(`${selectedFleet?.name || 'Fleet'} removed from the booking.`, { id: 'fleet-toggle' });
  };

  /**
   * Fleet card click handler — a REAL toggle.
   *   selected  -> remove the fleet (outline vanishes instantly)
   *   unselected -> add the fleet
   *
   * HOTFIX: error/success toasts carry a STATIC id, so repeated clicks OVERWRITE
   * the existing popup instead of stacking 5+ identical "already included"
   * toasts. The previous handler re-invoked addFleet on an already-selected
   * fleet, which returned early via the duplicate branch BEFORE any state write —
   * so nothing cleared and the red outline stuck permanently.
   */
  const handleFleetToggle = async (fleetId) => {
    if (vehicleAdditionLocked || fleetMutationRef.current) return;
    if (isFleetSelected(fleetId)) {
      removeFleet(fleetId);
      return;
    }
    fleetMutationRef.current = true;
    setFleetToAddId(fleetId);
    try {
      await addFleet(fleetId);
    } finally {
      fleetMutationRef.current = false;
      setFleetToAddId('');
    }
  };

  const addFleet = async (fleetId = fleetToAddId) => {
    const selectedFleet = fleetGroups.find((group) => group.id === fleetId);
    const fleetVehicles = selectedFleet?.vehicles || [];
    if (!fleetId || !fleetVehicles.length) return;
    const uniqueFleetVehicles = uniqueGarageVehicles(fleetVehicles);
    const maxBays = await getBayCapacity().catch(() => NaN);
    if (!Number.isFinite(maxBays) || maxBays <= 0) {
      toast.error('Fleet capacity is unavailable. Ask an administrator to configure the number of bays.');
      return;
    }
    const committedVehicles = vehicles.filter((vehicle) => !isUntouchedUnit(vehicle));
    const requiredBays = calculateBayUsage([...committedVehicles, ...uniqueFleetVehicles]);
    if (requiredBays > maxBays) {
      toast.error(`This fleet needs ${requiredBays} bays, but the business is currently configured for ${maxBays}.`);
      return;
    }
    const existingGarageIds = new Set(vehicles.map((vehicle) => vehicle.garageVehicleId).filter(Boolean));
    const newFleetVehicles = uniqueFleetVehicles.filter((vehicle) => !existingGarageIds.has(vehicle.id));
    if (!newFleetVehicles.length) {
      // Static toast id: repeated clicks overwrite one popup instead of stacking.
      return toast.error('Every vehicle in this fleet is already included.', { id: 'fleet-dup-error' });
    }
    const groupedVehicles = newFleetVehicles.map((vehicle) => garageVehicleToBookingVehicle(vehicle, `fleet:${fleetId}:type:${vehicle.type}`));
    updateVehicles((current) => {
      const base = current.length === 1 && isUntouchedUnit(current[0]) ? [] : current;
      return appendNewGarageVehicles(base, groupedVehicles);
    });
    setBookingData((current) => ({ ...current, fleetGroupId: fleetId }));
    toast.success(`${newFleetVehicles.length} fleet vehicle${newFleetVehicles.length === 1 ? '' : 's'} added in ${new Set(newFleetVehicles.map((vehicle) => vehicle.type)).size} service unit${new Set(newFleetVehicles.map((vehicle) => vehicle.type)).size === 1 ? '' : 's'}.`, { id: 'fleet-toggle' });
  };

  const updateUnit = (unit, patch) => updateVehicles((current) => current.map((vehicle) => unit.vehicles.some((member) => member.id === vehicle.id) ? { ...vehicle, ...patch } : vehicle));

  // 🛡️ SCENARIO 5 — WIZARD BACK-BUTTON / VEHICLE DOWNGRADE STATE CORRUPTION.
  //
  // Puppeteered flow: the customer selects an SUV + expensive packages in Step 3,
  // proceeds to Checkout (Step 4), presses the browser Back button and downgrades
  // the vehicle to a Motorcycle. A generic `updateUnit(unit, { type, services: [] })`
  // cleared `services` but LEFT `package_applied` / `package_price` on the vehicle,
  // so the Step 3/4 cards kept a GHOST package (e.g. "Package: SUV Detailing") and
  // `unitSubtotal()` returned the stale SUV package price for a motorcycle. The
  // grand total then disagreed with the re-derived line items.
  //
  // The correct rule: changing the vehicle TYPE must wipe EVERY type-scoped
  // artefact in one atomic update — the services, the package binding, the
  // package price, and any cached subtotal — because a service/package priced for
  // an SUV is not valid for a motorcycle. Services are re-chosen from scratch.
  const changeUnitType = (unit, nextType) => updateVehicles((current) => current.map((vehicle) => (
    unit.vehicles.some((member) => member.id === vehicle.id)
      ? {
          ...vehicle,
          type: nextType,
          services: [],
          package_applied: null,
          package_price: null,
          subtotal: 0,
        }
      : vehicle
  )));

  const removeUnit = (unit) => updateVehicles((current) => current.length === unit.vehicles.length ? [emptyVehicle()] : current.filter((vehicle) => !unit.vehicles.some((member) => member.id === vehicle.id)));
  // Section 3: an ARCHIVED (soft-deleted) service must not be bookable. The merge
  // in servicesCatalog.js already drops tombstoned built-ins, but a service can
  // also carry the flag on its own row, so the wizard filters defensively here.
  const isServiceBookable = (service) => Boolean(service) && service.archived !== true && service.is_active !== false;

  // A category is offered when it holds a bookable service priced for THIS vehicle
  // category. The price map is the only rule: it already keeps car services off
  // motorcycles (and the reverse) and works unchanged for a category the admin
  // adds in the Business Hub, whatever its name.
  const categoriesFor = (vehicle) => Object.entries(SERVICE_CATALOG)
    .filter(([, services]) => (services || []).some((service) => isServiceBookable(service) && Number(service.prices?.[vehicle.type]) > 0))
    .map(([category]) => category)
    .concat(packagePromosForVehicle(vehicle.type).length ? [PACKAGE_CATEGORY] : []);
  const categoryFor = (unit) => { const categories = categoriesFor(unit.vehicles[0]); return categories.includes(activeCategories[unit.id]) ? activeCategories[unit.id] : categories[0] || ''; };

  // Live package promos that cover THIS vehicle type (every service they need is on sale for it).
  function packagePromosForVehicle(vehicleType) {
    const type = String(vehicleType || '').trim();
    if (!type) return [];
    const all = Object.values(SERVICE_CATALOG).flat().filter(isServiceBookable);
    return (activePromos || []).filter((rule) => {
      if (!isPackageRule(rule) || !isPromoActiveForNow(rule)) return false;
      const names = getPackageServicesForVehicle(rule, type);
      return names.length > 0 && names.every((name) => all.some((svc) => String(svc.name).trim().toLowerCase() === name.toLowerCase() && Number(svc.prices?.[type]) > 0));
    });
  }

  // One tap adds every service of the package (or removes them again); the pricing engine then charges the flat price.
  const togglePackage = (unit, rule) => {
    const all = Object.values(SERVICE_CATALOG).flat().filter(isServiceBookable);
    updateVehicles((current) => current.map((vehicle) => {
      if (!unit.vehicles.some((member) => member.id === vehicle.id)) return vehicle;
      const names = getPackageServicesForVehicle(rule, vehicle.type).map((name) => name.toLowerCase());
      const has = (vehicle.services || []).filter((item) => names.includes(String(item.name).toLowerCase()));
      const on = vehicle.package_applied === rule.name;
      const kept = (vehicle.services || []).filter((item) => !on || !names.includes(String(item.name).toLowerCase()));
      const added = on ? [] : names
        .filter((name) => !has.some((item) => String(item.name).toLowerCase() === name))
        .map((name) => all.find((svc) => String(svc.name).trim().toLowerCase() === name))
        .filter(Boolean)
        .map((svc) => ({ ...svc, runtime_uuid: newId(), price: Number(svc.prices[vehicle.type] || 0) }));
      const { services: pricedServices, package: activePackage } = priceVehicleServices(vehicle.type, [...kept, ...added]);
      return { ...vehicle, services: pricedServices, package_applied: activePackage ? activePackage.name : null, package_price: activePackage ? activePackage.packagePrice : null };
    }));
  };

  // The booking creator decides whether a service's promo is used.
  const togglePromoUse = (unit, service) => {
    updateVehicles((current) => current.map((vehicle) => {
      if (!unit.vehicles.some((member) => member.id === vehicle.id)) return vehicle;
      const next = (vehicle.services || []).map((item) => item.id === service.id ? { ...item, skip_promo: !item.skip_promo } : item);
      const { services: pricedServices, package: activePackage } = priceVehicleServices(vehicle.type, next);
      return { ...vehicle, services: pricedServices, package_applied: activePackage ? activePackage.name : null, package_price: activePackage ? activePackage.packagePrice : null };
    }));
  };

  const toggleService = (unit, service) => {
    const selected = unit.vehicles.every((vehicle) => vehicle.services?.some((item) => item.id === service.id));

    updateVehicles((current) => current.map((vehicle) => {
      if (!unit.vehicles.some((member) => member.id === vehicle.id)) return vehicle;

      // 1. Apply the raw toggle to this vehicle's service list.
      const rawServices = selected
        ? (vehicle.services || []).filter((item) => item.id !== service.id)
        : [
            ...(vehicle.services || []),
            { ...service, runtime_uuid: newId(), price: Number(service.prices[vehicle.type] || 0) },
          ];

      // 2. Re-price the WHOLE vehicle. This is what lets a package turn on/off
      //    the moment its required set is completed or broken — a package is a
      //    whole-vehicle product, not a per-service discount.
      const { services: pricedServices, package: activePackage } = priceVehicleServices(vehicle.type, rawServices);

      return {
        ...vehicle,
        services: pricedServices,
        package_applied: activePackage ? activePackage.name : null,
        package_price: activePackage ? activePackage.packagePrice : null,
      };
    }));
  };

  const hasVehicleSelection = vehicles.some((vehicle) => vehicle.manual || vehicle.garageVehicleId || vehicle.fleetGroupId || Boolean(vehicle.type && vehicle.brand?.trim() && vehicle.model?.trim() && vehicle.plateNumber?.trim()));
  const hasAdminCustomerDetails = !adminMode || Boolean(bookingData.adminCustomerReady || (bookingData.customerId && bookingData.customerName && bookingData.customerEmail && bookingData.contactNumber));
  const showServiceConfiguration = hasVehicleSelection && hasAdminCustomerDetails;
  // validUnits also blocks when any plate collision is active
  const validUnits = showServiceConfiguration && !hasPlateDuplicates && vehicles.length > 0 && calculateBayUsage(vehicles) <= maxBays && vehicles.every((vehicle) => vehicle.type && vehicle.brand?.trim() && vehicle.model?.trim() && vehicle.plateNumber?.trim().length >= 4 && vehicle.services?.length);
  // A promo code lessens the order total once (never each service).
  const codeDiscount = calculateBookingDiscountSummary(vehicles, null, bookingData.promoRule || null).codeDiscount;
  const grandTotal = Math.max(0, vehicles.reduce((total, vehicle) => total + unitSubtotal(vehicle), 0) - codeDiscount);

  // Vehicle-addition subcontainer is locked when customer details are missing (admin) OR when
  // a plate duplicate must be resolved first.
  const vehicleAdditionLocked = (adminMode && !hasAdminCustomerDetails) || hasPlateDuplicates;
  const vehicleAdditionLockMessage = (adminMode && !hasAdminCustomerDetails)
    ? 'Complete customer details first'
    : 'Resolve duplicate plate numbers to add more vehicles';

  return <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
    <style>{`.booking-unit-columns{display:grid;grid-template-columns:1fr}.booking-unit-column{padding:1.25rem;border-top:1px solid var(--admin-border)}.booking-addable-card:hover:not(:disabled){transform:translateY(-4px);border-color:var(--admin-brand)!important;box-shadow:0 10px 20px rgba(var(--admin-brand-rgb),.18)}.booking-addable-card:focus,.booking-addable-card:focus-visible{outline:none}@media(min-width:900px){.booking-unit-columns{grid-template-columns:minmax(180px,.75fr) minmax(300px,1.6fr) minmax(220px,.9fr)}.booking-unit-column{border-top:0;border-left:1px solid var(--admin-border)}.booking-unit-column:first-child{border-left:0}}.vehicle-addition-locked{opacity:.38;filter:grayscale(.6);pointer-events:none;user-select:none;cursor:not-allowed}.vehicle-addition-locked *{pointer-events:none!important;tabindex:"-1"}`}</style>
    <section
      aria-disabled={vehicleAdditionLocked || undefined}
      style={{
        padding: '1.25rem',
        border: `1px solid ${vehicleAdditionLocked ? 'var(--admin-border)' : 'var(--admin-border)'}`,
        borderRadius: 'var(--admin-radius)',
        background: vehicleAdditionLocked ? 'var(--admin-bg)' : 'rgba(var(--admin-brand-rgb), .025)',
        position: 'relative',
        transition: 'opacity 0.3s ease, filter 0.3s ease, background 0.3s ease'
      }}
    >
      {/* Locked state overlay — blocks pointer events and keyboard access via inert-like wrapper */}
      {vehicleAdditionLocked && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, zIndex: 10,
            borderRadius: 'var(--admin-radius)',
            cursor: 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: '.6rem',
            background: 'var(--admin-card)',
            border: '1px solid var(--admin-border)',
            borderRadius: '6px',
            padding: '.6rem 1rem',
            boxShadow: '0 4px 16px rgba(0,0,0,.25)',
            color: 'var(--admin-text-secondary)',
            fontSize: '.72rem', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '.5px',
            pointerEvents: 'none'
          }}>
            <Lock size={14} />
            {vehicleAdditionLockMessage}
          </div>
        </div>
      )}
      {/* Inner content — visually dimmed and non-interactive when locked */}
      <div
        className={vehicleAdditionLocked ? 'vehicle-addition-locked' : undefined}
        style={{ pointerEvents: vehicleAdditionLocked ? 'none' : undefined }}
      >
        <h2 style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '1rem', fontWeight: '950', textTransform: 'uppercase' }}>1. Add vehicle units</h2>
        <p style={{ margin: '.4rem 0 1rem', color: 'var(--admin-text-secondary)', fontSize: '.8rem' }}>Choose how to add units: book an entire saved FLEET at once, or add INDIVIDUAL vehicles one by one.</p>

        {/* 🛠️ Fix 1: explicit Fleet / Individual mode switch (clean separation). */}
        <div role="tablist" aria-label="Vehicle addition mode" style={{ display: 'flex', gap: '.5rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--admin-border)' }}>
          <button
            type="button"
            role="tab"
            aria-selected={additionMode === 'fleet'}
            disabled={vehicleAdditionLocked || fleetGroups.length === 0}
            onClick={() => setAdditionMode('fleet')}
            style={{
              display: 'flex', alignItems: 'center', gap: '.5rem',
              padding: '.7rem 1.1rem', background: 'transparent', border: 'none',
              borderBottom: `3px solid ${additionMode === 'fleet' ? 'var(--admin-brand)' : 'transparent'}`,
              color: additionMode === 'fleet' ? 'var(--admin-brand)' : 'var(--admin-text-secondary)',
              fontWeight: 950, fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.5px',
              cursor: (vehicleAdditionLocked || fleetGroups.length === 0) ? 'not-allowed' : 'pointer',
              opacity: fleetGroups.length === 0 ? .45 : 1,
            }}
          >
            <Layers size={15} /> Book by Fleet
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={additionMode === 'individual'}
            disabled={vehicleAdditionLocked}
            onClick={() => setAdditionMode('individual')}
            style={{
              display: 'flex', alignItems: 'center', gap: '.5rem',
              padding: '.7rem 1.1rem', background: 'transparent', border: 'none',
              borderBottom: `3px solid ${additionMode === 'individual' ? 'var(--admin-brand)' : 'transparent'}`,
              color: additionMode === 'individual' ? 'var(--admin-brand)' : 'var(--admin-text-secondary)',
              fontWeight: 950, fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.5px',
              cursor: vehicleAdditionLocked ? 'not-allowed' : 'pointer',
            }}
          >
            <Car size={15} /> Individual Vehicles
          </button>
        </div>

        {/* ── TAB A: BOOK BY FLEET ─────────────────────────────────────── */}
        {additionMode === 'fleet' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.65rem', marginBottom: '1rem' }}>
            <label style={{ color: 'var(--admin-text-secondary)', fontSize: '.72rem', fontWeight: '900', textTransform: 'uppercase' }}>Your fleets</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.75rem' }}>
              {fleetGroups.map((group) => {
                const active = bookingData.fleetGroupId === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    tabIndex={vehicleAdditionLocked ? -1 : undefined}
                    aria-pressed={active}
                    title={active ? `Remove ${group.name} from this booking` : `Add ${group.name}`}
                    onClick={() => handleFleetToggle(group.id)}
                    className="booking-addable-card"
                    style={{
                      padding: '.75rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem',
                      background: active ? 'rgba(var(--admin-brand-rgb), 0.08)' : 'var(--admin-bg)',
                      color: 'var(--admin-text-primary)',
                      border: `2px solid ${active ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                      borderRadius: '6px', cursor: vehicleAdditionLocked ? 'not-allowed' : 'pointer',
                      textAlign: 'left', transition: 'border-color .2s ease, background .2s ease',
                    }}
                  >
                    <Layers size={16} color="var(--admin-brand)" />
                    <span>
                      <strong style={{ display: 'block' }}>{group.name}</strong>
                      <small style={{ color: 'var(--admin-text-secondary)' }}>
                        {active ? 'Added to booking · click to remove' : `${group.vehicles?.length || 0} vehicle units`}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── TAB B: INDIVIDUAL VEHICLES ───────────────────────────────── */}
        {additionMode === 'individual' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.75rem' }}>
            {garageVehicles.map((vehicle) => {
              const selected = isGarageVehicleSelected(vehicle);
              return (
                <button
                  key={vehicle.id}
                  type="button"
                  tabIndex={vehicleAdditionLocked ? -1 : undefined}
                  aria-pressed={selected}
                  onClick={() => toggleGarageVehicle(vehicle)}
                  title={selected ? `Remove ${vehicle.brand} ${vehicle.model} from this booking` : `Add ${vehicle.brand} ${vehicle.model}`}
                  className="booking-addable-card"
                  style={{
                    padding: '.75rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem',
                    background: selected ? 'rgba(var(--admin-brand-rgb), 0.08)' : 'var(--admin-bg)',
                    color: 'var(--admin-text-primary)',
                    border: `2px solid ${selected ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                    borderRadius: '6px', cursor: vehicleAdditionLocked ? 'not-allowed' : 'pointer',
                    textAlign: 'left', opacity: selected ? .9 : 1,
                    transition: 'transform .2s ease, border-color .2s ease, box-shadow .2s ease',
                  }}
                >
                  <Car size={16} color="var(--admin-brand)" />
                  <span>
                    <strong style={{ display: 'block' }}>{vehicle.brand} {vehicle.model}</strong>
                    <small style={{ color: 'var(--admin-text-secondary)' }}>
                      {selected ? 'Added to booking · click to remove' : `${vehicle.plate_number} · ${vehicle.type}`}
                    </small>
                  </span>
                </button>
              );
            })}
            {!showServiceConfiguration && <button
              type="button"
              tabIndex={vehicleAdditionLocked ? -1 : undefined}
              onClick={addManualVehicle}
              className="booking-addable-card"
              style={{ padding: '.75rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem', background: 'transparent', color: 'var(--admin-brand)', border: '1px dashed var(--admin-brand)', borderRadius: '6px', fontWeight: '900', cursor: vehicleAdditionLocked ? 'not-allowed' : 'pointer', transition: 'transform .2s ease, border-color .2s ease, box-shadow .2s ease' }}
            >
              <Plus size={16} /> ADD NEW VEHICLE
            </button>}
            {onCancelNewVehicle && (
              <button type="button" onClick={onCancelNewVehicle} title="Cancel adding this vehicle" style={{ padding: '.75rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem', background: 'transparent', color: 'var(--status-danger)', border: '1px dashed var(--status-danger)', borderRadius: '6px', fontWeight: '900', cursor: 'pointer' }}>
                <X size={16} /> CANCEL ADD NEW VEHICLE
              </button>
            )}
          </div>
        )}
      </div>
    </section>
    {showServiceConfiguration && <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div><h2 style={{ margin: 0, color: 'var(--admin-text-primary)', fontSize: '1rem', fontWeight: '950', textTransform: 'uppercase' }}>2. Configure services by unit</h2><p style={{ margin: '.4rem 0 0', color: 'var(--admin-text-secondary)', fontSize: '.8rem' }}>A fleet unit applies its selected services to all of its same-type vehicles.</p></div>
      {/* Premise 4: the standalone "Available promotions by vehicle" disclosure
          used to sit here as a full-width block, duplicating - and out-shouting -
          the actual service selection. Promotions now live INSIDE each unit's
          "Promos" service type (column A), scoped to that vehicle, so this block
          is removed to give the necessary controls their space back. */}
      {units.map((unit, index) => {
        const vehicle = unit.vehicles[0]; const complete = Boolean(vehicle.type && vehicle.brand?.trim() && vehicle.model?.trim() && vehicle.plateNumber?.trim().length >= 4);
        const category = categoryFor(unit); const categories = categoriesFor(vehicle);
        // 'Archived' is a hard exclusion, not a display flag: an archived service
        // never appears in the picker at all (Section 3 — archived services must
        // not be bookable by the customer).
        const services = (SERVICE_CATALOG[category] || []).filter(isServiceBookable);
        const selectedServices = vehicle.services || [];
        const unitGross = unit.vehicles.reduce((sum, member) => sum + unitGrossSubtotal(member), 0);
        const total = unit.vehicles.reduce((sum, member) => sum + unitSubtotal(member), 0);
        const unitDiscount = Math.max(0, unitGross - total);

        return <article key={unit.id} style={{ overflow: 'hidden', background: 'var(--admin-card)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)', boxShadow: 'var(--admin-card-shadow)' }}>
          <header style={{ padding: '1rem 1.25rem', display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', background: 'var(--admin-sidebar)', borderBottom: '1px solid var(--admin-border)' }}><div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', minWidth: 0 }}><span style={{ background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', padding: '.2rem .45rem', borderRadius: '4px', fontSize: '.68rem', fontWeight: '900' }}>UNIT {index + 1}</span><Car size={17} color="var(--admin-brand)" /><strong style={{ color: 'var(--admin-text-primary)' }}>{unit.locked ? `${unit.vehicles.length} saved ${vehicle.type || 'vehicle'}${unit.vehicles.length === 1 ? '' : 's'}` : (vehicle.brand && vehicle.model ? `${vehicle.brand} ${vehicle.model}` : 'New vehicle details required')}</strong></div><button type="button" onClick={() => removeUnit(unit)} aria-label={`Remove unit ${index + 1}`} style={{ background: 'transparent', color: 'var(--status-danger)', border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '.35rem', fontWeight: '800', fontSize: '.72rem' }}><Trash2 size={15} /> REMOVE</button></header>
          {unit.locked ? <div style={{ padding: '1rem 1.25rem', background: 'var(--admin-bg)', borderBottom: '1px solid var(--admin-border)' }}><div style={{ display: 'flex', alignItems: 'center', gap: '.45rem', color: 'var(--admin-text-secondary)', fontSize: '.7rem', fontWeight: '900', textTransform: 'uppercase', marginBottom: '.6rem' }}><Lock size={14} /> Saved vehicle details are locked</div>{unit.vehicles.map((member) => <div key={member.id} style={{ color: 'var(--admin-text-primary)', fontSize: '.8rem', lineHeight: 1.7 }}>{member.brand} {member.model} · {member.plateNumber} · {member.type}</div>)}</div> : <div style={{ padding: '1.25rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.75rem', borderBottom: '1px solid var(--admin-border)' }}><select aria-label="Vehicle type" value={vehicle.type} onChange={(event) => changeUnitType(unit, event.target.value)} style={inputStyle}><option value="">Vehicle type</option>{vehicleTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><input aria-label="Vehicle brand" value={vehicle.brand} onChange={(event) => updateUnit(unit, { brand: sanitizeVehicleText(event.target.value) })} placeholder="Brand" style={inputStyle} /><input aria-label="Vehicle model" value={vehicle.model} onChange={(event) => updateUnit(unit, { model: sanitizeVehicleText(event.target.value) })} placeholder="Model" style={inputStyle} /><div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}><input aria-label="Vehicle plate number" value={vehicle.plateNumber} onChange={(event) => updateUnit(unit, { plateNumber: sanitizeVehiclePlate(event.target.value) })} onBlur={() => {/* duplicate check fires via useMemo on every render */}} placeholder="Plate number" style={{ ...inputStyle, ...(plateDuplicateMap[unit.id] ? { border: '1.5px solid #ef4444', boxShadow: '0 0 0 3px rgba(239,68,68,0.15)', outline: 'none' } : {}) }} />{plateDuplicateMap[unit.id] && <span role="alert" style={{ display: 'block', fontSize: '.65rem', color: 'var(--status-danger)', fontWeight: '800', lineHeight: 1.35, paddingTop: '.1rem' }}>Duplicate Entry: Plate number &lsquo;{plateDuplicateMap[unit.id].conflictPlate}&rsquo; is already assigned to Unit {plateDuplicateMap[unit.id].conflictUnitIndex}.</span>}</div></div>}
          <div className="booking-unit-columns" style={{ opacity: complete ? 1 : .45, pointerEvents: complete ? 'auto' : 'none' }}>
            <div className="booking-unit-column"><p style={{ margin: '0 0 .75rem', fontSize: '.68rem', color: 'var(--admin-text-secondary)', fontWeight: '900', textTransform: 'uppercase' }}>A. Service type</p>{categories.map((item) => <button key={item} type="button" onClick={() => setActiveCategories((current) => ({ ...current, [unit.id]: item }))} style={{ width: '100%', marginBottom: '.5rem', padding: '.75rem', textAlign: 'left', borderRadius: '6px', border: `1px solid ${category === item ? 'var(--admin-brand)' : 'var(--admin-border)'}`, background: category === item ? 'var(--admin-brand)' : 'var(--admin-bg)', color: category === item ? '#fff' : 'var(--admin-text-primary)', cursor: 'pointer', fontWeight: '800', fontSize: '.78rem' }}>{item}</button>)}</div>
            <div className="booking-unit-column">
              <p style={{ margin: '0 0 .75rem', fontSize: '.68rem', color: 'var(--admin-text-secondary)', fontWeight: '900', textTransform: 'uppercase' }}>B. Select services</p>
              {category === PACKAGE_CATEGORY ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                  {packagePromosForVehicle(vehicle.type).map((rule) => {
                    const names = getPackageServicesForVehicle(rule, vehicle.type);
                    const on = unit.vehicles.every((member) => member.package_applied === rule.name);
                    const standalone = getPackageStandaloneSum(rule, vehicle.type);
                    return (
                      <button key={rule.id || rule.name} type="button" onClick={() => togglePackage(unit, rule)} aria-pressed={on}
                        style={{ width: '100%', textAlign: 'left', padding: '.85rem', borderRadius: '6px', cursor: 'pointer', color: 'var(--admin-text-primary)', background: on ? 'rgba(var(--admin-brand-rgb), .08)' : 'var(--admin-bg)', border: `1px solid ${on ? 'var(--admin-brand)' : 'var(--admin-border)'}`, display: 'flex', gap: '.75rem', alignItems: 'flex-start' }}>
                        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 19, height: 19, borderRadius: 4, flexShrink: 0, border: `1.5px solid ${on ? 'var(--admin-brand)' : 'var(--admin-text-secondary)'}`, background: on ? 'var(--admin-brand)' : 'transparent', color: 'var(--admin-text-on-brand)' }}>{on ? <Check size={13} strokeWidth={3.5} /> : null}</span>
                        <span style={{ flex: 1 }}>
                          <strong style={{ fontSize: '.85rem' }}>{rule.name}</strong>
                          <small style={{ display: 'block', marginTop: '.2rem', color: 'var(--admin-text-secondary)', lineHeight: 1.4 }}>Includes: {names.join(', ')}</small>
                        </span>
                        <span style={{ textAlign: 'right' }}>
                          {standalone > Number(rule.value || 0) && <div style={{ textDecoration: 'line-through', opacity: 0.5, fontSize: '.72rem', color: 'var(--admin-text-secondary)' }}>₱{standalone.toLocaleString()}</div>}
                          <strong style={{ color: '#10b981', whiteSpace: 'nowrap' }}>₱{Number(rule.value || 0).toLocaleString()}</strong>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
              <>
              {services.map((service) => {
                const basePrice = Number(service.prices[vehicle.type] || 0);
                if (!basePrice) return null;
                const selected = unit.vehicles.every((member) => member.services?.some((item) => item.id === service.id));
                const promoSkipped = selected && Boolean(vehicle.services?.find((item) => item.id === service.id)?.skip_promo);
                const promoInfo = promoSkipped ? null : getBestPromoForService(vehicle.type, service.name, basePrice);
                const effectivePrice = promoInfo ? promoInfo.effectivePrice : basePrice;
                const hasDiscount = promoInfo && promoInfo.discountAmount > 0;

                return (
                  <label
                    key={service.id}
                    style={{
                      width: '100%',
                      marginBottom: '.6rem',
                      padding: '.85rem',
                      display: 'flex',
                      gap: '.75rem',
                      textAlign: 'left',
                      // `relative` anchors the visually-hidden checkbox below, so it
                      // stays inside this row instead of escaping to the page body.
                      position: 'relative',
                      background: selected ? 'rgba(var(--admin-brand-rgb), .08)' : 'var(--admin-bg)',
                      color: 'var(--admin-text-primary)',
                      border: `1px solid ${selected ? 'var(--admin-brand)' : 'var(--admin-border)'}`,
                      borderRadius: '6px',
                      cursor: 'pointer'
                    }}
                  >
                    {/* Section 4.1: a standard HTML checkbox drives selection (bound
                        to the derived `selected` state). Visually hidden so the row
                        keeps its dark-theme card look, but it stays a real, focusable,
                        screen-reader-announced control. */}
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleService(unit, service)}
                      aria-label={`Select ${service.name}`}
                      style={{
                        position: 'absolute',
                        width: 1,
                        height: 1,
                        padding: 0,
                        margin: -1,
                        overflow: 'hidden',
                        clip: 'rect(0, 0, 0, 0)',
                        whiteSpace: 'nowrap',
                        border: 0
                      }}
                    />
                    <span aria-hidden="true">
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 19,
                        height: 19,
                        borderRadius: 4,
                        border: `1.5px solid ${selected ? 'var(--admin-brand)' : 'var(--admin-text-secondary)'}`,
                        background: selected ? 'var(--admin-brand)' : 'transparent',
                        color: 'var(--admin-text-on-brand)'
                      }}>
                        {selected ? <Check size={13} strokeWidth={3.5} /> : null}
                      </span>
                    </span>
                    <span style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '.85rem' }}>{service.name}</strong>
                        {hasDiscount && (
                          <span style={{ background: '#059669', color: 'var(--admin-text-on-brand)', fontSize: '.62rem', padding: '.12rem .38rem', borderRadius: '3px', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                            {promoInfo.tagText}
                          </span>
                        )}
                      </div>
                      <small style={{ display: 'block', marginTop: '.2rem', color: 'var(--admin-text-secondary)', lineHeight: 1.4 }}>{service.desc}</small>
                    </span>
                    <div style={{ textAlign: 'right' }}>
                      {hasDiscount && (
                        <div style={{ textDecoration: 'line-through', opacity: 0.5, fontSize: '.72rem', color: 'var(--admin-text-secondary)' }}>
                          ₱{basePrice.toLocaleString()}
                        </div>
                      )}
                      <strong style={{ color: hasDiscount ? '#10b981' : 'var(--admin-brand)', whiteSpace: 'nowrap' }}>
                        ₱{effectivePrice.toLocaleString()}
                      </strong>
                    </div>
                  </label>
                );
              })}
              </>
              )}
            </div>
            <aside className="booking-unit-column" style={{ background: 'rgba(var(--admin-brand-rgb), .025)', display: 'flex', flexDirection: 'column' }}>
              <p style={{ margin: '0 0 .75rem', fontSize: '.68rem', color: 'var(--admin-text-secondary)', fontWeight: '900', textTransform: 'uppercase' }}>C. Unit summary</p>
              <strong style={{ color: 'var(--admin-text-primary)', fontSize: '.85rem' }}>{unit.locked ? `${unit.vehicles.length} ${vehicle.type} vehicle${unit.vehicles.length === 1 ? '' : 's'}` : `${vehicle.brand} ${vehicle.model}`}</strong>
              <small style={{ color: 'var(--admin-text-secondary)', marginBottom: '1rem' }}>{unit.locked ? 'The selected services apply to every listed vehicle.' : `${vehicle.plateNumber} · ${vehicle.type}`}</small>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.55rem', flex: 1 }}>
                {selectedServices.length ? (
                  vehicle.package_applied ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.35)', borderRadius: '6px', padding: '.5rem .6rem', marginBottom: '.35rem' }}>
                        <Layers size={14} color="var(--status-success)" />
                        <strong style={{ color: 'var(--status-success)', fontSize: '.78rem' }}>Package: {vehicle.package_applied}</strong>
                      </div>
                      <small style={{ color: 'var(--admin-text-secondary)', fontSize: '.68rem', textTransform: 'uppercase', fontWeight: '800' }}>Includes</small>
                      {selectedServices.map((service) => (
                        <div key={service.id} style={{ display: 'flex', gap: '.5rem', justifyContent: 'space-between', color: 'var(--admin-text-secondary)', fontSize: '.76rem' }}>
                          <span>{service.name}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                            <span style={{ textDecoration: 'line-through', opacity: .65 }}>₱{Number(service.original_price || service.price || 0).toLocaleString()}</span>
                            <button type="button" onClick={() => toggleService(unit, service)} aria-label={`Remove ${service.name}`} style={{ color: 'var(--status-danger)', background: 'none', border: 0, cursor: 'pointer' }}><X size={15} /></button>
                          </div>
                        </div>
                      ))}
                    </>
                  ) : (
                    selectedServices.map((service) => {
                      const sPrice = vehicleServiceNetPrice(service);
                      return (
                        <div key={service.id} style={{ display: 'flex', gap: '.5rem', justifyContent: 'space-between', color: 'var(--admin-text-primary)', fontSize: '.78rem' }}>
                          <span>
                            {service.name}{unit.vehicles.length > 1 ? ` × ${unit.vehicles.length}` : ''}
                            {(service.skip_promo || service.applied_promo) && (
                              <button type="button" onClick={() => togglePromoUse(unit, service)} style={{ marginLeft: '.35rem', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--admin-text-secondary)', fontSize: '.68rem', fontWeight: 800, textDecoration: 'underline' }}>
                                {service.skip_promo ? 'Use promo' : 'Skip promo'}
                              </button>
                            )}
                            {service.applied_promo && (
                              <span style={{ marginLeft: '.35rem', color: 'var(--status-success)', fontSize: '.7rem', fontWeight: '700' }}>
                                ({service.applied_promo})
                              </span>
                            )}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                            <span style={{ fontWeight: '700' }}>₱{(sPrice * unit.vehicles.length).toLocaleString()}</span>
                            <button type="button" onClick={() => toggleService(unit, service)} aria-label={`Remove ${service.name}`} style={{ color: 'var(--status-danger)', background: 'none', border: 0, cursor: 'pointer' }}><X size={15} /></button>
                          </div>
                        </div>
                      );
                    })
                  )
                ) : <small style={{ color: 'var(--admin-text-secondary)' }}>No services selected yet.</small>}
              </div>
              <div style={{ marginTop: '1rem', paddingTop: '.85rem', borderTop: '1px solid var(--admin-border)' }}>
                {unitDiscount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '.35rem', fontSize: '.75rem', color: 'var(--admin-text-secondary)' }}>
                    <span>{vehicle.package_applied ? 'Services total' : 'Gross subtotal'}</span>
                    <span style={{ textDecoration: 'line-through' }}>₱{unitGross.toLocaleString()}</span>
                  </div>
                )}
                {unitDiscount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '.35rem', fontSize: '.75rem', color: 'var(--status-success)', fontWeight: '800' }}>
                    <span>{vehicle.package_applied ? 'Package savings' : 'Promo Discount'}</span>
                    <span>-₱{unitDiscount.toLocaleString()}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: '.7rem', fontWeight: '900', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>{vehicle.package_applied ? 'Package price' : 'Unit subtotal'}</span>
                  <strong style={{ color: 'var(--admin-brand)', fontSize: '1.2rem' }}>₱{total.toLocaleString()}</strong>
                </div>
              </div>
            </aside>
          </div>{!complete && <p style={{ margin: 0, padding: '.75rem 1.25rem', color: 'var(--admin-text-secondary)', fontSize: '.75rem', background: 'var(--admin-bg)' }}>Complete this vehicle's details to unlock its services.</p>}
        </article>;
      })}
      <button
        type="button"
        onClick={addManualVehicle}
        disabled={vehicleAdditionLocked}
        className="booking-addable-card"
        style={{ alignSelf: 'stretch', padding: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.5rem', background: 'transparent', color: 'var(--admin-brand)', border: '1px dashed var(--admin-brand)', borderRadius: '6px', fontWeight: '900', cursor: vehicleAdditionLocked ? 'not-allowed' : 'pointer', opacity: vehicleAdditionLocked ? 0.5 : 1 }}
      >
        <Plus size={16} /> ADD ANOTHER VEHICLE
      </button>
    </section>}
    {/* The promo code is entered HERE, with the services, so the total and the downpayment are final before the
        customer reaches the payment page. (On the payment page it came too late: a receipt could already be
        uploaded for the old amount.) */}
    {(!adminMode || bookingData.customerId) && (
      <PromoCodeBox
        promoCode={bookingData.promoCode}
        promoRule={bookingData.promoRule}
        onApplied={(rule) => setBookingData((prev) => ({ ...prev, promoCode: rule.code, promoRule: rule }))}
        onRemoved={() => setBookingData((prev) => ({ ...prev, promoCode: null, promoRule: null }))}
      />
    )}
    <footer style={{ padding: '1.25rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', background: 'var(--admin-sidebar)', border: '1px solid var(--admin-border)', borderRadius: 'var(--admin-radius)' }}><div><span style={{ color: 'var(--admin-text-secondary)', fontWeight: '800', fontSize: '.72rem', textTransform: 'uppercase' }}>Booking estimate · {vehicles.length} vehicle{vehicles.length === 1 ? '' : 's'} in {units.length} unit{units.length === 1 ? '' : 's'}</span>{codeDiscount > 0 && <span style={{ display: 'block', color: 'var(--status-success)', fontWeight: 800, fontSize: '.78rem' }}>Promo code {bookingData.promoRule?.code}: −₱{codeDiscount.toLocaleString()} off the total</span>}<strong style={{ display: 'block', color: 'var(--admin-brand)', fontSize: '1.6rem' }}>₱{grandTotal.toLocaleString()}</strong></div><div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap' }}>{onCancel && <button type="button" onClick={onCancel} style={{ padding: '.9rem 1.25rem', background: 'transparent', color: 'var(--status-danger)', border: '1px solid #ef4444', borderRadius: '6px', fontWeight: '900', cursor: 'pointer' }}>CANCEL</button>}<button type="button" disabled={!validUnits} title={!validUnits ? 'Complete every vehicle unit and select at least one service for each.' : ''} onClick={onNext} style={{ padding: '.9rem 1.25rem', background: validUnits ? 'var(--admin-brand)' : 'var(--admin-bg)', color: validUnits ? '#fff' : 'var(--admin-text-secondary)', border: `1px solid ${validUnits ? 'var(--admin-brand)' : 'var(--admin-border)'}`, borderRadius: '6px', fontWeight: '900', cursor: validUnits ? 'pointer' : 'not-allowed', opacity: validUnits ? 1 : .5 }}>PROCEED TO SCHEDULE</button></div></footer>
  </div>;
};

export default Step2Services;
