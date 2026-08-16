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
    # Defensive: Google occasionally yields partial tuples on odd responses
    try:
        date = list(dt.date) + [1, 1, 1]
        time = list(dt.time) + [0, 0]
        return f"{date[0]:04d}-{date[1]:02d}-{date[2]:02d}T{time[0]:02d}:{time[1]:02d}:00"
    except Exception:
        return ""


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
        try:
            result = get_flights(query)
        except ValueError as e:
            # Google served an unparseable page (usually a datacenter-IP
            # consent/at-capacity page). Surface a clear, actionable error.
            print(json.dumps({
                "ok": False,
                "error": f"Google returned an unparseable response (likely blocking this server's IP): {e}",
            }))
            return
        out = []
        for f in list(result):
          try:
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
          except Exception:
            continue  # skip a malformed itinerary, keep the rest
        print(json.dumps({"ok": True, "currency": currency, "flights": out}))
    except Exception as e:  # noqa: BLE001 - bridge must always emit JSON
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
