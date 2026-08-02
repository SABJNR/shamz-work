// Simple JSON-file "database". No native compilation needed (unlike sqlite3
// drivers), so this installs and runs cleanly on any machine with just Node.js.
// Fine for a small storefront; if you outgrow it, swap this file for a real
// database (Postgres, MySQL, etc.) without touching server.js's calling code
// much, since it's all accessed through the functions exported below.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: [], products: [], orders: [], waitlist: [], nextId: { users: 1, products: 1, orders: 1, waitlist: 1 } };
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

function nextId(table) {
  const id = data.nextId[table]++;
  return id;
}

function persist() {
  saveData(data);
}

// ---------- Seed default admin + sample products on first run ----------
if (data.users.length === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  data.users.push({
    id: nextId('users'), name: 'Admin', email: 'admin@example.com', phone: '',
    password_hash: hash, is_admin: 1, created_at: new Date().toISOString()
  });
  console.log('Seeded default admin: admin@example.com / admin123  (CHANGE THIS PASSWORD)');
}

if (data.products.length === 0) {
  const sample = [
    ['Classic Oxford Shirt', 'A clean, everyday button-down in crisp cotton oxford.', 1800000, 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=800', 'available', 0, 'S,M,L,XL'],
    ['Essential Crewneck Tee', 'Heavyweight cotton tee, boxy fit, built to last.', 900000, 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800', 'available', 0, 'S,M,L,XL,XXL'],
    ['Shamz Signature Hoodie (Coming Soon)', 'Our next drop — heavyweight fleece hoodie with embroidered logo. Preview only.', 2500000, 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800', 'unreleased', 0, 'S,M,L,XL'],
    ['Varsity Bomber Jacket (Pre-order)', 'Limited pre-order run, ships in 4 weeks.', 3800000, 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800', 'unreleased', 1, 'S,M,L,XL']
  ];
  sample.forEach(([name, description, price, image_url, status, allow_preorder, sizes]) => {
    data.products.push({
      id: nextId('products'), name, description, price, currency: 'NGN', image_url,
      status, allow_preorder, sizes, created_at: new Date().toISOString()
    });
  });
  console.log('Seeded sample products.');
}
persist();

// ================= Users =================
const users = {
  findByEmail(email) {
    return data.users.find(u => u.email === email.toLowerCase()) || null;
  },
  findById(id) {
    return data.users.find(u => u.id === Number(id)) || null;
  },
  create({ name, email, phone, password_hash, is_admin }) {
    const user = { id: nextId('users'), name, email: email.toLowerCase(), phone: phone || '', password_hash, is_admin: is_admin ? 1 : 0, created_at: new Date().toISOString() };
    data.users.push(user);
    persist();
    return user;
  },
  findAdminByEmail(email) {
    return data.users.find(u => u.email === email.toLowerCase() && u.is_admin) || null;
  }
};

// ================= Products =================
const products = {
  all() {
    return [...data.products].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  available() {
    return products.all().filter(p => p.status === 'available');
  },
  unreleased() {
    return products.all().filter(p => p.status === 'unreleased');
  },
  find(id) {
    return data.products.find(p => p.id === Number(id)) || null;
  },
  create(fields) {
    const p = { id: nextId('products'), created_at: new Date().toISOString(), ...fields };
    data.products.push(p);
    persist();
    return p;
  },
  update(id, fields) {
    const p = products.find(id);
    if (!p) return null;
    Object.assign(p, fields);
    persist();
    return p;
  },
  remove(id) {
    data.products = data.products.filter(p => p.id !== Number(id));
    persist();
  }
};

// ================= Orders =================
const orders = {
  create(fields) {
    const o = { id: nextId('orders'), status: 'pending_payment', created_at: new Date().toISOString(), ...fields };
    data.orders.push(o);
    persist();
    return o;
  },
  forUser(userId) {
    return data.orders
      .filter(o => o.user_id === Number(userId))
      .map(o => ({ ...o, product: products.find(o.product_id) }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  allWithDetails() {
    return data.orders
      .map(o => ({ ...o, product: products.find(o.product_id), customer: users.findById(o.user_id) }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  updateStatus(id, status) {
    const o = data.orders.find(o => o.id === Number(id));
    if (o) { o.status = status; persist(); }
    return o;
  },
  count() {
    return data.orders.length;
  }
};

// ================= Waitlist =================
const waitlist = {
  add(userId, productId) {
    const exists = data.waitlist.find(w => w.user_id === Number(userId) && w.product_id === Number(productId));
    if (exists) return exists;
    const w = { id: nextId('waitlist'), user_id: Number(userId), product_id: Number(productId), created_at: new Date().toISOString() };
    data.waitlist.push(w);
    persist();
    return w;
  },
  has(userId, productId) {
    return !!data.waitlist.find(w => w.user_id === Number(userId) && w.product_id === Number(productId));
  },
  allWithDetails() {
    return data.waitlist
      .map(w => ({ ...w, product: products.find(w.product_id), customer: users.findById(w.user_id) }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  count() {
    return data.waitlist.length;
  }
};

module.exports = { users, products, orders, waitlist };
