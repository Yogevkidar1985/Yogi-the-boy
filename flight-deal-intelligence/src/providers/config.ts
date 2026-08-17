/**
 * Centralized provider configuration (§32-§33): feature flags, timeouts and
 * rate limits live here — never scattered through the codebase.
 *
 * A provider runs only when it is BOTH enabled here AND has working
 * credentials (each adapter's isAvailable() decides the latter).
 */

export interface ProviderConfig {
  enabled: boolean;
  timeoutMs: number;
  /** Max requests per minute we will send to this provider. */
  requestsPerMinute: number;
  /** Max concurrent in-flight requests to this provider. */
  concurrency: number;
}

/** How a provider is obtained today — surfaced on the setup screen. */
export type AccessModel = 'SELF_SERVE' | 'INVITE_ONLY' | 'ENTERPRISE' | 'NONE_NEEDED' | 'DISCONTINUED';

export interface ProviderInfo {
  label: string;
  /** Environment variables that switch this provider on. */
  envVars: string[];
  access: AccessModel;
  signupUrl?: string;
  /** Honest, current note about what it takes to use this source. */
  note: string;
}

/**
 * Provider availability as of August 2026. Kept next to the config so the
 * setup screen never sends anyone to a dead end: Amadeus closed its
 * Self-Service portal on 17 July 2026 and Kiwi's Tequila has been
 * invite-only since 2024.
 */
export const providerInfo: Record<string, ProviderInfo> = {
  serpapi: {
    label: 'SerpAPI — Google Flights',
    envVars: ['SERPAPI_API_KEY'],
    access: 'SELF_SERVE',
    signupUrl: 'https://serpapi.com/users/sign_up',
    note: 'ההמלצה הראשונה: הרשמה עצמית מיידית, מחזיר תוצאות Google Flights אמיתיות, ויש מכסה חינמית חודשית. עובד גם משרתי ענן.',
  },
  duffel: {
    label: 'Duffel — NDC / חברות תעופה',
    envVars: ['DUFFEL_API_TOKEN'],
    access: 'SELF_SERVE',
    signupUrl: 'https://duffel.com/',
    note: 'הרשמה עצמית זמינה. מצב הבדיקה מחזיר נתוני דמה של Duffel Airways בלבד — למחירים אמיתיים נדרש טוקן production (בתשלום לפי חיפוש/הזמנה).',
  },
  amadeus: {
    label: 'Amadeus — GDS',
    envVars: ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'],
    access: 'DISCONTINUED',
    signupUrl: 'https://developers.amadeus.com/',
    note: 'פורטל ה-Self-Service נסגר ב-17 ביולי 2026 ומפתחות ישנים הפסיקו לעבוד. המתאם נשאר פעיל עבור חשבון Amadeus Enterprise (דורש הסמכת IATA/ARC).',
  },
  kiwi: {
    label: 'Kiwi.com Tequila',
    envVars: ['KIWI_API_KEY'],
    access: 'INVITE_ONLY',
    signupUrl: 'https://tequila.kiwi.com/portal',
    note: 'סגור להרשמה עצמית מאז 2024 — שותפות B2B בהזמנה בלבד. המתאם מוכן ויופעל מיד עם קבלת מפתח.',
  },
  'fast-flights': {
    label: 'fast-flights (Google Flights, ללא מפתח)',
    envVars: [],
    access: 'NONE_NEEDED',
    note: 'לא דורש מפתח, אך Google חוסם כתובות של שרתי ענן — בפרודקשן הוא ייכשל לעיתים קרובות. מתאים לשימוש מקומי.',
  },
  fli: {
    label: 'fli CLI (Google Flights, ללא מפתח)',
    envVars: [],
    access: 'NONE_NEEDED',
    note: 'כמו fast-flights — ללא מפתח, וכפוף לאותן חסימות מצד Google בסביבת ענן.',
  },
  mock: {
    label: 'Mock (נתוני הדגמה)',
    envVars: ['MOCK_PROVIDER'],
    access: 'NONE_NEEDED',
    note: 'נתונים סינתטיים לפיתוח ובדיקות בלבד. אין להפעיל בפרודקשן — התוצאות אינן אמיתיות.',
  },
};

const flag = (name: string, dflt = true): boolean => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return v === '1' || v.toLowerCase() === 'true';
};

const num = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/** Per-provider defaults; every value is overridable by environment. */
export const providerConfig: Record<string, ProviderConfig> = {
  'fast-flights': {
    enabled: flag('ENABLE_FAST_FLIGHTS'),
    timeoutMs: num('FAST_FLIGHTS_TIMEOUT_MS', 40000),
    requestsPerMinute: num('FAST_FLIGHTS_RPM', 30),
    concurrency: num('FAST_FLIGHTS_CONCURRENCY', 3),
  },
  fli: {
    enabled: flag('ENABLE_FLI'),
    timeoutMs: num('FLI_TIMEOUT_MS', 40000),
    requestsPerMinute: num('FLI_RPM', 30),
    concurrency: num('FLI_CONCURRENCY', 3),
  },
  serpapi: {
    enabled: flag('ENABLE_SERPAPI'),
    timeoutMs: num('SERPAPI_TIMEOUT_MS', 30000),
    requestsPerMinute: num('SERPAPI_RPM', 20),
    concurrency: num('SERPAPI_CONCURRENCY', 4),
  },
  amadeus: {
    enabled: flag('ENABLE_AMADEUS'),
    timeoutMs: num('AMADEUS_TIMEOUT_MS', 25000),
    requestsPerMinute: num('AMADEUS_RPM', 40),
    concurrency: num('AMADEUS_CONCURRENCY', 5),
  },
  duffel: {
    enabled: flag('ENABLE_DUFFEL'),
    timeoutMs: num('DUFFEL_TIMEOUT_MS', 25000),
    requestsPerMinute: num('DUFFEL_RPM', 40),
    concurrency: num('DUFFEL_CONCURRENCY', 5),
  },
  kiwi: {
    enabled: flag('ENABLE_KIWI'),
    timeoutMs: num('KIWI_TIMEOUT_MS', 20000),
    requestsPerMinute: num('KIWI_RPM', 60),
    concurrency: num('KIWI_CONCURRENCY', 5),
  },
  mock: {
    enabled: flag('ENABLE_MOCK'),
    timeoutMs: num('MOCK_TIMEOUT_MS', 5000),
    requestsPerMinute: num('MOCK_RPM', 1000),
    concurrency: num('MOCK_CONCURRENCY', 20),
  },
};

const FALLBACK: ProviderConfig = {
  enabled: true,
  timeoutMs: num('PROVIDER_TIMEOUT_SECONDS', 45) * 1000,
  requestsPerMinute: 30,
  concurrency: 4,
};

/** Env var that toggles a provider, e.g. fast-flights → ENABLE_FAST_FLIGHTS. */
export function enableFlagName(provider: string): string {
  return 'ENABLE_' + provider.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
}

/**
 * Config for a provider. The enabled flag is re-read from the environment on
 * every call so a provider can be turned off at runtime without a restart;
 * limits and timeouts are resolved once at startup.
 */
export function configFor(provider: string): ProviderConfig {
  const base = providerConfig[provider] ?? FALLBACK;
  return { ...base, enabled: flag(enableFlagName(provider), base.enabled) };
}

/**
 * Token-bucket rate limiter with a concurrency gate, per provider (§23, §43).
 * Callers await a slot; when the minute budget is exhausted the request waits
 * for the window to roll over rather than hammering the provider.
 */
export class ProviderRateLimiter {
  private windowStart = 0;
  private used = 0;
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private cfg: ProviderConfig, private now: () => number = Date.now) {}

  /** Would a request be allowed right now without waiting? */
  canProceed(): boolean {
    this.rollWindow();
    return this.active < this.cfg.concurrency && this.used < this.cfg.requestsPerMinute;
  }

  private rollWindow(): void {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.used = 0;
    }
  }

  /** Run fn under the provider's rate + concurrency limits. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    while (!this.canProceed()) {
      if (this.active >= this.cfg.concurrency) {
        await new Promise<void>((resolve) => this.queue.push(resolve));
      } else {
        // minute budget spent: wait for the window to roll over
        const wait = Math.max(50, 60_000 - (this.now() - this.windowStart));
        await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
      }
    }
    this.used++;
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  stats(): { active: number; usedThisMinute: number; limitPerMinute: number; concurrency: number } {
    this.rollWindow();
    return {
      active: this.active,
      usedThisMinute: this.used,
      limitPerMinute: this.cfg.requestsPerMinute,
      concurrency: this.cfg.concurrency,
    };
  }
}
