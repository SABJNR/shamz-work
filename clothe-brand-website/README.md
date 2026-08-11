# Shamz Clothing Store — Website

A custom-built storefront where:
- **Anyone can browse** — available items and unreleased/"coming soon" drops — with no account.
- **Ordering requires an account with a verified email.** Guests are prompted to sign up when they click "Order" or "Pre-order," and get a verification email before they can actually place one.
- **Customer profiles** save name/phone/address once, and pre-fill at checkout (like Jumia/Amazon).
- **Unreleased items** can be marked either "preview only" (with a "notify me" waitlist) or "pre-order open," per item.
- **You (admin)** manage everything from `/admin`: add/edit/delete products, set availability, view all orders/waitlist, change your password, and add trusted co-admins.
- **Data persists for real.** Products, orders, and customer accounts are stored in MongoDB Atlas (free), and uploaded product photos in Cloudinary (free) — both survive restarts and redeploys, unlike the earlier version of this app.

## Tech stack
Node.js + Express + EJS templates, MongoDB (via the official `mongodb` driver) for data, Cloudinary for image uploads, Brevo for transactional email. No frontend framework/build step and no native modules to compile, so `npm install` works cleanly on any machine.

## One-time setup: create your free database

You need a MongoDB Atlas account (free forever, no card required) before the app will run.

1. Go to [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) and sign up.
2. Create a free **M0 cluster** (the free tier) — accept the defaults.
3. Under **Database Access**, create a database user with a username and password (save these).
4. Under **Network Access**, click **Add IP Address** → **Allow Access from Anywhere** (`0.0.0.0/0`) — simplest for a small project; you can tighten this later.
5. Go to your cluster → **Connect** → **Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Add a database name right after `.net/` (anything you like, e.g. `shamz`):
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/shamz?retryWrites=true&w=majority
   ```
   Replace `<username>` and `<password>` with what you created in step 3.

That full string is your `MONGODB_URI`.

## Running it locally

1. Install [Node.js](https://nodejs.org) (v18 or later).
2. In this folder, install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
4. Open `.env` and fill in:
   - `SESSION_SECRET` — any long random string
   - `MONGODB_URI` — the connection string from the setup above (**required** — the app won't start without it)
   - Optionally `BREVO_*` and `CLOUDINARY_*` (see below) — the app still runs without these, it just skips sending real emails / uploading real images until you add them.
5. Start the server:
   ```
   npm start
   ```
6. Visit **http://localhost:3000**. On first run it seeds a default admin account and a few sample products into your database.

## Admin panel

Go to **http://localhost:3000/login** (same login as customers — admin accounts are auto-routed to `/admin` after logging in).

Default login (⚠️ change immediately — go to `/admin/change-password` after logging in):
- Email: `admin@example.com`
- Password: `admin123`

From the admin panel you can:
- **Products** — add/edit items, upload an image (if Cloudinary is configured) or paste an image URL, set price, sizes, and status.
- **Orders** — see every order/pre-order with the customer's contact info, update status.
- **Waitlist** — see everyone waiting on an unreleased item.
- **Change Password** — update your own admin password.
- **Admin Accounts** — see all admins, and create new trusted admin accounts (e.g. for your client or team). New admins you create this way are marked verified immediately — no email loop.

## Email verification (Brevo)

Customer accounts start unverified and can't place orders until they click a link sent to their email. To actually send that email:

1. Sign up free at [brevo.com](https://www.brevo.com) (no card needed).
2. **Settings → Senders & IP → Senders** — add and verify a sender email (your own Gmail works fine).
3. **Settings → SMTP & API → API Keys** — generate a new key.
4. Put that key in `.env` (or your host's environment variables) as `BREVO_API_KEY`, and the verified sender email as `BREVO_SENDER_EMAIL`.

Without this set up, the app just prints "would have sent..." to the console instead of emailing anyone — fine for local testing, not fine for real customers.

## Taking real payments (Paystack)

By default, orders are recorded but no online payment is collected — the admin follows up manually. To actually charge customers online:

1. Sign up free at [paystack.com](https://paystack.com) — no card needed to start in test mode.
2. Go to **Settings → API Keys & Webhooks**.
3. Copy the **Secret Key** — use the **Test Secret Key** (`sk_test_...`) while developing, and only switch to the **Live Secret Key** (`sk_live_...`) once you're ready for real customer payments (Paystack will ask you to complete a short business verification first).
4. Put it in `.env` (or your host's environment variables) as `PAYSTACK_SECRET_KEY`.

Once set, the order flow changes automatically:
- Customer fills the order form → gets sent to Paystack's secure payment page
- After paying, they're brought back and the order is marked **confirmed** — but only after the server double-checks with Paystack that the payment genuinely succeeded (never trusting the browser redirect alone)
- If payment fails or is abandoned, the order is marked **payment failed**, and the customer sees a **"Pay now"** button under "My Orders" to retry
- Admin sees real-time payment status on the Orders page

Test mode gives you fake card numbers to test the full flow without moving real money — see [Paystack's test cards](https://paystack.com/docs/payments/test-payments/) docs.

## Product image uploads (Cloudinary)

By default, the admin product form only accepts an image **URL** (paste a link). To allow uploading a photo file directly:

1. Sign up free at [cloudinary.com](https://cloudinary.com) (no card needed).
2. From your Dashboard, copy your **Cloud name**, **API Key**, and **API Secret**.
3. Put these in `.env` (or your host's environment variables) as `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.

Once set, the "upload a file" option appears automatically on the product form, and uploaded images are stored permanently on Cloudinary (not on your app server, which can get wiped on redeploy).

## Deploying (e.g. on Render)

1. Push this project to GitHub.
2. On [Render](https://render.com), create a new **Web Service** from your repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Under **Environment**, add all the variables from your `.env` file: `SESSION_SECRET`, `MONGODB_URI`, and the Brevo/Cloudinary ones if you're using them, plus `APP_BASE_URL` set to your Render URL (e.g. `https://your-app.onrender.com`) so verification email links point to the right place.
4. Deploy. Because data now lives in MongoDB Atlas and images in Cloudinary (not on Render's disk), everything will survive redeploys and restarts from now on.

## Project structure

```
server.js             Main app — all routes (public, customer auth, orders, admin)
db.js                  MongoDB data layer + seed data
mailer.js              Sends verification emails via Brevo
views/                 EJS templates (pages)
  admin/                Admin panel pages
  partials/             Shared header/footer
public/css/style.css   Styling
```

## Making it yours

- Brand name is set to "Shamz Clothing Store" in `views/partials/header.ejs` and `views/partials/footer.ejs`.
- Replace the color palette / fonts in `public/css/style.css` (`:root` variables at the top).
- Delete the sample products from the admin panel and add your real ones.
