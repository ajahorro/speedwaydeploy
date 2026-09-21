export const SERVICES_DATA = {
  "Exclusive Packages": [
    { id: "pkg_1", name: "Showroom Shine (Pkg 1)", desc: "The ultimate refresh: VIP wash, engine wash, tire mags detailing, and hand glass watermarks removal.", prices: { Sedan: 2500, SUV: 3500 }, estTime: "4 Hours", durationMinutes: 240 },
    { id: "pkg_2", name: "Ultimate Protection (Pkg 2)", desc: "Machine polish for swirl removal, paint protection wax, and BTZ interior disinfection.", prices: { Sedan: 3500, SUV: 4500 }, estTime: "5 Hours", durationMinutes: 300 },
  ],
  "Premium Car Wash": [
    { id: "wash_1", name: "Regular Wash", desc: "Professional exterior cleaning using high-quality automotive soap and microfiber drying.", prices: { Sedan: 150, SUV: 180, "Van/L300": 300 }, estTime: "1 Hour", durationMinutes: 60 },
    { id: "wash_2", name: "Supreme Wash", desc: "Advanced wash including high-gloss treatment, degreaser, and protective wax.", prices: { Sedan: 500, SUV: 600, "Van/L300": 800 }, estTime: "2 Hours", durationMinutes: 120 },
  ],
  "Specialized Exterior Care": [
    { id: "ext_1", name: "Spot Removal", desc: "Targeted removal of localized stains and blemishes from the paint surface.", prices: { Sedan: 1000, SUV: 1500, "Van/L300": 2000 }, estTime: "1-2 Hours", durationMinutes: 90 },
    { id: "ext_2", name: "Acid Rain Removal (Hand)", desc: "Manual removal of water spots and acid rain marks to restore surface clarity.", prices: { Sedan: 600, SUV: 800, "Van/L300": 1000 }, estTime: "2 Hours", durationMinutes: 120 },
    { id: "ext_3", name: "Acid Rain Removal (Machine)", desc: "Machine-buffed treatment for deep water spot and acid rain mark removal.", prices: { Sedan: 1000, SUV: 1500, "Van/L300": 2000 }, estTime: "3 Hours", durationMinutes: 180 },
    { id: "ext_4", name: "Engine Wash", desc: "Safe and thorough cleaning of the engine bay to remove accumulated grease and dirt.", prices: { Sedan: 500, SUV: 800, "Van/L300": 1000 }, estTime: "1 Hour", durationMinutes: 60 },
    { id: "ext_5", name: "Headlight Polish", desc: "Restores yellowed or hazy headlights to original factory clarity.", prices: { Sedan: 800, SUV: 1000, "Van/L300": 1300 }, estTime: "1.5 Hours", durationMinutes: 90 },
    { id: "ext_6", name: "Asphalt Removal", desc: "Removes road tar and asphalt splatters without affecting the paint finish.", prices: { Sedan: 700, SUV: 900, "Van/L300": 1200 }, estTime: "2 Hours", durationMinutes: 120 },
    { id: "ext_7", name: "Buff Wax (Machine)", desc: "Machine-applied premium wax for an ultra-smooth and protective finish.", prices: { Sedan: 1000, SUV: 1500, "Van/L300": 2500 }, estTime: "2-3 Hours", durationMinutes: 150 },
    { id: "ext_8", name: "Mags Detailing", desc: "Deep cleaning and polishing of wheels and rims to remove brake dust and oxidation.", prices: { Sedan: 1200, SUV: 2000, "Van/L300": 2800 }, estTime: "2 Hours", durationMinutes: 120 },
  ],
  "Interior & Cabin Care": [
    { id: "int_1", name: "Interior Detailing", desc: "Deep extraction, shampooing, and disinfection of all interior cabin surfaces.", prices: { Sedan: 4500, SUV: 5500, "Van/L300": 6500 }, estTime: "4-5 Hours", durationMinutes: 270 },
    { id: "int_2", name: "Back to Zero", desc: "Ozone treatment and antibacterial fogging to eliminate odors and germs.", prices: { Sedan: 350, SUV: 400, "Van/L300": 600 }, estTime: "30 Mins", durationMinutes: 30 },
    { id: "int_3", name: "Seat Cover In/Out", desc: "Professional removal, cleaning, and reinstallation of vehicle seat covers.", prices: { Sedan: 500, SUV: 800, "Van/L300": 1200 }, estTime: "2 Hours", durationMinutes: 120 },
    { id: "int_4", name: "Ceiling Cleaning", desc: "Careful removal of stains and dust from the vehicle's interior headliner.", prices: { Sedan: 700, SUV: 1000, "Van/L300": 1300 }, estTime: "2 Hours", durationMinutes: 120 },
  ],
  "Professional Detailing": [
    { id: "det_1", name: "Ceramic Coating", desc: "Premium 3-step exterior detailing followed by long-term ceramic protection.", prices: { Sedan: 10000, SUV: 13000, "Van/L300": 16000 }, estTime: "2 Days", durationMinutes: 2880 },
    { id: "det_2", name: "Exterior Detailing (3 Step)", desc: "Complete 3-step process: cutting cream, polishing, and high-gloss finishing.", prices: { Sedan: 5000, SUV: 6000, "Van/L300": 7000 }, estTime: "1 Day", durationMinutes: 1440 },
    { id: "det_3", name: "1st Step Cutting", desc: "Intensive swirl and deep scratch removal process only.", prices: { Sedan: 2500, SUV: 3000, "Van/L300": 3500 }, estTime: "4 Hours", durationMinutes: 240 },
    { id: "det_4", name: "Glass Detailing", desc: "Machine buffing for the windshield only to ensure perfect optical clarity.", prices: { Sedan: 3500, SUV: 4500, "Van/L300": 6000 }, estTime: "3 Hours", durationMinutes: 180 },
  ],
  "Motorcycle Specialist": [
    { id: "moto_1", name: "Moto Wash", desc: "Professional cleaning tailored specifically for motorcycle components.", prices: { Regular: 120, Bigbike: 150 }, estTime: "30 Mins", durationMinutes: 30 },
    { id: "moto_2", name: "Moto VIP", desc: "Includes wash, high-gloss treatment, degreaser, and protective wax.", prices: { Regular: 250, Bigbike: 350 }, estTime: "1 Hour", durationMinutes: 60 },
    { id: "moto_3", name: "Moto Detail", desc: "Full restoration of all visible motorcycle parts and surfaces.", prices: { Regular: 2500, Bigbike: 3000 }, estTime: "4 Hours", durationMinutes: 240 },
    { id: "moto_4", name: "Moto Ceramic Coating", desc: "Hydrophobic ceramic shield for paint, plastics, and metal parts.", prices: { Regular: 3500, Bigbike: 5500 }, estTime: "1 Day", durationMinutes: 1440 },
    { id: "moto_5", name: "Moto 3-Step Detailing", desc: "Comprehensive cutting, polishing, and finishing for bike paintwork.", prices: { Regular: 2500, Bigbike: 3500 }, estTime: "5 Hours", durationMinutes: 300 },
  ],
  "Add-on Treatments": [
    { id: "add_1", name: "Waxx Add-on", desc: "Extra layer of protective wax for an enhanced reflective shine.", prices: { Sedan: 200, SUV: 300, "Van/L300": 400 }, estTime: "30 Mins", durationMinutes: 30 },
    { id: "add_2", name: "Highgloss Add-on", desc: "Intense gloss enhancer for that wet-look finish.", prices: { Sedan: 200, SUV: 300, "Van/L300": 400 }, estTime: "30 Mins", durationMinutes: 30 },
    { id: "add_3", name: "Degreaser Add-on", desc: "Heavy-duty degreasing for underchassis or specific dirty areas.", prices: { Sedan: 200, SUV: 300, "Van/L300": 400 }, estTime: "30 Mins", durationMinutes: 30 },
  ]
};

export const getServiceCatalog = () => {
  if (typeof window === 'undefined') return SERVICES_DATA;
  try {
    const customCatalog = JSON.parse(localStorage.getItem('speedway_custom_services') || '[]');
    const activeCustomServices = Array.isArray(customCatalog) ? customCatalog.filter(service => !service.archived) : [];
    if (!activeCustomServices.length) return SERVICES_DATA;
    return {
      ...SERVICES_DATA,
      'Custom Services': activeCustomServices.map(service => ({
        id: service.id || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: service.name,
        desc: service.description || 'Custom service added by the admin.',
        prices: { Sedan: Number(service.price || 0), SUV: Number(service.price || 0), 'Van/L300': Number(service.price || 0), Regular: Number(service.price || 0), Bigbike: Number(service.price || 0) },
        estTime: `${Number(service.durationMinutes || 60)} mins`,
        durationMinutes: Number(service.durationMinutes || 60)
      }))
    };
  } catch {
    return SERVICES_DATA;
  }
};

export const getAvailableServiceNames = () => {
  const catalog = getServiceCatalog();
  return Object.values(catalog).flatMap(list => list.map(service => service.name));
};

import { PROMO_MODE, isNeverExpiring } from '../domain/promo/promoTypes';

/**
 * Return a snapshot of the promo rules that are currently active.
 *
 * NOTE: Promo persistence is owned by services/promoService.js (Supabase +
 * localStorage fallback). This synchronous reader exists so the pure pricing
 * helpers below stay usable without a network round-trip; the authoritative
 * list is hydrated into the cache by promoService on app load.
 */
export const getPromoRules = () => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem('speedway_promo_rules') || '[]');
    return Array.isArray(parsed)
      ? parsed.filter(rule => rule && rule.active !== false)
      : [];
  } catch {
    return [];
  }
};

/** Whether a promo rule is active and within its validity window right now. */
export const isPromoActiveForNow = (rule) => {
  if (!rule || rule.active === false) return false;

  const now = new Date();
  const validFrom = rule.valid_from || rule.validFrom;
  // Tolerates both the current JSON null and the legacy 'never' string.
  const validUntil = isNeverExpiring(rule.valid_until) ? rule.validUntil : (rule.valid_until || rule.validUntil);
  const fromDate = validFrom ? new Date(validFrom) : null;
  const untilDate = !isNeverExpiring(validUntil) ? new Date(validUntil) : null;
  if (fromDate && !Number.isNaN(fromDate.getTime()) && fromDate > now) return false;
  if (untilDate && !Number.isNaN(untilDate.getTime()) && untilDate < now) return false;
  return true;
};

/** Standard promo rules only (excludes package bundles). */
export const getStandardPromoRules = () => getPromoRules().filter(rule => rule.mode !== PROMO_MODE.PACKAGE);

/** Package promo rules only. */
export const getPackagePromoRules = () => getPromoRules().filter(rule => rule.mode === PROMO_MODE.PACKAGE);

export const getApplicablePromoRules = ({ vehicleType, serviceName }) => {
  const targetVehicleType = String(vehicleType || '').trim();
  const targetServiceName = String(serviceName || '').trim();

  if (!targetVehicleType || !targetServiceName) return [];

  return getStandardPromoRules().filter(rule => {
    if (!isPromoActiveForNow(rule)) return false;

    const hasVehicleScope = Array.isArray(rule.vehicleTypes) && rule.vehicleTypes.length > 0;
    const vehicleMatch = !hasVehicleScope || rule.vehicleTypes.some(vehicle => String(vehicle).toLowerCase() === targetVehicleType.toLowerCase());

    const hasServiceScope = Array.isArray(rule.serviceNames) && rule.serviceNames.length > 0;
    const normalizedServiceName = targetServiceName.toLowerCase();
    const serviceMatch = !hasServiceScope || rule.serviceNames.some(name => {
      const candidate = String(name || '').trim().toLowerCase();
      return !candidate || normalizedServiceName.includes(candidate) || candidate.includes(normalizedServiceName);
    });

    const fallbackServiceMatch = !rule.serviceNames?.length && !!rule.serviceName && (normalizedServiceName.includes(String(rule.serviceName).trim().toLowerCase()) || String(rule.serviceName).trim().toLowerCase().includes(normalizedServiceName));

    return vehicleMatch && (serviceMatch || fallbackServiceMatch);
  });
};

export const getEffectivePriceForService = (basePrice, vehicleType, serviceName) => {
  let adjustedPrice = Number(basePrice || 0);
  const rules = getApplicablePromoRules({ vehicleType, serviceName });

  rules.forEach(rule => {
    if (rule.type === 'percentage') {
      adjustedPrice = adjustedPrice * (1 - (Number(rule.value || 0) / 100));
    } else if (rule.type === 'fixed') {
      adjustedPrice = Math.max(0, adjustedPrice - Number(rule.value || 0));
    }
  });

  return Math.round(adjustedPrice * 100) / 100;
};

// --- Package Promo pricing --------------------------------------------------

/**
 * Active package promos that apply to a given vehicle type.
 * Used by the booking portals to populate the "Special Packages" tab.
 */
export const getApplicablePackages = (vehicleType) => {
  const target = String(vehicleType || '').trim().toLowerCase();
  return getPackagePromoRules().filter(rule => {
    if (!isPromoActiveForNow(rule)) return false;
    const scoped = Array.isArray(rule.vehicleTypes) && rule.vehicleTypes.length > 0;
    return !scoped || rule.vehicleTypes.some(type => String(type).toLowerCase() === target);
  });
};

/** Look up a single package rule by id. */
export const getPackageById = (packageId) =>
  getPackagePromoRules().find(rule => rule.id === packageId) || null;

/**
 * Resolve the standalone (undiscounted) price of a named service from the live
 * catalog for a vehicle type. Returns 0 when the service/type is not priced.
 */
export const getStandaloneServicePrice = (serviceName, vehicleType) => {
  const catalog = getServiceCatalog();
  const target = String(serviceName || '').trim().toLowerCase();
  for (const list of Object.values(catalog)) {
    const match = list.find(service => String(service.name || '').trim().toLowerCase() === target);
    if (match) return Number(match.prices?.[vehicleType] || 0);
  }
  return 0;
};

/**
 * Sum the standalone prices of a package's bundled services for a vehicle type.
 * This is the comparison baseline for the pricing invariant.
 */
export const getPackageStandaloneSum = (pkg, vehicleType) => {
  if (!pkg) return 0;
  const services = pkg.bundledServices || [];
  return services.reduce((sum, name) => sum + getStandaloneServicePrice(name, vehicleType), 0);
};

/**
 * Compute package savings relative to standalone totals for the services that
 * were actually selected (falls back to the full bundle when none are given).
 * @returns {{ packagePrice:number, standaloneTotal:number, savings:number, savingsPercent:number }}
 */
export const calculatePackageDiscount = (packageId, selectedServiceIds = [], vehicleType = '') => {
  const pkg = typeof packageId === 'object' && packageId ? packageId : getPackageById(packageId);
  if (!pkg) return { packagePrice: 0, standaloneTotal: 0, savings: 0, savingsPercent: 0 };

  const bundle = pkg.bundledServices || [];
  const selected = (selectedServiceIds || []).length ? selectedServiceIds : bundle;
  const applicable = bundle.length ? bundle.filter(name => selected.includes(name)) : selected;
  const standaloneTotal = applicable.reduce((sum, name) => sum + getStandaloneServicePrice(name, vehicleType), 0);
  const packagePrice = Number(pkg.packagePrice || 0);
  const savings = Math.max(0, standaloneTotal - packagePrice);
  return {
    packagePrice,
    standaloneTotal,
    savings,
    savingsPercent: standaloneTotal > 0 ? Math.round((savings / standaloneTotal) * 100) : 0
  };
};

/**
 * Discount summary across a whole booking.
 *
 * - Standard promos apply per line item (existing behaviour, unchanged).
 * - Package promos override a unit's subtotal as a *group*: the unit pays the
 *   fixed package price instead of the itemised service sum. Baseline standalone
 *   subtotals are never mutated in place.
 *
 * A vehicle opts into a package via `vehicle.packageId`; the bundled services
 * remain as line items so bay usage and service history stay accurate.
 */
export const calculateBookingDiscountSummary = (vehicles = []) => {
  let originalTotal = 0;
  let discountedTotal = 0;
  const appliedPackages = [];

  (vehicles || []).forEach(vehicle => {
    const pkg = vehicle.packageId ? getPackageById(vehicle.packageId) : null;

    if (pkg) {
      // Package unit: subtotal locks to the fixed package rate. The comparison
      // baseline is the standalone sum of whichever bundled services are present
      // as line items; a fleet unit applies once per vehicle. If no line items
      // survived (e.g. an emptied selection), fall back to the package's own
      // declared standalone sum so the unit is never silently free.
      const services = Array.isArray(vehicle.services) ? vehicle.services : [];
      const itemisedSum = services.reduce(
        (sum, service) => sum + Number(service.price || service.basePrice || 0),
        0
      );
      const declaredSum = getPackageStandaloneSum(pkg, vehicle.type);
      const standaloneSum = itemisedSum > 0 ? itemisedSum : declaredSum;
      const packagePrice = Number(pkg.packagePrice || 0);
      const unitMultiplier = Math.max(1, Number(vehicle.packageUnits || 1));
      originalTotal += standaloneSum * unitMultiplier;
      discountedTotal += packagePrice * unitMultiplier;
      appliedPackages.push({
        packageId: pkg.id,
        name: pkg.name,
        packagePrice: packagePrice * unitMultiplier,
        standaloneSum: standaloneSum * unitMultiplier,
        savings: Math.max(0, (standaloneSum - packagePrice) * unitMultiplier),
      });
      return;
    }

    (vehicle.services || []).forEach(service => {
      const basePrice = Number(service.price || service.basePrice || 0);
      originalTotal += basePrice;
      discountedTotal += getEffectivePriceForService(basePrice, vehicle.type, service.name || service.service_name);
    });
  });

  return {
    originalTotal,
    discountedTotal,
    totalDiscount: Math.max(0, originalTotal - discountedTotal),
    appliedPackages,
  };
};

export const applyPromoRules = (basePrice, serviceName = '', vehicleType = '') => getEffectivePriceForService(basePrice, vehicleType, serviceName);
