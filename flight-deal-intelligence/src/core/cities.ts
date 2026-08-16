/**
 * City → airport mapping with Hebrew + English names, so users can type
 * "ברגמו" or "Bergamo" like on Google Flights instead of IATA codes (§17-§18).
 * Multi-airport metros list every airport; the first code is the primary.
 */

export interface CityEntry {
  /** English city name */
  city: string;
  /** Hebrew city name(s) */
  he: string[];
  codes: string[];
  country?: string;
}

export const CITIES: CityEntry[] = [
  // Israel & region
  { city: 'Tel Aviv', he: ['תל אביב'], codes: ['TLV'], country: 'Israel' },
  { city: 'Eilat', he: ['אילת'], codes: ['ETM'], country: 'Israel' },
  { city: 'Larnaca', he: ['לרנקה', 'לרנאקה'], codes: ['LCA'], country: 'Cyprus' },
  { city: 'Paphos', he: ['פאפוס'], codes: ['PFO'], country: 'Cyprus' },
  { city: 'Amman', he: ['עמאן'], codes: ['AMM'], country: 'Jordan' },
  { city: 'Cairo', he: ['קהיר'], codes: ['CAI'], country: 'Egypt' },
  { city: 'Sharm El Sheikh', he: ['שארם א שייח', 'שארם'], codes: ['SSH'], country: 'Egypt' },
  // Europe — west
  { city: 'London', he: ['לונדון'], codes: ['LHR', 'LGW', 'STN', 'LTN'], country: 'UK' },
  { city: 'Manchester', he: ['מנצ׳סטר', 'מנצסטר'], codes: ['MAN'], country: 'UK' },
  { city: 'Edinburgh', he: ['אדינבורו'], codes: ['EDI'], country: 'UK' },
  { city: 'Dublin', he: ['דבלין'], codes: ['DUB'], country: 'Ireland' },
  { city: 'Paris', he: ['פריז', 'פריס'], codes: ['CDG', 'ORY', 'BVA'], country: 'France' },
  { city: 'Nice', he: ['ניס'], codes: ['NCE'], country: 'France' },
  { city: 'Lyon', he: ['ליון'], codes: ['LYS'], country: 'France' },
  { city: 'Marseille', he: ['מרסיי'], codes: ['MRS'], country: 'France' },
  { city: 'Amsterdam', he: ['אמסטרדם'], codes: ['AMS'], country: 'Netherlands' },
  { city: 'Brussels', he: ['בריסל'], codes: ['BRU', 'CRL'], country: 'Belgium' },
  { city: 'Zurich', he: ['ציריך'], codes: ['ZRH'], country: 'Switzerland' },
  { city: 'Geneva', he: ['ז׳נבה', 'זנבה'], codes: ['GVA'], country: 'Switzerland' },
  { city: 'Frankfurt', he: ['פרנקפורט'], codes: ['FRA', 'HHN'], country: 'Germany' },
  { city: 'Munich', he: ['מינכן'], codes: ['MUC'], country: 'Germany' },
  { city: 'Berlin', he: ['ברלין'], codes: ['BER'], country: 'Germany' },
  { city: 'Hamburg', he: ['המבורג'], codes: ['HAM'], country: 'Germany' },
  { city: 'Cologne', he: ['קלן'], codes: ['CGN'], country: 'Germany' },
  { city: 'Dusseldorf', he: ['דיסלדורף'], codes: ['DUS'], country: 'Germany' },
  { city: 'Vienna', he: ['וינה'], codes: ['VIE'], country: 'Austria' },
  { city: 'Salzburg', he: ['זלצבורג'], codes: ['SZG'], country: 'Austria' },
  { city: 'Innsbruck', he: ['אינסברוק'], codes: ['INN'], country: 'Austria' },
  // Europe — south
  { city: 'Madrid', he: ['מדריד'], codes: ['MAD'], country: 'Spain' },
  { city: 'Barcelona', he: ['ברצלונה'], codes: ['BCN'], country: 'Spain' },
  { city: 'Malaga', he: ['מלגה'], codes: ['AGP'], country: 'Spain' },
  { city: 'Palma de Mallorca', he: ['מיורקה', 'פלמה'], codes: ['PMI'], country: 'Spain' },
  { city: 'Ibiza', he: ['איביזה'], codes: ['IBZ'], country: 'Spain' },
  { city: 'Seville', he: ['סביליה'], codes: ['SVQ'], country: 'Spain' },
  { city: 'Valencia', he: ['ולנסיה'], codes: ['VLC'], country: 'Spain' },
  { city: 'Lisbon', he: ['ליסבון'], codes: ['LIS'], country: 'Portugal' },
  { city: 'Porto', he: ['פורטו'], codes: ['OPO'], country: 'Portugal' },
  { city: 'Rome', he: ['רומא'], codes: ['FCO', 'CIA'], country: 'Italy' },
  { city: 'Milan', he: ['מילאנו', 'מילנו'], codes: ['MXP', 'LIN', 'BGY'], country: 'Italy' },
  { city: 'Bergamo', he: ['ברגמו'], codes: ['BGY'], country: 'Italy' },
  { city: 'Venice', he: ['ונציה'], codes: ['VCE', 'TSF'], country: 'Italy' },
  { city: 'Naples', he: ['נאפולי'], codes: ['NAP'], country: 'Italy' },
  { city: 'Bologna', he: ['בולוניה'], codes: ['BLQ'], country: 'Italy' },
  { city: 'Florence', he: ['פירנצה'], codes: ['FLR', 'PSA'], country: 'Italy' },
  { city: 'Pisa', he: ['פיזה'], codes: ['PSA'], country: 'Italy' },
  { city: 'Catania', he: ['קטניה'], codes: ['CTA'], country: 'Italy' },
  { city: 'Palermo', he: ['פלרמו'], codes: ['PMO'], country: 'Italy' },
  { city: 'Athens', he: ['אתונה'], codes: ['ATH'], country: 'Greece' },
  { city: 'Thessaloniki', he: ['סלוניקי'], codes: ['SKG'], country: 'Greece' },
  { city: 'Heraklion', he: ['הרקליון', 'כרתים'], codes: ['HER', 'CHQ'], country: 'Greece' },
  { city: 'Rhodes', he: ['רודוס'], codes: ['RHO'], country: 'Greece' },
  { city: 'Santorini', he: ['סנטוריני'], codes: ['JTR'], country: 'Greece' },
  { city: 'Mykonos', he: ['מיקונוס'], codes: ['JMK'], country: 'Greece' },
  { city: 'Corfu', he: ['קורפו'], codes: ['CFU'], country: 'Greece' },
  { city: 'Kos', he: ['קוס'], codes: ['KGS'], country: 'Greece' },
  { city: 'Zakynthos', he: ['זקינתוס'], codes: ['ZTH'], country: 'Greece' },
  { city: 'Malta', he: ['מלטה'], codes: ['MLA'], country: 'Malta' },
  // Europe — east & central
  { city: 'Budapest', he: ['בודפשט'], codes: ['BUD'], country: 'Hungary' },
  { city: 'Prague', he: ['פראג'], codes: ['PRG'], country: 'Czechia' },
  { city: 'Warsaw', he: ['ורשה'], codes: ['WAW', 'WMI'], country: 'Poland' },
  { city: 'Krakow', he: ['קרקוב'], codes: ['KRK'], country: 'Poland' },
  { city: 'Bucharest', he: ['בוקרשט'], codes: ['OTP'], country: 'Romania' },
  { city: 'Cluj', he: ['קלוז׳'], codes: ['CLJ'], country: 'Romania' },
  { city: 'Sofia', he: ['סופיה'], codes: ['SOF'], country: 'Bulgaria' },
  { city: 'Varna', he: ['ורנה'], codes: ['VAR'], country: 'Bulgaria' },
  { city: 'Burgas', he: ['בורגס'], codes: ['BOJ'], country: 'Bulgaria' },
  { city: 'Belgrade', he: ['בלגרד'], codes: ['BEG'], country: 'Serbia' },
  { city: 'Zagreb', he: ['זאגרב'], codes: ['ZAG'], country: 'Croatia' },
  { city: 'Split', he: ['ספליט'], codes: ['SPU'], country: 'Croatia' },
  { city: 'Dubrovnik', he: ['דוברובניק'], codes: ['DBV'], country: 'Croatia' },
  { city: 'Ljubljana', he: ['לובליאנה'], codes: ['LJU'], country: 'Slovenia' },
  { city: 'Tirana', he: ['טירנה'], codes: ['TIA'], country: 'Albania' },
  { city: 'Podgorica', he: ['פודגוריצה'], codes: ['TGD'], country: 'Montenegro' },
  { city: 'Tivat', he: ['טיבט'], codes: ['TIV'], country: 'Montenegro' },
  { city: 'Vilnius', he: ['וילנה'], codes: ['VNO'], country: 'Lithuania' },
  { city: 'Riga', he: ['ריגה'], codes: ['RIX'], country: 'Latvia' },
  { city: 'Tallinn', he: ['טאלין'], codes: ['TLL'], country: 'Estonia' },
  { city: 'Copenhagen', he: ['קופנהגן'], codes: ['CPH'], country: 'Denmark' },
  { city: 'Stockholm', he: ['שטוקהולם', 'סטוקהולם'], codes: ['ARN'], country: 'Sweden' },
  { city: 'Oslo', he: ['אוסלו'], codes: ['OSL'], country: 'Norway' },
  { city: 'Helsinki', he: ['הלסינקי'], codes: ['HEL'], country: 'Finland' },
  { city: 'Reykjavik', he: ['רייקיאוויק'], codes: ['KEF'], country: 'Iceland' },
  // Turkey, Caucasus
  { city: 'Istanbul', he: ['איסטנבול', 'אינסטבול'], codes: ['IST', 'SAW'], country: 'Turkey' },
  { city: 'Antalya', he: ['אנטליה'], codes: ['AYT'], country: 'Turkey' },
  { city: 'Bodrum', he: ['בודרום'], codes: ['BJV'], country: 'Turkey' },
  { city: 'Tbilisi', he: ['טביליסי'], codes: ['TBS'], country: 'Georgia' },
  { city: 'Batumi', he: ['באטומי', 'בטומי'], codes: ['BUS'], country: 'Georgia' },
  { city: 'Yerevan', he: ['ירוואן'], codes: ['EVN'], country: 'Armenia' },
  { city: 'Baku', he: ['באקו'], codes: ['GYD'], country: 'Azerbaijan' },
  // Gulf & Middle East
  { city: 'Dubai', he: ['דובאי'], codes: ['DXB'], country: 'UAE' },
  { city: 'Abu Dhabi', he: ['אבו דאבי'], codes: ['AUH'], country: 'UAE' },
  { city: 'Doha', he: ['דוחה'], codes: ['DOH'], country: 'Qatar' },
  { city: 'Bahrain', he: ['בחריין'], codes: ['BAH'], country: 'Bahrain' },
  // Americas
  { city: 'New York', he: ['ניו יורק'], codes: ['JFK', 'EWR', 'LGA'], country: 'USA' },
  { city: 'Boston', he: ['בוסטון'], codes: ['BOS'], country: 'USA' },
  { city: 'Miami', he: ['מיאמי'], codes: ['MIA', 'FLL'], country: 'USA' },
  { city: 'Orlando', he: ['אורלנדו'], codes: ['MCO'], country: 'USA' },
  { city: 'Los Angeles', he: ['לוס אנג׳לס', 'לוס אנגלס'], codes: ['LAX'], country: 'USA' },
  { city: 'San Francisco', he: ['סן פרנסיסקו'], codes: ['SFO'], country: 'USA' },
  { city: 'Las Vegas', he: ['לאס וגאס'], codes: ['LAS'], country: 'USA' },
  { city: 'Chicago', he: ['שיקגו'], codes: ['ORD'], country: 'USA' },
  { city: 'Washington', he: ['וושינגטון'], codes: ['IAD', 'DCA'], country: 'USA' },
  { city: 'Toronto', he: ['טורונטו'], codes: ['YYZ'], country: 'Canada' },
  { city: 'Montreal', he: ['מונטריאול'], codes: ['YUL'], country: 'Canada' },
  { city: 'Mexico City', he: ['מקסיקו סיטי'], codes: ['MEX'], country: 'Mexico' },
  { city: 'Cancun', he: ['קנקון'], codes: ['CUN'], country: 'Mexico' },
  { city: 'Buenos Aires', he: ['בואנוס איירס'], codes: ['EZE'], country: 'Argentina' },
  { city: 'Sao Paulo', he: ['סאו פאולו'], codes: ['GRU'], country: 'Brazil' },
  { city: 'Rio de Janeiro', he: ['ריו דה ז׳נרו', 'ריו'], codes: ['GIG'], country: 'Brazil' },
  // Asia & Pacific
  { city: 'Bangkok', he: ['בנגקוק', 'בנקוק'], codes: ['BKK', 'DMK'], country: 'Thailand' },
  { city: 'Phuket', he: ['פוקט'], codes: ['HKT'], country: 'Thailand' },
  { city: 'Chiang Mai', he: ['צ׳יאנג מאי'], codes: ['CNX'], country: 'Thailand' },
  { city: 'Koh Samui', he: ['קוסמוי', 'קו סמוי'], codes: ['USM'], country: 'Thailand' },
  { city: 'Tokyo', he: ['טוקיו'], codes: ['NRT', 'HND'], country: 'Japan' },
  { city: 'Osaka', he: ['אוסקה'], codes: ['KIX'], country: 'Japan' },
  { city: 'Seoul', he: ['סיאול'], codes: ['ICN'], country: 'South Korea' },
  { city: 'Beijing', he: ['בייג׳ינג', 'בייגין'], codes: ['PEK'], country: 'China' },
  { city: 'Shanghai', he: ['שנחאי'], codes: ['PVG'], country: 'China' },
  { city: 'Hong Kong', he: ['הונג קונג'], codes: ['HKG'], country: 'Hong Kong' },
  { city: 'Taipei', he: ['טאיפיי'], codes: ['TPE'], country: 'Taiwan' },
  { city: 'Singapore', he: ['סינגפור'], codes: ['SIN'], country: 'Singapore' },
  { city: 'Kuala Lumpur', he: ['קואלה לומפור'], codes: ['KUL'], country: 'Malaysia' },
  { city: 'Bali', he: ['באלי'], codes: ['DPS'], country: 'Indonesia' },
  { city: 'Manila', he: ['מנילה'], codes: ['MNL'], country: 'Philippines' },
  { city: 'Hanoi', he: ['האנוי'], codes: ['HAN'], country: 'Vietnam' },
  { city: 'Ho Chi Minh', he: ['הו צ׳י מין', 'סייגון'], codes: ['SGN'], country: 'Vietnam' },
  { city: 'Delhi', he: ['דלהי'], codes: ['DEL'], country: 'India' },
  { city: 'Mumbai', he: ['מומבאי'], codes: ['BOM'], country: 'India' },
  { city: 'Goa', he: ['גואה'], codes: ['GOI'], country: 'India' },
  { city: 'Colombo', he: ['קולומבו'], codes: ['CMB'], country: 'Sri Lanka' },
  { city: 'Male', he: ['מלדיביים', 'מלה'], codes: ['MLE'], country: 'Maldives' },
  { city: 'Sydney', he: ['סידני'], codes: ['SYD'], country: 'Australia' },
  { city: 'Melbourne', he: ['מלבורן'], codes: ['MEL'], country: 'Australia' },
  // Africa
  { city: 'Marrakech', he: ['מרקש'], codes: ['RAK'], country: 'Morocco' },
  { city: 'Casablanca', he: ['קזבלנקה'], codes: ['CMN'], country: 'Morocco' },
  { city: 'Johannesburg', he: ['יוהנסבורג'], codes: ['JNB'], country: 'South Africa' },
  { city: 'Cape Town', he: ['קייפטאון'], codes: ['CPT'], country: 'South Africa' },
  { city: 'Nairobi', he: ['ניירובי'], codes: ['NBO'], country: 'Kenya' },
  { city: 'Zanzibar', he: ['זנזיבר'], codes: ['ZNZ'], country: 'Tanzania' },
  { city: 'Addis Ababa', he: ['אדיס אבבה'], codes: ['ADD'], country: 'Ethiopia' },
];

export interface AirportSuggestion {
  code: string;
  city: string;
  country?: string;
  /** true when this is the metro's primary airport */
  primary: boolean;
}

/** Search cities by Hebrew/English prefix or substring. */
export function searchCities(query: string, limit = 8): AirportSuggestion[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: AirportSuggestion[] = [];
  const seen = new Set<string>();
  const matches = (e: CityEntry) =>
    e.city.toLowerCase().startsWith(q) ||
    e.city.toLowerCase().includes(q) ||
    e.he.some((h) => h.startsWith(q) || h.includes(q));
  // prefix matches first
  const ranked = CITIES.filter(matches).sort((a, b) => {
    const ap = a.city.toLowerCase().startsWith(q) || a.he.some((h) => h.startsWith(q)) ? 0 : 1;
    const bp = b.city.toLowerCase().startsWith(q) || b.he.some((h) => h.startsWith(q)) ? 0 : 1;
    return ap - bp;
  });
  for (const entry of ranked) {
    for (const [i, code] of entry.codes.entries()) {
      if (seen.has(code)) continue;
      seen.add(code);
      out.push({ code, city: entry.city, country: entry.country, primary: i === 0 });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Resolve free text (city name he/en, IATA code) to an airport code. */
export function resolveAirport(query: string): AirportSuggestion | null {
  const q = query.trim();
  if (!q) return null;
  // "City (CODE)" form from the autocomplete
  const parens = q.match(/\(([A-Za-z]{3})\)\s*$/);
  if (parens) return { code: parens[1]!.toUpperCase(), city: q.replace(/\s*\(.*$/, ''), primary: true };
  // bare IATA code
  if (/^[A-Za-z]{3}$/.test(q)) {
    const code = q.toUpperCase();
    const entry = CITIES.find((e) => e.codes.includes(code));
    return { code, city: entry?.city ?? code, country: entry?.country, primary: true };
  }
  const results = searchCities(q, 1);
  return results[0] ?? null;
}

/** Hebrew city display name for a code (falls back to English). */
export function cityForCode(code: string): { city: string; he?: string } | null {
  const c = code.toUpperCase();
  const entry = CITIES.find((e) => e.codes.includes(c));
  return entry ? { city: entry.city, he: entry.he[0] } : null;
}
