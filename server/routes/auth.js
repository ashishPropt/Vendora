import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { requireJwt } from '../middleware/auth.js';
const JWT_SECRET = process.env.JWT_SECRET || 'vendora-jwt-prod-2026-leaseloft';

const router = Router();

// POST /auth/signup  (developer/API user accounts)
router.post('/signup', async (req, res) => {
  const { email, password, full_name, company } = req.body;
  if (!email || !password || !full_name)
    return res.status(400).json({ error: 'email, password and full_name are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, full_name, company)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, email, full_name, company, plan, created_at`,
      [email.toLowerCase().trim(), hash, full_name.trim(), company?.trim() || null]
    );
    const user = rows[0];
    const token = jwt.sign({ userId: user.user_id, email: user.email }, JWT_SECRET, { expiresIn: '8h' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw err;
  } finally {
    client.release();
  }
});

// POST /auth/login -- unified login for admin users AND vendor portal users
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const lc = email.toLowerCase().trim();

    const client = await pool.connect();
    try {
      // 1. Check admin_users first
      const adminResult = await client.query(
        'SELECT user_id, email, password_hash, full_name, role, is_active FROM admin_users WHERE email = $1',
        [lc]
      );
      if (adminResult.rows.length) {
        const u = adminResult.rows[0];
        if (!u.is_active) return res.status(401).json({ error: 'Account disabled' });
        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
        const token = jwt.sign(
          { role: 'admin', userId: u.user_id, email: u.email, full_name: u.full_name },
          JWT_SECRET, { expiresIn: '8h' }
        );
        const { password_hash, ...safe } = u;
        return res.json({ token, role: 'admin', user: safe });
      }

      // 2. Check vendor_portal_users
      const vendorResult = await client.query(
        `SELECT u.user_id, u.vendor_id, u.email, u.first_name, u.last_name,
                u.password_hash, u.is_active, v.canonical_name
         FROM vendor_portal_users u
         JOIN vendors v ON v.vendor_id = u.vendor_id
         WHERE u.email = $1`,
        [lc]
      );
      if (vendorResult.rows.length) {
        const u = vendorResult.rows[0];
        if (!u.is_active) return res.status(401).json({ error: 'Account disabled' });
        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
        await client.query(
          'UPDATE vendor_portal_users SET last_login_at = NOW() WHERE user_id = $1', [u.user_id]
        );
        const token = jwt.sign(
          { role: 'vendor', vendorUserId: u.user_id, vendorId: u.vendor_id, email: u.email },
          JWT_SECRET, { expiresIn: '30d' }
        );
        const { password_hash, ...safe } = u;
        return res.json({ token, role: 'vendor', user: safe });
      }

      // 3. Check developer_accounts
      const devResult = await client.query(
        'SELECT dev_id, email, password_hash, full_name, is_active FROM developer_accounts WHERE email = $1',
        [lc]
      );
      if (devResult.rows.length) {
        const u = devResult.rows[0];
        if (!u.is_active) return res.status(401).json({ error: 'Account disabled' });
        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
        const DEV_SECRET = process.env.DEV_JWT_SECRET || process.env.JWT_SECRET || 'vendora-dev-secret-2026';
        const token = jwt.sign(
          { dev_id: u.dev_id, email: u.email, full_name: u.full_name, type: 'developer', role: 'developer' },
          DEV_SECRET, { expiresIn: '7d' }
        );
        const { password_hash, ...safe } = u;
        return res.json({ token, role: 'developer', user: safe });
      }

      return res.status(401).json({ error: 'Invalid email or password' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me  (JWT required)
router.get('/me', requireJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT user_id, email, full_name, company, plan, created_at FROM users WHERE user_id = $1',
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } finally {
    client.release();
  }
});


// POST /auth/signup  (vendor self-registration)
router.post('/register', async (req, res) => {
  const { email, password, first_name, last_name } = req.body || {};
  if (!email || !password || !first_name) return res.status(400).json({ error: 'email, password, and first_name required' });
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT user_id FROM vendor_portal_users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const vName = (first_name.trim() + ' ' + (last_name || '').trim()).trim();
    const { randomUUID } = await import('crypto');
    const newVendorId = randomUUID();
    const slug = (vName + '-' + newVendorId.slice(0,8)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
    const vRes = await client.query(
      `INSERT INTO vendors
         (vendor_id, slug, canonical_name, email, primary_category_code,
          is_active, is_claimed, is_licensed, is_insured, is_background_checked,
          is_onboarded, created_at, updated_at)
       VALUES ($1, $2, $3, $4,
               (SELECT category_code FROM category_taxonomy LIMIT 1),
               true, false, false, false, false, true, NOW(), NOW())
       RETURNING vendor_id`,
      [newVendorId, slug, vName, email.toLowerCase()]
    );
    const vendor_id = vRes.rows[0].vendor_id;
    const { rows } = await client.query(
      `INSERT INTO vendor_portal_users (email, password_hash, first_name, last_name, is_active, vendor_id)
       VALUES ($1, $2, $3, $4, true, $5) RETURNING user_id, email, first_name, last_name`,
      [email.toLowerCase(), hash, first_name.trim(), (last_name || '').trim(), vendor_id]
    );
    const user = rows[0];
    const token = jwt.sign({ vendorUserId: user.user_id, vendorId: vendor_id, email: user.email, role: 'vendor', first_name: user.first_name }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, role: 'vendor', user });
  } catch(err) {
    console.error('[register] error:', err.message, err.code);
    return res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

export default router;
