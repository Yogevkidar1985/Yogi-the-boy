/**
 * Natural-language trip parser (§17, §30, §66) — Hebrew + English.
 *
 * Rule-based by default so it works with zero API keys; when ANTHROPIC_API_KEY
 * is set an LLM refinement step can be plugged in (LLMParser interface) without
 * changing callers.
 */
import type { ParsedTripRequest, Passengers } from '../core/types.js';
import { DEFAULT_PASSENGERS } from '../core/types.js';
import { resolveDestinationGroup, isValidAirport, DESTINATION_GROUPS } from '../core/airports.js';

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  ינואר: 1, פברואר: 2, מרץ: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7,
  אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12,
};

const ANYWHERE_PATTERNS = [
  /לא\s+אכפת\s+לי\s+לאן/, /anywhere/i, /לכל\s+מקום/, /לא\s+משנה\s+לאן/, /רק\s+שיהיה\s+זול/,
];

const WEEKEND_PATTERNS = [/סופ["']?ש/, /weekend/i, /סוף\s+שבוע/];

function monthWindow(month: number, now: Date): { from: string; to: string } {
  const refYear = now.getUTCFullYear();
  const refMonth = now.getUTCMonth() + 1;
  let year = refYear;
  if (month < refMonth) year += 1;
  let from = `${year}-${String(month).padStart(2, '0')}-01`;
  // current month: the window starts tomorrow, not on the 1st (already past)
  if (month === refMonth && year === refYear) {
    from = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${String(month).padStart(2, '0')}-${lastDay}` };
}

function extractTripLength(text: string): { min: number; max: number } | undefined {
  // "7-14 ימים" / "5 to 8 days" / "10-21 days"
  let m = text.match(/(\d+)\s*[-–עד]+\s*(\d+)\s*(?:ימים|days?|nights?|לילות)/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = text.match(/(\d+)\s*(?:ימים|days?|nights?|לילות)/);
  if (m) return { min: Number(m[1]), max: Number(m[1]) };
  if (/שבועיים|two weeks/i.test(text)) return { min: 12, max: 16 };
  if (/כשבוע|a week|שבוע/.test(text)) return { min: 6, max: 8 };
  return undefined;
}

function extractBudget(text: string): { maxPrice: number; currency: string } | undefined {
  const m = text.match(/(?:עד|under|below|max|-?\s*ב)\s*[€$₪£]?\s*(\d{2,5})\s*([€$₪£]|eur|usd|ils|gbp|שקל|יורו|דולר)?/i);
  if (!m) return undefined;
  const curMap: Record<string, string> = {
    '€': 'EUR', $: 'USD', '₪': 'ILS', '£': 'GBP', eur: 'EUR', usd: 'USD',
    ils: 'ILS', gbp: 'GBP', שקל: 'ILS', יורו: 'EUR', דולר: 'USD',
  };
  const sym = text.match(/[€$₪£]/)?.[0];
  return {
    maxPrice: Number(m[1]),
    currency: curMap[(m[2] ?? sym ?? '').toLowerCase()] ?? 'EUR',
  };
}

function extractPassengers(text: string): Passengers {
  const p = { ...DEFAULT_PASSENGERS };
  const adults = text.match(/(\d+)\s*(?:adults?|מבוגרים)/i);
  const children = text.match(/(\d+)\s*(?:children|kids|ילדים)/i);
  if (adults) p.adults = Number(adults[1]);
  if (children) p.children = Number(children[1]);
  if (/משפחה|family/i.test(text) && !adults) {
    p.adults = 2;
    if (!children) p.children = 2;
  }
  if (/זוג|couple/i.test(text) && !adults) p.adults = 2;
  return p;
}

/** Find destination phrases: known group names or explicit IATA codes. */
function extractPlaces(text: string): { origins: string[]; destinations: string[]; label?: string } {
  const origins: string[] = [];
  let destinations: string[] = [];
  let label: string | undefined;

  // explicit IATA codes like "TLV to JFK"
  const codes = [...text.matchAll(/\b([A-Z]{3})\b/g)].map((m) => m[1]!).filter(isValidAirport);
  if (codes.length >= 2) {
    origins.push(codes[0]!);
    destinations = codes.slice(1);
  } else if (codes.length === 1) {
    destinations = [codes[0]!];
  }

  // origin: "מתל אביב" / "from tel aviv"
  const originPatterns: [RegExp, string][] = [
    [/מתל\s*אביב|from\s+tel\s*aviv|תל\s*אביב/i, 'TLV'],
  ];
  for (const [re, code] of originPatterns) {
    if (re.test(text) && !origins.includes(code)) origins.unshift(code);
  }

  // destination group names (Hebrew/English), longest match first
  const lower = text.toLowerCase();
  const names = Object.keys(DESTINATION_GROUPS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (name === 'tel aviv' || name === 'תל אביב') continue;
    if (lower.includes(name)) {
      const group = resolveDestinationGroup(name);
      if (group) {
        destinations = group;
        label = name;
        break;
      }
    }
  }

  if (!origins.length) origins.push(process.env.DEFAULT_ORIGIN ?? 'TLV');
  return { origins, destinations, label };
}

export function parseTripRequest(text: string, now: Date = new Date()): ParsedTripRequest {
  const { origins, destinations, label } = extractPlaces(text);
  const tripLength = extractTripLength(text);
  const budget = extractBudget(text);
  const passengers = extractPassengers(text);

  // date window: month name or "next month" or explicit date range
  const refMonth = now.getUTCMonth() + 1;
  let window: { from: string; to: string } | undefined;
  for (const [name, num] of Object.entries(MONTHS)) {
    if (text.toLowerCase().includes(name)) {
      window = monthWindow(num, now);
      break;
    }
  }
  if (!window && /החודש הבא|next month/i.test(text)) {
    const m = refMonth === 12 ? 1 : refMonth + 1;
    window = monthWindow(m, now);
  }
  // "בסוף אוקטובר" narrows to the last third
  if (window && /סוף|end of|late/i.test(text)) {
    const [y, mo] = window.from.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
    window = { from: `${window.from.slice(0, 8)}20`, to: `${window.to.slice(0, 8)}${lastDay}` };
  }
  if (!window) {
    // default: next 60 days
    const from = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 67 * 86400000).toISOString().slice(0, 10);
    window = { from, to };
  }

  const anywhere = ANYWHERE_PATTERNS.some((re) => re.test(text));
  const weekend = WEEKEND_PATTERNS.some((re) => re.test(text));
  const cabin = /business|ביזנס|עסקים/i.test(text)
    ? 'BUSINESS'
    : /first|ראשונה/i.test(text)
      ? 'FIRST'
      : 'ECONOMY';

  const flexible = anywhere || weekend || !!tripLength || destinations.length !== 1 ||
    /גמיש|flexible|בערך|around|לא משנה.*מתי|whenever/i.test(text);

  return {
    origins,
    destinations,
    destinationLabel: anywhere ? 'anywhere' : label,
    departureWindow: window,
    tripLengthDays: tripLength,
    maxPrice: budget?.maxPrice,
    currency: budget?.currency,
    passengers,
    cabin,
    flexibility: flexible ? 'HIGH' : 'NONE',
    mode: anywhere ? 'ANYWHERE' : weekend ? 'WEEKEND' : flexible ? 'FLEXIBLE' : 'SPECIFIC',
    raw: text,
  };
}
