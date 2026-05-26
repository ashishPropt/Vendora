/**
 * Vendora API v3  —  Authorization: Bearer <api_key>
 *
 * GET  /v3/businesses/search   — search vendors by zip + distance + term (LLM classified)
 *                                 add ?bid_request=true to send bids to onboarded vendors
 * GET  /v3/businesses/:id      — single vendor
 * GET  /v3/bid-status          — bid status for a maintenance request
 * GET  /v3/bid-messages        — message thread for a bid
 * POST /v3/bid-messages        — landlord sends a message
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireApiKey } from '../middleware/apikey.js';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';

const router = Router();
router.use((req, res, next) => {
  // vendor-invite has its own dual auth (API key OR admin JWT)
  if (req.path === '/vendor-invite' || req.path.startsWith('/vendor-invite/'))
    return next();
  requireApiKey(req, res, next);
});

// ── Taxonomy cache (loaded once at module import) ─────────────────────────────
let _taxonomyCache = null;
async function getTaxonomy() {
  if (_taxonomyCache) return _taxonomyCache;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT category_code, display_name, keywords FROM category_taxonomy WHERE is_active = true ORDER BY priority`
    );
    _taxonomyCache = rows;
    setTimeout(() => { _taxonomyCache = null; }, 10 * 60 * 1000); // refresh every 10 min
    return rows;
  } finally { client.release(); }
}

// ── LLM term classification ───────────────────────────────────────────────────
const _classifyCache = new Map();  // term → { code, ts }
const CLASSIFY_TTL_MS = 30 * 60 * 1000;

async function classifyTerm(term) {
  const key = term.toLowerCase().trim();
  const cached = _classifyCache.get(key);
  if (cached && Date.now() - cached.ts < CLASSIFY_TTL_MS) return cached.code;

  const taxonomy = await getTaxonomy();
  const codeList = taxonomy.map(t => `${t.category_code}: ${t.display_name}`).join('\n');

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content:
            `You are a home-services category classifier.\n` +
            `Given this maintenance request, reply with ONLY the best matching category code from the list below, or "NONE" if nothing fits.\n\n` +
            `Maintenance request: "${term}"\n\nCategories:\n${codeList}`,
        }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const code = data.content?.[0]?.text?.trim().replace(/["'`]/g, '');
    const valid = taxonomy.some(t => t.category_code === code) ? code : null;
    _classifyCache.set(key, { code: valid, ts: Date.now() });
    return valid;
  } catch {
    return null;
  }
}

// ── Zip geocoding via Nominatim ───────────────────────────────────────────────
const _geoCache = new Map();
async function geocodeZip(zip) {
  if (_geoCache.has(zip)) return _geoCache.get(zip);
  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&country=us&format=json&limit=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Vendora/1.0 (vendora@proptxchange.com)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.length) return null;
    const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    _geoCache.set(zip, coords);
    setTimeout(() => _geoCache.delete(zip), 60 * 60 * 1000); // 1-hour TTL
    return coords;
  } catch {
    return null;
  }
}

// ── ZIP → state fallback ───────────────────────────────────────────────────────
const ZIP_RANGES = [
  [1000,2799,'MA'],[3000,3899,'NH'],[3900,4999,'ME'],[5000,5999,'VT'],
  [6000,6999,'CT'],[7000,8999,'NJ'],[10000,14999,'NY'],[15000,19699,'PA'],
  [19700,19999,'DE'],[20000,20599,'DC'],[20600,21999,'MD'],[22000,24699,'VA'],
  [24700,26999,'WV'],[27000,28999,'NC'],[29000,29999,'SC'],[30000,31999,'GA'],
  [32000,34999,'FL'],[35000,36999,'AL'],[37000,38599,'TN'],[38600,39999,'MS'],
  [40000,42999,'KY'],[43000,45999,'OH'],[46000,47999,'IN'],[48000,49999,'MI'],
  [50000,52999,'IA'],[53000,54999,'WI'],[55000,56799,'MN'],[57000,57999,'SD'],
  [58000,58999,'ND'],[59000,59999,'MT'],[60000,62999,'IL'],[63000,65999,'MO'],
  [66000,67999,'KS'],[68000,69999,'NE'],[70000,71499,'LA'],[71600,72999,'AR'],
  [73000,74999,'OK'],[75000,79999,'TX'],[80000,81999,'CO'],[82000,83199,'WY'],
  [83200,83999,'ID'],[84000,84999,'UT'],[85000,86599,'AZ'],[87000,88499,'NM'],
  [88900,89999,'NV'],[90000,96199,'CA'],[96700,96899,'HI'],[97000,97999,'OR'],
  [98000,99499,'WA'],[99500,99999,'AK'],
];
function zipToState(zip) {
  const n = parseInt(zip, 10);
  if (isNaN(n)) return null;
  for (const [lo, hi, st] of ZIP_RANGES) if (n >= lo && n <= hi) return st;
  return null;
}

// ── Format helpers ────────────────────────────────────────────────────────────
function formatPhone(raw) {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return `+${d}`;
}
function displayPhone(raw) {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  const c = d.length === 11 ? d.slice(1) : d;
  return c.length === 10 ? `(${c.slice(0,3)}) ${c.slice(3,6)}-${c.slice(6)}` : raw;
}

function buildBusiness(v) {
  const addr1 = v.street_address || null;
  const city  = v.city  || null;
  const state = v.state || null;
  const zip   = v.zip   || null;
  const parts = [addr1, [city, state, zip].filter(Boolean).join(', ')].filter(Boolean);

  return {
    id:           v.vendor_id,
    alias:        v.slug,
    name:         v.canonical_name,
    image_url:    null,
    is_closed:    !v.is_active,
    is_onboarded: Boolean(v.is_onboarded),
    url:          v.website_url || null,
    review_count: Number(v.total_reviews) || 0,
    categories: [{
      alias: v.primary_category_code,
      title: v.category_name || v.primary_category_code,
    }],
    rating:      v.avg_rating ? Number(v.avg_rating) : null,
    coordinates: {
      latitude:  v.lat ? Number(v.lat) : null,
      longitude: v.lng ? Number(v.lng) : null,
    },
    transactions: [],
    location: { address1: addr1, address2: null, address3: null, city, zip_code: zip, country: 'US', state, display_address: parts },
    phone:         formatPhone(v.primary_phone),
    display_phone: displayPhone(v.primary_phone),
    email:         v.email || null,
    distance_miles: v.distance_miles ? Number(v.distance_miles) : null,
    vendora: {
      vendor_score:          v.vendor_score        ? Number(v.vendor_score)        : null,
      score_tier:            v.score_tier          || null,
      quality_score:         v.quality_score       ? Number(v.quality_score)       : null,
      compliance_score:      v.compliance_score    ? Number(v.compliance_score)    : null,
      reputation_score:      v.reputation_score    ? Number(v.reputation_score)    : null,
      is_licensed:           v.is_licensed,
      is_insured:            v.is_insured,
      is_background_checked: v.is_background_checked,
      bbb_accredited:        v.bbb_accredited      || null,
      bbb_rating:            v.bbb_rating          || null,
      years_in_business:     v.years_in_business   || null,
      employee_count_range:  v.employee_count_range || null,
    },
  };
}

// ── GET /v3/businesses/search ─────────────────────────────────────────────────
router.get('/businesses/search', async (req, res) => {
  const {
    zip_code,
    term,
    categories,
    distance     = 50,     // miles radius
    limit        = 20,
    offset       = 0,
    sort_by      = 'best_match',
    bid_request  = 'false',
    // Bid request fields (used when bid_request=true)
    maintenance_request_id,
    lease_id,
    landlord_id,
    description,
    priority,
    property_name,
    unit_label,
    address,
  } = req.query;

  if (!zip_code) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', description: 'zip_code is required' } });
  }

  const state = zipToState(zip_code);
  if (!state) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', description: `Cannot resolve state for zip_code "${zip_code}"` } });
  }

  const lim      = Math.min(Math.max(parseInt(limit, 10)  || 20, 1), 50);
  const off      = Math.max(parseInt(offset, 10)         || 0, 0);
  const distMi   = Math.min(Math.max(parseFloat(distance) || 50, 1), 500);
  const doBid    = bid_request === 'true';

  // ── LLM category classification ────────────────────────────────────────────
  let resolvedCategory = categories || null;
  if (term && !resolvedCategory) {
    resolvedCategory = await classifyTerm(term);
  }

  // ── Geocode zip for distance filter ────────────────────────────────────────
  const coords = await geocodeZip(zip_code);

  // ── Build SQL ───────────────────────────────────────────────────────────────
  const conditions = ['v.is_active = true', 'v.state = $1'];
  const params = [state];
  let pi = 2;

  // Category filter (from LLM classification or explicit param)
  if (resolvedCategory) {
    const cats = resolvedCategory.split(',').map(c => c.trim()).filter(Boolean);
    if (cats.length) {
      conditions.push(`(v.primary_category_code = ANY($${pi}) OR v.secondary_category_codes && $${pi})`);
      params.push(cats);
      pi++;
    }
  }

  // Distance filter: Haversine when vendor has lat/lng and we have search coords
  let distanceExpr = 'NULL';
  if (coords) {
    distanceExpr =
      `3959 * acos(LEAST(1.0, cos(radians(${coords.lat})) * cos(radians(v.lat)) ` +
      `* cos(radians(v.lng) - radians(${coords.lng})) ` +
      `+ sin(radians(${coords.lat})) * sin(radians(v.lat))))`;
    // Only apply distance filter where vendor has coordinates
    conditions.push(
      `(v.lat IS NULL OR v.lng IS NULL OR ` +
      `${distanceExpr} <= $${pi})`
    );
    params.push(distMi);
    pi++;
  }

  const orderMap = {
    best_match:   'v.is_onboarded DESC, v.vendor_score DESC NULLS LAST',
    rating:       'v.is_onboarded DESC, avg_rating DESC NULLS LAST',
    review_count: 'v.is_onboarded DESC, total_reviews DESC NULLS LAST',
  };
  const zipBoost = `CASE WHEN v.zip = '${zip_code.replace(/'/g,'')}' THEN 0 ELSE 1 END`;
  const order = `${zipBoost}, ${orderMap[sort_by] || orderMap.best_match}`;

  const sql = `
    SELECT
      v.*,
      ct.display_name            AS category_name,
      ROUND(AVG(vrs.avg_rating)::numeric, 1)  AS avg_rating,
      SUM(vrs.review_count)::int               AS total_reviews,
      vs.quality_score, vs.compliance_score, vs.reputation_score,
      ${coords ? `ROUND((${distanceExpr})::numeric, 1)` : 'NULL'} AS distance_miles,
      COUNT(*) OVER ()           AS total_count
    FROM vendors v
    LEFT JOIN category_taxonomy ct         ON ct.category_code = v.primary_category_code
    LEFT JOIN vendor_reviews_summary vrs   ON vrs.vendor_id    = v.vendor_id
    LEFT JOIN vendor_scores vs             ON vs.vendor_id     = v.vendor_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY v.vendor_id, ct.display_name,
             vs.quality_score, vs.compliance_score, vs.reputation_score
    ORDER BY ${order}
    LIMIT $${pi} OFFSET $${pi + 1}`;

  params.push(lim, off);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    const businesses = rows.map(buildBusiness);

    // ── Bid request flow ────────────────────────────────────────────────────
    let bidResults = null;
    if (doBid && maintenance_request_id && lease_id && landlord_id) {
      const onboarded = rows.filter(r => r.is_onboarded);
      bidResults = [];

      for (const v of onboarded) {
        try {
          const { rows: br } = await client.query(
            `INSERT INTO bid_requests
               (vendor_id, maintenance_request_id, lease_id, landlord_id,
                title, description, priority, property_name, unit_label, address, zip_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (vendor_id, maintenance_request_id) DO NOTHING
             RETURNING bid_id, status, sent_at`,
            [v.vendor_id, maintenance_request_id, lease_id, landlord_id,
             term || 'Maintenance Request', description || null,
             priority || null, property_name || null,
             unit_label || null, address || null, zip_code]
          );
          // If conflict (already sent), fetch existing
          let bid = br[0];
          if (!bid) {
            const { rows: ex } = await client.query(
              `SELECT bid_id, status, sent_at, responded_at FROM bid_requests
               WHERE vendor_id=$1 AND maintenance_request_id=$2`,
              [v.vendor_id, maintenance_request_id]
            );
            bid = ex[0];
          }
          bidResults.push({
            vendor_id: v.vendor_id,
            vendor_name: v.canonical_name,
            bid_id: bid?.bid_id || null,
            status: bid?.status || 'sent',
            sent_at: bid?.sent_at || new Date().toISOString(),
          });
        } catch (e) {
          bidResults.push({ vendor_id: v.vendor_id, vendor_name: v.canonical_name, status: 'error', error: e.message });
        }
      }
    }

    res.json({
      businesses,
      total,
      matched_category: resolvedCategory || null,
      region: { zip_code, state, distance_miles: distMi },
      ...(bidResults !== null ? { bid_results: bidResults } : {}),
    });
  } finally {
    client.release();
  }
});

// ── GET /v3/businesses/:id ────────────────────────────────────────────────────
router.get('/businesses/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT v.*, ct.display_name AS category_name,
         ROUND(AVG(vrs.avg_rating)::numeric,1) AS avg_rating,
         SUM(vrs.review_count)::int             AS total_reviews,
         vs.quality_score, vs.compliance_score, vs.reputation_score
       FROM vendors v
       LEFT JOIN category_taxonomy ct       ON ct.category_code = v.primary_category_code
       LEFT JOIN vendor_reviews_summary vrs ON vrs.vendor_id    = v.vendor_id
       LEFT JOIN vendor_scores vs           ON vs.vendor_id     = v.vendor_id
       WHERE v.vendor_id::text = $1 OR v.slug = $1
       GROUP BY v.vendor_id, ct.display_name, vs.quality_score, vs.compliance_score, vs.reputation_score`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'BUSINESS_NOT_FOUND', description: 'Business not found' } });
    res.json(buildBusiness(rows[0]));
  } finally { client.release(); }
});

// ── GET /v3/bid-status?maintenance_request_id=... ────────────────────────────
router.get('/bid-status', async (req, res) => {
  const { maintenance_request_id } = req.query;
  if (!maintenance_request_id)
    return res.status(400).json({ error: 'maintenance_request_id required' });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT br.bid_id, br.vendor_id, v.canonical_name AS vendor_name,
              br.status, br.sent_at, br.viewed_at, br.responded_at,
              br.agreed_amount, br.completed_at, br.landlord_rating, br.landlord_review,
              (SELECT json_agg(json_build_object(
                'response_type', resp.response_type,
                'message', resp.message,
                'quote_amount', resp.quote_amount,
                'availability', resp.availability,
                'created_at', resp.created_at)
               ORDER BY resp.created_at)
               FROM bid_responses resp WHERE resp.bid_id = br.bid_id) AS responses,
              (SELECT COUNT(*) FROM bid_messages m
               WHERE m.bid_id = br.bid_id AND m.sender_type = 'vendor' AND m.is_read = false
              )::int AS unread_messages
       FROM bid_requests br
       JOIN vendors v ON v.vendor_id = br.vendor_id
       WHERE br.maintenance_request_id = $1
       ORDER BY br.sent_at`,
      [maintenance_request_id]
    );
    res.json({ bids: rows });
  } finally { client.release(); }
});

// ── GET /v3/bid-messages?bid_id=... ──────────────────────────────────────────
router.get('/bid-messages', async (req, res) => {
  const { bid_id } = req.query;
  if (!bid_id) return res.status(400).json({ error: 'bid_id required' });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM bid_messages WHERE bid_id = $1 ORDER BY created_at`,
      [bid_id]
    );
    res.json({ messages: rows });
  } finally { client.release(); }
});

// ── POST /v3/bid-messages  (landlord sends reply) ────────────────────────────
router.post('/bid-messages', async (req, res) => {
  const { bid_id, message, sender_type, sender_id, landlord_id } = req.body;
  if (!bid_id || !message)
    return res.status(400).json({ error: 'bid_id and message are required' });
  // sender_type defaults to 'landlord' for this endpoint; sender_id can be landlord_id
  const sType = sender_type || 'landlord';
  const sId   = sender_id || landlord_id || null;
  const client = await pool.connect();
  try {
    // Verify the bid exists
    const { rows: br } = await client.query(
      `SELECT bid_id FROM bid_requests WHERE bid_id = $1`, [bid_id]
    );
    if (!br.length) return res.status(404).json({ error: 'Bid not found' });
    const { rows } = await client.query(
      `INSERT INTO bid_messages (bid_id, sender_type, sender_id, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [bid_id, sType, sId, message]
    );
    res.status(201).json(rows[0]);
  } finally { client.release(); }
});


// ── POST /v3/award-bid ────────────────────────────────────────────────────────
// Awards the job to one vendor, closes all other bids for the same request,
// and sends an automatic message to each vendor.
router.post('/award-bid', async (req, res) => {
  const { bid_id, maintenance_request_id, landlord_id, note } = req.body;
  if (!bid_id || !maintenance_request_id)
    return res.status(400).json({ error: 'bid_id and maintenance_request_id are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify the winning bid exists
    const { rows: wb } = await client.query(
      `SELECT br.bid_id, br.vendor_id, v.canonical_name
       FROM bid_requests br
       JOIN vendors v ON v.vendor_id = br.vendor_id
       WHERE br.bid_id = $1 AND br.maintenance_request_id = $2`,
      [bid_id, maintenance_request_id]
    );
    if (!wb.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bid not found' });
    }
    const winner = wb[0];

    // 1. Get agreed_amount from latest quote response
    const { rows: qr } = await client.query(
      `SELECT quote_amount FROM bid_responses
       WHERE bid_id = $1 AND response_type = 'quote'
       ORDER BY created_at DESC LIMIT 1`,
      [bid_id]
    );
    const agreedAmount = qr[0]?.quote_amount ?? null;

    // Mark winning bid as awarded + store agreed_amount
    await client.query(
      `UPDATE bid_requests SET status = 'awarded', responded_at = NOW(), agreed_amount = $2
       WHERE bid_id = $1`,
      [bid_id, agreedAmount]
    );

    // Create escrow record if there's an agreed amount
    if (agreedAmount != null) {
      await client.query(
        `INSERT INTO escrow_transactions
           (bid_id, maintenance_request_id, vendor_id, amount, status)
         VALUES ($1, $2, $3, $4, 'held')
         ON CONFLICT (bid_id) DO NOTHING`,
        [bid_id, maintenance_request_id, winner.vendor_id, agreedAmount]
      );
    }

    // 2. Close all other bids for this maintenance request (not already declined)
    const { rows: others } = await client.query(
      `UPDATE bid_requests
       SET status = 'closed'
       WHERE maintenance_request_id = $1
         AND bid_id != $2
         AND status NOT IN ('declined', 'closed', 'awarded')
       RETURNING bid_id, vendor_id`,
      [maintenance_request_id, bid_id]
    );

    // 3. Send congratulations message to winning vendor
    const winMsg = note
      ? `Great news — you've been awarded this job! ${note}`
      : `Great news — you've been awarded this job! Please confirm your availability and proceed.`;
    await client.query(
      `INSERT INTO bid_messages (bid_id, sender_type, sender_id, message)
       VALUES ($1, 'landlord', $2, $3)`,
      [bid_id, landlord_id || null, winMsg]
    );

    // 4. Send closure messages to other vendors
    for (const other of others) {
      await client.query(
        `INSERT INTO bid_messages (bid_id, sender_type, sender_id, message)
         VALUES ($1, 'landlord', $2, $3)`,
        [other.bid_id, landlord_id || null,
         'Thank you for your quote. We have awarded this job to another vendor.']
      );
    }

    await client.query('COMMIT');

    res.json({
      awarded_bid_id:   bid_id,
      awarded_vendor:   winner.canonical_name,
      closed_bid_count: others.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});


// ── POST /v3/complete-job ─────────────────────────────────────────────────────
// Landlord marks a job as completed, rates the vendor, releases escrow.
router.post('/complete-job', async (req, res) => {
  const { bid_id, maintenance_request_id, landlord_rating, landlord_review, landlord_id } = req.body;
  if (!bid_id || !maintenance_request_id)
    return res.status(400).json({ error: 'bid_id and maintenance_request_id are required' });
  if (landlord_rating != null && (landlord_rating < 1 || landlord_rating > 5))
    return res.status(400).json({ error: 'landlord_rating must be 1–5' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify the bid exists and is awarded
    const { rows: br } = await client.query(
      `SELECT br.bid_id, br.vendor_id, br.agreed_amount, v.canonical_name
       FROM bid_requests br
       JOIN vendors v ON v.vendor_id = br.vendor_id
       WHERE br.bid_id = $1 AND br.maintenance_request_id = $2 AND br.status = 'awarded'`,
      [bid_id, maintenance_request_id]
    );
    if (!br.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Awarded bid not found' });
    }
    const bid = br[0];

    // Mark bid as completed
    await client.query(
      `UPDATE bid_requests
       SET status = 'completed', completed_at = NOW(),
           landlord_rating = $2, landlord_review = $3
       WHERE bid_id = $1`,
      [bid_id, landlord_rating ?? null, landlord_review?.trim() || null]
    );

    // Release escrow
    await client.query(
      `UPDATE escrow_transactions
       SET status = 'released', released_at = NOW()
       WHERE bid_id = $1 AND status = 'held'`,
      [bid_id]
    );

    // Send completion message to vendor
    const ratingText = landlord_rating
      ? ` You received a ${landlord_rating}-star rating.`
      : '';
    const reviewText = landlord_review?.trim()
      ? ` Review: "${landlord_review.trim()}"`
      : '';
    const completionMsg = `The landlord has marked this job as complete.${ratingText}${reviewText} Payment has been released to your account.`;
    await client.query(
      `INSERT INTO bid_messages (bid_id, sender_type, sender_id, message)
       VALUES ($1, 'landlord', $2, $3)`,
      [bid_id, landlord_id || null, completionMsg]
    );

    await client.query('COMMIT');

    res.json({
      completed_bid_id: bid_id,
      vendor_name: bid.canonical_name,
      agreed_amount: bid.agreed_amount,
      landlord_rating: landlord_rating ?? null,
      escrow_released: bid.agreed_amount != null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});


// ── POST /v3/vendor-invite ─────────────────────────────────────────────────────
// Creates (or refreshes) a 30-day invite link for an un-onboarded vendor.
// Requires API key. Body: { vendor_id, invited_by? }
router.post('/vendor-invite', async (req, res, next) => {
  // Accept either the Vendora API key or an admin JWT
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  // Try API key first
  const { rows: kr } = await pool.query(
    `SELECT key_id FROM api_keys WHERE key_hash = encode(digest($1,'sha256'),'hex') AND is_active = true`,
    [token]
  ).catch(() => ({ rows: [] }));
  if (kr.length) return next();
  // Fall back to admin JWT
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET || 'vendora-jwt-prod-2026-leaseloft');
    if (p.role === 'admin') return next();
  } catch {}
  return res.status(401).json({ error: 'Invalid API key or admin token' });
}, async (req, res) => {
  const { vendor_id, invited_by } = req.body || {};
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required' });

  const client = await pool.connect();
  try {
    // Verify vendor exists
    const { rows: vr } = await client.query(
      `SELECT vendor_id, canonical_name, is_onboarded FROM vendors WHERE vendor_id = $1`,
      [vendor_id]
    );
    if (!vr.length) return res.status(404).json({ error: 'Vendor not found' });
    if (vr[0].is_onboarded) return res.status(409).json({ error: 'Vendor is already onboarded' });

    // Upsert invite (one active invite per vendor; refreshes token each time)
    const token = randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO vendor_invites (vendor_id, token, invited_by, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')
       ON CONFLICT (vendor_id) DO UPDATE
         SET token      = $2,
             invited_by = $3,
             expires_at = NOW() + INTERVAL '30 days',
             used_at    = NULL,
             created_at = NOW()`,
      [vendor_id, token, invited_by || null]
    );

    const invite_url = `http://45.77.79.14/onboard.html?invite=${token}`;
    res.json({ invite_url, token, vendor_name: vr[0].canonical_name });
  } finally { client.release(); }
});

// ── GET /v3/vendor-invite/:token ───────────────────────────────────────────────
// Public endpoint — returns vendor data for pre-filling the onboarding form.
router.get('/vendor-invite/:token', async (req, res) => {
  const { token } = req.params;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT vi.vendor_id, vi.expires_at, vi.used_at,
              v.canonical_name, v.primary_phone, v.email,
              v.website_url, v.street_address, v.city, v.state, v.zip,
              v.is_onboarded, v.score_tier,
              vc.display_name AS category_display_name
       FROM vendor_invites vi
       JOIN vendors v ON v.vendor_id = vi.vendor_id
       LEFT JOIN category_taxonomy vc ON vc.category_code = v.primary_category_code
       WHERE vi.token = $1`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid invite link' });
    const inv = rows[0];
    if (inv.used_at)
      return res.status(410).json({ error: 'This invite link has already been used' });
    if (new Date(inv.expires_at) < new Date())
      return res.status(410).json({ error: 'This invite link has expired. Ask your contact to resend it.' });
    if (inv.is_onboarded)
      return res.status(409).json({ error: 'This business is already registered on Vendora' });

    res.json({
      vendor_id:            inv.vendor_id,
      canonical_name:       inv.canonical_name,
      primary_phone:        inv.primary_phone   || '',
      email:                inv.email           || '',
      website_url:          inv.website_url     || '',
      street_address:       inv.street_address  || '',
      city:                 inv.city            || '',
      state:                inv.state           || '',
      zip:                  inv.zip             || '',
      category_display_name: inv.category_display_name || '',
    });
  } finally { client.release(); }
});


export default router;
