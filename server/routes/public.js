import { Router }      from 'express';
import { randomBytes } from 'crypto';
import { pool }        from '../db.js';

const router = Router();

// â”€â”€ Shared helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function toE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

/** Geocode a US address string â†’ { lat, lng, city, state } or null */
async function geocodeAddress(address) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({ q: address, format: 'json', limit: '1',
                            countrycodes: 'us', addressdetails: '1' });
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Vendora-API/1.0 (api@vendora.io)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.length) return null;
    const hit = data[0];
    return {
      lat:   parseFloat(hit.lat),
      lng:   parseFloat(hit.lon),
      city:  hit.address?.city || hit.address?.town || hit.address?.village || null,
      state: hit.address?.state_code?.toUpperCase() || null,
    };
  } catch { return null; }
}
/**
 * Auto-detect service category from a free-text maintenance description.
 * Scores each active category by counting keyword matches, returns best fits.
 * @returns { codes: string[], label: string }
 */
async function detectCategoryFromDescription(description, client) {
  const desc = description.toLowerCase();
  const { rows } = await client.query(
    `SELECT category_code, display_name, keywords,
       (SELECT COUNT(*)::int FROM unnest(keywords) kw
        WHERE $1 ILIKE '%' || lower(kw) || '%') AS match_count
     FROM category_taxonomy
     WHERE is_active = true
     ORDER BY match_count DESC, priority ASC`,
    [desc]
  );

  // Pass 1 — exact keyword-phrase substring match (as before)
  let matched = rows.filter(r => r.match_count > 0);

  // Pass 2 — fuzzy word-level match (e.g. "light" <-> "lighting"/"lights",
  // "leak" <-> "leaking"). Catches real categories that pass 1 misses because
  // the taxonomy only stores full phrases ("lighting installation") rather
  // than the bare root word a user actually types ("light").
  if (matched.length === 0) {
    const descWords = desc.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
    const scored = rows.map(r => {
      let score = 0;
      for (const raw of (r.keywords || [])) {
        for (const kwWord of String(raw).toLowerCase().split(/[^a-z0-9]+/)) {
          if (kwWord.length < 4) continue;
          for (const dWord of descWords) {
            if (kwWord.includes(dWord) || dWord.includes(kwWord)) score++;
          }
        }
      }
      return { ...r, fuzzy_score: score };
    }).filter(r => r.fuzzy_score > 0)
      .sort((a, b) => b.fuzzy_score - a.fuzzy_score || a.priority - b.priority);
    matched = scored;
  }

  if (matched.length > 0) {
    const best = matched.slice(0, 5);
    return {
      codes: best.map(r => r.category_code),
      label: best[0]?.display_name || 'General Maintenance',
    };
  }

  // Pass 3 — nothing matched at all (exact or fuzzy): do NOT pick an arbitrary
  // tied-at-zero row (that's how "basement light" ended up as "Pest Control").
  // Fall back explicitly to General Handyman — a real catch-all for
  // ambiguous/unclassifiable requests.
  const handyman = rows.find(r => r.category_code === 'HND.GEN');
  if (handyman) {
    return { codes: [handyman.category_code], label: handyman.display_name };
  }
  return { codes: [rows[0]?.category_code].filter(Boolean), label: rows[0]?.display_name || 'General Maintenance' };
}

/** Send job-details email via Resend (noop if RESEND_API_KEY not set) */
async function sendJobDetailsEmail({ vendorEmail, vendorName, inviteUrl, job,
  buttonText = 'View Job & Submit Quote →',
  intro = 'Great speaking with you! Here are the full details for the job we discussed:' }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'vendors@vendora.leaseloft.ai';

  const urgencyLabel = job.urgency === 'urgent' ? 'âš¡ URGENT â€” ' : '';
  const subject = `${urgencyLabel}Job Opportunity: ${job.categoryLabel} in ${job.city || job.address} â€“ LeaseLoft`;

  const html = `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
<h2 style="color:#4f46e5">Job Opportunity for ${vendorName}</h2>
<p>${intro}</p>

<table style="width:100%;border-collapse:collapse;margin:20px 0">
  <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;width:40%">Service needed</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${job.categoryLabel}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600">Property type</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${job.propertyType}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600">Location</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${job.address}</td></tr>
  ${job.unitNumber ? `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600">Unit</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${job.unitNumber}</td></tr>` : ''}
  <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600">Urgency</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${job.urgency === 'urgent' ? 'âš¡ Urgent' : job.urgency === 'scheduled' ? 'ðŸ“… Scheduled' : 'Normal'}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600">Description</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${job.description}</td></tr>
  <tr><td style="padding:8px 0;font-weight:600">Requested by</td>
      <td style="padding:8px 0">${job.requesterName || 'Property Manager'}</td></tr>
</table>

<h3>Ready to quote? Set up your free account:</h3>
<a href="${inviteUrl}"
   style="display:inline-block;background:#4f46e5;color:#fff;padding:14px 28px;
          border-radius:8px;text-decoration:none;font-weight:600;font-size:16px">
  View Job &amp; Submit Quote â†’
</a>

<p style="margin-top:24px;font-size:14px;color:#666">
  <strong>How LeaseLoft works for vendors:</strong><br>
  âœ“ Free to sign up â€” no monthly fees or subscriptions<br>
  âœ“ You choose which jobs to quote â€” full control of your schedule<br>
  âœ“ LeaseLoft guarantees payment â€” no more chasing invoices<br>
  âœ“ Small commission only when a job is completed and paid
</p>

<p style="font-size:12px;color:#999;margin-top:32px">
  LeaseLoft Vendor Network Â· <a href="https://vendora.leaseloft.ai">vendora.leaseloft.ai</a><br>
  You're receiving this because our AI coordinator Alex spoke with you about this opportunity.
  Reply to this email with any questions.
</p>
</body></html>`;

  if (!RESEND_KEY) {
    console.log(`[email] RESEND_API_KEY not set â€” skipping email to ${vendorEmail}`);
    console.log(`[email] Invite URL: ${inviteUrl}`);
    return { sent: false, reason: 'no_resend_key' };
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: FROM_EMAIL, to: vendorEmail, subject, html }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[email] Resend error:', data);
      return { sent: false, reason: data.message || 'resend_error' };
    }
    console.log(`[email] Sent to ${vendorEmail} â€” Resend ID: ${data.id}`);
    return { sent: true, resend_id: data.id };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}


/** Expand common address abbreviations so TTS reads them naturally */
function expandAddress(addr) {
  if (!addr) return addr;
  const map = {
    '\\bBlvd\\.?\\b': 'Boulevard',
    '\\bAve\\.?\\b':  'Avenue',
    '\\bSt\\.?\\b':   'Street',
    '\\bDr\\.?\\b':   'Drive',
    '\\bRd\\.?\\b':   'Road',
    '\\bLn\\.?\\b':   'Lane',
    '\\bCt\\.?\\b':   'Court',
    '\\bPl\\.?\\b':   'Place',
    '\\bTwp\\.?\\b':  'Township',
    '\\bBoro\\.?\\b': 'Borough',
    '\\bPkwy\\.?\\b': 'Parkway',
    '\\bHwy\\.?\\b':  'Highway',
    '\\bFwy\\.?\\b':  'Freeway',
    '\\bExpy\\.?\\b': 'Expressway',
    '\\bSq\\.?\\b':   'Square',
    '\\bTer\\.?\\b':  'Terrace',
    '\\bCir\\.?\\b':  'Circle',
    '\\bXing\\.?\\b': 'Crossing',
    '\\bJct\\.?\\b':  'Junction',
    '\\bMt\\.?\\b':   'Mount',
    '\\bFt\\.?\\b':   'Fort',
    '\\bSte\\.?\\b':  'Suite',
    '\\bApt\\.?\\b':  'Apartment',
    '\\bNJ\\b': 'New Jersey',
    '\\bNY\\b': 'New York',
    '\\bPA\\b': 'Pennsylvania',
    '\\bCT\\b': 'Connecticut',
    '\\bMA\\b': 'Massachusetts',
    '\\bFL\\b': 'Florida',
    '\\bTX\\b': 'Texas',
    '\\bCA\\b': 'California',
    '\\bGA\\b': 'Georgia',
    '\\bIL\\b': 'Illinois',
    '\\bOH\\b': 'Ohio',
    '\\bWA\\b': 'Washington',
    '\\bCO\\b': 'Colorado',
    '\\bSC\\b': 'South Carolina',
    '\\bNC\\b': 'North Carolina',
    '\\bVA\\b': 'Virginia',
    '\\bMD\\b': 'Maryland',
  };
  let out = addr;
  for (const [pattern, replacement] of Object.entries(map)) {
    out = out.replace(new RegExp(pattern, 'gi'), replacement);
  }
  return out;
}

/** Build the system prompt for an outbound quote-request call */
function buildQuoteCallPrompt(vendor, job) {
  const name     = vendor.canonical_name;
  const category = vendor.category_display_name || job.categoryLabel || 'service';
  const city     = job.city || vendor.city || 'your area';

  return `You are Alex, a job coordinator at LeaseLoft â€” a property management platform that \
connects property managers with trusted local vendors.

You are calling ${name}, a ${category} business in ${city}, because we have a \
${job.urgency === 'urgent' ? 'URGENT ' : ''}job that matches their specialty and they are the \
right kind of business to handle it.

â”â”â” THE JOB â”â”â”
Service type : ${category}
Property     : ${job.propertyType}
Location     : ${job.address}${job.unitNumber ? ', ' + job.unitNumber : ''}
Urgency      : ${job.urgency === 'urgent' ? 'URGENT â€” needed ASAP' : job.urgency === 'scheduled' ? 'Scheduled â€” flexible timing' : 'Normal â€” within a few days'}
Description  : ${job.description}
Requested by : ${job.requesterName || 'one of our property managers'}

â”â”â” YOUR GOALS (in order) â”â”â”
1. Introduce yourself and the job â€” naturally, not like a script
2. See if they're available and interested in quoting
3. Get their email to send full job details + free sign-up link
4. Briefly explain LeaseLoft if they ask

â”â”â” ABOUT LEASELOFT (use naturally in conversation, never all at once) â”â”â”
â€¢ Property managers post jobs â†’ LeaseLoft matches them with local vendors
â€¢ Vendors submit quotes â†’ PM picks the best fit
â€¢ LeaseLoft handles contracts and guarantees payment â€” vendors never chase invoices
â€¢ 100% free to sign up; small commission only on completed, paid jobs
â€¢ Vendors control their schedule â€” pause anytime, choose which jobs to quote

â”â”â” CONVERSATION STYLE â”â”â”
â€¢ WARM and NATURAL â€” this is a job offer, not a sales pitch
â€¢ SHORT responses â€” 2 sentences max per turn. Listen more than you talk.
â€¢ Use natural acknowledgments: "Got it", "Makes sense", "Absolutely"
â€¢ Lead every conversation with the job opportunity â€” the platform is secondary
â€¢ Never read a list aloud â€” weave info into natural sentences
• If interrupted mid-sentence: stop immediately, listen fully, answer their point directly, then continue naturally. Do not restart or lose your place.

─── OPENING ───
The call opens with: "Good [morning/afternoon/evening]! Is this ${name}?"
LISTEN carefully to whatever they say and respond naturally:

• They confirm ("Yes", "Speaking", "This is", "Yeah", "That's me") — warmly introduce yourself:
  "Great — my name's Alex, I'm calling from LeaseLoft. We have a property manager in ${city}
   looking for ${category.toLowerCase()} work — and we think you'd be a great fit.
   Do you have just a minute?"

• They sound confused or ask to repeat ("Sorry?", "What?", "Who is this?", "Didn't catch that") —
  DON'T barrel forward. Respond: "Sorry about that — this is Alex from LeaseLoft.
  I was calling for ${name} — is that you?"

• They say "I'm driving" / "I'm busy" / "not a good time" — acknowledge it first:
  "No problem — I'll be super quick, 30 seconds. We have a ${category.toLowerCase()} job
   in ${city} and I think you'd be perfect for it. Still okay?"
  If they push back again — offer a callback time and end politely.

• They say something unexpected — RESPOND to what they actually said before moving on.
  NEVER just say "Right" and continue as if they confirmed.

â”â”â” IF THEY WANT JOB DETAILS â”â”â”
Tell them naturally:
"So the job is: ${job.description}. It's at a ${job.propertyType} in ${job.address}. \
${job.urgency === 'urgent' ? 'They need it done as soon as possible. ' : ''}Would you be \
interested in putting in a quote?"

─── IF THEY SAY YES / WANT MORE INFO ───
"Perfect — what's the best email to send you the full details?"

EMAIL VERIFICATION (3-step, progressive):
Step 1 — Repeat it back naturally (no spelling):
  "So that's [email as spoken] — have I got that right?"
  If confirmed — move on.
Step 2 — If not confirmed or they correct you, try once more naturally:
  "Got it — [corrected email] — is that it?"
  If confirmed — move on.
Step 3 — If still not confirmed after two tries, ask them to spell it:
  "Let me have you spell that out so I get it exactly right."
  Listen, then read back LETTER BY LETTER:
  "[letter]-[letter]-[letter]... dot ... at ... [domain]. Is that correct?"
  Only proceed once they explicitly confirm.

AFTER EMAIL CONFIRMED:
"Great, I'll send that right over — it has all the job details and a free sign-up link."

─── IF VENDOR ASKS TO BE TEXTED INSTEAD ───
If vendor says "just text me", "send me a text", "can you text that", etc.:
  "Absolutely — what's the best number to text you on?"
  Listen for the number, then read it back:
  "Got it — I'll text the job details to [number]. Sound good?"
  Wait for confirmation, then end the call politely.
  (The system will send the SMS automatically.)

OBJECTION HANDLING â”â”â”
"Already busy" â†’ "That's great to hear â€” and totally fine! This one is \
${job.urgency === 'urgent' ? 'urgent, so timing matters, but if it doesn\'t work we understand.' : 'flexible on timing â€” would it fit your schedule in the next few days?'}"
"What's LeaseLoft?" â†’ "We're a property management platform â€” PMs post jobs, vendors \
like you quote on them, and we handle all the payment and paperwork. It's free to sign up."
"Cost?" â†’ "Nothing upfront at all. We take a small cut only when the job is done and \
paid â€” no fees, no subscriptions."
"Sounds like a scam" â†’ "I completely understand â€” there are a lot of spam calls out there. \
Feel free to look us up: vendora.leaseloft.ai â€” happy to wait while you check."
"Not interested" â†’ "No problem at all â€” thanks for your time! Feel free to reach out if a \
future job would be a better fit."

=== ENDING THE CALL (CRITICAL — DO NOT LINGER) ===
The moment the conversation has reached its natural conclusion — vendor agreed to get the email/text, declined, asked you to call back, or you hit voicemail — wrap up IMMEDIATELY with exactly ONE short closing line. Say it ONCE and then STOP TALKING.

Do NOT ramble through multiple goodbyes. Do NOT add filler like "alright then", "well", "okay great", or repeat "thanks" / "take care" / "bye" more than once. One clean line, and you're done — that line IS the end of the call, not the start of a longer farewell.

Pick ONE matching closing line and say it exactly once:
  - Vendor agreed (email or text) -> "Perfect, I'll get that sent right over — thanks so much, have a great day!"
  - Vendor declined / not interested -> "No problem at all — thanks for your time, have a great day!"
  - Vendor asked for a callback -> "Sounds great, I'll have someone follow up then — thanks, take care!"
  - Voicemail -> end your brief message with "...thanks, have a great day!" and stop.

Recite your chosen line EXACTLY AS WRITTEN above — word for word, nothing added, nothing swapped. Do NOT insert a name (the vendor's, your own, "buddy", "friend", "Eyo", or anything else), and do NOT add extra filler words ("uh", "so", "alright", "okay"). Any inserted word can be misheard as a name and will confuse the vendor — say the line clean, plain, and exactly as scripted.

Immediately after delivering that one line, call the endCall function to hang up. Do not wait for the vendor to reply, do not keep talking, do not add anything after it — calling endCall right after your closing line IS the correct, clean ending.

â”â”â” CALL OUTCOMES (determine at end of call) â”â”â”
â€¢ INTERESTED_EMAIL     â€” vendor agreed, gave an email address for job details
â€¢ INTERESTED_CALLBACK  â€” vendor interested but asked to call back later
â€¢ NOT_INTERESTED       â€” vendor declined
â€¢ VOICEMAIL            â€” reached voicemail, left a brief message
â€¢ NO_ANSWER            â€” no answer, did not leave voicemail

IMPORTANT: This is a phone call. Keep every response to 1â€“3 SHORT sentences.`;
}

// ── Media-based issue analysis (Claude vision) ─────────────────────────────
const MEDIA_ANALYSIS_MODEL = 'claude-sonnet-4-6';
const MAX_MEDIA_ITEMS       = 5;
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function guessImageMediaType(url) {
  const ext = String(url).split('?')[0].split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  return map[ext] || null;
}

/**
 * Look at one or more photos (and best-effort skip videos) of a maintenance
 * issue and ask Claude to describe what's wrong, in plain language a vendor
 * can act on, plus a category hint / severity / confidence.
 *
 * @param {Array<{url?:string, data?:string, media_type?:string}>} media
 * @param {string|null} contextDescription — any text description already provided
 * @returns {Promise<{
 *   ai_description: string|null,
 *   category_hint: string|null,
 *   severity: string|null,
 *   confidence: 'none'|'low'|'medium'|'high',
 *   safety_concern: boolean,
 *   notes: string|null,
 *   skipped_media: Array<object>,
 * }>}
 */
async function analyzeMaintenanceMedia(media, contextDescription) {
  const items   = Array.isArray(media) ? media.slice(0, MAX_MEDIA_ITEMS) : [];
  const blocks  = [];
  const skipped = [];

  for (const item of items) {
    if (!item || (!item.url && !item.data)) {
      skipped.push({ reason: 'media item missing "url" or "data"' });
      continue;
    }
    const mediaType = item.media_type || (item.url ? guessImageMediaType(item.url) : null);
    if (!mediaType) {
      skipped.push({ url: item.url || null, reason: 'could not determine media_type' });
      continue;
    }
    if (mediaType.startsWith('video/')) {
      skipped.push({ url: item.url || null, media_type: mediaType,
        reason: 'video analysis is not supported yet — please extract a still frame and submit it as an image' });
      continue;
    }
    if (!SUPPORTED_IMAGE_TYPES.includes(mediaType)) {
      skipped.push({ url: item.url || null, media_type: mediaType, reason: `unsupported media_type: ${mediaType}` });
      continue;
    }
    blocks.push({
      type: 'image',
      source: item.data
        ? { type: 'base64', media_type: mediaType, data: item.data }
        : { type: 'url', url: item.url },
    });
  }

  if (!blocks.length) {
    return {
      ai_description: null, category_hint: null, severity: null,
      confidence: 'none', safety_concern: false,
      notes: skipped.length ? 'No analyzable images — see skipped_media' : 'No media provided',
      skipped_media: skipped,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ai_description: null, category_hint: null, severity: null,
      confidence: 'none', safety_concern: false,
      notes: 'Media analysis unavailable (ANTHROPIC_API_KEY not configured)',
      skipped_media: skipped,
    };
  }

  const promptText = `You are a maintenance triage assistant for a property management platform. \
Look at the attached photo(s) of a maintenance issue${contextDescription ? ` (the requester also wrote: "${contextDescription}")` : ''}.

Respond with ONLY a JSON object (no markdown, no code fences, no extra text) with these exact fields:
{
  "issue_description": "1-3 sentence plain-English description of what's wrong, written as if describing the job to a contractor",
  "category_hint": "short phrase naming the type of repair/trade needed (e.g. 'leaking pipe under sink', 'cracked drywall', 'broken garage door spring')",
  "severity": "low" | "medium" | "high" | "emergency",
  "confidence": "low" | "medium" | "high",
  "safety_concern": true | false,
  "notes": "anything else useful for a vendor to know — visible water damage, exposed wiring, mold, etc."
}

If the photo(s) don't clearly show a maintenance issue, set "confidence" to "low" and describe what you do see in "notes".`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MEDIA_ANALYSIS_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: promptText }] }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error('[media-analysis] Claude API error:', resp.status, errBody.slice(0, 300));
      return {
        ai_description: null, category_hint: null, severity: null,
        confidence: 'none', safety_concern: false,
        notes: `Media analysis failed (HTTP ${resp.status})`,
        skipped_media: skipped,
      };
    }

    const data = await resp.json();
    let text = (data.content?.[0]?.text || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* fall through */ }

    if (!parsed) {
      return {
        ai_description: text || null, category_hint: null, severity: null,
        confidence: 'low', safety_concern: false,
        notes: 'Could not parse structured analysis from model output',
        skipped_media: skipped,
      };
    }

    return {
      ai_description: parsed.issue_description || null,
      category_hint:  parsed.category_hint || null,
      severity:       parsed.severity || null,
      confidence:     parsed.confidence || 'medium',
      safety_concern: !!parsed.safety_concern,
      notes:          parsed.notes || null,
      skipped_media:  skipped,
    };
  } catch (err) {
    console.error('[media-analysis] error:', err.message);
    return {
      ai_description: null, category_hint: null, severity: null,
      confidence: 'none', safety_concern: false,
      notes: `Media analysis error: ${err.message}`,
      skipped_media: skipped,
    };
  }
}

// â”€â”€ GET /public/categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (parent_code)
        parent_code AS code,
        first_value(display_name) OVER (
          PARTITION BY parent_code ORDER BY priority, display_name
        ) AS first_child_name
      FROM category_taxonomy
      WHERE is_active = true AND parent_code IS NOT NULL
      ORDER BY parent_code
    `);

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

// â”€â”€ GET /public/search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  if (q) { params.push(`%${q}%`); conditions.push(`v.canonical_name ILIKE $${params.length}`); }
  if (state) { params.push(state); conditions.push(`v.state = $${params.length}`); }
  if (category) { params.push(`${category}%`); conditions.push(`v.primary_category_code LIKE $${params.length}`); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const client = await pool.connect();
  try {
    const [dataResult, countResult] = await Promise.all([
      client.query(
        `SELECT v.vendor_id, v.canonical_name, v.city, v.state, v.zip,
                v.primary_phone, v.website_url, v.is_onboarded, v.is_licensed, v.is_insured,
                v.vendor_score, v.score_tier,
                v.bbb_rating, v.bbb_accredited,
                v.avg_rating, v.review_count, v.rating_source,
                v.hours_text,
                ct.display_name AS category_display_name, ct.category_code
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         ${where}
         ORDER BY v.vendor_score DESC NULLS LAST, v.canonical_name
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      client.query(`SELECT COUNT(*) AS total FROM vendors v ${where}`, params),
    ]);
    const total = parseInt(countResult.rows[0].total, 10);
    return res.json({ vendors: dataResult.rows, total, page, limit });
  } catch (err) {
    console.error('GET /public/search error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// â”€â”€ POST /public/claim-request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/claim-request', async (req, res) => {
  const { vendor_id, requester_name, requester_email, requester_phone, message } = req.body;
  if (!vendor_id || !requester_name || !requester_email)
    return res.status(400).json({ error: 'vendor_id, requester_name, and requester_email are required' });

  const client = await pool.connect();
  try {
    const vendorResult = await client.query(
      'SELECT vendor_id, canonical_name, is_onboarded FROM vendors WHERE vendor_id = $1', [vendor_id]
    );
    if (!vendorResult.rows.length) return res.status(404).json({ error: 'Vendor not found' });
    const vendor = vendorResult.rows[0];
    if (vendor.is_onboarded) return res.status(409).json({ error: 'This business is already on Vendora' });

    const pendingResult = await client.query(
      `SELECT request_id FROM vendor_invite_requests WHERE vendor_id = $1 AND status = 'pending' LIMIT 1`,
      [vendor_id]
    );
    if (pendingResult.rows.length > 0)
      return res.status(409).json({ error: 'A request for this listing is already pending review' });

    const insertResult = await client.query(
      `INSERT INTO vendor_invite_requests (vendor_id, requester_name, requester_email, requester_phone, message)
       VALUES ($1, $2, $3, $4, $5) RETURNING request_id`,
      [vendor_id, requester_name, requester_email, requester_phone ?? null, message ?? null]
    );
    return res.status(201).json({
      request_id: insertResult.rows[0].request_id,
      vendor_name: vendor.canonical_name,
      message: `Your request to claim ${vendor.canonical_name} has been submitted. We'll review it within 1â€“2 business days.`,
    });
  } catch (err) {
    console.error('POST /public/claim-request error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// â”€â”€ POST /public/request-quotes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Receives a maintenance job description, finds matching vendors in the area,
// and fires outbound VAPI calls to each â€” presenting the job as a real opportunity
// and inviting interested vendors to onboard via a personalised invite link.
//
// Body: {
//   _secret          : string   â€” shared secret (QUOTE_REQUEST_SECRET env var)
//   category_keyword : string   â€” e.g. "plumber", "HVAC", "electrician"
//   category_code    : string   â€” optional, e.g. "PLB", "HVC" (overrides keyword)
//   address          : string   â€” full job address
//   unit_number      : string?  â€” apartment/unit number
//   description      : string   â€” what needs to be done
//   property_type    : string?  â€” "apartment" | "house" | "condo" | "commercial"
//   urgency          : string?  â€” "urgent" | "normal" | "scheduled"
//   requester_name   : string?  â€” property manager's name
//   requester_email  : string?  â€” property manager's email
//   max_vendors      : number?  â€” max vendors to call (default 5, max 10)
// }
router.post('/request-quotes', async (req, res) => {
  // â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const QUOTE_SECRET = process.env.QUOTE_REQUEST_SECRET || 'leaseloft-quotes-2026';
  if ((req.body._secret || req.headers['x-quote-secret']) !== QUOTE_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const {
    category_keyword,
    category_code:    rawCatCode,
    address,
    unit_number      = null,
    description,
    property_type    = 'apartment',
    urgency          = 'normal',
    requester_name   = null,
    requester_email  = null,
    max_vendors: maxRaw = 3,
    _test            = false,
  } = req.body || {};

  const maxVendors = Math.min(Math.max(parseInt(maxRaw) || 3, 1), 20);

  if (!address)     return res.status(400).json({ error: '"address" is required' });
  if (!description) return res.status(400).json({ error: '"description" is required' });

  const VAPI_KEY      = process.env.VAPI_API_KEY;
  const VAPI_PHONE_ID = process.env.VAPI_PHONE_NUMBER_ID;
  const VOICE_ID      = process.env.VAPI_ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const PUBLIC_URL    = (process.env.PUBLIC_URL || 'https://vendora.leaseloft.ai').replace(/\/$/, '');

  if (!VAPI_KEY || !VAPI_PHONE_ID)
    return res.status(503).json({ error: 'VAPI not configured on server' });

  const client = await pool.connect();
  try {
    // â”€â”€ 1. Resolve category codes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let codes = [];
    let categoryLabel = '';

    if (rawCatCode) {
      const catRes = await client.query(
        `SELECT category_code, display_name FROM category_taxonomy
         WHERE category_code LIKE $1 AND is_active = true ORDER BY priority LIMIT 5`,
        [`${rawCatCode}%`]
      );
      codes = catRes.rows.map(r => r.category_code);
      categoryLabel = catRes.rows[0]?.display_name || rawCatCode;
    } else if (category_keyword) {
      const kw = category_keyword.toLowerCase();
      const catRes = await client.query(
        `SELECT category_code, display_name FROM category_taxonomy
         WHERE is_active = true AND (
           lower(display_name) ILIKE $1
           OR EXISTS (SELECT 1 FROM unnest(keywords) kw WHERE lower($2) ILIKE '%' || lower(kw) || '%')
         )
         ORDER BY priority LIMIT 8`,
        [`%${kw}%`, category_keyword]
      );
      codes = catRes.rows.map(r => r.category_code);
      categoryLabel = catRes.rows[0]?.display_name || category_keyword;
    } else {
      // Auto-detect from free-text description using category taxonomy keywords
      const detected = await detectCategoryFromDescription(description, client);
      codes         = detected.codes;
      categoryLabel = detected.label;
      console.log(`[quote-request] auto-detected: ${categoryLabel} (${codes.slice(0,3).join(', ')}) from description`);
    }

    if (!codes.length)
      return res.status(422).json({ error: 'Could not determine service category — try adding category_keyword' });

    // â”€â”€ 2. Geocode the job address â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const geo = await geocodeAddress(address);
    const jobCity  = geo?.city  || null;
    const jobState = geo?.state || null;

    // â”€â”€ 3. Find vendors with phones near the job â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let vendorRows;
    if (geo?.lat && geo?.lng) {
      // Prefer geocoded vendors within 30 miles; fall back to state match
      const distExpr = `3959 * acos(LEAST(1.0,
        cos(radians(${geo.lat})) * cos(radians(v.lat)) *
          cos(radians(v.lng) - radians(${geo.lng})) +
        sin(radians(${geo.lat})) * sin(radians(v.lat))))`;

      const { rows } = await client.query(
        `SELECT v.vendor_id, v.canonical_name, v.primary_phone, v.city, v.state,
                v.is_onboarded, v.onboarding_email,
                ct.display_name AS category_display_name,
                CASE WHEN v.lat IS NOT NULL THEN ROUND((${distExpr})::numeric,1)
                     ELSE NULL END AS distance_miles
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         WHERE v.is_active = true
           AND v.primary_phone IS NOT NULL
           AND (v.primary_category_code = ANY($1) OR v.secondary_category_codes && $1)
           AND (
             (v.lat IS NOT NULL AND ${distExpr} <= 30)
             OR (v.state = $2)
           )
           ${_test ? '' : `AND NOT EXISTS (
             SELECT 1 FROM vendor_calls vc
             WHERE vc.vendor_id = v.vendor_id
               AND vc.initiated_at > NOW() - INTERVAL '24 hours'
               AND vc.initiated_by = 'quote-request'
           )`}
         ORDER BY
           CASE WHEN v.lat IS NOT NULL THEN ${distExpr} ELSE 500 END,
           v.vendor_score DESC NULLS LAST,
           v.vendor_id
         LIMIT $3`,
        [codes, jobState || '', maxVendors]
      );
      vendorRows = rows;
    } else {
      // No geo â€” fall back to state from address string or top-scored vendors
      const stateMatch = address.match(/\b([A-Z]{2})\b(?:\s+\d{5})?$/)?.[1] || null;
      const { rows } = await client.query(
        `SELECT v.vendor_id, v.canonical_name, v.primary_phone, v.city, v.state,
                v.is_onboarded, v.onboarding_email,
                ct.display_name AS category_display_name, NULL AS distance_miles
         FROM vendors v
         LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
         WHERE v.is_active = true
           AND v.primary_phone IS NOT NULL
           AND (v.primary_category_code = ANY($1) OR v.secondary_category_codes && $1)
           ${stateMatch ? `AND v.state = '${stateMatch}'` : ''}
           ${_test ? '' : `AND NOT EXISTS (
             SELECT 1 FROM vendor_calls vc
             WHERE vc.vendor_id = v.vendor_id
               AND vc.initiated_at > NOW() - INTERVAL '24 hours'
               AND vc.initiated_by = 'quote-request'
           )`}
         ORDER BY v.vendor_score DESC NULLS LAST, v.vendor_id
         LIMIT $2`,
        [codes, maxVendors]
      );
      vendorRows = rows;
    }

    if (!vendorRows.length)
      return res.status(404).json({ error: 'No available vendors with phone numbers found for this category/area' });

    // â”€â”€ 4. Create the quote_request record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { rows: [qr] } = await client.query(
      `INSERT INTO quote_requests
         (category_code, category_label, address, city, state, lat, lng,
          description, property_type, urgency, unit_number,
          requester_name, requester_email, vendors_called, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'api')
       RETURNING quote_request_id`,
      [
        codes[0], categoryLabel, address, jobCity, jobState,
        geo?.lat ?? null, geo?.lng ?? null,
        description, property_type, urgency, unit_number,
        requester_name, requester_email,
        vendorRows.length,
      ]
    );
    const quoteRequestId = qr.quote_request_id;

    const job = {
      categoryLabel,
      address: unit_number ? `${address}, ${unit_number}` : address,
      unitNumber: unit_number,
      city:  jobCity  || address,
      description,
      propertyType: property_type,
      urgency,
      requesterName: requester_name || 'our client',
    };

    // â”€â”€ 5. Fire VAPI calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const results = [];
    const LEASELOFT_URL = (process.env.LEASELOFT_APP_URL || 'https://app.leaseloft.ai').replace(/\/$/,'');

    // Split: already-onboarded vendors get an email bid-request;
    // new vendors get the VAPI call + onboarding invite
    const onboardedVendors = vendorRows.filter(v => v.is_onboarded && v.onboarding_email);
    const newVendors        = vendorRows.filter(v => !v.is_onboarded || !v.onboarding_email);

    // ── 5a. Onboarded vendors: send bid-request email ─────────────────────────
    for (const vendor of onboardedVendors) {
      const email  = vendor.onboarding_email;
      const bidUrl = `${LEASELOFT_URL}/vendor/bids?job=${quoteRequestId}`;
      const emailResult = await sendJobDetailsEmail({
        vendorEmail: email,
        vendorName:  vendor.canonical_name,
        inviteUrl:   bidUrl,
        buttonText:  'View Job & Submit Quote →',
        intro: `Hi ${vendor.canonical_name}, we have a new ${categoryLabel} job in your area that matches your specialty. Here are the details:`,
        job,
      });

      const { rows: [cr] } = await client.query(
        `INSERT INTO vendor_calls
           (vendor_id, phone_dialed, initiated_by, status, quote_request_id)
         VALUES ($1, $2, 'bid-request', 'pending_bid', $3)
         RETURNING call_id`,
        [vendor.vendor_id, email, quoteRequestId]
      );

      await client.query(
        `INSERT INTO quote_request_vendors (quote_request_id, vendor_id, call_id, status)
         VALUES ($1, $2, $3, 'bid_requested')
         ON CONFLICT (quote_request_id, vendor_id) DO NOTHING`,
        [quoteRequestId, vendor.vendor_id, cr.call_id]
      );

      results.push({
        vendor_id: vendor.vendor_id,
        name:      vendor.canonical_name,
        city:      vendor.city,
        type:      'onboarded',
        status:    emailResult.sent ? 'bid_request_sent' : 'bid_request_queued',
        email,
      });
      console.log(`[quote-request] onboarded vendor ${vendor.canonical_name} -> bid-request email to ${email} (${emailResult.sent ? 'sent' : 'queued'})`);
    }

    // ── 5b. New vendors: outbound VAPI call + onboarding invite ──────────────
    for (const vendor of newVendors) {
      const e164 = toE164(vendor.primary_phone);
      if (!e164) {
        results.push({ vendor_id: vendor.vendor_id, name: vendor.canonical_name,
                       status: 'skipped', reason: 'unparseable_phone' });
        continue;
      }

      job.address   = expandAddress(job.address);
      job.city      = expandAddress(job.city);
      const systemPrompt  = buildQuoteCallPrompt(vendor, job);
      const vendorCity    = job.city || vendor.city || 'your area';
      const hour = new Date().getUTCHours() - 5; // EST approx
      const greeting = hour < 0 ? 'evening' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
      const firstMessage  =
        `Good ${greeting}! Is this ${vendor.canonical_name.slice(0, 50)}?`;

      const vapiPayload = {
        phoneNumberId: VAPI_PHONE_ID.trim(),
        customer: {
          number: e164,
          name: vendor.canonical_name.slice(0, 40),
        },
        assistant: {
          name: `QuoteCall-${quoteRequestId.slice(0, 8)}`,
          firstMessage,
          model: {
            provider: 'anthropic',
            model:    'claude-haiku-4-5-20251001',
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.65,
          },
          voice: {
            provider:        '11labs',
            voiceId:         process.env.VAPI_ELEVENLABS_VOICE_ID || 'dN8hviqdNrAsEcL57yFj',
            model:           'eleven_turbo_v2_5',
            stability:       0.50,
            similarityBoost: 0.75,
            style:           0.20,
            useSpeakerBoost: true,
          },
          endCallFunctionEnabled: true,
          serverUrl: `${(process.env.PUBLIC_URL || 'https://vendora.leaseloft.ai').replace(/\/$/,'')}/admin/call-outcome`,
          serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET || 'vendora-vapi-hook-2026',
          serverMessages: ['end-of-call-report', 'status-update', 'hang'],
          silenceTimeoutSeconds: 8,
          maxDurationSeconds: 600,
          endCallPhrases: ['have a great day', 'thanks so much, have a great day', 'thanks for your time, have a great day', 'take care', 'have someone follow up', 'goodbye', 'good bye', 'bye bye'],
          endCallMessage: "Thanks so much for your time â€” have a great day!",
          transcriber: {
            provider: 'deepgram',
            model:    'nova-2',
            language: 'en-US',
          },
          analysisPlan: {
            summaryPrompt:
              'Summarize this vendor outreach call in 2â€“3 sentences: ' +
              'what was the job offered, how did the vendor respond, and what is the next step?',
            structuredDataSchema: {
              type: 'object',
              properties: {
                outcome: {
                  type: 'string',
                  enum: ['INTERESTED_EMAIL', 'INTERESTED_CALLBACK', 'NOT_INTERESTED', 'VOICEMAIL', 'NO_ANSWER'],
                  description: 'The result of the call',
                },
                vendor_email: {
                  type: 'string',
                  description: 'Email address provided by the vendor if they want job details',
                },
                sms_phone: {
                  type: 'string',
                  description: 'Phone number to SMS job details to, if vendor asked to be texted instead of emailed',
                },
                quote_estimate: {
                  type: 'string',
                  description: 'Any rough price estimate the vendor mentioned',
                },
                callback_time: {
                  type: 'string',
                  description: 'Preferred callback time if outcome is INTERESTED_CALLBACK',
                },
                notes: {
                  type: 'string',
                  description: 'Any other useful information from the call',
                },
              },
              required: ['outcome'],
            },
          },
        },
      };

      try {
        const vapiRes  = await fetch('https://api.vapi.ai/call', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_KEY}` },
          body:    JSON.stringify(vapiPayload),
        });
        const vapiData = await vapiRes.json();

        if (!vapiRes.ok) {
          console.warn(`[quote-call] vendor ${vendor.vendor_id} VAPI error:`, JSON.stringify(vapiData).slice(0, 200));
          results.push({ vendor_id: vendor.vendor_id, name: vendor.canonical_name,
                         status: 'failed', error: Array.isArray(vapiData.message) ? vapiData.message[0] : vapiData.message });
          continue;
        }

        // Record the call
        const { rows: [cr] } = await client.query(
          `INSERT INTO vendor_calls
             (vendor_id, vapi_call_id, phone_dialed, initiated_by, status, quote_request_id)
           VALUES ($1, $2, $3, 'quote-request', 'initiated', $4)
           RETURNING call_id`,
          [vendor.vendor_id, vapiData.id, e164, quoteRequestId]
        );

        // Record in join table
        await client.query(
          `INSERT INTO quote_request_vendors (quote_request_id, vendor_id, call_id, status)
           VALUES ($1, $2, $3, 'called')
           ON CONFLICT (quote_request_id, vendor_id) DO NOTHING`,
          [quoteRequestId, vendor.vendor_id, cr.call_id]
        );

        results.push({
          vendor_id:    vendor.vendor_id,
          name:         vendor.canonical_name,
          phone:        e164,
          city:         vendor.city,
          distance_miles: vendor.distance_miles,
          call_id:      cr.call_id,
          vapi_call_id: vapiData.id,
          status:       'initiated',
        });

        console.log(`[quote-call] ${vendor.canonical_name} (${e164}) â†’ call ${vapiData.id}`);
      } catch (err) {
        console.error(`[quote-call] vendor ${vendor.vendor_id} error:`, err.message);
        results.push({ vendor_id: vendor.vendor_id, name: vendor.canonical_name,
                       status: 'error', error: err.message });
      }

      // Polite delay between calls (VAPI rate limit)
      if (newVendors.indexOf(vendor) < newVendors.length - 1)
        await new Promise(r => setTimeout(r, 1500));
    }

    const initiated    = results.filter(r => r.status === 'initiated').length;
    const bidRequested = results.filter(r => r.type  === 'onboarded').length;
    console.log(`[quote-request] ${quoteRequestId} - ${initiated} VAPI calls, ${bidRequested} bid emails, ${vendorRows.length} total vendors`);

    return res.json({
      quote_request_id:   quoteRequestId,
      category:           categoryLabel,
      vendors_found:      vendorRows.length,
      vendors_called:     initiated,
      vendors_emailed:    bidRequested,
      vendors_contacted:  initiated + bidRequested,
      vendors:            results,
    });
  } catch (err) {
    console.error('POST /public/request-quotes error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

// â”€â”€ GET /public/quote-status/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Poll the status of a quote request: how many vendors called, how many interested
router.get('/quote-status/:id', async (req, res) => {
  const QUOTE_SECRET = process.env.QUOTE_REQUEST_SECRET || 'leaseloft-quotes-2026';
  if ((req.query._secret || req.headers['x-quote-secret']) !== QUOTE_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const client = await pool.connect();
  try {
    const { rows: [qr] } = await client.query(
      `SELECT * FROM quote_requests WHERE quote_request_id = $1`,
      [req.params.id]
    );
    if (!qr) return res.status(404).json({ error: 'Quote request not found' });

    const { rows: calls } = await client.query(
      `SELECT vc.call_id, vc.vapi_call_id, vc.status, vc.outcome,
              vc.summary, vc.vendor_email, vc.quote_estimate, vc.callback_time,
              vc.initiated_at, vc.ended_at,
              v.canonical_name, v.city, v.state, v.primary_phone,
              ct.display_name AS category_display_name
       FROM vendor_calls vc
       JOIN vendors v ON v.vendor_id = vc.vendor_id
       LEFT JOIN category_taxonomy ct ON ct.category_code = v.primary_category_code
       WHERE vc.quote_request_id = $1
       ORDER BY vc.initiated_at`,
      [req.params.id]
    );

    const summary = {
      total_called:   calls.length,
      interested:     calls.filter(c => c.outcome?.startsWith('INTERESTED')).length,
      not_interested: calls.filter(c => c.outcome === 'NOT_INTERESTED').length,
      pending:        calls.filter(c => !c.outcome).length,
      voicemail:      calls.filter(c => c.outcome === 'VOICEMAIL').length,
    };

    return res.json({ quote_request: qr, calls, summary });
  } catch (err) {
    console.error('GET /public/quote-status error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

export { sendJobDetailsEmail };
export { buildQuoteCallPrompt, toE164, expandAddress, analyzeMaintenanceMedia };
export default router;
