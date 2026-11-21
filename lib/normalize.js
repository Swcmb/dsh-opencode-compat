// @ianwusb/dsh-opencode-compat — pure helpers: tool aliases, argument
// normalization and readable hints. No DSH internals, no npm dependencies.
//
// Scope after cleanup:
//   - shell -> native DSH pwsh (delegated; never self-spawned)
//   - todowrite -> todo_write
//   - webfetch -> web_fetch
//   - websearch -> web_search
// Same-name aliases (read/write/edit/glob/grep) were removed: a profile-root
// plugin cannot register them without colliding with the native global tool.

export const TOOL_NAME_MAP = Object.freeze({
  shell: 'pwsh',
  todowrite: 'todo_write',
  webfetch: 'web_fetch',
  websearch: 'web_search',
})

export const ALIAS_NAMES = Object.freeze(Object.keys(TOOL_NAME_MAP))

/** Upper bound for a delegated shell timeout. */
export const MAX_TIMEOUT_MS = 600_000

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function shallowArgs(args) {
  if (!isRecord(args)) return {}
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export function clampTimeoutMs(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS)
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function synthesizeDescription(command, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const text = `Run: ${command}`
  return text.length > 80 ? `${text.slice(0, 80)}` : text
}

/**
 * OpenCode shell {command, workdir?, timeout?} -> DSH pwsh
 * {command, workdir?, timeoutMs?, description}. DSH pwsh requires
 * description and command. The alias runs through the native pwsh tool, so
 * DSH's own sandbox, blacklist and approval chain still apply.
 */
export function normalizeShellArgs(args = {}) {
  const raw = isRecord(args) ? args : {}
  const command = typeof raw.command === 'string' ? raw.command : ''
  if (command.trim() === '') {
    return {
      ok: false,
      error: {
        code: 'MISSING_COMMAND',
        message: 'shell 别名需要字符串参数 command（要执行的 PowerShell 命令）。',
      },
    }
  }
  return {
    ok: true,
    command,
    workdir: firstNonEmpty(raw.workdir),
    timeoutMs: clampTimeoutMs(raw.timeoutMs) ?? clampTimeoutMs(raw.timeout),
    description: synthesizeDescription(command, raw.description),
  }
}

/** web_fetch accepts {url} only. */
export function normalizeWebFetchArgs(args = {}) {
  const raw = shallowArgs(args)
  return raw.url !== undefined ? { url: raw.url } : raw
}

/** web_search accepts {queries: string[]}; OpenCode sends {query: string}. */
export function normalizeWebSearchArgs(args = {}) {
  const raw = shallowArgs(args)
  if (raw.queries !== undefined || raw.query === undefined) return raw
  return {
    ...raw,
    queries: Array.isArray(raw.query) ? raw.query : [raw.query],
  }
}

/** todo_write and the remaining passthrough aliases share argument shapes. */
export function normalizePassthroughArgs(args = {}) {
  return shallowArgs(args)
}

const NORMALIZERS = Object.freeze({
  shell: normalizeShellArgs,
  todowrite: normalizePassthroughArgs,
  webfetch: normalizeWebFetchArgs,
  websearch: normalizeWebSearchArgs,
})

export function normalizeGenericArgs(alias, args = {}) {
  const fn = NORMALIZERS[alias]
  return fn ? fn(args) : shallowArgs(args)
}

export function normalizeAliasArgs(alias, args = {}) {
  return normalizeGenericArgs(alias, args)
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Render any lossless JSON value as readable text. */
export function renderValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return String(value)
  if (isRecord(value) && typeof value.message === 'string') {
    const { message, ...rest } = value
    return message + (Object.keys(rest).length ? '\n' + safeStringify(rest) : '')
  }
  return safeStringify(value)
}

/** Explain the correct native tool name without throwing unknown-tool. */
export function aliasHint(alias, target, normalizedArgs, reason) {
  return {
    ok: false,
    alias,
    useTool: target,
    message: `DSH 中不存在工具 "${alias}"。请改用 "${target}"；本兼容别名当前无法直接委托，已按 DSH 约定归一化参数，可据此重试。`,
    reason,
    normalizedArgs,
  }
}
