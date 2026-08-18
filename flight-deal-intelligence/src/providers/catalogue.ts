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
  /** needs an OAuth token exchange before each search (not supported yet) */
  | 'NEEDS_OAUTH'
  /** returns schedules/status, never fares — useless as a search engine */
  | 'STATUS_ONLY'
  /** no self-serve access at the moment */
  | 'CLOSED';

export type EngineCategory =
  | 'PRICE_API'   // fare data / search APIs
  | 'META'        // metasearch and OTA affiliate programmes
  | 'GDS'         // global distribution systems
  | 'NDC'         // NDC aggregators
  | 'AIRLINE'     // an airline's own API
  | 'AWARD'       // points and award availability
  | 'MARKETPLACE' // API hubs reselling many engines
  | 'STATUS';     // schedules and tracking, no fares

export interface EngineTemplate {
  id: string;
  label: string;
  vendor: string;
  category: EngineCategory;
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
    category: 'PRICE_API',
    readiness: 'BUILT_IN', signupUrl: 'https://www.travelpayouts.com/',
    tier: 'FREE', envVars: ['TRAVELPAYOUTS_TOKEN', 'TRAVELPAYOUTS_MARKER'],
    note: 'הרשמה עצמית חינם. מחזיר מחירים זולים מהמטמון של Aviasales — לא חיפוש זמינות חי, והמערכת מסמנת זאת.',
  },
  {
    id: 'serpapi', label: 'SerpAPI — Google Flights', vendor: 'SerpAPI',
    category: 'PRICE_API',
    readiness: 'BUILT_IN', signupUrl: 'https://serpapi.com/users/sign_up',
    docsUrl: 'https://serpapi.com/google-flights-api',
    tier: 'PAID', envVars: ['SERPAPI_API_KEY'],
    note: 'תוצאות Google Flights אמיתיות. מכסה חינמית חודשית ואז לפי שימוש.',
  },
  {
    id: 'duffel', label: 'Duffel — NDC', vendor: 'Duffel',
    category: 'NDC',
    readiness: 'BUILT_IN', signupUrl: 'https://app.duffel.com/join',
    tier: 'PAID', envVars: ['DUFFEL_API_TOKEN'],
    note: 'תוכן ישיר מחברות תעופה. טוקן test מחזיר נתוני דמה — לייצור נדרש טוקן live.',
  },
  {
    id: 'amadeus', label: 'Amadeus — GDS', vendor: 'Amadeus',
    category: 'GDS',
    readiness: 'CLOSED', signupUrl: 'https://developers.amadeus.com/',
    tier: 'PREMIUM', envVars: ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
    note: 'פורטל ה-Self-Service נסגר ב-17.7.2026. המתאם מוכן ויעבוד ברגע שיהיה חשבון Enterprise.',
  },
  {
    id: 'kiwi', label: 'Kiwi.com Tequila', vendor: 'Kiwi.com',
    category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://tequila.kiwi.com/portal',
    tier: 'PAID', envVars: ['KIWI_API_KEY'],
    note: 'שותפים בלבד מאז 2024 (נדרש פרויקט עם 50,000+ משתמשים חודשיים). המתאם מוכן.',
  },

  // ---- documented request shapes: paste a key and run ----------------------
  {
    id: 'flightapi', label: 'FlightAPI.io', vendor: 'FlightAPI',
    category: 'PRICE_API',
    readiness: 'READY', signupUrl: 'https://www.flightapi.io/',
    docsUrl: 'https://docs.flightapi.io/flight-price-api/oneway-trip-api',
    urlTemplate: 'https://api.flightapi.io/onewaytrip/{KEY}/{origin}/{destination}/{departureDate}/{adults}/{children}/{infants}/{cabinTitle}/{currency}',
    tier: 'PAID', requestsPerMinute: 20, concurrency: 2,
    note: 'מחירים מ-700+ חברות ומוכרים. כל בקשה צורכת 2 קרדיטים — שמרו על קצב נמוך.',
  },
  {
    id: 'ryanair', label: 'Ryanair — מחירים ישירים', vendor: 'Ryanair',
    category: 'AIRLINE',
    readiness: 'READY', signupUrl: 'https://developer.ryanair.com/apis',
    urlTemplate: 'https://services-api.ryanair.com/farfnd/3/oneWayFares?departureAirportIataCode={origin}&arrivalAirportIataCode={destination}&outboundDepartureDateFrom={departureDate}&outboundDepartureDateTo={departureDate}&currency={currency}&limit=30',
    tier: 'FREE', requestsPerMinute: 20, concurrency: 2,
    note: 'ללא מפתח. מכסה את Ryanair בלבד, אבל לרוב במחיר הנמוך ביותר במסלולים שהיא מפעילה.',
  },
  {
    id: 'seatsaero', label: 'Seats.aero — כרטיסי נקודות', vendor: 'Seats.aero',
    category: 'AWARD',
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
    category: 'MARKETPLACE',
    readiness: 'NEEDS_LOOKUP', signupUrl: 'https://rapidapi.com/apiheya/api/sky-scrapper',
    urlTemplate: 'https://sky-scrapper.p.rapidapi.com/api/v1/flights/searchFlights?originSkyId={origin}&destinationSkyId={destination}&date={departureDate}&adults={adults}&currency={currency}',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'דורש מזהי Skyscanner (LOND, NYCA) ו-entityId ולא קודי IATA — צריך קריאת /searchAirport מקדימה שהמערכת עדיין לא מבצעת.',
  },
  {
    id: 'rapidapi-booking', label: 'Booking.com Flights', vendor: 'RapidAPI',
    category: 'MARKETPLACE',
    readiness: 'NEEDS_LOOKUP', signupUrl: 'https://rapidapi.com/DataCrawler/api/booking-com15',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'booking-com15.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'דורש fromId/toId פנימיים של Booking, לא IATA. העתיקו את הכתובת מה-Playground ב-RapidAPI.',
  },
  {
    id: 'rapidapi-google-flights', label: 'Google Flights (RapidAPI)', vendor: 'RapidAPI',
    category: 'MARKETPLACE',
    readiness: 'NEEDS_URL', signupUrl: 'https://rapidapi.com/DataCrawler/api/google-flights2',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'google-flights2.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'העתיקו את כתובת ה-endpoint מה-Playground והחליפו ערכים בתבניות. הזיהוי האוטומטי ימפה את התשובה.',
  },
  {
    id: 'rapidapi-kiwi', label: 'Kiwi.com (דרך RapidAPI)', vendor: 'RapidAPI',
    category: 'MARKETPLACE',
    readiness: 'NEEDS_URL', signupUrl: 'https://rapidapi.com/search/kiwi',
    headers: { 'x-rapidapi-key': '{KEY}' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'כמה ספקים מציעים גישה ל-Kiwi. הוסיפו x-rapidapi-host לפי ה-API שבחרתם.',
  },
  {
    id: 'rapidapi-flights-sky', label: 'Flights Scraper Sky', vendor: 'RapidAPI',
    category: 'MARKETPLACE',
    readiness: 'NEEDS_URL', signupUrl: 'https://rapidapi.com/ntd119/api/flights-sky',
    headers: { 'x-rapidapi-key': '{KEY}', 'x-rapidapi-host': 'flights-sky.p.rapidapi.com' },
    tier: 'LOW_COST', requestsPerMinute: 5, concurrency: 1,
    note: 'חלופה ל-Sky Scrapper מאותה משפחת נתונים. העתיקו endpoint מה-Playground.',
  },
  {
    id: 'zyla', label: 'Zyla API Hub', vendor: 'Zyla Labs',
    category: 'MARKETPLACE',
    readiness: 'NEEDS_URL', signupUrl: 'https://zylalabs.com/',
    headers: { Authorization: 'Bearer {KEY}' },
    tier: 'LOW_COST', requestsPerMinute: 10, concurrency: 2,
    note: 'חנות API עם כמה מנועי טיסות. מפתח אחד לכל החנות — אפשר להוסיף כמה מנועים איתו.',
  },
  {
    id: 'apimarket', label: 'api.market (MagicAPI)', vendor: 'api.market',
    category: 'MARKETPLACE',
    readiness: 'NEEDS_URL', signupUrl: 'https://api.market/',
    headers: { 'x-magicapi-key': '{KEY}' },
    tier: 'LOW_COST', requestsPerMinute: 10, concurrency: 2,
    note: 'חנות API נוספת עם מנועי טיסות. מפתח אחד לכל ה-APIs שם.',
  },
  {
    id: 'searchapi', label: 'SearchApi — Google Flights', vendor: 'SearchApi.io',
    category: 'PRICE_API',
    readiness: 'NEEDS_URL', signupUrl: 'https://www.searchapi.io/google-flights-api',
    tier: 'PAID', requestsPerMinute: 10, concurrency: 2,
    note: 'חלופה ל-SerpAPI לתוצאות Google Flights. העתיקו את מבנה הבקשה מהתיעוד שלהם.',
  },

  // ---- schedules and status: never fares -----------------------------------
  {
    id: 'aviationstack', label: 'Aviationstack', vendor: 'apilayer',
    category: 'STATUS',
    readiness: 'STATUS_ONLY', signupUrl: 'https://aviationstack.com/',
    tier: 'FREE',
    note: 'סטטוס טיסות ולוחות זמנים — ללא מחירים. כמנוע חיפוש יחזיר אפס תוצאות.',
  },
  {
    id: 'aerodatabox', label: 'AeroDataBox', vendor: 'RapidAPI',
    category: 'STATUS',
    readiness: 'STATUS_ONLY', signupUrl: 'https://rapidapi.com/aedbx-aedbx/api/aerodatabox',
    tier: 'LOW_COST',
    note: 'לוחות זמנים ונתוני מטוסים — ללא מחירים.',
  },
  {
    id: 'aeroapi', label: 'FlightAware AeroAPI', vendor: 'FlightAware',
    category: 'STATUS',
    readiness: 'STATUS_ONLY', signupUrl: 'https://www.flightaware.com/commercial/aeroapi/',
    tier: 'PAID',
    note: 'מעקב טיסות בזמן אמת — ללא מחירים.',
  },
  {
    id: 'flightlabs', label: 'FlightLabs', vendor: 'Zyla Labs',
    category: 'STATUS',
    readiness: 'STATUS_ONLY', signupUrl: 'https://www.goflightlabs.com/',
    tier: 'LOW_COST',
    note: 'סטטוס ולוחות זמנים. יש להם גם endpoint מחירים — אם תפעילו אותו, הוסיפו כמנוע נפרד עם זיהוי אוטומטי.',
  },
  {
    id: 'flightradar24', label: 'Flightradar24', vendor: 'FR24', category: 'STATUS',
    readiness: 'STATUS_ONLY', signupUrl: 'https://fr24api.flightradar24.com/',
    tier: 'PAID', envVars: ['FLIGHTRADAR_API_KEY'],
    note: 'מוגדר במערכת כהעשרה בלבד (מספרי טיסה, מטוסים) ולא כמקור מחירים.',
  },
  // ---- GDS: enterprise distribution, OAuth-based -------------------------
  {
    id: 'sabre', label: 'Sabre Dev Studio', vendor: 'Sabre', category: 'GDS',
    readiness: 'NEEDS_OAUTH', signupUrl: 'https://developer.sabre.com/',
    docsUrl: 'https://developer.sabre.com/rest-api/flightsearch-api/v1',
    tier: 'PREMIUM',
    note: 'הרשמה עצמית ל-sandbox חינם (production בתשלום). דורש החלפת client id/secret בטוקן OAuth לפני כל חיפוש — המתאם הגנרי עדיין לא תומך בזה.',
  },
  {
    id: 'travelport', label: 'Travelport+ APIs', vendor: 'Travelport', category: 'GDS',
    readiness: 'NEEDS_OAUTH', signupUrl: 'https://developer.travelport.com/',
    tier: 'PREMIUM',
    note: 'פורטל מפתחים עם סביבת בדיקה; גישה מסחרית דורשת הסכם. אימות OAuth.',
  },

  // ---- NDC aggregators: contract-based, adapters ready when access is -----
  {
    id: 'airgateway', label: 'AirGateway — NDC', vendor: 'AirGateway', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://airgateway.com/products/airgateway-api/',
    tier: 'PREMIUM',
    note: 'אגרגטור NDC עם sandbox, אך ההרשאות קשורות למספר IATA/TIDS של סוכנות. נדרש חשבון סוכנות.',
  },
  {
    id: 'verteil', label: 'Verteil — NDC', vendor: 'Verteil', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://www.verteil.com/',
    tier: 'PREMIUM',
    note: 'אגרגטור NDC לסוכנויות נסיעות. נדרש הסכם מסחרי.',
  },
  {
    id: 'tpconnects', label: 'TPConnects — NDC', vendor: 'TPConnects', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://tpconnects.com/',
    tier: 'PREMIUM',
    note: 'אגרגטור NDC. נדרש הסכם מסחרי ומספר IATA.',
  },
  {
    id: 'travelfusion', label: 'Travelfusion', vendor: 'Travelfusion', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://www.travelfusion.com/',
    tier: 'PREMIUM',
    note: 'גישה ישירה למאות חברות לואו-קוסט. B2B בלבד, נדרש הסכם.',
  },
  {
    id: 'mystifly', label: 'Mystifly', vendor: 'Mystifly', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://www.mystifly.com/',
    tier: 'PREMIUM',
    note: 'קונסולידטור טיסות גלובלי. נדרש הסכם B2B.',
  },
  {
    id: 'pkfare', label: 'PKFARE', vendor: 'PKFARE', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://www.pkfare.com/',
    tier: 'PREMIUM',
    note: 'קונסולידטור עם מחירי סיטונאות. נדרשת התקשרות עסקית.',
  },
  {
    id: 'tbo', label: 'TBO Air API', vendor: 'TBO', category: 'NDC',
    readiness: 'CLOSED', signupUrl: 'https://www.tboholidays.com/',
    tier: 'PREMIUM',
    note: 'API טיסות לסוכנויות. נדרש חשבון סוכן.',
  },

  // ---- airline direct ------------------------------------------------------
  {
    id: 'lufthansa', label: 'Lufthansa Group Open API', vendor: 'Lufthansa', category: 'AIRLINE',
    readiness: 'NEEDS_OAUTH', signupUrl: 'https://developer.lufthansa.com/',
    tier: 'FREE',
    note: 'הרשמה עצמית חינם עם מכסה. מכסה את קבוצת לופטהנזה. דורש טוקן OAuth לפני קריאה.',
  },
  {
    id: 'airfranceklm', label: 'Air France-KLM Developer', vendor: 'Air France-KLM', category: 'AIRLINE',
    readiness: 'NEEDS_URL', signupUrl: 'https://developer.airfranceklm.com/',
    headers: { 'API-Key': '{KEY}' },
    tier: 'FREE', requestsPerMinute: 10, concurrency: 2,
    note: 'פורטל מפתחים עם הרשמה עצמית ומפתח חינמי. העתיקו את endpoint ה-Offers מהתיעוד — הזיהוי האוטומטי ימפה את התשובה.',
  },
  {
    id: 'iag-ba', label: 'British Airways / IAG', vendor: 'IAG', category: 'AIRLINE',
    readiness: 'NEEDS_URL', signupUrl: 'https://developer.iairgroup.com/',
    tier: 'FREE', requestsPerMinute: 10, concurrency: 2,
    note: 'תוכנית Flight Offer Market Affiliates. נדרשת הרשמה ואישור; אחריה מקבלים מפתח ו-endpoint.',
  },
  {
    id: 'wizzair', label: 'Wizz Air', vendor: 'Wizz Air', category: 'AIRLINE',
    readiness: 'CLOSED', signupUrl: 'https://wizzair.com/',
    tier: 'FREE',
    note: 'אין API ציבורי. ה-API הפנימי מוגן בהגנת בוט — המערכת לא עוקפת הגנות ולכן לא נתמך.',
  },
  {
    id: 'easyjet', label: 'easyJet', vendor: 'easyJet', category: 'AIRLINE',
    readiness: 'CLOSED', signupUrl: 'https://www.easyjet.com/',
    tier: 'FREE',
    note: 'אין API ציבורי לחיפוש מחירים.',
  },

  // ---- more Travelpayouts endpoints, same token ---------------------------
  {
    id: 'tp-cheap', label: 'Aviasales — הכרטיסים הזולים', vendor: 'Travelpayouts', category: 'PRICE_API',
    readiness: 'READY', signupUrl: 'https://www.travelpayouts.com/',
    docsUrl: 'https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API',
    urlTemplate: 'https://api.travelpayouts.com/v1/prices/cheap?origin={origin}&destination={destination}&depart_date={departureDate}&currency={currency}&token={KEY}',
    tier: 'FREE', requestsPerMinute: 20, concurrency: 2,
    note: 'אותו טוקן של Travelpayouts, endpoint נוסף. כתובת לפי התיעוד הציבורי — הריצו זיהוי אוטומטי לאישור המבנה.',
  },
  {
    id: 'tp-calendar', label: 'Aviasales — לוח מחירים חודשי', vendor: 'Travelpayouts', category: 'PRICE_API',
    readiness: 'READY', signupUrl: 'https://www.travelpayouts.com/',
    docsUrl: 'https://support.travelpayouts.com/hc/en-us/articles/203972143-Price-calendar-API',
    urlTemplate: 'https://api.travelpayouts.com/v1/prices/calendar?origin={origin}&destination={destination}&depart_date={departureDate}&currency={currency}&token={KEY}',
    tier: 'FREE', requestsPerMinute: 20, concurrency: 2,
    note: 'המחירים הנמוכים לכל יום בחודש — מצוין לאיתור התאריך הזול. אותו טוקן.',
  },

  // Aviasales' /v2/prices/latest is deliberately NOT listed: it returns prices
  // for dates other than the one searched, and the generic adapter stamps the
  // searched date onto every result — which would mislabel them. It becomes
  // usable once a departureDate field can be mapped out of the response.

  // ---- award travel --------------------------------------------------------
  {
    id: 'pointsyeah', label: 'PointsYeah — כרטיסי נקודות', vendor: 'PointsYeah', category: 'AWARD',
    readiness: 'NEEDS_URL', signupUrl: 'https://www.pointsyeah.com/',
    docsUrl: 'https://www.pointsyeah.com/developers/flights/search',
    tier: 'LOW_COST', requestsPerMinute: 10, concurrency: 2,
    note: 'API ציבורי לזמינות אוורד ב-40+ תוכניות נאמנות. העתיקו את מבנה הבקשה מהתיעוד שלהם.',
  },
  {
    id: 'pointme', label: 'point.me', vendor: 'point.me', category: 'AWARD',
    readiness: 'CLOSED', signupUrl: 'https://point.me/',
    tier: 'PAID',
    note: 'כלי חיפוש אוורד רחב, ללא API ציבורי נכון להיום.',
  },
  {
    id: 'awardfares', label: 'AwardFares', vendor: 'AwardFares', category: 'AWARD',
    readiness: 'CLOSED', signupUrl: 'https://awardfares.com/',
    tier: 'PAID',
    note: 'חיפוש אוורד עם תצוגת ציר זמן. ללא API ציבורי.',
  },

  // ---- metasearch and OTA affiliate programmes ----------------------------
  {
    id: 'skyscanner-partner', label: 'Skyscanner Travel API', vendor: 'Skyscanner', category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://www.partners.skyscanner.net/',
    tier: 'PREMIUM',
    note: 'API רשמי לשותפים מסחריים, אישור פרטני. הדרך הזמינה לנתוני Skyscanner היום היא דרך RapidAPI.',
  },
  {
    id: 'wego', label: 'Wego Partner API', vendor: 'Wego', category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://www.wego.com/affiliates',
    tier: 'PREMIUM',
    note: 'מטא-סרץ׳ חזק במזרח התיכון ואסיה. גישה דרך תוכנית שותפים.',
  },
  {
    id: 'tripcom', label: 'Trip.com Affiliate', vendor: 'Trip.com', category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://www.trip.com/partners/',
    tier: 'PREMIUM',
    note: 'כיסוי חזק באסיה. נדרשת הצטרפות לתוכנית השותפים.',
  },
  {
    id: 'expedia-rapid', label: 'Expedia Rapid / Partner', vendor: 'Expedia', category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://developers.expediagroup.com/',
    tier: 'PREMIUM',
    note: 'גישה דרך תוכנית שותפים והסכם מסחרי.',
  },
  {
    id: 'kayak-affiliate', label: 'Kayak Affiliate', vendor: 'Kayak', category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://www.kayak.com/affiliates',
    tier: 'PREMIUM',
    note: 'הזנת מחירים לשותפים מאושרים בלבד.',
  },
  {
    id: 'edreams', label: 'eDreams ODIGEO', vendor: 'eDreams', category: 'META',
    readiness: 'CLOSED', signupUrl: 'https://www.edreamsodigeo.com/',
    tier: 'PREMIUM',
    note: 'קבוצת OTA אירופית. גישה עסקית בלבד.',
  },
];

/** Everything an operator could switch on, ordered by how quickly it can run. */
const ORDER: Record<EngineReadiness, number> = {
  BUILT_IN: 0, READY: 1, NEEDS_URL: 2, NEEDS_LOOKUP: 3, NEEDS_OAUTH: 4, CLOSED: 5, STATUS_ONLY: 6,
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
