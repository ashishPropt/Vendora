// /opt/vendora/server/routes/devapi.js
// Developer API — address+radius vendor search, authenticated by API key
import { Router }     from 'express';
import { pool }       from '../db.js';
import { createHash } from 'crypto';

const router = Router();

// ── API-key middleware ────────────────────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const raw  = auth.startsWith('Bearer ') ? auth.slice(7)
             : (req.query.api_key || null);

  if (!raw)
    return res.status(401).json({
      error: 'API key required. Pass Authorization: Bearer <key> or ?api_key=<key>',
    });

  const keyHash = createHash('sha256').update(raw).digest('hex');
  const client  = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT k.key_id, k.dev_id, d.email
       FROM developer_api_keys k
       JOIN developer_accounts d ON d.dev_id = k.dev_id
       WHERE k.key_hash=$1 AND k.is_active=true AND d.is_active=true`,
      [keyHash]);
    if (!rows.length)
      return res.status(401).json({ error: 'Invalid or revoked API key' });

    req.apiDev = rows[0];
    // fire-and-forget usage update
    pool.query(
      `UPDATE developer_api_keys
         SET last_used_at=NOW(), request_count=request_count+1
       WHERE key_id=$1`, [rows[0].key_id]).catch(() => {});
    next();
  } finally { client.release(); }
}

// ── Geocode via Nominatim (free OSM) ─────────────────────────────────────────
async function geocode(address) {
  const url = 'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q: address, format: 'json', limit: '1',
                          countrycodes: 'us', addressdetails: '1' });
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Vendora-API/1.0 (api@vendora.io)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Geocoder HTTP ${r.status}`);
  const data = await r.json();
  if (!data.length) return null;
  const hit = data[0];
  return {
    lat:               parseFloat(hit.lat),
    lng:               parseFloat(hit.lon),
    formatted_address: hit.display_name,
    state:             hit.address?.state_code || null,
    city:              hit.address?.city || hit.address?.town || hit.address?.village || null,
  };
}

// Haversine SQL fragment (returns miles)
const HVSN = (lat, lng, latCol = 'v.lat', lngCol = 'v.lng') =>
  `3959 * acos(LEAST(1.0,
      cos(radians(${lat})) * cos(radians(${latCol})) *
        cos(radians(${lngCol}) - radians(${lng})) +
      sin(radians(${lat})) * sin(radians(${latCol}))))`;

// ── GET /v2/vendors ───────────────────────────────────────────────────────────
router.get('/vendors', requireApiKey, async (req, res) => {
  const { address, q, category } = req.query;
  const radius = Math.min(Math.max(parseFloat(req.query.radius) || 25, 1), 200);
  let page     = Math.max(parseInt(req.query.page,  10) || 1, 1);
  let limit    = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
  const offset = (page - 1) * limit;

  if (!address)
    return res.status(400).json({ error: '"address" parameter is required' });

  let geo;
  try { geo = await geocode(address); }
  catch (err) { return res.status(502).json({ error: 'Geocoding error: ' + err.message }); }
  if (!geo)
    return res.status(422).json({ error: 'Could not locate that address in the US' });

  // Build WHERE dynamically
  const conditions = ['v.is_active = true'];
  const params     = [];

  if (q) {
    params.push(`%${q}%`);
    conditions.push(`v.canonical_name ILIKE $${params.length}`);
  }
  if (category) {
    params.push(`${category}%`);
    conditions.push(`v.primary_category_code LIKE $${params.length}`);
  }

  // lat/lng/radius placeholders
  params.push(geo.lat);  const $lat    = params.length;
  params.push(geo.lng);  const $lng    = params.length;
  params.push(radius);   const $radius = params.length;

  // Location filter: exact radius for geocoded vendors,
  // state fallback for vendors not yet geocoded
  let locFilter;
  if (geo.state) {
    params.push(geo.state);
    const $state = params.length;
    locFilter = `(
      (v.lat IS NOT NULL AND
        ${HVSN(`$${$lat}`, `$${$lng}`)} <= $${$radius})
      OR
      (v.lat IS NULL AND v.state = $${$state})
    )`;
  } else {
    locFilter = `(v.lat IS NOT NULL AND
      ${HVSN(`$${$lat}`, `$${$lng}`)} <= $${$radius})`;
  }
  conditions.push(locFilter);

  const WHERE = `WHERE ${conditions.join(' AND ')}`;

  // Distance expression for SELECT / ORDER
  const distExpr = `CASE WHEN v.lat IS NOT NULL
    THEN ROUND((${HVSN(`$${$lat}`, `$${$lng}`)})::numeric, 1)
    ELSE NULL END`;

  const client = await pool.connect();
  try {
    const [data, cnt] = await Promise.all([
      client.query(
        `SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                v.primary_phone, v.website_url,
                v.is_onboarded, v.is_licensed, v.is_insured,
                v.vendor_score, v.score_tier,
                ct.display_name AS category_display_name,
                ct.category_code,
                ${distExpr} AS distance_miles
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         ${WHERE}
         ORDER BY
           CASE WHEN v.lat IS NOT NULL THEN 0 ELSE 1 END,
           CASE WHEN v.lat IS NOT NULL
             THEN ${HVSN(`$${$lat}`, `$${$lng}`)}
             ELSE 99999 END,
           v.vendor_score DESC NULLS LAST
         LIMIT ${limit} OFFSET ${offset}`,
        params),
      client.query(`SELECT COUNT(*) AS total FROM vendors v ${WHERE}`, params),
    ]);

    return res.json({
      vendors:       data.rows,
      total:         parseInt(cnt.rows[0].total, 10),
      page,
      limit,
      radius_miles:  radius,
      search_center: { lat: geo.lat, lng: geo.lng, formatted_address: geo.formatted_address },
    });
  } finally { client.release(); }
});

// ── GET /v2/vendors/:id ───────────────────────────────────────────────────────
router.get('/vendors/:id', requireApiKey, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT v.*, ct.display_name AS category_display_name
       FROM vendors v
       LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
       WHERE v.vendor_id=$1 AND v.is_active=true`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vendor not found' });
    return res.json({ vendor: rows[0] });
  } finally { client.release(); }
});

export default router;
