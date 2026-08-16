/**
 * Currency normalization (§35). All prices are stored with original + normalized value.
 *
 * Live rates come from a pluggable fetcher (exchangerate.host compatible); when the
 * network is unavailable the service falls back to bundled static rates and marks
 * the timestamp accordingly. Rates are cached with a daily TTL (§54-55).
 */

export interface RateTable {
  base: string;
  rates: Record<string, number>;
  fetchedAt: string;
  source: 'live' | 'static';
}

/** Static fallback rates (approximate, base EUR). Updated when live fetch succeeds. */
const STATIC_RATES: Record<string, number> = {
  EUR: 1,
  USD: 1.17,
  ILS: 3.95,
  GBP: 0.85,
  CHF: 0.94,
  JPY: 172,
  THB: 38,
  AED: 4.3,
  TRY: 47,
  PLN: 4.27,
  HUF: 395,
  CZK: 24.6,
  RON: 5.06,
  BGN: 1.96,
  DKK: 7.46,
  SEK: 11.1,
  NOK: 11.6,
};

export class CurrencyService {
  private table: RateTable = {
    base: 'EUR',
    rates: { ...STATIC_RATES },
    fetchedAt: new Date(0).toISOString(),
    source: 'static',
  };
  private ttlMs = 24 * 60 * 60 * 1000;

  constructor(private defaultCurrency: string = process.env.DEFAULT_CURRENCY ?? 'EUR') {}

  get systemCurrency(): string {
    return this.defaultCurrency;
  }

  get lastUpdated(): string {
    return this.table.fetchedAt;
  }

  get source(): string {
    return this.table.source;
  }

  /** Try to refresh live rates. Non-fatal on failure (§39-40: providers may be down). */
  async refresh(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (Date.now() - Date.parse(this.table.fetchedAt) < this.ttlMs) return true;
    try {
      const res = await fetchImpl('https://open.er-api.com/v6/latest/EUR', {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { rates?: Record<string, number> };
      if (!data.rates) return false;
      this.table = {
        base: 'EUR',
        rates: data.rates,
        fetchedAt: new Date().toISOString(),
        source: 'live',
      };
      return true;
    } catch {
      return false; // keep static fallback
    }
  }

  rate(from: string, to: string): number {
    const f = this.table.rates[from.toUpperCase()];
    const t = this.table.rates[to.toUpperCase()];
    if (!f || !t) throw new Error(`Unknown currency: ${from} or ${to}`);
    return t / f;
  }

  convert(amount: number, from: string, to?: string): { value: number; rate: number; timestamp: string } {
    const target = to ?? this.defaultCurrency;
    if (from.toUpperCase() === target.toUpperCase()) {
      return { value: amount, rate: 1, timestamp: this.table.fetchedAt };
    }
    const r = this.rate(from, target);
    return { value: Math.round(amount * r * 100) / 100, rate: r, timestamp: this.table.fetchedAt };
  }
}

export const currencyService = new CurrencyService();
