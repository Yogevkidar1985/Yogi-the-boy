/**
 * Built-in engine catalogue.
 *
 * Every engine the system knows how to talk to, in one place, so adding one is
 * "pick from a list and paste a key" instead of hunting through vendor docs.
 *
 * The catalogue states plainly how ready each engine is. An entry never claims
 * a URL that was not taken from the vendor's own documentation: where the
 * request shape is unknown, `readiness` says so and the URL is left empty for
 * the operator to fill from the vendor's docs (the console's auto-detection
 * then works out the response mapping).
 *
 * Nothing here contains a credential. Keys are supplied by the operator and
 * stored encrypted.
 */

export type EngineReadiness =
  /** built-in adapter — configure with environment variables, not this form */
  | 'BUILT_IN'
  /** request URL documented and filled in; paste a key and it runs */
  | 'READY'
  /** URL must be copied from the vendor's docs; response mapping auto-detects */
  | 'NEEDS_URL'
  /** needs an ID-resolution call before search (not IATA-addressable yet) */
  | 'NEEDS_LOOKUP'
  /** returns schedules/status, never fares — useless as a search engine */
  | 'STATUS_ONLY'
  /** no self-serve access at the moment */
  | 'CLOSED';

export interface EngineTemplate {
  id: string;
  label: string;
  vendor: string;
  readiness: EngineReadiness;
  /** where an operator obtains the key */
  signupUrl: string;
  docsUrl?: string;
  /** request template; empty when the shape has to come from the vendor docs */
  urlTemplate?: string;
  headers?: Record<string, string>;
  /** filled only where the response shape is known; otherwise auto-detected */
  itemsPath?: string;
  map?: Record<string, string>;
  tier: 'FREE' | 'LOW_COST' | 'PAID' | 'PREMIUM';
  requestsPerMinute?: number;
  concurrency?: number;
  /** environment variables, for built-in adapters */
  envVars?: string[];
  /** what the operator needs to know before switching it on */
  note: string;
}

export const ENGINE_CATALOGUE: EngineTemplate[] = [
  // ---- built-in adapters: configured through the environment ---------------
  {
    id: 'travelpayouts', label: 'Travelpayouts / Aviasales', vendor: 'Travelpayouts',
    readiness: 'BUILT_IN', signupUrl: 'https://www.travelpayouts.com/',
    tier: 'FREE', envVars: ['TRAVELPAYOUTS_TOKEN', 'TRAVELPAYOUTS_MARKER'],
    note: 'הרשמה עצמית חינם. מחזיר מחירים זולים מהמטמון של Aviasales — לא חיפוש זמינות חי, והמערכת מסמנת זאת.',
  },
  {
    id: 'serpapi', label: 'SerpAPI — Google Flights', vendor: 'SerpAPI',
    readiness: 'BUILT_IN', signupUrl: 'https://serpapi.com/users/sign_up',
    docsUrl: 'https://serpapi.com/google-flights-api',
    tier: 'PAID', envVars: ['SERPAPI_API_KEY'],
    note: 'תוצאות Google Flights אמיתיות. מכסה חינמית חודשית ואז לפי שימוש.',
  },
  {
    id: 'duffel', label: 'Duffel — NDC', vendor: 'Duffel',
    readiness: 'BUILT_IN', signupUrl: 'https://app.duffel.com/join',
    tier: 'PAID', envVars: ['DUFFEL_API_TOKEN'],
    note: 'תוכן ישיר מחברות תעופה. טוקן test מחזיר נתוני דמה — לייצור נדרש טוקן live.',
  },
  {
    id: 'amadeus', label: 'Amadeus — GDS', vendor: 'Amadeus',
    readiness: 'CLOSED', signupUrl: 'https://developers.amadeus.com/',
    tier: 'PREMIUM', envVars: ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
    note: 'פורטל ה-Self-Service נסגר ב-17.7.2026. המתאם מוכן ויעבוד ברגע שיהיה חשבון Enterprise.',
  },
  {
    id: 'kiwi', label: 'Kiwi.com Tequila', vendor: 'Kiwi.com',
    readiness: 'CLOSED', signupUrl: 'https://tequila.kiwi.com/portal',
    tier: 'PAID', envVars: ['KIWI_API_KEY'],
    note: 'שותפים בלבד מאז 2024 (נדרש פרויקט עם 50,000+ משתמשים חודשיים). המתאם מוכן.',
  },

  // ---- documented request shapes: paste a key and run ----------------------
  {
    id: 'flightapi', label: 'FlightAPI.io', vendor: 'FlightAPI',
    readiness: 'READY', signupUrl: 'https://www.flightapi.io/',
    docsUrl: 'https://docs.flightapi.io/flight-price-api/oneway-trip-api',
    urlTemplate: 'https://api.flightapi.io/onewaytrip/{KEY}/{origin}/{destination}/{departureDate}/{adults}/{children}/{infants}/{cabinTitle}/{currency}',
    tier: 'PAID', requestsPerMinute: 20, concurrency: 2,
    note: 'מחירים מ-700+ חברות ומוכרים. כל בקשה צורכת 2 קרדיטים — שמרו על קצב נמוך.',
  },
  {
    id: 'ryanair', label: 'Ryanair — מחירים ישירים', vendor: 'Ryanair',
    readiness: 'READY', signupUrl: 'https://developer.ryanair.com/apis',
    urlTemplate: 'https://services-api.ryanair.com/farfnd/3/oneWayFares?departureAirportIataCode={origin}&arrivalAirportIataCode={destination}&outboundDepartureDateFrom={departureDate}&outboundDepartureDateTo={departureDate}&currency={currency}&limit=30',
    tier: 'FREE', requestsPerMinute: 20, concurrency: 2,
    note: 'ללא מפתח. מכסה את Ryanair בלבד, אבל לרוב במחיר הנמוך ביותר במסלולים שהיא מפעילה.',
  },
  {
    id: 'seatsaero', label: 'Seats.aero — כרטיסי נקודות', vendor: 'Seats.aero',
    readiness: 'READY', signupUrl: 'https://seats.aero/apikey',
    docsUrl: 'https://developers.seats.aero/reference/getting-started-p',
    urlTemplate: 'https://seats.aero/partnerapi/search?origin_airport={origin}&destination_airport={destination}&start_date={departureDate}&end_date={departureDate}&take=100',
    headers: { 'Partner-Authorization': 'Bearer {KEY}' },
    tier: 'PAID', requestsPerMinute: 10, concurrency: 2,
    note: 'זמינות אוורד ב-24 תוכניות נאמנות. המחירים בנקודות ולא במטבע — שימושי להשוואה נפרדת.',
  },

  // ---- vendor docs needed for the URL; mapping is auto-detected ------------
  {
    id: 'rapidapi-skyscrapper', label: 'Sky Scrapper (נתוני Skyscanner)', vendor: 'RapidAPI',
    readiness: 'NEEDS_LOOKUP', signupUrl: 'https://rapidapi.com/apiheya/api/sky-scrapper',
    urlTemplate: 'https://sky-scrapper.p.rapidapi.com/api/v1/flights/searchFlights?originSkyId={origin}&destinationSkyId={destination}&date={departureDate}&adults={adults}&currency={currency}',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'דורש מזהי Skyscanner (LOND, NYCA) ו-entityId ולא קודי IATA — צריך קריאת /searchAirport מקדימה שהמערכת עדיין לא מבצעת.',
  },
  {
    id: 'rapidapi-booking', label: 'Booking.com Flights', vendor: 'RapidAPI',
    readiness: 'NEEDS_LOOKUP', signupUrl: 'https://rapidapi.com/DataCrawler/api/booking-com15',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'booking-com15.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'דורש fromId/toId פנימיים של Booking, לא IATA. העתיקו את הכתובת מה-Playground ב-RapidAPI.',
  },
  {
    id: 'rapidapi-google-flights', label: 'Google Flights (RapidAPI)', vendor: 'RapidAPI',
    readiness: 'NEEDS_URL', signupUrl: 'https://rapidapi.com/DataCrawler/api/google-flights2',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'google-flights2.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'העתיקו את כתובת ה-endpoint מה-Playground והחליפו ערכים בתבניות. הזיהוי האוטומטי ימפה את התשובה.',
  },
  {
    id: 'rapidapi-kiwi', label: 'Kiwi.com (דרך RapidAPI)', vendor: 'RapidAPI',
    readiness: 'NEEDS_URL', signupUrl: 'https://rapidapi.com/search/kiwi',
    headers: { 'x-rapidapi-key': '{KEY}' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'כמה ספקים מציעים גישה ל-Kiwi. הוסיפו x-rapidapi-host לפי ה-API שבחרתם.',
  },
  {
    id: 'rapidapi-flights-sky', label: 'Flights Scraper Sky', vendor: 'RapidAPI',
    readiness: 'NEEDS_URL', signupUrl: 'https://rapidapi.com/ntd119/api/flights-sky',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'flights-sky.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'חלופה ל-Sky Scrapper מאותה משפחת נתונים. העתיקו endpoint מה-Playground.',
  },
  {
    id: 'zyla', label: 'Zyla API Hub', vendor: 'Zyla Labs',
    readiness: 'NEEDS_URL', signupUrl: 'https://zylalabs.com/',
    headers: { Authorization: 'Bearer {KEY}' },
    tier: 'LOW_COST', requestsPerMinute: 10, concurrency: 2,
    note: 'חנות API עם כמה מנועי טיסות. מפתח אחד לכל החנות — אפשר להוסיף כמה מנועים איתו.',
  },
  {
    id: 'apimarket', label: 'api.market (MagicAPI)', vendor: 'api.market',
    readiness: 'NEEDS_URL', signupUrl: 'https://api.market/',
    headers: { 'x-magicapi-key': '{KEY}' },
    tier: 'LOW_COST', requestsPerMinute: 10, concurrency: 2,
    note: 'חנות API נוספת עם מנועי טיסות. מפתח אחד לכל ה-APIs שם.',
  },
  {
    id: 'searchapi', label: 'SearchApi — Google Flights', vendor: 'SearchApi.io',
    readiness: 'NEEDS_URL', signupUrl: 'https://www.searchapi.io/google-flights-api',
    tier: 'PAID', requestsPerMinute: 10, concurrency: 2,
    note: 'חלופה ל-SerpAPI לתוצאות Google Flights. העתיקו את מבנה הבקשה מהתיעוד שלהם.',
  },

  // ---- schedules and status: never fares -----------------------------------
  {
    id: 'aviationstack', label: 'Aviationstack', vendor: 'apilayer',
    readiness: 'STATUS_ONLY', signupUrl: 'https://aviationstack.com/',
    tier: 'FREE',
    note: 'סטטוס טיסות ולוחות זמנים — ללא מחירים. כמנוע חיפוש יחזיר אפס תוצאות.',
  },
  {
    id: 'aerodatabox', label: 'AeroDataBox', vendor: 'RapidAPI',
    readiness: 'STATUS_ONLY', signupUrl: 'https://rapidapi.com/aedbx-aedbx/api/aerodatabox',
    tier: 'LOW_COST',
    note: 'לוחות זמנים ונתוני מטוסים — ללא מחירים.',
  },
  {
    id: 'aeroapi', label: 'FlightAware AeroAPI', vendor: 'FlightAware',
    readiness: 'STATUS_ONLY', signupUrl: 'https://www.flightaware.com/commercial/aeroapi/',
    tier: 'PAID',
    note: 'מעקב טיסות בזמן אמת — ללא מחירים.',
  },
  {
    id: 'flightlabs', label: 'FlightLabs', vendor: 'Zyla Labs',
    readiness: 'STATUS_ONLY', signupUrl: 'https://www.goflightlabs.com/',
    tier: 'LOW_COST',
    note: 'סטטוס ולוחות זמנים. יש להם גם endpoint מחירים — אם תפעילו אותו, הוסיפו כמנוע נפרד עם זיהוי אוטומטי.',
  },
  {
    id: 'flightradar24', label: 'Flightradar24', vendor: 'FR24',
    readiness: 'STATUS_ONLY', signupUrl: 'https://fr24api.flightradar24.com/',
    tier: 'PAID', envVars: ['FLIGHTRADAR_API_KEY'],
    note: 'מוגדר במערכת כהעשרה בלבד (מספרי טיסה, מטוסים) ולא כמקור מחירים.',
  },
];

/** Everything an operator could switch on, ordered by how quickly it can run. */
const ORDER: Record<EngineReadiness, number> = {
  BUILT_IN: 0, READY: 1, NEEDS_URL: 2, NEEDS_LOOKUP: 3, CLOSED: 4, STATUS_ONLY: 5,
};

export function catalogueForDisplay(): EngineTemplate[] {
  return [...ENGINE_CATALOGUE].sort(
    (a, b) => ORDER[a.readiness] - ORDER[b.readiness] || a.label.localeCompare(b.label),
  );
}

/** Which built-in engines already have their credentials in the environment. */
export function envConfigured(t: EngineTemplate): boolean | undefined {
  if (!t.envVars?.length) return undefined;
  return t.envVars.every((v) => Boolean(process.env[v]));
}
