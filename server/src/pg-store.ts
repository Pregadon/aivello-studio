import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { LedgerState } from '../../core/src/index.ts';
import type { Commit, Store, StoredEmbassy } from './store.ts';

export class PgStore implements Store {
  pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async migrate(): Promise<void> {
    const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    await this.pool.query(sql);
    // Підписи людини діють 10 хвилин, тож старіші записи про них уже нічого не захищають.
    await this.pool.query(`DELETE FROM human_nonces WHERE seen_at < now() - interval '1 day'`);
  }

  async load() {
    const e = await this.pool.query<{ id: string; state: StoredEmbassy['state']; agent_key_enc: string }>(
      'SELECT id, state, agent_key_enc FROM embassies ORDER BY created_at',
    );
    const l = await this.pool.query<{ state: LedgerState }>('SELECT state FROM attention_ledger WHERE id = 1');
    return {
      embassies: e.rows.map((r) => ({ id: r.id, state: r.state, agentKeyEnc: r.agent_key_enc })),
      ledger: l.rows[0]?.state,
    };
  }

  async hasNonce(sigHash: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM human_nonces WHERE sig_hash = $1', [sigHash]);
    return r.rowCount! > 0;
  }

  async hasStripeEvent(id: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM stripe_events WHERE id = $1', [id]);
    return r.rowCount! > 0;
  }

  async commit(c: Commit): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Унікальні ключі в nonces і stripe_events не дадуть двом процесам прийняти одне й те саме.
      if (c.nonce) {
        await db.query('INSERT INTO human_nonces (sig_hash, embassy, op) VALUES ($1, $2, $3)', [c.nonce.sigHash, c.nonce.embassy, c.nonce.op]);
      }
      if (c.stripeEvent) {
        await db.query('INSERT INTO stripe_events (id, type, outcome) VALUES ($1, $2, $3)', [c.stripeEvent.id, c.stripeEvent.type, c.stripeEvent.outcome]);
      }
      for (const e of c.embassies) {
        await db.query(
          `INSERT INTO embassies (id, state, agent_key_enc) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [e.id, JSON.stringify(e.state), e.agentKeyEnc],
        );
      }
      await db.query(
        `INSERT INTO attention_ledger (id, state) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state`,
        [JSON.stringify(c.ledger)],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
