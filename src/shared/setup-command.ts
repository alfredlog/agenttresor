/**
 * The one command the dashboard and the connect page show for a connection
 * link: `npm run setup "<connectUrl>"`. The link goes in double quotes so zsh
 * keeps the #fragment (unquoted, `#` starts a comment there). Bundled for the
 * browser as public/setup-command.js (npm run build:web).
 */

// Characters a connect link may hold that are inert inside double quotes in sh, bash and zsh
// (no $, `, \, " or !, which would expand or end the quoted string).
const SAFE_LINK = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@&+,;=%-]+$/

/** `npm run setup "<connectUrl>"`; throws for a link that is not safe to paste into a shell. */
export function setupCommand (connectUrl: string): string {
  if (!SAFE_LINK.test(connectUrl)) throw new Error('not a connection link that can be pasted into a shell')
  return `npm run setup "${connectUrl}"`
}
