// Sends transactional emails (signup verification, etc.) using Brevo's REST API.
// https://developers.brevo.com/reference/sendtransacemail
//
// Requires two environment variables (set these in Render's dashboard, or in
// your local .env file):
//   BREVO_API_KEY      - your Brevo API key (Settings -> SMTP & API -> API Keys)
//   BREVO_SENDER_EMAIL - the email address you verified as a sender in Brevo
//   BREVO_SENDER_NAME  - (optional) display name, defaults to "Shamz Clothing Store"
//
// If these aren't set, emails are skipped and logged to the console instead —
// this lets the rest of the app keep working during local development without
// needing a real email account set up.

async function sendEmail({ to, toName, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Shamz Clothing Store';

  if (!apiKey || !senderEmail) {
    console.log(`\n[mailer] BREVO_API_KEY / BREVO_SENDER_EMAIL not set — skipping real email.`);
    console.log(`[mailer] Would have sent to ${to}: "${subject}"`);
    console.log(`[mailer] ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`);
    return { skipped: true };
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[mailer] Brevo send failed:', res.status, errText);
    throw new Error('Failed to send email');
  }

  return await res.json();
}

const BRAND_NAME = process.env.BREVO_SENDER_NAME || 'F.D.C Clothing Store';
const BRAND_COLOR = '#E23A50';

function verificationEmailHtml({ name, verifyUrl }) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:${BRAND_COLOR};">Welcome to ${BRAND_NAME}, ${name}!</h2>
      <p>Please confirm your email address to activate your account and start ordering.</p>
      <p style="margin: 28px 0;">
        <a href="${verifyUrl}" style="background:${BRAND_COLOR};color:#fff;padding:12px 24px;text-decoration:none;border-radius:2px;display:inline-block;">
          Verify my email
        </a>
      </p>
      <p style="color:#666;font-size:13px;">If the button doesn't work, copy and paste this link into your browser:<br>${verifyUrl}</p>
      <p style="color:#666;font-size:13px;">If you didn't create this account, you can safely ignore this email.</p>
    </div>
  `;
}

function orderRowsHtml(order) {
  const isPickup = order.delivery_method === 'pickup';
  const deliveryLine = isPickup
    ? `<strong>Pickup at:</strong> ${order.shipping_address || ''}`
    : `<strong>Deliver to (${order.delivery_zone || 'delivery'}):</strong><br>${order.shipping_address || ''}, ${[order.shipping_city, order.shipping_state].filter(Boolean).join(', ')}`;

  const itemRows = order.items.map(item => `
      <tr><td style="padding:4px 0;color:#666;">${item.product_name} (${item.size || '—'} × ${item.quantity})</td><td style="padding:4px 0;text-align:right;">${formatKobo(item.line_total_kobo)}</td></tr>
  `).join('');

  return `
    <table style="width:100%; border-collapse:collapse; margin:16px 0; font-size:14px;">
      ${itemRows}
      <tr><td style="padding:4px 0;color:#666;border-top:1px solid #eee;">Items total</td><td style="padding:4px 0;text-align:right;border-top:1px solid #eee;">${formatKobo(order.item_total_kobo)}</td></tr>
      <tr><td style="padding:4px 0;color:#666;">Delivery fee</td><td style="padding:4px 0;text-align:right;">${isPickup ? 'Free (pickup)' : formatKobo(order.shipping_fee_kobo)}</td></tr>
      <tr><td style="padding:8px 0;font-weight:bold;border-top:1px solid #ddd;">Total</td><td style="padding:8px 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatKobo(order.amount_kobo)}</td></tr>
    </table>
    <p style="font-size:13.5px;color:#666;">
      ${deliveryLine}<br>
      Phone: ${order.shipping_phone || '—'}
    </p>
  `;
}

function formatKobo(kobo) {
  const n = Number(kobo) || 0;
  return '₦' + (n / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Sent to the store admin the moment a new order/pre-order comes in.
function orderNotificationEmailHtml({ order, customer }) {
  return `
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto;">
      <h2 style="color:${BRAND_COLOR};">🔔 New ${order.type === 'preorder' ? 'pre-order' : 'order'} received</h2>
      <p><strong>${customer.name}</strong> (${customer.email}) just placed an order.</p>
      ${orderRowsHtml(order)}
      <p style="font-size:13px;color:#999;">Order reference: ${order.id}</p>
    </div>
  `;
}

// Sent to the customer after their payment is confirmed.
function orderReceiptEmailHtml({ order, customerName }) {
  return `
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto;">
      <h2 style="color:${BRAND_COLOR};">Thanks for your order, ${customerName}! ✅</h2>
      <p>Your payment was successful and your ${order.type === 'preorder' ? 'pre-order' : 'order'} is confirmed.</p>
      ${orderRowsHtml(order)}
      <p style="font-size:13px;color:#999;">Order reference: ${order.id}</p>
      <p style="font-size:13px;color:#666;">Questions about this order? Just reply to this email.</p>
    </div>
  `;
}

const STATUS_MESSAGES = {
  confirmed: { emoji: '✅', headline: 'Your order is confirmed', body: "We've got it and we're getting it ready." },
  shipped: { emoji: '📦', headline: 'Your order has shipped!', body: "It's on its way to you now." },
  cancelled: { emoji: '❌', headline: 'Your order was cancelled', body: 'If this seems wrong, just reply to this email and we\'ll sort it out.' }
};

// Sent to the customer whenever an admin changes an order's status.
function orderStatusUpdateEmailHtml({ order, customerName, status }) {
  const info = STATUS_MESSAGES[status] || { emoji: '📋', headline: 'Order update', body: `Your order status changed to "${status.replace('_', ' ')}".` };
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:${BRAND_COLOR};">${info.emoji} ${info.headline}</h2>
      <p>Hi ${customerName}, ${info.body}</p>
      ${orderRowsHtml(order)}
      <p style="font-size:13px;color:#999;">Order reference: ${order.id}</p>
    </div>
  `;
}

module.exports = { sendEmail, verificationEmailHtml, orderNotificationEmailHtml, orderReceiptEmailHtml, orderStatusUpdateEmailHtml };
