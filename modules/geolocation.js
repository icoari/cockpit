// Returns the user's current position, or null if unavailable.
// Caches in-memory for 5 minutes to avoid repeated permission prompts.

let cached = null; // { ts, coords }
const TTL = 5 * 60 * 1000;

export async function getPosition({ timeout = 8000 } = {}) {
  if (cached && Date.now() - cached.ts < TTL) return cached.coords;

  if (!('geolocation' in navigator)) return null;

  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, timeout);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        cached = { ts: Date.now(), coords: { lat: pos.coords.latitude, lon: pos.coords.longitude } };
        resolve(cached.coords);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(null);
      },
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout }
    );
  });
}

// Great-circle distance in km between two lat/lon points
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
