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
    // 🛡️ SC-22 — SERVICE PREREQUISITES.
    // `requires` lists sibling service NAMES that must be present on the SAME
    // vehicle for this service to be valid. It is validated by
    // validateServiceRequirements() at the checkout boundary (client AND the
    // booking RPC), so an isolated dependent service (e.g. an add-on with no
    // wash) is rejected with a clean message rather than silently accepted.
    { id: "add_1", name: "Waxx Add-on", desc: "Extra layer of protective wax for an enhanced reflective shine.", prices: { Sedan: 200, SUV: 300, "Van/L300": 400 }, estTime: "30 Mins", durationMinutes: 30, requires: ["Regular Wash", "Supreme Wash"] },
    { id: "add_2", name: "Highgloss Add-on", desc: "Intense gloss enhancer for that wet-look finish.", prices: { Sedan: 200, SUV: 300, "Van/L300": 400 }, estTime: "30 Mins", durationMinutes: 30, requires: ["Regular Wash", "Supreme Wash"] },
    { id: "add_3", name: "Degreaser Add-on", desc: "Heavy-duty degreasing for underchassis or specific dirty areas.", prices: { Sedan: 200, SUV: 300, "Van/L300": 400 }, estTime: "30 Mins", durationMinutes: 30, requires: ["Regular Wash", "Supreme Wash"] },
  ]
};

export const buildFrozenServiceSnapshot = (service = {}, vehicleType = '', source = 'catalog') => {
  const normalized = service && typeof service === 'object' ? service : {};
  const basePrice = Number(normalized.price ?? normalized.basePrice ?? normalized.final_price ?? 0);
  const minutes = Number(normalized.durationMinutes ?? normalized.duration_minutes ?? normalized.duration ?? 60);
  const snapshot = {
    service_id: normalized.id || null,
    service_name: String(normalized.name || normalized.service_name || '').trim() || 'Custom service',
    price: Number.isFinite(basePrice) ? basePrice : 0,
    duration_minutes: Number.isFinite(minutes) ? minutes : 60,
    vehicle_type: String(vehicleType || normalized.vehicle_type || normalized.vehicleType || '').trim() || null,
    snapshot_source: source,
    service_snapshot: {
      id: normalized.id || null,
      name: String(normalized.name || normalized.service_name || '').trim() || 'Custom service',
      description: String(normalized.description || '').trim(),
      price: Number.isFinite(basePrice) ? basePrice : 0,
      duration_minutes: Number.isFinite(minutes) ? minutes : 60,
      vehicle_type: String(vehicleType || normalized.vehicle_type || normalized.vehicleType || '').trim() || null,
      source
    }
  };

  return {
    ...snapshot,
    service_name: snapshot.service_name,
    price: snapshot.price,
    duration_minutes: snapshot.duration_minutes,
    vehicle_type: snapshot.vehicle_type,
    service_id: snapshot.service_id,
    snapshot_source: snapshot.snapshot_source,
    service_snapshot: snapshot.service_snapshot,
  };
};

export const buildBookingServiceSnapshot = (service = {}, vehicleType = '', source = 'booking') => {
  const frozen = buildFrozenServiceSnapshot(service, vehicleType, source);
  const finalPrice = Number(frozen.price ?? 0);
  const entry = {
    service_id: frozen.service_id,
    service_name: frozen.service_name,
    final_price: finalPrice,
    duration_minutes: Number(frozen.duration_minutes ?? 60),
    vehicle_type: frozen.vehicle_type,
    service_snapshot: [{
      service_id: frozen.service_id,
      service_name: frozen.service_name,
      final_price: finalPrice,
      duration_minutes: Number(frozen.duration_minutes ?? 60),
      vehicle_type: frozen.vehicle_type,
      source
    }]
  };

  return {
    ...entry,
    service_name: entry.service_name,
    final_price: entry.final_price,
    duration_minutes: entry.duration_minutes,
    vehicle_type: entry.vehicle_type,
    service_id: entry.service_id,
    service_snapshot: entry.service_snapshot,
  };
};

export const getServiceCatalog = () => {
  // The catalog is intentionally limited to the governed built-in services.
  // Legacy custom-service rows remain stored for audit history but are no
  // longer exposed as bookable or configurable services.
  return SERVICES_DATA;
};

export const getAvailableServiceNames = () => {
  const catalog = getServiceCatalog();
  return Object.values(catalog).flatMap(list => list.map(service => service.name));
};

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

export const fetchActivePromos = async () => {
  try {
    const BACKEND_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) || 'http://localhost:3000';
    const res = await fetch(`${BACKEND_URL}/api/promos/active`);
    if (res.ok) {
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        if (typeof window !== 'undefined') {
          localStorage.setItem('speedway_promo_rules', JSON.stringify(json.data));
        }
        return json.data;
      }
    }
  } catch {
    // Fall back gracefully
  }
  return getPromoRules();
};

const isPromoActiveForNow = (rule, atDate = null) => {
  if (!rule || rule.active === false) return false;

  // Section 4 — Eligibility Rule: promo validity is evaluated against the
  // BOOKING CREATION DATE, not the current system clock. A booking made while a
  // promo was live keeps that promo even if its window later closes (and vice
  // versa). Callers that pass no date fall back to now for preview contexts.
  const now = atDate ? new Date(atDate) : new Date();
  const rawFrom = rule.validFrom || rule.valid_from;
  const rawUntil = rule.validUntil || rule.valid_until;
  const validFrom = rawFrom ? new Date(rawFrom) : null;
  const isNever = rule.neverExpires === true || rule.never_expires === true || rawUntil === 'never';
  const validUntil = isNever ? null : (rawUntil ? new Date(rawUntil) : null);

  if (validFrom && !isNaN(validFrom.getTime()) && validFrom > now) return false;
  if (validUntil && !isNaN(validUntil.getTime()) && validUntil < now) return false;
  return true;
};

export const getApplicablePromoRules = ({ vehicleType, serviceName, atDate = null }) => {
  const targetVehicleType = String(vehicleType || '').trim();
  const targetServiceName = String(serviceName || '').trim();

  if (!targetVehicleType || !targetServiceName) return [];

  return getPromoRules().filter(rule => {
    if (!isPromoActiveForNow(rule, atDate)) return false;

    // Packages are NOT evaluated per-service here. A package is a bundle that
    // only applies when the WHOLE set is present on the vehicle, so it is
    // resolved separately by getActivePackageForVehicle(). Excluding it from
    // the per-service path is what makes a package non-stackable.
    if (isPackageRule(rule)) return false;

    // 1. Dynamic Vehicle-to-Service Binding Matrix Evaluation. When a rule
    //    defines a matrix AND that matrix scopes the target vehicle, matrix
    //    membership is DECISIVE: only the services explicitly bound to this
    //    vehicle qualify. This prevents the broad fallback below from
    //    accidentally applying a per-vehicle promo to services it never listed
    //    (e.g. a 10%-off "Regular Wash" rule silently discounting "Engine Wash").
    let matrixScopedThisVehicle = false;
    if (rule.vehicleServiceMatrix && typeof rule.vehicleServiceMatrix === 'object') {
      const matrixVehicles = Object.keys(rule.vehicleServiceMatrix);
      const vehicleKey = matrixVehicles.find(v => String(v).toLowerCase() === targetVehicleType.toLowerCase());
      if (vehicleKey) {
        const boundServices = rule.vehicleServiceMatrix[vehicleKey];
        if (Array.isArray(boundServices) && boundServices.length > 0) {
          matrixScopedThisVehicle = true;
          const normTarget = targetServiceName.toLowerCase();
          const matches = boundServices.some(item => {
            const cand = String(item || '').trim().toLowerCase();
            return cand === normTarget || normTarget.includes(cand) || cand.includes(normTarget);
          });
          if (matches) return true;
        }
      }
    }
    // The rule explicitly scopes this vehicle but not this service → it does not
    // apply. Do not fall through to the broad scope.
    if (matrixScopedThisVehicle) return false;

    // 2. Fallback to vehicleTypes & serviceMatches array scope (only reached when
    //    the rule did not define a per-vehicle matrix for the target vehicle).
    const hasVehicleScope = Array.isArray(rule.vehicleTypes) && rule.vehicleTypes.length > 0;
    const vehicleMatch = !hasVehicleScope || rule.vehicleTypes.some(vehicle => String(vehicle).toLowerCase() === targetVehicleType.toLowerCase());

    const serviceList = Array.isArray(rule.serviceMatches) ? rule.serviceMatches : (Array.isArray(rule.serviceNames) ? rule.serviceNames : []);
    const hasServiceScope = serviceList.length > 0;
    const normalizedServiceName = targetServiceName.toLowerCase();
    const serviceMatch = !hasServiceScope || serviceList.some(name => {
      const candidate = String(name || '').trim().toLowerCase();
      return !candidate || normalizedServiceName.includes(candidate) || candidate.includes(normalizedServiceName);
    });

    const fallbackServiceMatch = !serviceList.length && !!rule.serviceName && (normalizedServiceName.includes(String(rule.serviceName).trim().toLowerCase()) || String(rule.serviceName).trim().toLowerCase().includes(normalizedServiceName));

    return vehicleMatch && (serviceMatch || fallbackServiceMatch);
  });
};

// ── Package (bundle) helpers ───────────────────────────────────────────────
// A package differs from a standard promo at the semantic level:
//   • Standard promo = a MODIFIER. It takes an amount/percentage off each
//     matched service, independently. Multiple standard promos may apply.
//   • Package = a PRODUCT. It replaces the individual prices of a defined SET
//     of services on one vehicle with a single flat price. It applies ONLY when
//     the customer has selected the entire set, and it never stacks with other
//     promos (a package price plus a percentage would double-discount).
export const isPackageRule = (rule) => Boolean(
  rule && (rule.mode === 'package' || rule.type === 'fixed_package')
);

// Resolve how a promo rule binds a specific vehicle to a set of service names.
// Returns the exact service-name list, or [] when the rule does not scope this
// vehicle at all.
export const getPackageServicesForVehicle = (rule, vehicleType) => {
  if (!rule || !vehicleType) return [];
  const target = String(vehicleType).toLowerCase();

  if (rule.vehicleServiceMatrix && typeof rule.vehicleServiceMatrix === 'object') {
    const key = Object.keys(rule.vehicleServiceMatrix)
      .find(v => String(v).toLowerCase() === target);
    if (key && Array.isArray(rule.vehicleServiceMatrix[key])) {
      return rule.vehicleServiceMatrix[key].map(s => String(s || '').trim()).filter(Boolean);
    }
  }
  // Fallback scope matrices.
  const scopedVehicles = Array.isArray(rule.vehicleTypes) ? rule.vehicleTypes : [];
  const scopeMatches = !scopedVehicles.length || scopedVehicles.some(v => String(v).toLowerCase() === target);
  if (!scopeMatches) return [];
  const list = Array.isArray(rule.serviceMatches) ? rule.serviceMatches : (Array.isArray(rule.serviceNames) ? rule.serviceNames : []);
  return list.map(s => String(s || '').trim()).filter(Boolean);
};

const normalizeServiceName = (name) => String(name || '').trim().toLowerCase();

// True when `selectedNames` contains every service required by the package set.
const packageSetIsComplete = (requiredNames, selectedNames) => {
  if (!requiredNames.length) return false;
  const selected = selectedNames.map(normalizeServiceName);
  return requiredNames.every(required => {
    const req = normalizeServiceName(required);
    return selected.some(sel => sel === req || sel.includes(req) || req.includes(sel));
  });
};

/**
 * Sum of a package's member services at their regular (catalog) prices for a
 * vehicle — the "if bought separately" figure. Used to warn an admin when a
 * package price is not actually a saving, and to compute package savings for UI.
 *
 * @param {object} rule the package promo rule
 * @param {string} vehicleType
 * @returns {number}
 */
export const getPackageStandaloneSum = (rule, vehicleType) => {
  const required = getPackageServicesForVehicle(rule, vehicleType);
  if (!required.length) return 0;
  const catalog = getServiceCatalog();
  const all = Object.values(catalog).flat();
  const norm = (s) => String(s || '').trim().toLowerCase();
  return required.reduce((sum, name) => {
    const match = all.find((svc) => {
      const svcName = norm(svc.name);
      const target = norm(name);
      return svcName === target || svcName.includes(target) || target.includes(svcName);
    });
    const priceMap = match?.prices || {};
    const price = Number(
      vehicleType === 'Motorcycle Regular'
        ? (priceMap.Regular ?? priceMap['Motorcycle Regular'] ?? 0)
        : vehicleType === 'Bigbike'
          ? (priceMap.Bigbike ?? 0)
          : (priceMap[vehicleType] ?? 0)
    );
    return sum + (Number.isFinite(price) ? price : 0);
  }, 0);
};

/**
 * Resolve the single package (if any) that fully applies to one vehicle in a
 * booking, given the services the customer selected on that vehicle.
 *
 * @param {string} vehicleType
 * @param {string[]} selectedServiceNames
 * @param {string|null} atDate
 * @returns {null | { rule, requiredServices, packagePrice, matchedServices, savings }}
 */
export const getActivePackageForVehicle = (vehicleType, selectedServiceNames = [], atDate = null) => {
  const names = Array.isArray(selectedServiceNames) ? selectedServiceNames : [];
  if (!vehicleType || !names.length) return null;

  const candidates = getPromoRules()
    .filter(rule => isPackageRule(rule) && isPromoActiveForNow(rule, atDate))
    .map(rule => ({ rule, requiredServices: getPackageServicesForVehicle(rule, vehicleType) }))
    .filter(({ requiredServices }) => packageSetIsComplete(requiredServices, names));

  if (!candidates.length) return null;

  const { rule, requiredServices } = candidates[0];
  const packagePrice = Math.max(0, Number(rule.value || 0));
  return {
    rule,
    requiredServices,
    packagePrice,
    matchedServices: requiredServices,
  };
};

/**
 * priceVehicleServices — the single source of truth for how one vehicle's
 * selected services are priced. It decides between the two promo semantics:
 *
 *  • PACKAGE (product): if the full bundle set is present, the vehicle is priced
 *    at ONE flat package price and every service is marked package-priced. No
 *    standard promo applies (non-stackable).
 *  • STANDARD (modifier): otherwise each service is priced with the standard
 *    promos that match it, independently.
 *
 * Returns the per-service array (unchanged shape the wizard stores) plus the
 * resolved package, so callers can both persist correct prices AND render the
 * bundle as a single line.
 *
 * @param {string} vehicleType
 * @param {Array<{ name:string, price?:number, basePrice?:number }>} services
 * @param {string|null} atDate
 */
export const priceVehicleServices = (vehicleType, services = [], atDate = null) => {
  const list = Array.isArray(services) ? services : [];
  const names = list.map(s => s.name || s.service_name || '').filter(Boolean);
  const activePackage = getActivePackageForVehicle(vehicleType, names, atDate);

  if (activePackage) {
    const pkgName = activePackage.rule.name;
    const priced = list.map(service => {
      const basePrice = Number(service.price ?? service.basePrice ?? 0);
      const priceAtBooking = Number(service.price_at_booking ?? basePrice);
      return {
        ...service,
        original_price: basePrice,
        // A package price is a whole-vehicle figure; individual services keep
        // their base price here so the bundle line can show the single total.
        price_at_booking: priceAtBooking,
        discount: Math.max(0, basePrice - priceAtBooking),
        applied_promo: null,
        package_applied: pkgName,
      };
    });

    // Package total is authoritative: clear per-service booking prices so the
    // unit subtotal function must use the package total instead of summing.
    return {
      services: priced.map(s => ({ ...s, price_at_booking: 0 })),
      package: {
        name: pkgName,
        ruleId: activePackage.rule.id,
        packagePrice: activePackage.packagePrice,
        requiredServices: activePackage.requiredServices,
      },
      unitSubtotal: activePackage.packagePrice,
    };
  }

  const priced = list.map(service => {
    const basePrice = Number(service.price ?? service.basePrice ?? 0);
    const promoInfo = getBestPromoForService(vehicleType, service.name || service.service_name, basePrice, atDate);
    const priceAtBooking = promoInfo ? promoInfo.effectivePrice : basePrice;
    return {
      ...service,
      original_price: basePrice,
      price_at_booking: priceAtBooking,
      discount: promoInfo ? promoInfo.discountAmount : 0,
      applied_promo: promoInfo ? promoInfo.name : null,
      package_applied: null,
    };
  });

  const unitSubtotal = priced.reduce((total, s) => total + Number(s.price_at_booking ?? 0), 0);
  return { services: priced, package: null, unitSubtotal: Math.round(unitSubtotal * 100) / 100 };
};

export const getEffectivePriceForService = (basePrice, vehicleType, serviceName, atDate = null) => {
  let adjustedPrice = Number(basePrice || 0);
  const rules = getApplicablePromoRules({ vehicleType, serviceName, atDate });

  // Standard promos stack additively, but the price is floored at 0 so a fixed
  // discount larger than the price can never create a negative charge.
  rules.forEach(rule => {
    if (rule.type === 'percentage') {
      adjustedPrice = adjustedPrice * (1 - (Number(rule.value || 0) / 100));
    } else if (rule.type === 'fixed') {
      adjustedPrice = Math.max(0, adjustedPrice - Number(rule.value || 0));
    }
  });

  return Math.round(adjustedPrice * 100) / 100;
};

export const getBestPromoForService = (vehicleType, serviceName, basePrice = 0, atDate = null) => {
  // Standard (modifier) promos only. Packages are bundles resolved per-vehicle
  // via getActivePackageForVehicle(), so they never appear here — that is what
  // keeps a package from being shown as a per-service "discount".
  const rules = getApplicablePromoRules({ vehicleType, serviceName, atDate });
  if (!rules.length) return null;
  const rule = rules[0];
  const effectivePrice = getEffectivePriceForService(basePrice, vehicleType, serviceName, atDate);
  const discountAmount = Math.max(0, Number(basePrice) - effectivePrice);
  return {
    ...rule,
    effectivePrice,
    discountAmount,
    tagText: rule.type === 'percentage'
      ? `${rule.value}% OFF`
      : `₱${Number(rule.value).toLocaleString()} OFF`
  };
};

export const calculateBookingDiscountSummary = (vehicles = [], atDate = null) => {
  let originalTotal = 0;
  let discountedTotal = 0;
  const appliedPackages = [];

  (vehicles || []).forEach(vehicle => {
    const services = vehicle.services || [];
    const standaloneSum = services.reduce(
      (sum, service) => sum + Number(service.price || service.basePrice || 0), 0
    );
    originalTotal += standaloneSum;

    // A package is a mutually-exclusive PRODUCT for this vehicle: when the full
    // bundle set is selected, the vehicle is priced at ONE flat package price
    // and NO standard promo applies on top (prevents double-discounting).
    const selectedNames = services.map(s => s.name || s.service_name || '').filter(Boolean);
    const activePackage = getActivePackageForVehicle(vehicle.type, selectedNames, atDate);

    if (activePackage) {
      discountedTotal += activePackage.packagePrice;
      appliedPackages.push({
        // Both naming conventions are provided so the booking persistence path
        // (packageId/standaloneSum) and UI consumers (ruleId/packagePrice) agree.
        packageId: activePackage.rule.id,
        ruleId: activePackage.rule.id,
        name: activePackage.rule.name,
        vehicleType: vehicle.type,
        packagePrice: activePackage.packagePrice,
        standaloneSum,
        savings: Math.max(0, standaloneSum - activePackage.packagePrice),
        requiredServices: activePackage.requiredServices,
      });
      return;
    }

    // No package applies → every service is priced with standard promos.
    services.forEach(service => {
      const basePrice = Number(service.price || service.basePrice || 0);
      discountedTotal += getEffectivePriceForService(basePrice, vehicle.type, service.name || service.service_name, atDate);
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

/**
 * Scenario 9 — resolve the IMMUTABLE booking-time price for a persisted service
 * line.
 *
 * A retroactive catalog price change (₱100 → ₱150) is a catastrophic LOGICAL
 * error if any display/receipt/total path reads the mutable live price. The
 * persisted line carries several frozen columns; this helper applies ONE
 * canonical precedence, identical to the SQL view public.booking_service_lines
 * (`effective_price`) so the two can never disagree:
 *
 *   price_at_booking → final_price → price_snapshot → live `price` → 0
 *
 * The live `price` column is intentionally LAST: it is the only one a later
 * catalog edit can move, so it is used only as a last-resort fallback for legacy
 * rows that predate the snapshot columns.
 */
export const resolveFrozenServicePrice = (service = {}) => {
  const candidates = [
    service.price_at_booking,
    service.final_price,
    service.price_snapshot,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value !== 0) return value;
  }
  const fallback = Number(service.price ?? 0);
  return Number.isFinite(fallback) ? fallback : 0;
};/**
 * Scenario 22 — Service prerequisite validation.
 *
 * A service may declare `requires: [<service names>]` meaning at least ONE of
 * the listed siblings must be present on the SAME vehicle. Example: the
 * "Waxx Add-on" requires a wash ("Regular Wash" or "Supreme Wash").
 *
 * This is enforced at the checkout boundary so a stale tab or a hand-crafted
 * payload cannot strip the prerequisite while keeping the dependent service.
 *
 * @param {Array} vehicles  the booking's vehicle list, each with `services`
 * @returns {{ ok: boolean, violations: Array<{ vehicleIndex, serviceName, requires }> }}
 */
export const validateServiceRequirements = (vehicles = []) => {
  const violations = [];

  (vehicles || []).forEach((vehicle, vehicleIndex) => {
    const serviceNames = (vehicle.services || [])
      .map((s) => String(s.name || s.service_name || '').trim().toLowerCase())
      .filter(Boolean);

    (vehicle.services || []).forEach((service) => {
      const required = service.requires || service.requires_services || [];
      if (!Array.isArray(required) || required.length === 0) return;

      // Satisfied when at least ONE listed prerequisite is present on this vehicle.
      const satisfied = required.some((req) =>
        serviceNames.includes(String(req).trim().toLowerCase()));

      if (!satisfied) {
        violations.push({
          vehicleIndex,
          serviceName: service.name || service.service_name || 'Service',
          requires: required.slice(),
        });
      }
    });
  });

  return { ok: violations.length === 0, violations };
};

/** Human-readable message for the FIRST violation, or null when none. */
export const describeServiceRequirementViolation = (violations = []) => {
  if (!violations.length) return null;
  const { serviceName, requires } = violations[0];
  return `"${serviceName}" requires ${requires.map((r) => `"${r}"`).join(' or ')} on the same vehicle. Please add the prerequisite or remove the add-on.`;
};