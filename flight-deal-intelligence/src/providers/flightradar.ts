/**
 * FlightRadarAdapter (§6): operational enrichment ONLY — never a price source,
 * fully isolated from the search pipeline. Uses the public, documented
 * FlightRadar24 data endpoints where reachable; when no API is available the
 * system continues without it (non-fatal by design).
 */

export interface FlightStatus {
  flightNumber: string;
  airline?: string;
  aircraft?: string;
  origin?: string;
  destination?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  estimatedDeparture?: string;
  estimatedArrival?: string;
  status?: string;
}

export class FlightRadarAdapter {
  readonly name = 'flightradar24';

  constructor(private apiKey: string | undefined = process.env.FLIGHTRADAR_API_KEY) {}

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Look up live status for a flight number via the official FR24 API
   * (https://fr24api.flightradar24.com — requires subscription API key).
   * Returns null when the API is not configured or unreachable.
   */
  async flightStatus(flightNumber: string): Promise<FlightStatus | null> {
    if (!this.apiKey) return null;
    try {
      const res = await fetch(
        `https://fr24api.flightradar24.com/api/live/flight-positions/full?flights=${encodeURIComponent(flightNumber)}`,
        {
          headers: {
            Accept: 'application/json',
            'Accept-Version': 'v1',
            Authorization: `Bearer ${this.apiKey}`,
          },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Record<string, unknown>[] };
      const f = data.data?.[0];
      if (!f) return null;
      return {
        flightNumber,
        airline: (f.painted_as as string) ?? (f.operating_as as string),
        aircraft: f.type as string,
        origin: f.orig_iata as string,
        destination: f.dest_iata as string,
        estimatedArrival: f.eta as string,
        status: 'airborne',
      };
    } catch {
      return null; // enrichment is best-effort (§6)
    }
  }
}
