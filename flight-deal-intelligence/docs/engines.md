# קטלוג מנועי חיפוש — הטמעה של 10–20 מנועים

מסמך עבודה: לכל מנוע — קישור להרשמה, מה הוא באמת מחזיר, ואיך מטמיעים אותו.

## איך מטמיעים מנוע ב-3 דקות (`/admin.html`)

1. **שם מזהה** באנגלית, למשל `flightapi`
2. **כתובת ה-API** עם התבניות: `{KEY} {origin} {destination} {departureDate} {returnDate} {adults} {children} {infants} {cabin} {cabinTitle} {cabinLower} {currency}`
3. **מפתח API** (נשמר מוצפן AES-256-GCM)
4. **כותרות** אם ה-API דורש, למשל `{"Authorization":"Bearer {KEY}"}`
5. לוחצים **זיהוי אוטומטי של המבנה** ← המערכת שולחת בקשה אמיתית אחת, קוראת את התשובה,
   וממלאת לבד את נתיב התוצאות ואת מיפוי השדות
6. **שמירה** — המנוע מצטרף לחיפוש המקבילי מיד, בלי פריסה מחדש

הזיהוי האוטומטי לא מנחש: שדה שלא זוהה נשאר ריק ומוצגת אזהרה. אם ה-API החזיר שגיאה
או מפתח שגוי — מוצג קוד השגיאה והתשובה המקורית, ולא "הצלחה" מזויפת.

---

## כל המנועים בקטלוג (46)

הרשימה נוצרת מהקוד עצמו (`npx tsx scripts/print-catalogue.ts`) ולכן תמיד מעודכנת.

**משמעות המצבים:**

| מצב | מה נדרש ממך |
|---|---|
| מתאם מובנה | משתנה סביבה ב-Render, זהו |
| מוכן — מפתח בלבד | הוסף מהקטלוג, הדבק מפתח, זיהוי אוטומטי, שמור |
| כתובת מהתיעוד | העתק את ה-endpoint מהספק, השאר זהה |
| נדרש זיהוי מזהים | הספק לא מקבל קודי IATA — נדרשת תוספת קוד אצלנו |
| נדרש OAuth | הספק דורש החלפת טוקן — נדרשת תוספת קוד אצלנו |
| סגור | אין הרשמה עצמית; המתאם ימתין לגישה |
| סטטוס בלבד | ללא מחירים — לא מתאים כמנוע חיפוש |

| מנוע | קטגוריה | מצב | קישור להרשמה | משתני סביבה |
|---|---|---|---|---|
| Duffel — NDC | NDC | מתאם מובנה | https://app.duffel.com/join | DUFFEL_API_TOKEN |
| SerpAPI — Google Flights | API מחירים | מתאם מובנה | https://serpapi.com/users/sign_up | SERPAPI_API_KEY |
| Travelpayouts / Aviasales | API מחירים | מתאם מובנה | https://www.travelpayouts.com/ | TRAVELPAYOUTS_TOKEN, TRAVELPAYOUTS_MARKER |
| Aviasales — הכרטיסים הזולים | API מחירים | מוכן — מפתח בלבד | https://www.travelpayouts.com/ |  |
| Aviasales — לוח מחירים חודשי | API מחירים | מוכן — מפתח בלבד | https://www.travelpayouts.com/ |  |
| FlightAPI.io | API מחירים | מוכן — מפתח בלבד | https://www.flightapi.io/ |  |
| Ryanair — מחירים ישירים | חברת תעופה | מוכן — מפתח בלבד | https://developer.ryanair.com/apis |  |
| Seats.aero — כרטיסי נקודות | נקודות | מוכן — מפתח בלבד | https://seats.aero/apikey |  |
| Air France-KLM Developer | חברת תעופה | כתובת מהתיעוד | https://developer.airfranceklm.com/ |  |
| api.market (MagicAPI) | חנות API | כתובת מהתיעוד | https://api.market/ |  |
| British Airways / IAG | חברת תעופה | כתובת מהתיעוד | https://developer.iairgroup.com/ |  |
| Flights Scraper Sky | חנות API | כתובת מהתיעוד | https://rapidapi.com/ntd119/api/flights-sky |  |
| Google Flights (RapidAPI) | חנות API | כתובת מהתיעוד | https://rapidapi.com/DataCrawler/api/google-flights2 |  |
| Kiwi.com (דרך RapidAPI) | חנות API | כתובת מהתיעוד | https://rapidapi.com/search/kiwi |  |
| PointsYeah — כרטיסי נקודות | נקודות | כתובת מהתיעוד | https://www.pointsyeah.com/ |  |
| SearchApi — Google Flights | API מחירים | כתובת מהתיעוד | https://www.searchapi.io/google-flights-api |  |
| Zyla API Hub | חנות API | כתובת מהתיעוד | https://zylalabs.com/ |  |
| Booking.com Flights | חנות API | נדרש זיהוי מזהים | https://rapidapi.com/DataCrawler/api/booking-com15 |  |
| Sky Scrapper (נתוני Skyscanner) | חנות API | נדרש זיהוי מזהים | https://rapidapi.com/apiheya/api/sky-scrapper |  |
| Lufthansa Group Open API | חברת תעופה | נדרש OAuth | https://developer.lufthansa.com/ |  |
| Sabre Dev Studio | GDS | נדרש OAuth | https://developer.sabre.com/ |  |
| Travelport+ APIs | GDS | נדרש OAuth | https://developer.travelport.com/ |  |
| AirGateway — NDC | NDC | סגור | https://airgateway.com/products/airgateway-api/ |  |
| Amadeus — GDS | GDS | סגור | https://developers.amadeus.com/ | AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET |
| AwardFares | נקודות | סגור | https://awardfares.com/ |  |
| easyJet | חברת תעופה | סגור | https://www.easyjet.com/ |  |
| eDreams ODIGEO | מטא-סרץ׳/OTA | סגור | https://www.edreamsodigeo.com/ |  |
| Expedia Rapid / Partner | מטא-סרץ׳/OTA | סגור | https://developers.expediagroup.com/ |  |
| Kayak Affiliate | מטא-סרץ׳/OTA | סגור | https://www.kayak.com/affiliates |  |
| Kiwi.com Tequila | מטא-סרץ׳/OTA | סגור | https://tequila.kiwi.com/portal | KIWI_API_KEY |
| Mystifly | NDC | סגור | https://www.mystifly.com/ |  |
| PKFARE | NDC | סגור | https://www.pkfare.com/ |  |
| point.me | נקודות | סגור | https://point.me/ |  |
| Skyscanner Travel API | מטא-סרץ׳/OTA | סגור | https://www.partners.skyscanner.net/ |  |
| TBO Air API | NDC | סגור | https://www.tboholidays.com/ |  |
| TPConnects — NDC | NDC | סגור | https://tpconnects.com/ |  |
| Travelfusion | NDC | סגור | https://www.travelfusion.com/ |  |
| Trip.com Affiliate | מטא-סרץ׳/OTA | סגור | https://www.trip.com/partners/ |  |
| Verteil — NDC | NDC | סגור | https://www.verteil.com/ |  |
| Wego Partner API | מטא-סרץ׳/OTA | סגור | https://www.wego.com/affiliates |  |
| Wizz Air | חברת תעופה | סגור | https://wizzair.com/ |  |
| AeroDataBox | סטטוס | סטטוס בלבד | https://rapidapi.com/aedbx-aedbx/api/aerodatabox |  |
| Aviationstack | סטטוס | סטטוס בלבד | https://aviationstack.com/ |  |
| FlightAware AeroAPI | סטטוס | סטטוס בלבד | https://www.flightaware.com/commercial/aeroapi/ |  |
| FlightLabs | סטטוס | סטטוס בלבד | https://www.goflightlabs.com/ |  |
| Flightradar24 | סטטוס | סטטוס בלבד | https://fr24api.flightradar24.com/ | FLIGHTRADAR_API_KEY |

---

## סדר עבודה מומלץ

1. **Travelpayouts** — הרשמה חינם. טוקן אחד מפעיל 3 מנועים: המתאם המובנה,
   "הכרטיסים הזולים" ו"לוח מחירים חודשי".
2. **SerpAPI** — מכסה חינמית, תוצאות Google Flights אמיתיות. משתנה סביבה.
3. **RapidAPI** — חשבון אחד, מפתח אחד, ומוסיפים ממנו 5 מנועים מהקטלוג
   (רק `x-rapidapi-host` משתנה בין אחד לשני).
4. **FlightAPI.io**, **Seats.aero**, **Ryanair** — כתובת כבר בקטלוג, מפתח ושמור.
   Ryanair לא דורש מפתח בכלל.
5. **Air France-KLM**, **Lufthansa**, **IAG** — פורטלי מפתחים עם הרשמה עצמית.

## מה עדיין חסום — ודורש תוספת קוד, לא מפתח

| חסם | מי מושפע | מה נדרש |
|---|---|---|
| זיהוי מזהים לפני חיפוש | Sky Scrapper, Booking.com | קריאה מקדימה שממירה IATA למזהה פנימי, ואז החיפוש |
| אימות OAuth | Sabre, Travelport, Lufthansa | החלפת client id/secret בטוקן, עם רענון לפני פקיעה |
| תאריך מתוך התשובה | Aviasales /prices/latest | מיפוי `departureDate` מהתשובה במקום חותמת התאריך שנשאל |

שלושת אלה פותחים יחד עוד 6 מנועים. אף אחד מהם לא תלוי במפתח — זו עבודה בצד שלנו.

## מגבלות שחשוב להכיר

- **מכסות חינם נגמרות מהר.** מנוע ב-100 קריאות לחודש יתרום מעט בחיפוש מקבילי.
  קבעו לו `בקשות לדקה` נמוך, או השאירו מושהה ותפעילו רק לאימות מחיר.
- **לא כל מנוע מחזיר קישור הזמנה.** בלי `bookingUrl` המערכת מייצרת קישור חיפוש כללי
  ולא מתחזה לקישור הזמנה ישיר.
- **מטבע.** אם ה-API לא מחזיר שדה מטבע — בדקו בתיעוד באיזה מטבע הוא עובד. מחיר במטבע
  שגוי יהרוס את ההשוואה בין המנועים.
- **הגנות בוט.** המערכת לא עוקפת הגנות ולא מפרה תנאי שימוש. ספק שדורש זאת מסומן כסגור.
