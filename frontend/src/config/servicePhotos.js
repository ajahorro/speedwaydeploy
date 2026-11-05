/**
 * Photos for the public Services page (/services) and the landing page's featured service cards.
 *
 * HOW TO ADD A PHOTO
 *   1. Put the image in  frontend/public/services/  (JPG or WebP, about 1200×800, under ~300 KB).
 *   2. Add its path below under the service id or category name, starting with "/services/".
 *        wash_basic: ['/services/basic-wash-1.jpg', '/services/basic-wash-2.jpg'],
 *   3. Commit and push. Nothing else needs to change.
 *
 * Each service shows up to SERVICE_PHOTO_SLOTS photos in its detail view. Empty slots show a
 * "Photo coming soon" placeholder, so you can fill them in gradually. The first photo is the
 * one used on the service card.
 *
 * Services added in the Business Hub use their own image (image_url) first when they have one;
 * they can also be listed here by their id.
 */

export const SERVICE_PHOTO_SLOTS = 3;

/** Category banner photos, keyed by the category name exactly as it appears on the page. */
export const CATEGORY_PHOTOS = {
  'Car Wash': [],
  'Packages': [],
  'Exterior Care': [],
  'Interior Care': [],
  'Detailing': [],
  'Labor Only': [],
  'Motorcycle Specialist': [],
  'Add-on Treatments': [],
};

/** Short line shown under each category title. Categories not listed here show no line. */
export const CATEGORY_BLURBS = {
  'Car Wash': 'Quick, thorough washes for everyday upkeep.',
  'Packages': 'Bundled treatments at a better price than booking each one separately.',
  'Exterior Care': 'Paint, glass and engine bay treatments that restore shine and protection.',
  'Interior Care': 'Cabin cleaning and protection for seats, carpets, ceiling and dashboard.',
  'Detailing': 'Full-day, in-depth interior and exterior restoration.',
  'Labor Only': 'Bring your own product; we supply the skilled labor.',
  'Motorcycle Specialist': 'Washes and finishing for motorcycles of every size.',
  'Add-on Treatments': 'Upgrades that go on top of a package you have chosen.',
};

/** Service photos, keyed by service id (see frontend/src/data/servicesCatalog.js for the ids). */
export const SERVICE_PHOTOS = {
  // Car Wash
  wash_basic: [],
  wash_premium: [],
  // Packages
  pkg_a: [],
  pkg_b: [],
  pkg_c: [],
  pkg_d: [],
  // Exterior Care
  ext_asphalt: [],
  ext_acid_full: [],
  ext_acid_wind: [],
  ext_hydro_glass: [],
  ext_wax: [],
  ext_buff: [],
  ext_engine: [],
  ext_headlight: [],
  // Interior Care
  int_armor: [],
  int_bac0: [],
  int_seat: [],
  int_ceiling: [],
  int_carpet: [],
  int_remove: [],
  // Detailing
  det_int_ord: [],
  det_int_baklas: [],
  det_ext: [],
  det_pkg: [],
  // Labor Only
  lab_spray: [],
  lab_wax: [],
  lab_acid: [],
  lab_hydro: [],
  // Motorcycle Specialist
  moto_wash_s: [],
  moto_wash_m: [],
  moto_wash_l: [],
  moto_wash_big: [],
  moto_armor: [],
  moto_wax: [],
  moto_buff: [],
  // Add-on Treatments
  add_hydro_wax: [],
};

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .map((src) => String(src || '').trim())
  .filter(Boolean);

/** Every photo for a service: its own uploaded image first, then the ones listed above. */
export const photosForService = (service = {}) => {
  const own = asList(service.image_url || service.imageUrl || service.photo_url || service.image);
  const listed = asList(SERVICE_PHOTOS[service.id]);
  return [...new Set([...own, ...listed])];
};

export const photosForCategory = (category) => asList(CATEGORY_PHOTOS[category]);
