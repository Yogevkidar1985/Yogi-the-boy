/**
 * Similar Flights Engine (Flight Watch V1 §8-§11): when a user saves a flight,
 * the system understands WHAT they liked about it — the "Flight DNA" — and
 * scores alternative flights on the same route/date window against it.
 *
 * Candidates come from the watch's monitored search (same route and dates), so
 * route+date similarity is already guaranteed; the score differentiates on
 * stops, schedule, duration, airline and price advantage.
 */

export interface FlightDna {
  airline?: string | null;
  flightNumber?: string | null;
  stops?: number | null;
  departureTime?: string | null;
  durationMinutes?: number | null;
  price: number;
}

export interface SimilarCandidate {
  airline: string;
  airlineName?: string;
  flightNumber?: string;
  stops: number;
  departureTime?: string;
  durationMinutes?: number;
  price: number;
  currency: string;
  bookingUrl?: string;
  similarity: number;
}

function depHour(t: string | null | undefined): number | null {
  const m = String(t ?? '').match(/T(\d{2})/);
  return m ? Number(m[1]) : null;
}

/** 0-100. Same route + dates are a given (the monitor query enforces them). */
export function similarityScore(
  dna: FlightDna,
  candidate: { airline?: string; stops?: number; departureTime?: string; durationMinutes?: number; normalizedPrice: number }
): number {
  let score = 45; // same route, same dates — the baseline the query guarantees

  // stops (15)
  if (dna.stops != null && candidate.stops != null) {
    const diff = Math.abs(dna.stops - candidate.stops);
    score += diff === 0 ? 15 : diff === 1 ? 7 : 0;
  } else {
    score += 7;
  }

  // schedule (15): how close is the departure hour
  const h1 = depHour(dna.departureTime);
  const h2 = depHour(candidate.departureTime);
  if (h1 !== null && h2 !== null) {
    const d = Math.min(Math.abs(h1 - h2), 24 - Math.abs(h1 - h2));
    score += d <= 1 ? 15 : d <= 3 ? 10 : d <= 6 ? 5 : 0;
  } else {
    score += 5;
  }

  // duration (10)
  if (dna.durationMinutes && candidate.durationMinutes) {
    const ratio = Math.abs(candidate.durationMinutes - dna.durationMinutes) / dna.durationMinutes;
    score += ratio <= 0.1 ? 10 : ratio <= 0.25 ? 6 : 2;
  } else {
    score += 4;
  }

  // airline (10)
  if (dna.airline && candidate.airline) {
    score += dna.airline === candidate.airline ? 10 : 0;
  }

  // price advantage (5)
  if (candidate.normalizedPrice < dna.price) score += 5;
  else if (candidate.normalizedPrice <= dna.price * 1.05) score += 3;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Exact-same-flight check — those are the watch itself, not an alternative. */
export function isSameFlight(dna: FlightDna, candidate: { airline?: string; flightNumber?: string }): boolean {
  return Boolean(
    dna.airline && dna.flightNumber &&
    candidate.airline === dna.airline &&
    candidate.flightNumber === dna.flightNumber
  );
}

/** Rank the watch's alternatives: top N similar candidates, best value first. */
export function rankSimilar(
  dna: FlightDna,
  flights: {
    airline: string; airlineName?: string; flightNumber: string; stops: number;
    departureTime: string; durationMinutes: number; normalizedPrice: number;
    normalizedCurrency: string; bookingUrl: string;
  }[],
  minScore = 60,
  limit = 3
): SimilarCandidate[] {
  return flights
    .filter((f) => !isSameFlight(dna, f))
    .map((f) => ({
      airline: f.airline,
      airlineName: f.airlineName,
      flightNumber: f.flightNumber,
      stops: f.stops,
      departureTime: f.departureTime,
      durationMinutes: f.durationMinutes,
      price: f.normalizedPrice,
      currency: f.normalizedCurrency,
      bookingUrl: f.bookingUrl,
      similarity: similarityScore(dna, f),
    }))
    .filter((c) => c.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity || a.price - b.price)
    .slice(0, limit);
}
