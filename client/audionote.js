/*
 * Federated Wiki : Audio Note Plugin — loader
 *
 * wiki-client fetches a plugin at one fixed address, /plugins/audionote/audionote.js,
 * and wiki-server tells browsers to keep it for an hour. An update therefore
 * reached nobody for up to an hour — and because plugins are imported after the
 * page has loaded, not even a hard reload fetched it. People ran old code
 * against a new server and met bugs already fixed.
 *
 * So this file stays small and stable, and asks — never from cache — which
 * version is installed, then imports the real plugin under that version. A new
 * release is a new address: it arrives on the next page load, everywhere.
 *
 * Licensed under the MIT license.
 */

let version = ''
try {
  const res = await fetch(new URL('./version.json', import.meta.url), { cache: 'no-store' })
  if (res.ok) version = (await res.json()).version || ''
} catch {
  // offline, or an odd server: fall through and load whatever the cache holds
}

await import(`./main.js${version ? `?v=${encodeURIComponent(version)}` : ''}`)
