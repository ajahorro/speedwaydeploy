import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * The shop's map (OpenStreetMap tiles through Leaflet: free, no API key).
 *  - read-only on the landing page;
 *  - editable in Business Hub › About & Map: click anywhere or drag the pin to move it.
 * The pin is drawn with CSS (no image files), in the brand red.
 */
export const DEFAULT_CENTER = { lat: 14.5794, lng: 121.1159, zoom: 13 }; // Cainta, Rizal

const pinIcon = L.divIcon({
  className: 'shop-pin',
  html: '<span class="shop-pin-dot"></span>',
  iconSize: [30, 30],
  iconAnchor: [15, 30],
});

export default function ShopMap({ location, editable = false, onChange, height = 320, label = 'Shop location map' }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  // create once
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return undefined;
    const start = location || DEFAULT_CENTER;
    const map = L.map(boxRef.current, {
      center: [start.lat, start.lng],
      zoom: start.zoom || (location ? 16 : DEFAULT_CENTER.zoom),
      scrollWheelZoom: editable, // the landing page should not trap the page scroll
      attributionControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    mapRef.current = map;

    if (editable) {
      const report = (latlng) => changeRef.current?.({ lat: latlng.lat, lng: latlng.lng, zoom: map.getZoom() });
      map.on('click', (e) => report(e.latlng));
      map.on('zoomend', () => { if (markerRef.current) report(markerRef.current.getLatLng()); });
    }
    // Leaflet measures its box once; re-measure when the box changes size (dialogs, tabs, phone rotation)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null;
    observer?.observe(boxRef.current);
    return () => { observer?.disconnect(); map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the pin in step with the value
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!location) {
      if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
      return;
    }
    const at = [location.lat, location.lng];
    if (!markerRef.current) {
      const marker = L.marker(at, { icon: pinIcon, draggable: editable, keyboard: editable, title: location.label || 'Shop location' }).addTo(map);
      if (editable) marker.on('dragend', () => { const p = marker.getLatLng(); changeRef.current?.({ lat: p.lat, lng: p.lng, zoom: map.getZoom() }); });
      markerRef.current = marker;
      map.setView(at, location.zoom || map.getZoom());
    } else {
      const jump = map.distance(markerRef.current.getLatLng(), at) > 300; // a search result or "my location", not a drag
      markerRef.current.setLatLng(at);
      if (jump) map.setView(at, location.zoom || 17);
      else if (!map.getBounds().contains(at)) map.panTo(at);
    }
  }, [location, editable]);

  return (
    <div className="shop-map-wrap">
      <style>{MAP_CSS}</style>
      <div ref={boxRef} className="shop-map" style={{ height }} role="region" aria-label={label} />
    </div>
  );
}

const MAP_CSS = `
.shop-map-wrap { width: 100%; }
.shop-map { width: 100%; border-radius: 4px; overflow: hidden; border: 1px solid rgba(127,127,127,.25); z-index: 0; }
.shop-map .leaflet-control-attribution { font-size: 10px; }
.shop-map a, .shop-map button { min-height: 0; }
.shop-pin { background: none; border: 0; }
.shop-pin-dot { position: absolute; left: 3px; top: 0; width: 24px; height: 24px; border-radius: 50% 50% 50% 0; background: #C41F2B;
  transform: rotate(-45deg); box-shadow: 0 3px 10px rgba(0,0,0,.45); border: 2px solid #fff; }
.shop-pin-dot::after { content: ''; position: absolute; left: 7px; top: 7px; width: 6px; height: 6px; border-radius: 50%; background: #fff; }
`;
