import type { TopicManager } from '@bsv/overlay'
import { Transaction, type AdmittanceInstructions } from '@bsv/sdk'
import { identifyAdmissible, type RuleOptions } from '../rules'

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
