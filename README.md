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

## The AI agent (MCP server)

`src/mcp/` is an MCP server that an AI agent (Claude Desktop, Claude Code…) uses to pay for services. It holds
the agent's own signing key: on first start it creates `mcp-data/agent-key.json` (mode 0600, gitignored) and
registers the public key with the proxy. The company then funds the agent's vault on `/vault.html`.

Tools: `list_services`, `check_budget`, `get_price`, `pay_and_fetch {url, method?, body?, purpose, maxSats}`,
`check_request {requestId}` and `show_agent_key` (the key fingerprint the company checks before funding; the server
also prints it to stderr on start). For each payment the agent asks the merchant's price itself, refuses above `maxSats`,
and signs the vault transaction only if output 0 pays exactly that price (`src/agent/pay.ts`). A payment above the
approval threshold comes back `pending` with a request id; once the company approves it, `check_request` pays it.

Settings come from the environment or the project's `.env`: `PROXY_URL`, `AGENT_API_KEY` (the `agt_…` key from
`POST /admin/agents`), `MERCHANT_URLS`, `MCP_DATA_DIR`; for HTTP also `MCP_TOKEN`, `MCP_PORT`, `MCP_HOST`.

**Claude Desktop** (`claude_desktop_config.json`, stdio). Use `--silent`: on stdio, stdout belongs to the protocol.
Claude Desktop may not see your shell's `PATH`; if `npm` is not found, give its absolute path (`which npm`).

```json
{
  "mcpServers": {
    "agenttresor": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/agenttresor", "run", "--silent", "mcp"],
      "env": {
        "PROXY_URL": "http://localhost:5050",
        "AGENT_API_KEY": "agt_…",
        "MERCHANT_URLS": "http://localhost:5080"
      }
    }
  }
}
```

**Claude Code**, stdio:

```bash
claude mcp add agenttresor -e PROXY_URL=http://localhost:5050 -e AGENT_API_KEY=agt_… -e MERCHANT_URLS=http://localhost:5080 -- npm --prefix /absolute/path/to/agenttresor run --silent mcp
```

or over HTTP, with `npm run mcp:http` running and `MCP_TOKEN` set:

```bash
claude mcp add --transport http agenttresor http://127.0.0.1:5070/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

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
- `src/agent/` — the agent side: `keys.ts` (its own key, `agent-key.json`), `proxy-client.ts`, `pay.ts` (price check,
  sign, retry once), `vault-signer.ts` (checks a payment before signing it)
- `src/mcp/` — the agent's MCP server: `server.ts` (tools), `http.ts` (Streamable HTTP + Bearer token), `main.ts`
- `src/shared/merchant.ts` — unpaid BRC-121 preflight and merchant calls, used by the proxy and the agent
- `src/shared/fingerprint.ts` — agent key fingerprint, shared by the agent, the dashboard (`public/fingerprint.js`)
  and the vault page
- `test/helpers/` — offline mock chain, test wallets and a proxy harness

See `docs/BSV_STACK_COMPLETE_GUIDE.md` and `AGENTS.md` before writing BSV code.
