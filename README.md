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
npm run setup <code>   # on the agent's machine: connect + run the agent service on MCP_PORT (default 5070)
```

## The three parties

| Party | Holds | Can do alone | Cannot do alone |
|---|---|---|---|
| **Company** (BSV Desktop) | the money, and the company key in its wallet | fund vaults; approve a payment by funding it; **reclaim** any unspent vault at any time | pay a merchant on the agent's behalf |
| **Proxy** (spend control) | the policy key (`PROXY_ROOT_KEY`), no funds | price each request, apply the rules, keep the ledger, add the second signature | move a single satoshi (the policy key is never enough on its own) |
| **Agent** (local service) | its own key (`mcp-data/agents/<id>/agent-key.json`) | ask, check what it is asked to sign, sign | move funds without the proxy, or pay more than the price it checked itself |

Every vault UTXO is locked by the same script, with derived keys (`[1, 'agenttresor vault']`, keyID `agent-<id>`):

```
OP_IF   <agentPub> OP_CHECKSIGVERIFY <policyPub> OP_CHECKSIG     spend:   agent AND policy
OP_ELSE <companyPub> OP_CHECKSIG                                 reclaim: company alone
OP_ENDIF
```

## How a payment works

The company creates the agent on the dashboard (`/`: name and rules) and gives it a one-time connection code. The
agent runs `npm run setup <code>` on its own machine: it creates its signing key, registers the public key
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
anchor recorded, notary topped up / low balance. `actor` is `rules`, `admin`, `agent:<id>`, `company`, `proxy` (an
anchor inside a payment) or `notary`. API keys appear only as masked hints, and the log refuses anything that looks like
a key or token.

Editing, removing or reordering a past entry breaks the chain. To also catch a chain rewritten with recomputed hashes,
the head is anchored on BSV: one 0-sat output `OP_FALSE OP_RETURN "agenttresor-audit" <hash> <seq>`. Anchors come from
three places, and the dashboard shows which one made each (*By*):

- **A — in payments (automatic).** Every vault payment the proxy builds ends with that 0-sat anchor output for the log
  head at the moment the payment is built. Once the payment is broadcast the anchor is recorded (source `payment`).
  It costs a few satoshis of fee from the vault that pays anyway. The agent's signer checks it: it signs only if the
  extra output is exactly one 0-sat AgentTresor anchor, last. `AUTO_ANCHOR_PAYMENTS=false` turns this off. **Update the
  agents before the proxy:** an older agent refuses to sign a payment with the extra output.
- **B — the notary, when idle (automatic).** The entries a payment writes after its own anchor, and everything that
  happens without payments (agents created, rules changed, approvals), would stay unanchored. Every 30 s the proxy
  checks three things. Are there unanchored entries? Is the newest one older than `ANCHOR_IDLE_MS` (2 minutes)? Is no
  vault payment being built? (A payment that is being built will carry its own anchor.) If all three hold, the notary
  anchors the current head (source `notary`). One anchor is in flight at a time.
- **Manual.** *Anchor now with BSV Desktop* on the dashboard (`src/company/audit-client.ts`) anchors from the
  company's wallet whenever you like. The proxy checks the transaction by SPV, and checks that the hash is the one at
  that seq, then records the anchor (source `company`).

### The notary wallet

The notary is the **operator's own small fee wallet**, never company funds. It is a wallet-toolbox wallet
(`openServerWallet`) with its own key `NOTARY_ROOT_KEY`, stored in `./data/notary-wallet.sqlite`. It broadcasts through
Arcade.

- **What it can do:** create anchor transactions (one 0-sat OP_RETURN output; the wallet adds its own fee input and
  change), and receive top-ups.
- **What it cannot do:** it holds no vault key, so it cannot sign for any vault, move company or agent funds, or
  approve anything. It only ever writes the hash and seq that are already in the log.
- **Worst case:** whoever steals `NOTARY_ROOT_KEY` gets its balance, which is at most `NOTARY_MAX_SATS` (1,000,000 sats,
  0.01 BSV, by default). They could also write meaningless anchors, but the proxy records only anchors it made itself, and
  verifying checks every recorded anchor against the log.
- **Top-up:** the dashboard shows the balance and has a *Top up notary from BSV Desktop* button. You choose the amount;
  it is capped so that the balance stays at or below `NOTARY_MAX_SATS`.
  - It is a BRC-29 payment to the notary's identity key: the company wallet derives the key with `forSelf: false`.
  - The proxy verifies the transaction by SPV, checks that the output is locked to the notary's own derived key, and
    internalizes it as a `'wallet payment'`.
  - It pays anchoring fees only.
- **Low balance:** remaining anchors ≈ balance / the average fee of the notary's last 10 anchors (30 sats until it has
  made some).
  - **Orange banner** when fewer than `NOTARY_LOW_ANCHORS` (20) are left: *Notary: about N anchors left — top up
    from BSV Desktop*, with the top-up button.
  - **Red banner** when none are left, or when an anchor failed for lack of funds.
  - On each crossing the proxy calls the Notifier's `lowNotaryBalance` (so a Telegram notifier can forward it) and
    writes one `notary.low_balance` audit entry. These happen once per crossing, not on every check. A top-up
    re-arms the alert.
  - When out of funds, the proxy logs it once and keeps running: payments and the manual button still anchor.
- **Off switches:** without `NOTARY_ROOT_KEY` the notary is disabled, logged at start and shown on the dashboard;
  `AUTO_ANCHOR_NOTARY=false` turns it off too.

```bash
# .env on the proxy host: a fresh key just for the notary (never reuse PROXY_ROOT_KEY)
NOTARY_ROOT_KEY=$(openssl rand -hex 32)
```

- `GET /admin/notary` — `{enabled, identityKey, balanceSats, anchorsLeft, avgAnchorCostSats, level, outOfFunds,
  topUpRoomSats, maxSats, banner}` (or `{enabled: false, reason}`)
- `POST /admin/notary/topup` — `{beef, outputIndex, derivationPrefix, derivationSuffix, senderIdentityKey}` (the
  dashboard sends it; `src/company/notary-client.ts`)

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
  shorter than the anchor), but entries after the latest anchor can be removed without trace. Payments and the notary
  keep this window short (at most `ANCHOR_IDLE_MS` plus 30 s while the notary has funds); the dashboard shows how many
  entries are not anchored yet.
- **A payment anchors the head as it was when the payment was built,** not the entries the payment itself writes
  (they contain its txid, so they cannot be inside it). The notary picks those up once the log is idle.
- **One proxy process per database.** Appends, the per-agent locks and the verified mark are per process.

## Connect an agent in 30 seconds

1. **Admin, on the dashboard** (`/`): *New agent* with its name and rules. The dashboard shows a one-time code
   (`AT-XXXX-XXXX`, valid 10 minutes, usable once) and the exact command, with a Copy button.
2. **On the agent's machine**, in a checkout of this project (`npm install` once):
   ```bash
   npm run setup AT-XXXX-XXXX -- --proxy https://your-proxy.example
   ```
   It adds the agent's profile (`mcp-data/agents/<agentId>/`: settings and the agent's own signing key, mode 0600),
   registers the key, starts the agent service (see [Run the agent](#run-the-agent)) and prints
   `Agent key fingerprint: XXXX-XXXX-XXXX`. The API key is never printed. The link form works too:
   `npm run setup "https://your-proxy.example/connect#AT-XXXX-XXXX"`. `npm run connect` does the same without
   touching the service.
3. **Admin, on `/vault.html`**: check that the fingerprint shown there is the one the agent printed, then fund the
   vault.

*New code* on the dashboard issues a fresh code, e.g. for a new machine. Without an open vault the agent's current
API key stops working at once; with an open vault it keeps working until the new code is used. A new machine has a
new signing key, so an open vault must be reclaimed and funded again for it.

## Run the agent

The agent side is a long-running local service (`src/service/`) that hosts one or more agents, each from its own
profile `mcp-data/agents/<agentId>/` (directory 0700; `agent-config.json`, `agent-key.json`, later `tunnel-secret`,
all 0600). MCP clients reach it over HTTP, so it keeps running between turns (Claude Code's desktop app stops stdio
servers at the end of every turn).

```bash
npm run setup AT-XXXX-XXXX -- --proxy https://your-proxy.example
```

`setup` = connect (adds the profile, with a new key of its own) + run the service (on macOS a launchd agent of your
user, `~/Library/LaunchAgents/de.agenttresor.agent.plist`, started at login and restarted if it stops; elsewhere a
background process) + status + the fingerprint reminder. It then prints the `.mcp.json` for Claude Code and offers to
write it if the project has none:

```json
{ "mcpServers": { "agenttresor": { "type": "http", "url": "http://127.0.0.1:5070/agents/<agentId>/mcp" } } }
```

`.mcp.json` names your own agent, so it is gitignored; `.mcp.json.example` is the template. Claude Code asks once to
approve the `agenttresor` server. Instead of the file: `claude mcp add --transport http agenttresor <that url>`.

| Command | |
|---|---|
| `npm run agents` | the profiles: agent id, proxy, key fingerprint |
| `npm run agent:status` | is the service running; per agent: proxy reachable, vault balance, fingerprint, MCP URL |
| `npm run agent:start` / `agent:stop` | background service (`mcp-data/agent.pid`, log in `mcp-data/agent.log`); a second instance is refused |
| `npm run agent:install-service` / `agent:uninstall-service` | macOS launchd agent (your user account, never root) |
| `npm run agent:run` | the service in the foreground, for debugging |

A profile added with `npm run connect` while the service runs is served at once, and a new connection code for an
agent is picked up without a restart. The single-agent files of earlier versions (`mcp-data/agent-config.json`,
`mcp-data/agent-key.json`) are moved into their agent's profile on the first start.

Each agent has its own MCP server, payer and key. Tools: `list_services`, `check_budget`, `get_price`,
`pay_and_fetch {url, method?, body?, purpose, maxSats}`, `check_request {requestId}` and `show_agent_key` (the
fingerprint the company checks before funding). For each payment the agent asks the merchant's price itself, refuses
above `maxSats`, and signs the vault transaction only if output 0 pays exactly that price (`src/agent/pay.ts`). A
payment above the approval threshold comes back `pending` with a request id; once the company approves it,
`check_request` pays it. Without a connection, or with a revoked key, every tool answers what to do.

Settings: `MCP_PORT` (5070), `MCP_DATA_DIR` (`mcp-data`), `MCP_HOST` (127.0.0.1) and `MCP_TOKEN`, in the
environment or the project's `.env`. The service ignores `PROXY_URL`, `AGENT_API_KEY` and `MERCHANT_URLS`: each
profile has its own.

**Claude Desktop** and other clients that keep a stdio server running can still use `npm run --silent mcp`: it serves
`AGENT_ID`'s profile, or the only one (here `PROXY_URL`, `AGENT_API_KEY` and `MERCHANT_URLS` still override it).

### Plain HTTP API

For agents that do not speak MCP, the service has the same tools as JSON, per agent, with the same access rules:

| | |
|---|---|
| `GET /agents/<id>/v1/budget` | `check_budget` |
| `POST /agents/<id>/v1/price` `{url, method?, body?}` | `get_price` |
| `POST /agents/<id>/v1/pay` `{url, method?, body?, purpose, maxSats}` | `pay_and_fetch`: own price check, agent signature, never above `maxSats` |
| `GET /agents/<id>/v1/requests/<requestId>` | `check_request`: pays an approved request |

The answers are the tools' JSON results (`status`: `paid`, `free`, `pending`, `denied`, `paid_not_delivered`,
`failed`), with HTTP 200; 400 for invalid input, 502 if the proxy cannot answer, 503 if the agent is not connected.

```bash
curl -s -X POST http://127.0.0.1:5070/agents/A-1234ABCD/v1/pay -H 'content-type: application/json' \
  -d '{"url":"https://shop.example/api/report","purpose":"Weekly market report","maxSats":600}'
```

```python
import requests
AGENT = "http://127.0.0.1:5070/agents/A-1234ABCD/v1"
url = "https://shop.example/api/report"
budget = requests.get(f"{AGENT}/budget").json()
price = requests.post(f"{AGENT}/price", json={"url": url}).json()
if price["status"] == "priced" and price["satoshis"] <= budget["remainingTodaySats"]:
    r = requests.post(f"{AGENT}/pay", json={"url": url, "purpose": "Weekly market report", "maxSats": price["satoshis"]}).json()
    print(r["status"], r.get("txid") or r.get("requestId") or r.get("reason"))
else:
    print("not paying:", price)
```

## Use it from ChatGPT

ChatGPT cannot reach `127.0.0.1`, so this is an opt-in public tunnel (Cloudflare quick tunnel, no account needed):

```bash
brew install cloudflared            # once
npm run agent:tunnel A-1234ABCD     # with the service running
```

It prints one URL, `https://<random>.trycloudflare.com/agents/A-1234ABCD/s/<secret>/mcp`. In ChatGPT, add a custom
connector (Settings → Connectors, developer mode) with that URL as the MCP server URL and no authentication. The
tunnel stays open while the command runs; the host name changes on every run, the secret does not (until revoked).
`npm run agent:tunnel-revoke A-1234ABCD` rotates the secret: the old URL stops working at once.

The same URL serves the HTTP API: `https://<random>.trycloudflare.com/agents/A-1234ABCD/s/<secret>/v1/budget`.

### Security notes

- **Loopback by default.** The service listens on 127.0.0.1. Local clients need no token, but a request with an
  `Origin` header (a web page) is refused, and the MCP SDK's Host check stops DNS rebinding. Listening on another
  address (`MCP_HOST`) requires `MCP_TOKEN` (at least 16 characters) on every request.
- **The tunnel URL is a capability.** Anything that comes through a tunnel or proxy (`X-Forwarded-For`,
  `Cf-Connecting-Ip`, `Forwarded`) or from a non-loopback address is accepted only with that agent's secret, in the
  path or as `Authorization: Bearer <secret>`, compared in constant time. Another agent's secret, a wrong one or none
  is a 401, and an agent that never had a tunnel cannot be reached from outside at all. The secret (32 random bytes)
  is stored 0600 in the profile and printed only in that one URL, never logged; keep it like a password.
- **The company's limits still apply.** Whoever holds the URL can only do what the agent can: the rules (allowed
  hosts, max per payment, daily budget, approval threshold) are enforced by the proxy, a vault payment needs the
  proxy's signature too, and the vault holds only what the company put in it. The company can reclaim the vault at any
  time.
- **Revoke** a leaked link with `npm run agent:tunnel-revoke <id>`, or stop the agent entirely with a new connection
  code on the dashboard (its API key stops working).

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
- `src/agent/` — the agent side: `connect.ts` (`npm run connect`), `profiles.ts` (one directory per agent, migration,
  tunnel secret), `config.ts` (`agent-config.json`), `keys.ts` (its own key, `agent-key.json`), `tools.ts` (the tools,
  shared by MCP and the HTTP API), `proxy-client.ts`, `pay.ts` (price check, sign, retry once), `vault-signer.ts`
  (checks a payment before signing it)
- `src/proxy/connect.ts` — one-time connection codes, constant-time lookup, rate limit, merchants from allowed hosts
- `src/mcp/` — the agent's MCP server: `server.ts` (tools), `setup.ts` (settings, key, registration), `main.ts` (stdio)
- `src/service/` — the local agent service: `app.ts` (MCP per agent), `api.ts` (plain HTTP API), `access.ts`
  (loopback, Origin, tunnel secret), `registry.ts` (profiles), `control.ts` (pid lock, start/stop), `launchd.ts`,
  `tunnel.ts` (cloudflared), `cli.ts` (`setup`, `agents`, `agent:*`), `main.ts`
- `src/shared/merchant.ts` — unpaid BRC-121 preflight and merchant calls, used by the proxy and the agent
- `src/audit/` — the hash-chained audit log, the OP_RETURN anchor script, anchor checks, `audit:verify`
- `src/company/audit-client.ts` — `anchorAuditHead` against any BRC-100 wallet (`public/audit.js` in the browser)
- `src/audit/notary.ts` — the notary: idle anchoring, top-ups, low-balance alert; `src/company/notary-client.ts` tops it up
- `src/shared/fingerprint.ts` — agent key fingerprint, shared by the agent, the dashboard (`public/fingerprint.js`)
  and the vault page
- `test/helpers/` — offline mock chain, test wallets and a proxy harness

See `docs/BSV_STACK_COMPLETE_GUIDE.md` and `AGENTS.md` before writing BSV code.

The BSV-21 token module is based on the official bsv21-token-kit starter kit from the BSV Developer Pack.
