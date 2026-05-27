import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Load config.env (fills gaps not already in process.env) ──────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dir, 'config.env');
if (existsSync(configPath)) {
  for (const line of readFileSync(configPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { requireJwt } from './middleware/auth.js';
import authRoutes   from './routes/auth.js';
import keysRoutes   from './routes/keys.js';
import v3Routes     from './routes/v3.js';
import vendorRoutes from './routes/vendor-portal.js';
import adminRoutes  from './routes/admin.js';
import publicRoutes    from './routes/public.js';
import developerRoutes from './routes/developer.js';
import devapiRoutes    from './routes/devapi.js';

const app = express();
app.use(cors());
app.use(express.json());

// ── Auth & API-key management (existing users / dashboard) ────────────────────
app.use('/auth',       authRoutes);
app.use('/v1/api-keys', keysRoutes);   // JWT-protected

// ── Vendor portal (vendor login, profile, bids) ───────────────────────────────
app.use('/vendor', vendorRoutes);

// ── Admin API ──────────────────────────────────────────────────────
app.use('/admin', adminRoutes);
app.use('/public', publicRoutes);
app.use('/dev',    developerRoutes);
app.use('/v2',    devapiRoutes);

// ── Yelp-compatible search + bid API ─────────────────────────────────────────
app.use('/v3', v3Routes);              // API-key-protected

// ── Legacy chat search ────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const query = (req.body.query || '').trim();
  if (!query) return res.json({ vendors: [], categories: [] });

  const client = await pool.connect();
  try {
    const catRes = await client.query(
      `SELECT category_code, display_name, keywords
       FROM category_taxonomy
       WHERE is_active = true
         AND EXISTS (SELECT 1 FROM unnest(keywords) kw
                     WHERE lower($1) ILIKE '%' || lower(kw) || '%')
       ORDER BY priority`,
      [query]
    );
    let categories = catRes.rows;
    if (!categories.length) {
      const fb = await client.query(
        `SELECT category_code, display_name, keywords
         FROM category_taxonomy WHERE is_active = true AND lower(display_name) ILIKE $1
         ORDER BY priority LIMIT 5`,
        [`%${query.toLowerCase()}%`]
      );
      categories = fb.rows;
    }
    if (!categories.length) return res.json({ vendors: [], categories: [] });

    const codes = categories.map(c => c.category_code);
    const vendorRes = await client.query(
      `SELECT v.vendor_id, v.canonical_name, v.primary_category_code,
              ct.display_name AS category_name, v.city, v.state,
              v.primary_phone, v.website_url, v.email,
              v.vendor_score, v.score_tier, v.is_licensed, v.is_insured,
              v.is_background_checked, v.years_in_business, v.employee_count_range,
              v.service_radius_miles, v.bbb_accredited, v.bbb_rating, v.is_onboarded,
              ROUND(AVG(vrs.avg_rating)::numeric,1) AS avg_rating,
              SUM(vrs.review_count)::int             AS total_reviews,
              vs.quality_score, vs.compliance_score, vs.reputation_score
       FROM vendors v
       LEFT JOIN category_taxonomy ct         ON ct.category_code = v.primary_category_code
       LEFT JOIN vendor_reviews_summary vrs   ON vrs.vendor_id    = v.vendor_id
       LEFT JOIN vendor_scores vs             ON vs.vendor_id     = v.vendor_id
       WHERE v.is_active = true
         AND (v.primary_category_code = ANY($1) OR v.secondary_category_codes && $1)
       GROUP BY v.vendor_id, v.canonical_name, v.primary_category_code, ct.display_name,
                v.city, v.state, v.primary_phone, v.website_url, v.email,
                v.vendor_score, v.score_tier, v.is_licensed, v.is_insured,
                v.is_background_checked, v.years_in_business, v.employee_count_range,
                v.service_radius_miles, v.bbb_accredited, v.bbb_rating, v.is_onboarded,
                vs.quality_score, vs.compliance_score, vs.reputation_score
       ORDER BY v.is_onboarded DESC, v.vendor_score DESC NULLS LAST`,
      [codes]
    );
    res.json({ vendors: vendorRes.rows, categories });
  } finally { client.release(); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Global error handler — always returns JSON so the client never hangs ──────
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Vendora API running on http://localhost:${PORT}`));
