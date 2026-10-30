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
npm run mcp:http       # the agent's MCP server over HTTP on MCP_PORT (default 5070)
```

## The three parties

| Party | Holds | Can do alone | Cannot do alone |
|---|---|---|---|
| **Company** (BSV Desktop) | the money, and the company key in its wallet | fund vaults; approve a payment by funding it; **reclaim** any unspent vault at any time | pay a merchant on the agent's behalf |
| **Proxy** (spend control) | the policy key (`PROXY_ROOT_KEY`), no funds | price each request, apply the rules, keep the ledger, add the second signature | move a single satoshi (the policy key is never enough on its own) |
| **Agent** (MCP server) | its own key (`mcp-data/agent-key.json`) | ask, check what it is asked to sign, sign | move funds without the proxy, or pay more than the price it checked itself |

Every vault UTXO is locked by the same script, with derived keys (`[1, 'agenttresor vault']`, keyID `agent-<id>`):

```
OP_IF   <agentPub> OP_CHECKSIGVERIFY <policyPub> OP_CHECKSIG     spend:   agent AND policy
OP_ELSE <companyPub> OP_CHECKSIG                                 reclaim: company alone
OP_ENDIF
```

## How a payment works

The company creates the agent on the dashboard (`/`: name and rules; the `agt_…` API key is shown once, for the
agent's `.env`). The agent runs `npm run mcp` on its own machine: it creates its signing key, registers the public key
(`POST /v1/vault/agent-key`) and prints `Agent key fingerprint: XXXX-XXXX-XXXX`. The company funds the agent's vault
on `/vault.html` only after checking that the fingerprint shown there, computed in the browser from the registered
key, is the same as on the agent's machine (`src/shared/fingerprint.ts`: first 6 bytes of sha256 of the compressed
key). Funding and approve-and-fund stay disabled until that is confirmed, and refuse a key that changed since. Then
the agent calls `POST /v1/pay`. The proxy reads the merchant's BRC-121 price from an unpaid
preflight and applies the rules. Three outcomes:

- **Under the approval threshold**: paid from the **agent's vault**. The proxy answers `{ status: 'sign', unsignedTx, … }`
  (input = the vault, output 0 = the merchant's BRC-29 output, output 1 = change back to the vault); the vault balance
  is a hard on-chain cap.
- **Above the threshold**: `pending`, and impossible until a human approves it **on chain**. Approving means funding:
  the dashboard's *Approve and fund* opens `/vault.html?approve=R-…`, which shows purpose, merchant, price and fee, and
  funds a one-off **request vault** with exactly price + fee from BSV Desktop (`approveAndFund`). The proxy checks it by
  SPV, exact script and exact amount. The agent then calls `POST /v1/requests/:id/execute` and gets a 1-input,
  1-output transaction: the whole request vault goes to the merchant's price and the fee; the agent's own vault is
  not touched. If the price changed in any way, the request fails with nothing paid. The daily budget and the
  per-payment maximum still apply at execute time. (BRC-121 payments expire after 30 s, so the company cannot sign the
  payment itself in advance; it funds it instead.)
- **Against the rules**: `denied`, nothing is built.

Either way the agent checks the transaction against the price it read itself and signs (`src/agent/vault-signer.ts`),
then `POST /v1/requests/:id/sign`. The proxy verifies the signature, adds the policy signature, broadcasts through
Arcade and sends the request to the merchant with the BRC-121 payment headers. The signature must come back within
20 s (merchants accept a payment for 30 s).

A request vault that is never spent (price changed, denied at execute, expired after 24 h, or the company changed its
mind) is listed under *Approved payments* on `/vault.html` and reclaimed by the company alone, like an agent vault.

## Audit log (tamper-evident, anchored on BSV)

Every decision and payment is appended to a hash-chained log in `./data/proxy.sqlite` (`src/audit/log.ts`):
`hash = sha256(prev_hash + canonical JSON {seq, at, actor, type, data})`, starting from 64 zeros, keys sorted at every
level. Entries: agent created, rules changed, agent key registered (with its fingerprint), request created / decided /
paid / paid_not_delivered / failed / expired, vault funded / payment / reclaimed, request vault funded / reclaimed,
anchor recorded. `actor` is `rules`, `admin`, `agent:<id>` or `company`. API keys appear only as masked hints, and
the log refuses anything that looks like a key or token.

Editing, removing or reordering a past entry breaks the chain. To also catch a chain rewritten with recomputed hashes,
the company anchors the head on BSV from its own wallet (dashboard: *Anchor now with BSV Desktop*,
`src/company/audit-client.ts`): one 0-sat output `OP_FALSE OP_RETURN "agenttresor-audit" <hash> <seq>`. The proxy pays
nothing; it checks the transaction by SPV and that the hash is the one at that seq, then records the anchor.

- `GET /admin/audit?after=&limit=` — entries and anchors (with WhatsOnChain links)
- `GET /admin/audit/head` — `{seq, hash, unanchoredEntries, latestAnchorSeq, chainShorterThanAnchor}`
- `GET /admin/audit/verify` — incremental: re-hashes only the entries after the last verified one (after checking that
  one is unchanged; any mismatch falls back to a full check). `?full=1` re-checks the whole chain. Both also check
  every anchor and whether the log is shorter than the latest anchor.
- `npm run audit:verify [-- path/to/proxy.sqlite]` — a full check from the command line (exit code 1 if tampered)

Every state change and its audit entry are written in one database transaction: if the entry cannot be written,
the change is rolled back too.

### Known limits

- **A payment is broadcast before its database transaction.** The vault state, the `vault.payment` entry and the
  request's "paid" record commit together, but after the broadcast, which cannot be rolled back. If that transaction
  fails (disk full, crash), the payment is on chain without a record; it then has to be reconciled from the txid.
- **The dashboard's verify is incremental.** It catches new entries and a changed last-verified entry, not an edit
  to an older entry: use *Verify full chain* or `npm run audit:verify` for that. The verified mark lives in memory, so
  the first check after a restart is a full one.
- **Only anchored entries are protected against deletion.** Deleting entries up to an anchor is reported (the log is
  shorter than the anchor), but entries after the latest anchor can be removed without trace. The dashboard shows how
  many are not anchored yet: anchor often.
- **One proxy process per database.** Appends, the per-agent locks and the verified mark are per process.

## Connect an agent in 30 seconds

1. **Admin, on the dashboard** (`/`): *New agent* with its name and rules. The dashboard shows a one-time code
   (`AT-XXXX-XXXX`, valid 10 minutes, usable once) and the exact command, with a Copy button.
2. **On the agent's machine**, in a checkout of this project (`npm install` once):
   ```bash
   npm run connect AT-XXXX-XXXX -- --proxy https://your-proxy.example
   ```
   It saves the agent's settings to `mcp-data/agent-config.json` (mode 0600), creates the agent's own signing key,
   registers it and prints `Connected as A-…. Agent key fingerprint: XXXX-XXXX-XXXX`. The API key is never printed.
   The link form works too: `npm run connect "https://your-proxy.example/connect#AT-XXXX-XXXX"`.
3. **Admin, on `/vault.html`**: check that the fingerprint shown there is the one the agent printed, then fund the
   vault. Claude Code picks up the agent from the project's `.mcp.json` (approve it once when asked).

*New code* on the dashboard issues a fresh code, e.g. for a new machine. Without an open vault the agent's current
API key stops working at once; with an open vault it keeps working until the new code is used. A new machine has a
new signing key, so an open vault must be reclaimed and funded again for it.

## The AI agent (MCP server)

`src/mcp/` is an MCP server that an AI agent (Claude Desktop, Claude Code…) uses to pay for services. It holds
the agent's own signing key (`mcp-data/agent-key.json`, mode 0600, gitignored) and registers its public key with the
proxy on start. The company funds the agent's vault on `/vault.html`.

Tools: `list_services`, `check_budget`, `get_price`, `pay_and_fetch {url, method?, body?, purpose, maxSats}`,
`check_request {requestId}` and `show_agent_key` (the key fingerprint the company checks before funding; the server
also prints it to stderr on start). For each payment the agent asks the merchant's price itself, refuses above `maxSats`,
and signs the vault transaction only if output 0 pays exactly that price (`src/agent/pay.ts`). A payment above the
approval threshold comes back `pending` with a request id; once the company approves it, `check_request` pays it.

Settings come from `mcp-data/agent-config.json`, written by `npm run connect`. The merchants come from the proxy
(`GET /v1/services`, the agent's allowed hosts). Env vars (or the project's `.env`) override the file: `PROXY_URL`,
`AGENT_API_KEY`, `MERCHANT_URLS`; also `MCP_DATA_DIR`, and for HTTP `MCP_TOKEN`, `MCP_PORT`, `MCP_HOST`. Without
settings, or with a revoked key, the server still starts and every tool answers
`Not connected. Ask your admin for a connection code and run: npm run connect <code>`.

**Claude Code** reads the project's `.mcp.json` (`npm run --silent mcp`, no paths, no keys) and asks once to approve
the `agenttresor` server. Use `--silent`: on stdio, stdout belongs to the protocol.

**Claude Desktop** (`claude_desktop_config.json`, stdio). Claude Desktop may not see your shell's `PATH`; if `npm`
is not found, give its absolute path (`which npm`).

```json
{
  "mcpServers": {
    "agenttresor": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/agenttresor", "run", "--silent", "mcp"]
    }
  }
}
```

**Over HTTP**, with `npm run mcp:http` running and `MCP_TOKEN` set:

```bash
claude mcp add --transport http agenttresor http://127.0.0.1:5070/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

### Proxy settings for onboarding

`PROXY_PUBLIC_URL` (e.g. `https://agentpay.example`) for the links in connection codes, and `TRUST_PROXY=1` behind
a reverse proxy, so the rate limit on `POST /v1/connect` (10 attempts per IP per 10 minutes) sees real client IPs.

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
- `src/company/vault-client.ts` — `fundVault`, `approveAndFund`, `reclaimVault` / `reclaimRequestVault` against any
  BRC-100 wallet; `vault-page.ts` is the
  browser script of `public/vault.html`, bundled by `npm run build:web` into `public/vault.js`
- `src/agent/` — the agent side: `connect.ts` (`npm run connect`), `config.ts` (`agent-config.json`), `keys.ts` (its
  own key, `agent-key.json`), `proxy-client.ts`, `pay.ts` (price check, sign, retry once), `vault-signer.ts` (checks a
  payment before signing it)
- `src/proxy/connect.ts` — one-time connection codes, constant-time lookup, rate limit, merchants from allowed hosts
- `src/mcp/` — the agent's MCP server: `server.ts` (tools), `setup.ts` (settings, key, registration), `http.ts`
  (Streamable HTTP + Bearer token), `main.ts`
- `src/shared/merchant.ts` — unpaid BRC-121 preflight and merchant calls, used by the proxy and the agent
- `src/audit/` — the hash-chained audit log, the OP_RETURN anchor script, anchor checks, `audit:verify`
- `src/company/audit-client.ts` — `anchorAuditHead` against any BRC-100 wallet (`public/audit.js` in the browser)
- `src/shared/fingerprint.ts` — agent key fingerprint, shared by the agent, the dashboard (`public/fingerprint.js`)
  and the vault page
- `test/helpers/` — offline mock chain, test wallets and a proxy harness

See `docs/BSV_STACK_COMPLETE_GUIDE.md` and `AGENTS.md` before writing BSV code.
