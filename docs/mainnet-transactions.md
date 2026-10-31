# AgentTresor on BSV mainnet

Real transactions made with AgentTresor on BSV mainnet. Each link opens the transaction on WhatsOnChain.

| Step | What it proves | Transaction |
|---|---|---|
| v1 vault funded from BSV Desktop (10,000 sats) | company funds, key stays in its wallet | [8c10f1e1…60c398](https://whatsonchain.com/tx/8c10f1e1d2e8aacbb1b00a7a9ed0d6b8e179b1312d708ce5b31152c33a60c398) |
| AI agent pays the merchant from the v1 vault (block 973,394, fee 36 sats) | agent + policy signatures, change back to the vault, BRC-121 | [413d699d…a9db40](https://whatsonchain.com/tx/413d699db2f025615bf99dda1dd432d51219467a14430835379d4e5830a9db40) |
| v2 covenant vault funded (3,000 sats) | covenant vault from BSV Desktop | [1fb01fd1…0447b2](https://whatsonchain.com/tx/1fb01fd1b30c4bbcbd3904c1a451640fe1ef70255ef12167ce9cd3725d0447b2) |
| v2 vault reclaimed by the company alone | exit path always open | [27ed255a…da7d40](https://whatsonchain.com/tx/27ed255aac04778782b76f6dcad099ebf57ec8a92a5b25a98e506a4585da7d40) |
| v2 covenant vault funded (5,000 sats) |  | [a9de79af…133c7e](https://whatsonchain.com/tx/a9de79af702c3a3f353fed2b81de30a94dbf848ef0e75704ebe157affb133c7e) |
| AI agent pays from the v2 covenant vault (fee 281 sats) | covenant executed by every node; audit anchor in the same tx | [a4a47b9a…4f6848](https://whatsonchain.com/tx/a4a47b9a98fd7c6af22970a0558ede997f0e84e113ad84af2596eb9e9b4f6848) |
| AI agent pays under euro budget rules | limits in EUR, converted at payment time | [74768147…965d1b](https://whatsonchain.com/tx/7476814714ffbeb17672e90d3243553913ba4fb193b959fb93d60a60fa965d1b) |
| Audit log anchored by the notary (26 sats) | every event on-chain within minutes | [6c8aec1c…d56772](https://whatsonchain.com/tx/6c8aec1c04b13591c2e015e23db6e431bdb40a043063974cfabf55cbecd56772) |

**Check the covenant yourself:** open the v2 payment on WhatsOnChain, *Scripts* tab: the input and the change output have the same ScriptHash (the change goes back into the same covenant vault), and the transaction's nLockTime is non-zero (the covenant's signature grinding).
