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
