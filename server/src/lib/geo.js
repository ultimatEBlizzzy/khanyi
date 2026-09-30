const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
  if (!a || !b) return 0;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Road distance is always longer than the crow-flies distance. We apply a
 * detour factor so the fee and ETA feel honest for a township road network.
 */
export const ROAD_FACTOR = 1.35;

export function roadKm(a, b) {
  const straight = haversineKm(a, b);
  return Math.round(straight * ROAD_FACTOR * 10) / 10;
}

/** Average speed by vehicle, km/h — used for the ETA engine. */
export const SPEED_KMH = { bike: 18, scooter: 24, car: 30 };

export function travelMinutes(km, vehicle = 'scooter') {
  const speed = SPEED_KMH[vehicle] ?? 24;
  return Math.max(4, Math.round((km / speed) * 60));
}
