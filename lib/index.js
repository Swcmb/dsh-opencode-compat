// @ianwusb/dsh-opencode-compat — register a small set of safe OpenCode-style
// tool aliases. Shell aliases delegate to native DSH pwsh; the plugin never
// spawns PowerShell itself and never registers a same-name alias.
//
// Constraints:
//  - Only Node built-ins and cordis' public tools API.
//  - Tools register in the normal registry, so DSH approval/guard/audit apply.
//  - No @deepseek-ai/* imports.

import {
  TOOL_NAME_MAP,
  ALIAS_NAMES,
  normalizeAliasArgs,
  aliasHint,
  renderValue,
} from './normalize.js'

export * from './normalize.js'

export const name = 'opencode-compat'
export const inject = ['tools']

const ANY_OUTPUT = Object.freeze({
  schema: {},
  render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
})

const field = (type, description) => ({
  type,
  ...(description ? { description } : {}),
})

export const PARAMETERS = Object.freeze({
  shell: {
    type: 'object',
    properties: {
      command: field('string', '要执行的 PowerShell 命令'),
      workdir: field('string', '工作目录'),
      timeout: field('number', '超时毫秒数'),
      description: field('string', '命令描述；缺失时由 command 生成'),
    },
    required: ['command'],
    additionalProperties: true,
  },
  todowrite: {
    type: 'object',
    properties: {
      todos: { type: 'array', items: field('object'), description: '完整替换的任务列表，元素 {content,status}' },
    },
    additionalProperties: true,
  },
  webfetch: {
    type: 'object',
    properties: { url: field('string', '要抓取的 URL') },
    required: ['url'],
    additionalProperties: true,
  },
  websearch: {
    type: 'object',
    properties: {
      query: field('string', 'OpenCode 风格单条查询（会转成 queries 数组）'),
      queries: { type: 'array', items: field('string'), description: 'DSH 风格查询数组' },
    },
    additionalProperties: true,
  },
})

function makeTool(alias, description, execute) {
  return {
    name: alias,
    description,
    parameters: PARAMETERS[alias] ?? { type: 'object', properties: {}, additionalProperties: true },
    output: ANY_OUTPUT,
    isConcurrencySafe: () => false,
    execute,
  }
}

function resolveDefinition(tools, target) {
  if (!tools || typeof target !== 'string') return undefined
  for (const key of ['get', 'executable']) {
    if (typeof tools[key] !== 'function') continue
    try {
      const def = tools[key].call(tools, target)
      if (def && typeof def.execute === 'function') return def
    } catch {
      // Some implementations require extra scope/toolSet arguments.
    }
  }
  return undefined
}

function resolveInvoker(tools) {
  for (const key of ['invoke', 'call']) {
    if (typeof tools?.[key] === 'function') {
      return (target, args, exec) => tools[key].call(tools, target, args, exec)
    }
  }
  return null
}

function toLossless(value) {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function serializeError(error) {
  const e = error instanceof Error ? error : new Error(String(error))
  return {
    name: e.name || 'Error',
    message: e.message || String(error),
    ...(e.code !== undefined ? { code: String(e.code) } : {}),
  }
}

function delegateFailure(alias, target, normalized, error, mode) {
  return {
    ok: false,
    alias,
    delegatedTo: target,
    mode,
    message: `已把 "${alias}" 的参数归一化后委托给 "${target}"，但真实工具执行失败；请检查参数或直接调用 "${target}"。`,
    error: serializeError(error),
    normalizedArgs: normalized,
  }
}

async function delegate(alias, target, args, exec, tools, nativeDef) {
  const normalized = normalizeAliasArgs(alias, args)
  if (normalized?.ok === false) return normalized

  const invoker = resolveInvoker(tools)
  if (invoker) {
    try {
      return toLossless(await invoker(target, normalized, exec))
    } catch (error) {
      return delegateFailure(alias, target, normalized, error, 'invoke')
    }
  }

  const def = nativeDef ?? resolveDefinition(tools, target)
  if (def && typeof def.execute === 'function') {
    try {
      return toLossless(await def.execute(normalized, exec))
    } catch (error) {
      return delegateFailure(alias, target, normalized, error, 'definition')
    }
  }

  return aliasHint(
    alias,
    target,
    normalized,
    '运行时未找到可委托的真实工具定义（工具未注册、被 restrict 或 DSH 版本差异）',
  )
}

/**
 * Build the alias tools without registering them.
 * @returns {{tools: object[], forwarding: boolean, captured: string[]}}
 */
export function buildAliasTools(tools) {
  const result = { tools: [], forwarding: false, captured: [] }
  const native = new Map()
  for (const target of new Set(ALIAS_NAMES.map((alias) => TOOL_NAME_MAP[alias]))) {
    const def = resolveDefinition(tools, target)
    if (def) {
      native.set(target, def)
      result.captured.push(target)
    }
  }
  for (const alias of ALIAS_NAMES) {
    const target = TOOL_NAME_MAP[alias]
    const nativeDef = native.get(target)
    const detail = alias === 'shell'
      ? 'Delegates to the native DSH pwsh tool; DSH sandbox, command policy and approval chain still apply.'
      : `Compatibility alias for OpenCode-style ${alias} calls; maps to DSH "${target}".`
    result.tools.push(makeTool(
      alias,
      `Compatibility alias for OpenCode-style ${alias} calls. ${detail}`,
      (args, exec) => delegate(alias, target, args, exec, tools, nativeDef),
    ))
  }
  result.forwarding = Boolean(resolveInvoker(tools)) || native.size > 0
  return result
}

export function apply(ctx) {
  if (!ctx) return
  const log = (scoped, message) => {
    try {
      const logger = scoped?.logger ?? ctx?.logger
      if (typeof logger?.info === 'function') logger.info('[dsh-opencode-compat] %s', message)
      else console.warn('[dsh-opencode-compat] ' + message)
    } catch {
      /* logging must not break the host */
    }
  }

  const run = (scoped) => {
    const tools = scoped?.tools
    if (!tools || typeof tools.register !== 'function') {
      log(scoped, 'tools 服务不可用或缺少 register()，跳过注册')
      return
    }
    const { tools: built, forwarding, captured } = buildAliasTools(tools)
    const registered = []
    for (const tool of built) {
      try {
        tools.register(tool)
        registered.push(tool.name)
      } catch (error) {
        log(scoped, `注册 "${tool.name}" 失败：${error?.message ?? error}`)
      }
    }
    log(
      scoped,
      `已注册 ${registered.length} 个别名：${registered.join(', ')}；转发=${forwarding}；捕获=${captured.join(',') || '无'}`,
    )
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], run)
      return
    } catch (error) {
      log(null, `ctx.inject 失败，回退直接注册：${error?.message ?? error}`)
    }
  }
  run(ctx)
}
