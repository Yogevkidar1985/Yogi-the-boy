/**
 * Booking / deep link generation (§47). The system never books — it hands the
 * user real-time links to Google Flights, Kiwi and airline sites.
 */
import type { SearchQuery } from './types.js';

export function googleFlightsUrl(q: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
}): string {
  const oneWay = !q.returnDate;
  const query = oneWay
    ? `Flights from ${q.origin} to ${q.destination} on ${q.departureDate} one way`
    : `Flights from ${q.origin} to ${q.destination} on ${q.departureDate} through ${q.returnDate}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}&curr=EUR`;
}

export function kiwiUrl(q: { origin: string; destination: string; departureDate: string; returnDate?: string }): string {
  const base = `https://www.kiwi.com/en/search/results/${q.origin.toLowerCase()}/${q.destination.toLowerCase()}/${q.departureDate}`;
  return q.returnDate ? `${base}/${q.returnDate}` : `${base}/no-return`;
}

export function skyscannerUrl(q: { origin: string; destination: string; departureDate: string; returnDate?: string }): string {
  const d = q.departureDate.replaceAll('-', '').slice(2);
  const r = q.returnDate ? '/' + q.returnDate.replaceAll('-', '').slice(2) : '';
  return `https://www.skyscanner.com/transport/flights/${q.origin.toLowerCase()}/${q.destination.toLowerCase()}/${d}${r}/`;
}

export function kayakUrl(q: { origin: string; destination: string; departureDate: string; returnDate?: string }): string {
  const base = `https://www.kayak.com/flights/${q.origin}-${q.destination}/${q.departureDate}`;
  return q.returnDate ? `${base}/${q.returnDate}` : base;
}

export function momondoUrl(q: { origin: string; destination: string; departureDate: string; returnDate?: string }): string {
  const base = `https://www.momondo.com/flight-search/${q.origin}-${q.destination}/${q.departureDate}`;
  return q.returnDate ? `${base}/${q.returnDate}` : base;
}

export function bookingLinks(q: SearchQuery | { origin: string; destination: string; departureDate: string; returnDate?: string }) {
  return {
    googleFlights: googleFlightsUrl(q),
    kiwi: kiwiUrl(q),
    skyscanner: skyscannerUrl(q),
    kayak: kayakUrl(q),
    momondo: momondoUrl(q),
  };
}
