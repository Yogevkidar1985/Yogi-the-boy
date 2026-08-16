#!/usr/bin/env python3
"""Bridge between the Node FastFlightsAdapter and the fast-flights Python package (v3).

Reads a JSON query on stdin, prints a JSON result list on stdout.
Input:  {"origin","destination","date","returnDate"?,"seat","adults","children","infants","maxStops"?,"currency"?}
Output: {"ok": true, "currency": "ILS", "flights": [...]} or {"ok": false, "error": "..."}

fast-flights v3 model: Flights(type, price:int, airlines:[str], flights:[SingleFlight], carbon)
SingleFlight(from_airport, to_airport, departure:SimpleDatetime, arrival:SimpleDatetime,
             duration:int minutes, plane_type). SimpleDatetime(date=(y,m,d), time=(h,m)).
The price integer is denominated in the currency requested in the query.
"""
import json
import sys


def iso(dt) -> str:
    (y, m, d), (hh, mm) = dt.date, dt.time
    return f"{y:04d}-{m:02d}-{d:02d}T{hh:02d}:{mm:02d}:00"


def main() -> None:
    try:
        from fast_flights import FlightQuery, Passengers, create_query, get_flights
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"fast-flights not installed: {e}"}))
        return

    try:
        req = json.loads(sys.stdin.read())
        currency = (req.get("currency") or "EUR").upper()
        flights_q = [FlightQuery(date=req["date"], from_airport=req["origin"], to_airport=req["destination"])]
        trip = "one-way"
        if req.get("returnDate"):
            trip = "round-trip"
            flights_q.append(
                FlightQuery(date=req["returnDate"], from_airport=req["destination"], to_airport=req["origin"])
            )
        query = create_query(
            flights=flights_q,
            trip=trip,
            seat=req.get("seat", "economy"),
            passengers=Passengers(
                adults=req.get("adults", 1),
                children=req.get("children", 0),
                infants_in_seat=req.get("infants", 0),
            ),
            currency=currency,
            max_stops=req.get("maxStops"),
        )
        result = get_flights(query)
        out = []
        for f in list(result):
            legs = list(getattr(f, "flights", []) or [])
            first, last = (legs[0], legs[-1]) if legs else (None, None)
            total_minutes = sum(int(getattr(l, "duration", 0) or 0) for l in legs)
            out.append(
                {
                    "price": getattr(f, "price", None),
                    "type": getattr(f, "type", None),
                    "airlines": list(getattr(f, "airlines", []) or []),
                    "stops": max(0, len(legs) - 1),
                    "departure": iso(first.departure) if first else None,
                    "arrival": iso(last.arrival) if last else None,
                    "durationMinutes": total_minutes,
                    "legs": [
                        {
                            "from": getattr(l.from_airport, "code", None),
                            "to": getattr(l.to_airport, "code", None),
                            "departure": iso(l.departure),
                            "arrival": iso(l.arrival),
                            "durationMinutes": int(getattr(l, "duration", 0) or 0),
                            "plane": getattr(l, "plane_type", None),
                        }
                        for l in legs
                    ],
                }
            )
        print(json.dumps({"ok": True, "currency": currency, "flights": out}))
    except Exception as e:  # noqa: BLE001 - bridge must always emit JSON
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
