# AgentTresor

Non-custodial spend control for AI agents on BSV (TUM Blockchain & AI Hackathon 2026, BSV track).
Companies lock a budget in an on-chain vault (2-of-2: agent AND policy, or the company alone);
agents pay merchants with BRC-121 only when the company's rules allow it.

## Setup

Node.js >= 22.

```bash
npm install
cp .env.example .env   # then set SERVER_PRIVATE_KEY
npm test               # offline, on wallet-toolbox's mock chain
npm run typecheck
npm run merchant       # demo merchant on MERCHANT_PORT (default 5080)
npm run proxy          # spend-control proxy + dashboard on PROXY_PORT (default 5050)
```

## How a payment works (non-custodial vault)

Each agent has one **vault UTXO**, funded by the company from its own wallet (BSV Desktop) and locked by

```
OP_IF   <agentPub> OP_CHECKSIGVERIFY <policyPub> OP_CHECKSIG
OP_ELSE <companyPub> OP_CHECKSIG
OP_ENDIF
```

- **Spend** needs the agent AND the proxy's policy key: neither can move funds alone.
- **Reclaim** needs only the company: it can always take the vault back.
- Keys are derived (`[1, 'agenttresor vault']`, keyID `agent-<id>`): the company's in its wallet, the policy key
  from `PROXY_ROOT_KEY`. The agent generates its own key and registers only the public key.

Flow: the agent registers its key (`POST /v1/vault/agent-key`) → the company funds the vault on `/vault.html` →
the agent calls `POST /v1/pay`. The proxy reads the merchant's BRC-121 price from an unpaid preflight, applies the
rules and the vault balance (a hard on-chain cap), and answers `{ status: 'sign', unsignedTx, … }`: input = the vault,
output 0 = the merchant's BRC-29 output, output 1 = change back to the vault. The agent checks it and signs
(`src/agent/vault-signer.ts`), then `POST /v1/requests/:id/sign`. The proxy verifies the signature, adds the policy
signature, broadcasts through Arcade and delivers the request to the merchant with the BRC-121 payment headers.
The signature must come back within 20 s (merchants accept a payment for 30 s).

## Layout

- `src/shared/bsv.ts`, `src/shared/brc121.ts` — the single (CJS) runtime build of `@bsv/sdk` and `@bsv/402-pay`; import
  SDK values from here, not from `@bsv/sdk`. `bsv.browser.ts` stands in for `bsv.ts` in the browser bundle
- `src/shared/network.ts` — `BSV_NETWORK` (main | test), Arcade URLs, WhatsOnChain links
- `src/shared/arcade.ts` — `ArcadeChainTracker` for SPV checks
- `src/shared/wallet.ts` — wallet-toolbox server wallet with Arcade as primary broadcaster (used by the demo merchant)
- `src/merchant/` — demo merchant selling to agents with BRC-121: `GET /api/catalog` (free), `GET /api/report` (fixed
  price), `POST /api/hotel/book` (nights x room rate)
- `src/vault/` — the vault: `script.ts` (locking/unlocking scripts, BIP-143 signing), `builder.ts` (payment tx, fee
  at 100 sat/kB), `service.ts` (funding check by SPV, payment build/finalize), `broadcaster.ts` (Arcade)
- `src/proxy/` — spend-control proxy: agent API (`/v1/…`, Bearer `agt_…`), rules (`rules.ts`: allowed hosts, max per
  payment, daily budget, approval threshold), approvals, ledger in `./data/proxy.sqlite`. Admin API under `/admin`
  (Bearer `ADMIN_TOKEN`); dashboard at `/`, vault page at `/vault.html`
- `src/company/vault-client.ts` — `fundVault` / `reclaimVault` against any BRC-100 wallet; `vault-page.ts` is the
  browser script of `public/vault.html`, bundled by `npm run build:web` into `public/vault.js`
- `src/agent/vault-signer.ts` — checks a payment before the agent signs it
- `test/helpers/` — offline mock chain, test wallets and a proxy harness

See `docs/BSV_STACK_COMPLETE_GUIDE.md` and `AGENTS.md` before writing BSV code.
