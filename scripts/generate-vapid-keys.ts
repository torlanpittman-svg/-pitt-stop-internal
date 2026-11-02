/**
 * Generate the VAPID keypair used to sign Web Push messages.
 *
 *   npx tsx scripts/generate-vapid-keys.ts
 *
 * Run ONCE per environment. The keypair is ours alone — there is no account to create, nothing to
 * register with Apple or Google, and no third-party service involved. The public key is handed to
 * browsers so they can create a subscription; the PRIVATE key only ever signs the request we make
 * to the push service and must stay in server-side environment variables.
 *
 * Read-only: it touches no database and writes no file. Copy the output into the environment
 * yourself (Vercel → Settings → Environment Variables, and .env.local for local work), then keep it.
 * Rotating these keys invalidates every existing device subscription — everyone has to tap
 * "Enable notifications on this device" again.
 */
import { generateVapidKeys, vapidKeysMatch } from '../apps/staff-alerts/web-push'

const keys = generateVapidKeys()
if (!vapidKeysMatch(keys)) {
  console.error('Generated keypair failed its own check — do not use it. Run again.')
  process.exit(1)
}

console.log(`
VAPID keypair generated. Set these three variables in the target environment:

  VAPID_PUBLIC_KEY=${keys.publicKey}
  VAPID_PRIVATE_KEY=${keys.privateKey}
  VAPID_SUBJECT=mailto:you@yourshop.com

  • VAPID_PUBLIC_KEY   safe to send to browsers (the app serves it to enrolled devices).
  • VAPID_PRIVATE_KEY  SERVER ONLY. Never commit it, never put it in NEXT_PUBLIC_*, never paste it
                       into a chat or a ticket. Treat it like a password.
  • VAPID_SUBJECT      a mailto: address or https: URL a push service can use to contact the shop.

Until all three are set, bookings are still recorded and still shown in the app — devices just
cannot be enrolled and nothing is sent.
`)
