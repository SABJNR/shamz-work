// Sends transactional emails (signup verification, etc.) using Brevo's REST API.
// https://developers.brevo.com/reference/sendtransacemail
//
// Requires two environment variables (set these in Render's dashboard, or in
// your local .env file):
//   BREVO_API_KEY      - your Brevo API key (Settings -> SMTP & API -> API Keys)
//   BREVO_SENDER_EMAIL - the email address you verified as a sender in Brevo
//   BREVO_SENDER_NAME  - (optional) display name, defaults to "F.D.C Clothing Store"
//
// If these aren't set, emails are skipped and logged to the console instead —
// this lets the rest of the app keep working during local development without
// needing a real email account set up.

async function sendEmail({ to, toName, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'F.D.C Clothing Store';

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

function verificationEmailHtml({ name, verifyUrl }) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#2B3A6B;">Welcome to F.D.C Clothing Store, ${name}!</h2>
      <p>Please confirm your email address to activate your account and start ordering.</p>
      <p style="margin: 28px 0;">
        <a href="${verifyUrl}" style="background:#B2502A;color:#fff;padding:12px 24px;text-decoration:none;border-radius:2px;display:inline-block;">
          Verify my email
        </a>
      </p>
      <p style="color:#666;font-size:13px;">If the button doesn't work, copy and paste this link into your browser:<br>${verifyUrl}</p>
      <p style="color:#666;font-size:13px;">If you didn't create this account, you can safely ignore this email.</p>
    </div>
  `;
}

module.exports = { sendEmail, verificationEmailHtml };
