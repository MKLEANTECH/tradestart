/**
 * TradeStart – Backend Server
 * Node.js + Express
 *
 * Supports two rails:
 *  RE (Reverse Engineering): Lean.connect() → entity_id + payment_source_id → Lean.pay()
 *  OF (Open Finance):        POST /consents/v1/account-on-file → Lean.authorizeConsent()
 *                            → consent_id → POST /payments/v1/account-on-file
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (redirect.html, index.html) via ngrok
app.use(express.static(__dirname));

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Secrets and app-specific IDs come from the environment (see .env.example)
// so this file is safe to publish — nothing here is a real credential.
// APP_TOKEN itself isn't secret (same value is already public in index.html —
// it's the LinkSDK's public app identifier, not an auth credential), so it
// keeps a fallback for local convenience. CLIENT_SECRET has none: it's a real
// OAuth secret and must come from the environment or startup fails loudly.
const APP_TOKEN     = process.env.LEAN_APP_TOKEN || "bf283b92-6f2f-4488-ace6-d89491ca2d52"; // = client_id for oauth2/token
const CLIENT_SECRET = process.env.LEAN_CLIENT_SECRET;
if (!CLIENT_SECRET) {
  throw new Error("LEAN_CLIENT_SECRET is not set — copy .env.example to .env and fill it in.");
}
const AUTH_BASE_URL = process.env.LEAN_AUTH_BASE_URL || "https://auth.sandbox.leantech.me";
const API_BASE_URL  = process.env.LEAN_API_BASE_URL || "https://sandbox.leantech.me";

// Confirmed payment destination for this sandbox app (MK LAB RECON / FAB_UAE).
// Verified via GET /payments/v1/destinations/{id} → status: "CONFIRMED".
// NOTE: this is a PAYMENTS destination — Payouts does NOT accept it (see
// PAYOUT_DESTINATION_ID below). Confirmed 2026-07-07 after a payout failed
// with "destination with id = ... not found" when this ID was reused.
const PAYMENT_DESTINATION_ID = process.env.LEAN_PAYMENT_DESTINATION_ID || "342ad057-2edf-4b3f-87cc-6991e8f74c6c";
const PAYOUT_SOURCE_ID       = process.env.LEAN_PAYOUT_SOURCE_ID || "c2bf511f-5946-4c24-8a12-b6cb58c20abc";
// Payouts keeps a SEPARATE destinations table from Payments, even for the same
// bank account. Run GET /api/dev/setup-payout-destination once (see route
// below), then paste the returned destination_id here.
const PAYOUT_DESTINATION_ID  = process.env.LEAN_PAYOUT_DESTINATION_ID || "c1d41f7a-6879-4443-a5b5-ec5448298244"; // TODO: fill in after running /api/dev/setup-payout-destination

// Payouts is a standalone feature for testing purposes — it does NOT draw down
// tradingBalance (which only reflects RE/SIP/AOF deposits). Each user starts
// with a generous fixed payoutBalance so there's always something to test
// withdrawals against; top it back up any time via /api/dev/topup-payout.
const PAYOUT_STARTING_BALANCE = 50000;

// ─── IN-MEMORY STORE (replace with a real DB in production) ─────────────────
// Keyed by a simple "app user ID" we generate (or you'd pass from your auth system)
const store = {
  // "appUserId": {
  //   customerId, tradingBalance, payoutBalance,
  //   -- Connect & Pay fields --
  //   entityId, accountId, paymentSourceId, beneficiaryStatus,
  //   -- Data Only field (its own independent entity) --
  //   dataOnlyEntityId,
  //   -- OF fields --
  //   consentId, consentStatus,
  //   -- shared --
  //   payments: [{ id, amount, currency, rail, initiatedAt, status }]
  // }
};

// ─── LIVE STATUS PUSH (Server-Sent Events) ───────────────────────────────────
// Replaces the old pattern of the frontend calling GET /api/status on a
// repeating 2-second timer to find out "did anything change yet". Instead,
// the browser opens ONE long-lived connection (GET /api/events) and we push
// a fresh snapshot down it the moment a Lean webhook actually changes
// something for that user — see the end of POST /webhooks/lean below.
// Keyed by appUserId; an array because a user could have the app open in
// more than one tab.
const sseClients = {};

// Resolves at READ time which entity dataOnlyEntityId currently points to
// and looks up whatever refresh status has been recorded for THAT entity —
// see the entity.data.refresh.updated handler in POST /webhooks/lean for why
// this can't just be a flat field set once at webhook-arrival time.
function dataOnlyRefreshStatusFor(user) {
  if (!user.dataOnlyEntityId) return null;
  return user.entityRefreshStatusByEntity?.[user.dataOnlyEntityId] || null;
}

// Single source of truth for "what does the frontend need to know about this
// user" — used by both GET /api/status (one-shot, e.g. on page load) and the
// SSE push (whenever a webhook updates something). Keeping this in one place
// means the two can never drift into returning different shapes.
function buildStatusPayload(user) {
  return {
    // Connect & Pay fields
    entityId:          user.entityId,
    paymentSourceId:   user.paymentSourceId,
    beneficiaryStatus: user.beneficiaryStatus,
    // Data Only field — its own independent entity, never the same one as above
    dataOnlyEntityId:      user.dataOnlyEntityId,
    // entity.created only means the entity/consent exists — Lean is still
    // populating the actual account/identity/transaction data behind it.
    // entity.data.refresh.updated (PENDING → FINISHED) is the real signal
    // that GET /data/v2/* will actually return something; see the webhook
    // handler below and pollForDataOnlyEntity() on the frontend.
    dataOnlyRefreshStatus: dataOnlyRefreshStatusFor(user),
    // OF fields
    consentId:         user.consentId,
    consentStatus:     user.consentStatus,
    // shared
    tradingBalance:    user.tradingBalance,
    payoutBalance:     user.payoutBalance ?? PAYOUT_STARTING_BALANCE,
    payouts:           user.payouts || [],
    schedules:         user.schedules || [],
    refunds:           user.refunds || [],
  };
}

function pushStatusUpdate(appUserId) {
  const user = store[appUserId];
  const clients = sseClients[appUserId];
  if (!user || !clients || clients.length === 0) return;
  const line = `data: ${JSON.stringify(buildStatusPayload(user))}\n\n`;
  clients.forEach((res) => {
    try { res.write(line); } catch { /* client likely disconnected — cleaned up on 'close' */ }
  });
}

// ─── LEAN API ACTIVITY BROADCAST ────────────────────────────────────────────
// The frontend's API Activity drawer only ever saw calls the BROWSER made to
// OUR OWN /api/* routes — it had no visibility into what server.js actually
// sends Lean, which is a different, translated payload for several routes
// (e.g. POST /api/schedules takes {kind,...} from the browser but sends Lean
// {type, kind, ...} — see leanFetch below). Every leanFetch call (success AND
// error) gets pushed down the SAME SSE connection the frontend already has
// open for live status, but as a distinctly-named "lean_api" event so it can
// never collide with the default "message" event the status snapshot uses.
// Broadcast to every open tab regardless of appUserId — this is a one-person
// training sandbox, not a multi-tenant app, so there's no reason to withhold
// one session's Lean calls from another tab.
let leanApiLogSeq = 0;
function broadcastLeanApiCall(entry) {
  const payload = { id: ++leanApiLogSeq, at: new Date().toISOString(), ...entry };
  const line = `event: lean_api\ndata: ${JSON.stringify(payload)}\n\n`;
  Object.values(sseClients).flat().forEach((res) => {
    try { res.write(line); } catch { /* client likely disconnected — cleaned up on 'close' */ }
  });
}

// ─── ACCESS TOKEN CACHE (backend, scope=api) ─────────────────────────────────
// Lean's backend APIs require a Bearer access token obtained via OAuth2 client_credentials.
let cachedToken = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.value;
  }

  const res = await fetch(`${AUTH_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     APP_TOKEN,
      client_secret: CLIENT_SECRET,
      grant_type:    "client_credentials",
      scope:         "api",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("[Auth] Failed to get access token:", data);
    throw Object.assign(new Error("Could not authenticate with Lean"), { status: res.status, body: data });
  }

  cachedToken = {
    value:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  console.log(`[Auth] New backend access token acquired, expires in ${data.expires_in}s`);
  return cachedToken.value;
}

/**
 * Mints a CUSTOMER-SCOPED access token — this is what LinkSDK needs as the
 * `access_token` field in Lean.connect() / Lean.pay(). It is NOT the same
 * token used for backend API calls (those use scope=api above).
 * Scope format: "customer.<customer_id>"
 */
async function getCustomerScopedToken(customerId) {
  const res = await fetch(`${AUTH_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     APP_TOKEN,
      client_secret: CLIENT_SECRET,
      grant_type:    "client_credentials",
      scope:         `customer.${customerId}`,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("[Auth] Failed to get customer-scoped token:", data);
    throw Object.assign(new Error("Could not mint customer-scoped token"), { status: res.status, body: data });
  }
  return data.access_token;
}

// ─── HELPER: authenticated fetch to Lean ────────────────────────────────────
// options.silent skips broadcasting a SUCCESSFUL call to the API Activity
// log — for internal fan-outs like reconciliation's one-lookup-per-payment
// loop, where the single user-facing endpoint (e.g. GET /api/reconciliation)
// already shows up as its own entry, and N near-identical per-payment
// sub-calls underneath it are noise, not signal. Failures are still always
// broadcast regardless of silent — a fan-out call failing IS worth seeing.
async function leanFetch(path, options = {}) {
  const { silent, ...fetchOptions } = options;
  const startedAt = Date.now();
  const method = fetchOptions.method || "GET";
  let reqBody = null;
  if (fetchOptions.body) { try { reqBody = JSON.parse(fetchOptions.body); } catch { reqBody = fetchOptions.body; } }

  const token = await getAccessToken();
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(fetchOptions.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const durationMs = Date.now() - startedAt;

  if (!res.ok) {
    // Lean's error response bodies don't always carry a correlation ID
    // (unlike the Dashboard's user-facing "Error ID") — check the common
    // header names so failures are searchable in Elastic without guessing.
    const correlationId =
      res.headers.get("lean-correlation-id") ||
      res.headers.get("x-correlation-id") ||
      res.headers.get("x-request-id") ||
      null;
    console.error(`[Lean API] ${method} ${path} → ${res.status}`, json);
    if (correlationId) console.error(`[Lean API] correlation id: ${correlationId} — search this in Elastic`);
    if (fetchOptions.body) console.error(`[Lean API] Request body was:`, fetchOptions.body);
    broadcastLeanApiCall({ method, url, reqBody, status: res.status, resBody: json, error: null, correlationId, durationMs });
    throw Object.assign(new Error(`Lean API error ${res.status}`), { status: res.status, body: json, correlationId });
  }
  if (!silent) broadcastLeanApiCall({ method, url, reqBody, status: res.status, resBody: json, error: null, correlationId: null, durationMs });
  return json;
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

/**
 * POST /api/init
 * Called when the TradeStart page loads. Creates (or retrieves) a Lean
 * Customer for this user, then mints a short-lived LinkSDK session token.
 *
 * Body: { appUserId }
 * Returns: { customerId, sessionToken, entityId? (if already linked) }
 */
app.post("/api/init", async (req, res) => {
  try {
    const { appUserId } = req.body;
    if (!appUserId) return res.status(400).json({ error: "appUserId required" });

    let user = store[appUserId];

    // 1. Create Customer if this is the first time we've seen this user
    if (!user) {
      let customerId;
      let recoveredFromRestart = false;

      try {
        const customer = await leanFetch("/customers/v1/", {
          method: "POST",
          body: JSON.stringify({ app_user_id: appUserId }),
        });
        customerId = customer.customer_id;
        console.log(`[Init] Created customer ${customerId} for user ${appUserId}`);
      } catch (err) {
        // This happens after a backend restart: our in-memory store is empty,
        // but Lean already has a customer for this app_user_id from before.
        // Recover by fetching the existing customer instead of failing.
        if (err.body?.status === "CUSTOMER_ALREADY_EXISTS") {
          const existing = await leanFetch(`/customers/v1/app-user-id/${appUserId}`);
          customerId = existing.customer_id;
          recoveredFromRestart = true;
          console.log(`[Init] Recovered existing customer ${customerId} for user ${appUserId}`);
        } else {
          throw err;
        }
      }

      // Start with a blank slate
      user = { customerId, entityId: null, dataOnlyEntityId: null, entityRefreshStatusByEntity: {}, accountId: null, tradingBalance: 0, payoutBalance: PAYOUT_STARTING_BALANCE, paymentSourceId: null, beneficiaryStatus: null, consentId: null, consentStatus: null, payments: [], payouts: [], schedules: [], refunds: [] };
      store[appUserId] = user;

      // After a restart recovery, try to restore entityId and paymentSourceId
      // from Lean's API so the app doesn't lose state between server restarts.
      if (recoveredFromRestart) {
        try {
          const entitiesResp = await leanFetch(`/customers/v1/${customerId}/entities`);
          const entities = Array.isArray(entitiesResp) ? entitiesResp : entitiesResp?.payload || [];
          // A customer can now hold up to two entities — one from Connect &
          // Pay's full-permission Lean.connect() call, one from Data Only's
          // restricted call. Classify each by its permission set (see the
          // same check in the entity.created webhook handler below) instead
          // of assuming entities[0] is the one and only entity.
          for (const entity of entities) {
            const p = entity.permissions || {};
            const isFullAccess = p.beneficiaries || p.standing_orders || p.direct_debits || p.scheduled_payments;
            if (isFullAccess) user.entityId = entity.id;
            else user.dataOnlyEntityId = entity.id;
          }
          if (user.entityId) console.log(`[Init] Restored Connect & Pay entity_id ${user.entityId} from Lean API`);
          if (user.dataOnlyEntityId) console.log(`[Init] Restored Data Only entity_id ${user.dataOnlyEntityId} from Lean API`);
        } catch (e) {
          console.warn(`[Init] Could not restore entity_id:`, e.message);
        }

        try {
          const sourcesResp = await leanFetch(`/customers/v1/${customerId}/payment-sources`);
          const sources = Array.isArray(sourcesResp) ? sourcesResp : sourcesResp?.payload || [];
          if (sources.length > 0) {
            const source = sources[0];
            user.paymentSourceId = source.id;
            const beneficiary = source.beneficiaries?.find(
              b => b.payment_destination_id === PAYMENT_DESTINATION_ID
            ) || source.beneficiaries?.[0];
            user.beneficiaryStatus = beneficiary?.status || null;
            console.log(`[Init] Restored payment_source_id ${user.paymentSourceId}, beneficiary status: ${user.beneficiaryStatus}`);
          }
        } catch (e) {
          console.warn(`[Init] Could not restore payment source:`, e.message);
        }

        // Restore OF consent if one exists for this customer
        try {
          const consentsResp = await leanFetch(`/consents/v1?customer_id=${customerId}`);
          const consents = Array.isArray(consentsResp) ? consentsResp : consentsResp?.data || [];
          // Pick the most recently created AUTHORISED consent, or the most recent of any status
          const active = consents.find(c => c.status === "AUTHORISED") || consents[0];
          if (active) {
            user.consentId     = active.consent_id || active.id;
            user.consentStatus = active.status;
            console.log(`[Init] Restored consent_id ${user.consentId}, status: ${user.consentStatus}`);
          }
        } catch (e) {
          console.warn(`[Init] Could not restore OF consent:`, e.message);
        }
      }
    }

    // 2. Mint a CUSTOMER-SCOPED access token for LinkSDK.
    //    This is what Lean.connect() / Lean.pay() expect as `access_token`.
    const customerToken = await getCustomerScopedToken(user.customerId);

    res.json({
      customerId:        user.customerId,
      accessToken:       customerToken,
      entityId:          user.entityId,
      dataOnlyEntityId:  user.dataOnlyEntityId,
      dataOnlyRefreshStatus: dataOnlyRefreshStatusFor(user),
      paymentSourceId:   user.paymentSourceId,
      beneficiaryStatus: user.beneficiaryStatus,
      consentId:         user.consentId,
      consentStatus:     user.consentStatus,
      tradingBalance:    user.tradingBalance,
      payoutBalance:     user.payoutBalance ?? PAYOUT_STARTING_BALANCE,
      payouts:           user.payouts || [],
      schedules:         user.schedules || [],
      refunds:           user.refunds || [],
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/balance?appUserId=xxx
 * Fetches real bank balance from Lean Data API.
 * Requires the user to have already linked their bank (entityId present).
 *
 * Steps:
 *  1. GET /data/v2/accounts  → pick first account → store accountId
 *  2. GET /data/v2/accounts/{accountId}/balances → pick INTERIM_AVAILABLE or first balance
 */
app.get("/api/balance", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user?.entityId) return res.status(400).json({ error: "No linked bank for this user" });

    // Step 1: get account list
    const accountsResp = await leanFetch(
      `/data/v2/accounts?entity_id=${user.entityId}`
    );
    if (accountsResp.status !== "OK") {
      return res.status(502).json({ error: "Could not fetch accounts", detail: accountsResp });
    }

    const accounts = accountsResp.data?.accounts;
    if (!accounts?.length) return res.status(404).json({ error: "No accounts found" });

    const account = accounts[0];
    user.accountId = account.account_id;

    // Store identity fields for display — already available from accounts response
    user.accountHolderName = account.account_holder_name || null;
    const ibanEntry = account.account?.find(a => a.scheme_name === "IBAN");
    user.iban = ibanEntry?.identification || null;

    const bankName = account.nickname || account.account_sub_type || account.account_type || "Your Bank";

    // Step 2: get balances for that account
    const balResp = await leanFetch(
      `/data/v2/accounts/${account.account_id}/balances?entity_id=${user.entityId}`
    );
    if (balResp.status !== "OK") {
      return res.status(502).json({ error: "Could not fetch balances", detail: balResp });
    }

    const balances = balResp.data?.balances || [];
    const preferred = balances.find(b => b.type === "INTERIM_AVAILABLE")
                   || balances.find(b => b.type === "CLOSING_AVAILABLE")
                   || balances[0];

    if (!preferred) return res.status(404).json({ error: "No balance data" });

    res.json({
      bankName,
      amount:            preferred.amount.amount,
      currency:          preferred.amount.currency,
      type:              preferred.type,
      accountHolderName: user.accountHolderName,
      iban:              user.iban,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * POST /api/payment-intent
 * Creates a Payment Intent on Lean's backend, returns the payment_intent_id
 * so the frontend can call Lean.pay(payment_intent_id).
 *
 * Body: { appUserId, amount, currency }
 * Returns: { paymentIntentId }
 */
app.post("/api/payment-intent", async (req, res) => {
  try {
    const { appUserId, amount, currency = "AED", reference } = req.body;
    const user = store[appUserId];
    if (!user?.customerId) return res.status(400).json({ error: "User not initialised" });

    // A Payment Source (beneficiary) must exist and be usable before we can
    // charge it. This is set up via a SEPARATE Lean.connect() call with
    // permissions: ["payments"] — see /api/init response + frontend setupPayments().
    if (!user.paymentSourceId) {
      return res.status(400).json({
        error: "NO_PAYMENT_SOURCE",
        message: "This customer hasn't set up a payment source yet. Run the payments setup step first.",
      });
    }
    if (user.beneficiaryStatus === "AWAITING_BENEFICIARY_COOL_OFF") {
      return res.status(400).json({
        error: "BENEFICIARY_COOLING_OFF",
        message: "The payment source is still in its cool-off period and isn't chargeable yet.",
      });
    }

    const intent = await leanFetch("/payments/v1/intents", {
      method: "POST",
      body: JSON.stringify({
        customer_id: user.customerId,
        amount:      parseFloat(amount),
        currency,
        purpose_code: "PIN",
        payment_destination_id: PAYMENT_DESTINATION_ID,
        // This endpoint's field is `description`, NOT `reference` — unlike
        // AoF payments/schedules below. Whatever the user typed in the
        // Reference box on the RE tab lands here.
        description: reference || `TradeStart dep ${Date.now().toString().slice(-8)}`,
      }),
    });

    // Store payment record keyed by intentId — will be updated with real
    // payment ID when payment.created webhook arrives (that's the ID
    // the Reconciliation API requires)
    if (!user.payments) user.payments = [];
    user.payments.push({
      id:          null,               // set by payment.created webhook
      intentId:    intent.payment_intent_id,
      amount:      parseFloat(amount),
      currency,
      rail:        "CP",
      initiatedAt: new Date().toISOString(),
      status:      "PENDING",
    });

    console.log(`[Payment] Intent created: ${intent.payment_intent_id} for AED ${amount}`);
    res.json({ paymentIntentId: intent.payment_intent_id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * POST /webhooks/lean
 * Lean sends events here. In sandbox you can test with the Lean dashboard's
 * "Send test event" button, or by completing a flow in LinkSDK.
 *
 * Key events we handle:
 *  - entity.created  → store entity_id for this customer
 *  - payment.created → update trading balance
 */
app.post("/webhooks/lean", (req, res) => {
  // In production: verify the webhook signature using your webhook secret.
  // For sandbox we skip this step.
  const event = req.body;
  console.log(`[Webhook] Received: ${event.type}`, JSON.stringify(event, null, 2));

  // Surface every inbound webhook in the SAME API Activity drawer as outbound
  // Lean calls, tagged "webhook" instead of "lean" — this is what actually
  // lets you check, e.g., whether a `reference`/`description` you sent on
  // create comes back on payment.created/payment.updated: the raw payload
  // lands here unmodified, no guessing from docs required.
  broadcastLeanApiCall({
    method: "WEBHOOK", url: event.type, reqBody: null,
    status: 200, resBody: event.payload, error: null,
    correlationId: null, durationMs: null, source: "webhook",
  });

  // Tracks which local user this webhook actually updated, so we can push a
  // fresh SSE snapshot to their browser once at the end — see pushStatusUpdate
  // calls below. Every branch that finds a matching user sets this.
  let touchedAppUserId = null;

  try {
    if (event.type === "entity.created") {
      // NOTE: Lean's payload uses `id` for the entity identifier, not `entity_id`.
      const { customer_id, id: entityId, permissions } = event.payload;
      // Find the user with this customer_id and store their entity_id
      const entry = Object.entries(store).find(
        ([, u]) => u.customerId === customer_id
      );
      if (entry) {
        const [foundAppUserId, user] = entry;
        // A customer can now produce TWO entities that both land here with
        // the same customer_id — Connect & Pay's full-permission
        // Lean.connect() call, and Data Only's restricted one.
        if (Array.isArray(permissions)) {
          // entity.created's own payload already carries the permissions
          // array requested for this entity (confirmed against a real
          // payload) — classify synchronously from it. This used to always
          // go through an extra GET /customers/v1/.../entities/{id} round
          // trip instead, which raced Lean's own entity.data.refresh.updated
          // burst that fires within milliseconds of this event: dataOnlyEntityId
          // could still be unset when FINISHED arrived, or never get set at
          // all if that round trip errored (its catch() defaulted to
          // Connect & Pay). Classifying inline removes both failure modes.
          const isFullAccess = ["beneficiaries", "standing_orders", "direct_debits", "scheduled_payments"].some((p) => permissions.includes(p));
          if (isFullAccess) {
            user.entityId = entityId;
            console.log(`[Webhook] Stored Connect & Pay entity_id ${entityId} for customer ${customer_id}`);
          } else {
            user.dataOnlyEntityId = entityId;
            console.log(`[Webhook] Stored Data Only entity_id ${entityId} for customer ${customer_id}`);
          }
          touchedAppUserId = foundAppUserId;
        } else {
          // Payload didn't carry a permissions array (unexpected shape) —
          // fall back to fetching the entity record directly. Fire-and-forget
          // so the webhook ack below isn't held up by this round trip; a
          // fresh SSE snapshot goes out once classification resolves.
          leanFetch(`/customers/v1/${customer_id}/entities/${entityId}`)
            .then((entity) => {
              const p = entity.permissions || {};
              const isFullAccess = p.beneficiaries || p.standing_orders || p.direct_debits || p.scheduled_payments;
              if (isFullAccess) {
                user.entityId = entityId;
                console.log(`[Webhook] Stored Connect & Pay entity_id ${entityId} for customer ${customer_id}`);
              } else {
                user.dataOnlyEntityId = entityId;
                console.log(`[Webhook] Stored Data Only entity_id ${entityId} for customer ${customer_id}`);
              }
              pushStatusUpdate(foundAppUserId);
            })
            .catch((e) => {
              // Can't classify — default to Connect & Pay's field, since
              // that's the mechanism most of this app's payment demos need.
              user.entityId = entityId;
              console.warn(`[Webhook] Could not classify entity ${entityId}, defaulting to Connect & Pay:`, e.message);
              pushStatusUpdate(foundAppUserId);
            });
        }
      } else {
        console.warn(`[Webhook] No user found for customer_id ${customer_id}`);
      }
    }

    // entity.created only means the entity/consent object exists — Lean
    // says explicitly that clients should NOT poll and should instead wait
    // for this event's `status` to reach FINISHED before calling any
    // /data/v2/* endpoint; it fires PENDING repeatedly while populating the
    // data store, per-data-type, then a final FINISHED once everything the
    // consent covers is actually queryable. Only Data Only's card currently
    // reads bulk data (Connect & Pay never calls /data/v2/*), so this only
    // needs to track dataOnlyEntityId, not the CP entity.
    //
    // Recorded by raw entity_id into entityRefreshStatusByEntity rather than
    // gated on entity_id === user.dataOnlyEntityId at write time — that
    // comparison used to require entity.created's own async classification
    // call (a couple hundred ms, fetching the entity's permissions to tell
    // Data Only apart from Connect & Pay) to have already resolved. In
    // practice Lean fires the entire PENDING...FINISHED burst for a fresh
    // entity within a few seconds of entity.created, so it routinely won
    // that race — FINISHED arrived and got silently dropped because
    // dataOnlyEntityId was still null, and the frontend's wait would time
    // out even though Lean had already sent everything needed. Storing
    // unconditionally and resolving which entity dataOnlyEntityId points to
    // at READ time (dataOnlyRefreshStatusFor() below) removes the race
    // entirely instead of just widening the window.
    if (event.type === "entity.data.refresh.updated") {
      const { customer_id, id: refreshEntityId, entity_id, status } = event.payload || {};
      const targetEntityId = entity_id || refreshEntityId;
      const entry = Object.entries(store).find(([, u]) => u.customerId === customer_id);
      if (entry) {
        const [foundAppUserId, user] = entry;
        if (targetEntityId) {
          if (!user.entityRefreshStatusByEntity) user.entityRefreshStatusByEntity = {};
          user.entityRefreshStatusByEntity[targetEntityId] = status;
          touchedAppUserId = foundAppUserId;
          console.log(`[Webhook] entity.data.refresh.updated for ${foundAppUserId}, entity ${targetEntityId} → ${status}`);
        }
      } else {
        console.warn(`[Webhook] No user found for customer_id ${customer_id} (data refresh event)`);
      }
    }

    if (event.type === "payment_source.created") {
      // Per Lean's docs: safe to acknowledge and ignore this one.
      // The useful data arrives in payment_source.beneficiary.created below.
      console.log(`[Webhook] payment_source.created received (ignored per Lean docs)`);
    }

    if (event.type === "payment_source.beneficiary.created" || event.type === "payment_source.beneficiary.updated") {
      const { customer_id, payment_source_id, status } = event.payload;
      const entry = Object.entries(store).find(
        ([, u]) => u.customerId === customer_id
      );
      if (entry) {
        entry[1].paymentSourceId   = payment_source_id;
        entry[1].beneficiaryStatus = status; // AWAITING_BENEFICIARY_COOL_OFF or ACTIVE
        touchedAppUserId = entry[0];
        console.log(
          `[Webhook] Payment source ${payment_source_id} for customer ${customer_id} → status: ${status}`
        );
      } else {
        console.warn(`[Webhook] No user found for customer_id ${customer_id} (payment source event)`);
      }
    }

    if (event.type === "payment.created") {
      const { id: paymentId, customer_id, intent_id, amount, currency, status } = event.payload;
      const entry = Object.entries(store).find(([, u]) => u.customerId === customer_id);
      if (entry) {
        const user = entry[1];
        touchedAppUserId = entry[0];

        // Payouts fire the SAME event types as deposits (payment.created /
        // payment.updated) — check payouts first so we never mistake a
        // payout creation for an incoming deposit and credit the balance.
        const payoutRecord = (user.payouts || []).find(p => p.intentId === intent_id);

        if (payoutRecord) {
          payoutRecord.id     = payoutRecord.id || paymentId;
          payoutRecord.status = status;
          console.log(`[Payout Webhook] payment.created for payout intent ${intent_id} → status ${status}`);
        } else {
          // Update the stored payment record with the real payment ID
          // (we stored it by intentId — now we can set the actual ID for reconciliation)
          if (!user.payments) user.payments = [];
          const pending = user.payments.find(p => p.intentId === intent_id && p.id === null);
          if (pending) {
            pending.id     = paymentId;
            pending.status = status;
            console.log(`[Payment] Updated record: intent ${intent_id} → payment ${paymentId}`);
          } else {
            // OF payment or one we don't have a record for yet — add it.
            // Scheduled Payments (new, pilot) executes automatically on its
            // due date, so this webhook is the ONLY place we learn about
            // it — there's no prior /api/... call from us to match against.
            // As of 2026-07-08 Lean's public webhook docs don't document a
            // schedule_id / scheduled_payment_id field on this payload at
            // all, so we can't confirm the real field name — this is a real
            // gap worth raising in the pilot feedback doc. Captured
            // opportunistically below under a couple of plausible names;
            // if neither is present, the payment still gets recorded
            // correctly as a normal OF deposit (existing behavior), just
            // without the "came from a schedule" tag.
            const scheduleRef = event.payload.schedule_id || event.payload.scheduled_payment_id || null;
            const existing = user.payments.find(p => p.id === paymentId);
            if (!existing) {
              user.payments.push({
                id:          paymentId,
                intentId:    intent_id || null,
                amount:      parseFloat(amount),
                currency:    currency || "AED",
                rail:        event.payload.consent_id ? "OF" : "CP",
                scheduleRef, // null unless Lean's payload happens to include it — unconfirmed field name
                initiatedAt: event.timestamp || new Date().toISOString(),
                status,
              });
              if (scheduleRef) console.log(`[Schedules] payment.created appears schedule-linked (${scheduleRef}) — field name unconfirmed, flag in pilot feedback`);
            }
          }

          // Update trading balance (deposits only — payouts are handled above)
          if (status === "ACCEPTED_BY_BANK" || status === "PENDING_WITH_BANK") {
            user.tradingBalance = (user.tradingBalance || 0) + parseFloat(amount);
            console.log(`[Webhook] Trading balance updated for ${entry[0]}: +${amount} ${currency} → ${user.tradingBalance}`);
          }
        }
      }
    }

    // ── OF Webhooks ────────────────────────────────────────────────────────
    if (event.type === "consent.authorised" || event.type === "consent.status.updated") {
      const { id: consent_id, customer_id, status } = event.payload;
      const entry = Object.entries(store).find(
        ([, u]) => u.customerId === customer_id || u.consentId === consent_id
      );
      if (entry) {
        entry[1].consentId     = consent_id;
        entry[1].consentStatus = status;
        touchedAppUserId = entry[0];
        console.log(`[Webhook] Consent ${consent_id} for customer ${customer_id} → status: ${status}`);
      } else {
        console.warn(`[Webhook] No user found for consent ${consent_id} / customer ${customer_id}`);
      }
    }

    // OF payment result — supplement the direct API response in /api/of/pay
    if (event.type === "payment.account-on-file.updated" || event.type === "payment.account_on_file.updated") {
      const { customer_id, amount, status } = event.payload;
      if (status === "PROCESSED") {
        const entry = Object.entries(store).find(([, u]) => u.customerId === customer_id);
        if (entry) {
          entry[1].tradingBalance = (entry[1].tradingBalance || 0) + parseFloat(amount?.amount || amount);
          touchedAppUserId = entry[0];
          console.log(`[Webhook] OF payment PROCESSED for ${entry[0]}, trading balance: ${entry[1].tradingBalance}`);
        }
      }
    }

    // SIP: payment.updated fires for status changes after payment.created.
    // Payouts ALSO fire payment.updated when authorized/accepted/rejected —
    // check payouts first (see payment.created above for why).
    if (event.type === "payment.updated") {
      const { id: paymentId, customer_id, intent_id, status, amount, currency } = event.payload;
      const entry = Object.entries(store).find(([, u]) => u.customerId === customer_id);
      if (entry) {
        const user = entry[1];
        touchedAppUserId = entry[0];
        const payoutRecord = (user.payouts || []).find(p => p.intentId === intent_id || p.id === paymentId);

        if (payoutRecord) {
          payoutRecord.status = status;
          payoutRecord.id     = payoutRecord.id || paymentId;
          if (status === "ACCEPTED_BY_BANK" && !payoutRecord._balanceDeducted) {
            payoutRecord._balanceDeducted = true;
            // Deducts from the standalone payoutBalance — tradingBalance
            // (RE/SIP/AOF deposits) is never touched by Payouts.
            if (user.payoutBalance === undefined) user.payoutBalance = PAYOUT_STARTING_BALANCE;
            user.payoutBalance = user.payoutBalance - parseFloat(amount ?? payoutRecord.amount);
            console.log(`[Payout Webhook] ACCEPTED_BY_BANK — deducted AED ${payoutRecord.amount} for ${entry[0]}, payoutBalance: ${user.payoutBalance}`);
          } else if (status === "FAILED") {
            console.log(`[Payout Webhook] Payout ${payoutRecord.id} FAILED for ${entry[0]} — balance left untouched`);
          } else {
            console.log(`[Payout Webhook] Payout ${payoutRecord.id} → status ${status}`);
          }
        } else {
          if (!user.payments) user.payments = [];
          // Update stored record
          const record = user.payments.find(p => p.intentId === intent_id || p.id === paymentId);
          if (record) {
            record.id     = paymentId;
            record.status = status;
          }
          // Credit trading balance on final accepted status
          if (status === "ACCEPTED_BY_BANK" || status === "PENDING_WITH_BANK") {
            const alreadyCredited = user.payments.filter(
              p => (p.id === paymentId) && p._balanceCredited
            ).length > 0;
            if (!alreadyCredited && record) {
              record._balanceCredited = true;
              user.tradingBalance = (user.tradingBalance || 0) + parseFloat(amount);
              console.log(`[Webhook] SIP payment.updated ${status} for ${entry[0]}: +${amount} → ${user.tradingBalance}`);
            }
          }
        }
      }
    }

    // ── Refunds webhook (event name unconfirmed) ─────────────────────────
    // Lean's public webhook docs don't currently document a dedicated event
    // for refund status changes (checked via the Lean documentation MCP on
    // 2026-07-31 — the Refunds spec covers POST/PUT/GET /payouts/refunds
    // only, no webhook section). This is a defensive catch-all in case one
    // fires under a name like refund.created / refund.updated /
    // refund.status.updated, so it gets logged and reflected locally instead
    // of silently ignored. Flag the real event name in the pilot feedback
    // doc once one is actually observed.
    if (event.type && event.type.startsWith("refund")) {
      const { id, refund_id, customer_id, status } = event.payload || {};
      const refundId = refund_id || id;
      const entry = Object.entries(store).find(
        ([, u]) => (u.refunds || []).some((r) => r.refundId === refundId) || u.customerId === customer_id
      );
      if (entry) {
        const [localAppUserId, user] = entry;
        touchedAppUserId = localAppUserId;
        const local = (user.refunds || []).find((r) => r.refundId === refundId);
        if (local && status) {
          local.status = status;
          if (status === "ACCEPTED_BY_BANK" && !local._balanceDeducted) {
            local._balanceDeducted = true;
            user.tradingBalance = (user.tradingBalance || 0) - parseFloat(local.amount);
          }
        }
        console.log(`[Webhook] Refund event ${event.type} for ${refundId} → ${status} (event name unconfirmed)`);
      } else {
        console.warn(`[Webhook] Refund event ${event.type} received but no matching local refund/customer found`, event.payload);
      }
    }
  } catch (err) {
    console.error("[Webhook] Error processing event:", err);
  }

  // Push the change straight to the browser over SSE instead of making it
  // wait for its next poll — this is what lets the frontend drop the old
  // "GET /api/status every 2 seconds" pattern entirely.
  if (touchedAppUserId) pushStatusUpdate(touchedAppUserId);

  // Always acknowledge receipt immediately (Lean retries on non-2xx)
  res.status(200).json({ received: true });
});

/**
 * POST /api/sip/payment-intent
 *
 * Creates a Payment Intent for OF-SIP (Single Instant Payment via Open Finance).
 * Unlike RE payments, SIP uses Lean.checkout() — no prior bank link or consent needed.
 * The user selects their bank and authorises the payment in real time.
 *
 * Body: { appUserId, amount, currency }
 * Returns: { paymentIntentId, accessToken }
 */
app.post("/api/sip/payment-intent", async (req, res) => {
  try {
    const { appUserId, amount, currency = "AED", reference } = req.body;
    const user = store[appUserId];
    if (!user?.customerId) return res.status(400).json({ error: "User not initialised" });

    const intent = await leanFetch("/payments/v1/intents", {
      method: "POST",
      body: JSON.stringify({
        customer_id:            user.customerId,
        amount:                 parseFloat(amount),
        currency,
        purpose_code:           "FIS",   // Financial Institution Services — correct for OF-SIP
        payment_destination_id: PAYMENT_DESTINATION_ID,
        // Same endpoint as RE above — field is `description`, not `reference`.
        description:            reference || `MKT SIP ${Date.now().toString().slice(-8)}`,
      }),
    });

    // Store pending payment record — will be updated with real payment_id from webhook
    if (!user.payments) user.payments = [];
    user.payments.push({
      id:          null,
      intentId:    intent.payment_intent_id,
      amount:      parseFloat(amount),
      currency,
      rail:        "SIP",
      initiatedAt: new Date().toISOString(),
      status:      "PENDING",
    });

    // Mint a fresh customer-scoped token for Lean.checkout()
    const accessToken = await getCustomerScopedToken(user.customerId);
    console.log(`[SIP] Intent created: ${intent.payment_intent_id} for AED ${amount}`);
    res.json({ paymentIntentId: intent.payment_intent_id, accessToken });
  } catch (err) {
    console.error("[SIP] Error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// OPEN FINANCE ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/of/create-consent
 * OF Step 1 (backend): Create an Account-on-File consent.
 * Returns the consent_id so the frontend can call Lean.authorizeConsent().
 *
 * An AoF consent defines:
 *  - Which destination account can receive payments
 *  - The purpose code (UAE CBUAE requirement)
 *  - Control parameters: max amounts, period limits, validity window
 *
 * Body: { appUserId }
 * Returns: { consentId, accessToken }
 */
app.post("/api/of/create-consent", async (req, res) => {
  try {
    const { appUserId } = req.body;
    const user = store[appUserId];
    if (!user?.customerId) return res.status(400).json({ error: "User not initialised" });

    // If already have an AUTHORISED consent, return it — no need to create again
    if (user.consentId && user.consentStatus === "AUTHORISED") {
      const accessToken = await getCustomerScopedToken(user.customerId);
      console.log(`[OF] Returning existing AUTHORISED consent ${user.consentId}`);
      return res.json({ consentId: user.consentId, accessToken });
    }

    // Create a fresh Account-on-File consent
    const consent = await leanFetch("/consents/v1/account-on-file", {
      method: "POST",
      body: JSON.stringify({
        customer_id:            user.customerId,
        destination_account_id: PAYMENT_DESTINATION_ID,
        currency:               "AED",
        reference:              `TradeStart-${appUserId.slice(-8)}`,
        purpose:                "PIN",
        control_parameters: {
          type:                 "VariableOnDemand",
          period_type:          "Month",
          max_individual_amount: 50000,
          max_cumulative_amount_per_period: 500000,
        },
        // Required by UAE Open Finance regulations — must identify the debtor.
        // In production: collect real Emirates ID from the user during onboarding.
        // In sandbox: any valid-format Emirates ID works.
        government_identifier: {
          type:  "EMIRATES_ID",
          value: "784-1990-1234567-1",
        },
      }),
    });

    user.consentId     = consent.id;
    user.consentStatus = consent.status; // AWAITING_AUTHORISATION
    console.log(`[OF] Created consent ${consent.id} for customer ${user.customerId}, status: ${consent.status}`);

    // Mint a fresh customer-scoped token for Lean.authorizeConsent()
    const accessToken = await getCustomerScopedToken(user.customerId);
    res.json({ consentId: consent.id, accessToken });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/of/balance?appUserId=xxx
 * OF balance fetch — much simpler than RE.
 * Uses GET /consents/v1/{consent_id}/balance directly.
 * Requires the consent to be AUTHORISED.
 */
app.get("/api/of/balance", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user?.consentId) return res.status(400).json({ error: "No OF consent for this user" });
    if (user.consentStatus !== "AUTHORISED") {
      return res.status(400).json({ error: "Consent is not yet AUTHORISED", status: user.consentStatus });
    }

    const balResp = await leanFetch(`/consents/v1/${user.consentId}/balance`);
    res.json({
      bankName: "Open Finance Bank",
      amount:   balResp.balance,
      currency: balResp.currency,
      type:     "OPEN_FINANCE",
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * POST /api/of/pay
 * OF payment — no Lean.pay() SDK call needed.
 * Backend calls POST /payments/v1/account-on-file directly.
 * The consent already has the user's pre-authorisation, so no extra
 * bank redirect is required for each individual payment.
 *
 * Body: { appUserId, amount }
 * Returns: { paymentId, status }
 */
app.post("/api/of/pay", async (req, res) => {
  try {
    const { appUserId, amount, reference } = req.body;
    const user = store[appUserId];
    if (!user?.consentId) return res.status(400).json({ error: "No OF consent for this user" });
    if (user.consentStatus !== "AUTHORISED") {
      return res.status(400).json({ error: "Consent not AUTHORISED", status: user.consentStatus });
    }

    const payment = await leanFetch("/payments/v1/account-on-file", {
      method: "POST",
      headers: {
        // OF payments require an Idempotency-Key to prevent double-charges
        "Idempotency-Key": `tradestart-${appUserId}-${Date.now()}`,
      },
      body: JSON.stringify({
        consent_id: user.consentId,
        amount:     parseFloat(amount),
        purpose:    "PIN",
        // This endpoint's field genuinely is `reference` (unlike RE/SIP
        // intents above, which use `description`) — already confirmed
        // working since this line existed before the user-editable box did.
        reference:  reference || `TradeStart dep ${Date.now().toString().slice(-8)}`,
        risk_details: {
          transaction_indicators: {
            channel: "WEB",
          },
        },
      }),
    });

    console.log(`[OF Payment] Created: ${payment.id}, status: ${payment.status}, amount: AED ${amount}`);

    // Store payment record for reconciliation lookups
    if (!user.payments) user.payments = [];
    user.payments.push({
      id:          payment.id,
      amount:      parseFloat(amount),
      currency:    "AED",
      rail:        "OF",
      initiatedAt: new Date().toISOString(),
      status:      payment.status,
    });

    // If immediately PROCESSED, update trading balance right now
    if (payment.status === "PROCESSED") {
      user.tradingBalance = (user.tradingBalance || 0) + parseFloat(amount);
      console.log(`[OF Payment] Immediately PROCESSED — trading balance: ${user.tradingBalance}`);
    }

    res.json({ paymentId: payment.id, status: payment.status });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/of/consent?appUserId=xxx
 *
 * Retrieves the full consent record via Lean's GET /consents/v1/{consent_id} —
 * this is a different, richer read than what /api/init caches locally
 * (consentId/consentStatus only). Used to power the AoF tab's Consent
 * Management section: start/expiration dates, the consented account,
 * control_parameters (limits), and payment_consumption (how much of the
 * consent's limits have actually been used so far).
 */
app.get("/api/of/consent", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user?.consentId) return res.status(400).json({ error: "No OF consent for this user" });

    const consent = await leanFetch(`/consents/v1/${user.consentId}`);
    res.json(consent);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * POST /api/of/consent/revoke
 *
 * Revokes the user's AoF consent via Lean's POST
 * /consents/v1/{consent_id}/revocation. Requires the consent to currently be
 * AUTHORISED (Lean returns 400 otherwise). This is a genuine, permanent
 * action — once revoked, deposits/schedules against this consent stop
 * working, same as if the end user had revoked it from a real consent
 * management screen. `reason` defaults to END_USER_REQUESTED since that's
 * the only reason that reflects what's actually happening here (a user
 * clicking Revoke in the app), not a dev/ops action.
 *
 * Body: { appUserId, reason?, additionalContext? }
 */
app.post("/api/of/consent/revoke", async (req, res) => {
  try {
    const { appUserId, reason = "END_USER_REQUESTED", additionalContext } = req.body;
    const user = store[appUserId];
    if (!user?.consentId) return res.status(400).json({ error: "No OF consent for this user" });
    if (user.consentStatus !== "AUTHORISED") {
      return res.status(400).json({ error: "Consent is not AUTHORISED — nothing to revoke.", status: user.consentStatus });
    }

    await leanFetch(`/consents/v1/${user.consentId}/revocation`, {
      method: "POST",
      body: JSON.stringify({ reason, additional_context: additionalContext || undefined }),
    });

    user.consentStatus = "REVOKED";
    console.log(`[Consent] Revoked ${user.consentId} for ${appUserId} (reason: ${reason})`);
    pushStatusUpdate(appUserId);

    res.json({ consentId: user.consentId, status: "REVOKED" });
  } catch (err) {
    console.error("[Consent] Revoke error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULED PAYMENTS ROUTES (Pay by Bank — Schedules API, Alpha pilot)
//
// A schedule (RECURRING or EXPLICIT) is registered against the user's
// existing AUTHORISED AoF consent — see /api/of/create-consent above. No
// new consent type is needed; this is a thin layer on top of AoF.
//
// docs: https://docs.leantech.me/reference/createschedule
//       https://docs.leantech.me/docs/getting-start-with-scheduled-payments
// ═══════════════════════════════════════════════════════════════════════════

function findLocalSchedule(user, scheduleId) {
  return (user.schedules || []).find(s => s.scheduleId === scheduleId);
}

/**
 * POST /api/schedules
 *
 * Registers a new schedule against the user's AUTHORISED AoF consent.
 *
 * Body (RECURRING): { appUserId, kind: "RECURRING", unit, amount, startDate, endDate?, reference? }
 *   unit is one of DAY | WEEK | MONTH | YEAR
 * Body (EXPLICIT):  { appUserId, kind: "EXPLICIT", executions: [{ executeOn, amount, reference? }, ...], reference? }
 *
 * Returns Lean's raw response: { schedule_id, consent_id, status, links }
 */
app.post("/api/schedules", async (req, res) => {
  try {
    const { appUserId, kind, unit, amount, startDate, endDate, executions, reference } = req.body;
    const user = store[appUserId];
    if (!user?.consentId) {
      return res.status(400).json({ error: "No AoF consent for this user — link via the AoF tab first." });
    }
    if (user.consentStatus !== "AUTHORISED") {
      return res.status(400).json({ error: "Consent not AUTHORISED — cannot register a schedule against it.", status: user.consentStatus });
    }

    let schedule;
    if (kind === "EXPLICIT") {
      if (!Array.isArray(executions) || executions.length === 0) {
        return res.status(400).json({ error: "At least one execution ({ executeOn, amount }) is required for an explicit schedule." });
      }
      schedule = {
        // The published OpenAPI spec says the discriminator field is `kind`
        // (discriminator.propertyName: "kind") — confirmed WRONG against the
        // live Alpha sandbox on 2026-07-08. Every request with only `kind`
        // failed with `INVALID_PARAMETERS, field: schedule`, even payloads
        // copied verbatim from Lean's own docs. Isolated via direct sandbox
        // calls: the deployed service actually keys off `type`. Sending both
        // so this keeps working if/when Lean fixes the service to match its
        // own spec. Flag this exact mismatch in the pilot feedback doc.
        type: "EXPLICIT",
        kind: "EXPLICIT",
        executions: executions.map(e => ({
          execute_on: e.executeOn,
          amount:     { value: parseFloat(e.amount), currency: "AED" },
          ...(e.reference ? { reference: e.reference } : {}),
        })),
      };
    } else if (kind === "RECURRING") {
      if (!unit || !amount || !startDate) {
        return res.status(400).json({ error: "unit, amount and startDate are required for a recurring schedule." });
      }
      schedule = {
        // See EXPLICIT branch above — `type` is the field the live service
        // actually reads for the discriminator, not `kind` as documented.
        type:       "RECURRING",
        kind:       "RECURRING",
        recurrence: { unit }, // DAY | WEEK | MONTH | YEAR
        amount:     { value: parseFloat(amount), currency: "AED" },
        start_date: startDate,
        ...(endDate ? { end_date: endDate } : {}),
      };
    } else {
      return res.status(400).json({ error: 'kind must be "RECURRING" or "EXPLICIT"' });
    }

    const body = {
      consent_id: user.consentId,
      schedule,
      ...(reference ? { reference } : {}),
    };

    const result = await leanFetch("/schedules/v1", {
      method: "POST",
      headers: {
        // Required per the OpenAPI spec — must be unique per operation.
        "Idempotency-Key": `tradestart-sched-${appUserId}-${Date.now()}`,
      },
      body: JSON.stringify(body),
    });

    if (!user.schedules) user.schedules = [];
    user.schedules.push({
      scheduleId: result.schedule_id,
      kind,
      status:     result.status,
      links:      result.links || {},
      createdAt:  new Date().toISOString(),
    });

    console.log(`[Schedules] Registered ${kind} schedule ${result.schedule_id} for ${appUserId}, status ${result.status}`);
    res.status(201).json(result);
  } catch (err) {
    console.error("[Schedules] Create error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/schedules?appUserId=xxx
 *
 * Uses Lean's own List Schedules endpoint (GET /schedules/v1?consentId=),
 * scoped to this user's AoF consent, as the source of truth — rather than
 * looping GETs over our locally-cached schedule IDs. Note: per the OpenAPI
 * spec, list/get responses do NOT include the `links` hypermedia object —
 * that's only present on the POST /schedules/v1 create response — so the
 * frontend derives which actions (pause/resume/cancel) are valid from
 * `status` directly instead of relying on links after creation.
 */
app.get("/api/schedules", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user) return res.status(400).json({ error: "User not initialised" });
    if (!user.consentId) return res.json({ schedules: [] });

    const live = await leanFetch(`/schedules/v1?consentId=${user.consentId}&size=100`);
    const summaries = live.content || [];

    // Keep our local cache's status in sync too (used by scheduleAction() below)
    summaries.forEach(s => {
      const local = findLocalSchedule(user, s.schedule_id);
      if (local) local.status = s.status;
    });

    res.json({
      schedules: summaries.map(s => ({
        scheduleId: s.schedule_id,
        // Same spec/implementation mismatch as the create request (see
        // POST /api/schedules comments): the OpenAPI spec says this field
        // is `kind`, but on the live sandbox it actually comes back as
        // `type`. Read both defensively rather than trusting the spec name.
        kind:       s.kind || s.type,
        status:     s.status,
        createdAt:  s.created_at,
        detail:     s,
      })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/** GET /api/schedules/:scheduleId/upcoming — proxies GET /schedules/v1/{id}/upcoming-payments */
app.get("/api/schedules/:scheduleId/upcoming", async (req, res) => {
  try {
    const result = await leanFetch(`/schedules/v1/${req.params.scheduleId}/upcoming-payments`);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/** GET /api/schedules/:scheduleId/payments — proxies GET /schedules/v1/{id}/payments (materialized history) */
app.get("/api/schedules/:scheduleId/payments", async (req, res) => {
  try {
    const result = await leanFetch(`/schedules/v1/${req.params.scheduleId}/payments`);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/** GET /api/schedules/:scheduleId/payments/:paymentId — proxies GET /schedules/v1/{id}/payments/{scheduled_payment_id} */
app.get("/api/schedules/:scheduleId/payments/:paymentId", async (req, res) => {
  try {
    const result = await leanFetch(`/schedules/v1/${req.params.scheduleId}/payments/${req.params.paymentId}`);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * Shared handler for the three lifecycle actions — pause / resume / cancel.
 * All three are simple POSTs against /schedules/v1/{id}/{action} with no
 * body. The OpenAPI spec doesn't state whether an Idempotency-Key is
 * required here (only createSchedule documents it) — omitted for now;
 * worth confirming for the pilot feedback doc if Lean returns a 400 asking
 * for one.
 */
function scheduleAction(action) {
  return async (req, res) => {
    try {
      const { scheduleId } = req.params;
      const { appUserId } = req.body || {};
      const result = await leanFetch(`/schedules/v1/${scheduleId}/${action}`, { method: "POST" });

      const user = appUserId && store[appUserId];
      const local = user && findLocalSchedule(user, scheduleId);
      if (local) {
        local.status = result.status;
        local.links  = result.links || local.links;
      }

      console.log(`[Schedules] ${action} → ${scheduleId} now ${result.status}`);
      res.json(result);
    } catch (err) {
      console.error(`[Schedules] ${action} error:`, err.body || err.message);
      res.status(err.status || 500).json({ error: err.message, detail: err.body });
    }
  };
}

app.post("/api/schedules/:scheduleId/pause",  scheduleAction("pause"));
app.post("/api/schedules/:scheduleId/resume", scheduleAction("resume"));
app.post("/api/schedules/:scheduleId/cancel", scheduleAction("cancel"));

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT LINKS ROUTES
// docs: https://docs.leantech.me/docs/create-payment-link
// API:  https://docs.leantech.me/reference/createpaymentlink
//
// A hosted-checkout product — you create a link describing a fixed payment
// (amount, currency, reference), Lean gives back a shareable URL, and
// whoever opens it pays without you writing any checkout UI. Distinct from
// everything else in this app: it's the only rail here where the END USER
// never touches LinkSDK inside TradeStart itself — they leave to Lean's own
// hosted page, authorize with their bank there, and get redirected back.
//
// Confirmed from the live OpenAPI schema (not guessed):
//  - payment_details.{reference, currency, amount} are REQUIRED;
//    destination_id and payment_purpose are optional (omit destination_id
//    to use the app's default destination, same one PAYMENT_DESTINATION_ID
//    points at for RE/SIP/AOF deposits in this app).
//  - top-level name/max_usages/expires_at/redirect_url/customer_id/
//    identifiers are all optional.
//  - redirect_url MUST already be registered in the Lean Dashboard's
//    application settings — an unregistered one causes a create-time error.
//  - Lean's List endpoint (GET /payment-links/v1) has no per-customer
//    filter, same situation as the unfiltered GET /schedules/v1 elsewhere
//    in this file — it returns every link for the whole app, not just one
//    user's. Fine for this single-operator sandbox.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/payment-links
 *
 * Body: {
 *   appUserId, amount, reference, currency?, paymentPurpose?,
 *   name?, maxUsages?, expiresAt?, redirectUrl?, identifiers?: [{type, displayLabel?, required?, limit?}]
 * }
 * Returns Lean's raw response: { id, link, status, current_usages, ... }
 */
app.post("/api/payment-links", async (req, res) => {
  try {
    const {
      appUserId, amount, reference, currency = "AED", paymentPurpose,
      name, maxUsages, expiresAt, redirectUrl, identifiers,
    } = req.body;

    if (!amount || !reference) {
      return res.status(400).json({ error: "amount and reference are required." });
    }

    const body = {
      payment_details: {
        reference,
        currency,
        amount: parseFloat(amount),
        ...(paymentPurpose ? { payment_purpose: paymentPurpose } : {}),
        // destination_id intentionally omitted — Lean falls back to this
        // app's default destination (same account RE/SIP/AOF deposits use).
      },
      ...(name        ? { name } : {}),
      ...(maxUsages   ? { max_usages: parseInt(maxUsages, 10) } : {}),
      ...(expiresAt   ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
      ...(Array.isArray(identifiers) && identifiers.length ? {
        identifiers: identifiers.map(i => ({
          type: i.type,
          ...(i.displayLabel ? { display_label: i.displayLabel } : {}),
          ...(typeof i.required === "boolean" ? { required: i.required } : {}),
          ...(i.limit ? { limit: parseInt(i.limit, 10) } : {}),
        })),
      } : {}),
    };

    const result = await leanFetch("/payment-links/v1", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const user = appUserId && store[appUserId];
    if (user) {
      if (!user.paymentLinks) user.paymentLinks = [];
      user.paymentLinks.unshift({ id: result.id, createdAt: new Date().toISOString() });
    }

    console.log(`[Payment Links] Created ${result.id} — ${result.link}`);
    res.status(201).json(result);
  } catch (err) {
    console.error("[Payment Links] Create error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/payment-links
 *
 * Lists every payment link for this app (no per-customer filter exists on
 * Lean's side — see note above). Query: ?size=100 default.
 */
app.get("/api/payment-links", async (req, res) => {
  try {
    const result = await leanFetch(`/payment-links/v1?size=100`);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/** GET /api/payment-links/:linkId/usages — proxies GET /payment-links/v1/{id}/usages */
app.get("/api/payment-links/:linkId/usages", async (req, res) => {
  try {
    const result = await leanFetch(`/payment-links/v1/${req.params.linkId}/usages?size=100`);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * PUT /api/payment-links/:linkId
 *
 * Only supported change: status ACTIVE <-> DISABLED. Lean rejects this once
 * a link has reached EXPIRED or USED (terminal states) — surfaced as a
 * normal error response, not handled specially here.
 * Body: { status: "ACTIVE" | "DISABLED" }
 */
app.put("/api/payment-links/:linkId", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["ACTIVE", "DISABLED"].includes(status)) {
      return res.status(400).json({ error: 'status must be "ACTIVE" or "DISABLED"' });
    }
    const result = await leanFetch(`/payment-links/v1/${req.params.linkId}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    console.log(`[Payment Links] ${req.params.linkId} → ${status}`);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DATA ROUTES — IDENTITY
// (Transactions route removed — the Mockbank's canned transaction history
// was confusing to test with, unrelated to any deposit made through this
// app, and provided no real testing value. See project memory for context.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/identity?appUserId=xxx
 *
 * Returns verified identity information for the linked account.
 * account_holder_name and IBAN are already stored from the balance call —
 * this route just exposes them cleanly.
 */
app.get("/api/identity", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user?.entityId) return res.status(400).json({ error: "No linked bank for this user" });

    // Already stored during balance fetch — no extra API call needed
    if (user.accountHolderName) {
      return res.json({
        accountHolderName: user.accountHolderName,
        iban:              user.iban,
        source:            "cached",
      });
    }

    // Fallback: re-fetch accounts if not cached yet
    const accountsResp = await leanFetch(`/data/v2/accounts?entity_id=${user.entityId}`);
    if (accountsResp.status !== "OK") {
      return res.status(502).json({ error: "Could not fetch identity", detail: accountsResp });
    }

    const account = accountsResp.data?.accounts?.[0];
    if (!account) return res.status(404).json({ error: "No account found" });

    user.accountHolderName = account.account_holder_name || null;
    const ibanEntry = account.account?.find(a => a.scheme_name === "IBAN");
    user.iban = ibanEntry?.identification || null;

    res.json({
      accountHolderName: user.accountHolderName,
      iban:              user.iban,
      source:            "live",
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DATA ONLY — separate Lean.connect() entity, no payment permission at all.
// See dataOnlyEntityId on the user record, and the entity.created webhook
// handler above for how it's told apart from the Connect & Pay entity.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/dataonly/accounts?appUserId=xxx
 *
 * Proof-of-data-access display for the Data Only card: identity + every
 * account this entity can see (each with its live balance) + the 10 most
 * recent transactions across all of them.
 *
 * NOTE: the comment above /api/identity says this app dropped Mockbank
 * transaction history entirely because it was confusing to test with and
 * unrelated to deposits made through this app — that decision was about
 * THIS app's own deposit-tracking screens. The Data Only card's whole
 * purpose is demonstrating breadth of data access, so transactions are
 * deliberately brought back here, scoped to this one card only.
 */
app.get("/api/dataonly/accounts", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user?.dataOnlyEntityId) return res.status(400).json({ error: "No Data Only bank linked for this user" });

    const accountsResp = await leanFetch(`/data/v2/accounts?entity_id=${user.dataOnlyEntityId}`);
    if (accountsResp.status !== "OK") {
      return res.status(502).json({ error: "Could not fetch accounts", detail: accountsResp });
    }

    const accounts = accountsResp.data?.accounts || [];
    if (!accounts.length) return res.status(404).json({ error: "No accounts found" });

    let identity = null;
    try {
      const identityResp = await leanFetch(`/data/v2/identity?entity_id=${user.dataOnlyEntityId}`, { silent: true });
      const idy = identityResp.data?.identities?.[0];
      if (idy) identity = { name: idy.full_legal_name || idy.name, email: idy.email_address || null, phone: idy.mobile_number || idy.phone || null };
    } catch (e) {
      console.warn(`[Data Only] Could not fetch identity:`, e.message);
    }

    let allTransactions = [];
    const enriched = await Promise.all(accounts.map(async (account) => {
      const ibanEntry = account.account?.find(a => a.scheme_name === "IBAN");
      let amount = null, currency = null;
      try {
        const balResp = await leanFetch(
          `/data/v2/accounts/${account.account_id}/balances?entity_id=${user.dataOnlyEntityId}`,
          { silent: true },
        );
        const balances = balResp.data?.balances || [];
        const preferred = balances.find(b => b.type === "INTERIM_AVAILABLE")
                       || balances.find(b => b.type === "CLOSING_AVAILABLE")
                       || balances[0];
        if (preferred) { amount = preferred.amount.amount; currency = preferred.amount.currency; }
      } catch (e) {
        console.warn(`[Data Only] Could not fetch balance for account ${account.account_id}:`, e.message);
      }
      try {
        const txResp = await leanFetch(
          `/data/v2/accounts/${account.account_id}/transactions?entity_id=${user.dataOnlyEntityId}&size=10`,
          { silent: true },
        );
        const txs = txResp.data?.transactions || [];
        allTransactions.push(...txs.map(t => ({
          description: t.transaction_information || t.merchant_details?.merchant_name || "Transaction",
          amount:      t.amount?.amount,
          currency:    t.amount?.currency,
          direction:   t.credit_debit_indicator,
          date:        t.booking_date_time,
          bankName:    account.nickname || account.account_sub_type || account.account_type || "Account",
        })));
      } catch (e) {
        console.warn(`[Data Only] Could not fetch transactions for account ${account.account_id}:`, e.message);
      }
      return {
        accountId:         account.account_id,
        bankName:          account.nickname || account.account_sub_type || account.account_type || "Account",
        accountHolderName: account.account_holder_name || null,
        iban:              ibanEntry?.identification || null,
        amount,
        currency,
      };
    }));

    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    allTransactions = allTransactions.slice(0, 10);

    res.json({ identity, accounts: enriched, transactions: allTransactions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INSIGHTS ROUTES
//
// Derived analytics on top of the SAME entity Data Only already connects —
// no new Lean.connect() permission, no separate consent (Lean's own spec
// requires only the accounts+transactions scope Data Only already requests).
// Every read below is a single synchronous backend call, same shape as AVS
// below — no SDK, no webhook, no polling.
// ═══════════════════════════════════════════════════════════════════════════

function requireDataOnlyEntity(req, res) {
  const user = store[req.query.appUserId];
  if (!user?.dataOnlyEntityId) {
    res.status(400).json({ error: "No Data Only bank linked for this user" });
    return null;
  }
  return user;
}

// Lean's Insights endpoints wrap their payload as { status, results_id,
// message, insights: {...} } — a different envelope key than the rest of
// this app's { status, data } convention (e.g. /api/dataonly/accounts above).
// name-verification is the one exception and uses { status, data }. Unwrap
// whichever key is present so the frontend renderers see the real payload.
function unwrapLean(resp) {
  if (resp && typeof resp === "object") {
    if ("insights" in resp) return resp.insights;
    if ("data" in resp) return resp.data;
  }
  return resp;
}

app.get("/api/insights/account-controls", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    res.json(unwrapLean(await leanFetch(`/insights/v3/account-controls?entity_id=${user.dataOnlyEntityId}`)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

app.get("/api/insights/cashflow-patterns", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    res.json(unwrapLean(await leanFetch(`/insights/v3/cashflow-patterns?entity_id=${user.dataOnlyEntityId}`)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

app.get("/api/insights/credit-assessments", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    res.json(unwrapLean(await leanFetch(`/insights/v3/credit-assessments?entity_id=${user.dataOnlyEntityId}`)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

app.get("/api/insights/credit-obligations", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    res.json(unwrapLean(await leanFetch(`/insights/v3/credit-obligations?entity_id=${user.dataOnlyEntityId}`)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

app.get("/api/insights/expenses", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    res.json(unwrapLean(await leanFetch(`/insights/v2/expenses?entity_id=${user.dataOnlyEntityId}`)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

app.get("/api/insights/spending", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    res.json(unwrapLean(await leanFetch(`/insights/v3/spending?entity_id=${user.dataOnlyEntityId}`)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// Lean's income endpoint is a POST (body-scoped entity_id + optional
// filters) even though every other Insights read here is a GET — kept as a
// GET on our own side so the frontend can treat it like the rest of this page.
app.get("/api/insights/income", async (req, res) => {
  const user = requireDataOnlyEntity(req, res);
  if (!user) return;
  try {
    const result = await leanFetch("/insights/v2/income", {
      method: "POST",
      body: JSON.stringify({ entity_id: user.dataOnlyEntityId }),
    });
    res.json(unwrapLean(result));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// The one Insights call that takes real input — checks whether a given name
// matches the name Lean holds for the account. appUserId is in the body
// (not query) for this one since it's a POST, same convention as elsewhere
// in this file (e.g. /api/refunds).
app.post("/api/insights/name-verification", async (req, res) => {
  const { appUserId, fullName } = req.body;
  const user = store[appUserId];
  if (!user?.dataOnlyEntityId) return res.status(400).json({ error: "No Data Only bank linked for this user" });
  if (!fullName) return res.status(400).json({ error: "fullName is required" });
  try {
    const result = await leanFetch("/insights/v1/name-verification", {
      method: "POST",
      body: JSON.stringify({ entity_id: user.dataOnlyEntityId, full_name: fullName }),
    });
    res.json(unwrapLean(result));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AVS ROUTES (Account Verification Solution)
//
// Unlike every other feature in this app, AVS has NOTHING to do with the
// LinkSDK, entities, or consents — it's a plain, stateless backend-to-backend
// REST call. You send an IBAN + an identifier, Lean's own systems check it
// against the bank, and you get an answer back in the same response. No
// webhook, no redirect, no polling required.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/avs/verify
 *
 * Calls Lean's International AVS endpoint (POST /verifications/v1/accounts)
 * for a UAE account. Two ways to match, and they behave differently:
 *   - identificationType "EMIRATES_ID" -> deterministic yes/no
 *     (account_ownership_verified true/false, no fuzzy score)
 *   - identificationType "FULL_NAME"   -> fuzzy name match
 *     (CONFIRMATION_OF_PAYEE_SERVICE; can come back with
 *      matching: { type: "PARTIAL"|"NO_MATCH", score } instead of a clean match)
 *
 * Body: { appUserId, iban, accountType, identificationType, identificationValue }
 * accountType defaults to "PERSONAL" (use "BUSINESS" for a corporate account +
 * TRADE_LICENCE/COMMERCIAL_REGISTRATION as the identificationType).
 */
app.post("/api/avs/verify", async (req, res) => {
  try {
    const { appUserId, iban, accountType, identificationType, identificationValue } = req.body;
    if (!iban || !identificationType || !identificationValue) {
      return res.status(400).json({ error: "iban, identificationType and identificationValue are required" });
    }

    const result = await leanFetch("/verifications/v1/accounts", {
      method: "POST",
      body: JSON.stringify({
        country_code: "AE",
        type: accountType || "PERSONAL",
        account_details: { type: "IBAN", value: iban },
        identifications: [{ type: identificationType, value: identificationValue }],
      }),
    });

    // Lean's spec exposes no GET to list or look up past checks by
    // results_id — this endpoint is fire-and-forget on their side. So this
    // local history (capped at 20) is the only record the app has of what
    // was checked and when; it's not synced with anything server-side.
    const user = appUserId && store[appUserId];
    if (user) {
      if (!user.avsChecks) user.avsChecks = [];
      user.avsChecks.unshift({
        iban,
        identificationType,
        identificationValue,
        result,
        checkedAt: new Date().toISOString(),
      });
      user.avsChecks = user.avsChecks.slice(0, 20);
    }

    res.json(result);
  } catch (err) {
    console.error("[AVS] Error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/avs/history?appUserId=xxx
 * Returns this session's local AVS check history (see note above).
 */
app.get("/api/avs/history", (req, res) => {
  const user = store[req.query.appUserId];
  res.json({ checks: (user && user.avsChecks) || [] });
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYOUTS ROUTE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/payout
 *
 * Sends money FROM the platform (PAYOUT_SOURCE_ID) TO the user's bank account.
 * This is a withdrawal — money flows out of MK Trading back to the user.
 *
 * Payouts is a standalone testing feature, deliberately NOT wired to
 * tradingBalance (which only reflects RE/SIP/AOF deposits). It draws against
 * its own payoutBalance, seeded with PAYOUT_STARTING_BALANCE, so you always
 * have something to withdraw regardless of what you've deposited. Top it up
 * any time via GET /api/dev/topup-payout.
 *
 * Payout Source: c2bf511f-5946-4c24-8a12-b6cb58c20abc (configured in Lean dashboard)
 * Payment Destination: separate Payouts-only destination (see PAYOUT_DESTINATION_ID)
 *
 * Body: { appUserId, amount }
 */
app.post("/api/payout", async (req, res) => {
  try {
    const { appUserId, amount, reference } = req.body;
    const user = store[appUserId];
    if (!user?.customerId) return res.status(400).json({ error: "User not initialised" });

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ error: "Invalid payout amount" });
    }
    if (user.payoutBalance === undefined) user.payoutBalance = PAYOUT_STARTING_BALANCE;
    // Payouts is intentionally decoupled from tradingBalance (which only
    // tracks RE/SIP/AOF deposits) — it has its own standalone test balance.
    if (parsedAmount > user.payoutBalance) {
      return res.status(400).json({ error: `Insufficient payout balance (AED ${user.payoutBalance}). Top it up via /api/dev/topup-payout.` });
    }
    if (!PAYOUT_DESTINATION_ID) {
      return res.status(400).json({
        error: "PAYOUT_DESTINATION_ID_NOT_SET",
        message: "Run GET /api/dev/setup-payout-destination once, then hardcode the returned destination_id as PAYOUT_DESTINATION_ID in server.js. Payouts destinations are separate from the PAYMENT_DESTINATION_ID used for deposits.",
      });
    }

    const payout = await leanFetch("/payouts/v1/payment", {
      method: "POST",
      headers: {
        "idempotency-key": `mktrading-payout-${appUserId}-${Date.now()}`,
      },
      body: JSON.stringify({
        payment_details: [{
          account_id: PAYOUT_SOURCE_ID,   // Platform's payout source account
          destination_details: [{
            payment_destination_id: PAYOUT_DESTINATION_ID, // Payouts-specific destination — NOT PAYMENT_DESTINATION_ID
            amount:                 parsedAmount,
            // ≤ 32 chars — Lean rejects longer values, so truncate rather
            // than let the frontend's maxlength be the only guard.
            description:            (reference || `MKT withdrawal`).slice(0, 32),
            authorize_payment:      false,
          }],
        }],
      }),
    });

    // Log the RAW response before touching it. Lean's docs show this shape as
    // flat ({ payouts_payment_details: [...] }), but several other endpoints
    // in this file (entities, payment-sources, consents) turned out to wrap
    // their array under .payload or .data instead of matching the docs — so
    // don't trust the shape until you've actually seen one real response.
    console.log(`[Payout] RAW response for ${appUserId}:`, JSON.stringify(payout, null, 2));

    // Defensive unwrap in case this endpoint also wraps the body (see above).
    const payoutBody = payout?.payload ?? payout?.data ?? payout;
    const detail      = payoutBody?.payouts_payment_details?.[0];
    // Confirmed 2026-07-07: Lean's actual sandbox response returns
    // destination_details as a single OBJECT here, not an array like the
    // OpenAPI spec claims. Handle both shapes so we never silently drop the
    // real status again.
    const destDetail  = Array.isArray(detail?.destination_details)
      ? detail.destination_details[0]
      : detail?.destination_details;

    if (!detail) {
      console.warn(`[Payout] WARNING: could not find payouts_payment_details in the response for ${appUserId}. ` +
        `The raw response above did not match the expected shape — check it before trusting anything downstream.`);
    }
    if (destDetail?.payment_status === "FAILED") {
      console.error(`[Payout] FAILED for ${appUserId}: ${destDetail.error_message || "no error_message returned"}`);
    }

    // authorize_payment: false → Lean parks this in AWAITING_AUTHORIZATION.
    // It has NOT reached the bank yet, so we do NOT touch payoutBalance here.
    // The balance is only debited once the /webhooks/lean handler sees this
    // payment reach ACCEPTED_BY_BANK (see payment.created / payment.updated).
    // If we couldn't parse the response at all, report UNKNOWN rather than
    // guessing — a confident-looking fallback status would hide a real bug.
    const status = destDetail?.payment_status || (detail ? "AWAITING_AUTHORIZATION" : "UNKNOWN");

    if (!user.payouts) user.payouts = [];
    user.payouts.push({
      intentId:        detail?.payment_intent_id || null,
      id:              detail?.payment_id || null,
      amount:          parsedAmount,
      currency:        "AED",
      status,
      errorMessage:    destDetail?.error_message || null,
      initiatedAt:     new Date().toISOString(),
      _balanceDeducted: false,
    });

    console.log(`[Payout] Created for ${appUserId}: AED ${parsedAmount}, status: ${status}, intentId: ${detail?.payment_intent_id || "MISSING"}` +
      (status === "FAILED" ? ` — FAILED: ${destDetail?.error_message}` : " — balance NOT yet deducted, awaiting authorization"));

    // Push immediately so the new payout appears in the list right away —
    // don't make the browser wait for the first webhook just to learn its
    // own just-created payout exists.
    pushStatusUpdate(appUserId);

    res.json({
      paymentIntentId: detail?.payment_intent_id,
      paymentId:       detail?.payment_id,
      status,
      errorMessage:    destDetail?.error_message || null,
      payoutBalance:   user.payoutBalance, // unchanged — still pending
    });
  } catch (err) {
    console.error("[Payout] Error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/dev/setup-payout-destination
 *
 * DEV-ONLY, run once. Payouts keeps its own destinations table, completely
 * separate from the Payments destinations table that PAYMENT_DESTINATION_ID
 * lives in — even for the exact same bank account. Reusing a Payments
 * destination ID in a payout fails with "destination with id = ... not found".
 *
 * This route: (1) looks up the existing, already-CONFIRMED Payments
 * destination to reuse its bank details, then (2) registers a matching
 * destination in the Payouts product. Take the returned destination_id and
 * hardcode it as PAYOUT_DESTINATION_ID above.
 */
app.get("/api/dev/setup-payout-destination", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Disabled in production" });
  }
  try {
    const existingResp = await leanFetch(`/payments/v1/destinations/${PAYMENT_DESTINATION_ID}`);
    console.log("[Dev] Existing Payments destination (raw):", JSON.stringify(existingResp, null, 2));
    const existing = existingResp?.payload ?? existingResp?.data ?? existingResp;

    if (!existing?.iban) {
      return res.status(502).json({
        error: "Could not read IBAN from the existing payment destination — check the raw log above and adjust the unwrap logic if Lean's shape differs.",
        raw: existingResp,
      });
    }

    // Required fields per Lean's Payouts destination spec: name, iban,
    // address, country, city, currency_iso_code. Sandbox mock destinations
    // usually don't carry a real postal address, so we fill sensible UAE
    // defaults for the fields Lean doesn't give us back.
    const createResp = await leanFetch("/payouts/v1/payment/destinations", {
      method: "POST",
      body: JSON.stringify([{
        name:              existing.name || existing.display_name || "MK LAB RECON",
        display_name:      existing.display_name || existing.name || "MK LAB RECON",
        iban:              existing.iban,
        account_number:    existing.account_number,
        bank_identifier:   existing.bank_identifier,
        address:           "Dubai, UAE",
        city:              "Dubai",
        country:           "ARE",
        currency_iso_code: "AED",
      }]),
    });
    console.log("[Dev] Create payout destination response (raw):", JSON.stringify(createResp, null, 2));

    // Response example in the spec is an array even though the schema says
    // object — same doc/reality mismatch as the payout endpoint. Handle both.
    const createdBody = createResp?.payload ?? createResp?.data ?? createResp;
    const created = Array.isArray(createdBody) ? createdBody[0] : createdBody;

    res.json({
      existingPaymentDestination: existing,
      createdPayoutDestination:   created,
      nextStep: created?.destination_id
        ? `Hardcode this as PAYOUT_DESTINATION_ID in server.js: "${created.destination_id}"`
        : "destination_id missing from response — check the raw logs printed to the terminal.",
    });
  } catch (err) {
    console.error("[Dev] setup-payout-destination error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/dev/topup-payout?appUserId=xxx&amount=50000
 *
 * DEV-ONLY. Payouts has its own standalone payoutBalance (see PAYOUT ROUTE
 * comment above) so you can keep testing withdrawals without needing to
 * re-deposit via RE/SIP/AOF first. Tops it back up to `amount` (defaults to
 * PAYOUT_STARTING_BALANCE) — purely local, no Lean API call involved.
 */
app.get("/api/dev/topup-payout", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Disabled in production" });
  }
  const { appUserId, amount } = req.query;
  const user = store[appUserId];
  if (!user) return res.status(404).json({ error: "User not found" });

  user.payoutBalance = amount ? parseFloat(amount) : PAYOUT_STARTING_BALANCE;
  console.log(`[Dev] Topped up payoutBalance for ${appUserId} → AED ${user.payoutBalance}`);
  res.json({ payoutBalance: user.payoutBalance });
});

// Applies a freshly-observed status to a local payout record, deducting the
// standalone payoutBalance exactly once the first time it reaches
// ACCEPTED_BY_BANK — shared between the refresh route below (and could be
// reused by the webhook handler above, though that already has its own
// inline copy of this same logic and wasn't touched here to avoid risking
// the currently-working webhook path while fixing an unrelated bug).
function applyPayoutStatus(user, payoutRecord, newStatus) {
  if (!newStatus || newStatus === payoutRecord.status) return;
  payoutRecord.status = newStatus;
  if (newStatus === "ACCEPTED_BY_BANK" && !payoutRecord._balanceDeducted) {
    payoutRecord._balanceDeducted = true;
    if (user.payoutBalance === undefined) user.payoutBalance = PAYOUT_STARTING_BALANCE;
    user.payoutBalance = user.payoutBalance - parseFloat(payoutRecord.amount);
  }
}

/**
 * GET /api/payouts/refresh?appUserId=xxx
 *
 * Manual pull of each non-terminal payout's live status, straight from
 * Lean — the same idea as the Recon tab's Refresh button. The webhook path
 * (see /webhooks/lean above → pushStatusUpdate) already updates this
 * automatically when Lean sends payment.updated for an authorization, but
 * MK asked for an explicit on-demand check too, as a safety net.
 *
 * IMPORTANT gotcha found 2026-07-12: `payment_id` is genuinely `null` per
 * Lean's own OpenAPI spec (POST /payouts/v1/payment response schema marks
 * it `["string","null"]`) until the payout moves past its initial CREATED
 * state — which is exactly the state a payout sits in right after creation,
 * before anyone's authorized it in the Dashboard. The original version of
 * this route only ever checked payouts that already had a payment_id, so it
 * silently skipped every payout still sitting at CREATED — which looked
 * like "Refresh does nothing" even though nothing was actually broken.
 * Fixed by falling back to GET /payouts/v1/payments (the list endpoint,
 * confirmed via its schema to return `payment_intent_id` on every item —
 * which we DO have from creation, even when payment_id is still null) and
 * matching on that instead. Once a payout is found there, its real
 * payment_id gets backfilled locally so future refreshes can use the
 * richer /payments/{id}/history endpoint directly.
 */
app.get("/api/payouts/refresh", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user) return res.status(400).json({ error: "User not initialised" });

    const pending = (user.payouts || []).filter(
      (p) => p.status !== "ACCEPTED_BY_BANK" && p.status !== "FAILED"
    );

    if (pending.length) {
      // Only fetched once per refresh call, reused for every payout that
      // still needs the payment_intent_id fallback lookup.
      let listItems = null;

      for (const p of pending) {
        try {
          if (p.id) {
            // We have a real payment_id — use the richer history endpoint.
            const history = await leanFetch(`/payouts/v1/payments/${p.id}/history`);
            const live = history?.payments?.[0];
            if (live?.status && live.status !== p.status) {
              console.log(`[Payout Refresh] ${p.id}: ${p.status} → ${live.status}`);
              applyPayoutStatus(user, p, live.status);
            }
            continue;
          }

          // No payment_id yet — this is expected while still CREATED, not
          // an error. Look it up in the list endpoint by payment_intent_id.
          if (listItems === null) {
            const list = await leanFetch("/payouts/v1/payments?page_size=100");
            listItems = list?.content || [];
          }
          const match = listItems.find((i) => i.payment_intent_id === p.intentId);
          if (match) {
            if (match.payment_id && !p.id) {
              p.id = match.payment_id;
              console.log(`[Payout Refresh] Backfilled payment_id ${p.id} for intent ${p.intentId}`);
            }
            if (match.status && match.status !== p.status) {
              console.log(`[Payout Refresh] ${p.intentId}: ${p.status} → ${match.status} (via list)`);
              applyPayoutStatus(user, p, match.status);
            }
          }
        } catch (err) {
          // Don't let one bad lookup kill the whole refresh — log and move on.
          console.warn(`[Payout Refresh] Could not refresh ${p.id || p.intentId}:`, err.body || err.message);
        }
      }
    }

    pushStatusUpdate(appUserId); // keep any other open tab/session in sync too
    res.json(buildStatusPayload(user));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REFUNDS ROUTES
// docs: https://docs.leantech.me/reference/createrefund (Refunds sits under
// the Payouts product — path prefix /payouts/refunds — even though what it
// refunds here is a RE/SIP/AoF deposit, not a payout).
//
// A refund reverses money that already reached the platform's destination
// account, sending it back to the ORIGINAL payer's bank account — Lean looks
// the payer up from payment_id, you never supply an IBAN yourself. It's a
// maker-checker flow: POST only queues the refund as CREATED; nothing moves
// until a separate PUT call approves or rejects it. The refund amount can't
// exceed the original payment's amount (enforced by Lean; checked locally
// here too for a clearer error message).
//
// Scoped to RE/SIP/OF deposits (user.payments) only — not Payouts
// withdrawals, since refunding a withdrawal would reverse money in the
// OPPOSITE direction (back into the platform's own payout source), which
// this demo doesn't model.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payments?appUserId=xxx
 *
 * Local, un-enriched list of this user's RE/SIP/OF deposits — no Lean API
 * call involved. Powers the Refunds tab's "which payment do you want to
 * refund" picker. For Lean-verified status per payment, use
 * GET /api/reconciliation instead (that one calls Lean per payment, which is
 * unnecessary overhead just to populate a dropdown).
 */
app.get("/api/payments", (req, res) => {
  const user = store[req.query.appUserId];
  res.json({ payments: (user && user.payments) || [] });
});

/**
 * GET /api/refunds/reasons
 * Proxies GET /payouts/refunds/reasons — the fixed list of reason_code values
 * Lean accepts on create (CUSTOMER_REQUEST, DUPLICATED_PAYMENT, etc.).
 */
app.get("/api/refunds/reasons", async (req, res) => {
  try {
    const result = await leanFetch("/payouts/refunds/reasons");
    const reasons = Array.isArray(result) ? result : result?.payload || result?.data || [];
    res.json({ reasons });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * POST /api/refunds
 *
 * Body: { appUserId, paymentId, amount, currency?, reasonCode, description?, externalReference? }
 * Creates the refund as CREATED — it will NOT move any money until a checker
 * approves it via PUT /api/refunds/:refundId below. Lean's create endpoint
 * takes (and returns) an ARRAY even for a single refund — sent/unwrapped
 * here to keep the frontend dealing with one plain object.
 */
app.post("/api/refunds", async (req, res) => {
  try {
    const { appUserId, paymentId, amount, currency = "AED", reasonCode, description, externalReference } = req.body;
    const user = store[appUserId];
    if (!user) return res.status(400).json({ error: "User not initialised" });
    if (!paymentId || !reasonCode || !amount) {
      return res.status(400).json({ error: "paymentId, reasonCode and amount are required" });
    }

    const parsedAmount = parseFloat(amount);
    const original = (user.payments || []).find((p) => p.id === paymentId);
    if (original && parsedAmount > original.amount) {
      return res.status(400).json({ error: `Refund amount cannot exceed the original payment (AED ${original.amount}).` });
    }

    const result = await leanFetch("/payouts/refunds", {
      method: "POST",
      body: JSON.stringify([{
        payment_id:  paymentId,
        amount:      parsedAmount,
        currency,
        reason_code: reasonCode,
        ...(description ? { description } : {}),
        ...(externalReference ? { external_reference: externalReference } : {}),
      }]),
    });

    const refund = Array.isArray(result) ? result[0] : result?.payload?.[0] ?? result?.data?.[0] ?? result;
    if (!refund?.refund_id) {
      console.warn(`[Refunds] Unexpected create response shape for ${appUserId}:`, JSON.stringify(result, null, 2));
      return res.status(502).json({ error: "Refund created but the response shape was unexpected — check the server terminal log.", raw: result });
    }

    if (!user.refunds) user.refunds = [];
    user.refunds.unshift({
      refundId:          refund.refund_id,
      paymentId:         refund.payment_id || paymentId,
      amount:            refund.amount ?? parsedAmount,
      currency:          refund.currency || currency,
      reasonCode:        refund.reason_code || reasonCode,
      description:       refund.description || description || null,
      externalReference: refund.external_reference || externalReference || null,
      beneficiary:       refund.beneficiary || null,
      status:            refund.status || "CREATED",
      createdAt:         new Date().toISOString(),
      _balanceDeducted:  false,
    });

    console.log(`[Refunds] Created ${refund.refund_id} for payment ${paymentId}, AED ${parsedAmount} (${reasonCode}) — awaiting approval`);
    pushStatusUpdate(appUserId);
    res.status(201).json(refund);
  } catch (err) {
    console.error("[Refunds] Create error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * PUT /api/refunds/:refundId
 *
 * The checker step. Body: { appUserId, status: "APPROVED" | "REJECTED" }.
 * Approving does not mean funds have moved yet — Lean still has to actually
 * send the refund to the bank. That later transition (PENDING_WITH_BANK /
 * ACCEPTED_BY_BANK / FAILED) is only visible via GET /api/refunds/refresh
 * below, since there's no confirmed webhook event for it (see the webhook
 * handler comment in /webhooks/lean).
 */
app.put("/api/refunds/:refundId", async (req, res) => {
  try {
    const { refundId } = req.params;
    const { appUserId, status } = req.body;
    if (!["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({ error: 'status must be "APPROVED" or "REJECTED"' });
    }
    const user = store[appUserId];
    if (!user) return res.status(400).json({ error: "User not initialised" });

    const result = await leanFetch("/payouts/refunds", {
      method: "PUT",
      body: JSON.stringify([{ refund_id: refundId, status }]),
    });

    // Same array-vs-object doc/reality gap seen elsewhere in this file (see
    // the Payouts destination_details note above) — handle both defensively.
    const updated = Array.isArray(result) ? result[0] : result?.payload?.[0] ?? result?.data?.[0] ?? result;

    const local = (user.refunds || []).find((r) => r.refundId === refundId);
    if (local) local.status = updated?.status || status;

    console.log(`[Refunds] ${refundId} → ${updated?.status || status}`);
    pushStatusUpdate(appUserId);
    res.json({ refundId, status: updated?.status || status });
  } catch (err) {
    console.error("[Refunds] Process error:", err.body || err.message);
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/refunds/refresh?appUserId=xxx
 *
 * Lean's List Refunds endpoint has no per-refund_id or per-customer filter
 * (same limitation as Schedules/Payment Links elsewhere in this file), so
 * this pulls the most recent page and matches by refund_id to pick up any
 * status Lean has moved on its own after approval (APPROVED ->
 * PENDING_WITH_BANK -> ACCEPTED_BY_BANK, or FAILED). Deducts tradingBalance
 * exactly once, the first time a refund is observed at ACCEPTED_BY_BANK —
 * mirrors applyPayoutStatus() above.
 */
app.get("/api/refunds/refresh", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user) return res.status(400).json({ error: "User not initialised" });

    const pending = (user.refunds || []).filter((r) => !["REJECTED", "FAILED", "ACCEPTED_BY_BANK"].includes(r.status));
    if (pending.length) {
      const list = await leanFetch("/payouts/refunds?size=100");
      const items = list?.content || list?.payload?.content || [];
      pending.forEach((r) => {
        const match = items.find((i) => i.refund_id === r.refundId);
        if (match?.status && match.status !== r.status) {
          console.log(`[Refunds Refresh] ${r.refundId}: ${r.status} → ${match.status}`);
          r.status = match.status;
          if (match.status === "ACCEPTED_BY_BANK" && !r._balanceDeducted) {
            r._balanceDeducted = true;
            user.tradingBalance = (user.tradingBalance || 0) - parseFloat(r.amount);
          }
        }
      });
    }

    pushStatusUpdate(appUserId);
    res.json(buildStatusPayload(user));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILIATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/reconciliation?appUserId=xxx
 *
 * Returns all payments for this user, each enriched with reconciliation
 * status from Lean's Reconciliation API.
 *
 * Reconciliation statuses:
 *   RECONCILED   — payment matched to a real bank deposit. Money arrived.
 *   OUTSTANDING  — payment initiated, no matching deposit yet. Still waiting.
 *   UNRECEIVED   — payment never matched. Investigate.
 *
 * We look up each stored payment individually via
 *   GET /reconciliation/v1/payments/{payment_id}
 * This gives real-time status for each one.
 */
app.get("/api/reconciliation", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user) return res.status(404).json({ error: "User not found" });

    const payments = user.payments || [];
    if (payments.length === 0) return res.json({ payments: [] });

    // Fetch reconciliation status for each payment in parallel
    const enriched = await Promise.all(
      payments.map(async (p) => {
        try {
          const recon = await leanFetch(`/reconciliation/v1/payments/${p.id}`, { silent: true });
          return {
            ...p,
            reconciliationStatus: recon.reconciliation?.status || "UNKNOWN",
            deposit: recon.reconciliation?.deposit || null,
            reconAmount: recon.reconciliation?.amount || null,
          };
        } catch (err) {
          // Payment may be too recent for reconciliation — return PENDING
          console.warn(`[Recon] Could not fetch reconciliation for ${p.id}:`, err.message);
          return {
            ...p,
            reconciliationStatus: "PENDING",
            deposit: null,
            reconAmount: null,
          };
        }
      })
    );

    // Sort newest first
    enriched.sort((a, b) => new Date(b.initiatedAt) - new Date(a.initiatedAt));
    res.json({ payments: enriched });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/reconciliation/deposits?appUserId=xxx&start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns raw deposits received in your FAB destination account,
 * optionally filtered by date range and reconciliation status.
 * Useful for seeing what money actually arrived vs what was initiated.
 */
app.get("/api/reconciliation/deposits", async (req, res) => {
  try {
    const { appUserId, start, end, status } = req.query;
    const user = store[appUserId];
    if (!user) return res.status(404).json({ error: "User not found" });

    let url = `/reconciliation/v1/deposits/?local_timezone=Asia/Dubai`;
    if (start) url += `&start_date=${start}`;
    if (end)   url += `&end_date=${end}`;
    if (status) url += `&reconciliation_status=${status}`;

    const data = await leanFetch(url);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/status?appUserId=xxx
 * Lightweight endpoint the frontend polls after linking a bank or making a
 * payment, to pick up state that arrives asynchronously via webhook
 * (entity_id, payment source/beneficiary status, trading balance).
 */
app.get("/api/status", (req, res) => {
  const user = store[req.query.appUserId];
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(buildStatusPayload(user));
});

/**
 * GET /api/events?appUserId=xxx
 *
 * Server-Sent Events stream — one long-lived connection per session instead
 * of the frontend repeatedly calling GET /api/status on a timer. Sends an
 * immediate snapshot on connect, then a fresh one every time a Lean webhook
 * changes something relevant for this user (see pushStatusUpdate() above,
 * called from the end of POST /webhooks/lean).
 */
app.get("/api/events", (req, res) => {
  const { appUserId } = req.query;
  if (!appUserId) return res.status(400).end();

  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control":  "no-cache",
    Connection:       "keep-alive",
  });
  res.flushHeaders?.();

  if (!sseClients[appUserId]) sseClients[appUserId] = [];
  sseClients[appUserId].push(res);
  console.log(`[SSE] ${appUserId} connected (${sseClients[appUserId].length} open)`);

  const user = store[appUserId];
  if (user) res.write(`data: ${JSON.stringify(buildStatusPayload(user))}\n\n`);

  // Some proxies/load balancers silently drop an idle connection — a
  // periodic comment line keeps this one alive without meaning anything.
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* handled by 'close' below */ }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients[appUserId] = (sseClients[appUserId] || []).filter((r) => r !== res);
    console.log(`[SSE] ${appUserId} disconnected (${sseClients[appUserId].length} left)`);
  });
});

/**
 * DELETE /api/dev/reset?appUserId=xxx
 *
 * Backs the frontend's "User Reset" button (userReset() in index.html —
 * renamed from the earlier devReset()/"Dev Reset" label; this route's path
 * was left as-is). Cleanup tool: deletes the user's bank entity on Lean's
 * side (so the same Mockbank test user can be relinked) and clears them
 * from the in-memory store, so you can run the full Link flow again from
 * scratch without manually curling Lean's API every time.
 *
 * Deliberately enabled in production too (unlike the other /api/dev/*
 * routes below, which stay guarded) — this is a demo app on a single
 * shared deployment, not a real production service with real user data,
 * and testers need to be able to reset their own session there directly.
 */
app.delete("/api/dev/reset", async (req, res) => {
  try {
    const { appUserId } = req.query;
    const user = store[appUserId];
    if (!user) return res.status(404).json({ error: "No local record for this appUserId" });

    let entityDeleted = false;
    if (user.entityId) {
      try {
        await leanFetch(`/customers/v1/${user.customerId}/entities/${user.entityId}`, {
          method: "DELETE",
          body: JSON.stringify({ reason: "USER_REQUESTED" }),
        });
        entityDeleted = true;
        console.log(`[User Reset] Deleted Connect & Pay entity ${user.entityId} for customer ${user.customerId}`);
      } catch (err) {
        console.warn(`[User Reset] Could not delete entity on Lean's side:`, err.body || err.message);
      }
    }
    if (user.dataOnlyEntityId) {
      try {
        await leanFetch(`/customers/v1/${user.customerId}/entities/${user.dataOnlyEntityId}`, {
          method: "DELETE",
          body: JSON.stringify({ reason: "USER_REQUESTED" }),
        });
        entityDeleted = true;
        console.log(`[User Reset] Deleted Data Only entity ${user.dataOnlyEntityId} for customer ${user.customerId}`);
      } catch (err) {
        console.warn(`[User Reset] Could not delete Data Only entity on Lean's side:`, err.body || err.message);
      }
    }

    // Revoke OF consent if one exists
    let consentRevoked = false;
    if (user.consentId && user.consentStatus === "AUTHORISED") {
      try {
        await leanFetch(`/consents/v1/${user.consentId}/revocation`, {
          method: "POST",
          body: JSON.stringify({ reason: "USER_REQUESTED" }),
        });
        consentRevoked = true;
        console.log(`[User Reset] Revoked consent ${user.consentId}`);
      } catch (err) {
        console.warn(`[User Reset] Could not revoke consent:`, err.body || err.message);
      }
    }

    delete store[appUserId];
    console.log(`[User Reset] Cleared local record for ${appUserId}`);
    res.json({ cleared: true, entityDeleted, consentRevoked, appUserId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

/**
 * GET /api/dev/users
 * DEV-ONLY: list all users currently tracked in the in-memory store,
 * useful for finding the appUserId to pass to /api/dev/reset (the "User
 * Reset" button's endpoint).
 */
app.get("/api/dev/users", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Disabled in production" });
  }
  res.json(store);
});

/**
 * GET /api/dev/schedules
 *
 * DEV-ONLY diagnostic. The regular GET /api/schedules is (correctly) scoped
 * to the CURRENT session's consentId — that's the right behavior for a real
 * customer, who should never see another consent's schedules, even an old
 * revoked one of their own.
 *
 * But /api/dev/reset (the "User Reset" button) only revokes the consent and
 * forgets the local session — it does NOT delete existing schedules from
 * Lean. So after a reset, a
 * schedule you registered under the old consent is still alive and ACTIVE
 * on Lean's side, just orphaned from any local session that knows its
 * consentId. This route calls GET /schedules/v1 with NO consentId filter
 * (confirmed via Lean's own OpenAPI spec that consentId is optional here,
 * not required) so you can see every schedule ever created under this app,
 * regardless of which reset wiped the session that created it.
 */
app.get("/api/dev/schedules", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Disabled in production" });
  }
  try {
    const live = await leanFetch(`/schedules/v1?size=100`);
    const summaries = live.content || [];
    res.json({
      schedules: summaries.map(s => ({
        scheduleId: s.schedule_id,
        consentId:  s.consent_id,
        kind:       s.kind || s.type,
        status:     s.status,
        createdAt:  s.created_at,
        detail:     s,
      })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TradeStart backend running on http://localhost:${PORT}`);
  console.log(`   Webhook endpoint: POST http://localhost:${PORT}/webhooks/lean`);
  console.log(`   Use ngrok or similar to expose this to the internet for webhooks.\n`);
});
