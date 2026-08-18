/** Print the engine catalogue as markdown, so docs cannot drift from code. */
import { ENGINE_CATALOGUE, catalogueForDisplay } from '../src/providers/catalogue.js';

const R: Record<string, string> = {
  BUILT_IN: 'מתאם מובנה', READY: 'מוכן — מפתח בלבד', NEEDS_URL: 'כתובת מהתיעוד',
  NEEDS_LOOKUP: 'נדרש זיהוי מזהים', NEEDS_OAUTH: 'נדרש OAuth', CLOSED: 'סגור', STATUS_ONLY: 'סטטוס בלבד',
};
const C: Record<string, string> = {
  PRICE_API: 'API מחירים', META: 'מטא-סרץ׳/OTA', GDS: 'GDS', NDC: 'NDC',
  AIRLINE: 'חברת תעופה', AWARD: 'נקודות', MARKETPLACE: 'חנות API', STATUS: 'סטטוס',
};

console.log('| מנוע | קטגוריה | מצב | קישור להרשמה | משתני סביבה |');
console.log('|---|---|---|---|---|');
for (const t of catalogueForDisplay()) {
  console.log(`| ${t.label} | ${C[t.category]} | ${R[t.readiness]} | ${t.signupUrl} | ${t.envVars?.join(', ') ?? ''} |`);
}
console.error(`total ${ENGINE_CATALOGUE.length}`);
