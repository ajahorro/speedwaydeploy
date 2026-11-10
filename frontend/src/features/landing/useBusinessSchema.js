import { useEffect } from 'react';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hh = (h) => `${String(Math.min(h, 23)).padStart(2, '0')}:${h >= 24 ? '59' : '00'}`;

/** Business details search engines can read (name, address, hours, map pin, socials), kept in step with the Business Hub. */
export default function useBusinessSchema(settings) {
  useEffect(() => {
    if (!settings) return undefined;
    const loc = settings.SHOP_LOCATION;
    const data = {
      '@context': 'https://schema.org',
      '@type': 'AutoWash',
      name: settings.BUSINESS_NAME || 'Comar Garage',
      url: window.location.origin,
      logo: `${window.location.origin}/favicon-512.png`,
      image: settings.HERO_PHOTO || `${window.location.origin}/favicon-512.png`,
      address: settings.BUSINESS_ADDRESS
        ? { '@type': 'PostalAddress', streetAddress: settings.BUSINESS_ADDRESS, addressLocality: 'Cainta', addressRegion: 'Rizal', addressCountry: 'PH' }
        : undefined,
      telephone: settings.BUSINESS_CONTACT_NUMBER || undefined,
      email: settings.BUSINESS_EMAIL || undefined,
      geo: loc ? { '@type': 'GeoCoordinates', latitude: loc.lat, longitude: loc.lng } : undefined,
      openingHoursSpecification: [{
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: DAYS.filter((_, i) => !(settings.CLOSED_WEEKDAYS || []).includes(i)),
        opens: hh(settings.OPENING_HOUR ?? 8),
        closes: hh(settings.CLOSING_HOUR ?? 18),
      }],
      sameAs: (settings.SOCIAL_LINKS || []).map((s) => s?.url || s).filter((u) => typeof u === 'string' && u.startsWith('http')),
      priceRange: '₱₱',
    };
    const tag = Object.assign(document.createElement('script'), { type: 'application/ld+json', text: JSON.stringify(data) });
    document.head.appendChild(tag);
    return () => tag.remove();
  }, [settings]);
}
