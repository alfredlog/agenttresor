/**
 * Network selection. BSV_NETWORK = main | test (default main) picks the Arcade
 * instance (guide §20) and the WhatsOnChain explorer used for links.
 */
export type BsvNetwork = 'main' | 'test'

export const ARCADE_URLS: Record<BsvNetwork, string> = {
  main: 'https://arcade-v2-us-1.bsvblockchain.tech',
  test: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'
}

const WOC_EXPLORERS: Record<BsvNetwork, string> = {
  main: 'https://whatsonchain.com',
  test: 'https://test.whatsonchain.com'
}

/** Reads BSV_NETWORK; throws on anything other than main or test. */
export function getNetwork (value = process.env.BSV_NETWORK): BsvNetwork {
  if (value === undefined || value === '') return 'main'
  if (value === 'main' || value === 'test') return value
  throw new Error(`BSV_NETWORK must be "main" or "test", got "${value}"`)
}

export function arcadeUrl (network: BsvNetwork = getNetwork()): string {
  return ARCADE_URLS[network]
}

export function txLink (txid: string, network: BsvNetwork = getNetwork()): string {
  return `${WOC_EXPLORERS[network]}/tx/${txid}`
}

export function addressLink (address: string, network: BsvNetwork = getNetwork()): string {
  return `${WOC_EXPLORERS[network]}/address/${address}`
}
