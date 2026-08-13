# MK Trading App — Project Documentation
*Solutions Engineering Training · Lean Technologies · June–July 2026*

---

## Overview

MK Trading App is a demo UAE trading platform built during SE onboarding at Lean Technologies. It demonstrates Lean's full Open Banking product surface in a single app — allowing a user to link their bank, view their live balance, and deposit funds into a mock trading account.

Built by: Mohammed Ishrath  
Role: Solutions Engineer, Lean Technologies  
Started: June 16, 2026  

---

## What Was Built

### App Summary
A single-page Node.js/Express + vanilla JS app simulating a UAE trading platform (like Capital.com or Plus500). Users go through a 3-step flow: link bank → verify balance → deposit.

The app supports **three payment rails**, each accessible from a top navigation tab:

| Tab | Rail | Description |
|-----|------|-------------|
| **RE** | Reverse Engineering | Lean scrapes the bank on the user's behalf. `Lean.connect()` + `Lean.pay()` |
| **SIP** | OF Single Instant Payment | One-time payment via Open Finance. `Lean.checkout()` — no prior setup needed |
| **AOF** | Account on File | Pre-authorized consent. `Lean.authorizeConsent()` + direct backend payment call |
| **Reconciliation** | — | Verify payments matched actual bank deposits |
| **Payout** | — | Withdraw trading balance back to bank via Lean Payouts API |

---

## File Structure

```
tradestart/
├── server.js        # Node.js/Express backend — all Lean API calls
├── index.html       # Frontend — single file, HTML/CSS/JS
├── redirect.html    # OF redirect landing page (after AlTareq)
├── package.json     # Dependencies: express, cors
```

---

## Credentials & Config (Sandbox)

| Key | Value |
|-----|-------|
| App Token / client_id | `bf283b92-6f2f-4488-ace6-d89491ca2d52` |
| Client Secret | *(see `.env` — never committed)* |
| Auth Base URL | `https://auth.sandbox.leantech.me` |
| API Base URL | `https://sandbox.leantech.me` |
| Payment Destination ID | `342ad057-2edf-4b3f-87cc-6991e8f74c6c` |
| Destination Name | MK LAB RECON (FAB UAE) |
| Destination Status | CONFIRMED |
| Payout Source ID | `c2bf511f-5946-4c24-8a12-b6cb58c20abc` |

> ⚠️ All sandbox credentials. Never use in production.

---

## How to Run

```bash
# 1. Install
cd tradestart && npm install

# 2. Start backend
node server.js
# → http://localhost:3000

# 3. Expose via ngrok (new terminal)
npx ngrok http 3000
# → Copy the https://xxx.ngrok-free.dev URL

# 4. Open in browser (MUST use ngrok URL, not localhost)
https://xxx.ngrok-free.dev/index.html
```

### Lean Dashboard Setup (per ngrok session)
1. **Webhooks** → Add endpoint: `https://xxx.ngrok-free.dev/webhooks/lean` — subscribe ALL events
2. **Settings → Redirection URLs** → Add: `https://xxx.ngrok-free.dev/index.html`

> ⚠️ ngrok free tier generates a new URL on every restart. Update dashboard each time.

---

## Authentication Model

Two OAuth2 tokens with different scopes:

### Backend Token (scope: api)
```
POST https://auth.sandbox.leantech.me/oauth2/token
client_id:     bf283b92-...
client_secret: (from LEAN_CLIENT_SECRET)
grant_type:    client_credentials
scope:         api
→ { access_token: "eyJ...", expires_in: 3599 }
```
Used in `Authorization: Bearer` header for all backend Lean API calls. Auto-refreshed. **Never sent to browser.**

### Frontend Token (scope: customer.<id>)
```
Same endpoint, scope: customer.{customer_id}
```
Passed as `access_token` in SDK calls (`Lean.connect`, `Lean.pay`, etc.). Minted per customer by backend.

---

## Backend API Routes

### `POST /api/init`
Called on every page load. Creates/recovers Lean Customer, mints customer token, returns full state.

**Recovery after restart:** calls `GET /customers/v1/app-user-id/{id}` → `GET /customers/v1/{id}/entities` → `GET /customers/v1/{id}/payment-sources` → `GET /consents/v1?customer_id={id}` to rebuild state from Lean's side.

### `GET /api/balance`
Fetches live balance via RE Data API.
1. `GET /data/v2/accounts?entity_id={id}` → get account list, store `accountId`, `accountHolderName`, IBAN
2. `GET /data/v2/accounts/{account_id}/balances?entity_id={id}` → get balances

Balance priority: `INTERIM_AVAILABLE` → `CLOSING_AVAILABLE` → first available.

### `GET /api/transactions`
Fetches transaction history. RE only.
- `GET /data/v2/accounts/{account_id}/transactions?entity_id={id}&page=0&size=20`
- Maps to clean shape: `{ id, description, amount, currency, type (CREDIT/DEBIT), date, merchant, category }`

### `GET /api/identity`
Returns `accountHolderName` and IBAN. Cached from balance fetch; falls back to re-fetching accounts.

### `POST /api/payment-intent`
Creates RE Payment Intent for `Lean.pay()`.
```json
{
  "customer_id": "...",
  "amount": 500,
  "currency": "AED",
  "purpose_code": "PIN",
  "payment_destination_id": "342ad057-...",
  "description": "MKT dep 12583043"  // ≤ 32 chars
}
```
Stores pending payment record (with `intentId`, no `id` yet — set by webhook).

### `POST /api/sip/payment-intent`
Creates OF-SIP Payment Intent for `Lean.checkout()`.
- Same as above but `purpose_code: "FIS"` (Financial Institution Services)
- Returns `{ paymentIntentId, accessToken }`

### `POST /api/of/create-consent`
Creates Account-on-File consent. If AUTHORISED consent already exists, returns it.
```json
{
  "customer_id": "...",
  "destination_account_id": "342ad057-...",
  "currency": "AED",
  "purpose": "PIN",
  "control_parameters": {
    "type": "VariableOnDemand",
    "period_type": "Month",
    "max_individual_amount": 50000,
    "max_cumulative_amount_per_period": 500000
  },
  "government_identifier": {
    "type": "EMIRATES_ID",
    "value": "784-1990-1234567-1"  // sandbox mock
  }
}
```

### `GET /api/of/balance`
`GET /consents/v1/{consent_id}/balance` → `{ balance, currency }`

### `POST /api/of/pay`
Direct AOF payment — no SDK needed. Requires `Idempotency-Key` header.
```json
{
  "consent_id": "...",
  "amount": 500,
  "purpose": "PIN",
  "reference": "MKT dep 12583043",
  "risk_details": { "transaction_indicators": { "channel": "WEB" } }
}
```

### `POST /api/payout`
Withdrawal from platform to bank via Payouts API.
- Sender: `PAYOUT_SOURCE_ID = c2bf511f-...`
- Destination: `PAYMENT_DESTINATION_ID`
- Requires `idempotency-key` header

### `GET /api/reconciliation`
Fetches all stored payments enriched with reconciliation status from `GET /reconciliation/v1/payments/{payment_id}`.

Returns: `{ payments: [{ id, intentId, amount, currency, rail, initiatedAt, status, reconciliationStatus, deposit }] }`

### `GET /api/reconciliation/deposits`
Raw deposits received at FAB destination account. Filterable by `start`, `end`, `status`.

### `GET /api/status`
Polled by frontend every 2s after bank linking. Returns current state: `entityId`, `paymentSourceId`, `beneficiaryStatus`, `consentId`, `consentStatus`, `tradingBalance`.

### `POST /webhooks/lean`
Handles all Lean events.

### `DELETE /api/dev/reset`
Dev-only. Deletes entity, revokes consent, clears store.

---

## Webhook Handlers

| Event | Action |
|-------|--------|
| `entity.created` | `store[appUserId].entityId = payload.id` |
| `payment_source.created` | Ignored |
| `payment_source.beneficiary.created` | Store `paymentSourceId` + `beneficiaryStatus` |
| `payment_source.beneficiary.updated` | Update `beneficiaryStatus` |
| `consent.status.updated` | Store `consentId = payload.id`, `consentStatus = payload.status` |
| `payment.created` | Match by `intent_id` → set real `payment_id`; update `tradingBalance` |
| `payment.updated` | SIP status updates → update `tradingBalance` |
| `payment.account-on-file.updated` | AOF PROCESSED → update `tradingBalance` |

> ⚠️ Field names: `entity.created` uses `payload.id` (not `payload.entity_id`). `consent.status.updated` uses `payload.id` (not `payload.consent_id`).

---

## RE Flow

1. `Lean.connect()` with `permissions: ["identity","accounts","balance","transactions","payments"]` + `payment_destination_id`
2. Webhooks: `payment_source.beneficiary.created` → `entity.created`
3. Frontend polls `/api/status` until `entityId` appears
4. Balance: two-call sequence via Data API
5. Deposit: `POST /api/payment-intent` → `Lean.pay(payment_intent_id)`
6. `payment.created` webhook → real `payment_id` stored → trading balance updated

---

## SIP Flow

1. No bank link step — straight to deposit amount
2. `POST /api/sip/payment-intent` → `paymentIntentId` + `accessToken`
3. `Lean.checkout()` → AlTareq redirect
4. Page reloads at `?sip_status=SUCCESS&ts_user_id={appUserId}`
5. `init()` detects params → calls `handleSipRedirectReturn()` → `Lean.captureRedirect()`
6. `pollForSipPayment()` watches trading balance for increase via webhook

---

## AOF Flow

1. `POST /api/of/create-consent` → `consent_id`
2. `Lean.authorizeConsent({ consent_id })` → AlTareq redirect
3. Page reloads at `?of_status=SUCCESS&ts_user_id={appUserId}`
4. `consent.status.updated` webhook fires with `status: AUTHORISED`
5. Frontend polls `/api/status` until `consentStatus === AUTHORISED`
6. Balance: `GET /consents/v1/{consent_id}/balance`
7. Deposit: `POST /api/of/pay` — no SDK, direct backend call
8. `payment.created` webhook → trading balance updated

---

## In-Memory Store

```javascript
store["appUserId"] = {
  customerId,           // Lean Customer ID
  entityId,             // RE: entity for data access
  accountId,            // RE: first account ID
  accountHolderName,    // RE: from accounts response
  iban,                 // RE: from accounts response
  paymentSourceId,      // RE: payment source
  beneficiaryStatus,    // RE: AWAITING_BENEFICIARY_COOL_OFF | ACTIVE
  consentId,            // AOF: consent ID
  consentStatus,        // AOF: AWAITING_AUTHORISATION | AUTHORISED
  tradingBalance,       // mock trading balance
  payments: [{          // all deposits across rails
    id,                 // real payment_id (set by webhook)
    intentId,           // payment_intent_id (set at creation)
    amount, currency,
    rail,               // RE | SIP | OF
    initiatedAt,
    status,
    _balanceCredited    // dedup flag for SIP
  }]
}
```

**Limitation:** In-memory. Wiped on server restart. Recovery via `/api/init` re-fetches from Lean's API.

---

## Reconciliation

| Status | Meaning |
|--------|---------|
| `RECONCILED` | Payment matched to real bank deposit. Money arrived. |
| `OUTSTANDING` | Payment initiated, no matching deposit yet. |
| `UNRECEIVED` | No match found. Investigate. |

> In sandbox, most payments stay `OUTSTANDING` because Mockbank doesn't simulate real deposits landing at FAB. Expected behavior.

---

## Sandbox Test Users

| Username | Password | Notes |
|----------|----------|-------|
| clarecorwin7427 | vJrmROdaTZwM | Simple login |
| analisareynolds413 | VVROaffXHrvcA | Has MFA |
| kamigrady6671 | ZLVAPzrF | Simple login |

> `entity.created` only fires for genuinely new customers (first bank link). On repeat testing, use `sessionStorage.clear()` + server restart to force a new customer.

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `CUSTOMER_ALREADY_EXISTS` 409 | Server restarted | Normal — recovery auto-handles it |
| `payment_source.beneficiary.created` never fires | Webhook not subscribed | Add it in Lean dashboard → Webhooks |
| `entity.created` never fires | Same test user reused | `sessionStorage.clear()` + restart server |
| `government_identifier is required` | AOF consent missing Emirates ID | Pass `{ type: "EMIRATES_ID", value: "..." }` |
| `Redirect URL doesn't match` | URL not in Lean dashboard | Add ngrok URL to Settings → Redirection URLs |
| `INVALID_PARAMETERS` on payment | description > 32 chars, wrong purpose_code, or unconfirmed destination | Check all three |
| `404` on Payouts | Product not enabled | Ask Lean team to provision Payouts on sandbox app |
| `Cannot read properties of null` in JS | Element ID not in DOM | Verify HTML contains the element before referencing it |
| Reconciliation shows nothing | Wrong payment ID stored | Must use `payment_id` from `payment.created` webhook, not `payment_intent_id` |

---

## Key Lessons Learned

1. **Two-token model** — `scope:api` for backend. `scope:customer.<id>` for frontend SDK. Client secret never leaves `server.js`.

2. **Webhooks are infrastructure, not code** — When a webhook-driven flow fails silently, check in order: (1) Is ngrok running and URL current? (2) Are the right events subscribed? (3) Does terminal show anything arriving? Only then look at code.

3. **Combine permissions in one `Lean.connect()` call** — `["identity","accounts","balance","transactions","payments"]` creates both Entity and Payment Source in one bank login. Splitting causes double login.

4. **Webhook field names are exact** — `entity.created` → `payload.id`, not `payload.entity_id`. `consent.status.updated` → `payload.id`, not `payload.consent_id`. Read the actual payload.

5. **RE payment ID ≠ intent ID** — Store `payment_intent_id` at creation time, then update with real `payment_id` from `payment.created` webhook. The Reconciliation API needs the real `payment_id`.

6. **OF redirect session survival** — Pass `ts_user_id` as a query param in the redirect URL so `sessionStorage` can be restored after AlTareq reloads the page at a new URL.

7. **`entity.created` fires once** — Only for genuinely new customers. Re-testing the same user won't trigger it. Use a fresh `appUserId` to force it.

8. **In-memory state dies on restart** — Always have a Lean API recovery path in `/api/init`. Never assume local state is canonical.

9. **Debug at the right layer** — Use Elastic logs + `lean-correlation-id`. Check `/api/status` first before assuming webhook code is wrong.

10. **HTML, CSS, and JS must all be present** — When referencing a DOM element in JS, the HTML must contain that element. When using a CSS class in JS-generated HTML, the CSS must define it. Verify all three before shipping.

---

## What's Not Production-Ready

- In-memory store — replace with PostgreSQL/Redis
- No webhook signature verification — add HMAC validation
- No user authentication — `appUserId` is self-generated
- Hardcoded Emirates ID — collect real Emirates ID during KYC
- Dev reset endpoint — remove before deploying
- ngrok — use a fixed domain in production
- `confirmation_of_payee_status: FAILED` on destination — investigate before go-live

---

## Lean Products Demonstrated

| Product | API | Status |
|---------|-----|--------|
| RE Data (Balance) | `GET /data/v2/accounts/{id}/balances` | ✅ |
| RE Data (Transactions) | `GET /data/v2/accounts/{id}/transactions` | ✅ |
| RE Data (Identity) | `account_holder_name` from accounts response | ✅ |
| RE SIP Payment | `POST /payments/v1/intents` + `Lean.pay()` | ✅ |
| OF SIP Payment | `POST /payments/v1/intents` + `Lean.checkout()` | ✅ |
| OF Account on File | `POST /consents/v1/account-on-file` + `Lean.authorizeConsent()` | ✅ |
| OF AOF Payment | `POST /payments/v1/account-on-file` | ✅ |
| Reconciliation | `GET /reconciliation/v1/payments/{id}` | ✅ |
| Payouts | `POST /payouts/v1/payment` | ✅ (sandbox provisioned) |
| Payment Links | — | ❌ Not built |
| Account Verification | — | ❌ Not built |
| Manual Data Refresh | `POST /data/v2/refreshes` | ❌ Not built |

---

*Generated: July 7, 2026*
