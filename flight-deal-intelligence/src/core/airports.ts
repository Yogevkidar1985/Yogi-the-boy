/**
 * Airport database (§12 airports table source) + nearby-airport groups (§18)
 * + destination groups for flexible/anywhere search (§17, §31).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from './cities.js';

// Reference data lives in assets/ — NOT in data/, which deployments may mount
// a persistent disk over (shadowing bundled files).
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

let airportsCache: Map<string, string> | null = null;

export function loadAirports(): Map<string, string> {
  if (airportsCache) return airportsCache;
  const map = new Map<string, string>();
  try {
    const csv = readFileSync(join(DATA_DIR, 'airports.csv'), 'utf-8');
    for (const line of csv.split('\n').slice(1)) {
      const idx = line.indexOf(',');
      if (idx > 0) map.set(line.slice(0, idx).trim().toUpperCase(), line.slice(idx + 1).trim());
    }
  } catch (err) {
    // A missing reference file must never take the API down — city search
    // (cities.ts) still works without it.
    console.error('[airports] failed to load airports.csv:', err instanceof Error ? err.message : err);
  }
  airportsCache = map;
  return map;
}

export function airportName(code: string): string | undefined {
  return loadAirports().get(code.toUpperCase());
}

export function isValidAirport(code: string): boolean {
  const map = loadAirports();
  if (map.size > 0) return map.has(code.toUpperCase());
  // airports DB unavailable — fall back to the curated city database
  const c = code.toUpperCase();
  return CITIES.some((e) => e.codes.includes(c));
}

/**
 * Nearby / alternative airports (§18). Each group lists alternates with an
 * estimated positioning cost (EUR) and time (hours) from the primary airport,
 * so True Trip Cost (§36) can include getting there.
 */
export interface NearbyAirport {
  code: string;
  positioningCostEur: number;
  positioningHours: number;
}

export const NEARBY_AIRPORTS: Record<string, NearbyAirport[]> = {
  TLV: [
    { code: 'LCA', positioningCostEur: 35, positioningHours: 1 },
    { code: 'ATH', positioningCostEur: 60, positioningHours: 2 },
    { code: 'CAI', positioningCostEur: 55, positioningHours: 1.5 },
  ],
  LON: [
    { code: 'LHR', positioningCostEur: 0, positioningHours: 0 },
    { code: 'LGW', positioningCostEur: 0, positioningHours: 0 },
    { code: 'STN', positioningCostEur: 0, positioningHours: 0 },
    { code: 'LTN', positioningCostEur: 0, positioningHours: 0 },
  ],
  LHR: [
    { code: 'LGW', positioningCostEur: 15, positioningHours: 1.5 },
    { code: 'STN', positioningCostEur: 15, positioningHours: 1.5 },
    { code: 'LTN', positioningCostEur: 12, positioningHours: 1.2 },
  ],
  NYC: [
    { code: 'JFK', positioningCostEur: 0, positioningHours: 0 },
    { code: 'EWR', positioningCostEur: 0, positioningHours: 0 },
    { code: 'LGA', positioningCostEur: 0, positioningHours: 0 },
  ],
  JFK: [
    { code: 'EWR', positioningCostEur: 10, positioningHours: 1 },
    { code: 'LGA', positioningCostEur: 8, positioningHours: 0.8 },
  ],
  PAR: [
    { code: 'CDG', positioningCostEur: 0, positioningHours: 0 },
    { code: 'ORY', positioningCostEur: 0, positioningHours: 0 },
    { code: 'BVA', positioningCostEur: 0, positioningHours: 0 },
  ],
  CDG: [
    { code: 'ORY', positioningCostEur: 12, positioningHours: 1.2 },
    { code: 'BVA', positioningCostEur: 17, positioningHours: 1.8 },
  ],
  TYO: [
    { code: 'NRT', positioningCostEur: 0, positioningHours: 0 },
    { code: 'HND', positioningCostEur: 0, positioningHours: 0 },
  ],
  MIL: [
    { code: 'MXP', positioningCostEur: 0, positioningHours: 0 },
    { code: 'LIN', positioningCostEur: 0, positioningHours: 0 },
    { code: 'BGY', positioningCostEur: 0, positioningHours: 0 },
  ],
  BER: [{ code: 'BER', positioningCostEur: 0, positioningHours: 0 }],
  ROM: [
    { code: 'FCO', positioningCostEur: 0, positioningHours: 0 },
    { code: 'CIA', positioningCostEur: 0, positioningHours: 0 },
  ],
};

export function nearbyAirports(code: string): NearbyAirport[] {
  return NEARBY_AIRPORTS[code.toUpperCase()] ?? [];
}

/** Expand a metro/city code or airport code into concrete airport codes. */
export function expandAirportCodes(code: string): string[] {
  const c = code.toUpperCase();
  const group = NEARBY_AIRPORTS[c];
  if (group && !isValidAirport(c)) return group.map((g) => g.code);
  return [c];
}

/**
 * Destination groups for "fly me to Japan / Europe / anywhere" (§17, §31).
 * Keys are lowercase names (English + Hebrew).
 */
export const DESTINATION_GROUPS: Record<string, string[]> = {
  japan: ['NRT', 'HND', 'KIX', 'NGO'],
  יפן: ['NRT', 'HND', 'KIX', 'NGO'],
  greece: ['ATH', 'SKG', 'HER', 'RHO', 'JTR'],
  יוון: ['ATH', 'SKG', 'HER', 'RHO', 'JTR'],
  italy: ['FCO', 'MXP', 'VCE', 'NAP', 'BGY'],
  איטליה: ['FCO', 'MXP', 'VCE', 'NAP', 'BGY'],
  spain: ['MAD', 'BCN', 'AGP', 'PMI'],
  ספרד: ['MAD', 'BCN', 'AGP', 'PMI'],
  thailand: ['BKK', 'DMK', 'HKT', 'CNX'],
  תאילנד: ['BKK', 'DMK', 'HKT', 'CNX'],
  'new york': ['JFK', 'EWR', 'LGA'],
  'ניו יורק': ['JFK', 'EWR', 'LGA'],
  london: ['LHR', 'LGW', 'STN', 'LTN'],
  לונדון: ['LHR', 'LGW', 'STN', 'LTN'],
  paris: ['CDG', 'ORY', 'BVA'],
  פריז: ['CDG', 'ORY', 'BVA'],
  amsterdam: ['AMS'],
  אמסטרדם: ['AMS'],
  berlin: ['BER'],
  ברלין: ['BER'],
  rome: ['FCO', 'CIA'],
  רומא: ['FCO', 'CIA'],
  tokyo: ['NRT', 'HND'],
  טוקיו: ['NRT', 'HND'],
  europe: ['ATH', 'LCA', 'OTP', 'BUD', 'VIE', 'PRG', 'WAW', 'SOF', 'BCN', 'FCO', 'CDG', 'AMS', 'BER', 'LHR', 'MAD', 'LIS'],
  אירופה: ['ATH', 'LCA', 'OTP', 'BUD', 'VIE', 'PRG', 'WAW', 'SOF', 'BCN', 'FCO', 'CDG', 'AMS', 'BER', 'LHR', 'MAD', 'LIS'],
  usa: ['JFK', 'EWR', 'MIA', 'LAX', 'SFO', 'BOS'],
  'ארהב': ['JFK', 'EWR', 'MIA', 'LAX', 'SFO', 'BOS'],
  dubai: ['DXB'],
  דובאי: ['DXB'],
  asia: ['BKK', 'DMK', 'HKT', 'NRT', 'HND', 'ICN', 'SGN', 'HAN', 'DEL', 'BOM', 'CMB', 'KUL', 'SIN', 'TPE'],
  אסיה: ['BKK', 'DMK', 'HKT', 'NRT', 'HND', 'ICN', 'SGN', 'HAN', 'DEL', 'BOM', 'CMB', 'KUL', 'SIN', 'TPE'],
  nearby: ['LCA', 'ATH', 'IST', 'SAW', 'CAI', 'AMM', 'TBS', 'EVN', 'BAK', 'OTP', 'SOF', 'BEG', 'SKG'],
  קרוב: ['LCA', 'ATH', 'IST', 'SAW', 'CAI', 'AMM', 'TBS', 'EVN', 'BAK', 'OTP', 'SOF', 'BEG', 'SKG'],
  'middle east': ['IST', 'SAW', 'DXB', 'AUH', 'CAI', 'AMM', 'DOH', 'BAH'],
  'המזרח התיכון': ['IST', 'SAW', 'DXB', 'AUH', 'CAI', 'AMM', 'DOH', 'BAH'],
  'tel aviv': ['TLV'],
  'תל אביב': ['TLV'],
  israel: ['TLV'],
  ישראל: ['TLV'],
  greece_all: ['ATH', 'SKG', 'HER', 'RHO', 'JTR'],
  germany: ['BER', 'MUC', 'FRA', 'DUS', 'HAM'],
  גרמניה: ['BER', 'MUC', 'FRA', 'DUS', 'HAM'],
  france: ['CDG', 'ORY', 'NCE', 'LYS', 'MRS'],
  צרפת: ['CDG', 'ORY', 'NCE', 'LYS', 'MRS'],
  cyprus: ['LCA', 'PFO'],
  קפריסין: ['LCA', 'PFO'],
  turkey: ['IST', 'SAW', 'AYT', 'ADB'],
  טורקיה: ['IST', 'SAW', 'AYT', 'ADB'],
  uk: ['LHR', 'LGW', 'STN', 'MAN', 'EDI'],
  אנגליה: ['LHR', 'LGW', 'STN', 'MAN', 'EDI'],
  בריטניה: ['LHR', 'LGW', 'STN', 'MAN', 'EDI'],
  portugal: ['LIS', 'OPO', 'FAO'],
  פורטוגל: ['LIS', 'OPO', 'FAO'],
  netherlands: ['AMS', 'EIN'],
  הולנד: ['AMS', 'EIN'],
};

/** Popular short/medium-haul destinations from TLV for Cheapest Anywhere mode (§31). */
export const ANYWHERE_DESTINATIONS: string[] = [
  'LCA', 'ATH', 'OTP', 'BUD', 'VIE', 'PRG', 'WAW', 'SOF', 'KRK', 'BEG',
  'IST', 'SAW', 'TBS', 'EVN', 'BAK', 'DXB', 'AUH', 'CAI', 'AMM',
  'BCN', 'MAD', 'FCO', 'MXP', 'CDG', 'AMS', 'BER', 'MUC', 'LHR', 'STN',
  'LIS', 'CPH', 'ARN', 'HEL', 'ZRH', 'GVA', 'BRU', 'DUB', 'EDI',
];

export function resolveDestinationGroup(name: string): string[] | undefined {
  return DESTINATION_GROUPS[name.trim().toLowerCase()];
}
