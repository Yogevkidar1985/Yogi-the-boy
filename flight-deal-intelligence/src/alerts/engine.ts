/**
 * Alert engine (§25): evaluates alert rules against fresh search results and
 * dispatches through channel adapters, recording every delivery (§12).
 *
 * Smart-alert semantics on top of the base rules:
 *  - per-rule flight filters (max stops / airlines / departure window / cabin)
 *  - cooldown: a rule stays silent for N minutes after it last fired
 *  - quiet hours: alerts are held back inside a configured UTC hour window
 */
import type { AlertRule, ScoredFlight } from '../core/types.js';
import { getDatabase, type FlightDatabase } from '../db/database.js';
import { defaultChannels, type AlertChannel, type AlertMessage } from './channels.js';

export interface TriggeredAlert {
  rule: AlertRule;
  flight: ScoredFlight;
  reason: string;
}

function depHour(f: ScoredFlight): number | null {
  const m = String(f.departureTime).match(/T(\d{2})/);
  return m ? Number(m[1]) : null;
}

/** Does this flight pass the rule's flight-type filters? */
export function matchesFilters(rule: AlertRule, f: ScoredFlight): boolean {
  const flt = rule.filters;
  if (!flt) return true;
  if (flt.maxStops !== undefined && f.stops > flt.maxStops) return false;
  if (flt.airlines?.length && !flt.airlines.includes(f.airline)) return false;
  if (flt.cabin && f.cabin !== flt.cabin) return false;
  if (flt.depHours) {
    const h = depHour(f);
    if (h !== null) {
      const [from, to] = flt.depHours;
      if (h < from || h >= to) return false;
    }
  }
  return true;
}

/** Is the rule allowed to fire right now (cooldown + quiet hours)? */
export function canFireNow(rule: AlertRule, now: Date = new Date()): boolean {
  if (rule.quietHours) {
    const [from, to] = rule.quietHours;
    const h = now.getUTCHours();
    const inQuiet = from <= to ? h >= from && h < to : h >= from || h < to; // window may wrap midnight
    if (inQuiet) return false;
  }
  if (rule.cooldownMinutes && rule.lastTriggeredAt) {
    const last = Date.parse(
      rule.lastTriggeredAt.includes('T') ? rule.lastTriggeredAt : rule.lastTriggeredAt + 'Z'
    );
    if (Number.isFinite(last) && now.getTime() - last < rule.cooldownMinutes * 60000) return false;
  }
  return true;
}

export function evaluateRules(
  rules: AlertRule[],
  flights: ScoredFlight[],
  previousLow: number | null,
  now: Date = new Date()
): TriggeredAlert[] {
  const triggered: TriggeredAlert[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    if (!canFireNow(rule, now)) continue;
    const eligible = flights.filter((f) => matchesFilters(rule, f));
    const best = [...eligible].sort((a, b) => a.normalizedPrice - b.normalizedPrice)[0];
    if (!best) continue;

    switch (rule.kind) {
      case 'PRICE_BELOW':
        if (best.normalizedPrice < rule.threshold) {
          triggered.push({
            rule,
            flight: best,
            reason: `price ${best.normalizedPrice} ${best.normalizedCurrency} dropped below ${rule.threshold}`,
          });
        }
        break;
      case 'DROP_PERCENT':
        if (previousLow && previousLow > 0) {
          const drop = (previousLow - best.normalizedPrice) / previousLow;
          if (drop >= rule.threshold / 100) {
            triggered.push({
              rule,
              flight: best,
              reason: `price dropped ${Math.round(drop * 100)}% (from ${previousLow} to ${best.normalizedPrice})`,
            });
          }
        }
        break;
      case 'DEAL_SCORE_ABOVE': {
        const bestScored = [...eligible].sort((a, b) => b.analysis.dealScore - a.analysis.dealScore)[0]!;
        if (bestScored.analysis.dealScore > rule.threshold) {
          triggered.push({
            rule,
            flight: bestScored,
            reason: `deal score ${bestScored.analysis.dealScore} above ${rule.threshold}`,
          });
        }
        break;
      }
    }
  }
  return triggered;
}

const SYM: Record<string, string> = { ILS: '₪', EUR: '€', USD: '$', GBP: '£' };
const money = (n: number, c: string) => `${SYM[c] ?? c + ' '}${Math.round(n).toLocaleString('en')}`;

/**
 * Hebrew, Telegram-friendly alert text with the numbers that matter up front.
 * Plain professional copy — no emojis anywhere in outbound notifications.
 */
export function formatAlertMessage(t: TriggeredAlert): AlertMessage {
  const f = t.flight;
  const price = money(f.normalizedPrice, f.normalizedCurrency);
  const stopsTxt = f.stops === 0 ? 'טיסה ישירה' : `${f.stops} עצירות`;
  const dates = `${f.departureDate}${f.returnDate ? ` → ${f.returnDate}` : ''}`;
  const vsAvg = f.analysis.vsAverage != null && f.analysis.vsAverage < 0
    ? `${Math.round(Math.abs(f.analysis.vsAverage) * 100)}% מתחת לממוצע ההיסטורי`
    : null;
  const headline =
    t.rule.kind === 'PRICE_BELOW'
      ? 'המחיר ירד מתחת ליעד שהגדרת'
      : t.rule.kind === 'DROP_PERCENT'
        ? 'ירידת מחיר במסלול במעקב'
        : 'נמצאה עסקה חזקה במסלול במעקב';
  return {
    title: `${headline}: ${f.origin} → ${f.destination} · ${price}`,
    body: [
      t.rule.label ? `יעד ההתראה: ${t.rule.label}` : null,
      `${dates} · ${f.airlineName ?? f.airline} · ${stopsTxt}`,
      `מחיר: ${price} · ציון עסקה ${f.analysis.dealScore}/100`,
      vsAvg,
      ...f.analysis.explanation.slice(0, 3).map((e) => `- ${e}`),
      ...(f.analysis.disclaimer ? [`לתשומת לב: ${f.analysis.disclaimer}`] : []),
    ]
      .filter(Boolean)
      .join('\n'),
    url: f.bookingUrl,
  };
}

export class AlertEngine {
  private channels: Map<string, AlertChannel>;

  constructor(
    channels: AlertChannel[] = defaultChannels(),
    private db: FlightDatabase = getDatabase()
  ) {
    this.channels = new Map(channels.map((c) => [c.name, c]));
  }

  /** Send one message through the given channels, recording every delivery. */
  async sendCustom(alertId: number, channelNames: string[], msg: AlertMessage): Promise<boolean> {
    let delivered = false;
    for (const channelName of channelNames) {
      const channel = this.channels.get(channelName);
      if (!channel) {
        this.db.recordAlertDelivery(alertId, channelName, 'error', 'unknown channel');
        continue;
      }
      if (!channel.enabled()) {
        this.db.recordAlertDelivery(alertId, channelName, 'skipped', 'channel not configured');
        continue;
      }
      try {
        await channel.send(msg);
        this.db.recordAlertDelivery(alertId, channelName, 'ok', msg.title);
        delivered = true;
      } catch (err) {
        this.db.recordAlertDelivery(
          alertId, channelName, 'error',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return delivered;
  }

  async dispatch(triggered: TriggeredAlert[]): Promise<void> {
    for (const t of triggered) {
      const delivered = await this.sendCustom(t.rule.id, t.rule.channels, formatAlertMessage(t));
      // start the cooldown only once something actually went out
      if (delivered) this.db.markAlertTriggered(t.rule.id);
    }
  }
}
