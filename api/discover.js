// discover.js — DNS-SD lookup of a tailnet service, MOVED to the shared door
// (@fortyfoxes/wiki-claude-door, Plan Tool Plan Phase 4), whose askOllama
// resolves its spec through it. Kept here as a re-export so anything that
// required ./discover.js still finds it. Node 22.12 or later.
module.exports = require('@fortyfoxes/wiki-claude-door/discover')
