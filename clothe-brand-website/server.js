require('dotenv').config();
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- View engine ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- Middleware ----
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use(session({
  // NOTE: in-memory session store — fine for local dev, but resets on restart
  // and won't scale across multiple instances. For production, swap in a
  // persistent store (e.g. Redis or a database-backed one).
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// Make current user available to all views
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.formatPrice = (kobo, currency = 'NGN') => {
    const amount = (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
    const symbol = currency === 'NGN' ? '₦' : currency + ' ';
    return `${symbol}${amount}`;
  };
  next();
});

// ---- File upload config (product images) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-'))
});
const upload = multer({ storage });

// ---- Auth helpers ----
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.redirectTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.redirect('/admin/login');
  }
  next();
}

// =====================================================
// PUBLIC ROUTES — anyone can view, no account needed
// =====================================================

app.get('/', (req, res) => {
  res.render('home', { available: db.products.available(), unreleased: db.products.unreleased() });
});

app.get('/product/:id', (req, res) => {
  const product = db.products.find(req.params.id);
  if (!product) return res.status(404).render('404');
  let alreadyWaitlisted = false;
  if (req.session.user) {
    alreadyWaitlisted = db.waitlist.has(req.session.user.id, product.id);
  }
  res.render('product', { product, alreadyWaitlisted });
});

// =====================================================
// CUSTOMER AUTH — required only when they try to order
// =====================================================

app.get('/signup', (req, res) => res.render('signup', { error: null, redirectTo: req.query.redirectTo || '/' }));

app.post('/signup', (req, res) => {
  const { name, email, phone, password, redirectTo } = req.body;
  if (!name || !email || !password) {
    return res.render('signup', { error: 'All fields are required.', redirectTo });
  }
  const existing = db.users.findByEmail(email);
  if (existing) {
    return res.render('signup', { error: 'An account with this email already exists. Please log in instead.', redirectTo });
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = db.users.create({ name, email, phone, password_hash: hash, is_admin: 0 });
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: 0 };
  res.redirect(redirectTo && redirectTo.startsWith('/') ? redirectTo : '/');
});

app.get('/login', (req, res) => res.render('login', { error: null, redirectTo: req.query.redirectTo || req.session.redirectTo || '/' }));

app.post('/login', (req, res) => {
  const { email, password, redirectTo } = req.body;
  const user = db.users.findByEmail(email || '');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid email or password.', redirectTo });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin };
  const dest = req.session.redirectTo || (redirectTo && redirectTo.startsWith('/') ? redirectTo : '/');
  delete req.session.redirectTo;
  res.redirect(dest);
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// =====================================================
// ORDERING — account required from this point on
// =====================================================

app.post('/order/:productId', requireLogin, (req, res) => {
  const product = db.products.find(req.params.productId);
  if (!product) return res.status(404).render('404');
  const { size, quantity, shipping_address, note } = req.body;

  const type = product.status === 'unreleased' ? 'preorder' : 'order';

  db.orders.create({
    user_id: req.session.user.id,
    product_id: product.id,
    size,
    quantity: Number(quantity) || 1,
    type,
    shipping_address,
    note: note || ''
  });

  res.render('order-confirmation', { product });
});

app.post('/waitlist/:productId', requireLogin, (req, res) => {
  const product = db.products.find(req.params.productId);
  if (!product) return res.status(404).render('404');
  db.waitlist.add(req.session.user.id, product.id);
  res.redirect('/product/' + product.id);
});

app.get('/my-orders', requireLogin, (req, res) => {
  const orders = db.orders.forUser(req.session.user.id).map(o => ({
    ...o,
    product_name: o.product ? o.product.name : '(deleted product)',
    image_url: o.product ? o.product.image_url : '',
    price: o.product ? o.product.price : 0,
    currency: o.product ? o.product.currency : 'NGN'
  }));
  res.render('my-orders', { orders });
});

// =====================================================
// ADMIN — separate login, manage products & view orders
// =====================================================

app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));

app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.users.findAdminByEmail(email || '');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('admin/login', { error: 'Invalid admin credentials.' });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: 1 };
  res.redirect('/admin');
});

app.get('/admin', requireAdmin, (req, res) => {
  res.render('admin/dashboard', {
    products: db.products.all(),
    orderCount: db.orders.count(),
    waitlistCount: db.waitlist.count()
  });
});

app.get('/admin/products/new', requireAdmin, (req, res) => {
  res.render('admin/product-form', { product: null });
});

app.post('/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  const { name, description, price, currency, status, allow_preorder, sizes, image_url } = req.body;
  const finalImage = req.file ? '/uploads/' + req.file.filename : (image_url || '');
  db.products.create({
    name, description,
    price: Math.round(parseFloat(price) * 100),
    currency: currency || 'NGN',
    image_url: finalImage,
    status,
    allow_preorder: status === 'unreleased' && allow_preorder ? 1 : 0,
    sizes: sizes || 'S,M,L,XL'
  });
  res.redirect('/admin');
});

app.get('/admin/products/:id/edit', requireAdmin, (req, res) => {
  const product = db.products.find(req.params.id);
  if (!product) return res.status(404).render('404');
  res.render('admin/product-form', { product });
});

app.put('/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const { name, description, price, currency, status, allow_preorder, sizes, image_url } = req.body;
  const existing = db.products.find(req.params.id);
  const finalImage = req.file ? '/uploads/' + req.file.filename : (image_url || existing.image_url);
  db.products.update(req.params.id, {
    name, description,
    price: Math.round(parseFloat(price) * 100),
    currency: currency || 'NGN',
    image_url: finalImage,
    status,
    allow_preorder: status === 'unreleased' && allow_preorder ? 1 : 0,
    sizes: sizes || 'S,M,L,XL'
  });
  res.redirect('/admin');
});

app.delete('/admin/products/:id', requireAdmin, (req, res) => {
  db.products.remove(req.params.id);
  res.redirect('/admin');
});

app.get('/admin/orders', requireAdmin, (req, res) => {
  const orders = db.orders.allWithDetails().map(o => ({
    ...o,
    product_name: o.product ? o.product.name : '(deleted product)',
    customer_name: o.customer ? o.customer.name : '(deleted user)',
    customer_email: o.customer ? o.customer.email : '',
    customer_phone: o.customer ? o.customer.phone : ''
  }));
  res.render('admin/orders', { orders });
});

app.put('/admin/orders/:id/status', requireAdmin, (req, res) => {
  db.orders.updateStatus(req.params.id, req.body.status);
  res.redirect('/admin/orders');
});

app.get('/admin/waitlist', requireAdmin, (req, res) => {
  const entries = db.waitlist.allWithDetails().map(w => ({
    ...w,
    product_name: w.product ? w.product.name : '(deleted product)',
    customer_name: w.customer ? w.customer.name : '(deleted user)',
    customer_email: w.customer ? w.customer.email : ''
  }));
  res.render('admin/waitlist', { entries });
});

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`\n  Clothe brand site running at http://localhost:${PORT}`);
  console.log(`  Admin panel:  http://localhost:${PORT}/admin/login`);
  console.log(`  Default admin login: admin@example.com / admin123 (change this!)\n`);
});
