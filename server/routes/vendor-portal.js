/**
 * Vendor Portal routes  —  /vendor/*
 *
 * Public:
 *   POST /vendor/onboard          — vendor self-onboarding (creates account + sets is_onboarded)
 *   POST /vendor/login            — login, returns JWT
 *
 * Protected (Bearer <vendor_jwt>):
 *   GET  /vendor/profile          — get own profile
 *   PUT  /vendor/profile          — update profile fields
 *   GET  /vendor/bids             — list bid requests sent to this vendor
 *   PUT  /vendor/bids/:bid_id     — respond to a bid (quote / decline / question)
 *   GET  /vendor/bids/:bid_id/messages  — message thread for a bid
 *   POST /vendor/bids/:bid_id/messages  — send a message to landlord
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';

const router = Router();
export const VENDOR_JWT_SECRET = process.env.JWT_SECRET || 'vendora-jwt-prod-2026-leaseloft';

// ── Vendor JWT middleware ─────────────────────────────────────────────────────
function requireVendorJwt(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing vendor token' });
  try {
    const payload = jwt.verify(token, VENDOR_JWT_SECRET);
    if (!payload.vendorUserId) return res.status(401).json({ error: 'Not a vendor token' });
    req.vendorUser = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── GET /vendor/find  (public — no auth) ─────────────────────────────────────
// Search for a vendor listing by business name + optional zip/state
// Used by the onboarding page so vendors can find their own record
router.get('/find', async (req, res) => {
  const { name, zip, state } = req.query;
  if (!name || name.trim().length < 2)
    return res.status(400).json({ error: 'name is required (min 2 chars)' });

  const conditions = [`lower(v.canonical_name) ILIKE $1`];
  const params     = [`%${name.toLowerCase().trim()}%`];
  let pi = 2;

  if (zip)   { conditions.push(`v.zip = $${pi++}`);                 params.push(zip.trim()); }
  if (state) { conditions.push(`v.state = $${pi++}`);               params.push(state.toUpperCase().trim()); }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT v.vendor_id, v.canonical_name, v.primary_phone, v.website_url,
              v.street_address, v.city, v.state, v.zip,
              v.primary_category_code, ct.display_name AS category_name,
              v.is_onboarded, v.is_licensed, v.is_insured, v.years_in_business,
              v.email AS listing_email
       FROM vendors v
       LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
       WHERE ${conditions.join(' AND ')}
       ORDER BY v.is_onboarded ASC, v.vendor_score DESC NULLS LAST
       LIMIT 12`,
      params
    );
    res.json({ vendors: rows });
  } finally { client.release(); }
});

// ── POST /vendor/onboard ──────────────────────────────────────────────────────
// Vendor finds their listing (by vendor_id or email) and claims it.
router.post('/onboard', async (req, res) => {
  const {
    vendor_id,          // UUID of existing vendor record
    email,              // login email
    password,
    first_name,
    last_name,
    // Optional profile corrections
    canonical_name,
    primary_phone,
    website_url,
    street_address,
    city,
    state,
    zip,
    // Bank details (optional — stored if all core fields provided)
    bank_account_holder,
    bank_name,
    bank_account_type,
    bank_routing_number,
    bank_account_number,
    // Invite token — present when vendor arrives via invite link
    invite_token,
  } = req.body;

  if (!vendor_id || !email || !password)
    return res.status(400).json({ error: 'vendor_id, email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const client = await pool.connect();
  try {
    // Verify vendor exists
    const { rows: vr } = await client.query(
      `SELECT vendor_id, canonical_name, is_onboarded FROM vendors WHERE vendor_id = $1`,
      [vendor_id]
    );
    if (!vr.length)
      return res.status(404).json({ error: 'Vendor not found. Check your vendor_id.' });

    const hash = await bcrypt.hash(password, 12);

    // Create portal user account
    const { rows: ur } = await client.query(
      `INSERT INTO vendor_portal_users (vendor_id, email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, vendor_id, email, first_name, last_name, created_at`,
      [vendor_id, email.toLowerCase().trim(), hash, first_name?.trim() || null, last_name?.trim() || null]
    );

    // Apply any profile corrections the vendor provided
    const updates = [];
    const uparams = [];
    let up = 1;
    const maybeSet = (col, val) => {
      if (val !== undefined && val !== null && val !== '') {
        updates.push(`${col} = $${up++}`);
        uparams.push(typeof val === 'string' ? val.trim() : val);
      }
    };
    maybeSet('canonical_name',  canonical_name);
    maybeSet('primary_phone',   primary_phone);
    maybeSet('website_url',     website_url);
    maybeSet('street_address',  street_address);
    maybeSet('city',            city);
    maybeSet('state',           state);
    maybeSet('zip',             zip);
    maybeSet('onboarding_email', email.toLowerCase().trim());

    updates.push(`is_onboarded = true`, `updated_at = NOW()`);

    await client.query(
      `UPDATE vendors SET ${updates.join(', ')} WHERE vendor_id = $${up}`,
      [...uparams, vendor_id]
    );

    // Save bank details if provided
    if (bank_account_holder && bank_name && bank_routing_number && bank_account_number) {
      const last4 = String(bank_account_number).slice(-4);
      await client.query(
        `INSERT INTO vendor_bank_accounts
           (vendor_id, account_holder, bank_name, account_type, routing_number, account_last4)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vendor_id) DO UPDATE
           SET account_holder = EXCLUDED.account_holder,
               bank_name = EXCLUDED.bank_name,
               account_type = EXCLUDED.account_type,
               routing_number = EXCLUDED.routing_number,
               account_last4 = EXCLUDED.account_last4,
               updated_at = NOW()`,
        [vendor_id, bank_account_holder.trim(), bank_name.trim(),
         bank_account_type || 'checking',
         bank_routing_number.trim(), last4]
      );
    }

    // Mark the invite link as used (if one was provided)
    if (invite_token) {
      await client.query(
        `UPDATE vendor_invites SET used_at = NOW()
          WHERE token = $1 AND vendor_id = $2 AND used_at IS NULL`,
        [invite_token, vendor_id]
      );
    }

    const token = jwt.sign(
      { vendorUserId: ur[0].user_id, vendorId: vendor_id, email: ur[0].email },
      VENDOR_JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, user: ur[0], vendor_id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw err;
  } finally { client.release(); }
});

// ── POST /vendor/login ────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT u.user_id, u.vendor_id, u.email, u.first_name, u.last_name,
              u.password_hash, u.is_active
       FROM vendor_portal_users u WHERE u.email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    await client.query(
      `UPDATE vendor_portal_users SET last_login_at = NOW() WHERE user_id = $1`,
      [rows[0].user_id]
    );

    const token = jwt.sign(
      { vendorUserId: rows[0].user_id, vendorId: rows[0].vendor_id, email: rows[0].email },
      VENDOR_JWT_SECRET,
      { expiresIn: '30d' }
    );
    const { password_hash, ...safe } = rows[0];
    res.json({ token, user: safe });
  } finally { client.release(); }
});

// ── GET /vendor/profile ───────────────────────────────────────────────────────
router.get('/profile', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT v.*, u.email, u.first_name, u.last_name, u.created_at AS portal_created_at
       FROM vendors v
       JOIN vendor_portal_users u ON u.vendor_id = v.vendor_id
       WHERE u.user_id = $1`,
      [req.vendorUser.vendorUserId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
    res.json(rows[0]);
  } finally { client.release(); }
});

// ── PUT /vendor/profile ───────────────────────────────────────────────────────
router.put('/profile', requireVendorJwt, async (req, res) => {
  const allowed = [
    'canonical_name','primary_phone','secondary_phone','email','website_url',
    'street_address','city','state','zip','years_in_business',
    'employee_count_range','service_radius_miles',
  ];
  const client = await pool.connect();
  try {
    const updates = [];
    const vals = [];
    let pi = 1;
    for (const col of allowed) {
      if (req.body[col] !== undefined) {
        updates.push(`${col} = $${pi++}`);
        vals.push(req.body[col] === '' ? null : req.body[col]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    updates.push(`updated_at = NOW()`);
    await client.query(
      `UPDATE vendors SET ${updates.join(', ')} WHERE vendor_id = $${pi}`,
      [...vals, req.vendorUser.vendorId]
    );
    res.json({ success: true });
  } finally { client.release(); }
});

// ── GET /vendor/bids ──────────────────────────────────────────────────────────
router.get('/bids', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT br.*,
         (SELECT json_agg(json_build_object(
           'response_id', r.response_id, 'response_type', r.response_type,
           'message', r.message, 'quote_amount', r.quote_amount,
           'availability', r.availability, 'created_at', r.created_at
         ) ORDER BY r.created_at) FROM bid_responses r WHERE r.bid_id = br.bid_id) AS responses,
         (SELECT COUNT(*) FROM bid_messages m WHERE m.bid_id = br.bid_id AND m.sender_type = 'landlord' AND NOT m.is_read) AS unread_messages,
         (SELECT et.status FROM escrow_transactions et WHERE et.bid_id = br.bid_id LIMIT 1) AS escrow_status,
         br.agreed_amount, br.completed_at, br.landlord_rating, br.landlord_review
       FROM bid_requests br
       WHERE br.vendor_id = $1
       ORDER BY br.sent_at DESC`,
      [req.vendorUser.vendorId]
    );
    // Mark as viewed
    await client.query(
      `UPDATE bid_requests SET viewed_at = NOW(), status = CASE WHEN status='sent' THEN 'viewed' ELSE status END
       WHERE vendor_id = $1 AND viewed_at IS NULL`,
      [req.vendorUser.vendorId]
    );
    res.json({ bids: rows });
  } finally { client.release(); }
});

// ── PUT /vendor/bids/:bid_id  (respond / quote / decline) ────────────────────
router.put('/bids/:bid_id', requireVendorJwt, async (req, res) => {
  const { bid_id } = req.params;
  const { response_type, message, quote_amount, availability } = req.body;

  if (!response_type || !message)
    return res.status(400).json({ error: 'response_type and message required' });

  const validTypes = ['quote', 'question', 'decline'];
  if (!validTypes.includes(response_type))
    return res.status(400).json({ error: `response_type must be one of: ${validTypes.join(', ')}` });

  const client = await pool.connect();
  try {
    // Verify this bid belongs to this vendor
    const { rows: br } = await client.query(
      `SELECT bid_id FROM bid_requests WHERE bid_id = $1 AND vendor_id = $2`,
      [bid_id, req.vendorUser.vendorId]
    );
    if (!br.length) return res.status(404).json({ error: 'Bid not found' });

    // Insert response
    const { rows: rr } = await client.query(
      `INSERT INTO bid_responses (bid_id, response_type, message, quote_amount, availability)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [bid_id, response_type, message, quote_amount || null, availability || null]
    );

    // Update bid status
    const newStatus = response_type === 'quote' ? 'quoted'
                    : response_type === 'decline' ? 'declined'
                    : 'viewed';
    await client.query(
      `UPDATE bid_requests SET status = $1, responded_at = NOW()
       WHERE bid_id = $2 AND status NOT IN ('quoted','declined')`,
      [newStatus, bid_id]
    );

    res.status(201).json(rr[0]);
  } finally { client.release(); }
});

// ── GET /vendor/bids/:bid_id/messages ────────────────────────────────────────
router.get('/bids/:bid_id/messages', requireVendorJwt, async (req, res) => {
  const { bid_id } = req.params;
  const client = await pool.connect();
  try {
    const { rows: br } = await client.query(
      `SELECT bid_id FROM bid_requests WHERE bid_id = $1 AND vendor_id = $2`,
      [bid_id, req.vendorUser.vendorId]
    );
    if (!br.length) return res.status(404).json({ error: 'Bid not found' });

    const { rows } = await client.query(
      `SELECT * FROM bid_messages WHERE bid_id = $1 ORDER BY created_at`,
      [bid_id]
    );
    // Mark landlord messages as read
    await client.query(
      `UPDATE bid_messages SET is_read = true WHERE bid_id = $1 AND sender_type = 'landlord'`,
      [bid_id]
    );
    res.json({ messages: rows });
  } finally { client.release(); }
});

// ── POST /vendor/bids/:bid_id/messages  (vendor → landlord) ──────────────────
router.post('/bids/:bid_id/messages', requireVendorJwt, async (req, res) => {
  const { bid_id } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const client = await pool.connect();
  try {
    const { rows: br } = await client.query(
      `SELECT bid_id FROM bid_requests WHERE bid_id = $1 AND vendor_id = $2`,
      [bid_id, req.vendorUser.vendorId]
    );
    if (!br.length) return res.status(404).json({ error: 'Bid not found' });

    const { rows } = await client.query(
      `INSERT INTO bid_messages (bid_id, sender_type, sender_id, message)
       VALUES ($1, 'vendor', $2, $3) RETURNING *`,
      [bid_id, req.vendorUser.vendorId, message]
    );
    res.status(201).json(rows[0]);
  } finally { client.release(); }
});


// ── GET /vendor/bank-account ──────────────────────────────────────────────────
router.get('/bank-account', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT bank_account_id, account_holder, bank_name, account_type,
              routing_number, account_last4, created_at, updated_at
       FROM vendor_bank_accounts WHERE vendor_id = $1`,
      [req.vendorUser.vendorId]
    );
    res.json(rows[0] || null);
  } finally { client.release(); }
});

// ── PUT /vendor/bank-account ──────────────────────────────────────────────────
router.put('/bank-account', requireVendorJwt, async (req, res) => {
  const { account_holder, bank_name, account_type, routing_number, account_number } = req.body;
  if (!account_holder || !bank_name || !routing_number || !account_number)
    return res.status(400).json({ error: 'account_holder, bank_name, routing_number and account_number are required' });

  const last4 = String(account_number).slice(-4);
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO vendor_bank_accounts
         (vendor_id, account_holder, bank_name, account_type, routing_number, account_last4)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (vendor_id) DO UPDATE
         SET account_holder = EXCLUDED.account_holder,
             bank_name = EXCLUDED.bank_name,
             account_type = EXCLUDED.account_type,
             routing_number = EXCLUDED.routing_number,
             account_last4 = EXCLUDED.account_last4,
             updated_at = NOW()`,
      [req.vendorUser.vendorId, account_holder.trim(), bank_name.trim(),
       account_type || 'checking', routing_number.trim(), last4]
    );
    res.json({ success: true });
  } finally { client.release(); }
});

// -- POST /vendor/push-token
router.post('/push-token', requireVendorJwt, async (req, res) => {
  const { expo_token } = req.body;
  if (!expo_token || !expo_token.startsWith('ExponentPushToken['))
    return res.status(400).json({ error: 'Valid Expo push token required' });
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO vendor_push_tokens (vendor_id, expo_token)
       VALUES ($1, $2)
       ON CONFLICT (vendor_id, expo_token) DO NOTHING`,
      [req.vendorUser.vendorId, expo_token]
    );
    res.json({ success: true });
  } finally { client.release(); }
});

// -- GET /vendor/quote-requests
router.get('/quote-requests', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT qrv.id, qrv.quote_request_id, qrv.status AS vendor_status,
              qrv.quoted_amount, qrv.quote_message, qrv.quoted_at,
              qr.category_label, qr.address, qr.city, qr.state,
              qr.description, qr.property_type, qr.urgency,
              qr.requester_name, qr.created_at
       FROM quote_request_vendors qrv
       JOIN quote_requests qr ON qr.quote_request_id = qrv.quote_request_id
       WHERE qrv.vendor_id = $1
       ORDER BY qr.created_at DESC
       LIMIT 50`,
      [req.vendorUser.vendorId]
    );
    res.json({ quote_requests: rows });
  } finally { client.release(); }
});

// -- POST /vendor/quote-requests/:qrv_id/quote
router.post('/quote-requests/:qrv_id/quote', requireVendorJwt, async (req, res) => {
  const { qrv_id } = req.params;
  const { message, amount } = req.body;
  if (!message || !amount)
    return res.status(400).json({ error: 'message and amount are required' });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, quote_request_id FROM quote_request_vendors
       WHERE id = $1 AND vendor_id = $2`,
      [qrv_id, req.vendorUser.vendorId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quote request not found' });
    await client.query(
      `UPDATE quote_request_vendors
       SET status = 'quoted', quoted_amount = $1, quote_message = $2, quoted_at = NOW()
       WHERE id = $3`,
      [parseFloat(amount), message.trim(), qrv_id]
    );
    await client.query(
      `UPDATE quote_requests SET quotes_received = quotes_received + 1
       WHERE quote_request_id = $1`,
      [rows[0].quote_request_id]
    );
    res.json({ success: true });
  } finally { client.release(); }
});



// GET /vendor/quote-requests/:id/messages
router.get('/quote-requests/:id/messages', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT m.message_id, m.sender_type, m.sender_id, m.body, m.created_at,
              COALESCE(v.first_name || ' ' || v.last_name, 'Admin') AS sender_name
       FROM rfq_messages m
       LEFT JOIN vendor_portal_users v ON v.user_id = m.sender_id AND m.sender_type = 'vendor'
       WHERE m.quote_request_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    res.json({ messages: rows });
  } finally { client.release(); }
});

// POST /vendor/quote-requests/:id/messages
router.post('/quote-requests/:id/messages', requireVendorJwt, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO rfq_messages (quote_request_id, sender_type, sender_id, body)
       VALUES ($1, 'vendor', $2, $3) RETURNING *`,
      [req.params.id, req.user.user_id, body.trim()]
    );
    res.json({ message: rows[0] });
  } finally { client.release(); }
});

// POST /vendor/quote-requests/:id/pass
router.post('/quote-requests/:id/pass', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    // Find the qrv record for this vendor
    const { rows: qrv } = await client.query(
      `SELECT id FROM quote_request_vendors
       WHERE quote_request_id = $1 AND vendor_id = (
         SELECT vendor_id FROM vendor_portal_users WHERE user_id = $2
       )`,
      [req.params.id, req.user.user_id]
    );
    if (!qrv.length) return res.status(404).json({ error: 'RFQ not found for this vendor' });
    await client.query(
      `UPDATE quote_request_vendors SET status = 'passed' WHERE id = $1`,
      [qrv[0].id]
    );
    // Insert a system message
    await client.query(
      `INSERT INTO rfq_messages (quote_request_id, sender_type, body) VALUES ($1, 'system', 'Vendor passed on this job')`,
      [req.params.id]
    );
    res.json({ success: true });
  } finally { client.release(); }
});

// GET /vendor/quotes/history
router.get('/quotes/history', requireVendorJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT qrv.id, qrv.quote_request_id, qrv.status AS vendor_status,
              qrv.quoted_amount, qrv.quote_message, qrv.quoted_at,
              qr.category_label, qr.address, qr.city, qr.state, qr.description,
              qr.property_type, qr.urgency, qr.requester_name, qr.created_at, qr.status AS rfq_status
       FROM quote_request_vendors qrv
       JOIN quote_requests qr ON qr.quote_request_id = qrv.quote_request_id
       WHERE qrv.vendor_id = (SELECT vendor_id FROM vendor_portal_users WHERE user_id = $1)
         AND qrv.status IN ('quoted','passed','accepted','declined','expired')
       ORDER BY COALESCE(qrv.quoted_at, qrv.created_at) DESC
       LIMIT 50`,
      [req.user.user_id]
    );
    res.json({ history: rows });
  } finally { client.release(); }
});

// PUT /vendor/profile
router.put('/profile', requireVendorJwt, async (req, res) => {
  const { first_name, last_name, phone, address, city, state, zip } = req.body || {};
  const client = await pool.connect();
  try {
    if (first_name || last_name) {
      await client.query(
        `UPDATE vendor_portal_users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name) WHERE user_id = $3`,
        [first_name?.trim() || null, last_name?.trim() || null, req.user.user_id]
      );
    }
    const { rows: vpu } = await client.query(`SELECT vendor_id FROM vendor_portal_users WHERE user_id = $1`, [req.user.user_id]);
    if (vpu[0]?.vendor_id) {
      await client.query(
        `UPDATE vendors SET
          canonical_name = COALESCE($1, canonical_name),
          primary_phone = COALESCE($2, primary_phone),
          street_address = COALESCE($3, street_address),
          city = COALESCE($4, city),
          state = COALESCE($5, state),
          zip = COALESCE($6, zip),
          updated_at = NOW()
         WHERE vendor_id = $7`,
        [
          first_name && last_name ? `${first_name} ${last_name}` : null,
          phone?.trim() || null,
          address?.trim() || null,
          city?.trim() || null,
          state?.trim() || null,
          zip?.trim() || null,
          vpu[0].vendor_id
        ]
      );
    }
    const { rows } = await client.query(
      `SELECT vpu.user_id, vpu.email, vpu.first_name, vpu.last_name,
              v.canonical_name, v.primary_phone, v.street_address, v.city, v.state, v.zip, v.primary_category_code
       FROM vendor_portal_users vpu LEFT JOIN vendors v ON v.vendor_id = vpu.vendor_id
       WHERE vpu.user_id = $1`,
      [req.user.user_id]
    );
    res.json(rows[0] || {});
  } finally { client.release(); }
});

// POST /vendor/scan-card — extract vendor info from business card image
router.post('/scan-card', requireVendorJwt, async (req, res) => {
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64) required' });
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: `Extract all business card information from this image. Return ONLY a JSON object with these fields (use empty string if not found):\n{\n  name: contact person name,\n  company: company/business name,\n  phone: phone number,\n  email: email address,\n  address: street address,\n  city: city,\n  state: state abbreviation,\n  zip: zip code,\n  website: website URL,\n  category: best guess at business category/trade\n}\nReturn ONLY the JSON, no markdown, no explanation.` },
          ],
        }],
      }),
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(502).json({ error: 'AI analysis failed' });
    const text = claudeData.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse card data' });
    res.json(JSON.parse(jsonMatch[0]));
  } catch (e) {
    console.error('[vendor-scan-card] error:', e.message);
    res.status(500).json({ error: 'Business card scan failed' });
  }
});


// POST /vendor/scan-and-match — scan business card, find or create vendor, link to this account
router.post('/scan-and-match', requireVendorJwt, async (req, res) => {
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64) required' });
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // 1. Extract card info via Claude vision
  let card;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: 'Extract all business card information. Return ONLY a JSON object: { name, company, phone, email, address, city, state, zip, website, category }. Use empty string for missing fields. Return ONLY the JSON.' }
        ]}]
      })
    });
    const cd = await claudeRes.json();
    if (!claudeRes.ok) return res.status(502).json({ error: 'AI scan failed' });
    const m = (cd.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return res.status(422).json({ error: 'Could not parse card' });
    card = JSON.parse(m[0]);
  } catch(e) {
    console.error('[scan-and-match] scan error:', e.message);
    return res.status(500).json({ error: 'Scan failed' });
  }

  const userId = req.vendorUser.vendorUserId;
  const client = await pool.connect();
  try {
    // 2. Search for existing vendor by email, phone, or company name
    const phone = (card.phone || '').replace(/[^0-9+]/g, '');
    const company = (card.company || '').trim();
    const cardEmail = (card.email || '').toLowerCase().trim();

    let match = null;
    if (company || cardEmail || phone) {
      const { rows } = await client.query(
        `SELECT * FROM vendors WHERE
           (canonical_name ILIKE $1 AND $1 != '')
           OR (email = $2 AND $2 != '')
           OR (primary_phone = $3 AND $3 != '')
         LIMIT 1`,
        [company, cardEmail, phone]
      );
      if (rows.length) match = rows[0];
    }

    if (match) {
      // 3a. Found existing vendor — link this user to it
      await client.query(
        `UPDATE vendor_portal_users SET vendor_id = $1 WHERE user_id = $2`,
        [match.vendor_id, userId]
      );
      return res.json({ matched: true, vendor: match, card });
    }

    // 3b. No match — create new vendor and link
    const { randomUUID } = await import('crypto');
    const newId = randomUUID();
    const slugBase = (company || card.name || 'vendor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-${'$'}/g, '').slice(0, 100);
    const slug = slugBase + '-' + newId.slice(0, 8);

    const catRes = await client.query(
      `SELECT category_code FROM category_taxonomy WHERE category_name ILIKE $1 LIMIT 1`,
      ['%' + (card.category || '') + '%']
    );
    const categoryCode = catRes.rows[0]?.category_code || (await client.query('SELECT category_code FROM category_taxonomy LIMIT 1')).rows[0]?.category_code;

    const { rows: newVendorRows } = await client.query(
      `INSERT INTO vendors (vendor_id, slug, canonical_name, email, primary_phone, website_url,
         street_address, city, state, zip, primary_category_code,
         is_active, is_claimed, is_licensed, is_insured, is_background_checked, is_onboarded, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               true, false, false, false, false, true, NOW(), NOW())
       RETURNING *`,
      [newId, slug, company || card.name, cardEmail || null, phone || null,
       card.website || null, card.address || null, card.city || null,
       card.state || null, card.zip || null, categoryCode]
    );
    const newVendor = newVendorRows[0];

    await client.query(
      `UPDATE vendor_portal_users SET vendor_id = $1 WHERE user_id = $2`,
      [newId, userId]
    );

    return res.json({ matched: false, vendor: newVendor, card });
  } catch(e) {
    console.error('[scan-and-match] db error:', e.message);
    return res.status(500).json({ error: 'Server error during vendor match' });
  } finally { client.release(); }
});


// POST /vendor/match-or-create — match card data to existing vendor or create new, link to account
router.post('/match-or-create', requireVendorJwt, async (req, res) => {
  const { name, company, phone, email, address, city, state, zip, website, category } = req.body || {};
  const userId = req.vendorUser.vendorUserId;
  const client = await pool.connect();
  try {
    const cleanPhone = (phone || '').replace(/[^0-9+]/g, '');
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanCompany = (company || '').trim();

    // Search for existing vendor
    let match = null;
    if (cleanCompany || cleanEmail || cleanPhone) {
      const { rows } = await client.query(
        `SELECT * FROM vendors WHERE
           (canonical_name ILIKE $1 AND $1 != '')
           OR (email = $2 AND $2 != '')
           OR (primary_phone = $3 AND $3 != '')
         LIMIT 1`,
        [cleanCompany, cleanEmail, cleanPhone]
      );
      if (rows.length) match = rows[0];
    }

    if (match) {
      await client.query(
        `UPDATE vendor_portal_users SET vendor_id = $1 WHERE user_id = $2`,
        [match.vendor_id, userId]
      );
      // Onboard the matched vendor so they join the quoting flow
      await client.query(
        `UPDATE vendors SET is_onboarded = true, is_active = true, updated_at = NOW() WHERE vendor_id = $1`,
        [match.vendor_id]
      );
      const { rows: updatedRows } = await client.query(`SELECT * FROM vendors WHERE vendor_id = $1`, [match.vendor_id]);
      return res.json({ matched: true, vendor: updatedRows[0] });
    }

    // Create new vendor
    const { randomUUID } = await import('crypto');
    const newId = randomUUID();
    const slugBase = (cleanCompany || name || 'vendor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-${'$'}/g, '').slice(0, 80);
    const slug = slugBase + '-' + newId.slice(0, 8);

    const catRes = await client.query(
      `SELECT category_code FROM category_taxonomy WHERE category_name ILIKE $1 LIMIT 1`,
      ['%' + (category || '') + '%']
    );
    const categoryCode = catRes.rows[0]?.category_code
      || (await client.query('SELECT category_code FROM category_taxonomy LIMIT 1')).rows[0]?.category_code;

    const { rows: newRows } = await client.query(
      `INSERT INTO vendors (vendor_id, slug, canonical_name, email, primary_phone, website_url,
         street_address, city, state, zip, primary_category_code,
         is_active, is_claimed, is_licensed, is_insured, is_background_checked, is_onboarded, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               true,false,false,false,false,true,NOW(),NOW())
       RETURNING *`,
      [newId, slug, cleanCompany || name, cleanEmail || null, cleanPhone || null,
       website || null, address || null, city || null, state || null, zip || null, categoryCode]
    );

    await client.query(
      `UPDATE vendor_portal_users SET vendor_id = $1 WHERE user_id = $2`,
      [newId, userId]
    );

    return res.json({ matched: false, vendor: newRows[0] });
  } catch(e) {
    console.error('[match-or-create] error:', e.message, e.code);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  } finally { client.release(); }
});

export default router;