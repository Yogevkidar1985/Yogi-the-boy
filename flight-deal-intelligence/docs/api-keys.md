# הזנת מפתחות API — מדריך מלא ל-Render

מסמך אחד שמרכז כל מקור, איפה מוציאים ממנו מפתח, ומה בדיוק להדביק ב-Render.
העתיקו את שם המשתנה בדיוק כפי שהוא כתוב — המערכת מחפשת את השם הזה.

---

## שלב 0 — איפה מזינים ב-Render (זהה לכל המפתחות)

1. https://dashboard.render.com ← בוחרים את השירות **flight-deal-intelligence**
2. בתפריט הצד: **Environment**
3. **Add Environment Variable** ← **Key** = שם המשתנה, **Value** = הערך מהספק
4. **Save Changes** — Render מפרס מחדש אוטומטית (1–3 דקות)
5. אחרי הפריסה: נכנסים ל-`/providers.html` באתר ולוחצים **בדיקת חיבור** לכל מקור

> המערכת לא מסמנת מקור כ"מחובר" רק בגלל שקיים מפתח — הבדיקה מריצה חיפוש אמיתי מולו.

---

## שלב 1 — המקורות שאפשר לפתוח היום בהרשמה עצמית

לפי הסדר המומלץ. אפשר להתחיל מאחד ולהוסיף בהמשך; כל מקור שמתווסף נסרק **במקביל** לשאר.

### 1. Travelpayouts / Aviasales — חינם, הכי מהיר להפעלה

- הרשמה: https://www.travelpayouts.com/
- אחרי אישור החשבון: **Tools → API → Flight Data API**, שם מופיע ה-Token
- ה-Marker הוא מספר השותף שלכם, מופיע באותו מסך

| Key | Value |
|---|---|
| `TRAVELPAYOUTS_TOKEN` | ה-Token מהמסך |
| `TRAVELPAYOUTS_MARKER` | מספר ה-Marker |

מה מקבלים: מחירים זולים שנצפו לאחרונה (נתוני מטמון, לא חיפוש זמינות חי) —
המערכת מסמנת אותם ככאלה ולא מציגה אותם כמחיר מאומת.

### 2. SerpAPI — תוצאות Google Flights אמיתיות

- הרשמה: https://serpapi.com/users/sign_up
- המפתח: https://serpapi.com/manage-api-key
- מכסה חינמית חודשית, מעבר לה לפי שימוש

| Key | Value |
|---|---|
| `SERPAPI_API_KEY` | המפתח מהמסך |

### 3. Duffel — תוכן NDC ישירות מחברות התעופה

- הרשמה: https://app.duffel.com/join
- המפתח: **Developers → Access tokens → New token**

| Key | Value |
|---|---|
| `DUFFEL_API_TOKEN` | הטוקן (`duffel_test_…` או `duffel_live_…`) |

> שימו לב: טוקן **test** מחזיר נתוני דמה של חברת תעופה מומצאת. המערכת מזהה
> ומסמנת זאת. לנתונים אמיתיים צריך טוקן **live** אחרי אישור חשבון ב-Duffel.

### 4. Telegram — התראות על ירידות מחיר

- פותחים בטלגרם צ׳אט עם **@BotFather** ← `/newbot` ← בוחרים שם ← מקבלים Token
- שולחים הודעה כלשהי לבוט החדש, ואז נכנסים ל:
  `https://api.telegram.org/bot<TOKEN>/getUpdates` ← מעתיקים את `chat.id`

| Key | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | הטוקן מ-BotFather |
| `TELEGRAM_CHAT_ID` | ה-chat id שלכם |

---

## שלב 2 — מקורות שסגורים כרגע להרשמה עצמית

המתאמים מוכנים במערכת; ברגע שיש מפתח הוא נכנס לעבודה מיד.

| מקור | מצב (אוגוסט 2026) | קישור | משתנים |
|---|---|---|---|
| **Amadeus** | פורטל ה-Self-Service נסגר ב-17.7.2026; נדרש חשבון Enterprise | https://developers.amadeus.com/ | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_ENV=production` |
| **Kiwi Tequila** | בהזמנה בלבד מאז 2024 (שותפים עסקיים) | https://tequila.kiwi.com/portal | `KIWI_API_KEY` |
| **FlightRadar24** | העשרה בלבד (מספרי טיסה/מטוסים), לא חובה | https://fr24api.flightradar24.com/ | `FLIGHTRADAR_API_KEY` |

---

## שלב 3 — כל API אחר, בלי לכתוב קוד

לשלושה מקורות נוספים יש חריצים מוכנים ב-Render (`CUSTOM1_`, `CUSTOM2_`, `CUSTOM3_`).
מעבר לזה — מסך הניהול תומך ב-20–30 מנועים.

### דרך א׳: משתני סביבה ב-Render

| Key | דוגמה לערך |
|---|---|
| `CUSTOM1_NAME` | `flightapi` |
| `CUSTOM1_URL` | `https://api.flightapi.io/onewaytrip/{KEY}/{origin}/{destination}/{departureDate}/{adults}/{children}/{infants}/{cabinTitle}/{currency}` |
| `CUSTOM1_KEY` | המפתח מהספק |
| `CUSTOM1_HEADERS` | `{"Authorization":"Bearer {KEY}"}` (אם נדרש) |
| `CUSTOM1_ITEMS` | נתיב JSON למערך התוצאות, למשל `data.itineraries` |
| `CUSTOM1_MAP` | מיפוי שדות, ראו למטה |
| `CUSTOM1_TIER` | `FREE` / `LOW_COST` / `PAID` / `PREMIUM` |

תבניות שאפשר להשתמש בהן בכתובת ובכותרות:

```
{KEY} {origin} {destination} {departureDate} {returnDate}
{adults} {children} {infants} {cabin} {cabinTitle} {cabinLower} {currency}
```

מיפוי שדות (חובה רק `price`; מה שלא קיים נשאר ריק — המערכת לא ממציאה ערכים,
ותוצאה בלי מחיר נזרקת):

```json
{
  "price": "fare.total",
  "currency": "fare.currency",
  "airline": "carrier.iata",
  "airlineName": "carrier.name",
  "flightNumber": "carrier.number",
  "departureTime": "dep",
  "arrivalTime": "arr",
  "stops": "stopCount",
  "durationMinutes": "durationMin",
  "bags": "baggage.checked",
  "bookingUrl": "link"
}
```

> את המבנה המדויק של התשובה לוקחים מהתיעוד של הספק עצמו. אל תנחשו נתיבים —
> מיפוי שגוי יגרום לכך שהמנוע פשוט לא יחזיר תוצאות (ולא לנתונים שגויים).

### דרך ב׳: מסך הניהול `/admin.html` — מומלץ ל-20–30 מנועים

הפעלה חד-פעמית ב-Render:

| Key | Value |
|---|---|
| `ADMIN_TOKEN` | סיסמה שתבחרו — הכניסה למסך הניהול |
| `ADMIN_SECRET` | מחרוזת אקראית באורך 20+ תווים — מצפינה את המפתחות בבסיס הנתונים |

ליצירת `ADMIN_SECRET` אקראי: `openssl rand -base64 32`

בלי `ADMIN_SECRET` המערכת **מסרבת** לשמור מפתחות, כדי שלא יישמרו בטקסט גלוי.

אחרי ההוספה: מנוע חדש מצטרף לחיפוש המקבילי **מיד**, בלי פריסה מחדש, עם
מגבלות קצב משלו (בקשות לדקה, מקביליות, timeout) וכפתורי בדיקה/השהיה/מחיקה.

מקורות שנוח לחבר כך (הרשמה עצמית, מבנה תשובה משתנה — יש לקחת מהתיעוד שלהם):

| מקור | קישור |
|---|---|
| FlightAPI.io | https://www.flightapi.io/ |
| Aviationstack | https://aviationstack.com/ |
| Amadeus for Developers (Enterprise) | https://developers.amadeus.com/ |
| RapidAPI — קטגוריית Flights | https://rapidapi.com/category/Travel |

---

## שלב 4 — הגדרות מומלצות (לא חובה)

| Key | ערך מוצע | מה זה עושה |
|---|---|---|
| `DEFAULT_CURRENCY` | `ILS` | מטבע התצוגה |
| `DEFAULT_ORIGIN` | `TLV` | שדה המוצא שמוצע כברירת מחדל |
| `PAID_REQUESTS_PER_DAY` | `400` | תקרה יומית לקריאות למקורות בתשלום |
| `SEARCH_CACHE_MINUTES` | `10` | כמה זמן תוצאה זהה נחשבת טרייה |
| `WORKER_POLL_SECONDS` | `60` | תדירות סבב הרענון של המעקבים |
| `MOCK_PROVIDER` | `0` | **חייב להישאר 0 בייצור** — אחרת יוצגו נתוני הדגמה |

---

## שלב 5 — בדיקה שהכל עובד

1. `/providers.html` ← לכל מקור מופיע **מוגדר**/**חסר** ולידו כפתור **בדיקת חיבור**
2. לוחצים בדיקת חיבור — מקור תקין יחזיר מספר תוצאות והשהיה במילישניות
3. `/api/health` מחזיר את רשימת המקורות ומצב הטלגרם
4. מריצים חיפוש אמיתי בעמוד הראשי ורואים שמופיעים שמות המקורות על התוצאות

---

## אבטחה

- המפתחות נשמרים בצד השרת בלבד ואינם נשלחים לדפדפן — ה-API מחזיר רק אם משתנה מוגדר או לא.
- מפתחות שנשמרים דרך מסך הניהול מוצפנים ב-AES-256-GCM.
- אין להעלות מפתחות ל-git. הקובץ `.env` אינו נשמר בריפו.
- אם מפתח נחשף — מבטלים אותו אצל הספק ומייצרים חדש; החלפה ב-Render היא מיידית.
