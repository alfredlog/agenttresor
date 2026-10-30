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
```

## Layout

- `src/shared/bsv.ts`, `src/shared/brc121.ts` — the single (CJS) runtime build of `@bsv/sdk` and `@bsv/402-pay`; import SDK values from here, not from `@bsv/sdk`
- `src/shared/network.ts` — `BSV_NETWORK` (main | test), Arcade URLs, WhatsOnChain links
- `src/shared/arcade.ts` — `ArcadeChainTracker` for SPV checks
- `src/shared/wallet.ts` — wallet-toolbox server wallet with Arcade as primary broadcaster
- `src/merchant/` — demo merchant selling to agents with BRC-121: `GET /api/catalog` (free), `GET /api/report` (fixed price), `POST /api/hotel/book` (nights x room rate)
- `test/helpers/mockchain.ts` — offline mock chain and test wallets

See `docs/BSV_STACK_COMPLETE_GUIDE.md` and `AGENTS.md` before writing BSV code.
