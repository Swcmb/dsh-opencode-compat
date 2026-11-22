// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPS_ALIAS_TARGETS,
  OPS_ALIAS_PARAMETERS,
  mapOpsArgs,
  registerOpsAliases,
} from '../lib/ops-aliases.js'

test('ops alias targets map onto dsh-ops public names', () => {
  assert.deepEqual(OPS_ALIAS_TARGETS, {
    read: 'ops_inspect_local_file',
    glob: 'ops_glob',
    grep: 'ops_grep',
    bash: 'ops_bash',
    ls: 'ops_glob',
    list: 'ops_glob',
  })
  for (const name of Object.keys(OPS_ALIAS_TARGETS)) {
    assert.ok(OPS_ALIAS_PARAMETERS[name], `${name} needs a parameter schema`)
    assert.equal(OPS_ALIAS_PARAMETERS[name].type, 'object')
  }
})

test('read normalizes filePath/path and clamps offset/limit', () => {
  assert.deepEqual(mapOpsArgs('read', { filePath: 'a.md' }), { path: 'a.md', offset: 1, limit: 400 })
  assert.deepEqual(mapOpsArgs('read', { path: 'b.md', offset: 0, limit: 5 }), { path: 'b.md', offset: 1, limit: 5 })
  assert.deepEqual(mapOpsArgs('read', { path: 'c.md', limit: 99_999 }), { path: 'c.md', offset: 1, limit: 10_000 })
  assert.deepEqual(mapOpsArgs('read', {}), { path: '.', offset: 1, limit: 400 })
})

test('glob wraps the OpenCode string pattern into the array form', () => {
  assert.deepEqual(mapOpsArgs('glob', { pattern: '**/*.ts' }), {
    path: '.',
    pattern: ['**/*.ts'],
    kind: 'file',
  })
  assert.deepEqual(mapOpsArgs('glob', { pattern: '*.md', path: 'docs' }), {
    path: 'docs',
    pattern: ['*.md'],
    kind: 'file',
  })
})

test('grep keeps include as a relative glob array', () => {
  assert.deepEqual(mapOpsArgs('grep', { pattern: 'TODO' }), {
    path: '.',
    pattern: 'TODO',
    outputMode: 'content',
  })
  assert.deepEqual(mapOpsArgs('grep', { pattern: 'TODO', include: '**/*.ts' }), {
    path: '.',
    pattern: 'TODO',
    outputMode: 'content',
    glob: ['**/*.ts'],
  })
})

test('bash synthesizes the required description and converts seconds', () => {
  assert.deepEqual(mapOpsArgs('bash', { command: 'ls -la' }), {
    command: 'ls -la',
    description: 'run: ls -la',
  })
  assert.deepEqual(mapOpsArgs('bash', { command: 'ls', timeout: 30 }), {
    command: 'ls',
    description: 'run: ls',
    timeoutMs: 30_000,
  })
  assert.deepEqual(mapOpsArgs('bash', { command: 'ls', timeoutMs: 5000, workdir: 'src' }), {
    command: 'ls',
    description: 'run: ls',
    workdir: 'src',
    timeoutMs: 5000,
  })
})

test('ls and list ask ops_glob for every entry kind', () => {
  for (const alias of ['ls', 'list']) {
    assert.deepEqual(mapOpsArgs(alias, { path: 'src' }), {
      path: 'src',
      pattern: ['*'],
      kind: 'all',
      sort: 'path',
      limit: 200,
    })
  }
})

test('aliases delegate to the real definition and survive a missing target', async () => {
  const registered = new Map()
  const tools = {
    register(definition) {
      registered.set(definition.name, definition)
    },
    get(name) {
      if (name !== 'ops_inspect_local_file') return undefined
      return {
        name,
        execute: async (args) => `read ${args.path} lines ${args.offset}..${args.offset + args.limit - 1}`,
      }
    },
  }
  const root = {
    inject: (_services, run) => run({ tools }),
    on: () => {},
  }
  registerOpsAliases(root, () => {})

  const read = registered.get('read')
  assert.equal(typeof read.execute, 'function')
  assert.equal(await read.execute({ filePath: 'a.md', limit: 3 }, {}), 'read a.md lines 1..3')

  const glob = registered.get('glob')
  const missed = await glob.execute({ pattern: '*.md' }, {})
  assert.equal(missed.ok, false)
  assert.match(missed.message, /not available in this session/)
})
