// @ianwusb/dsh-opencode-compat — ops_* aliases for the names this DSH build
// does not register itself.
//
// Why this is a separate layer from the aliases in index.js:
//   `shell`/`todowrite`/`webfetch`/`websearch` are profile-global aliases whose
//   targets are global tools. The file names below are different: the real tools
//   (`ops_inspect_local_file`, `ops_glob`, `ops_grep`, `ops_bash`) are published
//   by dsh-ops into each agent's own scope, and the kernel also registers the
//   official `read`/`glob`/`grep` there a few seconds after the agent is created.
//
//   So this layer registers twice: once inside `agent.ctx` (same scope as the
//   targets, and impossible for a host-side tools.restrict({deny}) to mask) and
//   once globally as a fallback. Where the official names already exist the
//   kernel refuses the duplicate registration with
//   `tool "read" is already registered in this scope`; that is expected and is
//   logged, never retried.
//
// What is actually gained:
//   `read`/`glob`/`grep`  — cover the window before the official tools land
//   `bash`/`ls`/`list`    — real gaps: this kernel never registers those names
//                           (the command tool is `ops_bash` / `pwsh`)
//
// Delegation never re-implements anything: the alias resolves the real
// definition and calls its own `execute`, so DSH keeps argument validation,
// sandboxing, approvals and rendering.

/** Alias -> real tool name, as published by dsh-ops. */
export const OPS_ALIAS_TARGETS = Object.freeze({
  read: 'ops_inspect_local_file',
  glob: 'ops_glob',
  grep: 'ops_grep',
  bash: 'ops_bash',
  ls: 'ops_glob',
  list: 'ops_glob',
})

const str = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined)
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Map an OpenCode-shaped call onto the real tool's argument object. */
export function mapOpsArgs(alias, args = {}) {
  const raw = args !== null && typeof args === 'object' ? args : {}
  const path = str(raw.filePath) ?? str(raw.file_path) ?? str(raw.path)
  switch (alias) {
    case 'read':
      return {
        path: path ?? '.',
        offset: Math.max(1, num(raw.offset) ?? 1),
        limit: Math.min(10_000, Math.max(1, num(raw.limit) ?? 400)),
      }
    case 'glob':
      return { path: path ?? '.', pattern: [str(raw.pattern) ?? '**/*'], kind: 'file' }
    case 'grep': {
      const out = { path: path ?? '.', pattern: str(raw.pattern) ?? '', outputMode: 'content' }
      const include = str(raw.include)
      if (include) out.glob = [include]
      return out
    }
    case 'bash': {
      const command = str(raw.command) ?? str(raw.cmd) ?? ''
      const out = {
        command,
        description: str(raw.description) ?? `run: ${command.trim().slice(0, 60) || 'shell command'}`,
      }
      const workdir = str(raw.workdir) ?? str(raw.cwd)
      if (workdir) out.workdir = workdir
      const timeout = num(raw.timeoutMs) ?? num(raw.timeout)
      if (timeout !== undefined) out.timeoutMs = timeout <= 1000 ? timeout * 1000 : timeout
      return out
    }
    case 'ls':
    case 'list':
      return { path: path ?? '.', pattern: ['*'], kind: 'all', sort: 'path', limit: num(raw.limit) ?? 200 }
    default:
      return raw
  }
}

/** Model-facing parameter schema per alias. */
export const OPS_ALIAS_PARAMETERS = Object.freeze({
  read: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'File to read, absolute or relative to the session workspace.' },
      path: { type: 'string', description: 'Alias of filePath.' },
      offset: { type: 'integer', description: '1-based first line; default 1.' },
      limit: { type: 'integer', description: 'Maximum lines; default 400.' },
    },
  },
  glob: {
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Search root; default the session workspace.' },
    },
  },
  grep: {
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Rust-style regular expression, e.g. "TODO|FIXME".' },
      path: { type: 'string', description: 'Search root; default the session workspace.' },
      include: { type: 'string', description: 'Only search files matching this relative glob.' },
    },
  },
  bash: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'Bash command or pipeline. Shell state does not persist.' },
      description: { type: 'string', description: 'Short active-voice description, 5–10 words.' },
      workdir: { type: 'string', description: 'Working directory relative to the session workspace.' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds; default 120000.' },
    },
  },
  ls: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory to list; default the session workspace.' } },
  },
  list: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory to list; default the session workspace.' } },
  },
})

const OPS_ALIAS_DESCRIPTIONS = Object.freeze({
  read: 'Read a UTF-8 text file and return numbered lines.',
  glob: 'Find files by glob pattern below a path.',
  grep: 'Search file contents with a regular expression.',
  bash: 'Execute a Bash command in the session workspace.',
  ls: 'List directory entries with byte sizes.',
  list: 'List directory entries with byte sizes.',
})

function renderText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function serialize(value) {
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

/** Resolve the delegation target inside one tools view. */
function resolveTarget(tools, target, agent, toolSet) {
  for (const key of ['get', 'executable']) {
    if (typeof tools[key] !== 'function') continue
    try {
      const definition = toolSet === undefined ? tools[key](target, agent) : tools[key](target, agent, toolSet)
      if (definition !== undefined) return definition
    } catch {
      /* some implementations reject a partial argument list */
    }
  }
  return undefined
}

function makeOpsDefinition(tools, alias, fallbackAgent) {
  const target = OPS_ALIAS_TARGETS[alias]
  return {
    name: alias,
    description: `${OPS_ALIAS_DESCRIPTIONS[alias]} Compatibility alias for the OpenCode-style "${alias}" call; delegates to "${target}".`,
    parameters: OPS_ALIAS_PARAMETERS[alias],
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent ?? fallbackAgent
      const definition = resolveTarget(tools, target, agent, exec?.toolSet)
      if (!definition || typeof definition.execute !== 'function') {
        return {
          ok: false,
          alias,
          delegatedTo: target,
          message: `${alias}: "${target}" is not available in this session, so the alias cannot delegate. Call "${target}" directly or use another file tool from your tool list.`,
        }
      }
      try {
        return serialize(await definition.execute(mapOpsArgs(alias, args), exec))
      } catch (error) {
        return {
          ok: false,
          alias,
          delegatedTo: target,
          message: `delegated "${alias}" to "${target}" and the real tool failed; check the arguments or call "${target}" directly.`,
          error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) },
          normalizedArgs: mapOpsArgs(alias, args),
        }
      }
    },
  }
}

function registerInto(tools, agent, sink) {
  const added = []
  for (const alias of Object.keys(OPS_ALIAS_TARGETS)) {
    try {
      tools.register(makeOpsDefinition(tools, alias, agent))
      added.push(alias)
    } catch (error) {
      sink.push({ alias, error: String(error?.message ?? error) })
    }
  }
  return added
}

/**
 * Register the ops_* alias layer.
 *
 * @param {object} root plugin context (Cordis)
 * @param {(scoped: object, message: string) => void} log logger
 */
export function registerOpsAliases(root, log) {
  const fibers = new Map()

  try {
    root.on('agent/created', ({ agent } = {}) => {
      if (!agent?.ctx || fibers.has(agent)) return
      try {
        const fiber = agent.ctx.plugin((child) => {
          child.inject(['tools'], (toolsCtx) => {
            const tools = toolsCtx.tools
            if (!tools || typeof tools.register !== 'function') return
            const failures = []
            const added = registerInto(tools, agent, failures)
            const resolved = Object.keys(OPS_ALIAS_TARGETS).map((alias) => ({
              alias,
              target: OPS_ALIAS_TARGETS[alias],
              ok: resolveTarget(tools, OPS_ALIAS_TARGETS[alias], agent) !== undefined,
            }))
            log(toolsCtx, `ops aliases in agent scope: +${added.length} [${added.join(', ')}], skipped ${failures.length}, resolved ${resolved.filter((r) => r.ok).length}/${resolved.length}`)
          })
        })
        if (fiber && typeof fiber.catch === 'function') fiber.catch(() => {})
        fibers.set(agent, fiber)
      } catch (error) {
        log(null, `ops alias agent attach failed: ${error?.message ?? error}`)
      }
    })
  } catch (error) {
    log(null, `ops alias agent hook failed: ${error?.message ?? error}`)
  }

  try {
    root.on('agent/disposed', ({ agent } = {}) => {
      const fiber = fibers.get(agent)
      fibers.delete(agent)
      try {
        const pending = fiber?.dispose?.()
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      } catch {
        /* disposal is best effort */
      }
    })
  } catch {
    /* a host without agent lifecycle events keeps only the global layer */
  }

  try {
    root.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.tools
      if (!tools || typeof tools.register !== 'function') return
      const failures = []
      const added = registerInto(tools, undefined, failures)
      log(toolsCtx, `ops aliases global: +${added.length} [${added.join(', ')}], skipped ${failures.length}`)
    })
  } catch (error) {
    log(null, `ops alias global registration failed: ${error?.message ?? error}`)
  }
}
