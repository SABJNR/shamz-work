# Shamz Clothing Store — Website

A custom-built storefront where:
- **Anyone can browse** — available items and unreleased/"coming soon" drops — with no account.
- **Ordering requires an account.** Guests are prompted to log in or sign up only when they click "Order" or "Pre-order."
- **Unreleased items** can be marked either "preview only" (with a "notify me" waitlist) or "pre-order open," per item — you decide when you add/edit the product.
- **You (admin)** manage everything from a separate `/admin` panel: add/edit/delete products, set availability, and view all orders and waitlist signups.

## Tech stack
Plain Node.js + Express + EJS templates + a simple JSON-file database (`data.json`, created automatically). No frontend framework/build step and no native modules to compile, so `npm install` works cleanly on any machine — including Windows without Visual Studio Build Tools installed.

## Running it locally

1. Install [Node.js](https://nodejs.org) (v18 or later).
2. In this folder, install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and set a real `SESSION_SECRET` (any long random string):
   ```
   cp .env.example .env
   ```
4. Start the server:
   ```
   npm start
   ```
5. Visit **http://localhost:3000**. The database file (`data.json`) is created automatically on first run, with a default admin account and a few sample products.

## Admin panel

Go to **http://localhost:3000/admin/login**

Default login (⚠️ change immediately):
- Email: `admin@example.com`
- Password: `admin123`

To change the admin password right now, the simplest way is to delete `data.json` and edit the seed password in `db.js` before restarting — see the `bcrypt.hashSync('admin123', 10)` line. (A proper "change password" admin screen is a natural next feature to add.)

From the admin panel you can:
- **Products** — add new items, upload an image (or paste an image URL), set price, sizes, and status (`Available now` vs `Unreleased`). For unreleased items, you choose whether customers can pre-order or only preview + join a waitlist.
- **Orders** — see every order/pre-order placed, with the customer's contact info, and update its status (pending payment → confirmed → shipped, or cancelled).
- **Waitlist** — see everyone who asked to be notified about an unreleased item, so you can email them when it drops.

## About payments

You mentioned payment method isn't decided yet, so right now "placing an order" just records the order as `pending_payment` and shows the customer's contact + shipping info in your admin Orders page — you follow up manually to collect payment. When you're ready:

- **Online payment (recommended for Nigeria):** [Paystack](https://paystack.com) or [Flutterwave](https://flutterwave.com) both have straightforward Node.js SDKs. The natural place to add this is inside the `/order/:productId` route in `server.js` — redirect to a payment page before saving the order as `confirmed`.
- **Pay on delivery / bank transfer:** the current setup already works for this as-is — you just contact the customer using the details in the Orders panel.

Happy to build the Paystack/Flutterwave integration for you once you've picked one and created an account with them (you'll need their API keys).

## Deploying it so it's live on the internet

This is a standard Node.js app, so it runs on most hosts. A few beginner-friendly options:

- **[Render](https://render.com)** — free tier, connect your GitHub repo, it runs `npm install && npm start` automatically.
- **[Railway](https://railway.app)** — similar, very quick for Node + SQLite apps.
- **A VPS (e.g. DigitalOcean, Hetzner)** — more control, use `pm2` to keep the app running.

One thing to know: this app stores data in a file (`data.json`) on disk. Most free hosting tiers **do not** persist disk storage between deploys/restarts, which would wipe your products/orders each time. For a real production launch, either:
- pick a host with a persistent disk (Render's paid tier, a VPS), or
- move to a hosted database like Postgres (a moderate rewrite of `db.js`, happy to help when you're ready).

Also note: sessions currently use Express's default **in-memory** store, which is fine for development but resets when the server restarts and won't work correctly if you run more than one server instance. For production, swap in a persistent session store (e.g. Redis).

## Project structure

```
server.js            Main app — all routes (public, customer auth, orders, admin)
db.js                 JSON-file data layer + seed data (creates data.json)
views/                EJS templates (pages)
  admin/               Admin panel pages
  partials/            Shared header/footer
public/css/style.css  Styling
public/uploads/       Uploaded product images land here
```

## Making it yours

- Brand name is already set to "Shamz Clothing Store" in `views/partials/header.ejs` and `views/partials/footer.ejs` — edit those files directly if it needs to change again.
- Replace the color palette / fonts in `public/css/style.css` (`:root` variables at the top) if you want a different look.
- Delete the sample products from the admin panel and add your real ones (shirts, tops, hoodies, etc.).
