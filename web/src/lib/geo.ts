/**
 * Reading the geocoded location off a case, and turning it into a map.
 *
 * The geocoding fields are added to `Case` by the backend and are optional on
 * the wire: a case created seconds ago has a `location` in the caller's own
 * words and nothing else until the geocoder answers. Every reader here is
 * defensive about that, because "not resolved yet" is a normal state that the
 * panel has to render honestly rather than a failure.
 *
 * The map itself is an OpenStreetMap embed - an iframe, a bounding box and a
 * marker. No key, no account and no map library in the bundle.
 */

import type { Case } from "./types";

export type LocationPrecision = "exact" | "approximate" | "unresolved";

/** Geocoding fields the backend puts on a case. All optional on the wire. */
export interface CaseGeoFields {
  /** The caller's own words, before normalisation. */
  location_text?: string | null;
  /** The normalised postal address. */
  location_formatted?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  location_precision?: LocationPrecision | null;
  /** On-site note: "Right lane near crosswalk, curb side." */
  location_detail?: string | null;
}

export type GeoCase = Case & CaseGeoFields;

/** Every geocoding field the panel and the summary read, already resolved. */
export interface CaseGeo {
  /** What the caller said, falling back to the legacy `location` field. */
  spoken: string | null;
  /** The normalised address, or the spoken text when nothing normalised it. */
  formatted: string | null;
  latitude: number | null;
  longitude: number | null;
  precision: LocationPrecision;
  detail: string | null;
  /** True only when there is a point good enough to drop a pin on. */
  hasPoint: boolean;
  /**
   * The geocoder has not answered at all yet - no point and no precision.
   * Distinct from `unresolved`, which is a geocoder that answered "no match".
   */
  pending: boolean;
}

/** Names of the geocoding fields, as they appear in a `changed` list. */
export const GEO_FIELDS = [
  "location",
  "location_text",
  "location_formatted",
  "latitude",
  "longitude",
  "location_precision",
  "location_detail",
] as const;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coordinates may arrive as numbers or as strings; both are real answers. */
function coordinate(value: unknown, limit: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return null;
  return parsed;
}

function precisionOf(value: unknown): LocationPrecision | null {
  return value === "exact" || value === "approximate" || value === "unresolved" ? value : null;
}

export function readGeo(item: Case | GeoCase | null): CaseGeo {
  const geo = (item ?? {}) as GeoCase;
  const spoken = text(geo.location_text) ?? text(geo.location) ?? text(geo.address);
  const formatted = text(geo.location_formatted);
  const latitude = coordinate(geo.latitude, 90);
  const longitude = coordinate(geo.longitude, 180);
  const hasPoint = latitude !== null && longitude !== null;
  const stated = precisionOf(geo.location_precision);
  // A point with no stated precision is at least a point; without one the
  // panel must say so rather than imply a resolved address.
  const precision = stated ?? (hasPoint ? "exact" : "unresolved");

  return {
    spoken,
    formatted: formatted ?? spoken,
    latitude,
    longitude,
    precision,
    detail: text(geo.location_detail),
    hasPoint: hasPoint && precision !== "unresolved",
    pending: !hasPoint && stated === null,
  };
}

/**
 * Half-width of the map's bounding box, in degrees.
 *
 * An approximate match gets a wider box: the pin is a neighbourhood, and a
 * tight crop around it would read as a rooftop it has not earned.
 */
const BBOX_DEGREES: Record<LocationPrecision, number> = {
  exact: 0.0022,
  approximate: 0.0075,
  unresolved: 0.02,
};

/** OpenStreetMap embed URL for one point: a bounding box plus a marker. */
export function osmEmbedUrl(latitude: number, longitude: number, precision: LocationPrecision): string {
  const pad = BBOX_DEGREES[precision] ?? BBOX_DEGREES.exact;
  // Longitude degrees narrow towards the poles; widen so the crop stays square.
  const lonPad = pad / Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  const bbox = [longitude - lonPad, latitude - pad, longitude + lonPad, latitude + pad]
    .map((value) => value.toFixed(6))
    .join(",");
  const params = new URLSearchParams({
    bbox,
    layer: "mapnik",
    marker: `${latitude.toFixed(6)},${longitude.toFixed(6)}`,
  });
  return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
}

/** A link to the same point, opened in whatever handles maps on this device. */
export function mapsLink(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(6);
  const lon = longitude.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

/**
 * Two lines for the card: the street, then the city and state.
 *
 * Nominatim returns its whole display name - street, neighbourhood, city,
 * county, state, postcode, country - which is accurate and unreadable. The
 * street is the first part, and the city and state are the last two that
 * survive dropping the country, the postcode and the county, which is the
 * "Berkeley, CA" an envelope would carry.
 */
export function addressLines(formatted: string | null): { street: string; region: string | null } | null {
  if (!formatted) return null;
  const parts = formatted
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { street: formatted, region: null };

  // Nominatim emits the house number as its own comma part, so taking the
  // first part alone leaves the card headlined "2210". Rejoin the number with
  // the street it belongs to.
  const numbered = /^\d+[a-z]?$/i.test(parts[0]) && parts.length > 1;
  const street = numbered ? `${parts[0]} ${parts[1]}` : parts[0];
  const tail = parts.slice(numbered ? 2 : 1);
  const rest = tail
    .filter((part) => !/^(usa|united states(\s+of\s+america)?)$/i.test(part))
    .filter((part) => !/^\d{5}(-\d{4})?$/.test(part))
    .filter((part) => !/\bcounty\b/i.test(part))
    // The street line often repeats as its own part on a named crossing.
    .filter((part) => !street.toLowerCase().includes(part.toLowerCase()));

  const region = rest.slice(-2).map(shortenState).join(", ");
  return { street, region: region.length > 0 ? region : null };
}

/**
 * The geocoder is bounded to a Berkeley viewbox, so California is the only
 * state a result can carry; anything else is left exactly as it came.
 */
function shortenState(part: string): string {
  return /^california$/i.test(part) ? "CA" : part;
}
