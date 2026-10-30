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
