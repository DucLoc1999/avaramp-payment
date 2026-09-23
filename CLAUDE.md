# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

- **Runtime**: Node.js, TypeScript (ES2022, CommonJS output)
- **Web**: Fastify 4
- **DB**: PostgreSQL via Knex 3 (`pg` driver)
- **Payments**: `sepay-pg-node` (SePay sandbox/prod PG integration)
- **Queue**: kafkajs (Kafka)
- **Blockchain**: `viem` (Avalanche C-Chain EVM)
- **Signing**: `@google-cloud/kms` — C-Chain payout tx signing via GCP Cloud KMS secp256k1 (ADC auth).

## Docker

Production image uses multi-stage build (builder → production). Migration runs in-process on startup via `onReady` hook — no `tsx` required in prod. Entrypoint only handles log dir permissions before handing off to `node dist/server.js`.

## Commands

```bash
npm run dev              # tsx watch — restarts on file changes
npm run build            # tsc → dist/
npm run start            # node dist/server.js
npm run migrate          # knex migrate:latest --knexfile src/knexfile.ts
npm run migrate:rollback # knex migrate:rollback --knexfile src/knexfile.ts
npm run wallet:add       # add/update wallet (scripts/add-wallet.ts)
npx tsc --noEmit         # type-check without emitting
```

Migrations require explicit env vars (Knex doesn't auto-load dotenv):
```bash
DB_HOST=127.0.0.1 DB_USER=admin DB_PASSWORD=123456 DB_NAME=avaramp \
  npx tsx node_modules/.bin/knex migrate:latest --knexfile src/knexfile.ts
```

`./start-prod.sh` handles migrate + build + start in one step.

No lint, test, or format scripts are configured.

## Architecture

**Entrypoint** `src/server.ts` — slim startup. Imports `buildApp()` from `./app`.

**App factory** `src/app.ts` — builds Fastify instance, registers plugins in order: cors → swagger → swaggerUi → errorHandler → routes:

| Prefix | Route File | Handler File | Auth |
|---|---|---|---|
| `/admin` | `routes/adminRoutes.ts` | `controllers/adminController.ts` | JWT |
| `/api/rate` | `routes/priceRoutes.ts` | `controllers/priceController.ts` | None |
| `/config` | `routes/configRoutes.ts` | `controllers/configController.ts` | JWT (write) |
| `/api/orders` | `routes/orderRoutes.ts` | `controllers/orderController.ts` | **Partner-App-Key** |
| `/api/partners` | `routes/partnerRoutes.ts` | `controllers/partnerController.ts` | **Partner-App-Key** |
| `/api/webhooks` | `routes/webhookRoutes.ts` | `controllers/webhookController.ts` | Apikey / Webhook signature |

**Workers:**
- `cchain-listener/src/index.ts` — polls the C-Chain for custodial sell deposits (USDT `Transfer` logs + native AVAX balance deltas), sweeps to the Master Wallet, and completes sell orders. Run as a separate process (compose/PM2), **or** in-process in the API by setting `CCHAIN_LISTENER_IN_API=true` (see `services/cchainListenerLoop.ts`). The standalone worker and the in-process loop share the same code path; enable the flag in exactly one process per deployment.

**Layers:**
- `controllers/` — request handlers, delegate to services
- `services/` — business logic
- `models/types.ts` — shared interfaces (OrderState, DepositRequest, etc.)
- `routes/` — Fastify route registration + JSON Schema
- `middlewares/` — errorHandler, sepayAuth, adminAuth, partnerAuth, chainWebhookAuth

**API docs** served at `/docs` (Swagger UI).

## Service boundary: `web-be`

The user-facing surface lives in a separate service, `web-be/` (sibling
directory). It owns Google login, user profiles, KYC ID recognition, payment
methods, and the `/api/me/orders/*` proxy. Those routes are **not** served by
`payment_svc` anymore:

- Moved out: `controllers/{auth,me,user}Controller.ts`,
  `routes/{auth,me,user}Routes.ts`, `services/{user,paymentMethod,googleAuth,idRecognition,geminiVision,ocrSpace,cccdParser,s3}Service.ts`,
  `middlewares/{userAuth,kycCheck}.ts`, migrations `020`/`021`/`023`.
- The partner-authenticated `POST /api/orders/deposit_v2` and
  `POST /api/orders/withdrawal_v2` were **removed** (they depended on user data
  now owned by `web-be`). Partners use the V1 endpoints or `web-be`'s
  `/api/me/orders/*`.
- `orders.user_id` is a plain integer with no FK; it is a logical reference to
  `web-be.users.id` (schema owned by `web-be` in the same database).
- `web-be` verifies `Partner-App-Key` by calling `payment_svc`'s
  `GET /api/partners/verify` (partner-authenticated) and proxies
  `/api/me/orders/*` back to `payment_svc`'s `/api/orders/*` using
  `PAYMENT_SVC_BASE_URL` + `PAYMENT_SVC_PARTNER_APP_KEY`.
- `GET /api/orders` and `GET /api/orders/:id` accept an optional `user_id`
  query param so `web-be` can scope results to the authenticated user.

## Authentication

### Client → Service (Partner-App-Key)
All order endpoints require `Partner-App-Key` header:
- `POST /api/orders/deposit`
- `POST /api/orders/withdrawal`
- `GET /api/orders/:payment_code`
- `POST /api/orders/:payment_code/cancel`

### Provider → Service Webhooks
- **SePay**: `Authorization: Apikey <SEPAY_WEBHOOK_API_KEY>`
- **Chain**: `X-Webhook-Signature` + `X-Webhook-Timestamp` (HMAC-SHA256)

### Callback to Client
Service signs callbacks with `X-Timestamp` + `X-Signature` (HMAC-SHA256). Client verifies.

## Data Flow: Deposit (Buy AVAX/USDT)

1. Client → `POST /api/orders/deposit` with `{ amount, chain_id, token_address, recipient, callback }`
2. `orderService.createDeposit()` → `priceService.getQuote('buy')` → `binanceService` + `configService`
3. Order saved to DB with `payment_status: 'pending'`, `order_state: 1 (CREATED)`. Callback fired (with retry + signature).
4. Client receives payment_code (e.g., `DHA1B2C3D4`), checkout URL / QR code / bank info
5. User transfers VND to SePay bank with content = `payment_code`
6. SePay → `POST /api/webhooks/sepay` → `sepayService.handleSepayWebhook()` matches `code`, validates amount
7. `orderService.confirmPayment()` → updates to `payment_state` PROCESSING and calls `cchainPayoutService.disburseCchain()`
8. **C-Chain payout** sends native AVAX or ERC-20 USDT (EIP-1559) to the recipient `0x` address
9. On acceptance + confirmations: `order_state: 3 (COMPLETED)`, `transaction_hash` stored
10. Callback POSTed to client's `callback` URL (with HMAC signature, retry up to 3×)

## Data Flow: Withdrawal (Sell AVAX/USDT)

1. Client → `POST /api/orders/withdrawal` with `{ amount, chain_id, token_address, callback, payment_info }`
2. Order saved with bank details, `order_state: 1 (CREATED)`, and a per-order C-Chain custodial `0x` deposit address is provisioned
3. User sends native AVAX and/or ERC-20 USDT to the custodial address
4. `cchain-listener` detects the deposit (USDT Transfer logs / native balance delta), waits for confirmations, then sweeps to the Master Wallet
5. Deposit is correlated by address (`orders.recipient`), `order_state: 2 (PROCESSING)`, VND payout executed
6. On sweep success: `order_state: 3 (COMPLETED)`, callback POSTed to client's `callback` URL

## Order States

| State | Name |
|---|---|
| 1 | CREATED |
| 2 | PROCESSING |
| 3 | COMPLETED |
| 4 | FAILED |
| 5 | CANCELLED |

**State Transitions:**
- `CREATED(1) → PROCESSING(2) → COMPLETED(3)`
- `CREATED(1) → PROCESSING(2) → FAILED(4)`
- `CREATED(1) → CANCELLED(5)`
- `PROCESSING(2) → CANCELLED(5)` (only if no irreversible step: no sepay_transaction_id)

## Callback Webhooks

When `order_state` changes, POST to client's callback URL with HMAC signature:

**Headers:**
```
Content-Type: application/json
X-Timestamp: <unix-ms>
X-Signature: HMAC-SHA256(secret, timestamp + "." + body)
```

**Body:**
```json
{
  "id": "1",
  "topic": "order.state.change",
  "ts": "2026-04-24T10:00:00.000Z",
  "payload": {
    "order_id": "1",
    "old_order_state": 1,
    "new_order_state": 2
  }
}
```

**Features:**
- Retry: 3 attempts with 5s delay between attempts
- Logging: all attempts logged to `callback_logs` table
- Signature: HMAC-SHA256 with dual-secret support (rotation window)
- Replay protection: 5-minute window

## Error Response Schema

All errors return standardized format with `X-Trace-ID` header:

```json
{
  "success": false,
  "error": {
    "code": "MACHINE_CODE",
    "message": "Human-readable message",
    "retriable": true,
    "trace_id": "req-123"
  }
}
```

**Error codes**: ORDER_NOT_FOUND, INVALID_AMOUNT, CANCEL_NOT_ALLOWED, VALIDATION_ERROR, UNAUTHORIZED, AUTH_NOT_CONFIGURED, INTERNAL_ERROR, CHAIN_EVENT_MISMATCH

## Key Services

- `binanceService.ts` — Binance P2P median price, 30s cache
- `configService.ts` — config table cache, fee audit log
- `priceService.ts` — quote calculation with spreads/fees
- `sepayPgService.ts` — SePay checkout session
- `orderService.ts` — deposit/withdrawal creation, confirmPayment, cancelOrder, formatOrderResponse
- `queueService.ts` — Kafka producer: emitDisburseCrypto, emitOrderPaid
- `gcpKmsService.ts` — GCP Cloud KMS secp256k1 signing: signTxHash (32-byte digest → r‖s‖v), getKmsPublicKeyCompressed (used by the C-Chain payout account)
- `encryptionService.ts` — AES-256-GCM encrypt/decrypt for wallet secrets
- `callbackService.ts` — webhook callback with retry (3×), logging, HMAC signature, dual-secret rotation
- `sepayService.ts` — webhook handler, deduplication
- `cchainWalletService.ts` — provision per-sell-order custodial 0x deposit wallets; AES-256-GCM at rest
- `cchainRpcService.ts` — viem public/wallet clients for C-Chain EVM RPC + native USDT contract helpers
- `cchainListenerService.ts` — poll custodial addresses for native AVAX + USDT `Transfer` deposits, dedupe, confirmations
- `cchainSweepService.ts` — sweep USDT (EIP-712 Permit + `transferFrom`) and native AVAX (self-funded transfer); EIP-1559 overrides
- `cchainOrderService.ts` — correlate swept deposits to sell orders and complete them idempotently
- `cchainEmitService.ts` — emit confirmed C-Chain deposits to Kafka/HTTP fallback and in-process handler
- `cchainPayoutService.ts` — C-Chain buy payout: EIP-1559 native AVAX / ERC-20 USDT transfers to the recipient `0x` address, balance preflight, confirmations, idempotency, failure marking, stuck-order recovery (`initCchainPayout`, `sweepStuckCchainPayouts`)
- `cchainPayoutAccount.ts` — payout signer: viem account backed by GCP KMS secp256k1 (raw-key `CCHAIN_PAYOUT_WALLET_PRIVATE_KEY` fallback); derives the payout `0x` address
- `cchainUnits.ts` — token-aware decimal conversion (AVAX 18, USDT 6) with precision validation

## Key Tables

- `orders` — order records (includes `cancelled_at`, `cancel_reason` for Plan 2)
- `config` — runtime config (spreads, fee rates, callback secrets for rotation)
- `webhook_logs` — deduplication
- `callback_logs` — callback attempt logging (Plan 2)
- `fee_audit_log` — fee change audit
- `custodial_wallets` — per-sell-order C-Chain custodial wallets (encrypted keys at rest, sweep + listener-cursor bookkeeping)
- `custodial_wallets` — per-sell-order C-Chain custodial deposit wallets (encrypted keys at rest, sweep bookkeeping)
- `cchain_deposits` — C-Chain deposits detected on custodial addresses (dedupe key, sweep lifecycle status)
- `admins` — admin users for JWT auth

## DB Singleton

`src/db.ts` — shared Knex instance, pool min:2/max:10. Import as `import db from '../db'`.

## Migrations

`src/migrations/` — numbered `000_` through `009_`. Dual .ts/.js handling in dev/prod via `src/db.ts` migrationSource.

- `008_create_callback_logs.ts` — callback attempt logging
- `009_add_cancel_fields.ts` — cancel order support

## Env / Secrets

All via `import 'dotenv/config'`. See `.env.example`:

| Variable | Description |
|---|---|
| `SEPAY_KEY` | SePay SDK secret_key |
| `SEPAY_WEBHOOK_API_KEY` | Webhook auth (Apikey header) |
| `SEPAY_ENV` | sandbox/production |
| `PARTNER_APP_KEY` | Client → Service auth header |
| `CALLBACK_TIMEOUT_MS` | Callback HTTP timeout (default 8000) |
| `CALLBACK_RETRY_COUNT` | Callback retry attempts (default 3) |
| `CALLBACK_RETRY_DELAY_MS` | Callback retry delay (default 5000) |
| `CALLBACK_SIGNATURE_SECRET` | HMAC secret for callback signing |
| `ORDER_EXPIRY_MINUTES` | Order expiration time in minutes (default: 5) |
| `CHAIN_WEBHOOK_SECRET` | HMAC secret for chain webhook |
| `KAFKA_BROKERS` | Kafka address:port |
| `KAFKA_CLIENT_ID` | Kafka client ID (default: avaramp) |
| `KAFKA_DISBURSE_TOPIC` | Default: avaramp.disburse_crypto |
| `KAFKA_ORDER_PAID_TOPIC` | Default: avaramp.order_paid |
| `KAFKA_SSL_CA_PATH` | Path to CA cert for TLS verification (e.g. `/app/data/kafka_ca.pem`). Required for managed brokers (Aiven) |
| `KAFKA_SSL` | Set `true` to enable TLS without a custom CA (ignored if `KAFKA_SSL_CA_PATH` set) |
| `KAFKA_SASL_MECHANISM` | `plain` / `scram-sha-256` / `scram-sha-512` (default: scram-sha-256) |
| `KAFKA_SASL_USERNAME` | SASL username (e.g. avnadmin) |
| `KAFKA_SASL_PASSWORD` | SASL password |
| `GCP_KMS_PROJECT_ID` | GCP project id (e.g. graceful-envoy-463407-a1) |
| `GCP_KMS_LOCATION_ID` | KMS location (e.g. asia-southeast1) |
| `GCP_KMS_KEY_RING` | KMS key ring (e.g. avax-ramp) |
| `GCP_KMS_KEY_ID` | KMS crypto key (e.g. avax-hotwallet-kr) |
| `GCP_KMS_KEY_VERSION` | KMS key version (default: 1) — the payout `0x` address is derived from the KMS key; no address env var is kept |
| `ADMIN_JWT_SECRET` | JWT signing secret for admin routes |

> KYC/AWS/Google/`USER_JWT_*` env vars moved to `web-be` (see `web-be/.env.example`).

## C-Chain buy payout (Avalanche EVM)

Buy (deposit) orders settle on the **C-Chain**: after SePay confirms fiat,
`orderService.confirmPayment` calls `cchainPayoutService.disburseCchain(orderId,
recipient, amount, assetCode, tokenAddress)`.
It sends native AVAX (`sendTransaction`) or ERC-20 USDT (`transfer` on
`CCHAIN_NATIVE_USDT_ADDRESS`) to the order's `0x` recipient using EIP-1559 fees,
waits for `CCHAIN_PAYOUT_CONFIRMATIONS`, then marks the order `COMPLETED` (hash
stored) or `FAILED`. Signing uses GCP KMS secp256k1 via a viem account; a raw
`CCHAIN_PAYOUT_WALLET_PRIVATE_KEY` is the dev fallback. Buy recipients MUST be
EVM `0x` addresses. `sweepStuckCchainPayouts()` recovers orders left in
`processing_state = 13` after a restart. The X-Chain settlement path has been
retired; the C-Chain is the only settlement chain.

## C-Chain custodial sell flow (Avalanche EVM)

The sell/withdrawal side settles on the Avalanche **C-Chain** (EVM) using a
**custodial deposit-address** model (correlation by address, not memo). Each
sell order provisions a unique `0x` EOA (`custodial_wallets`); funds are swept
to the Master Wallet:

- **Native AVAX**: a self-funded native transfer (gas deducted from the user's
  balance) signed by the custodial key.
- **Native USDT (ERC-20)**: an EIP-712 **Permit** signed by the custodial key
  plus `transferFrom` submitted by the Master Wallet (which pays AVAX gas).
- Every C-Chain tx uses **EIP-1559** gas (`maxFeePerGas` + `maxPriorityFeePerGas`,
  never `gasPrice`).

Correlation: a confirmed, swept deposit maps by `orders.recipient = deposit address`
→ completes the sell order once (idempotent). Key services:
`cchainWalletService`, `cchainRpcService`, `cchainListenerService`,
`cchainSweepService`, `cchainOrderService`, `cchainEmitService`; migration
`029..031` add `custodial_wallets` + `cchain_deposits`; the `cchain-listener/`
worker (PM2/compose) polls the C-Chain, or the API does when
`CCHAIN_LISTENER_IN_API=true` (`services/cchainListenerLoop.ts`).

C-Chain env (see `.env.example`):

| Variable | Description |
|---|---|
| `CCHAIN_RPC_BASE_URL` | C-Chain EVM RPC URL |
| `CCHAIN_CHAIN_ID` | Avalanche chain id (43113 Fuji / 43114 Mainnet) |
| `CCHAIN_NATIVE_USDT_ADDRESS` | Native USDT contract (`0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7`) |
| `CCHAIN_DEPOSIT_CONFIRMATIONS` | Blocks before a deposit is sweepable (default 25) |
| `CCHAIN_POLL_INTERVAL_MS` | Listener poll interval |
| `CCHAIN_MIN_SWEEP_THRESHOLD` | Min native unit before sweeping (default 0) |
| `MASTER_WALLET_PRIVATE_KEY` | Master/sweep-destination wallet private key (0x hex) |
| `CUSTODIAL_KEY_ENCRYPTION_KEY` | ≥32-char AES-256-GCM key for custodial keys at rest |
| `CCHAIN_LISTENER_FALLBACK_URL` | HTTP fallback (e.g. `/api/webhooks/cchain-incoming`) |
| `CCHAIN_LISTENER_FALLBACK_AUTH_TOKEN` | Bearer token for the fallback webhook |
| `CCHAIN_LISTENER_IN_API` | Run the deposit poll loop inside the API process instead of the `cchain-listener` worker (default: false; enable in exactly one process) |
| `CCHAIN_PAYOUT_WALLET_PRIVATE_KEY` | Payout wallet key (0x hex) — dev/local fallback; prefers GCP KMS |
| `CCHAIN_PAYOUT_CONFIRMATIONS` | Blocks before a buy payout is final (default: 1) |
| `CCHAIN_AVAX_GAS_RESERVE_WEI` | AVAX (wei) kept for USDT payout gas (default: 0.01 AVAX) |

> Secret rotation: on rotation of `MASTER_WALLET_PRIVATE_KEY`, sweep new deposits to
> the new Master address (old swept funds stay at the old address — reconcile).
> On rotation of `CUSTODIAL_KEY_ENCRYPTION_KEY`, all `custodial_wallets` rows must be
> re-encrypted before any further decryption/sweep, because AAD is bound to `order_id`.

## Payment Code

`DH<8-alphanum>` (e.g., `DHA1B2C3D4`) — unique order identifier. Used as SePay transfer description.

## tsconfig

`module: "ES2022"` + `moduleResolution: "Bundler"`. Build output to `dist/`. `package.json` must have `"type": "commonjs"`.

## Admin Endpoints

- `POST /admin/login` — JWT login
- `GET /admin/stats` — order statistics (JWT required)
- `PATCH /admin/callback-secret` — rotate callback HMAC secret (JWT required)

## Integration

Full API documentation (endpoints, authentication, callbacks, error codes,
flow diagrams) is served interactively at `/docs` (Swagger UI).