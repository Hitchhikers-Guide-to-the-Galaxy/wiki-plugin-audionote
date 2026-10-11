// discover.js — the parts that need no network: TXT parsing and spec parsing.
const assert = require('node:assert/strict')
const { txtFields, parse, resolve } = require('../api/discover.js')

// our doh-proxy sends TXT strings bare; dns.google quotes them
assert.deepEqual(txtFields([{ data: 'txtvers=1 model=qwen3:4b proto=https scope=tailnet' }]), { txtvers: '1', model: 'qwen3:4b', proto: 'https', scope: 'tailnet' })
assert.deepEqual(txtFields([{ data: '"txtvers=1" "model=qwen3:4b"' }]), { txtvers: '1', model: 'qwen3:4b' })
assert.equal(parse('dnssd:qwen._ollama._tcp.names.private.fish').name, 'qwen._ollama._tcp.names.private.fish')
assert.throws(() => parse('dnssd:qwen.names.private.fish'))
;(async () => {
  assert.equal(await resolve('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434') // a plain URL is used as is
  process.env.DNSSD_DOH = 'x'
  console.log('discover: ok')
})()
