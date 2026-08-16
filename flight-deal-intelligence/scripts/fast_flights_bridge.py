#!/usr/bin/env python3
"""Bridge between the Node FastFlightsAdapter and the fast-flights Python package.

Reads a JSON query on stdin, prints a JSON result list on stdout.
Input:  {"origin","destination","date","returnDate"?,"seat","adults","children","infants","maxStops"?,"currency"?}
Output: {"ok": true, "flights": [...]} or {"ok": false, "error": "..."}
"""
import json
import sys


def main() -> None:
    try:
        from fast_flights import FlightQuery, Passengers, create_query, get_flights
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"fast-flights not installed: {e}"}))
        return

    try:
        req = json.loads(sys.stdin.read())
        flights = [FlightQuery(date=req["date"], from_airport=req["origin"], to_airport=req["destination"])]
        trip = "one-way"
        if req.get("returnDate"):
            trip = "round-trip"
            flights.append(
                FlightQuery(date=req["returnDate"], from_airport=req["destination"], to_airport=req["origin"])
            )
        query = create_query(
            flights=flights,
            trip=trip,
            seat=req.get("seat", "economy"),
            passengers=Passengers(
                adults=req.get("adults", 1),
                children=req.get("children", 0),
                infants_in_seat=req.get("infants", 0),
            ),
            currency=req.get("currency", "EUR") or "",
            max_stops=req.get("maxStops"),
        )
        result = get_flights(query)
        out = []
        for f in list(result):
            out.append(
                {
                    "name": getattr(f, "name", None),
                    "departure": getattr(f, "departure", None),
                    "arrival": getattr(f, "arrival", None),
                    "duration": getattr(f, "duration", None),
                    "stops": getattr(f, "stops", None),
                    "price": getattr(f, "price", None),
                    "is_best": getattr(f, "is_best", None),
                    "delay": getattr(f, "delay", None),
                }
            )
        print(json.dumps({"ok": True, "flights": out}))
    except Exception as e:  # noqa: BLE001 - bridge must always emit JSON
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
