// MongoDB-backed data layer. Requires a MONGODB_URI environment variable
// pointing at a free MongoDB Atlas cluster (see README for setup steps).
//
// All functions here are async (they return Promises), since talking to a
// real database over the network isn't instant like the old JSON-file
// version was. Every call site in server.js awaits these.

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

let client;
let dbConn;

async function connect() {
  if (dbConn) return dbConn;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Add it to your .env file (local) or your ' +
      'hosting provider\'s environment variables (production). See README.md.'
    );
  }
  client = new MongoClient(uri, {
    serverApi: { version: '1', strict: true, deprecationErrors: true },
    serverSelectionTimeoutMS: 10000
  });
  await client.connect();
  dbConn = client.db(); // uses the database name embedded in the URI
  await ensureSeedData();
  return dbConn;
}

// ---------- helpers ----------

// Converts a Mongo document's _id (ObjectId) into a plain string `id` field,
// so the rest of the app can keep treating ids as simple strings (used in
// URLs like /product/:id) without needing to know about ObjectId anywhere else.
function withStringId(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toHexString(), ...rest };
}

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null; // invalid id format -- callers treat this as "not found"
  }
}

async function ensureSeedData() {
  const usersCol = dbConn.collection('users');
  const productsCol = dbConn.collection('products');

  const userCount = await usersCol.countDocuments();
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await usersCol.insertOne({
      name: 'Admin', email: 'admin@example.com', phone: '',
      password_hash: hash, is_admin: 1, email_verified: 1, verification_token: null,
      address: '', city: '', state: '',
      created_at: new Date().toISOString()
    });
    console.log('Seeded default admin: admin@example.com / admin123  (CHANGE THIS PASSWORD)');
  }

  const productCount = await productsCol.countDocuments();
  if (productCount === 0) {
    const sample = [
      ['Classic Oxford Shirt', 'A clean, everyday button-down in crisp cotton oxford.', 1800000, 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=800', 'available', 0, 'S,M,L,XL'],
      ['Essential Crewneck Tee', 'Heavyweight cotton tee, boxy fit, built to last.', 900000, 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800', 'available', 0, 'S,M,L,XL,XXL'],
      ['Shamz Signature Hoodie (Coming Soon)', 'Our next drop — heavyweight fleece hoodie with embroidered logo. Preview only.', 2500000, 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800', 'unreleased', 0, 'S,M,L,XL'],
      ['Varsity Bomber Jacket (Pre-order)', 'Limited pre-order run, ships in 4 weeks.', 3800000, 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800', 'unreleased', 1, 'S,M,L,XL']
    ];
    await productsCol.insertMany(sample.map(([name, description, price, image_url, status, allow_preorder, sizes]) => ({
      name, description, price, currency: 'NGN', image_url, status, allow_preorder, sizes,
      created_at: new Date().toISOString()
    })));
    console.log('Seeded sample products.');
  }
}

// ================= Users =================
const users = {
  async findByEmail(email) {
    const doc = await dbConn.collection('users').findOne({ email: email.toLowerCase() });
    return withStringId(doc);
  },
  async findById(id) {
    const oid = toObjectId(id);
    if (!oid) return null;
    const doc = await dbConn.collection('users').findOne({ _id: oid });
    return withStringId(doc);
  },
  async create({ name, email, phone, password_hash, is_admin, email_verified }) {
    const doc = {
      name,
      email: email.toLowerCase(),
      phone: phone || '',
      password_hash,
      is_admin: is_admin ? 1 : 0,
      email_verified: email_verified ? 1 : 0,
      verification_token: email_verified ? null : crypto.randomBytes(24).toString('hex'),
      address: '',
      city: '',
      state: '',
      created_at: new Date().toISOString()
    };
    const result = await dbConn.collection('users').insertOne(doc);
    return withStringId({ _id: result.insertedId, ...doc });
  },
  async findAdminByEmail(email) {
    const doc = await dbConn.collection('users').findOne({ email: email.toLowerCase(), is_admin: 1 });
    return withStringId(doc);
  },
  async findByVerificationToken(token) {
    const doc = await dbConn.collection('users').findOne({ verification_token: token });
    return withStringId(doc);
  },
  async markVerified(id) {
    const oid = toObjectId(id);
    if (!oid) return null;
    await dbConn.collection('users').updateOne({ _id: oid }, { $set: { email_verified: 1, verification_token: null } });
    return users.findById(id);
  },
  async regenerateVerificationToken(id) {
    const oid = toObjectId(id);
    if (!oid) return null;
    const token = crypto.randomBytes(24).toString('hex');
    await dbConn.collection('users').updateOne({ _id: oid }, { $set: { verification_token: token } });
    return users.findById(id);
  },
  async updatePassword(id, password_hash) {
    const oid = toObjectId(id);
    if (!oid) return null;
    await dbConn.collection('users').updateOne({ _id: oid }, { $set: { password_hash } });
    return users.findById(id);
  },
  async updateProfile(id, { name, phone, address, city, state }) {
    const oid = toObjectId(id);
    if (!oid) return null;
    const update = {};
    if (name !== undefined) update.name = name;
    if (phone !== undefined) update.phone = phone;
    if (address !== undefined) update.address = address;
    if (city !== undefined) update.city = city;
    if (state !== undefined) update.state = state;
    await dbConn.collection('users').updateOne({ _id: oid }, { $set: update });
    return users.findById(id);
  },
  async listAdmins() {
    const docs = await dbConn.collection('users').find({ is_admin: 1 }).toArray();
    return docs.map(withStringId);
  }
};

// ================= Products =================
const products = {
  async all() {
    const docs = await dbConn.collection('products').find().sort({ created_at: -1 }).toArray();
    return docs.map(withStringId);
  },
  async available() {
    const docs = await dbConn.collection('products').find({ status: 'available' }).sort({ created_at: -1 }).toArray();
    return docs.map(withStringId);
  },
  async unreleased() {
    const docs = await dbConn.collection('products').find({ status: 'unreleased' }).sort({ created_at: -1 }).toArray();
    return docs.map(withStringId);
  },
  async find(id) {
    const oid = toObjectId(id);
    if (!oid) return null;
    const doc = await dbConn.collection('products').findOne({ _id: oid });
    return withStringId(doc);
  },
  async create(fields) {
    const doc = { ...fields, created_at: new Date().toISOString() };
    const result = await dbConn.collection('products').insertOne(doc);
    return withStringId({ _id: result.insertedId, ...doc });
  },
  async update(id, fields) {
    const oid = toObjectId(id);
    if (!oid) return null;
    await dbConn.collection('products').updateOne({ _id: oid }, { $set: fields });
    return products.find(id);
  },
  async remove(id) {
    const oid = toObjectId(id);
    if (!oid) return;
    await dbConn.collection('products').deleteOne({ _id: oid });
  }
};

// ================= Orders =================
const orders = {
  async create(fields) {
    const doc = { ...fields, status: 'pending_payment', created_at: new Date().toISOString() };
    const result = await dbConn.collection('orders').insertOne(doc);
    return withStringId({ _id: result.insertedId, ...doc });
  },
  async find(id) {
    const oid = toObjectId(id);
    if (!oid) return null;
    const doc = await dbConn.collection('orders').findOne({ _id: oid });
    return withStringId(doc);
  },
  async forUser(userId) {
    const docs = await dbConn.collection('orders').find({ user_id: userId }).sort({ created_at: -1 }).toArray();
    return docs.map(withStringId);
  },
  async allWithDetails() {
    const docs = await dbConn.collection('orders').find().sort({ created_at: -1 }).toArray();
    const result = [];
    for (const o of docs) {
      const order = withStringId(o);
      order.customer = await users.findById(order.user_id);
      result.push(order);
    }
    return result;
  },
  async update(id, fields) {
    const oid = toObjectId(id);
    if (!oid) return null;
    await dbConn.collection('orders').updateOne({ _id: oid }, { $set: fields });
    return orders.find(id);
  },
  async updateStatus(id, status) {
    return orders.update(id, { status });
  },
  async count() {
    return dbConn.collection('orders').countDocuments();
  }
};

// ================= Waitlist =================
const waitlist = {
  async add(userId, productId) {
    const existing = await dbConn.collection('waitlist').findOne({ user_id: userId, product_id: productId });
    if (existing) return withStringId(existing);
    const doc = { user_id: userId, product_id: productId, created_at: new Date().toISOString() };
    const result = await dbConn.collection('waitlist').insertOne(doc);
    return withStringId({ _id: result.insertedId, ...doc });
  },
  async has(userId, productId) {
    const doc = await dbConn.collection('waitlist').findOne({ user_id: userId, product_id: productId });
    return !!doc;
  },
  async allWithDetails() {
    const docs = await dbConn.collection('waitlist').find().sort({ created_at: -1 }).toArray();
    const result = [];
    for (const w of docs) {
      const entry = withStringId(w);
      entry.product = await products.find(entry.product_id);
      entry.customer = await users.findById(entry.user_id);
      result.push(entry);
    }
    return result;
  },
  async count() {
    return dbConn.collection('waitlist').countDocuments();
  }
};

module.exports = { connect, users, products, orders, waitlist };
