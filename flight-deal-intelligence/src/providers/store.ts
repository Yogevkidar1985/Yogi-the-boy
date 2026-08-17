/**
 * Database-backed provider store: lets many search engines be added, edited
 * and switched on from the admin screen without redeploying.
 *
 * Secrets are encrypted at rest with AES-256-GCM using a key derived from
 * ADMIN_SECRET. Without ADMIN_SECRET the store refuses to persist API keys at
 * all rather than writing them in the clear — configure it, or keep using
 * environment variables.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { FlightDatabase } from '../db/database.js';
import type { ProviderCostTier } from './adapter.js';
import { GenericHttpAdapter, type GenericProviderSpec } from './generic.js';

export interface StoredProvider {
  id: number;
  name: string;
  enabled: boolean;
  urlTemplate: string;
  /** decrypted only when the caller explicitly asks (never in list output) */
  apiKey?: string;
  hasKey: boolean;
  headers: Record<string, string>;
  itemsPath?: string;
  map: Record<string, string>;
  tier: ProviderCostTier;
  timeoutMs: number;
  requestsPerMinute: number;
  concurrency: number;
  note?: string;
  createdAt: string;
}

export class ProviderStoreError extends Error {}

function secretKey(): Buffer | null {
  const s = process.env.ADMIN_SECRET;
  if (!s || s.length < 8) return null;
  // deterministic key from the configured secret; salt is fixed so existing
  // rows stay readable across restarts
  return scryptSync(s, 'fdi-provider-store', 32);
}

export function encryptSecret(plain: string): string {
  const key = secretKey();
  if (!key) throw new ProviderStoreError('ADMIN_SECRET is not configured — cannot store API keys securely');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string | null {
  const key = secretKey();
  if (!key) return null;
  try {
    const [ivB, tagB, dataB] = payload.split('.');
    if (!ivB || !tagB || !dataB) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong or rotated ADMIN_SECRET
  }
}

/** Show only enough of a key to recognise it. */
export function maskKey(key: string | undefined): string {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  url_template TEXT NOT NULL,
  api_key_enc TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  items_path TEXT,
  map_json TEXT NOT NULL DEFAULT '{}',
  tier TEXT NOT NULL DEFAULT 'PAID',
  timeout_ms INTEGER NOT NULL DEFAULT 20000,
  requests_per_minute INTEGER NOT NULL DEFAULT 30,
  concurrency INTEGER NOT NULL DEFAULT 4,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface ProviderInput {
  name: string;
  urlTemplate: string;
  apiKey?: string;
  headers?: Record<string, string>;
  itemsPath?: string;
  map?: Record<string, string>;
  tier?: ProviderCostTier;
  timeoutMs?: number;
  requestsPerMinute?: number;
  concurrency?: number;
  note?: string;
  enabled?: boolean;
}

export class ProviderStore {
  constructor(private db: FlightDatabase) {
    this.db.db.exec(SCHEMA);
  }

  private row2provider(r: Record<string, unknown>, withKey = false): StoredProvider {
    const enc = (r.api_key_enc as string) ?? '';
    return {
      id: r.id as number,
      name: r.name as string,
      enabled: !!r.enabled,
      urlTemplate: r.url_template as string,
      hasKey: Boolean(enc),
      apiKey: withKey && enc ? decryptSecret(enc) ?? undefined : undefined,
      headers: JSON.parse((r.headers_json as string) || '{}'),
      itemsPath: (r.items_path as string) ?? undefined,
      map: JSON.parse((r.map_json as string) || '{}'),
      tier: (r.tier as ProviderCostTier) ?? 'PAID',
      timeoutMs: r.timeout_ms as number,
      requestsPerMinute: r.requests_per_minute as number,
      concurrency: r.concurrency as number,
      note: (r.note as string) ?? undefined,
      createdAt: r.created_at as string,
    };
  }

  list(): StoredProvider[] {
    const rows = this.db.db.prepare(`SELECT * FROM custom_providers ORDER BY id`).all() as Record<string, unknown>[];
    return rows.map((r) => this.row2provider(r));
  }

  get(id: number, withKey = false): StoredProvider | undefined {
    const row = this.db.db.prepare(`SELECT * FROM custom_providers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.row2provider(row, withKey) : undefined;
  }

  create(input: ProviderInput): number {
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/i.test(input.name)) {
      throw new ProviderStoreError('name must be 2-31 chars: letters, digits, dot, dash, underscore');
    }
    if (!/^https:\/\//i.test(input.urlTemplate)) {
      throw new ProviderStoreError('url must start with https://');
    }
    const info = this.db.db
      .prepare(
        `INSERT INTO custom_providers
         (name, enabled, url_template, api_key_enc, headers_json, items_path, map_json, tier, timeout_ms, requests_per_minute, concurrency, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.name, input.enabled === false ? 0 : 1, input.urlTemplate,
        input.apiKey ? encryptSecret(input.apiKey) : null,
        JSON.stringify(input.headers ?? {}), input.itemsPath ?? null,
        JSON.stringify(input.map ?? {}), input.tier ?? 'PAID',
        input.timeoutMs ?? 20000, input.requestsPerMinute ?? 30, input.concurrency ?? 4,
        input.note ?? null
      );
    return Number(info.lastInsertRowid);
  }

  update(id: number, patch: Partial<ProviderInput>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.urlTemplate !== undefined) {
      if (!/^https:\/\//i.test(patch.urlTemplate)) throw new ProviderStoreError('url must start with https://');
      put('url_template', patch.urlTemplate);
    }
    if (patch.apiKey !== undefined) put('api_key_enc', patch.apiKey ? encryptSecret(patch.apiKey) : null);
    if (patch.headers !== undefined) put('headers_json', JSON.stringify(patch.headers));
    if (patch.itemsPath !== undefined) put('items_path', patch.itemsPath || null);
    if (patch.map !== undefined) put('map_json', JSON.stringify(patch.map));
    if (patch.tier !== undefined) put('tier', patch.tier);
    if (patch.timeoutMs !== undefined) put('timeout_ms', patch.timeoutMs);
    if (patch.requestsPerMinute !== undefined) put('requests_per_minute', patch.requestsPerMinute);
    if (patch.concurrency !== undefined) put('concurrency', patch.concurrency);
    if (patch.note !== undefined) put('note', patch.note);
    if (patch.enabled !== undefined) put('enabled', patch.enabled ? 1 : 0);
    if (!sets.length) return;
    this.db.db.prepare(`UPDATE custom_providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  remove(id: number): void {
    this.db.db.prepare(`DELETE FROM custom_providers WHERE id = ?`).run(id);
  }

  /** Build adapters for every enabled row that has a usable configuration. */
  adapters(): GenericHttpAdapter[] {
    const out: GenericHttpAdapter[] = [];
    for (const row of this.db.db.prepare(`SELECT * FROM custom_providers WHERE enabled = 1`).all() as Record<string, unknown>[]) {
      const p = this.row2provider(row, true);
      // a provider whose key cannot be decrypted (rotated ADMIN_SECRET) is
      // skipped rather than called with a broken credential
      if (p.hasKey && !p.apiKey) continue;
      const spec: GenericProviderSpec = {
        slot: `db:${p.id}`,
        name: p.name,
        urlTemplate: p.urlTemplate,
        key: p.apiKey,
        headers: p.headers,
        itemsPath: p.itemsPath,
        map: p.map,
        timeoutMs: p.timeoutMs,
        costTier: p.tier,
      };
      out.push(new GenericHttpAdapter(spec));
    }
    return out;
  }
}
