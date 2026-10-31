import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * A map (OpenStreetMap, through Leaflet) for pins and rounds (23 Oct 2026).
 *
 * Two uses:
 *  - a round: numbered stops, the plant ("W"), and the line from the plant
 *    through each stop and back;
 *  - one pin to place: click the map or drag the pin, and onPick gets it.
 * The map needs internet to draw; with none, the list beside it still works.
 */

export interface MapPoint { lat: number; lng: number; n?: number; label?: string; approximate?: boolean }
export interface LatLng { lat: number; lng: number }

const KINGSTON: L.LatLngExpression = [18.01, -76.85];

function numberIcon(n: number | string, bg = '#0e76bc', square = false) {
  return L.divIcon({
    className: '',
    html: `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;`
      + `border-radius:${square ? '6px' : '999px'};background:${bg};color:#fff;font:800 13px system-ui,sans-serif;`
      + `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35)">${n}</span>`,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
}
const pinIcon = L.divIcon({
  className: '',
  html: '<svg width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39s13-13.6 13-24A13 13 0 0 0 2 15c0 10.4 13 24 13 24z" fill="#0e76bc" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>',
  iconSize: [30, 40], iconAnchor: [15, 39],
});

export default function MapView({
  points = [], plant = null, line = false, pick, onPick, height = 360, label,
}: {
  points?: MapPoint[];
  plant?: LatLng | null;
  line?: boolean;
  /** One pin to place: where it is now (null = not placed yet). */
  pick?: LatLng | null;
  onPick?: (p: LatLng) => void;
  height?: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!box.current || map.current) return;
    const m = L.map(box.current, { scrollWheelZoom: false }).setView(KINGSTON, 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => pickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (plant) {
      L.marker([plant.lat, plant.lng], { icon: numberIcon('W', '#2d3590', true), title: 'The plant' }).addTo(g);
      bounds.push([plant.lat, plant.lng]);
    }
    if (line && plant && points.length) {
      const path: L.LatLngExpression[] = [[plant.lat, plant.lng], ...points.map((p) => [p.lat, p.lng] as L.LatLngExpression), [plant.lat, plant.lng]];
      L.polyline(path, { color: '#0e76bc', weight: 4, opacity: 0.8 }).addTo(g);
    }
    for (const p of points) {
      // Approximate pins (from the typed address) in a paler blue.
      L.marker([p.lat, p.lng], { icon: numberIcon(p.n ?? '•', p.approximate ? '#6aa9d8' : '#0e76bc'), title: p.approximate ? `${p.label ?? ''} (approximate)` : p.label }).addTo(g);
      bounds.push([p.lat, p.lng]);
    }
    if (onPick && pick) {
      const mk = L.marker([pick.lat, pick.lng], { icon: pinIcon, draggable: true, title: 'Drag to move' }).addTo(g);
      mk.on('dragend', () => { const ll = mk.getLatLng(); pickRef.current?.({ lat: ll.lat, lng: ll.lng }); });
      bounds.push([pick.lat, pick.lng]);
    }
    if (bounds.length === 1) m.setView(bounds[0], onPick ? 17 : 14);
    else if (bounds.length > 1) m.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 16 });
  }, [points, plant, line, pick, onPick]);

  useEffect(() => { setTimeout(() => map.current?.invalidateSize(), 50); });

  return <div ref={box} role="region" aria-label={label} style={{ height, borderRadius: 8, border: '1px solid var(--line)', zIndex: 0 }} />;
}
