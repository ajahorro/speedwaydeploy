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
  if (typeof window === 'undefined') return SERVICES_DATA;
  try {
    const persistedCustomServices = (() => {
      try {
        const direct = JSON.parse(localStorage.getItem('speedway_custom_services') || '[]');
        return Array.isArray(direct) ? direct : [];
      } catch {
        return [];
      }
    })();

    const runtimeCustomServices = (() => {
      try {
        const direct = window.__speedway_custom_services_cache;
        return Array.isArray(direct) ? direct : [];
      } catch {
        return [];
      }
    })();

    const customCatalog = runtimeCustomServices.length ? runtimeCustomServices : persistedCustomServices;
    const activeCustomServices = Array.isArray(customCatalog)
      ? customCatalog.filter((service) => service && service.is_active !== false && service.archived !== true)
      : [];

    if (!activeCustomServices.length) return SERVICES_DATA;

    const customServicesByType = activeCustomServices.map((service) => {
      const vehicleType = service.vehicleType || service.vehicle_type || '';
      const singlePrice = Number(service.price || 0);
      const prices = vehicleType
        ? { [vehicleType]: singlePrice }
        : {
            Sedan: singlePrice,
            SUV: singlePrice,
            'Van/L300': singlePrice,
            Regular: singlePrice,
            Bigbike: singlePrice
          };

      return {
        id: service.id || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: service.name,
        desc: service.description || 'Custom service added by the admin.',
        prices,
        estTime: `${Number(service.durationMinutes || 60)} mins`,
        durationMinutes: Number(service.durationMinutes || 60),
        vehicleType,
      };
    });

    return {
      ...SERVICES_DATA,
      'Custom Services': customServicesByType
    };
  } catch {
    return SERVICES_DATA;
  }
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

    // 1. Dynamic Vehicle-to-Service Binding Matrix Evaluation
    if (rule.vehicleServiceMatrix && typeof rule.vehicleServiceMatrix === 'object') {
      const matrixVehicles = Object.keys(rule.vehicleServiceMatrix);
      const vehicleKey = matrixVehicles.find(v => String(v).toLowerCase() === targetVehicleType.toLowerCase());
      if (vehicleKey) {
        const boundServices = rule.vehicleServiceMatrix[vehicleKey];
        if (Array.isArray(boundServices) && boundServices.length > 0) {
          const normTarget = targetServiceName.toLowerCase();
          const matches = boundServices.some(item => {
            const cand = String(item || '').trim().toLowerCase();
            return cand === normTarget || normTarget.includes(cand) || cand.includes(normTarget);
          });
          if (matches) return true;
        }
      }
    }

    // 2. Fallback to vehicleTypes & serviceMatches array scope
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

export const getEffectivePriceForService = (basePrice, vehicleType, serviceName, atDate = null) => {
  let adjustedPrice = Number(basePrice || 0);
  const rules = getApplicablePromoRules({ vehicleType, serviceName, atDate });

  rules.forEach(rule => {
    if (rule.type === 'percentage') {
      adjustedPrice = adjustedPrice * (1 - (Number(rule.value || 0) / 100));
    } else if (rule.type === 'fixed') {
      adjustedPrice = Math.max(0, adjustedPrice - Number(rule.value || 0));
    } else if (rule.type === 'fixed_package' || rule.mode === 'package') {
      if (Number(rule.value) > 0) {
        adjustedPrice = Math.min(adjustedPrice, Number(rule.value));
      }
    }
  });

  return Math.round(adjustedPrice * 100) / 100;
};

export const getBestPromoForService = (vehicleType, serviceName, basePrice = 0) => {
  const rules = getApplicablePromoRules({ vehicleType, serviceName });
  if (!rules.length) return null;
  const rule = rules[0];
  const effectivePrice = getEffectivePriceForService(basePrice, vehicleType, serviceName);
  const discountAmount = Math.max(0, Number(basePrice) - effectivePrice);
  return {
    ...rule,
    effectivePrice,
    discountAmount,
    tagText: rule.mode === 'package'
      ? `PKG: ₱${Number(rule.value).toLocaleString()}`
      : rule.type === 'percentage'
        ? `${rule.value}% OFF`
        : `₱${Number(rule.value).toLocaleString()} OFF`
  };
};

export const calculateBookingDiscountSummary = (vehicles = [], atDate = null) => {
  let originalTotal = 0;
  let discountedTotal = 0;

  (vehicles || []).forEach(vehicle => {
    (vehicle.services || []).forEach(service => {
      const basePrice = Number(service.price || service.basePrice || 0);
      originalTotal += basePrice;
      discountedTotal += getEffectivePriceForService(basePrice, vehicle.type, service.name || service.service_name, atDate);
    });
  });

  return {
    originalTotal,
    discountedTotal,
    totalDiscount: Math.max(0, originalTotal - discountedTotal)
  };
};

export const applyPromoRules = (basePrice, serviceName = '', vehicleType = '') => getEffectivePriceForService(basePrice, vehicleType, serviceName);

