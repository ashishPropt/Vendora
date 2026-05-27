/**
 * Vendora Admin API
 *   POST /admin/login              — get an 8-hour admin JWT
 *   GET  /admin/vendors            — search vendors (state filter, pagination)
 *   POST /admin/call-vendor        — initiate an AI outreach call via Vapi
 *   GET  /admin/call-status/:id    — poll call status
 *   POST /admin/call-outcome       — Vapi webhook (no JWT auth)
 */
import { Router }      from 'express';
import { pool }        from '../db.js';
import jwt             from 'jsonwebtoken';
import { randomBytes } from 'crypto';

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vendora-admin-2026';
const JWT_SECRET     = process.env.JWT_SECRET      || 'vendora-jwt-prod-2026-leaseloft';

export function requireAdminJwt(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Admin authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Not an admin token' });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
  }
}

// ── POST /admin/login ─────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// ── GET /admin/vendors ────────────────────────────────────────────────────────
router.get('/vendors', requireAdminJwt, async (req, res) => {
  const state     = (req.query.state    || '').trim().toUpperCase();
  const onboarded =  req.query.onboarded || 'false';
  const search    = (req.query.search   || '').trim();
  const page      = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit     = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10)));
  const offset    = (page - 1) * limit;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (state)                         { conditions.push(`v.state = $${p++}`);              params.push(state); }
  if (onboarded === 'false')           conditions.push('v.is_onboarded = false');
  else if (onboarded === 'true')       conditions.push('v.is_onboarded = true');
  if (search)                        { conditions.push(`v.canonical_name ILIKE $${p++}`); params.push(`%${search}%`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const client = await pool.connect();
  try {
    const [dataRes, countRes] = await Promise.all([
      client.query(
        `SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                v.primary_phone, v.website_url, v.is_onboarded, v.is_licensed,
                vc.display_name  AS category_display_name,
                v.vendor_score, v.score_tier,
                vi.token         AS invite_token,
                vi.expires_at    AS invite_expires,
                vi.used_at       AS invite_used,
                lc.outcome       AS last_call_outcome,
                lc.status        AS last_call_status,
                lc.initiated_at  AS last_call_at,
                lc.invite_sent   AS last_call_invite_sent
         FROM vendors v
         LEFT JOIN category_taxonomy vc ON vc.category_code = v.primary_category_code
         LEFT JOIN vendor_invites   vi ON vi.vendor_id = v.vendor_id
         LEFT JOIN LATERAL (
           SELECT outcome, status, initiated_at, invite_sent
           FROM vendor_calls
           WHERE vendor_id = v.vendor_id
           ORDER BY initiated_at DESC LIMIT 1
         ) lc ON true
         ${where}
         ORDER BY v.canonical_name
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      client.query(`SELECT COUNT(*) FROM vendors v ${where}`, params),
    ]);

    res.json({
      vendors: dataRes.rows,
      total:   parseInt(countRes.rows[0].count, 10),
      page,
      limit,
    });
  } finally { client.release(); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function toE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function buildSystemPrompt(vendor) {
  const category = vendor.category_display_name || 'service';
  const city     = vendor.city  || 'your area';
  const state    = vendor.state || '';
  const name     = vendor.canonical_name;

  return `You are Alex, a friendly outreach coordinator for Vendora — a platform that connects property managers with trusted local service vendors.

You are calling ${name}, a ${category} business in ${city}${state ? ', ' + state : ''}.

HOW VENDORA WORKS FOR VENDORS:
• Property managers post maintenance jobs → Vendora matches them with local vendors like ${name}
• Vendors choose which jobs to quote — no obligation, full control over schedule
• Vendora guarantees payment — no more chasing invoices
• Zero upfront cost — Vendora takes a small commission only when a job is completed and paid
• Active vendors typically receive 3–8 new local job leads per month

YOUR CONVERSATION STYLE:
• Warm, natural, professional — NOT robotic or scripted-sounding
• Keep every response SHORT (2–3 sentences max) — listen more than you talk
• Use natural fillers and acknowledgments ("Got it", "That makes sense", "Absolutely")
• Reference their specific trade and city to make the conversation feel local and personal
• Never read out a list — weave information into natural dialogue

OPENING:
"Hi, is this ${name}? Great — my name's Alex, I'm calling from Vendora. We help connect ${category} businesses with property managers who need work in the ${city} area. Do you have just a minute?"

IF BUSY / BAD TIME:
"Of course, I'm sorry to catch you at a bad time. Is there a better time I could call back?"

OBJECTION HANDLING (natural responses, not scripted):
• "Already have enough work" → Acknowledge positively: "That's great to hear! A lot of our vendors use us to fill their slower periods — and you control your own availability, so you can pause anytime."
• "How much does it cost?" → "Nothing upfront at all. We only earn a small percentage when a job is completed and paid — no monthly fees, no subscription."
• "Need to think about it / talk to partner" → "Totally understand — no rush at all. Would it help if I sent over a quick info link? No commitment needed."
• "Sounds like a scam" → "I completely understand the skepticism — there are a lot of those calls out there. Happy to give you our website so you can look us up first."
• "Not interested" → "No problem at all, I appreciate your time. Would it be alright if we reached out again in a few months in case things change?"

WHEN THEY SHOW INTEREST — ASK FOR CONTACT INFO:
"That's great to hear! The easiest next step is I can send you a sign-up link — your business info will already be pre-filled so it only takes about 5 minutes. What's the best email or phone number to send that to?"

ENDING THE CALL:
Always end politely and naturally regardless of outcome. Your final response should be a genuine, warm goodbye.

IMPORTANT: Keep responses conversational and brief. This is a phone call, not an email.`;
}

// ── POST /admin/call-vendor ───────────────────────────────────────────────────
router.post('/call-vendor', requireAdminJwt, async (req, res) => {
  const { vendor_id } = req.body || {};
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });

  const VAPI_KEY       = process.env.VAPI_API_KEY;
  const VAPI_PHONE_ID  = process.env.VAPI_PHONE_NUMBER_ID;
  const PUBLIC_URL     = (process.env.PUBLIC_URL || 'http://45.77.79.14').replace(/\/$/, '');
  const WH_SECRET      = process.env.VAPI_WEBHOOK_SECRET || 'vendora-vapi-hook-2026';
  const VOICE_ID       = process.env.VAPI_ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

  if (!VAPI_KEY)      return res.status(503).json({ error: 'VAPI_API_KEY not set in config.env' });
  if (!VAPI_PHONE_ID) return res.status(503).json({ error: 'VAPI_PHONE_NUMBER_ID not set in config.env' });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT v.vendor_id, v.canonical_name, v.primary_phone, v.city, v.state,
              ct.display_name AS category_display_name
       FROM vendors v
       LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
       WHERE v.vendor_id = $1`,
      [vendor_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vendor not found' });
    const vendor = rows[0];

    const e164 = toE164(vendor.primary_phone);
    if (!e164) return res.status(400).json({
      error: `Cannot parse phone "${vendor.primary_phone}" into a dialable number. Update it in the vendor record first.`,
    });

    // Use the pre-configured Vapi assistant, override only the dynamic per-vendor fields
    const vapiPayload = {
      assistantId:   '63ff5b64-4ea9-4e11-98e5-fdd8efb085c2',
      phoneNumberId: VAPI_PHONE_ID,
      customer:      { number: e164, name: vendor.canonical_name },
      assistantOverrides: {
        // Inject vendor-specific context into the system prompt
        model: {
          messages: [{ role: 'system', content: buildSystemPrompt(vendor) }],
        },
        // Personalised opening line for this vendor
        firstMessage: `Hi, is this ${vendor.canonical_name}? Great — my name's Alex, I'm calling from Vendora. We help connect ${vendor.category_display_name || 'service'} businesses with property managers who need work in the ${vendor.city || 'local'} area. Do you have just a minute?`,
        // Webhook back to this server
        serverUrl:       `${PUBLIC_URL}/admin/call-outcome`,
        serverUrlSecret: WH_SECRET,
      },
    };

    // Fire call
    const vapiRes  = await fetch('https://api.vapi.ai/call', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VAPI_KEY}` },
      body:    JSON.stringify(vapiPayload),
    });
    const vapiData = await vapiRes.json();
    if (!vapiRes.ok) {
      console.error('[vapi] call failed:', vapiData);
      return res.status(502).json({ error: vapiData.message || vapiData.error || 'Vapi rejected the call request' });
    }

    // Persist call record
    const { rows: cr } = await client.query(
      `INSERT INTO vendor_calls (vendor_id, vapi_call_id, phone_dialed, initiated_by, status)
       VALUES ($1, $2, $3, 'admin', 'initiated')
       RETURNING call_id, initiated_at`,
      [vendor_id, vapiData.id, e164]
    );

    res.json({
      call_id:      cr[0].call_id,
      vapi_call_id: vapiData.id,
      vendor_name:  vendor.canonical_name,
      phone_dialed: e164,
      status:       'initiated',
    });
  } finally { client.release(); }
});

// ── GET /admin/call-status/:call_id ──────────────────────────────────────────
router.get('/call-status/:call_id', requireAdminJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT vc.*, v.canonical_name
       FROM vendor_calls vc
       JOIN vendors v ON v.vendor_id = vc.vendor_id
       WHERE vc.call_id = $1`,
      [req.params.call_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Call not found' });
    res.json(rows[0]);
  } finally { client.release(); }
});

// ── POST /admin/call-outcome  (Vapi webhook — verified by shared secret) ──────
router.post('/call-outcome', async (req, res) => {
  const incomingSecret = req.headers['x-vapi-secret'];
  const WH_SECRET      = process.env.VAPI_WEBHOOK_SECRET || 'vendora-vapi-hook-2026';

  if (incomingSecret !== WH_SECRET) {
    console.warn('[vapi-webhook] invalid or missing secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Acknowledge immediately so Vapi doesn't retry
  res.json({ received: true });

  const msg = req.body?.message;
  if (!msg) return;

  const vapiCallId = msg.call?.id;
  if (!vapiCallId) return;

  const client = await pool.connect();
  try {
    // ── Status-update events (ringing, in-progress, etc.) ─────────────────────
    if (msg.type === 'status-update') {
      const map = {
        queued:        'initiated',
        ringing:       'ringing',
        'in-progress': 'in_progress',
        forwarding:    'in_progress',
        ended:         'ended',
      };
      await client.query(
        `UPDATE vendor_calls SET status = $1 WHERE vapi_call_id = $2`,
        [map[msg.status] || msg.status, vapiCallId]
      );
      return;
    }

    // ── End-of-call report ────────────────────────────────────────────────────
    if (msg.type === 'end-of-call-report') {
      const analysis    = msg.analysis        || {};
      const structured  = analysis.structuredData || {};
      const outcome     = structured.outcome   || 'FAILED';
      const summary     = analysis.summary     || msg.summary    || '';
      const notes       = structured.notes     || '';
      const callbackTime = structured.callbackTime || null;
      const contactInfo  = structured.contactInfo  || null;
      const transcript   = msg.transcript      || '';

      const { rows } = await client.query(
        `UPDATE vendor_calls
         SET status        = 'completed',
             outcome       = $1,
             summary       = $2,
             transcript    = $3,
             callback_time = $4,
             contact_info  = $5,
             ended_at      = NOW()
         WHERE vapi_call_id = $6
         RETURNING call_id, vendor_id`,
        [outcome, summary || notes, transcript, callbackTime, contactInfo, vapiCallId]
      );

      if (!rows.length) {
        console.warn('[vapi-webhook] no call record found for', vapiCallId);
        return;
      }

      const { call_id, vendor_id } = rows[0];

      // Auto-generate invite for interested vendors
      if (outcome === 'INTERESTED') {
        const token = randomBytes(32).toString('hex');
        await client.query(
          `INSERT INTO vendor_invites (vendor_id, token, invited_by)
           VALUES ($1, $2, 'auto-call')
           ON CONFLICT (vendor_id) DO UPDATE
             SET token      = EXCLUDED.token,
                 invited_by = EXCLUDED.invited_by,
                 created_at = NOW(),
                 expires_at = NOW() + INTERVAL '30 days',
                 used_at    = NULL`,
          [vendor_id, token]
        );
        await client.query(
          `UPDATE vendor_calls SET invite_sent = true WHERE call_id = $1`,
          [call_id]
        );
        const PUBLIC_URL  = (process.env.PUBLIC_URL || 'http://45.77.79.14').replace(/\/$/, '');
        const inviteUrl   = `${PUBLIC_URL}/onboard.html?invite=${token}`;
        console.log(`[vapi] INTERESTED: vendor ${vendor_id} — invite URL: ${inviteUrl}`);
        if (contactInfo) console.log(`[vapi] Vendor contact for invite delivery: ${contactInfo}`);
      }

      console.log(`[vapi] call ${vapiCallId} → outcome: ${outcome} | summary: ${summary.slice(0, 80)}`);
    }
  } catch (err) {
    console.error('[vapi-webhook] error processing event:', err.message);
  } finally { client.release(); }
});

export default router;
