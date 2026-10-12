/**
 * The RPC contract shared by this plugin's two halves.
 *
 * Deliberately free of host-only and browser-only imports: the host half
 * registers the channel and the browser half calls it, and the client bundle
 * may only `require` the shell-seeded platform modules — so this module must
 * stay plain constants and types that both programs can include.
 * @module @studyzy/dsh-suggest-prompt/rpc-contract
 */

/**
 * The browser-facing RPC channel this plugin owns. Absolute by contract
 * (`/^\/[A-Za-z0-9._~-]+$/`), and never the reserved `/api`.
 */
export const SUGGEST_RPC_CHANNEL = '/suggest-prompt'

/**
 * Endpoint returning the latest stored suggestion for one session.
 * Payload `{ sessionId }`; result is the suggestion payload or `null`.
 */
export const SUGGEST_RPC_GET = 'get'