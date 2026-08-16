/**
 * Provider adapter architecture (§3): every data source is an isolated adapter
 * behind one interface. Failures are non-fatal (§77); each call has a timeout
 * and retry with exponential backoff (§39).
 */
import type { FlightResult, SearchQuery } from '../core/types.js';

export interface ProviderCapabilities {
  roundTrip: boolean;
  multiCity: boolean;
  flexibleDates: boolean;
  liveNetwork: boolean; // needs outbound network access
}

export interface FlightSearchAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** Static priority hint; actual selection also weighs reliability (§70). */
  readonly priority: number;
  isAvailable(): Promise<boolean>;
  search(query: SearchQuery): Promise<FlightResult[]>;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean = true
  ) {
    super(`[${provider}] ${message}`);
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 1000, timeoutMs: 30000 };

export async function withRetry<T>(
  provider: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const { attempts, baseDelayMs, timeoutMs } = { ...DEFAULT_RETRY, ...opts };
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(AbortSignal.timeout(timeoutMs));
    } catch (err) {
      lastErr = err;
      if (err instanceof ProviderError && !err.retryable) break;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError(provider, String(lastErr));
}
