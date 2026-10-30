/**
 * `npm run audit:verify [-- path/to/proxy.sqlite]`: checks the audit log hash
 * chain and every on-chain anchor. Prints hashes and txids only, no secrets.
 * Exit code 0 if everything holds, 1 otherwise.
 */
import { verifyDatabase } from './verify-db.js'

const file = process.argv[2] ?? './data/proxy.sqlite'
const report = await verifyDatabase(file)

console.log(`audit log: ${file}`)
console.log(`entries:   ${report.entries} (head #${report.head.seq} ${report.head.hash})`)
console.log(report.ok ? 'chain:     valid' : `chain:     BROKEN at #${report.brokenAt}: ${report.reason}`)
for (const a of report.anchors) {
  console.log(`anchor:    #${a.seq} ${a.matches ? 'matches' : 'DOES NOT MATCH'} the log (tx ${a.txid})`)
}
if (report.anchors.length === 0) console.log('anchors:   none yet (anchor the head from the dashboard)')
const allGood = report.ok && report.anchors.every(a => a.matches)
console.log(allGood ? 'result:    OK' : 'result:    TAMPERED')
process.exit(allGood ? 0 : 1)
