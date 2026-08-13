# TradeStart – Test App

A minimal trading platform mock that demonstrates the full Lean Open Banking flow:
**Link bank → Read balance → Initiate instant deposit**

---

## Architecture

```
index.html  (frontend)
│
│  1. Lean.connect()  ──────────────────────────────────►  LinkSDK CDN
│  2. POST /api/init  ──────────────────────────────────►  server.js
│  3. GET  /api/balance  ───────────────────────────────►  server.js → Lean Data API
│  4. POST /api/payment-intent  ────────────────────────►  server.js → Lean Payment API
│  5. Lean.pay(paymentIntentId)  ───────────────────────►  LinkSDK CDN
│
◄──────  POST /webhooks/lean  ◄─────────────────────────  Lean Platform
         entity.created → store entity_id
         payment.created → update trading balance
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure your Lean credentials
```bash
cp .env.example .env
```
Fill in `LEAN_CLIENT_SECRET` and the other values from https://portal.sandbox.leantech.me — the server refuses to start without `LEAN_CLIENT_SECRET` set.

### 3. Start the backend
```bash
npm run dev
# or: node server.js
```
Server runs on http://localhost:3000

### 4. Expose webhooks to the internet
Lean needs to reach your backend to send webhook events.
Use ngrok (free):
```bash
npx ngrok http 3000
```
Copy the HTTPS URL (e.g. https://abc123.ngrok.io).

### 5. Register webhook URL in Lean Dashboard
1. Go to https://portal.sandbox.leantech.me
2. Navigate to Webhooks → Add endpoint
3. URL: https://abc123.ngrok.io/webhooks/lean
4. Select events: entity.created, payment.created

### 6. Open the frontend
Open index.html directly in your browser (or serve it with any static server):
```bash
npx serve .
# then open http://localhost:5000
```

---

## Lean API calls made by this app

| Step | Method | Endpoint | What it does |
|------|--------|----------|--------------|
| Init | POST | /customers/v1/ | Creates a Lean Customer for the user |
| Init | POST | /sessions/v1 | Mints a short-lived session token for LinkSDK |
| Balance | GET | /data/v2/accounts | Lists accounts for the entity |
| Balance | GET | /data/v2/accounts/{id}/balances | Fetches live balance |
| Payment | POST | /payments/v1/intents | Creates a payment intent |

---

## Key concepts to understand

### Entity vs Customer vs Payment Source

- **Customer**: Your user in Lean's system. Created by your backend. Has a `customer_id`.
- **Entity**: Created when a user completes `Lean.connect()`. It's the permission grant that lets you call the Data API (balances, transactions). Has an `entity_id`.
- **Payment Source**: Also created when a user completes `Lean.connect()` (if PAYMENTS permission is included). It's the bank account reference used when the user pays. Has a `payment_source_id`.

One `Lean.connect()` call creates BOTH the entity AND the payment source.

### Session Token vs App Token

- **App Token** (`bf283b92-...`): Your public identifier. Goes in the frontend — it's safe to expose.
- **Client Secret** (set via `LEAN_CLIENT_SECRET` in `.env`): Never expose this. Used only on the backend to create session tokens.
- **Session Token**: Short-lived token minted by your backend. The frontend passes it to Lean SDK calls. This way, the user can only do things your backend has authorised.

### Webhook flow (entity.created)

When `Lean.connect()` completes, Lean fires an `entity.created` webhook to your backend.
Your backend receives the `entity_id` and stores it against the user.
Without the `entity_id`, you cannot call the Data API.

This is why the frontend polls `/api/status` after connect — waiting for the webhook.

### Payment Intent flow

1. Your backend creates a Payment Intent with amount + currency.
2. Lean returns a `payment_intent_id`.
3. Your frontend passes `payment_intent_id` to `Lean.pay()`.
4. LinkSDK shows the user the payment confirmation screen.
5. User confirms in their banking app.
6. Lean fires `payment.created` webhook to your backend.

---

## Sandbox testing

In sandbox mode, you can use Lean's test bank credentials to complete a full flow without a real bank account. See: https://docs.leantech.me/docs/sandbox-testing

---

## Production checklist

- [ ] Replace `sandbox: "true"` with `sandbox: "false"` in Lean.connect() and Lean.pay()
- [ ] Change BASE_URL in server.js to `https://api2.leantech.me`
- [ ] Replace in-memory `store` with a proper database
- [ ] Implement webhook signature verification (HMAC)
- [ ] Add authentication to backend routes
- [ ] Add idempotency keys to Payment Intent creation
- [ ] Handle `payment_destination_id` (your company's receiving IBAN)
