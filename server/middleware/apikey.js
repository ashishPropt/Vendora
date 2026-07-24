import { createHash } from 'crypto';
import { pool } from '../db.js';

export async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!key) return res.status(401).json({ error: 'API key required. Pass via: Authorization: Bearer <key>' });

  const hash = createHash('sha256').update(key).digest('hex');
  const client = await pool.connect();
  try {
    // ── 1. Check developer_api_keys (keys created in the developer portal) ──
    const { rows: devRows } = await client.query(
      `SELECT key_id, dev_id AS user_id, is_active FROM developer_api_keys WHERE key_hash = $1`,
      [hash]
    );
    if (devRows.length) {
      if (!devRows[0].is_active) {
        return res.status(401).json({ error: 'Invalid or revoked API key' });
      }
      client.query(
        `UPDATE developer_api_keys SET request_count = request_count + 1, last_used_at = NOW() WHERE key_id = $1`,
        [devRows[0].key_id]
      ).catch(() => {});
      req.apiKey = devRows[0];
      return next();
    }

    // ── 2. Fall back to legacy api_keys table ─────────────────────────────
    const { rows } = await client.query(
      `SELECT key_id, user_id, is_active FROM api_keys WHERE key_hash = $1`,
      [hash]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }
    client.query(
      `UPDATE api_keys SET request_count = request_count + 1, last_used_at = NOW() WHERE key_id = $1`,
      [rows[0].key_id]
    ).catch(() => {});
    req.apiKey = rows[0];
    next();
  } finally {
    client.release();
  }
}
