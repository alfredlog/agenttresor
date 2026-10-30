/**
 * Tells humans that a payment waits for approval, and that it was decided.
 * The dashboard polls, so its notifier does nothing; Telegram (block 3b) plugs
 * in behind the same interface.
 */
import type { PaymentRequestRecord } from './store.js'

export interface Notifier {
  approvalNeeded: (req: PaymentRequestRecord) => Promise<void>
  decided: (req: PaymentRequestRecord) => Promise<void>
}

export class DashboardNotifier implements Notifier {
  async approvalNeeded (): Promise<void> {}
  async decided (): Promise<void> {}
}

/** Fans out to every notifier; one failing does not stop the others. */
export class CompositeNotifier implements Notifier {
  constructor (private readonly notifiers: Notifier[]) {}

  async approvalNeeded (req: PaymentRequestRecord): Promise<void> {
    await this.all(n => n.approvalNeeded(req))
  }

  async decided (req: PaymentRequestRecord): Promise<void> {
    await this.all(n => n.decided(req))
  }

  private async all (call: (n: Notifier) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map(call))
    const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} notifier(s) failed`)
  }
}
