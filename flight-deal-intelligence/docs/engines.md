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

## קבוצה א׳ — מקורות מחירים בהרשמה עצמית (אלה שמחזירים מחירי טיסות)

| # | מנוע | קישור להרשמה / מפתח | מה מקבלים | הטמעה |
|---|---|---|---|---|
| 1 | **Travelpayouts / Aviasales** | https://www.travelpayouts.com/ | מחירים זולים במטמון | מובנה: `TRAVELPAYOUTS_TOKEN`, `TRAVELPAYOUTS_MARKER` |
| 2 | **SerpAPI (Google Flights)** | https://serpapi.com/users/sign_up · מפתח: https://serpapi.com/manage-api-key | תוצאות Google Flights אמיתיות | מובנה: `SERPAPI_API_KEY` |
| 3 | **Duffel** | https://app.duffel.com/join | NDC ישיר מחברות תעופה | מובנה: `DUFFEL_API_TOKEN` (טוקן `test` = נתוני דמה) |
| 4 | **FlightAPI.io** | https://www.flightapi.io/ | מחירים מ-700+ חברות ומוכרים, 20 קריאות חינם לניסיון | מסך הניהול. כתובת: `https://api.flightapi.io/onewaytrip/{KEY}/{origin}/{destination}/{departureDate}/{adults}/{children}/{infants}/{cabinTitle}/{currency}` |
| 5 | **Sky Scrapper (נתוני Skyscanner)** | https://rapidapi.com/apiheya/api/sky-scrapper | חיפוש טיסות בזמן אמת, ~100 קריאות חינם בחודש | מסך הניהול + כותרות RapidAPI (למטה) |
| 6 | **Booking.com Flights** | https://rapidapi.com/ — קטגוריית Travel | חיפוש טיסות | מסך הניהול + כותרות RapidAPI |
| 7 | **Kiwi.com (דרך RapidAPI)** | https://rapidapi.com/ — חיפוש "Kiwi" | virtual interlining, מסלולים יצירתיים | מסך הניהול + כותרות RapidAPI |
| 8 | **Seats.aero** | https://developers.seats.aero/ | זמינות ומחירי **כרטיסי נקודות/אוורד** | מסך הניהול |
| 9 | **Ryanair (רשמי)** | https://developer.ryanair.com/apis | מחירים וזמינות של Ryanair בלבד | מסך הניהול, ללא מפתח |
| 10 | **Zyla API Hub / api.market** | https://zylalabs.com · https://api.market/ | חנויות API עם עשרות מנועי טיסות | מסך הניהול, מפתח אחד לכל החנות |

### כותרות ל-RapidAPI (שורות 5–7)

```json
{"x-rapidapi-key":"{KEY}","x-rapidapi-host":"sky-scrapper.p.rapidapi.com"}
```

`x-rapidapi-host` משתנה לפי ה-API שבחרתם — הוא מופיע בעמוד ה-API ב-RapidAPI.
מפתח RapidAPI אחד עובד מול **כל** ה-APIs שם, כך שאפשר להוסיף כמה מנועים עם אותו מפתח.

---

## קבוצה ב׳ — מקורות סטטוס/לוחות זמנים (לא מחירים)

חשוב: אלה **לא** מחזירים מחירים. הם שימושיים להעשרה (מספרי טיסה, עיכובים, סוג מטוס),
אבל אם תגדירו אותם כמנוע חיפוש הם יחזירו אפס תוצאות — כי אין בתשובה שדה מחיר.

| מנוע | קישור | למה משמש |
|---|---|---|
| Aviationstack | https://aviationstack.com/ | סטטוס טיסות, לוחות זמנים |
| AeroDataBox | https://rapidapi.com/aedbx-aedbx/api/aerodatabox | לוחות זמנים, מטוסים |
| FlightAware AeroAPI | https://www.flightaware.com/commercial/aeroapi/ | מעקב טיסות |
| FlightLabs | https://www.goflightlabs.com/ | סטטוס, לוחות זמנים |
| FlightRadar24 | https://fr24api.flightradar24.com/ | מעקב (מוגדר אצלנו כהעשרה: `FLIGHTRADAR_API_KEY`) |

---

## קבוצה ג׳ — סגורים להרשמה עצמית

| מנוע | מצב (אוגוסט 2026) | קישור |
|---|---|---|
| **Amadeus** | Self-Service נסגר 17.7.2026; Enterprise בלבד | https://developers.amadeus.com/ |
| **Kiwi Tequila (ישיר)** | שותפים בלבד; נדרש פרויקט עם 50,000+ MAU | https://tequila.kiwi.com/portal |
| **Skyscanner Travel API** | שותפות מסחרית, אישור פרטני | https://www.partners.skyscanner.net/ |
| Sabre / Travelport / Mystifly | חוזה B2B, לרוב דורש IATA/ARC | אתרי הספקים |

---

## סדר עבודה מומלץ להיום

1. **Travelpayouts** ו-**SerpAPI** — הרשמה עצמית מיידית, מכסה חינמית. משתני סביבה ב-Render.
2. **RapidAPI** — פותחים חשבון אחד, ומוסיפים ממנו 3–5 מנועים במסך הניהול עם אותו מפתח.
   זו הדרך המהירה ביותר להגיע ל-10 מנועים פעילים.
3. **FlightAPI.io** ו-**Duffel** — הרשמה עצמית, מפתח לכל אחד.
4. **Ryanair** ו-**Seats.aero** — נישתיים אבל מוסיפים כיסוי שאין למנועים הכלליים.

לכל מנוע שמוסיפים: **זיהוי אוטומטי → שמירה → כפתור בדיקה** בטבלה. מנוע שהבדיקה שלו
נכשלת לא יזיק לחיפוש (יש timeout, מפסק אוטומטי אחרי 3 כשלים, והחיפוש ממשיך בלעדיו),
אבל גם לא יתרום — לכן שווה לוודא ירוק לכל אחד.

---

## מגבלות שחשוב להכיר

- **מכסות חינם נגמרות מהר.** מנוע ב-100 קריאות לחודש יתרום מעט מאוד בחיפוש מקבילי.
  קבעו לו `בקשות לדקה` נמוך, או השאירו אותו מושהה ותפעילו רק לאימות מחיר.
- **לא כל מנוע מחזיר קישור הזמנה.** בלי `bookingUrl` המערכת מייצרת קישור חיפוש כללי
  ולא מתחזה לקישור הזמנה ישיר.
- **מטבע.** אם ה-API לא מחזיר שדה מטבע — בדקו בתיעוד באיזה מטבע הוא עובד. מחיר במטבע
  שגוי יהרוס את ההשוואה בין המנועים.
- **scraping.** המערכת לא עוקפת הגנות בוט ולא מפרה תנאי שימוש. מנוע שדורש זאת לא ייתמך.
