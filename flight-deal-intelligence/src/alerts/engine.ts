/**
 * Alert engine (§25): evaluates alert rules against fresh search results and
 * dispatches through channel adapters, recording every delivery (§12).
 */
import type { AlertRule, ScoredFlight } from '../core/types.js';
import { getDatabase, type FlightDatabase } from '../db/database.js';
import { defaultChannels, type AlertChannel, type AlertMessage } from './channels.js';

export interface TriggeredAlert {
  rule: AlertRule;
  flight: ScoredFlight;
  reason: string;
}

export function evaluateRules(
  rules: AlertRule[],
  flights: ScoredFlight[],
  previousLow: number | null
): TriggeredAlert[] {
  const triggered: TriggeredAlert[] = [];
  const best = [...flights].sort((a, b) => a.normalizedPrice - b.normalizedPrice)[0];
  if (!best) return triggered;

  for (const rule of rules) {
    if (!rule.active) continue;
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
        const bestScored = [...flights].sort((a, b) => b.analysis.dealScore - a.analysis.dealScore)[0]!;
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

export class AlertEngine {
  private channels: Map<string, AlertChannel>;

  constructor(
    channels: AlertChannel[] = defaultChannels(),
    private db: FlightDatabase = getDatabase()
  ) {
    this.channels = new Map(channels.map((c) => [c.name, c]));
  }

  async dispatch(triggered: TriggeredAlert[]): Promise<void> {
    for (const t of triggered) {
      const f = t.flight;
      const msg: AlertMessage = {
        title: `✈️ ${f.origin} → ${f.destination}: ${f.normalizedPrice} ${f.normalizedCurrency} (Deal Score ${f.analysis.dealScore})`,
        body: [
          `${f.departureDate}${f.returnDate ? ` – ${f.returnDate}` : ''}, ${f.airlineName ?? f.airline}, ${f.stops === 0 ? 'direct' : `${f.stops} stop(s)`}`,
          `Triggered: ${t.reason}`,
          ...f.analysis.explanation.map((e) => `• ${e}`),
          ...(f.analysis.disclaimer ? [f.analysis.disclaimer] : []),
        ].join('\n'),
        url: f.bookingUrl,
      };
      for (const channelName of t.rule.channels) {
        const channel = this.channels.get(channelName);
        if (!channel) {
          this.db.recordAlertDelivery(t.rule.id, channelName, 'error', 'unknown channel');
          continue;
        }
        if (!channel.enabled()) {
          this.db.recordAlertDelivery(t.rule.id, channelName, 'skipped', 'channel not configured');
          continue;
        }
        try {
          await channel.send(msg);
          this.db.recordAlertDelivery(t.rule.id, channelName, 'ok', msg.title);
        } catch (err) {
          this.db.recordAlertDelivery(
            t.rule.id, channelName, 'error',
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }
  }
}
