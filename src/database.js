import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { compareItems } from './compare-items.js';
import { DatabaseError } from './errors.js';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        baseline_established_at TEXT
      );

      CREATE TABLE IF NOT EXISTS products (
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        asin TEXT NOT NULL,
        title TEXT,
        url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        PRIMARY KEY (list_id, asin)
      );

      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        item_count INTEGER,
        new_item_count INTEGER,
        error_category TEXT,
        error_message TEXT,
        diagnostics_path TEXT
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_products_list_active
        ON products(list_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_messages_retry
        ON outbound_messages(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_scans_list_completed
        ON scans(list_id, completed_at DESC);
    `
  }
];

function nowIso(clock) {
  return clock().toISOString();
}

function messageDedupeKey(listId, items) {
  const identity = `${listId}:${items.map((item) => item.asin).sort().join(',')}`;
  return createHash('sha256').update(identity).digest('hex');
}

export class WishlistDatabase {
  constructor(path, { clock = () => new Date() } = {}) {
    this.path = path;
    this.clock = clock;
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (error) {
      throw new DatabaseError(`Could not open database ${path}: ${error.message}`, { cause: error });
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, nowIso(this.clock));
      });
    }
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  upsertList(list, timestamp = nowIso(this.clock)) {
    this.db.prepare(`
      INSERT INTO lists(id, name, url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        updated_at = excluded.updated_at
    `).run(list.id, list.name, list.url, timestamp, timestamp);
  }

  getListState(listId) {
    try {
      const list = this.db.prepare('SELECT * FROM lists WHERE id = ?').get(listId) || null;
      const activeItems = this.db.prepare(`
        SELECT asin, title, url FROM products
        WHERE list_id = ? AND is_active = 1 ORDER BY asin
      `).all(listId);
      const historicalItems = this.db.prepare(`
        SELECT asin, title, url, is_active FROM products
        WHERE list_id = ? ORDER BY asin
      `).all(listId);
      return { list, activeItems, historicalItems };
    } catch (error) {
      throw new DatabaseError(`Could not read state for list ${listId}: ${error.message}`, { cause: error });
    }
  }

  persistSuccessfulScan({ list, items, startedAt, buildMessage }) {
    try {
      return this.transaction(() => {
        const completedAt = nowIso(this.clock);
        this.upsertList(list, completedAt);
        const state = this.getListState(list.id);
        const isBaseline = !state.list?.baseline_established_at;
        const comparison = compareItems({
          currentItems: items,
          activeItems: state.activeItems,
          historicalItems: state.historicalItems
        });

        const scanResult = this.db.prepare(`
          INSERT INTO scans(
            list_id, started_at, completed_at, status, item_count, new_item_count
          ) VALUES (?, ?, ?, 'success', ?, ?)
        `).run(
          list.id,
          startedAt,
          completedAt,
          comparison.currentItems.length,
          isBaseline ? 0 : comparison.newItems.length
        );
        const scanId = Number(scanResult.lastInsertRowid);

        this.db.prepare('UPDATE products SET is_active = 0 WHERE list_id = ?').run(list.id);
        const upsertProduct = this.db.prepare(`
          INSERT INTO products(
            list_id, asin, title, url, first_seen_at, last_seen_at, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(list_id, asin) DO UPDATE SET
            title = COALESCE(excluded.title, products.title),
            url = COALESCE(excluded.url, products.url),
            last_seen_at = excluded.last_seen_at,
            is_active = 1
        `);
        for (const item of comparison.currentItems) {
          upsertProduct.run(
            list.id, item.asin, item.title, item.url, completedAt, completedAt
          );
        }

        if (isBaseline) {
          this.db.prepare('UPDATE lists SET baseline_established_at = ? WHERE id = ?')
            .run(completedAt, list.id);
        }

        let outboundMessage = null;
        if (!isBaseline && comparison.newItems.length > 0) {
          const message = buildMessage(list.name, comparison.newItems);
          const dedupeKey = messageDedupeKey(list.id, comparison.newItems);
          const inserted = this.db.prepare(`
            INSERT INTO outbound_messages(
              list_id, scan_id, dedupe_key, message, created_at, status, next_attempt_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(dedupe_key) DO NOTHING
          `).run(list.id, scanId, dedupeKey, message, completedAt, completedAt);
          if (inserted.changes > 0) {
            outboundMessage = this.db.prepare('SELECT * FROM outbound_messages WHERE id = ?')
              .get(Number(inserted.lastInsertRowid));
          }
        }

        return {
          scanId,
          isBaseline,
          comparison,
          outboundMessage
        };
      });
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError(`Could not save successful scan for ${list.id}: ${error.message}`, { cause: error });
    }
  }

  recordFailedScan({ list, startedAt, errorCategory, errorMessage, diagnosticsPath = null }) {
    try {
      const completedAt = nowIso(this.clock);
      this.upsertList(list, completedAt);
      const result = this.db.prepare(`
        INSERT INTO scans(
          list_id, started_at, completed_at, status, error_category, error_message, diagnostics_path
        ) VALUES (?, ?, ?, 'failed', ?, ?, ?)
      `).run(list.id, startedAt, completedAt, errorCategory, errorMessage, diagnosticsPath);
      return Number(result.lastInsertRowid);
    } catch (error) {
      throw new DatabaseError(`Could not record failed scan for ${list.id}: ${error.message}`, { cause: error });
    }
  }

  getMessage(id) {
    return this.db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(id) || null;
  }

  getRetryableMessages({ includeFailed = false, ignoreSchedule = false } = {}) {
    const statuses = includeFailed ? "('pending', 'failed')" : "('pending')";
    const dueClause = ignoreSchedule ? '' : 'AND (next_attempt_at IS NULL OR next_attempt_at <= ?)';
    const sql = `
      SELECT * FROM outbound_messages
      WHERE status IN ${statuses} ${dueClause}
      ORDER BY created_at, id
    `;
    return ignoreSchedule
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(nowIso(this.clock));
  }

  markMessageSent(id) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      UPDATE outbound_messages SET
        status = 'sent', sent_at = ?, attempt_count = attempt_count + 1,
        last_attempt_at = ?, next_attempt_at = NULL, last_error = NULL
      WHERE id = ? AND status != 'sent'
    `).run(timestamp, timestamp, id);
    return this.getMessage(id);
  }

  markMessageFailure(id, errorMessage, { maxAttempts, baseDelayMs }) {
    const message = this.getMessage(id);
    if (!message || message.status === 'sent') return message;
    const timestamp = this.clock();
    const attemptCount = message.attempt_count + 1;
    const status = attemptCount >= maxAttempts ? 'failed' : 'pending';
    const delay = baseDelayMs * (2 ** Math.max(0, attemptCount - 1));
    const nextAttemptAt = status === 'pending'
      ? new Date(timestamp.getTime() + delay).toISOString()
      : null;
    this.db.prepare(`
      UPDATE outbound_messages SET
        status = ?, attempt_count = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ?
      WHERE id = ? AND status != 'sent'
    `).run(status, attemptCount, timestamp.toISOString(), nextAttemptAt, errorMessage, id);
    return this.getMessage(id);
  }

  resetHistory({ listId = null } = {}) {
    try {
      return this.transaction(() => {
        const condition = listId ? ' WHERE list_id = ?' : '';
        const listCondition = listId ? ' WHERE id = ?' : '';
        const parameters = listId ? [listId] : [];
        const counts = {
          lists: this.db.prepare(`SELECT COUNT(*) AS count FROM lists${listCondition}`).get(...parameters).count,
          products: this.db.prepare(`SELECT COUNT(*) AS count FROM products${condition}`).get(...parameters).count,
          scans: this.db.prepare(`SELECT COUNT(*) AS count FROM scans${condition}`).get(...parameters).count,
          messages: this.db.prepare(`SELECT COUNT(*) AS count FROM outbound_messages${condition}`).get(...parameters).count
        };
        this.db.prepare(`DELETE FROM lists${listCondition}`).run(...parameters);
        return { scope: listId || 'all', ...counts };
      });
    } catch (error) {
      throw new DatabaseError(`Could not reset history${listId ? ` for ${listId}` : ''}: ${error.message}`, { cause: error });
    }
  }

  getStatus() {
    const lists = this.db.prepare(`
      SELECT
        l.id, l.name, l.url, l.baseline_established_at,
        SUM(CASE WHEN p.is_active = 1 THEN 1 ELSE 0 END) AS active_items,
        COUNT(p.asin) AS historical_items,
        (SELECT status FROM scans s WHERE s.list_id = l.id ORDER BY s.id DESC LIMIT 1) AS last_scan_status,
        (SELECT completed_at FROM scans s WHERE s.list_id = l.id ORDER BY s.id DESC LIMIT 1) AS last_scan_at
      FROM lists l
      LEFT JOIN products p ON p.list_id = l.id
      GROUP BY l.id
      ORDER BY l.name
    `).all();
    const messages = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM outbound_messages GROUP BY status ORDER BY status
    `).all();
    const outstanding = this.db.prepare(`
      SELECT id, list_id, message, created_at, status, attempt_count,
             last_attempt_at, next_attempt_at, last_error
      FROM outbound_messages
      WHERE status != 'sent'
      ORDER BY created_at
    `).all();
    return { lists, messages, outstanding };
  }
}

export { messageDedupeKey };
