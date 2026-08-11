require('dotenv').config();
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const db = require('./db');
const { sendEmail, verificationEmailHtml } = require('./mailer');
const paystack = require('./paystack');

const app = express();
const PORT = process.env.PORT || 3000;

const cloudinaryConfigured = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// ---- View engine ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- Middleware ----
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
  // NOTE: in-memory session store — fine for local dev and low-traffic sites,
  // but resets on restart and won't scale across multiple instances. Swap in
  // a persistent store (e.g. connect-mongo, since we already have MongoDB)
  // if that becomes a problem.
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// Make current user available to all views. Verification status is looked
// up fresh from the database on every request (instead of trusting the
// value cached at login time), so clicking the verify link updates the
// banner immediately -- even if it was clicked in a different browser/tab
// than the one currently logged in.
app.use(async (req, res, next) => {
  if (req.session.user) {
    try {
      const fresh = await db.users.findById(req.session.user.id);
      if (fresh) {
        req.session.user.email_verified = fresh.email_verified;
        req.session.user.name = fresh.name; // keep display name in sync too
      }
    } catch (e) {
      console.error('Failed to refresh session user:', e.message);
    }
  }
  res.locals.currentUser = req.session.user || null;
  res.locals.formatPrice = (kobo, currency = 'NGN') => {
    const amount = (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
    const symbol = currency === 'NGN' ? '₦' : currency + ' ';
    return `${symbol}${amount}`;
  };
  next();
});

function baseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Small helper so we don't need try/catch in every single async route.
function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---- File upload config (product images) ----
// Images are uploaded to Cloudinary (persistent) when configured; otherwise
// they fall back to storing directly on local disk, which is fine for local
// development but WON'T persist on most free hosting (see README).
const upload = multer({ storage: multer.memoryStorage() });

async function uploadImageIfPresent(file) {
  if (!file) return null;
  if (!cloudinaryConfigured) {
    console.warn('[uploads] CLOUDINARY_* env vars not set — image upload skipped. Use an image URL instead, or configure Cloudinary (see README).');
    return null;
  }
  const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  const result = await cloudinary.uploader.upload(dataUri, { folder: 'shamz-clothing-store' });
  return result.secure_url;
}

// ---- Auth helpers ----
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.redirectTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) {
    req.session.redirectTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (!req.session.user.is_admin) {
    return res.redirect('/');
  }
  next();
}
// Must be logged in AND have a verified email — used for ordering/pre-ordering.
const requireVerified = asyncRoute(async (req, res, next) => {
  if (!req.session.user) {
    req.session.redirectTo = req.originalUrl;
    return res.redirect('/login');
  }
  const user = await db.users.findById(req.session.user.id);
  if (!user || !user.email_verified) {
    return res.redirect('/verify-email-notice');
  }
  next();
});

// =====================================================
// PUBLIC ROUTES — anyone can view, no account needed
// =====================================================

app.get('/', asyncRoute(async (req, res) => {
  res.render('home', { available: await db.products.available(), unreleased: await db.products.unreleased() });
}));

app.get('/product/:id', asyncRoute(async (req, res) => {
  const product = await db.products.find(req.params.id);
  if (!product) return res.status(404).render('404');
  let alreadyWaitlisted = false;
  let profileUser = null;
  if (req.session.user) {
    alreadyWaitlisted = await db.waitlist.has(req.session.user.id, product.id);
    profileUser = await db.users.findById(req.session.user.id);
  }
  res.render('product', { product, alreadyWaitlisted, profileUser, paystackEnabled: paystack.isConfigured() });
}));

// =====================================================
// CUSTOMER AUTH — required only when they try to order
// =====================================================

app.get('/signup', (req, res) => res.render('signup', { error: null, redirectTo: req.query.redirectTo || '/' }));

app.post('/signup', asyncRoute(async (req, res) => {
  const { name, email, phone, password, redirectTo } = req.body;
  if (!name || !email || !password) {
    return res.render('signup', { error: 'All fields are required.', redirectTo });
  }
  if (password.length < 8) {
    return res.render('signup', { error: 'Password must be at least 8 characters.', redirectTo });
  }
  const existing = await db.users.findByEmail(email);
  if (existing) {
    return res.render('signup', { error: 'An account with this email already exists. Please log in instead.', redirectTo });
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = await db.users.create({ name, email, phone, password_hash: hash, is_admin: 0, email_verified: 0 });

  try {
    const verifyUrl = `${baseUrl(req)}/verify-email?token=${user.verification_token}`;
    await sendEmail({
      to: user.email,
      toName: user.name,
      subject: 'Confirm your email — Shamz Clothing Store',
      html: verificationEmailHtml({ name: user.name, verifyUrl })
    });
  } catch (e) {
    console.error('Failed to send verification email:', e.message);
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: 0, email_verified: 0 };
  req.session.pendingRedirect = redirectTo && redirectTo.startsWith('/') ? redirectTo : '/';
  res.redirect('/verify-email-notice');
}));

app.get('/verify-email-notice', requireLogin, asyncRoute(async (req, res) => {
  const user = await db.users.findById(req.session.user.id);
  // If they're already verified (e.g. clicked the link on their phone, then
  // came back to this tab and refreshed), skip straight to where they were
  // headed instead of showing "check your inbox" forever.
  if (user && user.email_verified) {
    const dest = req.session.pendingRedirect || '/';
    delete req.session.pendingRedirect;
    return res.redirect(dest);
  }
  res.render('verify-email-notice', { user, continueTo: req.session.pendingRedirect || '/' });
}));

app.post('/resend-verification', requireLogin, asyncRoute(async (req, res) => {
  const user = await db.users.findById(req.session.user.id);
  if (!user || user.email_verified) return res.redirect('/');
  const fresh = await db.users.regenerateVerificationToken(user.id);
  try {
    const verifyUrl = `${baseUrl(req)}/verify-email?token=${fresh.verification_token}`;
    await sendEmail({
      to: fresh.email,
      toName: fresh.name,
      subject: 'Confirm your email — Shamz Clothing Store',
      html: verificationEmailHtml({ name: fresh.name, verifyUrl })
    });
  } catch (e) {
    console.error('Failed to resend verification email:', e.message);
  }
  res.redirect('/verify-email-notice');
}));

app.get('/verify-email', asyncRoute(async (req, res) => {
  const { token } = req.query;
  const user = token ? await db.users.findByVerificationToken(token) : null;
  if (!user) {
    return res.render('verify-email-result', { success: false });
  }
  await db.users.markVerified(user.id);
  if (req.session.user && req.session.user.id === user.id) {
    req.session.user.email_verified = 1;
  }
  res.render('verify-email-result', { success: true });
}));

app.get('/login', (req, res) => res.render('login', { error: null, redirectTo: req.query.redirectTo || req.session.redirectTo || '/' }));

app.post('/login', asyncRoute(async (req, res) => {
  const { email, password, redirectTo } = req.body;
  const user = await db.users.findByEmail(email || '');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid email or password.', redirectTo });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, email_verified: user.email_verified };

  if (user.is_admin) {
    delete req.session.redirectTo;
    return res.redirect('/admin');
  }

  const dest = req.session.redirectTo || (redirectTo && redirectTo.startsWith('/') ? redirectTo : '/');
  delete req.session.redirectTo;
  res.redirect(dest);
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// =====================================================
// CUSTOMER PROFILE — saved address, like Jumia/Amazon,
// so it's remembered and prefilled at checkout.
// =====================================================

app.get('/profile', requireLogin, asyncRoute(async (req, res) => {
  const user = await db.users.findById(req.session.user.id);
  res.render('profile', { user, saved: req.query.saved === '1' });
}));

app.post('/profile', requireLogin, asyncRoute(async (req, res) => {
  const { name, phone, address, city, state } = req.body;
  const updated = await db.users.updateProfile(req.session.user.id, { name, phone, address, city, state });
  req.session.user.name = updated.name;
  res.redirect('/profile?saved=1');
}));

// =====================================================
// ORDERING — account + verified email required from here
// =====================================================

app.post('/order/:productId', requireVerified, asyncRoute(async (req, res) => {
  const product = await db.products.find(req.params.productId);
  if (!product) return res.status(404).render('404');
  const { size, quantity, shipping_address, note } = req.body;
  const qty = Number(quantity) || 1;

  const type = product.status === 'unreleased' ? 'preorder' : 'order';

  const order = await db.orders.create({
    user_id: req.session.user.id,
    product_id: product.id,
    size,
    quantity: qty,
    type,
    shipping_address,
    note: note || '',
    amount_kobo: product.price * qty
  });

  // If Paystack isn't set up yet, fall back to the old manual-payment flow
  // (order gets recorded, admin follows up to collect payment directly) so
  // the site keeps working while you're waiting on a Paystack account.
  if (!paystack.isConfigured()) {
    return res.render('order-confirmation', { product, paid: false, paystackEnabled: false });
  }

  try {
    const authUrl = await paystack.initializePayment({
      email: req.session.user.email,
      amountInKobo: order.amount_kobo,
      reference: order.id,
      callbackUrl: `${baseUrl(req)}/payment/callback`,
      metadata: { order_id: order.id, product_name: product.name }
    });
    res.redirect(authUrl);
  } catch (e) {
    console.error('Failed to start Paystack payment:', e.message);
    res.render('order-confirmation', { product, paid: false, paystackEnabled: true, startError: true });
  }
}));

// Paystack redirects the customer's browser back here after they attempt
// payment. We NEVER trust this redirect alone -- we always re-verify the
// payment status directly with Paystack's servers before treating an order
// as paid.
app.get('/payment/callback', asyncRoute(async (req, res) => {
  const { reference } = req.query;
  const order = reference ? await db.orders.find(reference) : null;
  if (!order) {
    return res.render('payment-result', { success: false, product: null });
  }
  const product = await db.products.find(order.product_id);

  try {
    const verification = await paystack.verifyPayment(reference);
    if (verification.success && verification.amountInKobo === order.amount_kobo) {
      await db.orders.update(order.id, { status: 'confirmed' });
      return res.render('order-confirmation', { product, paid: true, paystackEnabled: true });
    }
    await db.orders.update(order.id, { status: 'cancelled' });
    return res.render('payment-result', { success: false, product });
  } catch (e) {
    console.error('Payment verification failed:', e.message);
    return res.render('payment-result', { success: false, product });
  }
}));

// Lets a customer retry payment on an order that's still unpaid (e.g. they
// closed the Paystack tab, or a previous attempt failed).
app.post('/pay/:orderId', requireVerified, asyncRoute(async (req, res) => {
  const order = await db.orders.find(req.params.orderId);
  if (!order || order.user_id !== req.session.user.id) return res.status(404).render('404');
  if (order.status === 'confirmed' || order.status === 'shipped') return res.redirect('/my-orders');
  if (!paystack.isConfigured()) return res.redirect('/my-orders');

  try {
    const authUrl = await paystack.initializePayment({
      email: req.session.user.email,
      amountInKobo: order.amount_kobo,
      reference: order.id,
      callbackUrl: `${baseUrl(req)}/payment/callback`,
      metadata: { order_id: order.id }
    });
    res.redirect(authUrl);
  } catch (e) {
    console.error('Failed to restart Paystack payment:', e.message);
    res.redirect('/my-orders');
  }
}));

app.post('/waitlist/:productId', requireVerified, asyncRoute(async (req, res) => {
  const product = await db.products.find(req.params.productId);
  if (!product) return res.status(404).render('404');
  await db.waitlist.add(req.session.user.id, product.id);
  res.redirect('/product/' + product.id);
}));

app.get('/my-orders', requireLogin, asyncRoute(async (req, res) => {
  const rawOrders = await db.orders.forUser(req.session.user.id);
  const orders = rawOrders.map(o => ({
    ...o,
    product_name: o.product ? o.product.name : '(deleted product)',
    image_url: o.product ? o.product.image_url : '',
    price: o.product ? o.product.price : 0,
    currency: o.product ? o.product.currency : 'NGN'
  }));
  res.render('my-orders', { orders });
}));

// =====================================================
// ADMIN — same login as customers; admins are auto-routed
// here after logging in (see /login above). This route is
// kept only so old bookmarks/links still work.
// =====================================================

app.get('/admin/login', (req, res) => res.redirect('/login?redirectTo=/admin'));
app.post('/admin/login', (req, res) => res.redirect(307, '/login'));

app.get('/admin', requireAdmin, asyncRoute(async (req, res) => {
  res.render('admin/dashboard', {
    products: await db.products.all(),
    orderCount: await db.orders.count(),
    waitlistCount: await db.waitlist.count()
  });
}));

app.get('/admin/products/new', requireAdmin, (req, res) => {
  res.render('admin/product-form', { product: null, uploadsEnabled: cloudinaryConfigured });
});

app.post('/admin/products', requireAdmin, upload.single('image'), asyncRoute(async (req, res) => {
  const { name, description, price, currency, status, allow_preorder, sizes, image_url } = req.body;
  const uploadedUrl = await uploadImageIfPresent(req.file);
  const finalImage = uploadedUrl || image_url || '';
  await db.products.create({
    name, description,
    price: Math.round(parseFloat(price) * 100),
    currency: currency || 'NGN',
    image_url: finalImage,
    status,
    allow_preorder: status === 'unreleased' && allow_preorder ? 1 : 0,
    sizes: sizes || 'S,M,L,XL'
  });
  res.redirect('/admin');
}));

app.get('/admin/products/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
  const product = await db.products.find(req.params.id);
  if (!product) return res.status(404).render('404');
  res.render('admin/product-form', { product, uploadsEnabled: cloudinaryConfigured });
}));

app.put('/admin/products/:id', requireAdmin, upload.single('image'), asyncRoute(async (req, res) => {
  const { name, description, price, currency, status, allow_preorder, sizes, image_url } = req.body;
  const existing = await db.products.find(req.params.id);
  const uploadedUrl = await uploadImageIfPresent(req.file);
  const finalImage = uploadedUrl || image_url || existing.image_url;
  await db.products.update(req.params.id, {
    name, description,
    price: Math.round(parseFloat(price) * 100),
    currency: currency || 'NGN',
    image_url: finalImage,
    status,
    allow_preorder: status === 'unreleased' && allow_preorder ? 1 : 0,
    sizes: sizes || 'S,M,L,XL'
  });
  res.redirect('/admin');
}));

app.delete('/admin/products/:id', requireAdmin, asyncRoute(async (req, res) => {
  await db.products.remove(req.params.id);
  res.redirect('/admin');
}));

app.get('/admin/orders', requireAdmin, asyncRoute(async (req, res) => {
  const raw = await db.orders.allWithDetails();
  const orders = raw.map(o => ({
    ...o,
    product_name: o.product ? o.product.name : '(deleted product)',
    customer_name: o.customer ? o.customer.name : '(deleted user)',
    customer_email: o.customer ? o.customer.email : '',
    customer_phone: o.customer ? o.customer.phone : ''
  }));
  res.render('admin/orders', { orders });
}));

app.put('/admin/orders/:id/status', requireAdmin, asyncRoute(async (req, res) => {
  await db.orders.updateStatus(req.params.id, req.body.status);
  res.redirect('/admin/orders');
}));

app.get('/admin/waitlist', requireAdmin, asyncRoute(async (req, res) => {
  const raw = await db.waitlist.allWithDetails();
  const entries = raw.map(w => ({
    ...w,
    product_name: w.product ? w.product.name : '(deleted product)',
    customer_name: w.customer ? w.customer.name : '(deleted user)',
    customer_email: w.customer ? w.customer.email : ''
  }));
  res.render('admin/waitlist', { entries });
}));

// ---- Admin account security: change password, manage admin accounts ----

app.get('/admin/change-password', requireAdmin, (req, res) => {
  res.render('admin/change-password', { error: null, success: false });
});

app.post('/admin/change-password', requireAdmin, asyncRoute(async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = await db.users.findById(req.session.user.id);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.render('admin/change-password', { error: 'Current password is incorrect.', success: false });
  }
  if (!new_password || new_password.length < 8) {
    return res.render('admin/change-password', { error: 'New password must be at least 8 characters.', success: false });
  }
  if (new_password !== confirm_password) {
    return res.render('admin/change-password', { error: 'New password and confirmation do not match.', success: false });
  }
  await db.users.updatePassword(user.id, bcrypt.hashSync(new_password, 10));
  res.render('admin/change-password', { error: null, success: true });
}));

app.get('/admin/admins', requireAdmin, asyncRoute(async (req, res) => {
  res.render('admin/admins', { admins: await db.users.listAdmins(), error: null, success: false });
}));

app.post('/admin/admins', requireAdmin, asyncRoute(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.render('admin/admins', { admins: await db.users.listAdmins(), error: 'All fields are required and password must be at least 8 characters.', success: false });
  }
  const existing = await db.users.findByEmail(email);
  if (existing) {
    return res.render('admin/admins', { admins: await db.users.listAdmins(), error: 'An account with this email already exists.', success: false });
  }
  await db.users.create({ name, email, phone: '', password_hash: bcrypt.hashSync(password, 10), is_admin: 1, email_verified: 1 });
  res.render('admin/admins', { admins: await db.users.listAdmins(), error: null, success: true });
}));

app.use((req, res) => res.status(404).render('404'));

// Basic error handler for anything that throws inside an async route.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong on our end. Please try again in a moment.');
});

process.on('unhandledRejection', (err) => {
  console.error('\n  Unhandled error:');
  console.error(err);
  setTimeout(() => process.exit(1), 500);
});

db.connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Shamz Clothing Store running at http://localhost:${PORT}`);
      console.log(`  Admin panel:  http://localhost:${PORT}/admin/login`);
      console.log(`  Default admin login: admin@example.com / admin123 (change this!)\n`);
    });
  })
  .catch(err => {
    console.error('\n  Failed to connect to the database.');
    console.error('  ' + (err && err.message ? err.message : err) + '\n');
    // Give the log lines above a moment to actually flush to the console
    // before the process dies -- process.exit() can otherwise cut output
    // off mid-stream on some hosts, hiding the real error.
    setTimeout(() => process.exit(1), 500);
  });
