/**
 * Alert channel adapters (§26): each channel is an isolated adapter.
 * Console + Webhook + Telegram ship enabled; Email/WhatsApp/Push slots exist
 * behind the same interface.
 */

export interface AlertMessage {
  title: string;
  body: string;
  url?: string;
}

export interface AlertChannel {
  readonly name: string;
  enabled(): boolean;
  send(msg: AlertMessage): Promise<void>;
}

export class ConsoleChannel implements AlertChannel {
  readonly name = 'console';
  enabled(): boolean {
    return true;
  }
  async send(msg: AlertMessage): Promise<void> {
    console.log(`\nALERT: ${msg.title}\n${msg.body}${msg.url ? `\n${msg.url}` : ''}`);
  }
}

export class WebhookChannel implements AlertChannel {
  readonly name = 'webhook';
  constructor(private url: string | undefined = process.env.ALERT_WEBHOOK_URL) {}
  enabled(): boolean {
    return Boolean(this.url);
  }
  async send(msg: AlertMessage): Promise<void> {
    if (!this.url) throw new Error('ALERT_WEBHOOK_URL not configured');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}

export class TelegramChannel implements AlertChannel {
  readonly name = 'telegram';
  constructor(
    private token: string | undefined = process.env.TELEGRAM_BOT_TOKEN,
    private chatId: string | undefined = process.env.TELEGRAM_CHAT_ID
  ) {}
  enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }
  async send(msg: AlertMessage): Promise<void> {
    if (!this.token || !this.chatId) throw new Error('Telegram not configured');
    const text = `*${msg.title}*\n${msg.body}${msg.url ? `\n[Book / view](${msg.url})` : ''}`;
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`telegram responded ${res.status}`);
  }
}

export function defaultChannels(): AlertChannel[] {
  return [new ConsoleChannel(), new WebhookChannel(), new TelegramChannel()];
}
