// Handles payments via Paystack (https://paystack.com). Uses Node's built-in
// fetch, no extra npm package needed.
//
// Requires one environment variable:
//   PAYSTACK_SECRET_KEY - from your Paystack dashboard (Settings -> API Keys & Webhooks)
//   Use the "Test Secret Key" while developing, and the "Live Secret Key"
//   only once you're ready to accept real payments.
//
// If PAYSTACK_SECRET_KEY isn't set, initializePayment() throws a clear error
// so ordering fails loudly with an obvious message instead of silently
// letting people "order" without ever paying.

const PAYSTACK_BASE = 'https://api.paystack.co';

function isConfigured() {
  return !!process.env.PAYSTACK_SECRET_KEY;
}

// Starts a payment. Returns the URL to redirect the customer to.
// amountInKobo: the amount to charge, in kobo (i.e. price * 100), matching
// how prices are already stored in this app for NGN.
async function initializePayment({ email, amountInKobo, reference, callbackUrl, metadata }) {
  if (!isConfigured()) {
    throw new Error('PAYSTACK_SECRET_KEY is not set. Add it to your environment variables to enable payments.');
  }
  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      amount: amountInKobo,
      reference,
      callback_url: callbackUrl,
      metadata
    })
  });
  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || 'Failed to start payment with Paystack.');
  }
  return data.data.authorization_url;
}

// Confirms with Paystack (server-to-server, not trusting the browser) that a
// payment actually went through. Returns { success, amountInKobo } or throws.
async function verifyPayment(reference) {
  if (!isConfigured()) {
    throw new Error('PAYSTACK_SECRET_KEY is not set.');
  }
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
  });
  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data.message || 'Failed to verify payment with Paystack.');
  }
  return {
    success: data.data.status === 'success',
    amountInKobo: data.data.amount
  };
}

module.exports = { isConfigured, initializePayment, verifyPayment };
