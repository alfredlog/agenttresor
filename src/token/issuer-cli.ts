import dotenv from 'dotenv'
import { openServerWallet } from '../shared/wallet.js'
import { getNetwork } from '../shared/network.js'
import { OverlayClient } from './overlayApi.js'
import { TokenKit } from './token.js'

dotenv.config()

function required (name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') throw new Error(`${name} must be set in .env`)
  return value
}

function positiveAmount (value: string, name: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive whole number`)
  return BigInt(value)
}

async function main (): Promise<void> {
  const network = getNetwork()
  if (network !== 'test') {
    throw new Error('Token issuer CLI is testnet-only. Set BSV_NETWORK=test in .env.')
  }

  const [command, ...args] = process.argv.slice(2)
  const overlayUrl = required('BSV21_OVERLAY_URL')
  const companyIdentityKey = required('BSV21_COMPANY_IDENTITY_KEY')

  const company = await openServerWallet({
    rootKeyEnv: 'BSV21_COMPANY_PRIVATE_KEY',
    filePath: './data/bsv21-company-wallet.sqlite',
    network
  })

  try {
    if (company.identityKey !== companyIdentityKey) {
      throw new Error('BSV21_COMPANY_IDENTITY_KEY does not match BSV21_COMPANY_PRIVATE_KEY')
    }

    const kit = new TokenKit(
      company.wallet,
      new OverlayClient(overlayUrl, undefined, network)
    )

    if (command === 'deploy') {
      const [sym, supplyText, decimalsText] = args
      if (sym === undefined || supplyText === undefined || decimalsText === undefined) {
        throw new Error('Usage: npm run token:issuer -- deploy SYMBOL SUPPLY DECIMALS')
      }

      const supply = positiveAmount(supplyText, 'SUPPLY')
      const decimals = Number(decimalsText)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new Error('DECIMALS must be an integer from 0 to 18')
      }

      const deployed = await kit.deploy({ sym, amt: supply, dec: decimals })
      console.log(`Token deployed: ${deployed.tokenId}`)
      console.log(`Deployment transaction: ${deployed.txid}`)
      console.log('Copy the token ID into BSV21_TOKEN_ID in .env.')
      return
    }

    if (command === 'send') {
      const [tokenId, recipientIdentityKey, amountText] = args
      if (tokenId === undefined || recipientIdentityKey === undefined || amountText === undefined) {
        throw new Error('Usage: npm run token:issuer -- send TOKEN_ID RECIPIENT_IDENTITY_KEY AMOUNT')
      }

      const amount = positiveAmount(amountText, 'AMOUNT')
      await kit.sync()
      const sent = await kit.send(tokenId, amount, recipientIdentityKey)
      console.log(`Transferred ${amount} token units.`)
      console.log(`Transaction: ${sent.txid}`)
      return
    }

    throw new Error('Choose "deploy" or "send".')
  } finally {
    await company.close()
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})