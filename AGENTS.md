# AGENTS.md — Building on the BSV Blockchain

Instructions for AI coding agents (Claude Code, Cursor, Codex, Copilot…) working on a BSV Blockchain project for the TUM Blockchain & AI Hackathon 2026. Copy this file to the root of your repository.

## Source of truth

1. **`BSV_STACK_COMPLETE_GUIDE.md`** is the primary reference. Read the relevant section before writing code. Prefer its tested code (Appendix A) over code from memory: older examples on the web and in training data use outdated APIs.
2. `starter/bsv21-token-kit/` is the working reference implementation. Its 38 tests (`npm test`) show how every flow is called.
3. For anything the guide does not cover, use the official sources it links to (ts-stack, BRC specifications). Do not guess API names; check the installed package's type definitions.

## Versions

Node.js ≥ 22.

| Package | Version |
|---|---|
| `@bsv/sdk` | 3.2.1 |
| `@bsv/wallet-toolbox` | 2.14.9 |
| `@bsv/overlay` | 2.6.4 |
| `@bsv/overlay-express` | 2.7.4 |
| `@bsv/auth-express-middleware` | 2.2.9 |
| `@bsv/payment-express-middleware` | 2.1.9 |
| `@bsv/402-pay` | 0.3.3 |

The repositories `bsv-blockchain/ts-sdk` and `bsv-blockchain/wallet-toolbox` are superseded by the monorepo `bsv-blockchain/ts-stack`.

## Rules

### Wallet and keys
- **Connecting to the wallet:**
  - In a browser, use `new WalletClient('auto')` (BSV Desktop / BSV Browser).
  - In Node, pass the app domain as the second argument (the originator).
  - `new WalletClient('auto', 'simple')` is wrong.
- **The user's keys never leave the wallet.** Build transactions with `createAction` / `signAction` and sign custom inputs with `wallet.createSignature`. Never ask for a private key or recovery phrase.
- **Never lock funds, tokens or NFTs to `P2PKH(identityKey)`.** BRC-100 wallets only sign with derived keys (BRC-42/43). Lock everything to a derived key.
- **Protocol security level for keys that control value:** use level ≥ 1. Level 0 never asks the user for permission.

### Transactions and payments
- **`randomizeOutputs: false`:** set it whenever you rely on an output index (token deploys, NFT origins, payments).
- **Output index:** find it by locking script. Never hard-code `0`.
- **BRC-29 derivation:** `counterparty` is always the **other** party's identity key. The sender uses `forSelf: false` and the recipient uses `forSelf: true`. Never use `'self'` for a payment between two parties.
- **Receiving a payment:** verify it with SPV (`Transaction.fromAtomicBEEF(tx).verify(chainTracker)`), then `internalizeAction`. A received payment is spendable immediately, with no block confirmation needed.
- **`internalizeAction` protocols:**
  - `'wallet payment'` for plain satoshis;
  - `'basket insertion'` into a named basket for tokens, NFTs and app data;
  - **never put tokens or NFTs in the `default` basket**, because the wallet would spend them as fees.

### BSV-21 tokens
- **Canonical format:**
  - the content-type tag is `OP_1` (`0x51`);
  - every JSON value is a string (`"amt":"250"`, `"dec":"2"`);
  - ids are `<txid>_<vout>` (underscore).
- **Bitcoin Script does not enforce BSV-21.** The overlay is the source of truth: only treat a token UTXO as valid if the overlay admitted it and has not seen it spent.
- **Only spend overlay-validated UTXOs.** A wallet basket validates nothing, and one bad input gets the whole transaction refused.
- **Submit every token transaction to the overlay, in order** (parents first).
- **`inputBEEF`:** for token spends, use the overlay's BEEF (it has the full ancestry).
- **Topic and service names** must match `^tm_[a-z]+(_[a-z]+)*$` / `^ls_…` (BRC-87): no digits.

### NFTs (1Sat Ordinals)
- **Mint:** the inscription goes in output 0, with `randomizeOutputs: false`.
- **Transfer:** the NFT must be input 0 and land in a 1-satoshi output 0, because ordinals are tracked first-in, first-out.

### Paid APIs (HTTP 402)
- **Use the official protocols; do not invent headers.**
  - BRC-105: `@bsv/auth-express-middleware` + `@bsv/payment-express-middleware`; the client is `AuthFetch`.
  - BRC-121: `@bsv/402-pay`; the client is `create402Fetch`.
- **The server sets the price.** Use an atomic, shared replay store when more than one process serves paid routes.
- **`@bsv/402-pay` 0.3.3 with a wallet-toolbox wallet:** wrap the wallet with `withHostOriginator()` (see the guide §10.4).

### Server wallets
- **Creating the wallet:** use `@bsv/wallet-toolbox`: `Setup.createWalletSQLite({ env, rootKeyHex, filePath, databaseName })` with an `env` object you build yourself (guide §14). `Setup.getEnv()` requires a specific `.env`.
- **The private key:** load it from an environment variable or secret manager. Never commit it, never log it, and add `.env` to `.gitignore`.

### Non-custodial design
- User funds stay in the user's wallet.
- No single server key may control users' assets.

### Infrastructure
- **Block headers, broadcasting, transaction status:** use Arcade (`https://arcade-v2-us-1.bsvblockchain.tech`, headers at `/chaintracks/v2`). The free WhatsOnChain API rate-limits (`429`).
- **Explorers:** WhatsOnChain for transactions, BananaBlocks for BSV-21 tokens.

### Testing
- Test offline with wallet-toolbox's mock chain: see `starter/bsv21-token-kit/test/helpers/mockchain.ts`.
- In tests, load a single build of `@bsv/sdk` (see `vitest.config.ts`) to avoid two copies of the SDK classes.
