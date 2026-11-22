// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOOL_NAME_MAP,
  ALIAS_NAMES,
  MAX_TIMEOUT_MS,
  normalizeShellArgs,
  normalizeWebFetchArgs,
  normalizeWebSearchArgs,
  normalizeGenericArgs,
  renderValue,
  aliasHint,
} from '../lib/normalize.js'
import {
  PARAMETERS,
  buildAliasTools,
  apply,
} from '../lib/index.js'

test('tool map contains only safe aliases', () => {
  assert.deepEqual(TOOL_NAME_MAP, {
    shell: 'pwsh',
    todowrite: 'todo_write',
    webfetch: 'web_fetch',
    websearch: 'web_search',
  })
  assert.deepEqual([...ALIAS_NAMES].sort(), ['shell', 'todowrite', 'webfetch', 'websearch'])
  for (const forbidden of ['read', 'write', 'edit', 'glob', 'grep']) {
    assert.equal(forbidden in TOOL_NAME_MAP, false)
  }
})

test('shell normalization delegates to pwsh shape', () => {
  const out = normalizeShellArgs({
    command: 'Get-ChildItem',
    workdir: 'E:\\work',
    timeout: 5000,
    shell: 'pwsh',
  })
  assert.equal(out.ok, true)
  assert.equal(out.command, 'Get-ChildItem')
  assert.equal(out.workdir, 'E:\\work')
  assert.equal(out.timeoutMs, 5000)
  assert.match(out.description, /^Run: Get-ChildItem/)
  assert.equal(out.cwd, undefined)
})

test('shell normalization clamps timeout and requires command', () => {
  assert.equal(normalizeShellArgs({ command: 'x', timeoutMs: 999999999 }).timeoutMs, MAX_TIMEOUT_MS)
  const missing = normalizeShellArgs({})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'MISSING_COMMAND')
})

test('webfetch keeps only url', () => {
  assert.deepEqual(normalizeWebFetchArgs({ url: 'https://example.com', format: 'markdown' }), {
    url: 'https://example.com',
  })
})

test('websearch wraps query into queries', () => {
  assert.deepEqual(normalizeWebSearchArgs({ query: 'golang' }).queries, ['golang'])
  assert.deepEqual(normalizeWebSearchArgs({ queries: ['golang'] }).queries, ['golang'])
})

test('todowrite passes todos through', () => {
  const args = { todos: [{ content: 'a', status: 'pending' }] }
  assert.deepEqual(normalizeGenericArgs('todowrite', args), args)
})

test('parameters are standard JSON Schema objects', () => {
  for (const [alias, schema] of Object.entries(PARAMETERS)) {
    assert.equal(schema.type, 'object')
    assert.equal(typeof schema.properties, 'object')
    if (alias === 'shell' || alias === 'webfetch') assert.ok(Array.isArray(schema.required))
  }
})

function fakeTools(overrides = {}) {
  const definitions = {
    pwsh: { execute: async (args) => ({ tool: 'pwsh', args }) },
    todo_write: { execute: async (args) => ({ tool: 'todo_write', args }) },
    web_fetch: { execute: async (args) => ({ tool: 'web_fetch', args }) },
    web_search: { execute: async (args) => ({ tool: 'web_search', args }) },
    ...overrides,
  }
  return {
    get(name) {
      return definitions[name]
    },
    executable(name) {
      return definitions[name]
    },
  }
}

test('buildAliasTools registers four aliases and delegates shell to pwsh', async () => {
  const built = buildAliasTools(fakeTools())
  assert.deepEqual(built.tools.map((tool) => tool.name).sort(), ['shell', 'todowrite', 'webfetch', 'websearch'])
  assert.equal(built.forwarding, true)
  assert.deepEqual(built.captured.sort(), ['pwsh', 'todo_write', 'web_fetch', 'web_search'])

  const shell = built.tools.find((tool) => tool.name === 'shell')
  const value = await shell.execute({ command: 'Get-ChildItem', workdir: 'E:\\work' }, {})
  assert.equal(value.tool, 'pwsh')
  assert.equal(value.args.command, 'Get-ChildItem')
  assert.equal(value.args.workdir, 'E:\\work')
  assert.match(value.args.description, /^Run: /)
})

test('all alias tools have output and execute contracts', () => {
  const built = buildAliasTools(fakeTools())
  for (const tool of built.tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(tool.output.schema !== undefined)
  }
})

test('no forwarding returns readable hints instead of unknown tool', async () => {
  const built = buildAliasTools({})
  assert.equal(built.forwarding, false)
  const shell = built.tools.find((tool) => tool.name === 'shell')
  const value = await shell.execute({ command: 'Get-ChildItem' }, {})
  assert.equal(value.ok, false)
  assert.equal(value.useTool, 'pwsh')
})

test('delegation failure is structured', async () => {
  const built = buildAliasTools(fakeTools({
    web_search: {
      execute: async () => {
        throw new Error('boom')
      },
    },
  }))
  const websearch = built.tools.find((tool) => tool.name === 'websearch')
  const value = await websearch.execute({ query: 'x' }, {})
  assert.equal(value.ok, false)
  assert.equal(value.delegatedTo, 'web_search')
  assert.equal(value.error.message, 'boom')
})

test('apply registers the global aliases and the ops_* layer via ctx.inject', () => {
  const registered = []
  const tools = fakeTools()
  tools.register = (tool) => registered.push(tool)
  const ctx = {
    logger: { info() {} },
    inject(services, run) {
      assert.deepEqual(services, ['tools'])
      run({ tools })
    },
  }
  apply(ctx)
  const names = registered.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'bash',
    'glob',
    'grep',
    'list',
    'ls',
    'read',
    'shell',
    'todowrite',
    'webfetch',
    'websearch',
  ])
})

test('renderValue and aliasHint remain readable', () => {
  assert.equal(renderValue({ message: 'm', code: 'x' }), 'm\n{\n  "code": "x"\n}')
  const hint = aliasHint('shell', 'pwsh', { command: 'x' }, 'test')
  assert.equal(hint.ok, false)
  assert.equal(hint.useTool, 'pwsh')
  assert.match(hint.message, /pwsh/)
})
