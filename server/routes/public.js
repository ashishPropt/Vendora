import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// GET /public/categories
// Returns grouped parent categories.  The DB only has leaf rows (e.g. PLB.GEN),
// so we derive parent label from the first (highest-priority) child.
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (parent_code)
        parent_code AS code,
        -- Use first child's display_name as the group label
        first_value(display_name) OVER (
          PARTITION BY parent_code
          ORDER BY priority, display_name
        ) AS first_child_name
      FROM category_taxonomy
      WHERE is_active = true AND parent_code IS NOT NULL
      ORDER BY parent_code
    `);

    // Build a readable parent label: strip trailing sub-category words if possible,
    // otherwise just return the first child name.
    const PARENT_LABELS = {
      APP: 'Appliances', CLN: 'Cleaning', DMP: 'Dumpster / Roll-off', ELC: 'Electrical',
      FLR: 'Flooring', GCT: 'General Contractor', GLS: 'Glass & Windows', HVC: 'HVAC',
      JNK: 'Junk Removal', LCK: 'Locksmith', LND: 'Landscaping', MOV: 'Moving',
      PNT: 'Painting', PLB: 'Plumbing', PST: 'Pest Control', RFG: 'Roofing',
      SFT: 'Safety & Security', TRE: 'Tree Service', WTR: 'Water Damage',
    };

    const categories = rows.map(r => ({
      code: r.code,
      display_name: PARENT_LABELS[r.code] || r.first_child_name,
    })).sort((a, b) => a.display_name.localeCompare(b.display_name));

    return res.json({ categories });
  } catch (err) {
    console.error('GET /public/categories error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /public/search
router.get('/search', async (req, res) => {
  const { q, state, category } = req.query;
  let page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10) || 12;
  if (page < 1) page = 1;
  if (limit < 1) limit = 12;
  if (limit > 24) limit = 24;
  const offset = (page - 1) * limit;

  const conditions = ['v.is_active = true'];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    conditions.push(`v.canonical_name ILIKE $${params.length}`);
  }
  if (state) {
    params.push(state);
    conditions.push(`v.state = $${params.length}`);
  }
  if (category) {
    params.push(`${category}%`);
    conditions.push(`v.primary_category_code LIKE $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const client = await pool.connect();
  try {
    const [dataResult, countResult] = await Promise.all([
      client.query(
        `SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                v.primary_phone, v.website_url, v.is_onboarded, v.is_licensed, v.is_insured,
                v.vendor_score, v.score_tier,
                ct.display_name AS category_display_name, ct.category_code
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         ${where}
         ORDER BY v.vendor_score DESC NULLS LAST, v.canonical_name
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      client.query(
        `SELECT COUNT(*) AS total
         FROM vendors v
         ${where}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    return res.json({ vendors: dataResult.rows, total, page, limit });
  } catch (err) {
    console.error('GET /public/search error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /public/claim-request
router.post('/claim-request', async (req, res) => {
  const { vendor_id, requester_name, requester_email, requester_phone, message } = req.body;

  if (!vendor_id || !requester_name || !requester_email) {
    return res.status(400).json({ error: 'vendor_id, requester_name, and requester_email are required' });
  }

  const client = await pool.connect();
  try {
    // Check vendor exists
    const vendorResult = await client.query(
      'SELECT vendor_id, canonical_name, is_onboarded FROM vendors WHERE vendor_id = $1',
      [vendor_id]
    );
    if (vendorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const vendor = vendorResult.rows[0];

    if (vendor.is_onboarded) {
      return res.status(409).json({ error: 'This business is already on Vendora' });
    }

    // Check for existing pending request
    const pendingResult = await client.query(
      `SELECT request_id FROM vendor_invite_requests
       WHERE vendor_id = $1 AND status = 'pending'
       LIMIT 1`,
      [vendor_id]
    );
    if (pendingResult.rows.length > 0) {
      return res.status(409).json({ error: 'A request for this listing is already pending review' });
    }

    // Insert new request
    const insertResult = await client.query(
      `INSERT INTO vendor_invite_requests
         (vendor_id, requester_name, requester_email, requester_phone, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING request_id`,
      [vendor_id, requester_name, requester_email, requester_phone ?? null, message ?? null]
    );

    const { request_id } = insertResult.rows[0];
    const vendor_name = vendor.canonical_name;

    return res.status(201).json({
      request_id,
      vendor_name,
      message: `Your request to claim ${vendor_name} has been submitted. We'll review it within 1–2 business days.`,
    });
  } catch (err) {
    console.error('POST /public/claim-request error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
