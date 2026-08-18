/**
 * Response-shape discovery for the admin console.
 *
 * Every flight API returns a different JSON shape, and a wrong field mapping
 * produces an engine that silently returns nothing. Rather than asking an
 * operator to guess JSON paths, the console makes ONE real request and this
 * module reads the actual response: it finds the array the offers live in and
 * proposes a mapping from the keys that are really there.
 *
 * Two rules the heuristics never break:
 *  - only paths that exist in the observed response are ever suggested;
 *  - a field that cannot be identified is left empty rather than guessed at,
 *    because a wrong mapping would silently corrupt prices.
 */

export interface ArrayCandidate {
  /** dot path to the array, '' for a top-level array */
  path: string;
  length: number;
  /** keys of the first object element, flattened one level deep */
  keys: string[];
  /** how strongly this array looks like a list of priced offers (0-100) */
  score: number;
}

export interface FieldGuess {
  path: string;
  /** the value observed at that path in the first element */
  sample: string;
  confidence: 'HIGH' | 'MEDIUM';
}

export interface DiscoveryResult {
  itemsPath: string;
  candidates: ArrayCandidate[];
  map: Record<string, string>;
  guesses: Record<string, FieldGuess>;
  /** mapping targets that could not be identified — the operator fills these */
  missing: string[];
  /** first element of the chosen array, truncated for display */
  sample: unknown;
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Walk the response and collect every array of objects, with its path. */
export function findArrays(body: unknown, maxDepth = 6): ArrayCandidate[] {
  const out: ArrayCandidate[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || node == null) return;
    if (Array.isArray(node)) {
      const objects = node.filter(isObj);
      if (objects.length) {
        out.push({
          path,
          length: node.length,
          keys: flatKeys(objects[0]!),
          score: scoreArray(objects[0]!, node.length),
        });
      }
      // arrays of arrays / nested offer lists are still worth looking into
      if (node.length && !objects.length) visit(node[0], path ? `${path}.0` : '0', depth + 1);
      return;
    }
    if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(body, '', 0);
  return out.sort((a, b) => b.score - a.score || b.length - a.length);
}

/** Keys of an object, including one level of nesting ("fare.total"). */
function flatKeys(o: Record<string, unknown>, prefix = '', depth = 0): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    keys.push(p);
    if (depth < 2 && isObj(v)) keys.push(...flatKeys(v, p, depth + 1));
    // the first element of a nested array (segments, legs) is worth exposing
    if (depth < 2 && Array.isArray(v) && isObj(v[0])) keys.push(...flatKeys(v[0], `${p}.0`, depth + 1));
  }
  return keys;
}

/** An array is a list of offers if its elements carry something price-like. */
function scoreArray(first: Record<string, unknown>, length: number): number {
  const keys = flatKeys(first);
  let score = Math.min(30, length * 2);
  if (keys.some((k) => PRICE_RE.test(k))) score += 45;
  if (keys.some((k) => CURRENCY_RE.test(k))) score += 10;
  if (keys.some((k) => AIRLINE_RE.test(k))) score += 8;
  if (keys.some((k) => DEPART_RE.test(k))) score += 7;
  return Math.min(100, score);
}

const PRICE_RE = /(^|\.)((total|grand|final|gross)?_?(price|fare|amount|cost)|price_?total|total)$/i;
const CURRENCY_RE = /(^|\.)(currency|curr)([._]?code)?$/i;
const AIRLINE_RE = /(^|\.)(airline|carrier|marketing_?carrier|operating_?carrier|validating_?carrier)([._]?(code|iata))?$/i;
const AIRLINE_NAME_RE = /(^|\.)(airline|carrier|marketing)[._]?name$/i;
const FLIGHTNO_RE = /(^|\.)(flight[._]?(number|no|num)|number)$/i;
const DEPART_RE = /(^|\.)(departure|depart|dep)(_?(time|at|date_?time|datetime))?$/i;
const ARRIVE_RE = /(^|\.)(arrival|arrive|arr)(_?(time|at|date_?time|datetime))?$/i;
const STOPS_RE = /(^|\.)(stops|stop_?count|number_?of_?changes|changes|transfers|num_?stops)$/i;
const DURATION_RE = /(^|\.)(duration(_?(minutes|min|mins|in_?minutes))?|total_?duration|flight_?time)$/i;
const BAGS_RE = /(^|\.)(bags|baggage|checked_?bags|baggage_?count|free_?baggage)$/i;
const URL_RE = /(^|\.)(booking_?url|deep_?link|link|url|redirect|book_?link)$/i;

const looksIso = (v: unknown): boolean =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v);
const looksIata = (v: unknown): boolean => typeof v === 'string' && /^[A-Z0-9]{2,3}$/.test(v);
const looksCurrency = (v: unknown): boolean => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const looksUrl = (v: unknown): boolean => typeof v === 'string' && /^https?:\/\//i.test(v);
const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

function readPath(obj: unknown, path: string): unknown {
  if (path === '') return obj; // '' addresses the root, e.g. a top-level array
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc)) {
      const i = Number(key);
      return Number.isInteger(i) ? acc[i] : undefined;
    }
    return isObj(acc) ? acc[key] : undefined;
  }, obj);
}

/**
 * Choose a path for one target field: a key whose NAME matches and whose
 * VALUE has the right shape scores highest; a value-only match is offered at
 * medium confidence; anything else is left for the operator.
 */
function guessField(
  item: Record<string, unknown>,
  keys: string[],
  nameRe: RegExp,
  valueOk: (v: unknown) => boolean,
): FieldGuess | undefined {
  const byName = keys.filter((k) => nameRe.test(k));
  const nameAndValue = byName.find((k) => valueOk(readPath(item, k)));
  if (nameAndValue) {
    return { path: nameAndValue, sample: preview(readPath(item, nameAndValue)), confidence: 'HIGH' };
  }
  // a name match whose value looks wrong is still the operator's best lead
  if (byName.length) {
    return { path: byName[0]!, sample: preview(readPath(item, byName[0]!)), confidence: 'MEDIUM' };
  }
  return undefined;
}

function preview(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

/** Deepest price wins: "fare.total" is a better price than a stray "total". */
function guessPrice(item: Record<string, unknown>, keys: string[]): FieldGuess | undefined {
  const priced = keys
    .filter((k) => PRICE_RE.test(k))
    .map((k) => ({ k, v: asNumber(readPath(item, k)) }))
    .filter((c): c is { k: string; v: number } => c.v !== undefined && c.v > 0)
    // prefer a nested total (fare.total) over a bare one, then the larger value
    .sort((a, b) => b.k.split('.').length - a.k.split('.').length || b.v - a.v);
  if (!priced.length) return undefined;
  return { path: priced[0]!.k, sample: String(priced[0]!.v), confidence: 'HIGH' };
}

const TARGETS = ['price', 'currency', 'airline', 'airlineName', 'flightNumber',
  'departureTime', 'arrivalTime', 'stops', 'durationMinutes', 'bags', 'bookingUrl'] as const;

/** Read a parsed response and propose an items path plus a field mapping. */
export function discoverMapping(body: unknown): DiscoveryResult {
  const warnings: string[] = [];
  const candidates = findArrays(body);
  if (!candidates.length) {
    return {
      itemsPath: '', candidates: [], map: {}, guesses: {},
      missing: [...TARGETS], sample: undefined,
      warnings: ['לא נמצא מערך תוצאות בתשובה. ייתכן שהבקשה החזירה שגיאה או שנדרשים פרמטרים נוספים.'],
    };
  }
  const best = candidates[0]!;
  const items = readPath(body, best.path);
  const item = (Array.isArray(items) ? items.find(isObj) : undefined) as Record<string, unknown> | undefined;
  if (!item) {
    return {
      itemsPath: best.path, candidates, map: {}, guesses: {},
      missing: [...TARGETS], sample: undefined,
      warnings: ['המערך שנמצא ריק מאובייקטים — נסו שאילתה עם תאריך אחר או מסלול פופולרי.'],
    };
  }
  const keys = flatKeys(item);

  const guesses: Record<string, FieldGuess> = {};
  const put = (field: string, g?: FieldGuess) => { if (g) guesses[field] = g; };

  put('price', guessPrice(item, keys));
  put('currency', guessField(item, keys, CURRENCY_RE, looksCurrency));
  put('airline', guessField(item, keys, AIRLINE_RE, looksIata));
  put('airlineName', guessField(item, keys, AIRLINE_NAME_RE, (v) => typeof v === 'string' && v.length > 2));
  put('flightNumber', guessField(item, keys, FLIGHTNO_RE, (v) => typeof v === 'string' || typeof v === 'number'));
  put('departureTime', guessField(item, keys, DEPART_RE, looksIso));
  put('arrivalTime', guessField(item, keys, ARRIVE_RE, looksIso));
  put('stops', guessField(item, keys, STOPS_RE, (v) => asNumber(v) !== undefined));
  put('durationMinutes', guessField(item, keys, DURATION_RE, (v) => asNumber(v) !== undefined));
  put('bags', guessField(item, keys, BAGS_RE, (v) => asNumber(v) !== undefined));
  put('bookingUrl', guessField(item, keys, URL_RE, looksUrl));

  const map: Record<string, string> = {};
  for (const [field, g] of Object.entries(guesses)) map[field] = g.path;

  if (!map.price) {
    warnings.push('לא זוהה שדה מחיר. בלי מחיר המערכת זורקת את התוצאה — סמנו את הנתיב הנכון ידנית.');
  }
  if (map.price && !map.currency) {
    warnings.push('לא זוהה שדה מטבע. ודאו באיזה מטבע ה-API מחזיר מחירים — אחרת ההשוואה תהיה שגויה.');
  }
  const durGuess = guesses.durationMinutes;
  if (durGuess && /hour|hr/i.test(durGuess.path)) {
    warnings.push('נראה שמשך הטיסה מדווח בשעות ולא בדקות — בדקו את הערך לפני שמירה.');
  }

  return {
    itemsPath: best.path,
    candidates: candidates.slice(0, 6),
    map,
    guesses,
    missing: TARGETS.filter((t) => !map[t]),
    sample: item,
    warnings,
  };
}
