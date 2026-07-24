import { pool } from '../db.js';

export async function sendVendorPushNotification(vendorId, title, body, data = {}) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT expo_token FROM vendor_push_tokens WHERE vendor_id = $1`,
      [vendorId]
    );
    if (!rows.length) return;
    const messages = rows.map(r => ({ to: r.expo_token, sound: 'default', title, body, data }));
    const resp = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await resp.json();
    if (result.data) {
      for (let i = 0; i < result.data.length; i++) {
        if (result.data[i]?.details?.error === 'DeviceNotRegistered') {
          await client.query(`DELETE FROM vendor_push_tokens WHERE expo_token = $1`, [rows[i].expo_token]);
        }
      }
    }
  } catch (err) {
    console.error('[push] Error:', err.message);
  } finally { client.release(); }
}

export async function notifyVendorsOfQuoteRequest(vendorIds, quoteRequestId, categoryLabel, city) {
  await Promise.all(vendorIds.map(id =>
    sendVendorPushNotification(id, 'New Quote Request',
      `${categoryLabel} job in ${city} ? tap to view and quote`,
      { type: 'quote_request', quote_request_id: quoteRequestId })
  ));
}
