// /opt/vendora/server/routes/developer.js
import { Router }              from 'express';
import { pool }                from '../db.js';
import bcrypt                  from 'bcryptjs';
import jwt                     from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';

const router = Router();

const DEV_SECRET = () =>
  process.env.DEV_JWT_SECRET || process.env.JWT_SECRET || 'vendora-dev-secret-2026';

// ── Middleware ────────────────────────────────────────────────────────────────
export function requireDevJwt(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, DEV_SECRET());
    if (payload.type !== 'developer') throw new Error('Wrong token type');
    req.dev = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── POST /dev/register ────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, full_name, company } = req.body;
  if (!email || !password || !full_name)
    return res.status(400).json({ error: 'email, password, and full_name are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const client = await pool.connect();
  try {
    const exists = await client.query(
      'SELECT dev_id FROM developer_accounts WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length)
      return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await client.query(
      `INSERT INTO developer_accounts (email, password_hash, full_name, company)
       VALUES ($1,$2,$3,$4) RETURNING dev_id, email, full_name, company, created_at`,
      [email.toLowerCase(), hash, full_name, company || null]);

    const dev   = rows[0];
    const token = jwt.sign(
      { dev_id: dev.dev_id, email: dev.email, full_name: dev.full_name, type: 'developer' },
      DEV_SECRET(), { expiresIn: '7d' });
    return res.status(201).json({ token, dev });
  } finally { client.release(); }
});

// ── POST /dev/login ───────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT * FROM developer_accounts WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const dev   = rows[0];
    const ok    = await bcrypt.compare(password, dev.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { dev_id: dev.dev_id, email: dev.email, full_name: dev.full_name, type: 'developer' },
      DEV_SECRET(), { expiresIn: '7d' });
    return res.json({ token, dev: { dev_id: dev.dev_id, email: dev.email, full_name: dev.full_name } });
  } finally { client.release(); }
});

// ── GET /dev/me ───────────────────────────────────────────────────────────────
router.get('/me', requireDevJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT dev_id, email, full_name, company, created_at FROM developer_accounts WHERE dev_id=$1',
      [req.dev.dev_id]);
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    return res.json({ dev: rows[0] });
  } finally { client.release(); }
});

// ── GET /dev/keys ─────────────────────────────────────────────────────────────
router.get('/keys', requireDevJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT key_id, key_prefix, label, created_at, last_used_at, request_count, is_active
       FROM developer_api_keys WHERE dev_id=$1 ORDER BY created_at DESC`,
      [req.dev.dev_id]);
    return res.json({ keys: rows });
  } finally { client.release(); }
});

// ── POST /dev/keys ────────────────────────────────────────────────────────────
router.post('/keys', requireDevJwt, async (req, res) => {
  const { label } = req.body;
  const client = await pool.connect();
  try {
    const { rows: cnt } = await client.query(
      'SELECT COUNT(*) FROM developer_api_keys WHERE dev_id=$1 AND is_active=true', [req.dev.dev_id]);
    if (parseInt(cnt[0].count) >= 5)
      return res.status(409).json({ error: 'Maximum of 5 active API keys per account' });

    const rawKey    = 'vnd_' + randomBytes(24).toString('hex');   // 52 chars
    const keyHash   = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12);                        // "vnd_XXXXXXXX"

    const { rows } = await client.query(
      `INSERT INTO developer_api_keys (dev_id, key_prefix, key_hash, label)
       VALUES ($1,$2,$3,$4) RETURNING key_id, key_prefix, label, created_at`,
      [req.dev.dev_id, keyPrefix, keyHash, label || 'My API Key']);

    return res.status(201).json({
      ...rows[0],
      key:     rawKey,
      message: 'Copy this key now — it will not be shown again.',
    });
  } finally { client.release(); }
});

// ── DELETE /dev/keys/:id ──────────────────────────────────────────────────────
router.delete('/keys/:id', requireDevJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE developer_api_keys SET is_active=false
       WHERE key_id=$1 AND dev_id=$2 AND is_active=true RETURNING key_id`,
      [req.params.id, req.dev.dev_id]);
    if (!rows.length) return res.status(404).json({ error: 'Key not found' });
    return res.json({ ok: true });
  } finally { client.release(); }
});

export default router;
