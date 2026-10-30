@AGENTS.md

# AgentTresor
Non-custodial spend control for AI agents on BSV (TUM Blockchain & AI Hackathon 2026, BSV track).
Companies lock a budget in an on-chain vault (2-of-2: agent AND policy, or the company alone);
agents pay merchants with BRC-121 only when the company's rules allow it.

## Project rules
- Read docs/BSV_STACK_COMPLETE_GUIDE.md before any BSV code; prefer its Appendix A code and
  docs/starter-kit/ over code from memory.
- TypeScript, Node >= 22. Comments in English. Small steps; tests for every flow (wallet-toolbox mock chain).
- Never commit .env, keys or wallet databases; never print keys.
- Do NOT run git commit or git push: the developer reviews and commits.