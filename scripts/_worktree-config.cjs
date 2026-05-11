#!/usr/bin/env node
// Read/write `.quartz-pty-worktree.json` at the repo root.
// Mirrors `claude_pty/scripts/_worktree-config.js` so the two repos
// have the same launcher idiom.
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const file = path.join(ROOT, '.quartz-pty-worktree.json')
const cmd = process.argv[2]

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  return {}
}

if (cmd === 'path') {
  process.stdout.write(file)
  process.exit(0)
}

if (cmd === 'read') {
  const field = process.argv[3]
  const config = readConfig()
  if (!field) {
    process.stdout.write(JSON.stringify(config, null, 2))
  } else {
    process.stdout.write(String(config[field] ?? ''))
  }
  process.exit(0)
}

console.error('usage: _worktree-config.js {path|read [field]}')
process.exit(2)
