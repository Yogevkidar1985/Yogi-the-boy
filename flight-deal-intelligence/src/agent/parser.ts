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

/** Direct-flight intent. "בלי עצירות" / "ישירה" / "nonstop" → maxStops 0. */
function extractStops(text: string): number | undefined {
  if (/ישיר(ה|ות|ים)?|בלי\s*עצירות|ללא\s*עצירות|non[- ]?stop|direct/i.test(text)) return 0;
  const m = text.match(/(?:עד|max(?:imum)?)\s*(\d)\s*(?:עצירות|עצירה|stops?)/i);
  if (m) return Number(m[1]);
  if (/עצירה\s*אחת|one\s*stop/i.test(text)) return 1;
  return undefined;
}

/** Airline preferences: "רק אל על", "חוץ מ-Ryanair", "בלי לואו קוסט". */
const AIRLINE_NAMES: Record<string, string> = {
  'אל על': 'LY', elal: 'LY', 'el al': 'LY',
  ויזאיר: 'W6', wizz: 'W6', wizzair: 'W6',
  ריינאייר: 'FR', ryanair: 'FR',
  ארקיע: 'IZ', arkia: 'IZ',
  ישראייר: '6H', israir: '6H',
  לופטהנזה: 'LH', lufthansa: 'LH',
  טורקיש: 'TK', turkish: 'TK',
  'איזיג׳ט': 'U2', easyjet: 'U2',
  'אג׳יאן': 'A3', aegean: 'A3',
};

function extractAirlines(text: string): { airlines?: string[]; excludeAirlines?: string[] } {
  const lower = text.toLowerCase();
  const airlines: string[] = [];
  const excluded: string[] = [];
  for (const [name, code] of Object.entries(AIRLINE_NAMES)) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx < 0) continue;
    // look at the words right before the airline name to tell want from avoid
    const before = lower.slice(Math.max(0, idx - 22), idx);
    if (/(חוץ\s*מ|בלי|לא|without|except|no)\s*[-–]?\s*$/.test(before)) excluded.push(code);
    else airlines.push(code);
  }
  // low-cost carriers as a group
  if (/בלי\s*לואו\s*קוסט|לא\s*לואו\s*קוסט|no\s*low[- ]?cost/i.test(text)) {
    excluded.push('FR', 'W6', 'U2');
  }
  return {
    airlines: airlines.length ? [...new Set(airlines)] : undefined,
    excludeAirlines: excluded.length ? [...new Set(excluded)] : undefined,
  };
}

/** Checked baggage: "עם מזוודה", "2 מזוודות", "carry-on only" → 0. */
function extractBaggage(text: string): number | undefined {
  if (/רק\s*יד|ללא\s*מזווד|בלי\s*מזווד|carry[- ]?on\s*only|hand\s*luggage\s*only/i.test(text)) return 0;
  const m = text.match(/(\d)\s*(?:מזוודות|מזוודה|checked\s*bags?|suitcases?)/i);
  if (m) return Number(m[1]);
  if (/כולל\s*מזווד|עם\s*מזווד|with\s*(?:a\s*)?(?:checked\s*)?bag|suitcase/i.test(text)) return 1;
  return undefined;
}

/** Departure time preferences → an hour window. */
function extractTimeWindow(text: string): [number, number] | undefined {
  const after = text.match(/(?:אחרי|after|לא\s*לפני|not\s*before)\s*(\d{1,2})(?::(\d{2}))?/i);
  const before = text.match(/(?:לפני|before|עד\s*השעה)\s*(\d{1,2})(?::(\d{2}))?/i);
  if (after || before) {
    const lo = after ? Number(after[1]) : 0;
    const hi = before ? Number(before[1]) : 24;
    if (lo < hi) return [lo, hi];
  }
  if (/בוקר|morning/i.test(text)) return [5, 12];
  if (/צהריי?ם|afternoon/i.test(text)) return [12, 18];
  if (/ערב|evening/i.test(text)) return [17, 23];
  if (/לילה|night/i.test(text)) return [22, 24];
  return undefined;
}

function extractBudget(text: string): { maxPrice: number; currency: string } | undefined {
  // "עד 30 באוגוסט" is a date, not a budget — drop date phrases before
  // looking for money, otherwise a trip range becomes a €30 price cap
  const monthAlt = Object.keys(MONTHS).join('|');
  const clean = text
    .replace(new RegExp(`\\d{1,2}\\s*(?:ל|עד|[-–])?\\s*\\d{0,2}\\s*ב?(?:${monthAlt})`, 'gi'), ' ')
    .replace(/\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/g, ' ')
    .replace(/\d+\s*(?:ימים|יום|לילות|לילה|days?|nights?)/gi, ' ');
  const m = clean.match(/(?:עד|under|below|max|-?\s*ב)\s*[€$₪£]?\s*(\d{2,5})\s*([€$₪£]|eur|usd|ils|gbp|שקל|יורו|דולר)?/i);
  if (!m) return undefined;
  const hasCurrency = Boolean(m[2]) || /[€$₪£]/.test(clean);
  // an unqualified small number is far more likely a count than a price
  if (!hasCurrency && Number(m[1]) < 50) return undefined;
  const curMap: Record<string, string> = {
    '€': 'EUR', $: 'USD', '₪': 'ILS', '£': 'GBP', eur: 'EUR', usd: 'USD',
    ils: 'ILS', gbp: 'GBP', שקל: 'ILS', יורו: 'EUR', דולר: 'USD',
  };
  const sym = clean.match(/[€$₪£]/)?.[0];
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

/** One place mentioned in the text, with where it appeared and how. */
interface PlaceMention {
  /** index in the text, used to keep the order the user wrote */
  at: number;
  label: string;
  codes: string[];
  /** 'from' / 'to' when the sentence marked it explicitly */
  role: 'from' | 'to' | null;
}

/**
 * Direction is a hard constraint, never a guess: "מאיטליה לישראל" means
 * origin=Italy, destination=Israel — the opposite search is a different trip.
 * We read the explicit markers (Hebrew מ־/ל־ prefixes, English from/to, arrows)
 * and only fall back to word order when the user gave none.
 */
function extractPlaces(text: string): {
  origins: string[];
  destinations: string[];
  label?: string;
  originLabel?: string;
  ambiguousDirection: boolean;
  explicitOrigin: boolean;
} {
  const lower = text.toLowerCase();
  const mentions: PlaceMention[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  // 1) named places (countries, regions, cities), longest name first so
  //    "new york" wins over "york" and "תל אביב" over "אביב"
  for (const name of Object.keys(DESTINATION_GROUPS).sort((a, b) => b.length - a.length)) {
    let idx = lower.indexOf(name);
    while (idx >= 0) {
      if (!overlaps(idx, idx + name.length)) {
        const codes = resolveDestinationGroup(name);
        if (codes) {
          taken.push([idx, idx + name.length]);
          // marker directly before the name decides the role
          const before = text.slice(Math.max(0, idx - 14), idx);
          const prevChar = idx > 0 ? text[idx - 1] : '';
          let role: 'from' | 'to' | null = null;
          if (/\bfrom\s+$|\bמ\s*$|[-–]\s*$/i.test(before) || prevChar === 'מ') role = 'from';
          else if (/\bto\s+$|→\s*$|\bל\s*$/i.test(before) || prevChar === 'ל') role = 'to';
          mentions.push({ at: idx, label: name, codes, role });
        }
      }
      idx = lower.indexOf(name, idx + 1);
    }
  }

  // 2) explicit IATA codes ("FCO → TLV")
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    const code = m[1]!;
    const at = m.index ?? 0;
    if (!isValidAirport(code) || overlaps(at, at + 3)) continue;
    const before = text.slice(Math.max(0, at - 14), at);
    const role = /\bfrom\s+$|\bמ\s*$/i.test(before) ? 'from'
      : /\bto\s+$|→\s*$|[-–>]\s*$|\bל\s*$/i.test(before) ? 'to' : null;
    mentions.push({ at, label: code, codes: [code], role });
  }

  mentions.sort((a, b) => a.at - b.at);

  const marked = { from: mentions.find((m) => m.role === 'from'), to: mentions.find((m) => m.role === 'to') };
  let origin: PlaceMention | undefined = marked.from;
  let destination: PlaceMention | undefined = marked.to;
  let ambiguousDirection = false;

  if (!origin && !destination && mentions.length >= 2) {
    // no markers at all ("Italy Israel flights") — order is the only signal,
    // so honour it but record that the direction was not stated explicitly
    origin = mentions[0];
    destination = mentions[1];
    ambiguousDirection = true;
  } else if (origin && !destination) {
    destination = mentions.find((m) => m !== origin);
  } else if (!origin && destination) {
    origin = mentions.find((m) => m !== destination && m.at < destination!.at);
  } else if (!origin && !destination && mentions.length === 1) {
    // a single unmarked place is where the user wants to GO ("flights to Rome",
    // "אני רוצה אירופה") — the origin then falls back to the configured home
    destination = mentions[0];
  }

  const explicitOrigin = Boolean(origin);
  const originCodes = origin?.codes ?? [process.env.DEFAULT_ORIGIN ?? 'TLV'];
  let destCodes = destination?.codes ?? [];
  // never search a route into its own origin
  destCodes = destCodes.filter((c) => !originCodes.includes(c));

  return {
    origins: originCodes,
    destinations: destCodes,
    label: destination?.label,
    originLabel: origin?.label,
    ambiguousDirection: ambiguousDirection && mentions.length >= 2,
    explicitOrigin,
  };
}

const HE_MONTH_NAMES = Object.keys(MONTHS).filter((k) => /[֐-׿]/.test(k));

/** Explicit and relative dates — deterministic, never guessed by a model. */
function extractExplicitWindow(text: string, now: Date): { from: string; to: string } | undefined {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const at = (days: number) => iso(new Date(now.getTime() + days * 86400000));

  // JS \b does not work next to Hebrew letters (they are not \w), so Hebrew
  // words are bounded by whitespace/punctuation/string edges explicitly
  const heWord = (w: string) => new RegExp(`(^|[\\s,.!?"'\\-–])${w}($|[\\s,.!?"'\\-–])`);
  if (heWord('היום').test(text) || /\btoday\b/i.test(text)) return { from: iso(now), to: iso(now) };
  if (/מחרתיים/.test(text)) return { from: at(2), to: at(2) };
  if (heWord('מחר').test(text) || /\btomorrow\b/i.test(text)) return { from: at(1), to: at(1) };

  // "בעוד שבועיים" / "in two weeks" / "בעוד 10 ימים"
  let m = text.match(/בעוד\s*(\d+)\s*(ימים|יום|שבועות|שבוע)/);
  if (m) {
    const n = Number(m[1]) * (/שבוע/.test(m[2]!) ? 7 : 1);
    return { from: at(n), to: at(n + 3) };
  }
  if (/בעוד\s*שבועיים|in\s*two\s*weeks/i.test(text)) return { from: at(14), to: at(17) };
  if (/השבוע\s*הבא|next\s*week/i.test(text)) return { from: at(7), to: at(14) };
  if (/סוף\s*השבוע\s*הבא|next\s*weekend/i.test(text)) return { from: at(7), to: at(14) };

  const monthNum = (name: string) => MONTHS[name.toLowerCase()];
  const yearFor = (mo: number) => (mo < now.getUTCMonth() + 1 ? now.getUTCFullYear() + 1 : now.getUTCFullYear());
  const mk = (mo: number, day: number) => `${yearFor(mo)}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // range within a month: "בין ה-10 ל-20 בספטמבר" / "29 באוגוסט עד 30 באוגוסט"
  const monthAlt = HE_MONTH_NAMES.join('|');
  m = text.match(new RegExp(`(\\d{1,2})\\s*(?:ל|עד|[-–])\\s*(\\d{1,2})\\s*ב?(${monthAlt})`));
  if (m) {
    const mo = monthNum(m[3]!)!;
    return { from: mk(mo, Number(m[1])), to: mk(mo, Number(m[2])) };
  }
  // "29 באוגוסט עד 30 באוגוסט" (month repeated)
  m = text.match(new RegExp(`(\\d{1,2})\\s*ב?(${monthAlt}).{0,12}?(\\d{1,2})\\s*ב?(${monthAlt})`));
  if (m) {
    const mo1 = monthNum(m[2]!)!, mo2 = monthNum(m[4]!)!;
    return { from: mk(mo1, Number(m[1])), to: mk(mo2, Number(m[3])) };
  }
  // single day: "29 באוגוסט"
  m = text.match(new RegExp(`(\\d{1,2})\\s*ב(${monthAlt})`));
  if (m) {
    const mo = monthNum(m[2]!)!;
    const d = mk(mo, Number(m[1]));
    return { from: d, to: d };
  }
  // numeric dates: 29/08, 29.08, 29/08/2026 — optionally a range
  const num = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/g;
  const hits = [...text.matchAll(num)];
  if (hits.length) {
    const toIso = (h: RegExpMatchArray) => {
      const day = Number(h[1]), mo = Number(h[2]);
      if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
      const yr = h[3] ? (Number(h[3]) < 100 ? 2000 + Number(h[3]) : Number(h[3])) : yearFor(mo);
      return `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };
    const a = toIso(hits[0]!);
    const b = hits[1] ? toIso(hits[1]!) : null;
    if (a) return { from: a, to: b ?? a };
  }
  return undefined;
}

export function parseTripRequest(text: string, now: Date = new Date()): ParsedTripRequest {
  const places = extractPlaces(text);
  const { origins, destinations, label } = places;
  const tripLength = extractTripLength(text);
  const budget = extractBudget(text);
  const passengers = extractPassengers(text);

  // date window: explicit/relative dates first, then month name, then default
  const refMonth = now.getUTCMonth() + 1;
  let window = extractExplicitWindow(text, now);
  if (!window) for (const [name, num] of Object.entries(MONTHS)) {
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

  const airlinePrefs = extractAirlines(text);
  const missing: ParsedTripRequest['missing'] = [];
  if (!places.explicitOrigin) missing.push('origin');
  if (!destinations.length && !anywhere) missing.push('destination');

  return {
    origins,
    destinations,
    destinationLabel: anywhere ? 'anywhere' : label,
    originLabel: places.originLabel,
    departureWindow: window,
    tripLengthDays: tripLength,
    maxPrice: budget?.maxPrice,
    currency: budget?.currency,
    passengers,
    cabin,
    flexibility: flexible ? 'HIGH' : 'NONE',
    mode: anywhere ? 'ANYWHERE' : weekend ? 'WEEKEND' : flexible ? 'FLEXIBLE' : 'SPECIFIC',
    raw: text,
    maxStops: extractStops(text),
    budgetPerPerson: /לאדם|per\s*person|לנוסע/i.test(text) || undefined,
    airlines: airlinePrefs.airlines,
    excludeAirlines: airlinePrefs.excludeAirlines,
    checkedBags: extractBaggage(text),
    departureTimeWindow: extractTimeWindow(text),
    ambiguousDirection: places.ambiguousDirection || undefined,
    missing: missing.length ? missing : undefined,
  };
}
