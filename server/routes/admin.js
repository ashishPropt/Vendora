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
import { sendJobDetailsEmail, buildQuoteCallPrompt, expandAddress } from './public.js';


/** Send SMS via Twilio */
async function sendSmsJobDetails({ toPhone, vendorName, job, inviteUrl }) {
  const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER || '+18339182576';
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    console.log('[sms] Twilio creds not set — skipping SMS to', toPhone);
    return { sent: false, reason: 'no_twilio_creds' };
  }
  const body = [
    `Hi ${vendorName}! Alex from LeaseLoft here.`,
    `We have a ${job.category_label || job.categoryLabel || 'service'} job in ${job.city || job.address}:`,
    job.description ? job.description.slice(0, 120) : '',
    `Sign up free & submit your quote: ${inviteUrl}`,
    `Questions? Reply to this text.`,
  ].filter(Boolean).join('\n');
  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
        body: new URLSearchParams({ From: TWILIO_FROM, To: toPhone, Body: body }).toString(),
      }
    );
    const data = await r.json();
    if (r.ok) {
      console.log(`[sms] Sent to ${toPhone} — Twilio SID: ${data.sid}`);
      return { sent: true, sid: data.sid };
    }
    console.error('[sms] Twilio error:', data.message);
    return { sent: false, reason: data.message };
  } catch (e) {
    console.error('[sms] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

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

// ── Vendor lifecycle status ─────────────────────────────────────────────────
// Derives a single human-readable status from existing vendor/invite/call data.
// Requires the query to LEFT JOIN:
//   vendor_invites vi ON vi.vendor_id = v.vendor_id
//   LATERAL (SELECT outcome, call_id FROM vendor_calls WHERE vendor_id = v.vendor_id
//            AND quote_request_id IS NULL ORDER BY initiated_at DESC LIMIT 1) lc ON true
const LIFECYCLE_STATUS_SQL = `
  CASE
    WHEN v.is_test_vendor THEN 'test'
    WHEN NOT v.is_active THEN 'inactive'
    WHEN v.is_onboarded THEN 'onboarded'
    WHEN vi.invite_id IS NOT NULL AND vi.used_at IS NULL AND vi.expires_at > NOW() THEN 'invited'
    WHEN lc.outcome IN ('INTERESTED_EMAIL','COMPLETED') THEN 'interested'
    WHEN lc.outcome = 'INTERESTED_CALLBACK' THEN 'callback'
    WHEN lc.outcome = 'NOT_INTERESTED' THEN 'declined'
    WHEN lc.outcome IN ('NO_ANSWER','VOICEMAIL','UNKNOWN','FAILED','BLOCKED') THEN 'unreachable'
    WHEN lc.call_id IS NOT NULL THEN 'contacted'
    ELSE 'prospect'
  END`;

const LIFECYCLE_JOINS = `
  LEFT JOIN vendor_invites vi ON vi.vendor_id = v.vendor_id
  LEFT JOIN LATERAL (
    SELECT outcome, call_id, status, initiated_at
    FROM vendor_calls
    WHERE vendor_id = v.vendor_id AND quote_request_id IS NULL
    ORDER BY initiated_at DESC LIMIT 1
  ) lc ON true`;

const VALID_STATUSES = ['prospect','contacted','interested','callback','declined','unreachable','invited','onboarded','test','inactive'];

router.get('/vendors', requireAdminJwt, async (req, res) => {
  const state     = (req.query.state    || '').trim().toUpperCase();
  const search    = (req.query.search   || '').trim();
  const page      = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit     = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10)));
  const offset    = (page - 1) * limit;

  // `status` replaces the old `onboarded` filter. Accepts any value from
  // VALID_STATUSES, 'all', or — for backwards compatibility — 'true'/'false'.
  let status = (req.query.status || req.query.onboarded || '').trim().toLowerCase();
  if (status === 'true')  status = 'onboarded';
  if (status === 'false') status = ''; // "not yet onboarded" → no filter (was the old default)
  if (status === 'all')   status = '';
  if (status && !VALID_STATUSES.includes(status)) status = '';

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (state)  { conditions.push(`v.state = $${p++}`);              params.push(state); }
  if (search) { conditions.push(`v.canonical_name ILIKE $${p++}`); params.push(`%${search}%`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Wrap in a CTE so we can filter on the computed lifecycle_status.
  let statusFilter = '';
  if (status) { params.push(status); statusFilter = `WHERE lifecycle_status = $${p++}`; }

  const client = await pool.connect();
  try {
    const [dataRes, countRes] = await Promise.all([
      client.query(
        `WITH base AS (
           SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                  v.primary_phone, v.website_url, v.is_onboarded, v.is_licensed,
                  v.is_test_vendor,
                  vc.display_name  AS category_display_name,
                  v.vendor_score, v.score_tier,
                  vi.token         AS invite_token,
                  vi.expires_at    AS invite_expires,
                  vi.used_at       AS invite_used,
                  lc.outcome       AS last_call_outcome,
                  lc.status        AS last_call_status,
                  lc.initiated_at  AS last_call_at,
                  ${LIFECYCLE_STATUS_SQL} AS lifecycle_status
           FROM vendors v
           LEFT JOIN category_taxonomy vc ON vc.category_code = v.primary_category_code
           ${LIFECYCLE_JOINS}
           ${where}
         )
         SELECT * FROM base
         ${statusFilter}
         ORDER BY canonical_name
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      client.query(
        `WITH base AS (
           SELECT v.vendor_id, ${LIFECYCLE_STATUS_SQL} AS lifecycle_status
           FROM vendors v
           ${LIFECYCLE_JOINS}
           ${where}
         )
         SELECT COUNT(*) FROM base ${statusFilter}`,
        params
      ),
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
• If interrupted mid-sentence: stop, listen fully, answer their point directly, then continue naturally

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

    const category = vendor.category_display_name || 'service';
    const city     = vendor.city || 'your area';
    const name     = vendor.canonical_name;

    const onboardingPrompt = `You are Alex, a friendly outreach coordinator for Vendora — a platform that connects property managers with local service vendors.

You are calling ${name}, a ${category} business in ${city}.

YOUR ONLY GOAL: Introduce Vendora, see if they're interested, and get their email to send a sign-up link. Nothing else.

HOW VENDORA WORKS (one sentence): "Property managers post jobs, we match them with local vendors, you quote the jobs you want, and Vendora guarantees payment — no chasing invoices."

CONVERSATION RULES:
• Max 2 sentences per response. No lists. No speeches.
• ONE question per turn — never stack questions.
• If interrupted mid-sentence: stop immediately, listen to what they say, answer their point directly, then continue naturally. Do not restart or lose your place.
• Do NOT ask if they are "the decision maker" or "the right person." They answered the phone; talk to them.
• If they're interested, go straight to getting their email.
• If they're not interested, thank them and end the call.

OPENING — wait for them to confirm they are ${name}, then:
"Great — my name's Alex, I'm calling from Vendora. We connect ${category.toLowerCase()} businesses with property managers who need work in the ${city} area — would you be open to hearing about job opportunities from them?"

IF INTERESTED:
"Perfect — what's the best email to send you a sign-up link? It only takes about 5 minutes and there's no cost."
→ Repeat the email back once to confirm, then wrap up.

IF NOT INTERESTED / BUSY:
"No problem at all — thanks for your time, have a great day!"
→ END the call immediately.

IF THEY WANT A CALLBACK:
"Of course — I'll have someone follow up. Take care!"
→ END the call immediately.

COMMON OBJECTIONS (one short response each):
• "Already have enough work" → "That's great to hear! A lot of vendors use us to fill slower periods — you control your own availability and can pause any time."
• "How much does it cost?" → "Nothing upfront. We only earn a small percentage when a job is completed and paid — no monthly fees."
• "Not interested" → "No problem at all — thanks for your time, have a great day!" → END.

=== ENDING THE CALL ===
The moment the conversation is done — say ONE closing line and STOP COMPLETELY:
• Email confirmed: "Perfect, I'll send that right over — thanks so much, have a great day!"
• Declined: "No problem at all — thanks for your time, have a great day!"
• Callback: "Sounds good — we'll follow up then, take care!"
• Voicemail: End your brief message with "...thanks, have a great day!"

Say your closing line ONCE, word for word, with NOTHING added after it. Do not say "alright", "okay", "sure", or any filler. Do not repeat yourself. One line, then silence — the call ends.`;

    const vapiPayload = {
      phoneNumberId: VAPI_PHONE_ID.trim(),
      customer:      { number: e164, name },
      assistant: {
        firstMessage: `Hi, is this ${name}?`,
        model: {
          provider:    'anthropic',
          model:       'claude-haiku-4-5-20251001',
          messages:    [{ role: 'system', content: onboardingPrompt }],
          temperature: 0.65,
        },
        voice: {
          provider: '11labs',
          voiceId:  VOICE_ID,
          model:    'eleven_turbo_v2_5',
          stability: 0.75, similarityBoost: 0.75, style: 0.0,  useSpeakerBoost: false,
        },
        endCallFunctionEnabled: true,
        backgroundSound:   'off',
        stopSpeakingPlan:  { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1.0 },
        silenceTimeoutSeconds:  8,
        maxDurationSeconds:     300,
        endCallPhrases: [
          'have a great day', 'thanks so much, have a great day',
          'thanks for your time, have a great day', 'take care',
          'have someone follow up', 'goodbye', 'good bye', 'bye bye',
        ],
        endCallMessage: "Thanks so much for your time — have a great day!",
        transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en-US' },
        analysisPlan: {
          summaryPrompt: 'Summarize in 2 sentences: how did the vendor respond to the Vendora pitch and what is the next step?',
          structuredDataSchema: {
            type: 'object',
            properties: {
              outcome:       { type: 'string', enum: ['INTERESTED_EMAIL','INTERESTED_CALLBACK','NOT_INTERESTED','VOICEMAIL','NO_ANSWER'] },
              vendor_email:  { type: 'string', description: 'Email if vendor wants the sign-up link sent' },
              callback_time: { type: 'string', description: 'Preferred callback time if requested' },
              notes:         { type: 'string' },
            },
            required: ['outcome'],
          },
        },
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

// ── POST /admin/call-vendor-quote ─────────────────────────────────────────────
// Fires a test "quote request" outreach call (same assistant shape as the
// [v3-quote] flow used by POST /v3/vendors/search&get_quotes=true), using a
// synthetic test job so admins can preview the quote-request script.
router.post('/call-vendor-quote', requireAdminJwt, async (req, res) => {
  const {
    vendor_id,
    description     = null,
    address          = null,
    urgency          = 'normal',
    property_type    = 'apartment',
    unit_number      = null,
    requester_name   = 'Vendora Admin (Test)',
  } = req.body || {};
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });

  const VAPI_KEY       = process.env.VAPI_API_KEY;
  const VAPI_PHONE_ID  = process.env.VAPI_PHONE_NUMBER_ID;
  const PUBLIC_URL     = (process.env.PUBLIC_URL || 'https://vendora.leaseloft.ai').replace(/\/$/, '');
  const WH_SECRET      = process.env.VAPI_WEBHOOK_SECRET || 'vendora-vapi-hook-2026';
  const VOICE_ID       = process.env.VAPI_ELEVENLABS_VOICE_ID || 'dN8hviqdNrAsEcL57yFj';

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

    const categoryLabel = vendor.category_display_name || 'service';
    const cityState     = [vendor.city, vendor.state].filter(Boolean).join(', ') || 'your area';
    const jobDescription = (description && description.trim()) ||
      `A property manager needs ${categoryLabel.toLowerCase()} work done at a residential property — this is a test call to preview the quote-request script.`;
    const jobAddress = (address && address.trim()) || cityState;

    const jobBase = {
      categoryLabel,
      address:       expandAddress(unit_number ? `${jobAddress}, ${unit_number}` : jobAddress),
      unitNumber:    unit_number,
      city:          expandAddress(vendor.city || jobAddress),
      description:   jobDescription,
      propertyType:  property_type,
      urgency,
      requesterName: requester_name,
    };

    // Tag this as a test quote request so it's excluded from the real
    // [v3-quote] 24-hour cooldown (which only checks initiated_by = 'quote-request').
    const { rows: [qr] } = await client.query(
      `INSERT INTO quote_requests
         (category_label, address, city, state, description, property_type, urgency, unit_number, requester_name, vendors_called, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'admin-test')
       RETURNING quote_request_id`,
      [categoryLabel, jobAddress, vendor.city || null, vendor.state || null,
       jobDescription, property_type, urgency, unit_number, requester_name]
    );
    const quoteRequestId = qr.quote_request_id;

    const systemPrompt = buildQuoteCallPrompt(vendor, jobBase);
    const hour = new Date().getUTCHours() - 5;
    const greeting = hour < 0 ? 'evening' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

    const vapiPayload = {
      phoneNumberId: VAPI_PHONE_ID.trim(),
      customer: { number: e164, name: vendor.canonical_name.slice(0, 40) },
      assistant: {
        firstMessage: `Good ${greeting}! Is this ${vendor.canonical_name.slice(0, 50)}?`,
        model: {
          provider: 'anthropic',
          model:    'claude-haiku-4-5-20251001',
          messages: [{ role: 'system', content: systemPrompt }],
          temperature: 0.65,
        },
        voice: {
          provider: '11labs',
          voiceId:  VOICE_ID,
          model:    'eleven_turbo_v2_5',
          stability: 0.75, similarityBoost: 0.75, style: 0.0,  useSpeakerBoost: false,
        },
        endCallFunctionEnabled: true,
        backgroundSound:   'off',
        stopSpeakingPlan:  { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1.0 },
        silenceTimeoutSeconds: 8,
        maxDurationSeconds: 300,
        endCallPhrases: [
          'have a great day', 'thanks so much, have a great day',
          'thanks for your time, have a great day', 'take care',
          'have someone follow up', 'goodbye', 'good bye', 'bye bye',
        ],
        endCallMessage: "Thanks so much for your time — have a great day!",
        transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en-US' },
        analysisPlan: {
          summaryPrompt: 'Summarize in 2 sentences: what job was offered, and what did the vendor say?',
          structuredDataSchema: {
            type: 'object',
            properties: {
              outcome:        { type: 'string', enum: ['INTERESTED_EMAIL','INTERESTED_CALLBACK','NOT_INTERESTED','VOICEMAIL','NO_ANSWER'] },
              vendor_email:   { type: 'string' },
              quote_estimate: { type: 'string' },
              callback_time:  { type: 'string' },
            },
            required: ['outcome'],
          },
        },
      },
    };

    const vapiRes  = await fetch('https://api.vapi.ai/call', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VAPI_KEY}` },
      body:    JSON.stringify(vapiPayload),
    });
    const vapiData = await vapiRes.json();
    if (!vapiRes.ok) {
      console.error('[vapi] quote test call failed:', vapiData);
      const vapiErrMsg = Array.isArray(vapiData.message)
        ? vapiData.message.join('; ')
        : (vapiData.message || vapiData.error || 'Vapi rejected the call request');
      return res.status(502).json({ error: vapiErrMsg });
    }

    const { rows: cr } = await client.query(
      `INSERT INTO vendor_calls (vendor_id, vapi_call_id, phone_dialed, initiated_by, status, quote_request_id)
       VALUES ($1, $2, $3, 'quote-request-test', 'initiated', $4)
       RETURNING call_id, initiated_at`,
      [vendor_id, vapiData.id, e164, quoteRequestId]
    );

    res.json({
      call_id:      cr[0].call_id,
      vapi_call_id: vapiData.id,
      vendor_name:  vendor.canonical_name,
      phone_dialed: e164,
      status:       'initiated',
      call_type:    'quote',
    });
  } finally { client.release(); }
});

// ── GET /admin/call-status/:call_id ──────────────────────────────────────────
// When the call is still in-flight and no webhook is configured, poll Vapi
// directly so we always return the latest status.
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
    const row = rows[0];

    // If call is still open, sync status from Vapi so the UI doesn't stay stuck
    const openStatuses = ['initiated', 'ringing', 'in_progress'];
    if (row.vapi_call_id && openStatuses.includes(row.status)) {
      try {
        const VAPI_KEY = process.env.VAPI_API_KEY;
        const vapiRes  = await fetch(`https://api.vapi.ai/call/${row.vapi_call_id}`, {
          headers: { Authorization: `Bearer ${VAPI_KEY}` },
        });
        if (vapiRes.ok) {
          const vc = await vapiRes.json();
          const statusMap = {
            queued:        'initiated',
            ringing:       'ringing',
            'in-progress': 'in_progress',
            forwarding:    'in_progress',
            ended:         'ended',
          };
          const newStatus  = statusMap[vc.status] || vc.status || row.status;
          const analysis   = vc.analysis || {};
          const structured = analysis.structuredData || {};
          // Map Vapi's endedReason to a sensible outcome when structured analysis is missing
          let outcome = structured.outcome || null;
          if (!outcome && vc.status === 'ended') {
            const reason = vc.endedReason || '';
            if (/voicemail/i.test(reason))                         outcome = 'VOICEMAIL';
            else if (/no-answer|silence|timeout/i.test(reason))   outcome = 'NO_ANSWER';
            else if (/customer-busy|error-get-transport|call\.start\.error/i.test(reason)) outcome = 'BLOCKED';
            else if (/customer-ended|hangup/i.test(reason))       outcome = 'COMPLETED';
            else if (/assistant-ended/i.test(reason))             outcome = 'COMPLETED';
            else                                                   outcome = 'COMPLETED';
          }
          const summary    = analysis.summary   || vc.summary || null;
          const transcript = vc.transcript      || null;

          if (vc.status === 'ended') {
            await client.query(
              `UPDATE vendor_calls
               SET status = 'completed', outcome = COALESCE($1, outcome),
                   summary = COALESCE($2, summary), transcript = COALESCE($3, transcript),
                   ended_at = NOW()
               WHERE call_id = $4`,
              [outcome, summary, transcript, row.call_id]
            );
            row.status   = 'completed';
            row.outcome  = outcome  || row.outcome;
            row.summary  = summary  || row.summary;
          } else if (newStatus !== row.status) {
            await client.query(
              `UPDATE vendor_calls SET status = $1 WHERE call_id = $2`,
              [newStatus, row.call_id]
            );
            row.status = newStatus;
          }
        }
      } catch (e) {
        console.warn('[call-status] vapi sync failed:', e.message);
      }
    }

    res.json(row);
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
      const analysis     = msg.analysis           || {};
      const structured   = analysis.structuredData || {};
      const _endedReason  = msg.call?.endedReason || '';
      const outcome      = /customer-busy|error-get-transport|call\.start\.error/i.test(_endedReason)
                         ? 'BLOCKED'
                         : (structured.outcome || 'FAILED');
      const summary      = analysis.summary        || msg.summary || '';
      const notes        = structured.notes        || '';
      const callbackTime = structured.callback_time || structured.callbackTime || null;
      const contactInfo  = structured.contactInfo  || null;
      const vendorEmail  = structured.vendor_email || null;
      const quoteEstimate = structured.quote_estimate || null;
      // Vapi transcription is async — transcript may be in artifact or arrive late.
      // Try all known locations; schedule a delayed Vapi API fetch as fallback.
      const transcript   = msg.transcript
                        || msg.artifact?.transcript
                        || msg.call?.transcript
                        || '';

      const { rows } = await client.query(
        `UPDATE vendor_calls
         SET status         = 'completed',
             outcome        = $1,
             summary        = $2,
             transcript     = $3,
             callback_time  = $4,
             contact_info   = $5,
             vendor_email   = COALESCE($6, vendor_email),
             quote_estimate = COALESCE($7, quote_estimate),
             ended_at       = NOW()
         WHERE vapi_call_id = $8
         RETURNING call_id, vendor_id, quote_request_id`,
        [outcome, summary || notes, transcript, callbackTime, contactInfo,
         vendorEmail, quoteEstimate, vapiCallId]
      );

      if (!rows.length) {
        console.warn('[vapi-webhook] no call record found for', vapiCallId);
        return;
      }

      const { call_id, vendor_id, quote_request_id } = rows[0];

      // If transcript was empty, schedule a delayed fetch from Vapi API
      // (transcription typically completes 20-60s after the call ends)
      if (!transcript) {
        setTimeout(async () => {
          try {
            const vapiRes = await fetch(`https://api.vapi.ai/call/${vapiCallId}`, {
              headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
            });
            if (!vapiRes.ok) return;
            const vc = await vapiRes.json();
            const delayed = vc.transcript || vc.artifact?.transcript || null;
            if (delayed) {
              const c2 = await pool.connect();
              try {
                await c2.query(
                  `UPDATE vendor_calls SET transcript = $1 WHERE call_id = $2 AND (transcript IS NULL OR transcript = '')`,
                  [delayed, call_id]
                );
                console.log(`[vapi-webhook] delayed transcript saved for ${call_id} (${delayed.length} chars)`);
              } finally { c2.release(); }
            }
          } catch (e) {
            console.warn('[vapi-webhook] delayed transcript fetch failed:', e.message);
          }
        }, 45_000);
      }
      const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://vendora.leaseloft.ai').replace(/\/$/, '');

      // ── Generate invite token for any interested vendor ────────────────────
      const isInterested = outcome === 'INTERESTED' || outcome === 'INTERESTED_EMAIL'
                        || outcome === 'INTERESTED_CALLBACK';

      let inviteUrl = null;
      if (isInterested) {
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
          `UPDATE vendor_calls SET invite_sent = true WHERE call_id = $1`, [call_id]
        );
        inviteUrl = `${PUBLIC_URL}/onboard.html?invite=${token}`;
        console.log(`[vapi] ${outcome}: vendor ${vendor_id} — invite URL: ${inviteUrl}`);
      }

      // ── Quote-call specific: send job-details email ────────────────────────
      if (outcome === 'INTERESTED_EMAIL' && vendorEmail && quote_request_id) {
        try {
          // Fetch job details and vendor name
          const [jobRes, vendorRes] = await Promise.all([
            client.query(
              `SELECT category_label, address, city, description, property_type,
                      urgency, unit_number, requester_name
               FROM quote_requests WHERE quote_request_id = $1`,
              [quote_request_id]
            ),
            client.query(
              `SELECT canonical_name FROM vendors WHERE vendor_id = $1`, [vendor_id]
            ),
          ]);

          if (jobRes.rows.length && vendorRes.rows.length) {
            const job = jobRes.rows[0];
            await sendJobDetailsEmail({
              vendorEmail,
              vendorName: vendorRes.rows[0].canonical_name,
              inviteUrl:  inviteUrl || `${PUBLIC_URL}/onboard.html`,
              job: {
                categoryLabel: job.category_label,
                address:       job.address,
                unitNumber:    job.unit_number,
                city:          job.city,
                description:   job.description,
                propertyType:  job.property_type,
                urgency:       job.urgency,
                requesterName: job.requester_name,
              },
            });
          }

          // Update quote_request_vendors row with the email
          await client.query(
            `UPDATE quote_request_vendors
             SET status = 'interested', vendor_email = $1
             WHERE quote_request_id = $2 AND vendor_id = $3`,
            [vendorEmail, quote_request_id, vendor_id]
          );

          // Bump the quotes_received counter on the request
          await client.query(
            `UPDATE quote_requests
             SET quotes_received = quotes_received + 1, updated_at = NOW()
             WHERE quote_request_id = $1`,
            [quote_request_id]
          );
        } catch (emailErr) {
          console.error('[vapi-webhook] email send failed:', emailErr.message);
        }
      }

      // ── SMS: vendor asked to be texted instead ───────────────────────────
      const smsPhone = structured.sms_phone || null;
      if (smsPhone && quote_request_id) {
        try {
          const [jobRes2, vendorRes2] = await Promise.all([
            client.query(
              `SELECT category_label, address, city, description FROM quote_requests WHERE quote_request_id = $1`,
              [quote_request_id]
            ),
            client.query(`SELECT canonical_name FROM vendors WHERE vendor_id = $1`, [vendor_id]),
          ]);
          if (jobRes2.rows.length && vendorRes2.rows.length) {
            const smsInvite = inviteUrl || `${PUBLIC_URL}/onboard.html`;
            await sendSmsJobDetails({
              toPhone:    smsPhone,
              vendorName: vendorRes2.rows[0].canonical_name,
              job:        jobRes2.rows[0],
              inviteUrl:  smsInvite,
            });
          }
        } catch (smsErr) {
          console.error('[vapi-webhook] SMS send failed:', smsErr.message);
        }
      }

      // ── Legacy INTERESTED outcome (admin cold-call) ────────────────────────
      if (outcome === 'INTERESTED' && contactInfo)
        console.log(`[vapi] Vendor contact for invite delivery: ${contactInfo}`);

      console.log(`[vapi] call ${vapiCallId} → ${outcome} | ${summary.slice(0, 80)}`);
    }
  } catch (err) {
    console.error('[vapi-webhook] error processing event:', err.message);
  } finally { client.release(); }
});


// ── GET /admin/invite-requests ────────────────────────────────────────────────
router.get('/invite-requests', requireAdminJwt, async (req, res) => {
  const status = req.query.status || 'pending';
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT r.request_id, r.vendor_id, r.requester_name, r.requester_email,
              r.requester_phone, r.message, r.status, r.requested_at, r.reviewed_at,
              v.canonical_name
       FROM vendor_invite_requests r
       JOIN vendors v ON v.vendor_id = r.vendor_id
       WHERE ($1 = 'all' OR r.status = $1)
       ORDER BY r.requested_at DESC`,
      [status]
    );
    res.json({ requests: rows });
  } finally { client.release(); }
});

// ── POST /admin/invite-requests/:id/approve ───────────────────────────────────
router.post('/invite-requests/:id/approve', requireAdminJwt, async (req, res) => {
  const { id } = req.params;
  const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://45.77.79.14').replace(/\/$/, '');
  const client = await pool.connect();
  try {
    // Fetch the request
    const { rows: rr } = await client.query(
      `SELECT r.*, v.canonical_name FROM vendor_invite_requests r
       JOIN vendors v ON v.vendor_id = r.vendor_id
       WHERE r.request_id = $1`,
      [id]
    );
    if (!rr.length) return res.status(404).json({ error: 'Request not found' });
    const req2 = rr[0];
    if (req2.status !== 'pending') return res.status(409).json({ error: 'Request is no longer pending' });

    // Generate invite token
    const token = randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO vendor_invites (vendor_id, token, invited_by)
       VALUES ($1, $2, 'admin-approved-request')
       ON CONFLICT (vendor_id) DO UPDATE
         SET token = EXCLUDED.token, invited_by = EXCLUDED.invited_by,
             created_at = NOW(), expires_at = NOW() + INTERVAL '30 days', used_at = NULL`,
      [req2.vendor_id, token]
    );

    // Mark request approved
    await client.query(
      `UPDATE vendor_invite_requests
         SET status = 'approved', reviewed_at = NOW(), reviewed_by = 'admin'
       WHERE request_id = $1`,
      [id]
    );

    const invite_url = `${PUBLIC_URL}/onboard.html?invite=${token}`;
    res.json({
      invite_url,
      vendor_name:    req2.canonical_name,
      requester_email: req2.requester_email,
    });
  } finally { client.release(); }
});

// ── POST /admin/invite-requests/:id/reject ────────────────────────────────────
router.post('/invite-requests/:id/reject', requireAdminJwt, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE vendor_invite_requests
         SET status = 'rejected', reviewed_at = NOW(), reviewed_by = 'admin'
       WHERE request_id = $1 AND status = 'pending'
       RETURNING request_id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pending request not found' });
    res.json({ ok: true });
  } finally { client.release(); }
});


// ── GET /admin/vendors/lookup ─────────────────────────────────────────────────
// Fuzzy search by canonical_name, city, OR primary_phone. Returns ≤ 10 vendors.
// Used by the developer-portal "Test Vendors" panel.
router.get('/vendors/lookup', requireAdminJwt, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ vendors: [] });

  const digits = q.replace(/\D/g, '');
  const client = await pool.connect();
  try {
    let rows;
    if (digits.length >= 4) {
      // Has meaningful digits — search name, city AND phone
      ({ rows } = await client.query(
        `SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                v.primary_phone, v.website_url, v.email,
                v.is_licensed, v.is_insured, v.is_active, v.is_onboarded, v.is_test_vendor,
                v.primary_category_code,
                ct.display_name AS category_display_name,
                v.vendor_score, v.score_tier,
                ${LIFECYCLE_STATUS_SQL} AS lifecycle_status
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         ${LIFECYCLE_JOINS}
         WHERE v.canonical_name ILIKE $1
            OR v.city            ILIKE $1
            OR REGEXP_REPLACE(v.primary_phone, '[^0-9]', '', 'g') ILIKE $2
         ORDER BY v.canonical_name
         LIMIT 10`,
        [`%${q}%`, `%${digits}%`]
      ));
    } else {
      // Text-only query — search name and city only
      ({ rows } = await client.query(
        `SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                v.primary_phone, v.website_url, v.email,
                v.is_licensed, v.is_insured, v.is_active, v.is_onboarded, v.is_test_vendor,
                v.primary_category_code,
                ct.display_name AS category_display_name,
                v.vendor_score, v.score_tier,
                ${LIFECYCLE_STATUS_SQL} AS lifecycle_status
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         ${LIFECYCLE_JOINS}
         WHERE v.canonical_name ILIKE $1
            OR v.city            ILIKE $1
         ORDER BY v.canonical_name
         LIMIT 10`,
        [`%${q}%`]
      ));
    }
    res.json({ vendors: rows });
  } finally { client.release(); }
});

// ── GET /admin/taxonomy ───────────────────────────────────────────────────────
// Return category list for dropdown (code + display_name).
router.get('/taxonomy', requireAdminJwt, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT category_code, display_name
       FROM category_taxonomy
       WHERE is_active = true
       ORDER BY priority, display_name`
    );
    res.json({ categories: rows });
  } finally { client.release(); }
});

// ── POST /admin/vendors/upsert ────────────────────────────────────────────────
// Create a new vendor (same columns as collector agent) or update an existing one.
// Body: { vendor_id?, canonical_name, primary_category_code, city, state, zip?,
//         primary_phone?, email?, website_url?, is_licensed?, is_insured? }
// Returns the vendor row (including vendor_id).
router.post('/vendors/upsert', requireAdminJwt, async (req, res) => {
  const {
    vendor_id,
    canonical_name,
    primary_category_code,
    city, state, zip        = null,
    primary_phone           = null,
    email                   = null,
    website_url             = null,
    is_licensed             = false,
    is_insured              = false,
    is_test_vendor,         // optional override; defaults applied below
  } = req.body || {};

  if (!canonical_name?.trim())       return res.status(400).json({ error: 'canonical_name is required' });
  if (!city?.trim())                 return res.status(400).json({ error: 'city is required' });
  if (!state?.trim())                return res.status(400).json({ error: 'state is required' });

  // Normalise phone to E.164
  function toE164(p) {
    if (!p) return null;
    const d = String(p).replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return p.trim() || null;
  }

  function makeSlug(name, city2) {
    return (name + '-' + city2).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  }

  // Resolve category code from name if needed
  let resolvedCategoryCode = (primary_category_code || '').trim();

    const client = await pool.connect();
  try {
    // If category looks like a name (has spaces), look it up
    if (resolvedCategoryCode && /\s/.test(resolvedCategoryCode)) {
      let catLookup = await client.query(
        "SELECT category_code FROM category_taxonomy WHERE LOWER(display_name) LIKE LOWER($1) LIMIT 1",
        ['%' + resolvedCategoryCode + '%']
      );
      if (!catLookup.rows[0]) {
        const words = resolvedCategoryCode.split(/\s+/).filter(w => w.length > 3);
        for (const word of words) {
          catLookup = await client.query(
            "SELECT category_code FROM category_taxonomy WHERE LOWER(display_name) LIKE LOWER($1) LIMIT 1",
            ['%' + word + '%']
          );
          if (catLookup.rows[0]) break;
        }
      }
      resolvedCategoryCode = catLookup.rows[0]?.category_code || null;
    }
    if (!resolvedCategoryCode) {
      const fallback = await client.query("SELECT category_code FROM category_taxonomy ORDER BY category_code LIMIT 1");
      resolvedCategoryCode = fallback.rows[0]?.category_code || 'CLN.DEP';
    }

    let row;

    if (vendor_id) {
      // ── UPDATE existing vendor ──────────────────────────────────────────
      const testVendorClause = (typeof is_test_vendor === 'boolean') ? '$12' : 'is_test_vendor';
      const updateParams = [vendor_id,
         canonical_name.trim(), resolvedCategoryCode,
         city.trim(), state.trim().toUpperCase(),
         zip || null, toE164(primary_phone), email?.trim() || null,
         website_url?.trim() || null, !!is_licensed, !!is_insured];
      if (typeof is_test_vendor === 'boolean') updateParams.push(is_test_vendor);

      const { rows } = await client.query(
        `UPDATE vendors SET
           canonical_name        = $2,
           primary_category_code = $3,
           city                  = $4,
           state                 = $5,
           zip                   = COALESCE($6, zip),
           primary_phone         = COALESCE($7, primary_phone),
           email                 = COALESCE($8, email),
           website_url           = COALESCE($9, website_url),
           is_licensed           = $10,
           is_insured            = $11,
           is_active             = true,
           is_test_vendor        = ${testVendorClause},
           updated_at            = NOW()
         WHERE vendor_id = $1
         RETURNING vendor_id, canonical_name, city, state, zip,
                   primary_phone, email, website_url,
                   is_licensed, is_insured, primary_category_code,
                   is_test_vendor, is_onboarded, is_active`,
        updateParams
      );
      if (!rows.length) return res.status(404).json({ error: 'Vendor not found' });
      row = rows[0];
    } else {
      // ── INSERT new vendor (same logic as collector agent) ───────────────
      const { randomUUID } = await import('crypto');
      const newId = randomUUID();
      const slug  = makeSlug(canonical_name.trim(), city.trim());

      // New vendors created from the admin "Test Vendors" panel default to
      // is_test_vendor = true (admin can uncheck it explicitly in the form).
      const newIsTest = (typeof is_test_vendor === 'boolean') ? is_test_vendor : true;

      const { rows } = await client.query(
        `INSERT INTO vendors
           (vendor_id, slug,
            canonical_name, primary_category_code,
            city, state, zip,
            primary_phone, email, website_url,
            is_active, is_claimed,
            is_licensed, is_insured, is_background_checked,
            is_test_vendor,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 true, false, $11, $12, false, $13, NOW(), NOW())
         ON CONFLICT (vendor_id) DO UPDATE
           SET updated_at = NOW()
         RETURNING vendor_id, canonical_name, city, state, zip,
                   primary_phone, email, website_url,
                   is_licensed, is_insured, primary_category_code,
                   is_test_vendor, is_onboarded, is_active`,
        [newId, slug,
         canonical_name.trim(), resolvedCategoryCode,
         city.trim(), state.trim().toUpperCase(),
         zip || null, toE164(primary_phone), email?.trim() || null,
         website_url?.trim() || null,
         !!is_licensed, !!is_insured, newIsTest]
      );
      row = rows[0];
    }

    // Simple lifecycle status for a freshly saved vendor (no calls/invites yet
    // for brand-new vendors; existing vendors keep whatever the DB reflects).
    let lifecycle_status = 'prospect';
    if (row.is_test_vendor)        lifecycle_status = 'test';
    else if (row.is_active === false) lifecycle_status = 'inactive';
    else if (row.is_onboarded)     lifecycle_status = 'onboarded';

    res.json({ vendor: { ...row, lifecycle_status }, saved: true });
  } finally { client.release(); }
});


// ── GET /admin/calls — paginated call history ─────────────────────────────────
router.get('/calls', requireAdminJwt, async (req, res) => {
  const page    = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit   = Math.min(50, parseInt(req.query.limit || '25', 10));
  const offset  = (page - 1) * limit;
  const outcome = req.query.outcome     || null;
  const kind    = req.query.initiated_by || null;

  const conditions = [];
  const params     = [];

  if (outcome) { conditions.push(`vc.outcome = $${params.length + 1}`); params.push(outcome); }
  if (kind)    { conditions.push(`vc.initiated_by = $${params.length + 1}`); params.push(kind); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const client = await pool.connect();
  try {
    const [{ rows: calls }, { rows: countRows }] = await Promise.all([
      client.query(
        `SELECT vc.call_id, vc.vapi_call_id, vc.initiated_by, vc.status, vc.outcome,
                vc.summary, vc.phone_dialed, vc.initiated_at, vc.ended_at,
                vc.callback_time, vc.vendor_email, vc.quote_estimate, vc.invite_sent,
                v.canonical_name AS vendor_name, v.city, v.state, v.primary_category_code
         FROM vendor_calls vc
         LEFT JOIN vendors v ON v.vendor_id = vc.vendor_id
         ${where}
         ORDER BY vc.initiated_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      client.query(
        `SELECT COUNT(*) FROM vendor_calls vc ${where}`,
        params
      ),
    ]);

    res.json({
      calls,
      total: parseInt(countRows[0].count, 10),
      page,
      limit,
    });
  } finally { client.release(); }
});

// ── GET /admin/calls/:call_id/transcript ─────────────────────────────────────
router.get('/calls/:call_id/transcript', requireAdminJwt, async (req, res) => {
  const { call_id } = req.params;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT vc.*, v.canonical_name AS vendor_name, v.city, v.state, v.primary_phone
       FROM vendor_calls vc
       LEFT JOIN vendors v ON v.vendor_id = vc.vendor_id
       WHERE vc.call_id = $1`,
      [call_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Call not found' });
    res.json(rows[0]);
  } finally { client.release(); }
});


// ── POST /admin/scan-business-card — extract info from card image via Claude vision ──
router.post('/scan-business-card', requireAdminJwt, async (req, res) => {
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
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image },
            },
            {
              type: 'text',
              text: `Extract all business card information from this image. Return ONLY a JSON object with these fields (use empty string if not found):
{
  name: contact person name,
  company: company/business name,
  phone: phone number in format +1XXXXXXXXXX or as shown,
  email: email address,
  address: street address,
  city: city,
  state: state abbreviation,
  zip: zip code,
  website: website URL,
  category: best guess at business category/trade e.g. Plumbing, Electrical, HVAC, Roofing
}
Return ONLY the JSON, no markdown, no explanation.`,
            },
          ],
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      console.error('[scan-card] Claude error:', claudeData);
      return res.status(502).json({ error: 'AI analysis failed' });
    }

    const text = claudeData.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse card data' });

    const card = JSON.parse(jsonMatch[0]);
    res.json(card);
  } catch (e) {
    console.error('[scan-card] error:', e.message);
    res.status(500).json({ error: 'Business card scan failed' });
  }
});


// GET /admin/rfqs  — platform-wide RFQ monitor
router.get('/rfqs', requireAdminJwt, async (req, res) => {
  const { status, limit = 50 } = req.query;
  const client = await pool.connect();
  try {
    const conditions = status ? [`qr.status = '${status.replace(/'/g,"''")}'`] : [];
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await client.query(
      `SELECT qr.quote_request_id, qr.category_label, qr.address, qr.city, qr.state,
              qr.description, qr.property_type, qr.urgency, qr.requester_name,
              qr.status, qr.vendors_called, qr.quotes_received, qr.created_at,
              json_agg(json_build_object(
                'vendor_name', v.canonical_name,
                'vendor_status', qrv.status,
                'quoted_amount', qrv.quoted_amount,
                'quoted_at', qrv.quoted_at
              ) ORDER BY qrv.created_at) FILTER (WHERE qrv.id IS NOT NULL) AS vendor_responses
       FROM quote_requests qr
       LEFT JOIN quote_request_vendors qrv ON qrv.quote_request_id = qr.quote_request_id
       LEFT JOIN vendors v ON v.vendor_id = qrv.vendor_id
       ${where}
       GROUP BY qr.quote_request_id
       ORDER BY qr.created_at DESC
       LIMIT $1`,
      [parseInt(limit)]
    );
    res.json({ rfqs: rows });
  } finally { client.release(); }
});
export default router;
