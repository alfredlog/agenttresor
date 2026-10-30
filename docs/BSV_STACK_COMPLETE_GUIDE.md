# BSV Blockchain Stack — The Complete Guide to Building Applications

> **A single reference for building on the BSV Blockchain with a BRC-100 wallet (BSV Desktop): `@bsv/sdk`, `@bsv/wallet-toolbox`, payments (BRC-29), pay-per-request APIs (HTTP 402), SPV/BEEF, instant settlement, output baskets, overlays, BSV-21 tokens (mint, transfer, merge, origin checks), 1Sat Ordinals NFTs, and Arcade.**
>
> Written so that a developer — or an AI given only this file — can build complete applications end to end. Appendix A contains the full source of a working token kit (overlay + client + UI) that you can copy as-is.

**What has been verified, and how.** Each section is tagged:

| Tag | Meaning |
|---|---|
| ✅ **Mainnet** | Run on BSV mainnet with BSV Desktop (October 2026): token deploy, transfers, coin selection with change, overlay validation, basket sync, recovery from chain, Arcade SPV headers, token visible on BananaBlocks. |
| ✅ **Automated test** | Covered by the kit's test suite (38 tests): real `wallet-toolbox` wallets — the same wallet engine BSV Desktop runs — on wallet-toolbox's mock chain, talking to the real overlay over HTTP with SPV. |
| 🧩 **Pattern** | Correct usage of official APIs, not exercised by the kit's tests. |

**Using this file with an AI assistant.** Give it this file plus, if it can browse: the ts-stack docs (<https://bsv-blockchain.github.io/ts-stack/>), the BRC specifications (<https://github.com/bsv-blockchain/BRCs>) and the 1Sat Ordinals docs index (<https://docs.1satordinals.com/llms.txt>).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Packages, Versions and Official Repositories](#2-packages-versions-and-official-repositories)
3. [Core Concepts: UTXO, SPV, BEEF and 0-Conf](#3-core-concepts-utxo-spv-beef-and-0-conf)
4. [Connecting to the Wallet (BRC-100)](#4-connecting-to-the-wallet-brc-100)
5. [Identity Keys and Key Derivation](#5-identity-keys-and-key-derivation)
6. [Creating Transactions: createAction](#6-creating-transactions-createaction)
7. [Receiving Transactions: internalizeAction](#7-receiving-transactions-internalizeaction)
8. [Output Baskets, customInstructions and Tags](#8-output-baskets-custominstructions-and-tags)
9. [Instant P2P Payments with BRC-29](#9-instant-p2p-payments-with-brc-29)
10. [Airdrops and Pay-per-Request APIs (HTTP 402)](#10-airdrops-and-pay-per-request-apis-http-402)
11. [Treasury Wallets and UTXO Pools](#11-treasury-wallets-and-utxo-pools)
12. [On-Chain Data with OP_RETURN](#12-on-chain-data-with-op_return)
13. [1Sat Ordinals NFTs](#13-1sat-ordinals-nfts)
14. [Server Wallets with wallet-toolbox](#14-server-wallets-with-wallet-toolbox)
15. [BSV-21 Tokens: Concepts](#15-bsv-21-tokens-concepts)
16. [Running a Token Overlay](#16-running-a-token-overlay)
17. [Using Tokens from a BRC-100 App](#17-using-tokens-from-a-brc-100-app)
18. [Checking Token Origin and Security](#18-checking-token-origin-and-security)
19. [Showing Tokens and Balances](#19-showing-tokens-and-balances)
20. [Arcade: Broadcasting, Status and Chaintracks](#20-arcade-broadcasting-status-and-chaintracks)
21. [STAS Tokens (Coming Soon)](#21-stas-tokens-coming-soon)
22. [BRC Reference](#22-brc-reference)
23. [Troubleshooting](#23-troubleshooting)
24. [Cheat Sheet](#24-cheat-sheet)
- [Appendix B: Verification Checklist](#appendix-b-verification-checklist)
- [Appendix A: Token Kit Source](#appendix-a-token-kit-source)

---

## 1. Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ YOUR APP (browser or Node)                                            │
│   @bsv/sdk WalletClient ── BRC-100 ──▶ BSV Desktop (keys never leave) │
│   createAction · signAction · internalizeAction · listOutputs …       │
└───────────┬───────────────────────────────┬──────────────────────────┘
            │ AtomicBEEF (tx + SPV proofs)  │ POST /submit · /lookup
            ▼                               ▼
┌──────────────────────────┐   ┌───────────────────────────────────────┐
│ OTHER USERS / YOUR SERVER │   │ OVERLAY (e.g. the BSV-21 token kit)    │
│ verify SPV, internalize,  │   │ validates and indexes the transactions │
│ spend immediately (0-conf)│   │ of one protocol: the source of truth   │
└──────────────────────────┘   └───────────────────────────────────────┘
            │                               │ SPV block headers
            ▼                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ BSV BLOCKCHAIN — Arcade (broadcast, status, merkle proofs, headers),  │
│ miners, block inclusion                                               │
└──────────────────────────────────────────────────────────────────────┘
```

**Ground rules**
- The user's private keys **never** leave the wallet. Your app asks the wallet, over BRC-100, to derive keys, sign, create and internalize transactions. The user approves in the wallet's own UI.
- Transactions travel between parties as **AtomicBEEF**: the transaction plus everything needed to verify it with SPV. The recipient never has to trust the sender or a server.
- Rules the miners do not enforce — token balances, for example — are enforced by an **overlay** that indexes only valid transactions.

---

## 2. Packages, Versions and Official Repositories

### Install

```bash
# Browser app (talks to the user's wallet)
npm install @bsv/sdk

# Server (own wallet, overlays, authenticated APIs)
npm install @bsv/sdk @bsv/wallet-toolbox @bsv/overlay @bsv/overlay-express @bsv/auth-express-middleware knex better-sqlite3 express

# Pay-per-request APIs (HTTP 402): pick the protocol you need (§10)
npm install @bsv/payment-express-middleware   # BRC-105 (with auth-express-middleware)
npm install @bsv/402-pay                      # BRC-121 (client and server)
```

Node.js **22 or newer**.

### Versions this guide was verified with

| Package | Version | What it is |
|---|---|---|
| `@bsv/sdk` | 3.2.1 | Transactions, scripts, keys, BEEF/SPV, `WalletClient`, `AuthFetch`, overlay tools |
| `@bsv/wallet-toolbox` | 2.14.9 | Full BRC-100 wallet: storage (SQLite/MySQL), services, monitor. BSV Desktop is built on it |
| `@bsv/overlay` | 2.6.4 | Overlay engine (topic managers, lookup services, storage) |
| `@bsv/overlay-express` | 2.7.4 | Ready-made HTTP overlay server around the engine |
| `@bsv/auth-express-middleware` | 2.2.9 | BRC-103/104 mutual authentication for Express |
| `@bsv/payment-express-middleware` | 2.1.9 | BRC-105 pay-per-request (HTTP 402) for authenticated APIs |
| `@bsv/402-pay` | 0.3.3 | BRC-121 Simple 402 Payments: server middleware and client |
| `@bsv/message-box-client` | 2.6.0 | MessageBox (store-and-forward messages) and PeerPay |
| `@bsv/templates` | 2.0.0 | Extra script templates |

> **Watch out for duplicate SDK copies.** `wallet-toolbox` is CommonJS and loads the CJS build of `@bsv/sdk`. If your own code imports the ESM build in the same process, SDK classes exist twice and you get errors such as `script[serializedBytes] is not a function`. In tests, alias `@bsv/sdk` to one build (see `vitest.config.ts` in Appendix A). Browser apps and pure-ESM servers are not affected.

### Official repositories and documentation

| Component | Link | Notes |
|---|---|---|
| **TypeScript stack (monorepo)** | <https://github.com/bsv-blockchain/ts-stack> | Home of the SDK, wallet-toolbox, overlays, messaging, middleware. The old `ts-sdk` and `wallet-toolbox` repos are superseded by it |
| ts-stack documentation | <https://bsv-blockchain.github.io/ts-stack/> | API docs and guides |
| SDK package | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk> | |
| wallet-toolbox package | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox> | |
| wallet-toolbox examples | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox-examples> | |
| Overlay engine / overlay-express | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay> · <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay-express> | |
| MessageBox client | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client> | |
| Auth middleware | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth-express-middleware> | |
| Payment middleware (BRC-105) / 402-pay (BRC-121) | <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/payment-express-middleware> · <https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/402-pay> | |
| **BSV Desktop** | <https://github.com/bsv-blockchain/bsv-desktop> · [releases](https://github.com/bsv-blockchain/bsv-desktop/releases) | Reference BRC-100 desktop wallet |
| **BRC standards** | <https://github.com/bsv-blockchain/BRCs> · <https://brc.dev> | All specifications cited here |
| **BSV Skills Center** | <https://docs.bsvblockchain.org> | Conceptual docs and tutorials |
| **Arcade** | <https://github.com/bsv-blockchain/arcade> | Broadcast manager; public instance at `https://arcade-v2-us-1.bsvblockchain.tech` |
| go-chaintracks | <https://github.com/bsv-blockchain/go-chaintracks> | Block-header service exposed by Arcade at `/chaintracks/v2` |
| 1Sat Ordinals docs | <https://docs.1satordinals.com> · [BSV-21](https://docs.1satordinals.com/fungible-tokens/bsv-21) · [llms.txt](https://docs.1satordinals.com/llms.txt) | Inscription and BSV-21 specifications |
| 1sat-stack | <https://github.com/b-open-io/1sat-stack> | 1Sat indexer/overlay (Go) |
| 1Sat libraries | `@1sat/actions`, [`1sat-wallet-toolbox`](https://github.com/b-open-io/1sat-wallet-toolbox) | Alternative BSV-21/ordinals tooling from the 1Sat ecosystem |
| bOpen agents | <https://bopen.ai/agents> | AI agents and Claude Code plugins for BRC-100 / 1Sat (`/plugin install 1sat@b-open-io`) |
| **BananaBlocks** | <https://bananablocks.com> · [tokens](https://bananablocks.com/tokens) · [API](https://bananablocks.com/api/docs) | Explorer (GorillaPool) with BSV-21 token pages |
| WhatsOnChain API | <https://developers.whatsonchain.com> | Public explorer API |
| OrdFS | <https://docs.1satordinals.com/content-and-resolution/ordfs> | Serves inscription content at `https://ordfs.network/<origin>` |

---

## 3. Core Concepts: UTXO, SPV, BEEF and 0-Conf

### 3.1 The UTXO model

The BSV Blockchain uses unspent transaction outputs, not accounts. A transaction consumes existing outputs as inputs and creates new ones:

```
UTXO A (5000 sats) ──┐
                      ├──▶ Output 0: payment (3000 sats) → recipient
UTXO B (2000 sats) ──┘    Output 1: change  (3800 sats) → yourself
                           Fee:      200 sats            → miners
```

Every UTXO is independent, so transactions are validated in parallel and there is no global state to contend over.

### 3.2 SPV — Simplified Payment Verification (BRC-9, BRC-67)

To check that a transaction is valid you need the transaction, the transactions it spends, and a merkle proof (BUMP, BRC-74) linking a confirmed ancestor to a block header. Block headers are 80 bytes each; any header service can supply them (WhatsOnChain, or Arcade's chaintracks — see §20).

### 3.3 BEEF and AtomicBEEF (BRC-62, BRC-95)

**BEEF** packs a transaction with its unconfirmed ancestors and the merkle proofs of the confirmed ones, so the receiver can verify everything offline. **AtomicBEEF** is a BEEF that is about exactly one subject transaction; it is what `createAction` returns and what `internalizeAction` expects.

```typescript
import { Transaction } from '@bsv/sdk'

const result = await wallet.createAction({ /* … */ })
const tx = Transaction.fromAtomicBEEF(result.tx!) // subject tx, with sourceTransaction links
console.log(tx.id('hex'), tx.outputs.length)
const ok = await tx.verify(chainTracker)          // full SPV check (scripts + proofs)
```

**Extended Format (EF, BRC-30)** is a raw transaction that also carries each input's source satoshis and locking script; broadcasters such as Arcade accept it.

### 3.4 0-conf — settle without waiting for a block

On the BSV Blockchain a transaction is final in practice as soon as it is accepted by the network: nodes apply the first-seen rule and reject later double spends, and the recipient verifies the AtomicBEEF with SPV. A recipient that verifies and internalizes a payment can **spend it immediately**, before it is mined (✅ automated test: §9.4). Block inclusion follows later and the wallet picks up the merkle proof on its own.

---

## 4. Connecting to the Wallet (BRC-100)

**BRC-100** is the vendor-neutral wallet-to-application interface. **BSV Desktop** (<https://github.com/bsv-blockchain/bsv-desktop>) is the reference desktop wallet: it holds the keys, shows approval prompts, and serves the BRC-100 interface locally (HTTP on port **3321**, HTTPS on **2121**).

```typescript
import { WalletClient } from '@bsv/sdk'

// Browser app: BSV Desktop identifies your app by the page origin.
const wallet = new WalletClient('auto')

// Node / CLI tools: pass your app's domain as the originator (2nd argument).
// const wallet = new WalletClient('auto', 'myapp.example.com')

await wallet.waitForAuthentication({})                  // resolves once the wallet is unlocked
const { network } = await wallet.getNetwork({})          // 'mainnet' | 'testnet'
const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
```

> The second constructor argument is the **originator** (your app's domain), not a permission mode. `new WalletClient('auto', 'simple')` from older examples is wrong.

**Good to know about BSV Desktop**
- **Apps** is a directory of web apps. Apps are ordinary web pages opened in the browser that talk to the wallet over BRC-100; nothing is installed into the wallet. To list your app in the directory, publish it with `metanet-apps`, and declare grouped permissions in your `manifest.json`.
- **Permissions:** the wallet asks per app for protocol use (security level ≥ 1), spending and certificates. By default it does **not** ask for basket insertion, listing or removal (Settings → Advanced → *Basket Permissions*). This is why an app's "Baskets" access section can look empty even though the app keeps outputs in a basket (§8).
- **No token UI:** the wallet stores token outputs in baskets but does not interpret BSV-21. Your app shows balances (§19).

---

## 5. Identity Keys and Key Derivation

### 5.1 Identity key

The identity key is a compressed secp256k1 public key (66 hex characters). It is stable for a wallet and safe to share; others use it to pay you and to derive keys for you.

```typescript
const { publicKey } = await wallet.getPublicKey({ identityKey: true })
```

> **Never lock funds, tokens or NFTs directly to `P2PKH(identityKey)`.** BRC-100 wallets only sign with *derived* keys (BRC-42/43); there is no call that signs with the root identity key, so such an output can never be spent from the wallet.

### 5.2 Derived keys (BRC-42 and BRC-43)

Every key the wallet uses for an app is derived from four inputs:

| Input | Meaning |
|---|---|
| `protocolID: [securityLevel, name]` | `0` = no permission needed (avoid for keys that control value), `1` = one grant per app, `2` = one grant per app and counterparty. Names are letters, digits and spaces, at least 5 characters (BRC-43) |
| `keyID` | Any string identifying the key within the protocol (an index, an invoice number…) |
| `counterparty` | `'self'`, `'anyone'`, or the other party's identity key |
| `forSelf` | When deriving a counterparty-linked public key: `true` = my key, `false` = the counterparty's key |

```typescript
// The key a payer derives for the payee…
const { publicKey: forPayee } = await payerWallet.getPublicKey({
  protocolID: [2, '3241645161d8'], keyID: 'invoice-42', counterparty: payeeIdentityKey, forSelf: false
})
// …equals the key the payee derives for itself. ECDH makes the shared secret symmetric.
const { publicKey: mine } = await payeeWallet.getPublicKey({
  protocolID: [2, '3241645161d8'], keyID: 'invoice-42', counterparty: payerIdentityKey, forSelf: true
})
```

**Two derivation styles used in this guide**

| Style | Counterparty | Who can compute the address | Used for |
|---|---|---|---|
| Private (BRC-29) | the other party | only the two parties | payments (§9), airdrops (§10) |
| Public (`'anyone'`) | `'anyone'` | anyone who knows the identity key | token receive addresses (§17), NFT deliveries (§13) |

With `'anyone'`, the sender derives the recipient's key with the SDK alone, and the recipient's wallet derives the matching private key:

```typescript
import { KeyDeriver } from '@bsv/sdk'
const pub = new KeyDeriver('anyone').derivePublicKey([1, 'bsv21 token'], '0', recipientIdentityKey)
// recipient side: wallet.getPublicKey({ protocolID: [1,'bsv21 token'], keyID: '0', counterparty: 'anyone', forSelf: true })
```

(✅ automated test: the two derivations match.) The cost: anyone who knows the identity key can link those addresses to it.

---

## 6. Creating Transactions: createAction

`createAction` is the main call: the wallet selects inputs, computes the fee and change, signs, builds the AtomicBEEF and broadcasts.

### 6.1 Pay to a locking script

```typescript
import { WalletClient, P2PKH, PublicKey, Transaction } from '@bsv/sdk'

const wallet = new WalletClient('auto')
const lockingScript = new P2PKH().lock(PublicKey.fromString(recipientDerivedKeyHex).toAddress()).toHex()

const result = await wallet.createAction({
  description: 'Pay for order 1234',            // 5–50 characters, shown in the wallet
  outputs: [{ lockingScript, satoshis: 5000, outputDescription: 'Order 1234' }],
  options: {
    randomizeOutputs: false,      // keep your outputs at the indexes you gave them
    acceptDelayedBroadcast: false // broadcast before returning
  }
})
// result.txid: string · result.tx: AtomicBEEF (number[])
const tx = Transaction.fromAtomicBEEF(result.tx!)
const outputIndex = tx.outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
```

### 6.2 Useful options

| Option | Effect |
|---|---|
| `randomizeOutputs: false` | Your outputs keep their order, followed by change. Needed whenever you rely on an output index (token deploys, NFT origins, payment indexes) |
| `acceptDelayedBroadcast: false` | The call returns after broadcasting, so you can hand the AtomicBEEF on at once |
| `noSend: true` | Sign but do not broadcast; whoever internalizes it will broadcast it (§9.5) |
| `signAndProcess: false` | Always return a `signableTransaction` for you to complete with `signAction` |

### 6.3 Spending outputs your app controls (createAction + signAction)

For outputs with custom scripts — tokens, NFTs — the app supplies the inputs and the unlocking scripts; the wallet still adds funding inputs and change.

```typescript
const created = await wallet.createAction({
  description: 'Move my token',
  inputBEEF,                                         // BEEF containing the source transactions
  inputs: [{ outpoint: 'txid.0', unlockingScriptLength: 108, inputDescription: 'token input' }],
  outputs: [{ lockingScript: newLockingScriptHex, satoshis: 1, outputDescription: 'token output' }],
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
})
const signable = created.signableTransaction!       // { tx: AtomicBEEF, reference }
const tx = Transaction.fromAtomicBEEF(signable.tx)
const unlockingScript = await signWalletP2pkhInput(wallet, tx, 0, { protocolID, keyID }) // Appendix A, client/signer.ts
await wallet.signAction({ reference: signable.reference, spends: { 0: { unlockingScript: unlockingScript.toHex() } } })
```

`signWalletP2pkhInput` computes the BIP-143 sighash over the **full** source locking script and asks the wallet for a signature with `createSignature({ hashToDirectlySign })`: the private key never leaves the wallet. `unlockingScriptLength: 108` covers a P2PKH unlock (signature + public key).

---

## 7. Receiving Transactions: internalizeAction

`internalizeAction` gives the wallet a received AtomicBEEF. The wallet verifies it with SPV, broadcasts it if the network does not have it yet, and records the outputs you name. Those outputs are spendable at once.

There are two protocols:

| Protocol | For | Where the output goes | Requirements |
|---|---|---|---|
| `'wallet payment'` | Plain satoshis paid to you (BRC-29) | `default` basket; counts towards the wallet balance; spent automatically by future `createAction` calls | The output must be exactly `P2PKH(derived key)` for the given prefix, suffix and sender |
| `'basket insertion'` | Anything your app manages: tokens, NFTs, app records | A named basket (never `default`); not part of the balance; only spent when your app names it as an input | `basket`, optional `customInstructions` and `tags` |

```typescript
// Satoshis
await wallet.internalizeAction({
  tx: atomicBeef,
  outputs: [{
    outputIndex,
    protocol: 'wallet payment',
    paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
  }],
  description: 'Payment from Alice'
})

// An app-managed output (a token)
await wallet.internalizeAction({
  tx: atomicBeef,
  outputs: [{
    outputIndex,
    protocol: 'basket insertion',
    insertionRemittance: {
      basket: 'bsv21',
      customInstructions: JSON.stringify({ protocolID: [1, 'bsv21 token'], keyID: '3', counterparty: 'anyone' }),
      tags: ['bsv21', `id:${tokenId}`, `amt:${amount}`]
    }
  }],
  description: 'Receive tokens'
})
```

> **Tokens and NFTs must never go into `default`.** The wallet spends `default` outputs as fee money; a 1-sat token or NFT spent as a fee is destroyed. `'wallet payment'` refuses anything that is not plain P2PKH, and `'basket insertion'` refuses the `default` basket, so the wallet protects you as long as you pick the right protocol.

**Always compute `outputIndex`; never hard-code `0`.** Change outputs can occupy any index. Find yours by its locking script:

```typescript
const tx = Transaction.fromAtomicBEEF(atomicBeef)
const outputIndex = tx.outputs.findIndex(o => o.lockingScript.toHex() === expectedLockingScriptHex)
```

---

## 8. Output Baskets, customInstructions and Tags

A **basket** (BRC-46) is a named set of outputs your app tracks inside the user's wallet: tokens, NFTs, app state. Baskets travel with the wallet's storage and backups.

| Field | Purpose |
|---|---|
| `basket` | Name, e.g. `bsv21`, `ordinals`. The `default` basket is the wallet's own money |
| `customInstructions` | Free text stored with the output and returned to your app. Store whatever is needed to spend it later, e.g. `{"protocolID":[1,"bsv21 token"],"keyID":"3","counterparty":"anyone"}` |
| `tags` | Strings for filtering, e.g. `id:<tokenId>`, `amt:100` |

```typescript
// Create an output straight into a basket
await wallet.createAction({
  description: 'Mint',
  outputs: [{
    lockingScript, satoshis: 1, outputDescription: 'token',
    basket: 'bsv21', customInstructions: JSON.stringify(instructions), tags: ['bsv21']
  }],
  options: { randomizeOutputs: false }
})

// Read a basket, with the source transactions as BEEF
const { outputs, BEEF } = await wallet.listOutputs({
  basket: 'bsv21',
  tags: [`id:${tokenId}`],
  include: 'entire transactions',   // or 'locking scripts'
  includeCustomInstructions: true,
  includeTags: true,
  limit: 1000
})
// outputs[i]: { outpoint: 'txid.vout', satoshis, spendable, customInstructions?, tags? }

// Drop an output from a basket (does not spend it)
await wallet.relinquishOutput({ basket: 'bsv21', output: 'txid.0' })
```

**Notes**
- A basket does **not** validate anything. Any app can insert any output, including a fake token. Validity comes from an overlay (§18).
- The BEEF returned by `listOutputs` may omit unconfirmed ancestors. When you need a complete BEEF for spending, get it from the overlay or from Arcade (§17.6, §20).
- ✅ Mainnet: after deploying and transferring BSV-21 tokens from BSV Desktop, the `bsv21` basket held exactly the UTXOs the overlay reported as unspent.

---

## 9. Instant P2P Payments with BRC-29

**BRC-29** pays an identity key without address reuse: the sender picks a random `derivationPrefix` and `derivationSuffix`, derives the recipient's key with `counterparty = recipient`, and pays `P2PKH` of it. The recipient derives the same key with `counterparty = sender` and `forSelf: true`.

### 9.1 Sender

From `client/payments.ts` (Appendix A):

```typescript
import { P2PKH, PublicKey, Random, Transaction, Utils } from '@bsv/sdk'

export const BRC29_PROTOCOL: [2, string] = [2, '3241645161d8']

export async function createBrc29Payment (wallet, recipientIdentityKey: string, satoshis: number) {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey, // the OTHER party
    forSelf: false                      // derive the recipient's key
  })
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const res = await wallet.createAction({
    description: 'BRC-29 payment',
    outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 payment' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const outputIndex = Transaction.fromAtomicBEEF(res.tx!).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true })
  return { tx: Array.from(res.tx!), txid: res.txid!, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey }
}
```

### 9.2 Recipient: verify, then internalize

```typescript
export async function acceptBrc29Payment (wallet, p, chainTracker?) {
  const tx = Transaction.fromAtomicBEEF(p.tx)
  if (chainTracker && !(await tx.verify(chainTracker))) throw new Error('payment failed SPV verification')
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
    counterparty: p.senderIdentityKey, // the OTHER party
    forSelf: true                      // my own key
  })
  const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const out = tx.outputs[p.outputIndex]
  if (out?.lockingScript.toHex() !== expected) throw new Error('payment output is not locked to our key')
  if (out.satoshis !== p.satoshis) throw new Error('amount mismatch')
  await wallet.internalizeAction({
    tx: p.tx,
    outputs: [{ outputIndex: p.outputIndex, protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: p.derivationPrefix, derivationSuffix: p.derivationSuffix, senderIdentityKey: p.senderIdentityKey } }],
    description: 'Payment received'
  })
}
```

`chainTracker` can be `new ArcadeChainTracker()` (§20.3) or `new WhatsOnChain('main')` from the SDK. `internalizeAction` checks SPV again inside the wallet.

### 9.3 The two classic bugs

| Bug | Symptom | Fix |
|---|---|---|
| Recipient derives with `counterparty: 'self'` | `Script mismatch` on internalize | Always use the **other party's** identity key: the recipient uses the sender's key with `forSelf: true`, the sender uses the recipient's key with `forSelf: false` |
| `outputIndex: 0` hard-coded | Fails whenever change lands at index 0 | Use `randomizeOutputs: false` **and** find the index by locking script |

### 9.4 Receive without waiting for a block ✅ automated test

The kit's test runs the full flow with **no block mined**:
1. Alice pays Bob 50,000 sats.
2. Bob verifies SPV and internalizes the payment.
3. Bob immediately pays Carol 10,000 sats **from those unconfirmed sats** (the test asserts the new transaction spends Alice's output).
4. Carol verifies and internalizes.

Neither transaction is mined at any point. It also checks the failure cases: Mallory cannot accept a payment meant for Bob, and Bob cannot accept a payment claiming more than it is worth.

```
Sender (Alice)                   Transport                    Recipient (Bob)
  createAction → AtomicBEEF ─────▶ WebSocket / MessageBox / ──▶ verify SPV (ChainTracker)
  (broadcast to Arcade)            HTTP claim                   internalizeAction
                                                                spendable immediately
```

### 9.5 Transport patterns

| Pattern | When | How |
|---|---|---|
| **WebSocket relay** | Both online (chat, games) | Your server relays `{ tx, outputIndex, derivationPrefix, derivationSuffix, senderIdentityKey }` |
| **MessageBox** (🧩) | Recipient may be offline | `@bsv/message-box-client`: `new MessageBoxClient({ walletClient })`, `sendMessage({ recipient, messageBox, body })`, `listMessages({ messageBox })`, `acknowledgeMessage({ messageIds })`. For satoshi payments, `PeerPayClient({ walletClient })` wraps all of it: `sendPayment({ recipient, amount })`, `listIncomingPayments()`, `acceptPayment(p)`. The default host is `https://message-box-us-1.bsvb.tech` |
| **Claim from your server** | Rewards, airdrops | The server creates the payment, the client fetches and internalizes it (§10) |

`noSend: true` lets the sender skip broadcasting: the recipient's `internalizeAction` broadcasts it. That is useful when the sender is offline-first. Settlement is the same.

---

## 10. Airdrops and Pay-per-Request APIs (HTTP 402)

✅ automated test

Both flows rely on two things. **Mutual authentication** tells the server who is calling. **BRC-29 payments**, verified and internalized with the server wallet, settle at once.

### 10.1 Airdrops (server pays the user)

An airdrop is a BRC-29 payment from your server to a user. The server **must** know who is calling, and **the server, not the client, decides the amount**; otherwise anyone can drain the treasury. Use BRC-103/104 mutual authentication: the client's wallet signs every request, and the middleware exposes the verified caller as `req.auth.identityKey`.

**Server** (`examples/airdropServer.ts`):

```typescript
import express from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import { createBrc29Payment } from '../client/payments'

export function createAirdropApp (treasury, opts: { satoshis: number, claimed?: Set<string> }) {
  const claimed = opts.claimed ?? new Set<string>() // use a database in production
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet: treasury }))  // BRC-103/104

  app.post('/airdrop/claim', async (req, res) => {
    const identityKey = (req as AuthRequest).auth?.identityKey
    if (identityKey === undefined || identityKey === 'unknown') return res.status(401).json({ error: 'auth required' })
    if (claimed.has(identityKey)) return res.status(409).json({ error: 'already claimed' })
    claimed.add(identityKey) // reserve first, so parallel requests cannot double-claim
    try {
      res.json(await createBrc29Payment(treasury, identityKey, opts.satoshis))
    } catch (e) {
      claimed.delete(identityKey)
      res.status(500).json({ error: String(e) })
    }
  })
  return app
}
```

**Client:**

```typescript
import { AuthFetch, WalletClient } from '@bsv/sdk'
import { acceptBrc29Payment } from './client/payments'

const wallet = new WalletClient('auto')
const res = await new AuthFetch(wallet).fetch('https://api.example.com/airdrop/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
})
if (res.ok) await acceptBrc29Payment(wallet, await res.json())
```

The test checks that an unauthenticated request is refused, that an authenticated caller is paid the server's amount, and that a second claim returns 409. In production also add rate limiting, keep the claim list in a database, and never treat `identityKey === 'unknown'` as authenticated.

### 10.2 Pay-per-request APIs: which protocol?

Charging per HTTP request means the server answers **402 Payment Required** with a price, the client pays, and the request is retried with proof of payment. Do not invent your own headers. There are two official protocols, each with a server middleware and a client that **pays automatically**:

| | **BRC-105** — HTTP Service Monetization Framework | **BRC-121** — Simple 402 Payments |
|---|---|---|
| Caller identity | Mutually authenticated (BRC-103/104) — the server knows the payer's identity key | No handshake — anyone can pay |
| Server | `@bsv/auth-express-middleware` + `@bsv/payment-express-middleware` | `createPaymentMiddleware` from `@bsv/402-pay/server` |
| Client | `new AuthFetch(wallet).fetch(url)` (in `@bsv/sdk`) | `create402Fetch({ wallet })(url)` from `@bsv/402-pay/client` |
| Challenge headers | `x-bsv-payment-version`, `x-bsv-payment-satoshis-required`, `x-bsv-payment-derivation-prefix` | `x-bsv-sats`, `x-bsv-server` |
| Proof headers | `x-bsv-payment` = `{ derivationPrefix, derivationSuffix, transaction }` | `x-bsv-beef`, `x-bsv-sender`, `x-bsv-nonce`, `x-bsv-time`, `x-bsv-vout` |
| Replay protection | Server-issued derivation nonce + atomic txid claim (`409` on replay) | 30-second timestamp window + atomic txid claim (fresh `402` on replay) |
| Good for | Accounts, per-user metering, APIs that already authenticate | Public content, paywalled articles, open APIs |

The two are **not interchangeable**: their headers and client contracts differ. In both, output 0 of the client's transaction is a BRC-29 payment to the server; the server wallet internalizes it, so the satoshis are spendable by the merchant **immediately**.

### 10.3 BRC-105 server and client ✅ automated test

`examples/payPerRequest.ts`:

```typescript
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware, type PaymentRequest } from '@bsv/payment-express-middleware'

export function createBrc105App (merchant, prices: Record<string, number>) {
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet: merchant }))   // 1) who is calling (BRC-103/104)
  app.use(createPaymentMiddleware({                      // 2) have they paid (BRC-105)
    wallet: merchant,
    calculateRequestPrice: req => prices[req.path] ?? 0  // 0 = free
    // replayStore: { claim: async txid => db.insertIfAbsent(txid) }  ← required with >1 process
  }))
  app.get('/premium', (req: PaymentRequest, res) => {
    res.json({ data: 'premium data', receipt: req.payment }) // { accepted, satoshisPaid, txid, tx }
  })
  return app
}
```

```typescript
import { AuthFetch, WalletClient } from '@bsv/sdk'

const res = await new AuthFetch(new WalletClient('auto')).fetch('https://api.example.com/premium')
// 402 → AuthFetch builds the BRC-29 payment with the wallet → retries with x-bsv-payment → 200
```

**What the test proves:** a free route returns 200 with `satoshisPaid: 0`; `/premium` answers 402, `AuthFetch` pays 500 sats automatically, and the merchant's spendable balance grows by exactly 500; resending the same payment header returns **409** (`ERR_PAYMENT_REPLAYED`).

Other errors you can get: `400 ERR_INVALID_DERIVATION_PREFIX` (the server did not create that prefix), `400 ERR_INVALID_PAYMENT` (bad BEEF, or output 0 below the price) and `503` (replay store unavailable).

### 10.4 BRC-121 server and client ✅ automated test

```typescript
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'

export function createBrc121App (merchant, satoshis: number) {
  const app = express()
  app.use('/articles/:slug', createPaymentMiddleware({
    wallet: merchant,
    calculatePrice: () => satoshis      // return undefined to make a path free
    // replayStore: sharedAtomicStore    ← required with >1 process
  }))
  app.get('/articles/:slug', (req, res) => { res.json({ article: req.params.slug, payment: (req as any).payment }) })
  return app
}
```

```typescript
import { create402Fetch, constructPaymentHeaders } from '@bsv/402-pay/client'

const fetch402 = create402Fetch({ wallet: withHostOriginator(wallet) })   // see the note below
const res = await fetch402('https://example.com/articles/hello')        // 402 → pay → 200

// Or build the headers yourself (service workers, custom fetch):
const headers = await constructPaymentHeaders(withHostOriginator(wallet), url, 100, serverIdentityKey)
```

**What the test proves:**
- an unpaid request gets `402` with `x-bsv-sats: 100` and `x-bsv-server: <merchant identity key>`;
- `create402Fetch` pays automatically and the merchant is credited 100 sats;
- sending the same payment headers twice gives `200`, then a fresh `402`.

> **Gotcha (`@bsv/402-pay` 0.3.3):** the client passes the request origin **with its scheme** (`https://example.com`) as the BRC-100 originator. wallet-toolbox wallets require a bare hostname and throw *"The originator parameter must be a canonical DNS hostname"*. Wrap the wallet with `withHostOriginator()` (`examples/payPerRequest.ts`), a small proxy that strips the scheme. This was tested with a wallet-toolbox wallet; with `WalletClient` + BSV Desktop it is untested, and the wrapper is harmless.

### 10.5 Production checklist for paid APIs
- **Replay store:** use a shared, durable, atomic replay store (insert-if-absent on the txid) when more than one process or replica serves paid routes. The in-memory default is per process and is lost on restart.
- **Pricing:** treat pricing as security-sensitive and deterministic. Never take the price from the request.
- **HTTPS:** serve over HTTPS. For browser clients, expose the `x-bsv-payment-*` (BRC-105) or `x-bsv-sats`/`x-bsv-server` (BRC-121) headers through CORS.
- **Limits:** rate-limit the paid routes, and monitor `409`/`503` rates.
- **Treasury:** the merchant wallet is a server wallet (§14). Its incoming payments are ordinary `default`-basket satoshis, spendable at once (§11).

---

## 11. Treasury Wallets and UTXO Pools

🧩 Pattern, using APIs exercised by the tests

A treasury is a server wallet (§14) holding UTXOs ready to pay out instantly.

```
Treasury wallet (wallet-toolbox, SQLite/MySQL)
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   N change UTXOs
  │ 25,000   │ │ 25,000   │ │ 25,000   │ │ 25,000   │   kept topped up
  └──────────┘ └──────────┘ └──────────┘ └──────────┘
        createAction picks inputs, change returns to the pool, spendable at 0-conf
```

- **Funding:** an admin pays the treasury with BRC-29 (§9) and the server runs `acceptBrc29Payment(treasuryWallet, payment)`.
- **Parallel payouts:** one big UTXO forces payouts to queue behind each other's change. Ask the wallet to keep many change outputs:

  ```typescript
  await setup.wallet.setWalletChangeParams(64, 25_000) // aim for 64 change UTXOs of ~25,000 sats
  ```

- **Chained payouts:** change from an unconfirmed payout is immediately reusable. A long chain of unconfirmed transactions works, but many independent UTXOs keep throughput high and keep failures independent.
- **Broadcasting:** use Arcade as the primary broadcaster for clear status and merkle proofs (§14.2, §20).
- **Balance:**

  ```typescript
  async function poolBalance (wallet) {
    let total = 0, count = 0
    for (let offset = 0; ; offset += 100) {
      const { outputs, totalOutputs } = await wallet.listOutputs({ basket: 'default', limit: 100, offset })
      for (const o of outputs) if (o.spendable) { total += o.satoshis; count++ }
      if (outputs.length === 0 || offset + outputs.length >= totalOutputs) break
    }
    return { spendableSatoshis: total, spendableOutputs: count }
  }
  ```

---

## 12. On-Chain Data with OP_RETURN

`OP_FALSE OP_RETURN <data>` creates a provably unspendable, 0-satoshi output. It is stored on chain for good and costs only the fee.

```typescript
import { OP, Script, Transaction, Utils, WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto')
const lockingScript = new Script()
  .writeOpCode(OP.OP_FALSE)
  .writeOpCode(OP.OP_RETURN)
  .writeBin(Utils.toArray('Hello BSV Blockchain', 'utf8')) // add more writeBin() calls for more fields
  .toHex()

const res = await wallet.createAction({
  description: 'OP_RETURN data',
  outputs: [{ lockingScript, satoshis: 0, outputDescription: 'data' }]
})
console.log(`https://whatsonchain.com/tx/${res.txid}`)
```

`writeBin` picks the minimal push encoding, up to `OP_PUSHDATA4`. Large payloads are allowed, subject to miner and broadcaster policy (Arcade reports its policy at `/health`).

---

## 13. 1Sat Ordinals NFTs

✅ automated test

A 1Sat Ordinal is a **1-satoshi output carrying an inscription**. The inscription is written once, at mint; afterwards the NFT moves by spending that satoshi into another 1-sat output. Its id, the **origin**, is the mint outpoint `txid_vout`. Spec: <https://docs.1satordinals.com>.

### 13.1 Canonical inscription format

```
OP_FALSE OP_IF  "ord"  OP_1  <content-type>  OP_0  <data>  OP_ENDIF   ← envelope (never executed)
OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG                     ← owner (P2PKH)
```

- The content-type tag is **`OP_1` (byte `0x51`)**. The non-minimal form `01 01` is rejected by the 1Sat BSV-21 indexer, so always use `OP_1`.
- Use the SDK's `Script.writeBin`, which handles any size up to `OP_PUSHDATA4`. A hand-written push helper limited to `OP_PUSHDATA2` breaks on files over 64 KB.
- Lock to a **derived key**, never to the identity key (§5.1).

### 13.2 OrdinalKit (Appendix A, `client/ordinals.ts`)

```typescript
import { WalletClient } from '@bsv/sdk'
import { OrdinalKit } from './client/ordinals'

const kit = new OrdinalKit(new WalletClient('auto'))

// Mint: output 0 (randomizeOutputs: false), into the 'ordinals' basket, key [1,'one sat ordinals'] + random keyID
const { txid, origin } = await kit.mint('image/svg+xml', svgString)   // origin = `${txid}_0`

// List what I own
const nfts = await kit.list()   // [{ outpoint, origin, contentType, data?, … }]

// Transfer: NFT input at index 0 → 1-sat output at index 0, locked to a key derived for the recipient
const delivery = await kit.transfer(nfts[0].outpoint, recipientIdentityKey)
// send `delivery` ({ tx, txid, outputIndex, keyID, senderIdentityKey, origin, contentType }) by MessageBox/WebSocket/HTTP

// Recipient: checks the output is a 1-sat P2PKH to its key, then internalizes it ('basket insertion')
await new OrdinalKit(recipientWallet).receive(delivery)
```

**Why input 0 → output 0?** Ordinal theory tracks satoshis first-in, first-out. With the NFT as input 0 and a 1-sat output at index 0, the NFT's satoshi lands in that output. `transfer()` checks that the wallet placed the NFT at input 0 and the 1-sat output at output 0, and aborts otherwise, so the ordinal is never sent to the wrong output or spent as fee.

The test mints a text inscription, transfers it to another identity key, checks the input/output placement, checks that the wrong recipient cannot `receive()` it, and that the new owner can transfer it back with the origin preserved.

### 13.3 Viewing NFTs
- **Content:** `https://ordfs.network/<origin>`, for example `https://ordfs.network/<txid>_0` (see the [OrdFS docs](https://docs.1satordinals.com/content-and-resolution/ordfs)).
- **Explorers:** BananaBlocks (<https://bananablocks.com>) and WhatsOnChain.
- **Metadata** (name, collection) can be attached with MAP after the inscription; see [Adding metadata](https://docs.1satordinals.com/adding-metadata). Large files: [Handling large files](https://docs.1satordinals.com/handling-large-files).

---

## 14. Server Wallets with wallet-toolbox

### 14.1 Quick setup (SQLite or MySQL)

`Setup.getEnv()` expects a specific `.env` (`MY_MAIN_IDENTITY`, `MY_MAIN_IDENTITY2`, `MAIN_TAAL_API_KEY`, …) and throws without it. For an app server, build the environment object yourself:

```typescript
import { PrivateKey } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'

const rootKey = PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY!)   // 64 hex chars; keep it secret
const identityKey = rootKey.toPublicKey().toString()
const env = { chain: 'main' as const, identityKey, identityKey2: identityKey, taalApiKey: '', devKeys: {}, mySQLConnection: '{}' }

const setup = await Setup.createWalletSQLite({
  env, rootKeyHex: rootKey.toHex(), filePath: './server-wallet.sqlite', databaseName: 'server_wallet'
})
// MySQL: Setup.createWalletMySQL({ env: { ...env, mySQLConnection: JSON.stringify({ host, port, user, password, database }) }, rootKeyHex, databaseName })

const wallet = setup.wallet // a full BRC-100 WalletInterface: use it exactly like WalletClient
console.log('Server identity key:', setup.identityKey)
```

(Verified: this constructs a working wallet.) With wallet-toolbox 2.14.x on Node, block headers already come from **Arcade's chaintracks** (`GoChaintracksServiceClient` → `https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v2`).

> The `WoCChaintracks` workaround from older versions of this guide is no longer needed. It was written because the previous default header service failed from VPS/Docker hosts.

### 14.2 Arcade as the primary broadcaster

`Setup` broadcasts through its default providers (GorillaPool, TAAL, Bitails, WhatsOnChain). To make Arcade primary, build the wallet with your own `Services`:

```typescript
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { Monitor, Services, Setup, StorageKnex, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox'

const chain = 'main'
const rootKey = PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY!)
const identityKey = rootKey.toPublicKey().toString()

const options = Services.createDefaultOptions(chain)
options.arcadeUrl = 'https://arcade-v2-us-1.bsvblockchain.tech'
const services = new Services(options)   // broadcast order: Arcade, GorillaPool, TAAL, Bitails, WhatsOnChain

const storage = new StorageKnex({ ...StorageKnex.createStorageBaseOptions(chain), knex: Setup.createSQLiteKnex('./server-wallet.sqlite') })
await storage.migrate('server-wallet', identityKey)
await storage.makeAvailable()
const manager = new WalletStorageManager(identityKey, storage)
await manager.makeAvailable()
manager.setServices(services)

const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(chain, manager, services))
monitor.addDefaultTasks()                      // tracks proofs, retries broadcasts
const wallet = new Wallet({ chain, keyDeriver: new CachedKeyDeriver(rootKey), storage: manager, services, monitor })
```

(Verified: this constructs a working wallet, with Arcade first among broadcasters and merkle-proof providers.) Run the monitor continuously in production (`monitor.startTasks()`).

---

## 15. BSV-21 Tokens: Concepts

**BSV-21** is the 1Sat fungible-token protocol. Each token output is a 1-sat inscription of content-type `application/bsv-20` with a JSON payload, followed by a normal P2PKH. Spec: <https://docs.1satordinals.com/fungible-tokens/bsv-21>.

```
00 63                          OP_FALSE OP_IF
03 6f7264                      "ord"
51                             OP_1  (content-type tag — canonical)
12 6170706c…2d3230             "application/bsv-20"
00                             OP_0
<push> {"p":"bsv-20","op":"transfer","id":"<txid>_<vout>","amt":"250"}
68                             OP_ENDIF
76 a9 14 <20-byte pkh> 88 ac   P2PKH owner
```

| Operation | JSON | Meaning |
|---|---|---|
| `deploy+mint` | `{"p":"bsv-20","op":"deploy+mint","sym":"KIT","amt":"1000000","dec":"2"}` | Creates the token and its entire supply. **Token id = this output's outpoint** `txid_vout` |
| `transfer` | `{"p":"bsv-20","op":"transfer","id":"<tokenId>","amt":"250"}` | Moves `amt` of the token |
| `burn` | `{"p":"bsv-20","op":"burn","id":"<tokenId>","amt":"100"}` | Destroys `amt` (it stays visible, carries no balance) |

**The three canonical rules** (outputs that break them are ignored by the 1Sat indexer, and by the kit):
1. The content-type tag is `OP_1` (`0x51`), not `01 01`.
2. **Every JSON value is a string**: `"amt":"250"`, `"dec":"2"`.
3. `id` uses an **underscore**: `<txid>_<vout>`.

`amt` is an integer in base units: with `dec: "2"`, `"amt":"1000000"` is 10,000.00 tokens.

### Why an overlay is required

Bitcoin Script does **not** enforce BSV-21. To miners a token output is just a P2PKH with some data, and anyone can broadcast a "transfer" of your token minted out of thin air. What makes a token output genuine is its **history**: every input of every transaction back to the deploy must itself be a genuine token output, and outputs must never exceed inputs. Checking that is the job of an **overlay**: it admits a transaction only if those rules hold and indexes the result. Treat the overlay as the source of truth for balances (§16, §18).

---

## 16. Running a Token Overlay

✅ Mainnet · ✅ automated test

The kit's overlay (Appendix A, `overlay/`) is a single Node process with one SQLite file: no MongoDB, no Docker.

```bash
npm install
npm run overlay          # http://localhost:8080  (topic tm_tokenkit, service ls_tokenkit)
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `OVERLAY_DB` | `./data/overlay.db` | SQLite file |
| `NETWORK` | `main` | `main` or `test` |
| `CHAINTRACKS_URL` | `https://arcade-v2-us-1.bsvblockchain.tech` | SPV block headers (Arcade go-chaintracks) |
| `CHAIN_TRACKER=woc` | – | Use WhatsOnChain for headers instead (`WOC_API_KEY` optional) |
| `TOKEN_WHITELIST` | empty = all tokens | Comma-separated token ids to index |
| `OVERLAY_PRIVATE_KEY` | generated into `./data/overlay.key` | Overlay node identity |

### 16.1 How it is built

```typescript
// overlay/server.ts (abridged)
const server = new OverlayExpress('bsv21kit', privateKeyHex, `localhost:${port}`)
server.configurePort(port)
server.configureNetwork('main')
server.configureChaintracks('https://arcade-v2-us-1.bsvblockchain.tech', { apiPrefix: '/chaintracks/v2', reorgStream: false })
await server.configureKnex({ client: 'better-sqlite3', connection: { filename: './data/overlay.db' }, useNullAsDefault: true })
server.configureEnableGASPSync(false)
server.configureEngineParams({ advertiser: noopAdvertiser })        // local node: no SHIP/SLAP advertising
server.configureTopicManager('tm_tokenkit', new Bsv21KitTopicManager())
server.configureLookupServiceWithKnex('ls_tokenkit', createBsv21KitLookupService)
await server.configureEngine(false)                                 // false = no SHIP/SLAP → no MongoDB needed
await server.start()
```

- **Names must be canonical (BRC-87):** topics match `^tm_[a-z]+(_[a-z]+)*$`, so no digits. The SDK's `TopicBroadcaster` rejects names like `tm_bsv21kit`; this kit uses `tm_tokenkit` / `ls_tokenkit`.
- **SPV on every submit:** the engine verifies each submitted BEEF against block headers. With the free WhatsOnChain API that means rate limits (`429`) on busy BEEFs; Arcade's chaintracks avoids this (§20).

### 16.2 Admission rules (topic manager)

`core/rules.ts` is a port of the 1Sat validated topic manager (`1sat-stack/pkg/bsv21/topic_validated.go`):

| Case | Decision |
|---|---|
| `deploy+mint` output | Admitted. Its id is its own outpoint, so it cannot impersonate another token |
| `transfer` / `burn` outputs of token X | Admitted only if the sum of X inputs **already admitted by this overlay** (`previousCoins`) covers the outputs |
| An input that looks like token X but was never admitted | The whole transaction is refused |
| Inputs of token X used to create outputs of token Y | Not admitted |
| Output sums beyond 2⁶⁴−1 | Not admitted |
| Token inputs consumed | Returned in `coinsToRetain`: marked spent and kept as history |

```typescript
export function identifyAdmissible (tx: Transaction, previousCoins: number[], opts = {}) {
  // 1) outputs: deploys admitted; transfers/burns summed per token id
  // 2) inputs: each token input must be in previousCoins, else throw UnknownTokenInputError
  // 3) per token: admit its outputs only if tokensIn >= outputs
}
```

### 16.3 Lookup queries (`ls_tokenkit`)

Standard `POST /lookup` with `{ "service": "ls_tokenkit", "query": … }`:

| Query | Returns |
|---|---|
| `{ "op": "identity", "identityKey": "03…", "tokenId"?: "…", "includeSpent"?: false }` | Token UTXOs at the identity's deterministic addresses (§17.1), scanning 20 unused indexes past the last used one |
| `{ "op": "utxos", "ownerPkhs": ["<hash160 hex>"], "tokenId"?: "…" }` | Unspent outputs at those addresses |
| `{ "op": "token", "tokenId": "<txid>_<vout>" }` | The deploy output |
| `{ "op": "tokens" }` | Known deploys |
| `{ "op": "outpoint", "txid": "…", "vout": 0 }` | One output |
| `{ "op": "history", "tokenId": "…", "limit": 100 }` | All outputs, spent ones included |

Each returned output carries a BEEF (the transaction and its ancestry) plus `context`: UTF-8 JSON with `tokenId`, `amt`, `ownerPkh`, `spent`, `spendingTxid`, `index`, `sym` and `dec`.

```bash
curl -s -X POST http://localhost:8080/lookup -H 'Content-Type: application/json' \
  -d '{"service":"ls_tokenkit","query":{"op":"identity","identityKey":"03…"}}'

curl -s -X POST http://localhost:8080/submit -H 'Content-Type: application/octet-stream' \
  -H 'X-Topics: ["tm_tokenkit"]' --data-binary @tx.beef
```

`/submit` returns a STEAK, e.g. `{"tm_tokenkit":{"outputsToAdmit":[0],"coinsToRetain":[1]}}`. A refused transaction comes back with empty lists, so check that your token outputs are listed in `outputsToAdmit` (the client does this for you).

### 16.4 Deploying publicly 🧩
- Put the overlay behind HTTPS and keep `data/` on persistent storage.
- CORS is open by default (`configureEdgePolicy` restricts origins).
- Set `TOKEN_WHITELIST` if you only want to index your own tokens.
- Back up `data/overlay.db`. If you lose it, transactions can be re-submitted in order from chain (§17.6).

---

## 17. Using Tokens from a BRC-100 App

✅ Mainnet · ✅ automated test

`TokenKit` (Appendix A, `client/token.ts`) works with any `WalletInterface`: `WalletClient` in the browser (BSV Desktop), or a wallet-toolbox `Wallet` on a server.

```typescript
import { WalletClient } from '@bsv/sdk'
import { OverlayClient } from './client/overlayApi'
import { TokenKit } from './client/token'

const kit = new TokenKit(new WalletClient('auto'), new OverlayClient('http://localhost:8080'))
```

### 17.1 Deterministic receive addresses

Token output #n of identity I is locked to `P2PKH(HASH160(BRC-42(I, protocol [1,'bsv21 token'], keyID "n", counterparty 'anyone')))`.
- A sender computes your address from your identity key alone, with no handshake.
- The overlay can list what an identity holds (`op: "identity"`).
- **You receive without being notified:** your app asks the overlay and finds new outputs.
- After losing local data, you recover by rescanning, like an HD wallet with a gap limit of 20.
- The cost: holdings are publicly linkable to the identity key. A private alternative is BRC-29-style derivation plus a MessageBox notice (not implemented in the kit).

The protocol uses security level 1, so BSV Desktop asks once per app. Do not use level 0 for keys that hold value: the wallet would never ask.

### 17.2 Mint (deploy)

```typescript
const { txid, tokenId } = await kit.deploy({ sym: 'GOLD', amt: 1_000_000n, dec: 2 })
// tokenId = `${txid}_0` (output 0 thanks to randomizeOutputs: false)
```

The deploy output goes straight into your `bsv21` basket with `customInstructions` (protocol, keyID, index), and the transaction is submitted to the overlay.

### 17.3 Balances and UTXOs

```typescript
const balances = await kit.balances()
// [{ tokenId, sym, dec, overlay: 1000000n, basket: 1000000n, utxos: 1 }]

const utxos = await kit.utxos(tokenId)
// [{ outpoint, amount, index, inOverlay: true, inBasket: true, … }]

const someoneElse = await kit.overlayUtxos('03…otherIdentityKey', tokenId) // anyone's holdings
```

`overlay` is what the overlay validates. `basket` is what your wallet stores. When they differ, run `sync()`.

### 17.4 Transfer, coin selection and change

```typescript
await kit.send(tokenId, 250n, recipientIdentityKey)   // to someone
await kit.send(tokenId, 10n, 'self')                  // to a fresh address of yours
```

What `send` does:
1. Takes the UTXOs in your basket **that the overlay validates and has not seen spent** (`spendable()`).
2. Selects largest-first until the amount is covered.
3. Builds the outputs: the recipient's next unused address (asked from the overlay), plus the change to your own next address, back in your basket.
4. Calls `createAction` with `inputBEEF` **from the overlay**, which holds each UTXO's complete ancestry.
5. Signs every token input through the wallet (`createSignature`); the wallet adds the fee inputs.
6. Calls `signAction`. The wallet broadcasts, and the kit submits the transaction to the overlay.

### 17.5 Merge

```typescript
await kit.merge(tokenId) // all validated UTXOs of the token → one output on a fresh address of yours
```

### 17.6 Sync, receiving and recovery

```typescript
const { inserted, relinquished, healed, unvalidated } = await kit.sync()
```

`sync()` runs four steps:
1. **Retry:** re-submits anything still queued for the overlay.
2. **Heal:** basket UTXOs the overlay has never seen are re-submitted from chain. The BEEF comes from Arcade (`GET /tx/:txid`: raw tx + merkle path, walking parents if unconfirmed) or else WhatsOnChain. Genuine ones get admitted; forgeries stay `unvalidated`.
3. **Insert:** UTXOs the overlay credits to you but your basket lacks are internalized with `'basket insertion'`. This is how **incoming tokens arrive**.
4. **Relinquish:** basket entries the overlay reports as spent are dropped.

The overlay accepts unconfirmed transactions (SPV on the BEEF), so a recipient sees tokens **seconds after they are sent, not after a block**.

**Recovery** (✅ automated test): a new wallet with the same root key and no local data runs `sync()` and gets back all its tokens from the overlay, and can spend them.

**Ordering** (outbox): the overlay never fetches missing parents. Transactions are submitted in order from a persistent queue; transient failures (overlay down, its header service rate-limited) are retried up to 5 times; definitive refusals are reported.

### 17.7 A minimal UI

Appendix A includes a single-page app (`web/`): connect to BSV Desktop, create a token, see balances (overlay vs basket), a UTXO table with ✓ for "validated by the overlay" and ✓ for "in my basket", send, merge, sync, and look up any identity key. Run it with `npm run web` (Vite, port 5173) and open it in the browser with BSV Desktop running.

---

## 18. Checking Token Origin and Security

✅ automated test

The overlay admits a token output only when it descends, input by input, from the genuine deploy. The kit's tests cover:

| Attack / mistake | Result |
|---|---|
| A "transfer" of a real token created from plain satoshis | Broadcasts fine (miners do not check BSV-21); the overlay does **not** admit it |
| Spending a token-looking output the overlay never admitted | The transaction is refused |
| Outputs exceeding inputs (inflation) | Outputs not admitted (the inputs are still consumed) |
| Using token X inputs to create token Y | Not admitted |
| Amount sums overflowing uint64 | Not admitted |
| Non-canonical encodings (`01 01`, numeric JSON values, `.` in ids) | Ignored |
| A fake token inserted into your wallet basket by some app | Shown as "not validated", never selected by `send`/`merge`; spending it by force is refused by the overlay |

**Rules for app developers**
1. **Never trust a basket for token validity.** Baskets store whatever apps put there.
2. **Only spend UTXOs the overlay validates and reports unspent.** Mixing one bad input with good ones gets the whole transaction refused, and the good inputs are spent on chain anyway.
3. **Submit every token transaction to the overlay, in order.** A transfer whose parent never reached the overlay is refused until the parent arrives.
4. Use security level ≥ 1 for token keys, and keep tokens and NFTs in their own baskets with their own key protocols (separate from payments).
5. Only use topic managers that apply the rules in §16.2. In particular, a transfer whose inputs carry none of that token must never be treated as an issuance.

---

## 19. Showing Tokens and Balances

1. **In your app (recommended).** BSV Desktop does not interpret BSV-21: it stores the 1-sat outputs in your basket, nothing more. Show balances with `kit.balances()` and `kit.utxos()` (§17.3), and anyone's holdings with `kit.overlayUtxos(identityKey)`.
2. **BananaBlocks** — `https://bananablocks.com/token/<tokenId>` (✅ Mainnet: the kit's test token appeared automatically).
   - Canonical BSV-21 deploys are picked up from chain and listed as **Discovered**: holders, supply, decimals and deploy height, refreshed periodically and *unverified*.
   - **Upgrade to Verified:** on the token page, *Upgrade to Verified* shows the token's **fee address**. Anyone can fund it. A deposit activates indexing on the 1Sat network: the token's full history is walked and verified, and it becomes *Verified* on BananaBlocks, usually within about 15 minutes. Cost: **1,000 sats per token output** (historical outputs included). The token stays active while the fee balance is positive.
   - Token list: <https://bananablocks.com/tokens>. API: <https://bananablocks.com/api/docs>.
3. **WhatsOnChain** — `https://whatsonchain.com/tx/<txid>` for any transaction; NFT content at `https://ordfs.network/<origin>`.

---

## 20. Arcade: Broadcasting, Status and Chaintracks

**Arcade** (<https://github.com/bsv-blockchain/arcade>) is the BSV Association's transaction broadcast manager. Its public instances also serve block headers through **go-chaintracks**, which is all an SPV verifier needs. It is a drop-in replacement for WhatsOnChain wherever you need headers or transaction status, and it is the default header source in wallet-toolbox 2.14.x on Node.

| Network | Base URL |
|---|---|
| mainnet | `https://arcade-v2-us-1.bsvblockchain.tech` |
| testnet | `https://arcade-v2-testnet-us-1.bsvblockchain.tech` |
| teratestnet | `https://arcade-v2-ttn-us-1.bsvblockchain.tech` |

### 20.1 Endpoints

| Endpoint | Returns |
|---|---|
| `GET /health` | Status, block height, policy (fees, sizes) |
| `GET /chaintracks/v2/height` | `{ "height": 971454 }` |
| `GET /chaintracks/v2/tip` | Header of the chain tip |
| `GET /chaintracks/v2/header/height/{h}` | `{ "merkleRoot", "hash", "previousHash", "height", … }` |
| `GET /tx/{txid}` | `{ txStatus: "MINED" \| …, blockHeight, blockHash, merklePath, rawTx (Extended Format) }` |
| `POST /tx` | Broadcast; Arcade expects **Extended Format** (EF), not BEEF |

The public endpoints send `Access-Control-Allow-Origin: *`, so browsers can call them directly. ✅ Mainnet: 12 parallel header requests all returned 200, where the free WhatsOnChain API returned `429` for half of 8.

### 20.2 As the overlay's header source

```typescript
server.configureChaintracks('https://arcade-v2-us-1.bsvblockchain.tech', { apiPrefix: '/chaintracks/v2', reorgStream: false })
```

### 20.3 As an SDK ChainTracker (any SPV check)

`client/arcadeChainTracker.ts`:

```typescript
import type { ChainTracker } from '@bsv/sdk'

export class ArcadeChainTracker implements ChainTracker {
  private readonly roots = new Map<number, string>()
  constructor (private readonly url = 'https://arcade-v2-us-1.bsvblockchain.tech') {}

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    let known = this.roots.get(height)
    if (known === undefined) {
      const res = await fetch(`${this.url}/chaintracks/v2/header/height/${height}`)
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`Arcade header request failed (${res.status})`)
      known = String((await res.json()).merkleRoot).toLowerCase()
      this.roots.set(height, known)
    }
    return known === root.toLowerCase()
  }

  async currentHeight (): Promise<number> {
    const res = await fetch(`${this.url}/chaintracks/v2/height`)
    return (await res.json()).height
  }
}

// const ok = await Transaction.fromAtomicBEEF(beef).verify(new ArcadeChainTracker())
```

✅ Mainnet: verified a real token deploy by SPV with this tracker.

### 20.4 Building a BEEF from Arcade (re-submitting a transaction from chain)

```typescript
import { MerklePath, Transaction } from '@bsv/sdk'

export async function beefFromArcade (txid: string, arcadeUrl = 'https://arcade-v2-us-1.bsvblockchain.tech') {
  const seen = new Map<string, Transaction>()
  const load = async (id: string): Promise<Transaction> => {
    if (seen.has(id)) return seen.get(id)!
    const info = await (await fetch(`${arcadeUrl}/tx/${id}`)).json()
    const isEF = info.rawTx.slice(8, 20).toLowerCase() === '0000000000ef'   // version + EF marker
    const tx = isEF ? Transaction.fromHexEF(info.rawTx) : Transaction.fromHex(info.rawTx)
    seen.set(id, tx)
    if (info.merklePath) tx.merklePath = MerklePath.fromHex(info.merklePath)   // mined: proof is enough
    else for (const input of tx.inputs) input.sourceTransaction = await load(input.sourceTXID!) // walk parents
    return tx
  }
  return (await load(txid)).toBEEF()
}
```

Arcade knows the transactions broadcast through it; BSV Desktop uses Arcade as its primary broadcaster. For other transactions, fall back to WhatsOnChain's `GET /v1/bsv/main/tx/{txid}/beef`.

### 20.5 In wallet-toolbox
- **Headers:** default on Node (§14.1).
- **Broadcasting and proofs:** `options.arcadeUrl` (§14.2).

---

## 21. STAS Tokens (Coming Soon)

Everything in this guide uses **BSV-21**, which works today end to end with BRC-100 wallets. **STAS** (STAS 3.0 / DSTAS, <https://github.com/stassso/STAS-3-script-templates>) can be supported with the same architecture — overlay as source of truth, wallet basket as local copy — and this guide will be extended. STAS differs because it is a **Script covenant**:

| Topic | BSV-21 | STAS 3.0 / DSTAS |
|---|---|---|
| Who enforces transfers | The overlay | Bitcoin Script itself (the locking script re-creates itself and conserves value); the overlay checks lineage and issuance |
| Amount | `amt` field | Satoshi value of the output |
| Issuance | `deploy+mint` output (id = outpoint) | Issued from the token's redemption address; a sound overlay must require issuance transactions to spend an output of that address |
| Compliance features | – | Freeze and confiscation by an authority (useful for regulated assets) |
| SDK | `@bsv/sdk` + the kit | [`dxs-bsv-token-sdk`](https://github.com/dxsapp/dxs-bsv-token-sdk) (`dstas` entrypoint: issue, transfer, split, merge, freeze, redeem) |
| BRC-100 signing | Standard P2PKH sighash → `createSignature` | `dxs-bsv-token-sdk` signs with a raw `PrivateKey`; with a BRC-100 wallet you need an adapter that builds the DSTAS unlocking script from a wallet signature (sighash + `createSignature`) |

---

## 22. BRC Reference

Specifications: <https://github.com/bsv-blockchain/BRCs> (also browsable at <https://brc.dev>).

| BRC | Title | Used for |
|---|---|---|
| 9 / 67 | Simplified Payment Verification | Verifying transactions with proofs and headers |
| 22 | Overlay Network Data Synchronization | Submitting to overlays (`/submit`) |
| 24 | Overlay Network Lookup Services | Querying overlays (`/lookup`) |
| 29 | Simple Authenticated BSV P2PKH Payment Protocol | Payments to identity keys (§9) |
| 30 | Transaction Extended Format (EF) | Raw tx with source data; Arcade input format |
| 31 | Authrite Mutual Authentication | Earlier mutual-auth protocol (succeeded by BRC-103/104) |
| 33 | PeerServ Message Relay Interface | Store-and-forward messaging (MessageBox) |
| 42 | BSV Key Derivation Scheme (BKDS) | All derived keys (§5) |
| 43 | Security Levels, Protocol IDs, Key IDs and Counterparties | `protocolID`, `keyID`, `counterparty` |
| 46 | Wallet Transaction Output Tracking (Output Baskets) | Baskets (§8) |
| 62 | BEEF Transactions | Transaction + ancestry + proofs |
| 74 | BSV Unified Merkle Path (BUMP) | Merkle proofs inside BEEF |
| 87 | Naming Conventions for Topic Managers and Lookup Services | `tm_…` / `ls_…` names |
| 88 | Overlay Services Synchronization Architecture | SHIP/SLAP discovery between overlay nodes |
| 95 | Atomic BEEF Transactions | What `createAction` returns |
| 100 | Wallet-to-Application Interface | `WalletClient` ↔ BSV Desktop |
| 103 / 104 | Peer-to-Peer Mutual Authentication / HTTP transport | `AuthFetch` + `createAuthMiddleware` (§10) |
| 105 | HTTP Service Monetization Framework | Authenticated pay-per-request: `AuthFetch` + `@bsv/payment-express-middleware` (§10.3) |
| 121 | Simple 402 Payments | Unauthenticated pay-per-request: `@bsv/402-pay` (§10.4) |

---

## 23. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Script mismatch` on `internalizeAction` | Wrong counterparty (`'self'`) or wrong `outputIndex` | §9.3 |
| Wallet "not found" / connection refused | BSV Desktop closed or locked | Open and unlock it; it listens on 3321 (HTTP) and 2121 (HTTPS) |
| `script[serializedBytes] is not a function` | Two copies of `@bsv/sdk` (CJS + ESM) in one process | Alias `@bsv/sdk` to one build (§2) |
| Overlay returns `Request could not be processed` / `Failed to verify merkleroot for height …` | Its header source failed, typically WhatsOnChain `429` | Use Arcade chaintracks (§20.2). Clients should retry such errors (the kit's outbox does) |
| `TopicBroadcaster` rejects your topic | Non-canonical name (digits, capitals) | `^tm_[a-z]+(_[a-z]+)*$` (BRC-87) |
| Token transfer not admitted although broadcast | Its parent never reached the overlay, or the inputs are not genuine | Submit in order; run `sync()` to heal from chain (§17.6). If it stays unvalidated, it is not a genuine token |
| Spending fails with missing source transactions for unconfirmed parents | The BEEF from `listOutputs` lacks unconfirmed ancestors | Use the overlay's BEEF (TokenKit does) or Arcade (§20.4) as `inputBEEF` |
| BSV Desktop shows nothing under an app's Baskets | That screen lists permission *grants*; basket permissions are off by default | Normal. Enable *Require permission for basket listing* in Settings → Advanced if you want grants to appear; show balances in your app |
| NFT or funds cannot be moved | Locked to `P2PKH(identityKey)` | Always lock to derived keys (§5.1, §13) |
| NFT sent to the wrong output / lost as fee | Ordinal input not at index 0, or random output order | Ordinal at input 0 → 1-sat output 0, `randomizeOutputs: false` (§13.2) |
| `Setup.getEnv` throws `.env is not a valid SetupEnv configuration` | Missing `.env` keys | Build the env object yourself (§14.1) |
| Payout bursts serialize | One large UTXO | `setWalletChangeParams(count, satoshis)` (§11) |
| `create402Fetch` throws *originator parameter must be a canonical DNS hostname* | `@bsv/402-pay` 0.3.3 passes `https://host` as the originator | Wrap the wallet with `withHostOriginator()` (§10.4) |
| Paid API returns `409 ERR_PAYMENT_REPLAYED` | The same payment transaction was presented twice | Expected protection; let the client pay again (BRC-105) |
| Paid API works on one server but double-accepts across replicas | In-memory replay store per process | Inject a shared atomic replay store (§10.5) |

---

## 24. Cheat Sheet

```typescript
// ── Connect ───────────────────────────────────────────
import { WalletClient, Transaction, P2PKH, PublicKey } from '@bsv/sdk'
const wallet = new WalletClient('auto')                       // ('auto', 'myapp.com') in Node
const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })

// ── Pay / receive instantly (BRC-29) ──────────────────
const payment = await createBrc29Payment(wallet, recipientKey, 1000)
await acceptBrc29Payment(recipientWallet, payment, new ArcadeChainTracker())

// ── Raw createAction / internalizeAction ──────────────
const r = await wallet.createAction({ description: 'Pay', outputs: [{ lockingScript, satoshis: 1000, outputDescription: 'pay' }], options: { randomizeOutputs: false, acceptDelayedBroadcast: false } })
const tx = Transaction.fromAtomicBEEF(r.tx!)
await wallet.internalizeAction({ tx: r.tx!, outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey } }], description: 'Received' })

// ── Baskets ───────────────────────────────────────────
await wallet.listOutputs({ basket: 'bsv21', include: 'entire transactions', includeCustomInstructions: true, includeTags: true })

// ── Tokens (BSV-21) ───────────────────────────────────
const kit = new TokenKit(wallet, new OverlayClient('http://localhost:8080'))
const { tokenId } = await kit.deploy({ sym: 'GOLD', amt: 1_000_000n, dec: 2 })
await kit.send(tokenId, 250n, recipientIdentityKey)
await kit.merge(tokenId)
await kit.sync()                                               // receive, heal, recover
const balances = await kit.balances()

// ── NFTs (1Sat Ordinals) ──────────────────────────────
const nfts = new OrdinalKit(wallet)
const { origin } = await nfts.mint('text/plain', 'hello')
const delivery = await nfts.transfer((await nfts.list())[0].outpoint, recipientIdentityKey)
await new OrdinalKit(recipientWallet).receive(delivery)

// ── Authenticated requests (BRC-103/104) ──────────────
const res = await new AuthFetch(wallet).fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })

// ── Pay-per-request (HTTP 402) ────────────────────────
// BRC-105 server: app.use(createAuthMiddleware({ wallet })); app.use(createPaymentMiddleware({ wallet, calculateRequestPrice }))
const paid = await new AuthFetch(wallet).fetch('https://api.example.com/premium')        // pays 402 automatically
// BRC-121 server: app.use('/articles/:slug', createPaymentMiddleware({ wallet, calculatePrice }))  (@bsv/402-pay/server)
const article = await create402Fetch({ wallet: withHostOriginator(wallet) })('https://example.com/articles/x')

// ── Arcade ────────────────────────────────────────────
const ok = await Transaction.fromAtomicBEEF(beef).verify(new ArcadeChainTracker())
const beefFromChain = await beefFromArcade(txid)
```

```bash
npm run overlay   # token overlay on :8080 (SQLite, Arcade headers)
npm run web       # demo UI on :5173
npm test          # 38 tests (rules + end-to-end on the mock chain)
```

---

## Appendix B: Verification Checklist

**Automated** (`npm test`, 38 tests, real wallet-toolbox wallets on the mock chain, overlay over HTTP with SPV):
- **Inscriptions:** canonical round trip; rejection of `01 01`, numeric JSON values and dot ids; uint64 bounds.
- **Admission rules:** deploy; exact, split and merged transfers; inflation; forgery from plain sats; unknown token input; cross-token funding; overflow; burn; whitelist.
- **Keys:** sender-side `'anyone'` derivation equals the wallet's own.
- **Tokens:**
  - deploy, with overlay and basket agreeing;
  - send to another identity key, with the recipient seeing it via the overlay without notice;
  - sync, merge, multi-input selection with change, supply conservation;
  - both forgery scenarios;
  - spent outputs moving to history;
  - recovery of a wallet with no local data.
- **Payments:** BRC-29 payment received and **spent again before any block**; refusal of payments that are not ours or are worth less than claimed.
- **NFTs:** mint at output 0; transfer with the ordinal at input 0 → output 0; wrong recipient refused; transfer back with the origin preserved.
- **Airdrop:** unauthenticated request refused; the server sets the amount; a second claim gets 409.
- **Pay-per-request, BRC-105:** free route without payment; 402 paid automatically by `AuthFetch`, with the merchant credited exactly; replayed payment refused (409).
- **Pay-per-request, BRC-121:** 402 challenge carries price and server key; `create402Fetch` pays automatically, with the merchant credited; replayed headers get a fresh 402.

**On mainnet with BSV Desktop** (October 2026):
- two BSV-21 deploys;
- transfers to self and multi-input coin selection with change;
- basket matching the overlay exactly;
- recovery of a deploy from chain (Arcade BEEF);
- SPV via Arcade chaintracks;
- the token listed on BananaBlocks.

**Before relying on it in production:**
- run a merge and a transfer to another identity key on mainnet;
- deploy the overlay behind HTTPS with backups;
- review key custody.

---

## Appendix A: Token Kit Source

The complete, tested source of the kit used throughout this guide. Recreate the files at the paths shown, then run `npm install`, `npm test`, `npm run overlay` and `npm run web`.

```
bsv21-token-kit/
  package.json  tsconfig.json  vitest.config.ts
  core/        inscription.ts · rules.ts · addresses.ts
  overlay/     Bsv21KitTopicManager.ts · Bsv21KitLookupService.ts · noopAdvertiser.ts · chainTracker.ts · server.ts
  client/      signer.ts · coinselect.ts · overlayApi.ts · token.ts · ordinals.ts · payments.ts · arcadeChainTracker.ts
  examples/    airdropServer.ts · payPerRequest.ts
  web/         index.html · vite.config.ts · src/main.ts · src/style.css
  test/        helpers/mockchain.ts · rules.test.ts · e2e.mockchain.test.ts · payments-nft.e2e.test.ts · pay-per-request.e2e.test.ts
```

### `package.json`

```json
{
  "name": "bsv21-token-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Plug-and-play BSV-21 token overlay + BRC-100 client + minimal web UI (prototype)",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "overlay": "tsx overlay/server.ts",
    "web": "vite web",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@bsv/402-pay": "^0.3.3",
    "@bsv/auth-express-middleware": "^2.2.9",
    "@bsv/overlay": "^2.6.4",
    "@bsv/overlay-express": "^2.7.4",
    "@bsv/payment-express-middleware": "^2.1.9",
    "@bsv/sdk": "^3.2.1",
    "@bsv/wallet-toolbox": "^2.14.9",
    "better-sqlite3": "^13.0.3",
    "express": "^5.3.0",
    "knex": "^3.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/express": "^5.0.6",
    "@types/node": "^26.6.5",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vite": "^8.3.4",
    "vitest": "^4.1.12"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["core", "overlay", "client", "examples", "web/src"]
}
```

### `vitest.config.ts`

```typescript
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // wallet-toolbox is CommonJS and loads the CJS build of @bsv/sdk. Point our
      // code at the same build so SDK objects (Transaction, Script…) are one
      // class instance across both. Browser and overlay runtimes are pure ESM
      // and do not need this.
      '@bsv/sdk': fileURLToPath(new URL('./node_modules/@bsv/sdk/dist/cjs/mod.js', import.meta.url))
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
```

### `core/inscription.ts`

```typescript
/**
 * 1Sat Ordinals inscriptions, canonical form:
 *
 *   OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0 <data> OP_ENDIF
 *   OP_DUP OP_HASH160 <owner pkh> OP_EQUALVERIFY OP_CHECKSIG
 *
 * The content-type tag is OP_1 (0x51), never the non-minimal `01 01`. Pushes use
 * minimal encoding up to OP_PUSHDATA4, so any file size works. The trailing
 * P2PKH is what lets any BRC-100 wallet sign the output normally.
 *
 * BSV-21 tokens are inscriptions of content-type "application/bsv-20" whose
 * JSON payload passes the three gates the 1Sat indexer enforces:
 *  1. the content-type tag is OP_1;
 *  2. every JSON value is a string (`"dec":"2"`, not `"dec":2`);
 *  3. a transfer/burn `id` is `<txid>_<vout>` (underscore, not dot).
 */
import { LockingScript, OP, P2PKH, Script, Utils } from '@bsv/sdk'

export interface DecodedInscription {
  contentType: string
  data: number[]
  /** Owner pubkey hash (hex) from the trailing P2PKH. */
  ownerPkh: string
}

/** Build a canonical inscription owned by `ownerPkh` (hex or bytes). */
export function buildInscription (contentType: string, data: number[] | string, ownerPkh: string | number[]): LockingScript {
  const pkh = typeof ownerPkh === 'string' ? Utils.toArray(ownerPkh, 'hex') : ownerPkh
  if (pkh.length !== 20) throw new Error('owner pkh must be 20 bytes')
  const bytes = typeof data === 'string' ? Utils.toArray(data, 'utf8') : data
  const envelope = new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_IF)
    .writeBin(Utils.toArray('ord', 'utf8'))
    .writeOpCode(OP.OP_1)
    .writeBin(Utils.toArray(contentType, 'utf8'))
    .writeOpCode(OP.OP_0)
    .writeBin(bytes)
    .writeOpCode(OP.OP_ENDIF)
  return LockingScript.fromHex(envelope.toHex() + new P2PKH().lock(pkh).toHex())
}

/** Decode a canonical inscription + P2PKH output, or null if it is not one. */
export function decodeInscription (script: LockingScript | Script | string): DecodedInscription | null {
  try {
    const s = typeof script === 'string' ? LockingScript.fromHex(script) : script
    const c = s.chunks
    if (c.length !== 13) return null
    const isPush = (i: number, len?: number): boolean =>
      c[i].data !== undefined && (len === undefined || c[i].data!.length === len)
    if (c[0].op !== OP.OP_FALSE || c[1].op !== OP.OP_IF) return null
    if (!isPush(2) || Utils.toUTF8(c[2].data!) !== 'ord') return null
    if (c[3].op !== OP.OP_1 || c[3].data !== undefined) return null // canonical tag only
    if (!isPush(4)) return null
    if (c[5].op !== OP.OP_0 || (c[5].data !== undefined && c[5].data.length > 0)) return null
    if (c[7].op !== OP.OP_ENDIF) return null
    if (c[8].op !== OP.OP_DUP || c[9].op !== OP.OP_HASH160 || !isPush(10, 20) ||
        c[11].op !== OP.OP_EQUALVERIFY || c[12].op !== OP.OP_CHECKSIG) return null
    return { contentType: Utils.toUTF8(c[4].data!), data: c[6].data ?? [], ownerPkh: Utils.toHex(c[10].data!) }
  } catch {
    return null
  }
}

// ── BSV-21 ────────────────────────────────────────────────────────────────

export type Bsv21Op = 'deploy+mint' | 'transfer' | 'burn'

export interface Bsv21Inscription {
  op: Bsv21Op
  /** Base-10 integer string, 0 … 2^64-1. */
  amt: string
  /** Token id `<txid>_<vout>`; absent on deploy+mint (the deploy outpoint IS the id). */
  id?: string
  sym?: string
  /** Decimal places as a string, '0' … '18'. */
  dec?: string
  icon?: string
}

export interface DecodedBsv21 extends Bsv21Inscription {
  ownerPkh: string
  amount: bigint
}

export const BSV21_CONTENT_TYPE = 'application/bsv-20'
export const MAX_U64 = (1n << 64n) - 1n

const TOKEN_ID_RE = /^[0-9a-f]{64}_\d+$/
const UINT_RE = /^(0|[1-9]\d*)$/

export function isTokenId (id: string): boolean {
  return TOKEN_ID_RE.test(id)
}

export function tokenIdFromOutpoint (txid: string, vout: number): string {
  return `${txid}_${vout}`
}

function validatePayload (p: Record<string, unknown>): Bsv21Inscription {
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string') throw new Error(`BSV-21 field "${k}" must be a string`)
  }
  if (p.p !== 'bsv-20') throw new Error('BSV-21 "p" must be "bsv-20"')
  const op = p.op as string
  if (op !== 'deploy+mint' && op !== 'transfer' && op !== 'burn') throw new Error(`unsupported BSV-21 op "${op}"`)
  const amt = p.amt as string
  if (typeof amt !== 'string' || !UINT_RE.test(amt) || BigInt(amt) > MAX_U64) throw new Error('BSV-21 "amt" must be a uint64 string')
  if (p.dec !== undefined && (!UINT_RE.test(p.dec as string) || Number(p.dec) > 18)) throw new Error('BSV-21 "dec" must be "0".."18"')
  if (op === 'deploy+mint') {
    if (p.id !== undefined) throw new Error('deploy+mint must not carry an id')
  } else if (typeof p.id !== 'string' || !isTokenId(p.id)) {
    throw new Error('BSV-21 "id" must be "<txid>_<vout>"')
  }
  return {
    op,
    amt,
    id: p.id as string | undefined,
    sym: p.sym as string | undefined,
    dec: p.dec as string | undefined,
    icon: p.icon as string | undefined
  }
}

/** Build a canonical BSV-21 locking script owned by `ownerPkh` (hex or byte array). */
export function buildBsv21Script (insc: Bsv21Inscription, ownerPkh: string | number[]): LockingScript {
  const payload: Record<string, string> = { p: 'bsv-20', op: insc.op }
  if (insc.id !== undefined) payload.id = insc.id
  payload.amt = insc.amt
  if (insc.sym !== undefined) payload.sym = insc.sym
  if (insc.dec !== undefined) payload.dec = insc.dec
  if (insc.icon !== undefined) payload.icon = insc.icon
  validatePayload(payload) // never write something we would refuse to read
  return buildInscription(BSV21_CONTENT_TYPE, JSON.stringify(payload), ownerPkh)
}

/**
 * Decode a canonical BSV-21 output. Returns null for anything that is not one
 * (including non-canonical encodings, which the 1Sat indexer also ignores).
 */
export function decodeBsv21 (script: LockingScript | Script | string): DecodedBsv21 | null {
  const insc = decodeInscription(script)
  if (insc === null || insc.contentType !== BSV21_CONTENT_TYPE) return null
  try {
    const json = JSON.parse(Utils.toUTF8(insc.data))
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
    const p = validatePayload(json) // gates 2 and 3
    return { ...p, ownerPkh: insc.ownerPkh, amount: BigInt(p.amt) }
  } catch {
    return null
  }
}
```

### `core/rules.ts`

```typescript
/**
 * BSV-21 admission rules — a TypeScript port of 1Sat's validated topic manager
 * (b-open-io/1sat-stack pkg/bsv21/topic_validated.go).
 *
 * BSV-21 conservation is NOT enforced by Bitcoin Script (outputs are a plain
 * P2PKH with an inscription), so these rules are the whole truth:
 *
 *  - deploy+mint outputs are always admitted. Their token id is their own
 *    outpoint, so a deploy can never claim someone else's token.
 *  - transfer / burn outputs of a token are admitted only when the token
 *    inputs that the overlay ALREADY admitted (`previousCoins`) cover them.
 *  - a token input the overlay never admitted makes the whole transaction
 *    inadmissible: we cannot vouch for where it came from.
 *
 * The result is that every admitted UTXO descends, input by input, from the
 * genuine deploy.
 */
import type { Transaction } from '@bsv/sdk'
import { decodeBsv21, MAX_U64, tokenIdFromOutpoint } from './inscription'

export interface Admission {
  outputsToAdmit: number[]
  /** Token inputs consumed by this tx; the engine marks them spent and keeps them for history. */
  coinsToRetain: number[]
}

export class UnknownTokenInputError extends Error {
  constructor (readonly inputIndex: number, readonly outpoint: string) {
    super(`input ${inputIndex} spends token output ${outpoint}, which this overlay never admitted`)
  }
}

interface TokenSummary {
  tokensIn: bigint
  out: bigint
  vouts: number[]
}

export interface RuleOptions {
  /** If set, only these token ids are tracked (deploys of other tokens are ignored). */
  whitelist?: ReadonlySet<string>
}

export function identifyAdmissible (tx: Transaction, previousCoins: number[], opts: RuleOptions = {}): Admission {
  const txid = tx.id('hex')
  const tracked = (id: string): boolean => opts.whitelist === undefined || opts.whitelist.has(id)
  const admit: Admission = { outputsToAdmit: [], coinsToRetain: [] }
  const summary = new Map<string, TokenSummary>()

  // Pass 1: outputs.
  tx.outputs.forEach((output, vout) => {
    const d = decodeBsv21(output.lockingScript)
    if (d === null) return
    if (d.op === 'deploy+mint') {
      if (tracked(tokenIdFromOutpoint(txid, vout))) admit.outputsToAdmit.push(vout)
      return
    }
    const id = d.id!
    if (!tracked(id)) return
    const s = summary.get(id) ?? { tokensIn: 0n, out: 0n, vouts: [] }
    s.out += d.amount
    s.vouts.push(vout)
    summary.set(id, s)
  })
  if (summary.size === 0) return admit

  // Pass 2: inputs.
  tx.inputs.forEach((input, vin) => {
    const sourceTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (source === undefined || sourceTxid === undefined) return
    const d = decodeBsv21(source.lockingScript)
    if (d === null || d.op === 'burn') return // burned outputs carry no balance
    const id = d.op === 'deploy+mint' ? tokenIdFromOutpoint(sourceTxid, input.sourceOutputIndex) : d.id!
    const s = summary.get(id)
    if (s === undefined) return // incidental: this tx has no outputs of that token
    if (!previousCoins.includes(vin)) {
      throw new UnknownTokenInputError(vin, `${sourceTxid}_${input.sourceOutputIndex}`)
    }
    admit.coinsToRetain.push(vin)
    s.tokensIn += d.amount
  })

  // Per-token decision.
  for (const s of summary.values()) {
    if (s.out <= MAX_U64 && s.tokensIn >= s.out) admit.outputsToAdmit.push(...s.vouts)
  }
  admit.outputsToAdmit.sort((a, b) => a - b)
  admit.coinsToRetain.sort((a, b) => a - b)
  return admit
}
```

### `core/addresses.ts`

```typescript
/**
 * Deterministic receive keys (BRC-42 with counterparty 'anyone').
 *
 * Key `keyID` of identity I under protocol P is derived with the public
 * "anyone" key (private key 1), so ANYONE who knows I can compute it — the
 * sender, the overlay, a block explorer — and the owner's wallet derives the
 * matching private key with `counterparty: 'anyone', forSelf: true`.
 *
 * Tokens use numbered keys (keyID "0", "1", …) so the overlay can scan an
 * identity's addresses. NFTs use a random keyID that travels with the delivery.
 *
 * Trade-off (accepted for this kit): holdings are publicly linkable to the
 * identity key.
 */
import { KeyDeriver, PublicKey, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

/** Security level 1: the wallet asks once per app (level 0 would never ask). */
export const TOKEN_PROTOCOL: WalletProtocol = [1, 'bsv21 token']
export const ORDINAL_PROTOCOL: WalletProtocol = [1, 'one sat ordinals']
export const TOKEN_BASKET = 'bsv21'
export const ORDINALS_BASKET = 'ordinals'
/** Unused indices scanned past the highest used one (like an HD wallet gap limit). */
export const GAP_LIMIT = 20

export const keyIdFor = (index: number): string => `${index}`

const anyone = new KeyDeriver('anyone')

/** Public key `keyID` of `identityKey` under `protocol`, computable by anyone. */
export function anyonePublicKey (identityKey: string, keyID: string, protocol: WalletProtocol = TOKEN_PROTOCOL): PublicKey {
  return anyone.derivePublicKey(protocol, keyID, identityKey)
}

/** HASH160 (hex) of that key — what a P2PKH-suffixed output locks to. */
export function anyonePkh (identityKey: string, keyID: string, protocol: WalletProtocol = TOKEN_PROTOCOL): string {
  return anyonePublicKey(identityKey, keyID, protocol).toHash('hex') as string
}

/** Token receive key #index of `identityKey`. */
export const receivePublicKey = (identityKey: string, index: number): PublicKey => anyonePublicKey(identityKey, keyIdFor(index))
export const receivePkh = (identityKey: string, index: number): string => anyonePkh(identityKey, keyIdFor(index))

/** The owner's view of the same key, derived by their wallet (must equal anyonePublicKey). */
export async function ownPublicKey (
  wallet: Pick<WalletInterface, 'getPublicKey'>,
  keyID: string,
  protocol: WalletProtocol = TOKEN_PROTOCOL,
  originator?: string
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ protocolID: protocol, keyID, counterparty: 'anyone', forSelf: true }, originator)
  return publicKey
}

export const ownReceivePublicKey = async (wallet: Pick<WalletInterface, 'getPublicKey'>, index: number, originator?: string): Promise<string> =>
  await ownPublicKey(wallet, keyIdFor(index), TOKEN_PROTOCOL, originator)

/** Stored with each basket output so the app can sign for it later. */
export interface CustomInstructions {
  protocolID: WalletProtocol
  keyID: string
  counterparty: 'anyone'
  /** Receive-key index (tokens only). */
  index?: number
}

export const instructionsFor = (index: number): CustomInstructions => ({
  protocolID: TOKEN_PROTOCOL,
  keyID: keyIdFor(index),
  counterparty: 'anyone',
  index
})
```

### `overlay/Bsv21KitTopicManager.ts`

```typescript
import type { TopicManager } from '@bsv/overlay'
import { Transaction, type AdmittanceInstructions } from '@bsv/sdk'
import { identifyAdmissible, type RuleOptions } from '../core/rules'

export const TOPIC = 'tm_tokenkit'

/**
 * Topic manager for BSV-21 tokens. All the logic lives in core/rules.ts so the
 * same rules can be unit-tested without an engine.
 *
 * A transaction spending a token output this overlay never admitted is
 * refused (the rules throw): submit token transactions in order.
 */
export class Bsv21KitTopicManager implements TopicManager {
  constructor (private readonly opts: RuleOptions = {}) {}

  async identifyAdmissibleOutputs (beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const tx = Transaction.fromBEEF(beef)
    return identifyAdmissible(tx, previousCoins, this.opts)
  }

  async getDocumentation (): Promise<string> {
    return [
      '# tm_tokenkit',
      'Admits canonical BSV-21 (1Sat) outputs:',
      '- deploy+mint: always (token id = its own outpoint)',
      '- transfer/burn: only when admitted token inputs cover the outputs',
      'A transaction spending an unadmitted token output is rejected.'
    ].join('\n')
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return { name: TOPIC, shortDescription: 'BSV-21 tokens validated back to their deploy' }
  }
}
```

### `overlay/Bsv21KitLookupService.ts`

```typescript
import type { LookupFormula, LookupService, OutputAdmittedByTopic, OutputSpent } from '@bsv/overlay'
import { Utils, type LookupQuestion } from '@bsv/sdk'
import type { Knex } from 'knex'
import { decodeBsv21, tokenIdFromOutpoint } from '../core/inscription'
import { GAP_LIMIT, receivePkh } from '../core/addresses'
import { TOPIC } from './Bsv21KitTopicManager'

export const SERVICE = 'ls_tokenkit'
const OUTPUTS = 'bsv21kit_outputs'
const TOKENS = 'bsv21kit_tokens'
const MAX_RESULTS = 500

/** Queries accepted by `ls_tokenkit` (the `query` of a LookupQuestion). */
export type KitQuery =
  | { op: 'token', tokenId: string }
  | { op: 'tokens' }
  | { op: 'utxos', ownerPkhs: string[], tokenId?: string }
  | { op: 'identity', identityKey: string, tokenId?: string, includeSpent?: boolean }
  | { op: 'outpoint', txid: string, vout: number }
  | { op: 'history', tokenId: string, limit?: number }

/** Per-output metadata returned in each lookup answer's `context` (UTF-8 JSON). */
export interface OutputContext {
  tokenId: string
  op: string
  amt: string
  ownerPkh: string
  spent: boolean
  spendingTxid?: string
  /** Receive-key index, only for `identity` queries. */
  index?: number
  sym?: string
  dec?: string
}

interface OutputRow {
  txid: string
  vout: number
  token_id: string
  op: string
  amt: string
  owner_pkh: string
  spent: number
  spending_txid: string | null
}

export const migrations = [{
  name: '2026-10-17-001-bsv21kit',
  async up (knex: Knex): Promise<void> {
    await knex.schema.createTable(OUTPUTS, t => {
      t.string('txid', 64).notNullable()
      t.integer('vout').notNullable()
      t.string('token_id', 80).notNullable().index()
      t.string('op', 16).notNullable()
      t.string('amt', 24).notNullable()
      t.string('owner_pkh', 40).notNullable().index()
      t.integer('satoshis').notNullable()
      t.boolean('spent').notNullable().defaultTo(false)
      t.string('spending_txid', 64)
      t.timestamp('created_at').defaultTo(knex.fn.now())
      t.primary(['txid', 'vout'])
    })
    await knex.schema.createTable(TOKENS, t => {
      t.string('token_id', 80).primary()
      t.string('sym', 64)
      t.string('dec', 4)
      t.string('icon', 255)
      t.string('supply', 24).notNullable()
      t.timestamp('created_at').defaultTo(knex.fn.now())
    })
  },
  async down (knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists(OUTPUTS)
    await knex.schema.dropTableIfExists(TOKENS)
  }
}]

const isHex = (s: unknown, len: number): s is string => typeof s === 'string' && s.length === len && /^[0-9a-f]+$/.test(s)

export class Bsv21KitLookupService implements LookupService {
  readonly admissionMode = 'locking-script' as const
  readonly spendNotificationMode = 'txid' as const

  constructor (private readonly knex: Knex) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script' || payload.topic !== TOPIC) return
    const d = decodeBsv21(payload.lockingScript)
    if (d === null) return
    const tokenId = d.op === 'deploy+mint' ? tokenIdFromOutpoint(payload.txid, payload.outputIndex) : d.id!
    await this.knex(OUTPUTS).insert({
      txid: payload.txid,
      vout: payload.outputIndex,
      token_id: tokenId,
      op: d.op,
      amt: d.amt,
      owner_pkh: d.ownerPkh,
      satoshis: payload.satoshis
    }).onConflict(['txid', 'vout']).ignore()
    if (d.op === 'deploy+mint') {
      await this.knex(TOKENS).insert({ token_id: tokenId, sym: d.sym ?? null, dec: d.dec ?? '0', icon: d.icon ?? null, supply: d.amt })
        .onConflict('token_id').ignore()
    }
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== TOPIC) return
    const spendingTxid = payload.mode === 'txid' || payload.mode === 'script' ? payload.spendingTxid : null
    await this.knex(OUTPUTS).where({ txid: payload.txid, vout: payload.outputIndex }).update({ spent: true, spending_txid: spendingTxid })
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.knex(OUTPUTS).where({ txid, vout: outputIndex }).delete()
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    if (question.service !== SERVICE) throw new Error(`unsupported service ${question.service}`)
    const q = question.query as KitQuery
    if (q === null || typeof q !== 'object') throw new Error('query must be an object')

    switch (q.op) {
      case 'token': {
        const [txid, vout] = this.parseTokenId(q.tokenId)
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ txid, vout }))
      }
      case 'tokens':
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ op: 'deploy+mint' }).orderBy('created_at', 'desc').limit(MAX_RESULTS))
      case 'utxos': {
        if (!Array.isArray(q.ownerPkhs) || q.ownerPkhs.length === 0 || q.ownerPkhs.length > MAX_RESULTS || !q.ownerPkhs.every(p => isHex(p, 40))) {
          throw new Error('ownerPkhs must be 1..500 hex pkhs')
        }
        const rows = this.knex<OutputRow>(OUTPUTS).whereIn('owner_pkh', q.ownerPkhs).andWhere('spent', false)
        if (q.tokenId !== undefined) rows.andWhere({ token_id: q.tokenId })
        return await this.formula(await rows.limit(MAX_RESULTS))
      }
      case 'identity': {
        if (!isHex(q.identityKey, 66)) throw new Error('identityKey must be a compressed public key (hex)')
        const indexOf = await this.scanIdentity(q.identityKey)
        if (indexOf.size === 0) return []
        const rows = this.knex<OutputRow>(OUTPUTS).whereIn('owner_pkh', [...indexOf.keys()])
        if (q.includeSpent !== true) rows.andWhere('spent', false)
        if (q.tokenId !== undefined) rows.andWhere({ token_id: q.tokenId })
        return await this.formula(await rows.limit(MAX_RESULTS), indexOf)
      }
      case 'outpoint':
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ txid: q.txid, vout: q.vout }))
      case 'history': {
        const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_RESULTS)
        return await this.formula(await this.knex<OutputRow>(OUTPUTS).where({ token_id: q.tokenId }).orderBy('created_at', 'desc').limit(limit))
      }
      default:
        throw new Error('unknown query op')
    }
  }

  /** pkh → receive index for every used index of `identityKey`, scanning GAP_LIMIT past the last used one. */
  private async scanIdentity (identityKey: string): Promise<Map<string, number>> {
    const used = new Map<string, number>()
    let start = 0
    for (;;) {
      const batch = new Map<string, number>()
      for (let i = start; i < start + GAP_LIMIT; i++) batch.set(receivePkh(identityKey, i), i)
      const hits = await this.knex(OUTPUTS).distinct('owner_pkh').whereIn('owner_pkh', [...batch.keys()])
      if (hits.length === 0) return used
      let maxUsed = start
      for (const { owner_pkh: pkh } of hits) {
        const i = batch.get(pkh)!
        used.set(pkh, i)
        maxUsed = Math.max(maxUsed, i)
      }
      start = maxUsed + 1
    }
  }

  private parseTokenId (tokenId: string): [string, number] {
    const m = /^([0-9a-f]{64})_(\d+)$/.exec(tokenId ?? '')
    if (m === null) throw new Error('tokenId must be "<txid>_<vout>"')
    return [m[1], Number(m[2])]
  }

  private async formula (rows: OutputRow[], indexOf?: Map<string, number>): Promise<LookupFormula> {
    const tokenIds = [...new Set(rows.map(r => r.token_id))]
    const meta = new Map((await this.knex(TOKENS).whereIn('token_id', tokenIds)).map((t: any) => [t.token_id, t]))
    return rows.map(r => {
      const ctx: OutputContext = {
        tokenId: r.token_id,
        op: r.op,
        amt: r.amt,
        ownerPkh: r.owner_pkh,
        spent: Boolean(r.spent),
        ...(r.spending_txid !== null ? { spendingTxid: r.spending_txid } : {}),
        ...(indexOf?.has(r.owner_pkh) === true ? { index: indexOf.get(r.owner_pkh) } : {}),
        ...(meta.get(r.token_id)?.sym != null ? { sym: meta.get(r.token_id).sym } : {}),
        ...(meta.get(r.token_id)?.dec != null ? { dec: meta.get(r.token_id).dec } : {})
      }
      return { txid: r.txid, outputIndex: r.vout, context: Utils.toArray(JSON.stringify(ctx), 'utf8') }
    })
  }

  async getDocumentation (): Promise<string> {
    return '# ls_tokenkit\nQueries: token, tokens, utxos (ownerPkhs), identity (identityKey), outpoint, history.'
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return { name: SERVICE, shortDescription: 'BSV-21 token UTXOs by owner, identity key, token and outpoint' }
  }
}

export const createBsv21KitLookupService = (knex: Knex): { service: LookupService, migrations: typeof migrations } => ({
  service: new Bsv21KitLookupService(knex),
  migrations
})
```

### `overlay/noopAdvertiser.ts`

```typescript
import type { Advertiser } from '@bsv/overlay'

/**
 * A local overlay does not advertise itself on SHIP/SLAP. Without this,
 * overlay-express builds a WalletAdvertiser that calls a remote storage
 * server at start-up.
 */
export const noopAdvertiser: Advertiser & { init: () => Promise<void> } = {
  init: async () => {},
  createAdvertisements: async () => ({ beef: [], topics: [] }),
  findAllAdvertisements: async () => [],
  revokeAdvertisements: async () => ({ beef: [], topics: [] }),
  parseAdvertisement: () => { throw new Error('advertising is disabled on this overlay') }
}
```

### `overlay/chainTracker.ts`

```typescript
/**
 * WhatsOnChain chain tracker that survives the free API's rate limit.
 *
 * Every submit verifies the merkle root of each proven ancestor in the BEEF.
 * Without an API key WhatsOnChain answers ~3 requests/s and returns 429 beyond
 * that; the SDK's tracker turns any failed request into "Failed to verify
 * merkleroot", which rejects a perfectly valid transaction. This wrapper:
 *  - caches confirmed (height, root) pairs — block headers do not change;
 *  - runs one request at a time;
 *  - retries failed requests with exponential backoff.
 * Set WOC_API_KEY for higher limits.
 */
import { WhatsOnChain, type ChainTracker } from '@bsv/sdk'

export class ResilientChainTracker implements ChainTracker {
  private readonly inner: WhatsOnChain
  private readonly verified = new Map<number, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private height?: { value: number, at: number }

  constructor (network: 'main' | 'test' = 'main', apiKey?: string, private readonly retries = 6) {
    this.inner = new WhatsOnChain(network, apiKey !== undefined && apiKey !== '' ? { apiKey } : {})
  }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    if (this.verified.get(height) === root) return true
    const ok = await this.serial(async () => await this.inner.isValidRootForHeight(root, height))
    if (ok) this.verified.set(height, root)
    return ok
  }

  async currentHeight (): Promise<number> {
    if (this.height !== undefined && Date.now() - this.height.at < 30_000) return this.height.value
    const value = await this.serial(async () => await this.inner.currentHeight())
    this.height = { value, at: Date.now() }
    return value
  }

  /** One request at a time, retried with backoff (0.4s, 0.8s, 1.6s …). */
  private async serial<T> (fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn()
        } catch (e) {
          if (attempt >= this.retries) throw e
          await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt))
        }
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return await next
  }
}
```

### `overlay/server.ts`

```typescript
/**
 * Plug-and-play BSV-21 overlay: `npm run overlay`.
 *
 * One process, one SQLite file, no MongoDB, no Docker. Standard overlay
 * endpoints: POST /submit (x-topics: ["tm_tokenkit"]) and POST /lookup
 * (service "ls_tokenkit").
 *
 * Env: PORT (8080), OVERLAY_DB (./data/overlay.db), NETWORK (main|test),
 *      OVERLAY_PRIVATE_KEY (hex; generated and saved to ./data/overlay.key if absent),
 *      TOKEN_WHITELIST (comma-separated token ids; empty = all tokens),
 *      CHAINTRACKS_URL (block headers for SPV; default Arcade https://arcade-v2-us-1.bsvblockchain.tech),
 *      CHAIN_TRACKER=woc (use WhatsOnChain instead), WOC_API_KEY (optional WoC key).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import OverlayExpress from '@bsv/overlay-express'
import { PrivateKey, type ChainTracker } from '@bsv/sdk'
import { Bsv21KitTopicManager, TOPIC } from './Bsv21KitTopicManager'
import { createBsv21KitLookupService, SERVICE } from './Bsv21KitLookupService'
import { noopAdvertiser } from './noopAdvertiser'
import { ResilientChainTracker } from './chainTracker'

export const DEFAULT_CHAINTRACKS_URL = 'https://arcade-v2-us-1.bsvblockchain.tech'

export interface OverlayOptions {
  port: number
  dbFile: string
  network?: 'main' | 'test'
  /** Explicit chain tracker (tests pass the mock chain's). Overrides chainSource. */
  chainTracker?: ChainTracker | 'scripts only'
  /** Where SPV block headers come from on mainnet: Arcade chaintracks (default) or WhatsOnChain. */
  chainSource?: 'arcade' | 'woc'
  chaintracksUrl?: string
  privateKey?: string
  whitelist?: string[]
  quiet?: boolean
}

export interface RunningOverlay {
  url: string
  close: () => Promise<void>
}

export async function startOverlay (opts: OverlayOptions): Promise<RunningOverlay> {
  mkdirSync(dirname(resolve(opts.dbFile)), { recursive: true })
  const server = new OverlayExpress('bsv21kit', opts.privateKey ?? PrivateKey.fromRandom().toHex(), `localhost:${opts.port}`)
  if (opts.quiet === true) {
    const silent = { ...console, log: () => {}, info: () => {}, warn: () => {}, debug: () => {} }
    server.configureLogger(silent as typeof console)
  }
  server.configurePort(opts.port)
  server.configureNetwork(opts.network ?? 'main')
  const network = opts.network ?? 'main'
  if (opts.chainTracker !== undefined) {
    server.configureChainTracker(opts.chainTracker)
  } else if (network === 'main' && opts.chainSource !== 'woc') {
    // Block headers from Arcade's go-chaintracks (BSV Association infrastructure).
    server.configureChaintracks(opts.chaintracksUrl ?? DEFAULT_CHAINTRACKS_URL, { apiPrefix: '/chaintracks/v2', reorgStream: false })
  } else {
    server.configureChainTracker(new ResilientChainTracker(network, process.env.WOC_API_KEY))
  }
  await server.configureKnex({ client: 'better-sqlite3', connection: { filename: opts.dbFile }, useNullAsDefault: true })
  server.configureEnableGASPSync(false)
  server.configureEngineParams({ advertiser: noopAdvertiser })
  server.configureTopicManager(TOPIC, new Bsv21KitTopicManager(
    opts.whitelist !== undefined && opts.whitelist.length > 0 ? { whitelist: new Set(opts.whitelist) } : {}
  ))
  server.configureLookupServiceWithKnex(SERVICE, createBsv21KitLookupService)
  await server.configureEngine(false) // false = no SHIP/SLAP, so no MongoDB
  await server.start()
  return {
    url: `http://localhost:${opts.port}`,
    close: async () => { await server.close() }
  }
}

function loadOrCreateKey (file: string): string {
  if (process.env.OVERLAY_PRIVATE_KEY !== undefined) return process.env.OVERLAY_PRIVATE_KEY
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const key = PrivateKey.fromRandom().toHex()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, key, { mode: 0o600 })
  return key
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080)
  const overlay = await startOverlay({
    port,
    dbFile: process.env.OVERLAY_DB ?? './data/overlay.db',
    network: (process.env.NETWORK as 'main' | 'test' | undefined) ?? 'main',
    privateKey: loadOrCreateKey('./data/overlay.key'),
    chainSource: process.env.CHAIN_TRACKER === 'woc' ? 'woc' : 'arcade',
    chaintracksUrl: process.env.CHAINTRACKS_URL,
    whitelist: (process.env.TOKEN_WHITELIST ?? '').split(',').map(s => s.trim()).filter(Boolean)
  })
  console.log(`BSV-21 overlay running at ${overlay.url}  (topic ${TOPIC}, service ${SERVICE}, SPV headers: ${process.env.CHAIN_TRACKER === 'woc' ? 'WhatsOnChain' : (process.env.CHAINTRACKS_URL ?? DEFAULT_CHAINTRACKS_URL)})`)
}
```

### `client/signer.ts`

```typescript
/**
 * Unlock a P2PKH-suffixed output (BSV-21 tokens, 1Sat NFTs, plain P2PKH) with
 * a BRC-100 wallet.
 *
 * The app computes the BIP-143 preimage over the FULL source locking script
 * (inscription + P2PKH) and asks the wallet to sign its hash with the derived
 * key — the private key never leaves the wallet.
 */
import {
  Hash,
  Signature,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type Transaction,
  type WalletInterface,
  type WalletProtocol
} from '@bsv/sdk'
import { keyIdFor, TOKEN_PROTOCOL } from '../core/addresses'

/** <73-byte checksig sig push> + <33-byte pubkey push>. */
export const P2PKH_UNLOCK_LENGTH = 108
const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

export interface KeyRef {
  protocolID: WalletProtocol
  keyID: string
}

export async function signWalletP2pkhInput (
  wallet: WalletInterface,
  tx: Transaction,
  inputIndex: number,
  key: KeyRef,
  originator?: string
): Promise<UnlockingScript> {
  const input = tx.inputs[inputIndex]
  const sourceTx = input.sourceTransaction
  if (sourceTx === undefined) throw new Error(`input ${inputIndex} has no source transaction`)
  const source = sourceTx.outputs[input.sourceOutputIndex]
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? sourceTx.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope: SCOPE
  })
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.hash256(preimage),
    protocolID: key.protocolID,
    keyID: key.keyID,
    counterparty: 'anyone'
  }, originator)
  const { publicKey } = await wallet.getPublicKey({ protocolID: key.protocolID, keyID: key.keyID, counterparty: 'anyone', forSelf: true }, originator)
  const sig = Signature.fromDER([...signature])
  const checksig = new TransactionSignature(sig.r, sig.s, SCOPE).toChecksigFormat()
  const pub = Utils.toArray(publicKey, 'hex')
  return new UnlockingScript([
    { op: checksig.length, data: checksig },
    { op: pub.length, data: pub }
  ])
}

/** Token input locked to receive key #keyIndex. */
export const signTokenInput = async (
  wallet: WalletInterface,
  tx: Transaction,
  inputIndex: number,
  keyIndex: number,
  originator?: string
): Promise<UnlockingScript> =>
  await signWalletP2pkhInput(wallet, tx, inputIndex, { protocolID: TOKEN_PROTOCOL, keyID: keyIdFor(keyIndex) }, originator)
```

### `client/coinselect.ts`

```typescript
/**
 * Largest-first coin selection: few inputs, and small dust UTXOs are left for
 * a later merge. Returns the chosen UTXOs and their total.
 */
export function selectUtxos<T extends { amount: bigint }> (utxos: T[], target: bigint): { selected: T[], total: bigint } {
  const sorted = [...utxos].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
  const selected: T[] = []
  let total = 0n
  for (const u of sorted) {
    if (total >= target) break
    selected.push(u)
    total += u.amount
  }
  if (total < target) throw new Error(`insufficient token balance: have ${total}, need ${target}`)
  return { selected, total }
}
```

### `client/overlayApi.ts`

```typescript
/**
 * Minimal client for the kit overlay: standard POST /submit and POST /lookup,
 * plus an outbox so token transactions reach the overlay in order.
 *
 * The overlay only admits a transfer whose token inputs it already knows, and
 * it does not fetch missing parents itself, so a failed submit must be retried
 * before any child transaction is submitted.
 */
import { Beef, MerklePath, Transaction, Utils } from '@bsv/sdk'
import type { KitQuery, OutputContext } from '../overlay/Bsv21KitLookupService'
import { decodeBsv21 } from '../core/inscription'

export const TOPIC = 'tm_tokenkit'
export const SERVICE = 'ls_tokenkit'

export interface OverlayOutput {
  txid: string
  vout: number
  tx: Transaction
  /** BEEF (as returned by the overlay) containing tx and its ancestry. */
  beef: number[]
  ctx: OutputContext
}

export interface OutboxItem {
  txid: string
  beef: number[]
  attempts?: number
  lastError?: string
}

export interface OutboxStore {
  load: () => OutboxItem[]
  save: (items: OutboxItem[]) => void
}

export const memoryOutbox = (): OutboxStore => {
  let items: OutboxItem[] = []
  return { load: () => items, save: (next) => { items = next } }
}

export const DEFAULT_ARCADE_URL = 'https://arcade-v2-us-1.bsvblockchain.tech'

/**
 * Build a BEEF for `txid` from Arcade's GET /tx/:txid, which returns the raw
 * transaction (Extended Format) and, once mined, its merkle path. An unmined
 * transaction is completed by walking its parents until each is proven.
 */
export async function beefFromArcade (txid: string, arcadeUrl = DEFAULT_ARCADE_URL): Promise<number[]> {
  const seen = new Map<string, Transaction>()
  const load = async (id: string, depth: number): Promise<Transaction> => {
    const cached = seen.get(id)
    if (cached !== undefined) return cached
    if (depth > 25) throw new Error('unproven ancestry too deep')
    const res = await fetch(`${arcadeUrl}/tx/${id}`)
    if (!res.ok) throw new Error(`Arcade does not know ${id} (${res.status})`)
    const info = await res.json() as { rawTx?: string, merklePath?: string }
    if (info.rawTx === undefined || info.rawTx === '') throw new Error(`Arcade has no raw tx for ${id}`)
    // Extended Format = version (4 bytes) followed by the marker 0000000000EF.
    const isEF = info.rawTx.slice(8, 20).toLowerCase() === '0000000000ef'
    const tx = isEF ? Transaction.fromHexEF(info.rawTx) : Transaction.fromHex(info.rawTx)
    seen.set(id, tx)
    if (info.merklePath !== undefined && info.merklePath !== '') {
      tx.merklePath = MerklePath.fromHex(info.merklePath)
    } else {
      for (const input of tx.inputs) {
        input.sourceTransaction = await load(input.sourceTXID ?? input.sourceTransaction!.id('hex'), depth + 1)
      }
    }
    return tx
  }
  return (await load(txid, 0)).toBEEF()
}

/** Transient overlay errors (e.g. its chain tracker rate-limited) are retried this many times. */
const MAX_ATTEMPTS = 5

export class OverlayClient {
  constructor (
    readonly url: string,
    private readonly outbox: OutboxStore = memoryOutbox(),
    readonly chain: 'main' | 'test' = 'main',
    readonly arcadeUrl = DEFAULT_ARCADE_URL
  ) {}

  /** Queue a transaction (BEEF or AtomicBEEF) and flush the queue in order. */
  async submit (tx: number[] | Uint8Array): Promise<Record<string, unknown>> {
    const bytes = Array.from(tx)
    const parsed = Beef.fromBinary(bytes)
    const txid = parsed.atomicTxid ?? parsed.txs[parsed.txs.length - 1].txid
    const beef = Transaction.fromBEEF(bytes, txid).toBEEF()
    this.outbox.save([...this.outbox.load().filter(i => i.txid !== txid), { txid, beef }])
    const results = await this.flush()
    const mine = results.find(r => r.txid === txid)
    if (mine === undefined) {
      const queued = this.outbox.load().find(i => i.txid === txid)
      throw new Error(`transaction ${txid} is on chain but not yet in the overlay` +
        (queued?.lastError !== undefined ? ` (${queued.lastError})` : ' (an earlier transaction is still queued)') +
        '; it will be retried on the next sync')
    }
    if (mine.error !== undefined) throw new Error(mine.error)
    return mine.steak!
  }

  /**
   * Re-submit a transaction that is already on chain. Recovers tokens whose
   * original submit never reached the overlay. The BEEF (tx + ancestry back to
   * merkle proofs) comes from Arcade, falling back to WhatsOnChain.
   */
  async submitFromChain (txid: string): Promise<Record<string, unknown>> {
    let beef: number[]
    try {
      beef = await beefFromArcade(txid, this.arcadeUrl)
    } catch {
      const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.chain}/tx/${txid}/beef`)
      if (!res.ok) throw new Error(`neither Arcade nor WhatsOnChain could provide ${txid} (${res.status})`)
      beef = Utils.toArray((await res.text()).trim(), 'hex')
    }
    return await this.submit(beef)
  }

  /** Submit queued transactions in order; stop at the first one the overlay cannot take yet. */
  async flush (): Promise<Array<{ txid: string, steak?: Record<string, unknown>, error?: string }>> {
    const queue = this.outbox.load().map(i => ({ ...i }))
    const done: Array<{ txid: string, steak?: Record<string, unknown>, error?: string }> = []
    while (queue.length > 0) {
      const item = queue[0]
      let res: Response
      try {
        res = await fetch(`${this.url}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Topics': JSON.stringify([TOPIC]) },
          body: new Uint8Array(item.beef)
        })
      } catch {
        break // overlay unreachable: keep the queue and retry later
      }
      const body = await res.json().catch(() => ({})) as Record<string, any>
      if (!res.ok) {
        // The engine answers a generic error when SPV checking fails for
        // infrastructure reasons (e.g. its chain tracker was rate-limited):
        // keep the item and retry later, a bounded number of times.
        item.attempts = (item.attempts ?? 0) + 1
        item.lastError = `overlay answered ${res.status}: ${String(body.message ?? body.description ?? res.statusText)}`
        if (item.attempts < MAX_ATTEMPTS) break
        queue.shift()
        done.push({ txid: item.txid, error: `overlay rejected ${item.txid} after ${item.attempts} attempts: ${item.lastError}` })
        continue
      }
      queue.shift()
      {
        const missing = await this.unadmittedTokenOutputs(item, body)
        if (missing.length > 0) {
          // Earlier queue items were already submitted, so this is not a parent
          // still pending: the transaction does not descend from a genuine deploy.
          done.push({ txid: item.txid, error: `overlay did not admit token output(s) ${missing.join(', ')} of ${item.txid}: they do not descend from the token's deploy (or spend a token output the overlay never admitted)` })
        } else {
          done.push({ txid: item.txid, steak: body })
        }
      }
    }
    this.outbox.save(queue)
    return done
  }

  /**
   * Token outputs of the submitted transaction that the overlay did not admit.
   * The STEAK alone cannot tell a refusal from a duplicate submission (both
   * admit nothing), so anything not in the STEAK is checked with a lookup.
   */
  private async unadmittedTokenOutputs (item: OutboxItem, steak: Record<string, any>): Promise<number[]> {
    const tx = Transaction.fromBEEF(item.beef, item.txid)
    const tokenVouts = tx.outputs.map((o, vout) => (decodeBsv21(o.lockingScript) !== null ? vout : -1)).filter(v => v >= 0)
    const admitted = new Set<number>(steak[TOPIC]?.outputsToAdmit ?? [])
    const missing: number[] = []
    for (const vout of tokenVouts) {
      if (admitted.has(vout)) continue
      if ((await this.lookup({ op: 'outpoint', txid: item.txid, vout })).length === 0) missing.push(vout)
    }
    return missing
  }

  pending (): OutboxItem[] {
    return this.outbox.load()
  }

  async lookup (query: KitQuery): Promise<OverlayOutput[]> {
    const res = await fetch(`${this.url}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: SERVICE, query })
    })
    const answer = await res.json() as any
    if (!res.ok) throw new Error(`lookup failed: ${String(answer.message ?? res.statusText)}`)
    if (answer.type !== 'output-list') throw new Error(`unexpected lookup answer ${String(answer.type)}`)
    return answer.outputs.map((o: { beef: number[], outputIndex: number, context?: number[] }) => {
      const tx = Transaction.fromBEEF(o.beef)
      return {
        txid: tx.id('hex'),
        vout: o.outputIndex,
        tx,
        beef: o.beef,
        ctx: JSON.parse(Utils.toUTF8(o.context ?? [])) as OutputContext
      }
    })
  }
}
```

### `client/token.ts`

```typescript
/**
 * TokenKit — BSV-21 tokens on any BRC-100 wallet (BSV Desktop, wallet-toolbox…).
 *
 * The overlay is the source of truth: it validates every token UTXO back to
 * its deploy. The wallet basket `bsv21` is the owner's local copy: `sync()`
 * pulls what the overlay says you own into the basket, and `send()` spends
 * from the basket, so the wallet tracks spends and backs the tokens up.
 */
import { Beef, Transaction, type WalletInterface } from '@bsv/sdk'
import { buildBsv21Script, decodeBsv21, tokenIdFromOutpoint, type DecodedBsv21 } from '../core/inscription'
import { instructionsFor, receivePkh, TOKEN_BASKET, type CustomInstructions } from '../core/addresses'
import type { OverlayClient, OverlayOutput } from './overlayApi'
import { P2PKH_UNLOCK_LENGTH, signWalletP2pkhInput } from './signer'
import { selectUtxos } from './coinselect'

export interface BasketEntry {
  outpoint: string
  txid: string
  vout: number
  decoded: DecodedBsv21
  tokenId: string
  instructions: CustomInstructions
}

export interface TokenUtxo {
  txid: string
  vout: number
  outpoint: string
  tokenId: string
  amount: bigint
  /** Receive-key index of the owner's address. */
  index: number
  sym?: string
  dec?: string
  inBasket: boolean
  inOverlay: boolean
}

export interface TokenBalance {
  tokenId: string
  sym?: string
  dec: string
  overlay: bigint
  basket: bigint
  utxos: number
}

const tokenIdOf = (d: DecodedBsv21, txid: string, vout: number): string =>
  d.op === 'deploy+mint' ? tokenIdFromOutpoint(txid, vout) : d.id!

export class TokenKit {
  private identity?: string

  constructor (
    readonly wallet: WalletInterface,
    readonly overlay: OverlayClient,
    readonly originator?: string
  ) {}

  async identityKey (): Promise<string> {
    this.identity ??= (await this.wallet.getPublicKey({ identityKey: true }, this.originator)).publicKey
    return this.identity
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** What the overlay says `identityKey` holds (works for anyone's identity key). */
  async overlayUtxos (identityKey: string, tokenId?: string): Promise<OverlayOutput[]> {
    return await this.overlay.lookup({ op: 'identity', identityKey, tokenId })
  }

  /** The owner's token UTXOs in the wallet basket. */
  async basketEntries (): Promise<{ entries: BasketEntry[], beef: number[] }> {
    const res = await this.wallet.listOutputs({
      basket: TOKEN_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 1000
    }, this.originator)
    const beef = res.BEEF !== undefined ? Array.from(res.BEEF) : []
    const parsed = beef.length > 0 ? Beef.fromBinary(beef) : undefined
    const entries: BasketEntry[] = []
    for (const o of res.outputs) {
      const [txid, voutStr] = o.outpoint.split('.')
      const vout = Number(voutStr)
      const tx = parsed?.findTxid(txid)?.tx
      const script = o.lockingScript ?? tx?.outputs[vout]?.lockingScript.toHex()
      if (script === undefined) continue
      const decoded = decodeBsv21(script)
      if (decoded === null || o.customInstructions === undefined) continue
      entries.push({
        outpoint: o.outpoint,
        txid,
        vout,
        decoded,
        tokenId: tokenIdOf(decoded, txid, vout),
        instructions: JSON.parse(o.customInstructions) as CustomInstructions
      })
    }
    return { entries, beef }
  }

  /** Merged view: every UTXO the overlay or the basket knows about. */
  async utxos (tokenId?: string): Promise<TokenUtxo[]> {
    const me = await this.identityKey()
    const [fromOverlay, { entries }] = await Promise.all([this.overlayUtxos(me, tokenId), this.basketEntries()])
    const byOutpoint = new Map<string, TokenUtxo>()
    for (const o of fromOverlay) {
      const outpoint = `${o.txid}.${o.vout}`
      byOutpoint.set(outpoint, {
        txid: o.txid,
        vout: o.vout,
        outpoint,
        tokenId: o.ctx.tokenId,
        amount: BigInt(o.ctx.amt),
        index: o.ctx.index ?? -1,
        sym: o.ctx.sym,
        dec: o.ctx.dec,
        inBasket: false,
        inOverlay: true
      })
    }
    for (const e of entries) {
      if (tokenId !== undefined && e.tokenId !== tokenId) continue
      const known = byOutpoint.get(e.outpoint)
      if (known !== undefined) { known.inBasket = true; continue }
      byOutpoint.set(e.outpoint, {
        txid: e.txid,
        vout: e.vout,
        outpoint: e.outpoint,
        tokenId: e.tokenId,
        amount: e.decoded.amount,
        index: e.instructions.index ?? -1,
        sym: e.decoded.sym,
        dec: e.decoded.dec,
        inBasket: true,
        inOverlay: false
      })
    }
    return [...byOutpoint.values()]
  }

  async balances (): Promise<TokenBalance[]> {
    const map = new Map<string, TokenBalance>()
    for (const u of await this.utxos()) {
      const b = map.get(u.tokenId) ?? { tokenId: u.tokenId, sym: u.sym, dec: u.dec ?? '0', overlay: 0n, basket: 0n, utxos: 0 }
      if (u.inOverlay) b.overlay += u.amount
      if (u.inBasket) b.basket += u.amount
      b.sym ??= u.sym
      b.utxos++
      map.set(u.tokenId, b)
    }
    return [...map.values()]
  }

  /** Next unused receive index of `identityKey` according to the overlay (and our basket, for ourselves). */
  async nextIndex (identityKey: string): Promise<number> {
    const seen = await this.overlay.lookup({ op: 'identity', identityKey, includeSpent: true })
    let max = Math.max(-1, ...seen.map(o => o.ctx.index ?? -1))
    if (identityKey === await this.identityKey()) {
      const { entries } = await this.basketEntries()
      max = Math.max(max, ...entries.map(e => e.instructions.index ?? -1))
    }
    return max + 1
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  async deploy (args: { sym: string, amt: bigint, dec: number, icon?: string }): Promise<{ txid: string, tokenId: string }> {
    const me = await this.identityKey()
    const index = await this.nextIndex(me)
    const lockingScript = buildBsv21Script(
      { op: 'deploy+mint', amt: args.amt.toString(), sym: args.sym, dec: String(args.dec), icon: args.icon },
      receivePkh(me, index)
    )
    const res = await this.wallet.createAction({
      description: `Deploy BSV-21 token ${args.sym}`.slice(0, 50),
      labels: ['bsv21'],
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: `${args.sym} supply`.slice(0, 50),
        basket: TOKEN_BASKET,
        customInstructions: JSON.stringify(instructionsFor(index)),
        tags: ['bsv21', `amt:${args.amt}`]
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.txid === undefined || res.tx === undefined) throw new Error('deploy was not completed by the wallet')
    await this.overlay.submit(res.tx)
    return { txid: res.txid, tokenId: tokenIdFromOutpoint(res.txid, 0) }
  }

  /**
   * Overlay ↔ basket.
   *  1. Retries queued overlay submissions.
   *  2. Heals: basket token UTXOs the overlay has never seen are re-submitted
   *     from chain (WhatsOnChain BEEF). Genuine ones get admitted; forgeries
   *     stay "unvalidated" and are never spent.
   *  3. Inserts into the basket the UTXOs the overlay credits to us.
   *  4. Relinquishes basket entries the overlay reports as spent.
   */
  async sync (): Promise<{ inserted: string[], relinquished: string[], healed: string[], unvalidated: string[] }> {
    await this.overlay.flush()
    const me = await this.identityKey()
    let [fromOverlay, { entries }] = await Promise.all([
      this.overlay.lookup({ op: 'identity', identityKey: me, includeSpent: true }),
      this.basketEntries()
    ])

    const healed: string[] = []
    const unvalidated: string[] = []
    const known = new Set(fromOverlay.map(o => `${o.txid}.${o.vout}`))
    const pending = new Set(this.overlay.pending().map(i => i.txid))
    const unknownTxids = [...new Set(entries.filter(e => !known.has(e.outpoint) && !pending.has(e.txid)).map(e => e.txid))]
    for (const txid of unknownTxids) {
      try {
        await this.overlay.submitFromChain(txid)
        healed.push(txid)
      } catch {
        unvalidated.push(...entries.filter(e => e.txid === txid).map(e => e.outpoint))
      }
    }
    if (healed.length > 0) fromOverlay = await this.overlay.lookup({ op: 'identity', identityKey: me, includeSpent: true })

    const inBasket = new Set(entries.map(e => e.outpoint))
    const inserted: string[] = []
    const relinquished: string[] = []

    const missingByTx = new Map<string, OverlayOutput[]>()
    for (const o of fromOverlay) {
      if (o.ctx.spent || inBasket.has(`${o.txid}.${o.vout}`) || o.ctx.index === undefined) continue
      missingByTx.set(o.txid, [...(missingByTx.get(o.txid) ?? []), o])
    }
    for (const [txid, outs] of missingByTx) {
      await this.wallet.internalizeAction({
        tx: Transaction.fromBEEF(outs[0].beef, txid).toAtomicBEEF(),
        outputs: outs.map(o => ({
          outputIndex: o.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: TOKEN_BASKET,
            customInstructions: JSON.stringify(instructionsFor(o.ctx.index!)),
            tags: ['bsv21', `id:${o.ctx.tokenId}`, `amt:${o.ctx.amt}`]
          }
        })),
        labels: ['bsv21'],
        description: 'Receive BSV-21 tokens'
      }, this.originator)
      inserted.push(...outs.map(o => `${o.txid}.${o.vout}`))
    }

    const spentOnOverlay = new Set(fromOverlay.filter(o => o.ctx.spent).map(o => `${o.txid}.${o.vout}`))
    for (const e of entries) {
      if (!spentOnOverlay.has(e.outpoint)) continue
      await this.wallet.relinquishOutput({ basket: TOKEN_BASKET, output: e.outpoint }, this.originator)
      relinquished.push(e.outpoint)
    }
    return { inserted, relinquished, healed, unvalidated }
  }

  /** Send `amount` of `tokenId` to an identity key (or to yourself, on a fresh address). */
  async send (tokenId: string, amount: bigint, to: string | 'self'): Promise<{ txid: string, recipientIndex: number }> {
    if (amount <= 0n) throw new Error('amount must be positive')
    const { entries, beef } = await this.spendable(tokenId)
    const { selected, total } = selectUtxos(entries, amount)
    return await this.spendInputs(selected, beef, tokenId, [
      { to, amount },
      ...(total > amount ? [{ to: 'self' as const, amount: total - amount }] : [])
    ], `Send ${amount} tokens`)
  }

  /** Consolidate every UTXO of `tokenId` into one, on a fresh address of yours. */
  async merge (tokenId: string): Promise<{ txid: string, recipientIndex: number }> {
    const { entries: selected, beef } = await this.spendable(tokenId)
    if (selected.length < 2) throw new Error('nothing to merge: fewer than two UTXOs')
    const total = selected.reduce((s, u) => s + u.amount, 0n)
    return await this.spendInputs(selected, beef, tokenId, [{ to: 'self', amount: total }], `Merge ${selected.length} token UTXOs`)
  }

  /**
   * Basket UTXOs of `tokenId` that the overlay has validated and not seen spent.
   * A basket entry the overlay does not vouch for (a forgery dropped into the
   * basket, or a transaction still waiting to be submitted) is never spent:
   * mixing it with genuine inputs would get the whole transaction rejected.
   */
  async spendable (tokenId: string): Promise<{ entries: Array<BasketEntry & { amount: bigint }>, beef: number[] }> {
    const me = await this.identityKey()
    const [validated, { entries, beef }] = await Promise.all([this.overlayUtxos(me, tokenId), this.basketEntries()])
    const ok = new Set(validated.map(o => `${o.txid}.${o.vout}`))
    // The overlay keeps each UTXO's full ancestry back to mined transactions;
    // the wallet's listOutputs BEEF may omit unmined parents, which a strict
    // broadcaster rejects. Use the overlay's BEEF, topped up with the wallet's.
    const merged = new Beef()
    for (const o of validated) merged.mergeBeef(o.beef)
    if (beef.length > 0) merged.mergeBeef(beef)
    return {
      entries: entries.filter(e => e.tokenId === tokenId && ok.has(e.outpoint)).map(e => ({ ...e, amount: e.decoded.amount })),
      beef: merged.toBinary()
    }
  }

  /** Low-level spend of the given basket entries. Does NOT check them against the overlay — prefer send/merge. */
  async spendInputs (
    inputs: Array<BasketEntry & { amount: bigint }>,
    inputBEEF: number[],
    tokenId: string,
    destinations: Array<{ to: string | 'self', amount: bigint }>,
    description: string
  ): Promise<{ txid: string, recipientIndex: number }> {
    const me = await this.identityKey()
    let nextOwn = await this.nextIndex(me)
    const outputs = []
    let recipientIndex = -1
    for (const d of destinations) {
      const self = d.to === 'self' || d.to === me
      const owner = self ? me : d.to
      const index = self ? nextOwn++ : await this.nextIndex(owner)
      if (recipientIndex === -1) recipientIndex = index
      outputs.push({
        lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: d.amount.toString() }, receivePkh(owner, index)).toHex(),
        satoshis: 1,
        outputDescription: self ? 'Tokens to self' : 'Tokens to recipient',
        ...(self
          ? { basket: TOKEN_BASKET, customInstructions: JSON.stringify(instructionsFor(index)), tags: ['bsv21', `id:${tokenId}`, `amt:${d.amount}`] }
          : {})
      })
    }

    const created = await this.wallet.createAction({
      description: description.slice(0, 50),
      labels: ['bsv21'],
      inputBEEF,
      inputs: inputs.map(u => ({ outpoint: u.outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: 'BSV-21 token input' })),
      outputs,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')

    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (const u of inputs) {
      const i = tx.inputs.findIndex(inp => (inp.sourceTXID ?? inp.sourceTransaction?.id('hex')) === u.txid && inp.sourceOutputIndex === u.vout)
      if (i === -1) throw new Error(`token input ${u.outpoint} missing from signable transaction`)
      if (tx.inputs[i].sourceTransaction === undefined) {
        tx.inputs[i].sourceTransaction = Beef.fromBinary(inputBEEF).findTxid(u.txid)?.tx
      }
      const key = { protocolID: u.instructions.protocolID, keyID: u.instructions.keyID }
      spends[i] = { unlockingScript: (await signWalletP2pkhInput(this.wallet, tx, i, key, this.originator)).toHex() }
    }
    const signed = await this.wallet.signAction({ reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.txid === undefined || signed.tx === undefined) throw new Error('wallet did not complete the transaction')
    await this.overlay.submit(signed.tx)
    return { txid: signed.txid, recipientIndex }
  }
}
```

### `client/ordinals.ts`

```typescript
/**
 * 1Sat Ordinals NFTs on any BRC-100 wallet.
 *
 * An NFT is a 1-satoshi output. The inscription (content) is written once, at
 * mint; afterwards the NFT moves by spending that satoshi into another 1-sat
 * output. Ordinal theory tracks satoshis first-in-first-out, so a transfer
 * spends the NFT as input 0 and pays it to output 0.
 *
 * Keys: each NFT output is locked to a key derived with BRC-42
 * (protocol [1,'one sat ordinals'], random keyID, counterparty 'anyone'), never
 * to the identity key — a BRC-100 wallet cannot sign with its root key, so an
 * output locked to P2PKH(identityKey) could never be moved.
 *
 * Delivery: the sender hands the recipient an `OrdinalDelivery` (AtomicBEEF +
 * keyID) over any channel (MessageBox, WebSocket, HTTP); the recipient checks
 * it and `receive()`s it into the `ordinals` basket.
 */
import { Beef, P2PKH, Random, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { anyonePkh, ORDINAL_PROTOCOL, ORDINALS_BASKET, type CustomInstructions } from '../core/addresses'
import { buildInscription, decodeInscription } from '../core/inscription'
import { P2PKH_UNLOCK_LENGTH, signWalletP2pkhInput } from './signer'

export interface OrdinalDelivery {
  /** AtomicBEEF of the transfer transaction. */
  tx: number[]
  txid: string
  outputIndex: number
  keyID: string
  senderIdentityKey: string
  /** Inscription id of the NFT (mint outpoint, `txid_vout`). */
  origin: string
  contentType?: string
}

export interface OwnedOrdinal {
  outpoint: string
  origin: string
  contentType?: string
  /** Present when this output still holds the inscription (i.e. we minted it and never moved it). */
  data?: number[]
}

const newKeyID = (): string => Utils.toHex(Random(16))

const instructions = (keyID: string): CustomInstructions => ({ protocolID: ORDINAL_PROTOCOL, keyID, counterparty: 'anyone' })

export class OrdinalKit {
  private identity?: string

  constructor (readonly wallet: WalletInterface, readonly originator?: string) {}

  async identityKey (): Promise<string> {
    this.identity ??= (await this.wallet.getPublicKey({ identityKey: true }, this.originator)).publicKey
    return this.identity
  }

  /** Inscribe `data` and keep the NFT in the `ordinals` basket. */
  async mint (contentType: string, data: number[] | string): Promise<{ txid: string, origin: string }> {
    const keyID = newKeyID()
    const lockingScript = buildInscription(contentType, data, anyonePkh(await this.identityKey(), keyID, ORDINAL_PROTOCOL))
    const res = await this.wallet.createAction({
      description: 'Mint 1Sat Ordinal NFT',
      labels: ['ordinals'],
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: `NFT ${contentType}`.slice(0, 50),
        basket: ORDINALS_BASKET,
        customInstructions: JSON.stringify(instructions(keyID)),
        tags: ['ordinal', `type:${contentType}`]
      }],
      // Keep the NFT at output 0 so its origin is `${txid}_0`.
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    if (res.txid === undefined) throw new Error('mint was not completed by the wallet')
    return { txid: res.txid, origin: `${res.txid}_0` }
  }

  /** NFTs currently in the `ordinals` basket. */
  async list (): Promise<Array<OwnedOrdinal & { instructions: CustomInstructions, txid: string, vout: number }>> {
    const res = await this.wallet.listOutputs({
      basket: ORDINALS_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      includeTags: true,
      limit: 1000
    }, this.originator)
    const beef = res.BEEF !== undefined && res.BEEF.length > 0 ? Beef.fromBinary(Array.from(res.BEEF)) : undefined
    return res.outputs.filter(o => o.customInstructions !== undefined).map(o => {
      const [txid, vout] = o.outpoint.split('.')
      const tags = o.tags ?? []
      const insc = decodeInscription(beef?.findTxid(txid)?.tx?.outputs[Number(vout)]?.lockingScript.toHex() ?? '')
      return {
        outpoint: o.outpoint,
        txid,
        vout: Number(vout),
        origin: tags.find(t => t.startsWith('origin:'))?.slice(7) ?? `${txid}_${vout}`,
        contentType: insc?.contentType ?? tags.find(t => t.startsWith('type:'))?.slice(5),
        data: insc?.data,
        instructions: JSON.parse(o.customInstructions!) as CustomInstructions
      }
    })
  }

  /** Transfer an NFT from the basket to `recipientIdentityKey`. Returns what the recipient needs. */
  async transfer (outpoint: string, recipientIdentityKey: string): Promise<OrdinalDelivery> {
    const owned = (await this.list()).find(o => o.outpoint === outpoint)
    if (owned === undefined) throw new Error(`NFT ${outpoint} is not in the ordinals basket`)
    const { BEEF } = await this.wallet.listOutputs({ basket: ORDINALS_BASKET, include: 'entire transactions', limit: 1000 }, this.originator)
    const keyID = newKeyID()
    const created = await this.wallet.createAction({
      description: 'Transfer 1Sat Ordinal NFT',
      labels: ['ordinals'],
      inputBEEF: BEEF !== undefined ? Array.from(BEEF) : undefined,
      inputs: [{ outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: 'NFT input' }],
      outputs: [{
        lockingScript: new P2PKH().lock(Utils.toArray(anyonePkh(recipientIdentityKey, keyID, ORDINAL_PROTOCOL), 'hex')).toHex(),
        satoshis: 1,
        outputDescription: 'NFT to recipient'
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, this.originator)
    const signable = created.signableTransaction
    if (signable === undefined) throw new Error('wallet did not return a signable transaction')
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    // First-in-first-out: the NFT satoshi must be input 0 and land in output 0.
    const [txid, vout] = outpoint.split('.')
    if ((tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex')) !== txid || tx.inputs[0].sourceOutputIndex !== Number(vout)) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('the wallet did not place the NFT at input 0; aborted so the ordinal is not moved to the wrong output')
    }
    if (tx.outputs[0].satoshis !== 1) {
      await this.wallet.abortAction({ reference: signable.reference }, this.originator)
      throw new Error('output 0 is not the 1-sat NFT output; aborted')
    }
    const unlockingScript = await signWalletP2pkhInput(this.wallet, tx, 0, owned.instructions, this.originator)
    const signed = await this.wallet.signAction({ reference: signable.reference, spends: { 0: { unlockingScript: unlockingScript.toHex() } }, options: { acceptDelayedBroadcast: false } }, this.originator)
    if (signed.txid === undefined || signed.tx === undefined) throw new Error('wallet did not complete the transfer')
    return {
      tx: Array.from(signed.tx),
      txid: signed.txid,
      outputIndex: 0,
      keyID,
      senderIdentityKey: await this.identityKey(),
      origin: owned.origin,
      contentType: owned.contentType
    }
  }

  /** Accept an NFT sent to us: check it is locked to our key, then add it to the basket. */
  async receive (d: OrdinalDelivery): Promise<void> {
    const tx = Transaction.fromAtomicBEEF(d.tx)
    const out = tx.outputs[d.outputIndex]
    const expected = new P2PKH().lock(Utils.toArray(anyonePkh(await this.identityKey(), d.keyID, ORDINAL_PROTOCOL), 'hex')).toHex()
    if (out === undefined || out.satoshis !== 1 || out.lockingScript.toHex() !== expected) {
      throw new Error('delivery output is not a 1-sat output locked to our key')
    }
    await this.wallet.internalizeAction({
      tx: d.tx,
      outputs: [{
        outputIndex: d.outputIndex,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: ORDINALS_BASKET,
          customInstructions: JSON.stringify(instructions(d.keyID)),
          tags: ['ordinal', `origin:${d.origin}`, ...(d.contentType !== undefined ? [`type:${d.contentType}`] : [])]
        }
      }],
      labels: ['ordinals'],
      description: 'Receive 1Sat Ordinal NFT'
    }, this.originator)
  }
}
```

### `client/payments.ts`

```typescript
/**
 * Instant peer-to-peer payments (BRC-29) between BRC-100 wallets.
 *
 * The sender builds the transaction and hands the recipient an AtomicBEEF
 * (the transaction plus its ancestry back to merkle proofs) and the BRC-29
 * derivation data. The recipient verifies it with SPV and internalizes it; the
 * output is spendable immediately — no block confirmation needed.
 */
import { P2PKH, PublicKey, Random, Transaction, Utils, type ChainTracker, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

/** BRC-29 payment protocol ID. */
export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

export interface Brc29Payment {
  /** AtomicBEEF (BRC-95) of the payment transaction. */
  tx: number[]
  txid: string
  outputIndex: number
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

/** Sender: pay `satoshis` to `recipientIdentityKey`. The wallet signs and broadcasts. */
export async function createBrc29Payment (
  wallet: WalletInterface,
  recipientIdentityKey: string,
  satoshis: number,
  description = 'BRC-29 payment',
  originator?: string
): Promise<Brc29Payment> {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey, // the OTHER party
    forSelf: false // derive the recipient's key, not ours
  }, originator)
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const res = await wallet.createAction({
    description,
    outputs: [{ lockingScript, satoshis, outputDescription: 'BRC-29 payment' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  }, originator)
  if (res.txid === undefined || res.tx === undefined) throw new Error('payment was not completed by the wallet')
  const outputIndex = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  if (outputIndex === -1) throw new Error('payment output not found in the transaction')
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  return { tx: Array.from(res.tx), txid: res.txid, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey }
}

/**
 * Recipient: verify and accept a payment. With a `chainTracker` the SPV proof
 * is checked here before the wallet is asked anything (the wallet checks again
 * inside internalizeAction). Throws if the output is not really ours or not
 * worth what the sender claims.
 */
export async function acceptBrc29Payment (
  wallet: WalletInterface,
  p: Brc29Payment,
  chainTracker?: ChainTracker,
  description = 'Payment received',
  originator?: string
): Promise<void> {
  const tx = Transaction.fromAtomicBEEF(p.tx)
  if (chainTracker !== undefined && !(await tx.verify(chainTracker))) throw new Error('payment failed SPV verification')
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${p.derivationPrefix} ${p.derivationSuffix}`,
    counterparty: p.senderIdentityKey, // the OTHER party
    forSelf: true // our own key
  }, originator)
  const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const out = tx.outputs[p.outputIndex]
  if (out === undefined || out.lockingScript.toHex() !== expected) throw new Error('payment output is not locked to our key')
  if (out.satoshis !== p.satoshis) throw new Error(`payment is ${String(out.satoshis)} sats, not ${p.satoshis}`)
  await wallet.internalizeAction({
    tx: p.tx,
    outputs: [{
      outputIndex: p.outputIndex,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: p.derivationPrefix,
        derivationSuffix: p.derivationSuffix,
        senderIdentityKey: p.senderIdentityKey
      }
    }],
    description
  }, originator)
}
```

### `client/arcadeChainTracker.ts`

```typescript
/**
 * Minimal SDK ChainTracker backed by Arcade's go-chaintracks REST API.
 * Use it anywhere the SDK asks for a chain tracker, e.g.
 * `await Transaction.fromAtomicBEEF(beef).verify(new ArcadeChainTracker())`.
 *
 *   GET {url}/chaintracks/v2/height                → { height }
 *   GET {url}/chaintracks/v2/header/height/{h}     → { merkleRoot, hash, … }
 *
 * Block headers never change once buried, so verified roots are cached.
 */
import type { ChainTracker } from '@bsv/sdk'

export const ARCADE_MAINNET = 'https://arcade-v2-us-1.bsvblockchain.tech'
export const ARCADE_TESTNET = 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'

export class ArcadeChainTracker implements ChainTracker {
  private readonly roots = new Map<number, string>()

  constructor (private readonly url = ARCADE_MAINNET) {}

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    let known = this.roots.get(height)
    if (known === undefined) {
      const res = await fetch(`${this.url}/chaintracks/v2/header/height/${height}`)
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`Arcade header request failed (${res.status})`)
      known = String((await res.json() as { merkleRoot: string }).merkleRoot).toLowerCase()
      this.roots.set(height, known)
    }
    return known === root.toLowerCase()
  }

  async currentHeight (): Promise<number> {
    const res = await fetch(`${this.url}/chaintracks/v2/height`)
    if (!res.ok) throw new Error(`Arcade height request failed (${res.status})`)
    return (await res.json() as { height: number }).height
  }
}
```

### `examples/airdropServer.ts`

```typescript
/**
 * Authenticated airdrop server.
 *
 * Every request is mutually authenticated (BRC-103/104), so `req.auth.identityKey`
 * is the caller's verified identity key — not something the client typed. The
 * server, not the client, decides the amount, and each identity can claim once.
 *
 * Client side:
 *   const res = await new AuthFetch(wallet).fetch(`${url}/airdrop/claim`, { method: 'POST' })
 *   await acceptBrc29Payment(wallet, await res.json())
 */
import express, { type Express } from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import type { WalletInterface } from '@bsv/sdk'
import { createBrc29Payment } from '../client/payments'

export interface AirdropOptions {
  satoshis: number
  /** Persist this in a database in production; in memory here. */
  claimed?: Set<string>
}

export function createAirdropApp (treasury: WalletInterface, opts: AirdropOptions): Express {
  const claimed = opts.claimed ?? new Set<string>()
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet: treasury }))

  app.post('/airdrop/claim', async (req, res) => {
    const identityKey = (req as AuthRequest).auth?.identityKey
    if (identityKey === undefined || identityKey === 'unknown') {
      res.status(401).json({ error: 'mutual authentication required' })
      return
    }
    if (claimed.has(identityKey)) {
      res.status(409).json({ error: 'already claimed' })
      return
    }
    claimed.add(identityKey) // reserve before spending, so parallel requests cannot double-claim
    try {
      const payment = await createBrc29Payment(treasury, identityKey, opts.satoshis, `Airdrop ${opts.satoshis} sats`)
      res.json(payment)
    } catch (e) {
      claimed.delete(identityKey)
      res.status(500).json({ error: String((e as Error).message) })
    }
  })
  return app
}
```

### `examples/payPerRequest.ts`

```typescript
/**
 * Pay-per-request HTTP APIs (HTTP 402) with the two official protocols.
 *
 * BRC-105 (HTTP Service Monetization Framework) — mutually authenticated.
 *   Server: @bsv/auth-express-middleware + @bsv/payment-express-middleware
 *   Client: `new AuthFetch(wallet).fetch(url)` pays 402 challenges automatically.
 *   Use when the API already knows its callers by identity key.
 *
 * BRC-121 (Simple 402 Payments) — no authentication handshake.
 *   Server: createPaymentMiddleware from @bsv/402-pay/server
 *   Client: `create402Fetch({ wallet })(url)` pays automatically.
 *   Use for public content/APIs where anyone may pay per request.
 *
 * Both validate the BRC-29 payment with the merchant wallet (internalizeAction:
 * the sats land in the merchant's balance immediately) and refuse replays with
 * an atomic replay store. Use a shared, durable store when more than one
 * process serves the routes.
 */
import express, { type Express } from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware as createBrc105Middleware, type PaymentRequest } from '@bsv/payment-express-middleware'
import { createPaymentMiddleware as createBrc121Middleware } from '@bsv/402-pay/server'
import type { WalletInterface } from '@bsv/sdk'

/**
 * @bsv/402-pay 0.3.3's client passes the request origin WITH its scheme
 * ("https://api.example.com") as the BRC-100 originator; wallet-toolbox wallets
 * require a bare hostname ("api.example.com") and reject the call. Wrap a
 * wallet-toolbox wallet with this before giving it to create402Fetch /
 * constructPaymentHeaders.
 */
export function withHostOriginator (wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get (target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (args: unknown, originator?: string) =>
        value.call(target, args, typeof originator === 'string' ? originator.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : originator)
    }
  })
}

/** BRC-105: price per path (0 = free). The receipt is in `req.payment`. */
export function createBrc105App (merchant: WalletInterface, prices: Record<string, number>): Express {
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet: merchant })) // 1) who is calling (BRC-103/104)
  app.use(createBrc105Middleware({ // 2) have they paid (BRC-105)
    wallet: merchant,
    calculateRequestPrice: req => prices[req.path] ?? 0
  }))
  app.get('/free', (req: PaymentRequest, res) => { res.json({ data: 'free data', receipt: req.payment }) })
  app.get('/premium', (req: PaymentRequest, res) => { res.json({ data: 'premium data', receipt: req.payment }) })
  return app
}

/** BRC-121: every /articles/:slug costs `satoshis`. */
export function createBrc121App (merchant: WalletInterface, satoshis: number): Express {
  const app = express()
  app.use('/articles/:slug', createBrc121Middleware({
    wallet: merchant,
    calculatePrice: () => satoshis
  }))
  app.get('/articles/:slug', (req, res) => {
    res.json({ article: req.params.slug, payment: (req as any).payment })
  })
  return app
}
```

### `web/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BSV-21 Token Kit</title>
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <header>
    <div>
      <h1>BSV-21 Token Kit</h1>
      <p class="sub">Local overlay as the source of truth + BRC-100 wallet (BSV Desktop)</p>
    </div>
    <div class="status">
      <span id="wallet-status" class="chip">Wallet: not connected</span>
      <span id="overlay-status" class="chip">Overlay: …</span>
    </div>
  </header>

  <main>
    <section class="card" id="connect-card">
      <h2>1 · Connect</h2>
      <p>Open BSV Desktop (mainnet) and connect. The wallet asks you to approve each action.</p>
      <div class="row">
        <button id="connect">Connect wallet</button>
        <button id="sync" class="secondary" disabled>Sync overlay → basket</button>
        <button id="refresh" class="secondary" disabled>Refresh</button>
      </div>
      <p class="mono small" id="identity"></p>
    </section>

    <section class="card">
      <h2>2 · Create a token</h2>
      <form id="deploy-form" class="grid">
        <label>Symbol <input name="sym" value="KITTEST" maxlength="32" required /></label>
        <label>Supply (display units) <input name="amt" value="10000" required /></label>
        <label>Decimals <input name="dec" type="number" min="0" max="18" value="2" required /></label>
        <button type="submit" disabled>Create token (deploy)</button>
      </form>
      <p class="small muted">Supply in display units: 10000 with 2 decimals = 1,000,000 base units.</p>
    </section>

    <section class="card">
      <h2>3 · My tokens</h2>
      <table>
        <thead><tr><th>Token</th><th>Overlay balance</th><th>Basket balance</th><th>UTXOs</th><th></th></tr></thead>
        <tbody id="balances"><tr><td colspan="5" class="muted">Connect the wallet.</td></tr></tbody>
      </table>
    </section>

    <section class="card">
      <h2>4 · UTXOs <span id="utxo-token" class="muted small"></span></h2>
      <table>
        <thead><tr><th>Outpoint</th><th>Amount</th><th>Address index</th><th>Overlay</th><th>Basket</th></tr></thead>
        <tbody id="utxos"><tr><td colspan="5" class="muted">Pick a token under “My tokens”.</td></tr></tbody>
      </table>
      <p class="small muted">Overlay ✓ = validated back to the original deploy. Basket ✓ = stored in your wallet. Only Overlay ✓ UTXOs are ever spent.</p>
    </section>

    <section class="card">
      <h2>5 · Send</h2>
      <form id="send-form" class="grid">
        <label>Token <select name="token"></select></label>
        <label>Amount <input name="amount" value="1" required /></label>
        <label class="wide">Recipient (identity key, or empty = myself on a fresh address)
          <input name="to" placeholder="03… (66 hex characters)" class="mono" />
        </label>
        <button type="submit" disabled>Send</button>
      </form>
    </section>

    <section class="card">
      <h2>6 · Look up any identity key</h2>
      <form id="lookup-form" class="row">
        <input name="key" placeholder="03… identity key" class="mono grow" required />
        <button type="submit">Ask the overlay</button>
      </form>
      <div id="lookup-result" class="small"></div>
    </section>

    <section class="card">
      <h2>Log</h2>
      <ol id="log" class="log"></ol>
    </section>
  </main>

  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### `web/vite.config.ts`

```typescript
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // The page imports ../client and ../core from the repo root.
    fs: { allow: ['..'] }
  }
})
```

### `web/src/main.ts`

```typescript
import { WalletClient } from '@bsv/sdk'
import { OverlayClient, type OutboxStore } from '../../client/overlayApi'
import { TokenKit, type TokenBalance } from '../../client/token'

const OVERLAY_URL = (import.meta as any).env?.VITE_OVERLAY_URL ?? 'http://localhost:8080'
const WOC = 'https://whatsonchain.com/tx/'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const short = (s: string, n = 8): string => (s.length > 2 * n ? `${s.slice(0, n)}…${s.slice(-n)}` : s)
const txLink = (txid: string, label = short(txid)): string => `<a href="${WOC}${esc(txid)}" target="_blank" rel="noopener">${esc(label)}</a>`

function formatAmount (amount: bigint, dec: number): string {
  if (dec === 0) return amount.toString()
  const s = amount.toString().padStart(dec + 1, '0')
  const whole = s.slice(0, -dec)
  const frac = s.slice(-dec).replace(/0+$/, '')
  return frac === '' ? whole : `${whole}.${frac}`
}

function parseAmount (text: string, dec: number): bigint {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`invalid amount: "${text}"`)
  const [whole, frac = ''] = t.split('.')
  if (frac.length > dec) throw new Error(`at most ${dec} decimals`)
  return BigInt(whole + frac.padEnd(dec, '0'))
}

/** Outbox persisted in localStorage so a failed overlay submit survives a reload. */
const localOutbox = (key: string): OutboxStore => ({
  load: () => { try { return JSON.parse(localStorage.getItem(key) ?? '[]') } catch { return [] } },
  save: (items) => { try { localStorage.setItem(key, JSON.stringify(items)) } catch { /* private mode */ } }
})

const overlay = new OverlayClient(OVERLAY_URL, localOutbox(`bsv21kit-outbox:${OVERLAY_URL}`))
let kit: TokenKit | undefined
let balances: TokenBalance[] = []
let selectedToken: string | undefined

function log (html: string, isError = false): void {
  const li = document.createElement('li')
  li.innerHTML = `<span class="muted">${new Date().toLocaleTimeString()}</span> ${html}`
  if (isError) li.className = 'err'
  $('#log').prepend(li)
}

async function run (label: string, fn: () => Promise<string | void>): Promise<void> {
  const buttons = [...document.querySelectorAll('button')]
  buttons.forEach(b => { b.dataset.wasDisabled = String(b.disabled); b.disabled = true })
  log(`${esc(label)}… (approve in BSV Desktop if asked)`)
  try {
    const msg = await fn()
    if (msg !== undefined) log(msg)
    await refresh()
  } catch (e: any) {
    log(`${esc(label)} failed: ${esc(e?.message ?? e)}`, true)
    console.error(e)
  } finally {
    buttons.forEach(b => { b.disabled = b.dataset.wasDisabled === 'true' })
    if (kit !== undefined) enableWalletButtons()
  }
}

function enableWalletButtons (): void {
  for (const sel of ['#sync', '#refresh', '#deploy-form button', '#send-form button']) $<HTMLButtonElement>(sel).disabled = false
}

async function checkOverlay (): Promise<void> {
  const chip = $('#overlay-status')
  try {
    const res = await fetch(`${OVERLAY_URL}/listTopicManagers`)
    const topics = await res.json()
    const ok = 'tm_tokenkit' in topics
    chip.textContent = `Overlay: ${ok ? 'OK' : 'no tm_tokenkit'} · ${OVERLAY_URL}`
    chip.className = `chip ${ok ? 'ok' : 'bad'}`
  } catch {
    chip.textContent = `Overlay: not responding (${OVERLAY_URL}) — run npm run overlay`
    chip.className = 'chip bad'
  }
  const pending = overlay.pending()
  if (pending.length > 0) log(`${pending.length} transaction(s) waiting to reach the overlay (retried on Sync): ${pending.map(t => txLink(t.txid)).join(', ')}`)
}

async function refresh (): Promise<void> {
  if (kit === undefined) return
  balances = await kit.balances()
  const tbody = $('#balances')
  tbody.innerHTML = balances.length === 0
    ? '<tr><td colspan="5" class="muted">No tokens yet.</td></tr>'
    : balances.map(b => {
      const dec = Number(b.dec)
      const sel = b.tokenId === selectedToken ? ' class="selected"' : ''
      return `<tr${sel}>
        <td><strong>${esc(b.sym ?? '?')}</strong><br><span class="mono small">${txLink(b.tokenId.split('_')[0], short(b.tokenId, 6))}</span></td>
        <td>${formatAmount(b.overlay, dec)}</td>
        <td>${formatAmount(b.basket, dec)}${b.basket !== b.overlay ? ' <span class="no">≠</span>' : ''}</td>
        <td>${b.utxos}</td>
        <td class="row"><button class="secondary" data-utxos="${esc(b.tokenId)}">UTXOs</button>
            <button class="secondary" data-merge="${esc(b.tokenId)}">Merge</button></td>
      </tr>`
    }).join('')
  const select = $<HTMLSelectElement>('#send-form select')
  const current = select.value
  select.innerHTML = balances.map(b => `<option value="${esc(b.tokenId)}">${esc(b.sym ?? '?')} · ${esc(short(b.tokenId, 6))}</option>`).join('')
  if (balances.some(b => b.tokenId === current)) select.value = current
  if (selectedToken !== undefined) await showUtxos(selectedToken)
}

async function showUtxos (tokenId: string): Promise<void> {
  if (kit === undefined) return
  selectedToken = tokenId
  const b = balances.find(x => x.tokenId === tokenId)
  const dec = Number(b?.dec ?? 0)
  $('#utxo-token').textContent = `${b?.sym ?? ''} · ${short(tokenId, 6)}`
  const utxos = await kit.utxos(tokenId)
  $('#utxos').innerHTML = utxos.length === 0
    ? '<tr><td colspan="5" class="muted">No UTXOs.</td></tr>'
    : utxos.map(u => `<tr>
        <td class="mono small">${txLink(u.txid)}.${u.vout}</td>
        <td>${formatAmount(u.amount, dec)}</td>
        <td>${u.index >= 0 ? `#${u.index}` : '—'}</td>
        <td class="${u.inOverlay ? 'yes' : 'no'}">${u.inOverlay ? '✓' : '✗ not validated'}</td>
        <td class="${u.inBasket ? 'yes' : 'no'}">${u.inBasket ? '✓' : '✗ (Sync)'}</td>
      </tr>`).join('')
}

$('#connect').addEventListener('click', () => void run('Connect', async () => {
  const wallet = new WalletClient('auto')
  const { network } = await wallet.getNetwork({})
  kit = new TokenKit(wallet, overlay)
  const key = await kit.identityKey()
  $('#wallet-status').textContent = `Wallet: ${short(key, 6)} · ${network}`
  $('#wallet-status').className = `chip ${network === 'mainnet' ? 'ok' : 'bad'}`
  $('#identity').innerHTML = `Your identity key: ${esc(key)}`
  if (network !== 'mainnet') log('Warning: the wallet is not on mainnet; the overlay validates against mainnet.', true)
  enableWalletButtons()
  return `Connected (${esc(network)})`
}))

$('#sync').addEventListener('click', () => void run('Sync', async () => {
  const { inserted, relinquished, healed, unvalidated } = await kit!.sync()
  return `Synced: ${inserted.length} UTXO(s) added to the basket, ${relinquished.length} removed` +
    (healed.length > 0 ? `, ${healed.length} transaction(s) recovered from chain (${healed.map(t => txLink(t)).join(', ')})` : '') +
    (unvalidated.length > 0 ? `, ${unvalidated.length} basket UTXO(s) the overlay does NOT validate` : '') + '.'
}))

$('#refresh').addEventListener('click', () => void run('Refresh', async () => {}))

$('#deploy-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const f = new FormData(ev.target as HTMLFormElement)
  void run('Create token', async () => {
    const dec = Number(f.get('dec'))
    const amt = parseAmount(String(f.get('amt')), dec)
    const { txid, tokenId } = await kit!.deploy({ sym: String(f.get('sym')).trim(), amt, dec })
    selectedToken = tokenId
    return `Token created: ${esc(tokenId)} (${txLink(txid)})`
  })
})

$('#send-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const f = new FormData(ev.target as HTMLFormElement)
  void run('Send', async () => {
    const tokenId = String(f.get('token'))
    const b = balances.find(x => x.tokenId === tokenId)
    if (b === undefined) throw new Error('pick a token')
    const amount = parseAmount(String(f.get('amount')), Number(b.dec))
    const toRaw = String(f.get('to') ?? '').trim()
    if (toRaw !== '' && !/^0[23][0-9a-f]{64}$/i.test(toRaw)) throw new Error('the identity key must be a compressed public key (66 hex)')
    const to = toRaw === '' ? 'self' : toRaw.toLowerCase()
    const { txid, recipientIndex } = await kit!.send(tokenId, amount, to)
    return `Sent ${formatAmount(amount, Number(b.dec))} ${esc(b.sym ?? '')} to ${to === 'self' ? 'yourself' : esc(short(to, 6))} (address #${recipientIndex}) · ${txLink(txid)}`
  })
})

$('#balances').addEventListener('click', (ev) => {
  const el = ev.target as HTMLElement
  if (el.dataset.utxos !== undefined) void run('UTXOs', async () => { await showUtxos(el.dataset.utxos!) })
  if (el.dataset.merge !== undefined) {
    const tokenId = el.dataset.merge
    void run('Merge', async () => {
      const { txid } = await kit!.merge(tokenId)
      return `Merged · ${txLink(txid)}`
    })
  }
})

$('#lookup-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const key = String(new FormData(ev.target as HTMLFormElement).get('key')).trim().toLowerCase()
  void (async () => {
    const out = $('#lookup-result')
    try {
      if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error('invalid identity key')
      const utxos = await overlay.lookup({ op: 'identity', identityKey: key })
      const byToken = new Map<string, { sym?: string, dec: number, total: bigint, n: number }>()
      for (const u of utxos) {
        const t = byToken.get(u.ctx.tokenId) ?? { sym: u.ctx.sym, dec: Number(u.ctx.dec ?? 0), total: 0n, n: 0 }
        t.total += BigInt(u.ctx.amt)
        t.n++
        byToken.set(u.ctx.tokenId, t)
      }
      out.innerHTML = byToken.size === 0
        ? '<p class="muted">The overlay knows no tokens for this identity key.</p>'
        : `<ul>${[...byToken].map(([id, t]) => `<li><strong>${esc(t.sym ?? '?')}</strong> ${formatAmount(t.total, t.dec)} in ${t.n} UTXO(s) · <span class="mono">${esc(short(id, 6))}</span></li>`).join('')}</ul>`
    } catch (e: any) {
      out.innerHTML = `<p class="no">${esc(e.message)}</p>`
    }
  })()
})

void checkOverlay()
```

### `web/src/style.css`

```css
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --text: #1a1d23;
  --muted: #5d6573;
  --border: #dfe3ea;
  --accent: #1f5fd6;
  --accent-text: #ffffff;
  --ok: #17803d;
  --bad: #b42318;
  --chip: #eef1f6;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151a;
    --card: #1b1f26;
    --text: #e8ebf0;
    --muted: #9aa3b2;
    --border: #2c323c;
    --accent: #5b8def;
    --accent-text: #0d1117;
    --ok: #4ac26b;
    --bad: #f47067;
    --chip: #252b34;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
  padding: 20px 16px;
  max-width: 980px;
  margin: 0 auto;
}
h1 { margin: 0; font-size: 22px; }
h2 { margin: 0 0 10px; font-size: 16px; }
.sub, .muted { color: var(--muted); }
.sub { margin: 2px 0 0; }
.small { font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
main { max-width: 980px; margin: 0 auto; padding: 0 16px 40px; display: grid; gap: 14px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; overflow-x: auto; }
.status { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { background: var(--chip); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 13px; }
.chip.ok { color: var(--ok); }
.chip.bad { color: var(--bad); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.grow { flex: 1; min-width: 200px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; align-items: end; }
.grid .wide { grid-column: 1 / -1; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input, select {
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  width: 100%;
}
button {
  font: inherit;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-text);
  border-radius: 6px;
  padding: 7px 14px;
  cursor: pointer;
}
button.secondary { background: transparent; color: var(--accent); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
tr.selected td { background: var(--chip); }
.yes { color: var(--ok); font-weight: 600; }
.no { color: var(--bad); font-weight: 600; }
a { color: var(--accent); }
.log { margin: 0; padding-left: 20px; font-size: 13px; display: grid; gap: 4px; }
.log .err { color: var(--bad); }
```

### `test/helpers/mockchain.ts`

```typescript
/**
 * Offline test harness: wallet-toolbox's mock chain plus real wallet-toolbox
 * wallets (the same wallet engine BSV Desktop runs).
 *
 * Two MockServices behaviours (wallet-toolbox 2.14.9) differ from a real
 * broadcaster and are patched here, test-only:
 *  1. Re-broadcasting a transaction the network already has is a success on
 *     ARC/Arcade ("already known"); MockServices treats it as a double spend
 *     of its own inputs. A recipient's wallet re-broadcasts on internalizeAction.
 *  2. hydrateInputSourcesFromBeef parses a fresh Transaction per input but marks
 *     parents visited by txid, so a tx spending two outputs of the same parent
 *     (e.g. a token + the sats change of the deploy) leaves the second copy
 *     without its own sources and script verification fails. Fixed by sharing
 *     one Transaction instance per txid.
 */
import { knex as makeKnex, type Knex } from 'knex'
import { Beef, CachedKeyDeriver, MerklePath, PrivateKey, Script, Transaction, type ChainTracker } from '@bsv/sdk'
import {
  MockServices,
  ScriptTemplateBRC29,
  StorageKnex,
  Wallet,
  WalletStorageManager,
  randomBytesBase64,
  randomBytesHex
} from '@bsv/wallet-toolbox'

export const memoryKnex = (): Knex => makeKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })

export interface MockChain {
  services: MockServices
  chainTracker: ChainTracker
  makeWallet: (rootKey?: PrivateKey) => Promise<Wallet>
  fund: (wallet: Wallet, satoshis?: number) => Promise<void>
  mineBlock: () => Promise<void>
  close: () => Promise<void>
}

export async function createMockChain (): Promise<MockChain> {
  const chainDb = memoryKnex()
  const services = new MockServices(chainDb)
  await services.initialize()
  for (let i = 0; i < 110; i++) await services.mineBlock()

  const postBeef = services.postBeef.bind(services)
  ;(services as any).postBeef = async (beef: Beef, txids: string[]) => {
    const results = []
    for (const txid of txids) {
      const known = await (services as any).storage.getTransaction(txid)
      results.push(known != null
        ? { name: 'MockServices', status: 'success', txidResults: [{ txid, status: 'success', alreadyKnown: true }] }
        : (await postBeef(beef, [txid]))[0])
    }
    return results
  }
  ;(services as any).hydrateInputSourcesFromBeef = (tx: Transaction, beef: Beef) => {
    const cache = new Map<string, Transaction>()
    const walk = (t: Transaction): void => {
      for (const input of t.inputs) {
        if (input.sourceTransaction !== undefined || input.sourceTXID === undefined) continue
        let source = cache.get(input.sourceTXID)
        if (source === undefined) {
          const raw = beef.findTxid(input.sourceTXID)?.rawTx
          if (raw === undefined) continue
          source = Transaction.fromBinary(Array.from(raw))
          cache.set(input.sourceTXID, source)
          walk(source)
        }
        input.sourceTransaction = source
      }
    }
    walk(tx)
  }

  const cleanups: Array<() => Promise<void>> = []

  async function makeWallet (rootKey = PrivateKey.fromRandom()): Promise<Wallet> {
    const db = memoryKnex()
    const provider = new StorageKnex({ chain: 'mock', knex: db, commissionSatoshis: 0, feeModel: { model: 'sat/kb', value: 100 } })
    await provider.migrate('bsv21kit-e2e', randomBytesHex(33))
    await provider.makeAvailable()
    const storage = new WalletStorageManager(rootKey.toPublicKey().toString(), provider)
    await storage.makeAvailable()
    storage.setServices(services)
    const wallet = new Wallet({ chain: 'mock', keyDeriver: new CachedKeyDeriver(rootKey), storage, services, actionBatchMode: 'legacy' } as any)
    cleanups.push(async () => { await wallet.destroy(); await db.destroy() })
    return wallet
  }

  /** Fund a wallet from a mature mock-chain coinbase (pattern from wallet-toolbox's own tests). */
  async function fund (wallet: Wallet, satoshis = 1_000_000): Promise<void> {
    const height = await services.getHeight()
    const [utxo] = await (services as any).storage.knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null }).where('blockHeight', '<=', height - 100).orderBy('blockHeight', 'asc').limit(1)
    const sourceRawTx = Array.from((await (services as any).storage.getTransaction(utxo.txid)).rawTx as number[])
    const derivationPrefix = randomBytesBase64(16)
    const derivationSuffix = randomBytesBase64(16)
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: wallet.keyDeriver })
    const payment = new Transaction()
    payment.addInput({ sourceTransaction: Transaction.fromBinary(sourceRawTx), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff })
    payment.addOutput({ satoshis, lockingScript: template.lock(keys.privateKey, keys.publicKey) })
    const txid = payment.id('hex')
    const sourceProof = (await services.getMerklePath(utxo.txid)).merklePath as MerklePath
    const unproven = new Beef()
    unproven.mergeRawTx(sourceRawTx, unproven.mergeBump(sourceProof))
    unproven.mergeRawTx(payment.toBinary())
    await services.postBeef(unproven, [txid])
    await services.mineBlock()
    const beef = new Beef()
    beef.mergeRawTx(payment.toBinary(), beef.mergeBump((await services.getMerklePath(txid)).merklePath as MerklePath))
    await wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid),
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: wallet.identityKey } }],
      description: 'Fund test wallet'
    })
  }

  return {
    services,
    chainTracker: await services.getChainTracker() as ChainTracker,
    makeWallet,
    fund,
    mineBlock: async () => { await services.mineBlock() },
    close: async () => {
      for (const c of cleanups.reverse()) await c()
      await chainDb.destroy()
    }
  }
}
```

### `test/rules.test.ts`

```typescript
import { describe, expect, it } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { buildBsv21Script, decodeBsv21, MAX_U64 } from '../core/inscription'
import { identifyAdmissible, UnknownTokenInputError } from '../core/rules'
import { ownReceivePublicKey, receivePublicKey } from '../core/addresses'

const A = 'ab'.repeat(20)
const B = 'cd'.repeat(20)
const EMPTY = new UnlockingScript([])

function deployTx (amt = '1000'): { tx: Transaction, tokenId: string } {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: buildBsv21Script({ op: 'deploy+mint', amt, sym: 'KIT', dec: '0' }, A), satoshis: 1 })
  return { tx, tokenId: `${tx.id('hex')}_0` }
}

function spend (parent: Transaction, vout: number, outputs: Array<{ id: string, amt: string, owner?: string, op?: 'transfer' | 'burn' }>): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: vout, unlockingScript: EMPTY })
  for (const o of outputs) {
    tx.addOutput({ lockingScript: buildBsv21Script({ op: o.op ?? 'transfer', id: o.id, amt: o.amt }, o.owner ?? B), satoshis: 1 })
  }
  return tx
}

describe('inscription', () => {
  it('round-trips a canonical transfer', () => {
    const s = buildBsv21Script({ op: 'transfer', id: `${'aa'.repeat(32)}_0`, amt: '42' }, A)
    expect(decodeBsv21(s)).toMatchObject({ op: 'transfer', amt: '42', amount: 42n, ownerPkh: A })
  })

  it('rejects the three non-canonical forms 1Sat also rejects', () => {
    const json = (p: object) => Utils.toHex(Utils.toArray(JSON.stringify(p), 'utf8'))
    const push = (h: string) => (h.length / 2 > 0x4b ? '4c' : '') + (h.length / 2).toString(16).padStart(2, '0') + h
    const build = (tag: string, p: object) => LockingScript.fromHex(
      '0063' + push(Utils.toHex(Utils.toArray('ord', 'utf8'))) + tag +
      push(Utils.toHex(Utils.toArray('application/bsv-20', 'utf8'))) + '00' + push(json(p)) + '68' + '76a914' + A + '88ac')
    const ok = { p: 'bsv-20', op: 'transfer', id: `${'aa'.repeat(32)}_0`, amt: '5' }
    expect(decodeBsv21(build('51', ok))).not.toBeNull()
    expect(decodeBsv21(build('0101', ok))).toBeNull() // gate 1: non-minimal OP_1
    expect(decodeBsv21(build('51', { ...ok, amt: 5 }))).toBeNull() // gate 2: number value
    expect(decodeBsv21(build('51', { ...ok, id: `${'aa'.repeat(32)}.0` }))).toBeNull() // gate 3: dot id
  })

  it('refuses to build amounts above uint64', () => {
    expect(() => buildBsv21Script({ op: 'deploy+mint', amt: (MAX_U64 + 1n).toString() }, A)).toThrow()
  })
})

describe('admission rules', () => {
  it('admits a deploy+mint', () => {
    const { tx } = deployTx()
    expect(identifyAdmissible(tx, [])).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
  })

  it('admits an exact transfer and a split, retaining the spent input', () => {
    const { tx: d, tokenId } = deployTx()
    expect(identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: '1000' }]), [0])).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect(identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: '600' }, { id: tokenId, amt: '400', owner: A }]), [0]).outputsToAdmit).toEqual([0, 1])
  })

  it('admits a merge of two admitted UTXOs', () => {
    const { tx: d, tokenId } = deployTx()
    const split = spend(d, 0, [{ id: tokenId, amt: '600' }, { id: tokenId, amt: '400' }])
    const merge = new Transaction()
    merge.addInput({ sourceTransaction: split, sourceOutputIndex: 0, unlockingScript: EMPTY })
    merge.addInput({ sourceTransaction: split, sourceOutputIndex: 1, unlockingScript: EMPTY })
    merge.addOutput({ lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '1000' }, B), satoshis: 1 })
    expect(identifyAdmissible(merge, [0, 1])).toEqual({ outputsToAdmit: [0], coinsToRetain: [0, 1] })
  })

  it('rejects inflation (outputs exceed admitted inputs)', () => {
    const { tx: d, tokenId } = deployTx()
    const r = identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: '1001' }]), [0])
    expect(r.outputsToAdmit).toEqual([])
    expect(r.coinsToRetain).toEqual([0]) // the input is still consumed (tokens burned)
  })

  it('FORGERY: rejects a "transfer" of a real token minted from plain sats', () => {
    const { tokenId } = deployTx()
    const funding = new Transaction()
    funding.addOutput({ lockingScript: new P2PKH().lock(Utils.toArray(A, 'hex')), satoshis: 1000 })
    const forged = new Transaction()
    forged.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: EMPTY })
    forged.addOutput({ lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '1000000' }, B), satoshis: 1 })
    expect(identifyAdmissible(forged, []).outputsToAdmit).toEqual([])
  })

  it('FORGERY: refuses a token input the overlay never admitted', () => {
    const { tokenId } = deployTx()
    const fake = new Transaction() // looks like a token UTXO, but was never admitted
    fake.addOutput({ lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '5000' }, A), satoshis: 1 })
    expect(() => identifyAdmissible(spend(fake, 0, [{ id: tokenId, amt: '5000' }]), [])).toThrow(UnknownTokenInputError)
  })

  it('FORGERY: an admitted input of token X cannot fund outputs of token Y', () => {
    const { tx: dx } = deployTx('1000')
    const { tokenId: idY } = deployTx('7')
    expect(identifyAdmissible(spend(dx, 0, [{ id: idY, amt: '1000' }]), [0]).outputsToAdmit).toEqual([])
  })

  it('rejects an output sum that would overflow uint64', () => {
    const { tx: d, tokenId } = deployTx(MAX_U64.toString())
    const r = identifyAdmissible(spend(d, 0, [{ id: tokenId, amt: MAX_U64.toString() }, { id: tokenId, amt: '2' }]), [0])
    expect(r.outputsToAdmit).toEqual([])
  })

  it('admits a burn covered by inputs, and a burned output carries no balance', () => {
    const { tx: d, tokenId } = deployTx()
    const burn = spend(d, 0, [{ id: tokenId, amt: '900' }, { id: tokenId, amt: '100', op: 'burn' }])
    expect(identifyAdmissible(burn, [0]).outputsToAdmit).toEqual([0, 1])
    const fromBurn = spend(burn, 1, [{ id: tokenId, amt: '100' }])
    expect(identifyAdmissible(fromBurn, [0]).outputsToAdmit).toEqual([])
  })

  it('honours a whitelist', () => {
    const { tx } = deployTx()
    expect(identifyAdmissible(tx, [], { whitelist: new Set(['other_0']) }).outputsToAdmit).toEqual([])
  })
})

describe('deterministic receive keys', () => {
  it('sender-side derivation equals the owner wallet derivation (BRC-42 anyone)', async () => {
    const root = PrivateKey.fromRandom()
    const wallet = new ProtoWallet(root)
    const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
    for (const i of [0, 1, 7]) {
      expect(await ownReceivePublicKey(wallet, i)).toBe(receivePublicKey(identityKey, i).toString())
    }
    expect(receivePublicKey(identityKey, 0).toString()).not.toBe(receivePublicKey(identityKey, 1).toString())
  })
})
```

### `test/e2e.mockchain.test.ts`

```typescript
/**
 * Tokens, end to end, offline: real wallet-toolbox wallets (the same wallet
 * engine BSV Desktop runs) on wallet-toolbox's mock chain, and the real overlay
 * server over HTTP, with SPV checked against the mock chain's headers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { startOverlay, type RunningOverlay } from '../overlay/server'
import { OverlayClient } from '../client/overlayApi'
import { TokenKit } from '../client/token'
import { buildBsv21Script } from '../core/inscription'
import { instructionsFor, receivePkh, TOKEN_BASKET } from '../core/addresses'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
let overlay: RunningOverlay
const makeWallet = async (rootKey?: PrivateKey): Promise<Wallet> => await chain.makeWallet(rootKey)
const fund = async (wallet: Wallet): Promise<void> => await chain.fund(wallet)

const sum = (xs: Array<{ amount: bigint }>): bigint => xs.reduce((s, x) => s + x.amount, 0n)
const unspentAmounts = async (kit: TokenKit, identityKey: string, tokenId: string): Promise<bigint[]> =>
  (await kit.overlayUtxos(identityKey, tokenId)).map(o => BigInt(o.ctx.amt)).sort((a, b) => (a < b ? -1 : 1))

beforeAll(async () => {
  chain = await createMockChain()
  const dir = mkdtempSync(join(tmpdir(), 'bsv21kit-'))
  overlay = await startOverlay({ port: 18090, dbFile: join(dir, 'overlay.db'), chainTracker: chain.chainTracker, quiet: true })
})

afterAll(async () => {
  await overlay?.close()
  await chain?.close()
})

describe('BSV-21 token kit, end to end', () => {
  let alice: Wallet, bob: Wallet
  let kitA: TokenKit, kitB: TokenKit
  let aliceKey: string, bobKey: string
  let tokenId: string

  it('sets up two funded BRC-100 wallets', async () => {
    alice = await makeWallet()
    bob = await makeWallet()
    await fund(alice)
    await fund(bob)
    kitA = new TokenKit(alice, new OverlayClient(overlay.url))
    kitB = new TokenKit(bob, new OverlayClient(overlay.url))
    aliceKey = await kitA.identityKey()
    bobKey = await kitB.identityKey()
  })

  it('deploys a token: overlay and basket agree', async () => {
    ;({ tokenId } = await kitA.deploy({ sym: 'KIT', amt: 1_000_000n, dec: 2 }))
    expect(tokenId).toMatch(/^[0-9a-f]{64}_0$/)
    const [b] = await kitA.balances()
    expect(b).toMatchObject({ tokenId, sym: 'KIT', overlay: 1_000_000n, basket: 1_000_000n, utxos: 1 })
  })

  it('sends to another identity key; the recipient sees it via the overlay without being told', async () => {
    await kitA.send(tokenId, 300n, bobKey)
    expect(await unspentAmounts(kitA, bobKey, tokenId)).toEqual([300n]) // queried by Alice, Bob did nothing
    let [b] = await kitB.balances()
    expect(b).toMatchObject({ overlay: 300n, basket: 0n }) // overlay knows, Bob's wallet does not yet
    const { inserted } = await kitB.sync()
    expect(inserted).toHaveLength(1)
    ;[b] = await kitB.balances()
    expect(b).toMatchObject({ overlay: 300n, basket: 300n })
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([999_700n]) // change on a fresh address
  })

  it('merges two UTXOs into one (and the overlay accepts it)', async () => {
    await kitA.send(tokenId, 200n, bobKey)
    await kitB.sync()
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([200n, 300n])
    await kitB.merge(tokenId)
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([500n])
    const utxos = await kitB.utxos(tokenId)
    expect(utxos).toHaveLength(1)
    expect(utxos[0]).toMatchObject({ amount: 500n, inBasket: true, inOverlay: true })
  })

  it('selects several UTXOs to cover an amount and returns change', async () => {
    await kitA.send(tokenId, 1_000n, 'self') // Alice now holds 998_500 + 1_000 (+ earlier history)
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([1_000n, 998_500n])
    await kitA.send(tokenId, 999_000n, bobKey) // needs both UTXOs
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([500n])
    await kitB.sync()
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([500n, 999_000n])
  })

  it('supply is conserved across every transfer', async () => {
    const all = [...await kitA.overlayUtxos(aliceKey, tokenId), ...await kitA.overlayUtxos(bobKey, tokenId)]
    expect(sum(all.map(o => ({ amount: BigInt(o.ctx.amt) })))).toBe(1_000_000n)
  })

  it('FORGERY: a "transfer" of the real token created from plain sats is not admitted', async () => {
    const forgedScript = buildBsv21Script({ op: 'transfer', id: tokenId, amt: '5000000' }, receivePkh(bobKey, 50))
    const res = await bob.createAction({
      description: 'Forged token output',
      outputs: [{ lockingScript: forgedScript.toHex(), satoshis: 1, outputDescription: 'forged tokens' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    // It broadcasts fine on-chain (Script does not enforce BSV-21), but the overlay refuses it.
    await expect(kitB.overlay.submit(res.tx!)).rejects.toThrow(/did not admit/)
    expect(await unspentAmounts(kitB, bobKey, tokenId)).toEqual([500n, 999_000n])
  })

  it('FORGERY: a fake token UTXO dropped into the basket is never selected, and spending it is rejected', async () => {
    // A wallet basket does not validate tokens: anyone's app can insert a fake.
    const fakeIndex = 60
    const res = await bob.createAction({
      description: 'Fake token in basket',
      outputs: [{
        lockingScript: buildBsv21Script({ op: 'transfer', id: tokenId, amt: '7000000' }, receivePkh(bobKey, fakeIndex)).toHex(),
        satoshis: 1,
        outputDescription: 'fake tokens',
        basket: TOKEN_BASKET,
        customInstructions: JSON.stringify(instructionsFor(fakeIndex))
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const fakeOutpoint = `${res.txid!}.0`
    const utxos = await kitB.utxos(tokenId)
    expect(utxos.find(u => u.outpoint === fakeOutpoint)).toMatchObject({ inBasket: true, inOverlay: false })
    const [b] = (await kitB.balances()).filter(x => x.tokenId === tokenId)
    expect(b.overlay).toBe(999_500n) // the overlay view ignores the fake
    expect((await kitB.spendable(tokenId)).entries.map(e => e.outpoint)).not.toContain(fakeOutpoint)

    // Bypass the kit's protection and spend the fake directly: the overlay refuses it.
    const { entries } = await kitB.basketEntries()
    const fake = entries.find(e => e.outpoint === fakeOutpoint)!
    await expect(kitB.spendInputs([{ ...fake, amount: fake.decoded.amount }], Array.from(res.tx!), tokenId, [{ to: aliceKey, amount: 7_000_000n }], 'Spend fake tokens'))
      .rejects.toThrow(/did not admit/)
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([500n]) // Alice got nothing
  })

  it('a spent UTXO disappears from the overlay', async () => {
    const before = await kitB.overlayUtxos(bobKey, tokenId)
    const { txid } = await kitB.send(tokenId, 100n, aliceKey)
    const after = new Set((await kitB.overlayUtxos(bobKey, tokenId)).map(o => `${o.txid}.${o.vout}`))
    const gone = before.filter(o => !after.has(`${o.txid}.${o.vout}`))
    expect(gone).toHaveLength(1) // exactly the selected input left the unspent set
    const history = await kitB.overlay.lookup({ op: 'identity', identityKey: bobKey, tokenId, includeSpent: true })
    const spent = history.find(o => o.txid === gone[0].txid && o.vout === gone[0].vout)!
    expect(spent.ctx).toMatchObject({ spent: true, spendingTxid: txid }) // kept as history, marked spent
  })

  it('RECOVERY: a fresh wallet with the same key and no local data recovers its tokens from the overlay', async () => {
    const restored = await makeWallet(PrivateKey.fromHex((bob as any).keyDeriver.rootKey.toHex()))
    await fund(restored) // fresh storage knows nothing; sats only to pay for a later send
    const kitR = new TokenKit(restored, new OverlayClient(overlay.url))
    expect(await kitR.identityKey()).toBe(bobKey)
    const { inserted } = await kitR.sync()
    expect(inserted.length).toBeGreaterThan(0)
    const [b] = (await kitR.balances()).filter(x => x.tokenId === tokenId)
    expect(b.basket).toBe(b.overlay)
    expect(b.overlay).toBe(999_400n)
    await kitR.send(tokenId, 400n, aliceKey) // the restored wallet can spend them
    expect(await unspentAmounts(kitA, aliceKey, tokenId)).toEqual([100n, 400n, 500n])
  })
})
```

### `test/payments-nft.e2e.test.ts`

```typescript
/**
 * Instant payments, NFTs and an authenticated airdrop — end to end, offline,
 * with real wallet-toolbox wallets on the mock chain. No block is mined during
 * these flows: everything below happens at 0-conf.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { AuthFetch, Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { acceptBrc29Payment, createBrc29Payment, type Brc29Payment } from '../client/payments'
import { OrdinalKit } from '../client/ordinals'
import { createAirdropApp } from '../examples/airdropServer'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
const isMined = async (txid: string): Promise<boolean> =>
  (await (chain.services as any).storage.getTransaction(txid))?.blockHeight != null

const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { await chain?.close() })

describe('instant BRC-29 payments (no block confirmation)', () => {
  let alice: Wallet, bob: Wallet, carol: Wallet, mallory: Wallet
  let payment: Brc29Payment

  it('Alice pays Bob; Bob verifies SPV and internalizes', async () => {
    ;[alice, bob, carol, mallory] = await Promise.all([chain.makeWallet(), chain.makeWallet(), chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    payment = await createBrc29Payment(alice, bob.identityKey, 50_000)
    expect(await isMined(payment.txid)).toBe(false)
    await acceptBrc29Payment(bob, payment, chain.chainTracker)
    expect(await spendableSats(bob)).toBe(50_000)
  })

  it('Bob spends the received sats immediately, before any block is mined', async () => {
    const onward = await createBrc29Payment(bob, carol.identityKey, 10_000)
    expect(Transaction.fromAtomicBEEF(onward.tx).inputs.some(i => i.sourceTXID === payment.txid)).toBe(true)
    await acceptBrc29Payment(carol, onward, chain.chainTracker)
    expect(await isMined(payment.txid)).toBe(false)
    expect(await isMined(onward.txid)).toBe(false)
    expect(await spendableSats(carol)).toBe(10_000)
  })

  it('rejects a payment that is not ours, or worth less than claimed', async () => {
    const p = await createBrc29Payment(alice, bob.identityKey, 5_000)
    await expect(acceptBrc29Payment(mallory, p, chain.chainTracker)).rejects.toThrow(/not locked to our key/)
    await expect(acceptBrc29Payment(bob, { ...p, satoshis: 50_000 }, chain.chainTracker)).rejects.toThrow(/not 50000/)
    await acceptBrc29Payment(bob, p, chain.chainTracker)
  })
})

describe('1Sat Ordinals NFTs on a BRC-100 wallet', () => {
  let alice: Wallet, bob: Wallet
  let ka: OrdinalKit, kb: OrdinalKit
  let origin: string

  it('mints an NFT at output 0 into the ordinals basket', async () => {
    ;[alice, bob] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    await chain.fund(bob) // pays the fee when sending it back
    ka = new OrdinalKit(alice)
    kb = new OrdinalKit(bob)
    const minted = await ka.mint('text/plain', 'Hello from the BSV Blockchain')
    origin = minted.origin
    expect(origin).toBe(`${minted.txid}_0`)
    const [nft] = await ka.list()
    expect(nft).toMatchObject({ origin, contentType: 'text/plain' })
    expect(Buffer.from(nft.data!).toString('utf8')).toBe('Hello from the BSV Blockchain')
  })

  it('transfers it to another identity key; the ordinal stays at input 0 → output 0', async () => {
    const [nft] = await ka.list()
    const delivery = await ka.transfer(nft.outpoint, bob.identityKey)
    const tx = Transaction.fromAtomicBEEF(delivery.tx)
    expect(`${tx.inputs[0].sourceTXID}.${tx.inputs[0].sourceOutputIndex}`).toBe(nft.outpoint)
    expect(tx.outputs[0].satoshis).toBe(1)
    await expect(new OrdinalKit(alice).receive(delivery)).rejects.toThrow(/not a 1-sat output locked to our key/)
    await kb.receive(delivery)
    expect(await ka.list()).toHaveLength(0)
    const [received] = await kb.list()
    expect(received).toMatchObject({ origin, contentType: 'text/plain', outpoint: `${delivery.txid}.0` })
  })

  it('the recipient can move it on (back to Alice), keeping the origin', async () => {
    const [nft] = await kb.list()
    const delivery = await kb.transfer(nft.outpoint, alice.identityKey)
    await ka.receive(delivery)
    const [back] = await ka.list()
    expect(back.origin).toBe(origin)
    expect(await kb.list()).toHaveLength(0)
  })
})

describe('authenticated airdrop (BRC-103/104)', () => {
  let server: Server
  let url: string
  let treasury: Wallet, dave: Wallet

  beforeAll(async () => {
    treasury = await chain.makeWallet()
    await chain.fund(treasury)
    dave = await chain.makeWallet()
    await new Promise<void>(resolve => { server = createAirdropApp(treasury, { satoshis: 2_000 }).listen(18092, resolve) })
    url = 'http://localhost:18092'
  })
  afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

  it('refuses a request that is not mutually authenticated', async () => {
    const res = await fetch(`${url}/airdrop/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.ok).toBe(false)
  })

  it('pays the verified caller once; the second claim is refused', async () => {
    const client = new AuthFetch(dave)
    const first = await client.fetch(`${url}/airdrop/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(first.status).toBe(200)
    const payment = await first.json() as Brc29Payment
    expect(payment.satoshis).toBe(2_000) // the server decides the amount
    await acceptBrc29Payment(dave, payment, chain.chainTracker)
    expect(await spendableSats(dave)).toBe(2_000)
    const second = await client.fetch(`${url}/airdrop/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(second.status).toBe(409)
  })
})
```

### `test/pay-per-request.e2e.test.ts`

```typescript
/**
 * Pay-per-request APIs (HTTP 402), end to end with real wallet-toolbox wallets
 * on the mock chain: the client pays automatically, the merchant's balance
 * grows at once, and a replayed payment is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { AuthFetch, P2PKH, PublicKey, Random, Utils } from '@bsv/sdk'
import { constructPaymentHeaders, create402Fetch } from '@bsv/402-pay/client'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createBrc105App, createBrc121App, withHostOriginator } from '../examples/payPerRequest'
import { createMockChain, type MockChain } from './helpers/mockchain'

let chain: MockChain
const spendableSats = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
const listen = async (app: any, port: number): Promise<Server> => await new Promise(resolve => { const s = app.listen(port, () => resolve(s)) })

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { await chain?.close() })

describe('BRC-105: authenticated pay-per-request (AuthFetch pays automatically)', () => {
  let merchant: Wallet, alice: Wallet, server: Server
  const url = 'http://localhost:18093'

  beforeAll(async () => {
    ;[merchant, alice] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(alice)
    server = await listen(createBrc105App(merchant, { '/premium': 500 }), 18093)
  })
  afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

  it('serves a free route without payment', async () => {
    const res = await new AuthFetch(alice).fetch(`${url}/free`)
    expect(res.status).toBe(200)
    expect((await res.json()).receipt).toMatchObject({ satoshisPaid: 0 })
  })

  it('answers 402, the client pays, and the merchant is credited at once', async () => {
    const before = await spendableSats(merchant)
    const res = await new AuthFetch(alice).fetch(`${url}/premium`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBe('premium data')
    expect(body.receipt).toMatchObject({ accepted: true, satoshisPaid: 500 })
    expect(await spendableSats(merchant)).toBe(before + 500)
  })

  it('refuses a replayed payment (409)', async () => {
    // Get a challenge without letting AuthFetch pay it.
    const probe = new AuthFetch(alice)
    ;(probe as any).handlePaymentAndRetry = async (_u: string, _c: unknown, r: Response) => r
    const challenge = await probe.fetch(`${url}/premium`)
    expect(challenge.status).toBe(402)
    const derivationPrefix = challenge.headers.get('x-bsv-payment-derivation-prefix')!
    const serverKey = challenge.headers.get('x-bsv-auth-identity-key')!
    // Pay it by hand, exactly as AuthFetch does (BRC-29 output 0 to the server).
    const derivationSuffix = Utils.toBase64(Random(32))
    const { publicKey } = await alice.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: serverKey })
    const created = await alice.createAction({
      description: 'Pay for a premium request',
      outputs: [{ satoshis: 500, lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex(), outputDescription: 'HTTP request payment' }],
      options: { randomizeOutputs: false }
    })
    const header = JSON.stringify({ derivationPrefix, derivationSuffix, transaction: Utils.toBase64(Array.from(created.tx!)) })
    const client = new AuthFetch(alice)
    const first = await client.fetch(`${url}/premium`, { headers: { 'x-bsv-payment': header } })
    expect(first.status).toBe(200)
    const replay = await client.fetch(`${url}/premium`, { headers: { 'x-bsv-payment': header } })
    expect(replay.status).toBe(409)
  })
})

describe('BRC-121: simple 402 payments (no auth handshake)', () => {
  let merchant: Wallet, bob: Wallet, server: Server
  const url = 'http://localhost:18094'

  beforeAll(async () => {
    ;[merchant, bob] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(bob)
    server = await listen(createBrc121App(merchant, 100), 18094)
  })
  afterAll(async () => { await new Promise(resolve => server?.close(resolve)) })

  it('challenges an unpaid request with 402 and the price', async () => {
    const res = await fetch(`${url}/articles/hello`)
    expect(res.status).toBe(402)
    expect(res.headers.get('x-bsv-sats')).toBe('100')
    expect(res.headers.get('x-bsv-server')).toBe(merchant.identityKey)
  })

  it('create402Fetch pays automatically; the merchant is credited', async () => {
    const before = await spendableSats(merchant)
    const res = await create402Fetch({ wallet: withHostOriginator(bob) })(`${url}/articles/hello`)
    expect(res.status).toBe(200)
    expect((await res.json()).article).toBe('hello')
    expect(await spendableSats(merchant)).toBe(before + 100)
  })

  it('refuses the same payment headers twice (fresh 402)', async () => {
    const headers = await constructPaymentHeaders(withHostOriginator(bob), `${url}/articles/again`, 100, merchant.identityKey)
    const first = await fetch(`${url}/articles/again`, { headers: headers as unknown as Record<string, string> })
    expect(first.status).toBe(200)
    const replay = await fetch(`${url}/articles/again`, { headers: headers as unknown as Record<string, string> })
    expect(replay.status).toBe(402)
  })
})
```
