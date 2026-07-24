import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { pool } from '../db.js';
import { requireJwt } from '../middleware/auth.js';

const router = Router();
router.use(requireJwt);

function generateKey() {
  const raw = randomBytes(30).toString('hex'); // 60 hex chars
  return `vnd_${raw}`;                          // 64 chars total
}

// GET /v1/api-keys — list my keys
router.get('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT key_id, key_name, key_prefix, is_active, request_count, last_used_at, created_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ keys: rows });
  } finally {
    client.release();
  }
});

// POST /v1/api-keys — create new key
router.post('/', async (req, res) => {
  const { key_name = 'Default Key' } = req.body;
  const key = generateKey();
  const hash = createHash('sha256').update(key).digest('hex');
  const prefix = key.slice(0, 12); // "vnd_" + 8 chars

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO api_keys (user_id, key_name, key_hash, key_prefix)
       VALUES ($1, $2, $3, $4)
       RETURNING key_id, key_name, key_prefix, is_active, request_count, created_at`,
      [req.user.userId, key_name.trim().slice(0, 60), hash, prefix]
    );
    // Return the full key ONCE — we never store it plain
    res.status(201).json({ ...rows[0], key });
  } finally {
    client.release();
  }
});

// PATCH /v1/api-keys/:id — rename
router.patch('/:id', async (req, res) => {
  const { key_name } = req.body;
  if (!key_name) return res.status(400).json({ error: 'key_name required' });
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE api_keys SET key_name = $1
       WHERE key_id = $2 AND user_id = $3`,
      [key_name.trim().slice(0, 60), req.params.id, req.user.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true });
  } finally {
    client.release();
  }
});

// DELETE /v1/api-keys/:id — revoke
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `UPDATE api_keys SET is_active = false
       WHERE key_id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true });
  } finally {
    client.release();
  }
});

export default router;
