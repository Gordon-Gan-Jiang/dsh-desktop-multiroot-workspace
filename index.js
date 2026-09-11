/**
 * dsh-multiroot-workspace — node half.
 *
 * The durable multiroot-workspace registry plus its HTTP API. One logical
 * workspace = a title + an ordered root list; exactly one root carries
 * `primary: true` (the session-cwd anchor). Records persist in the bundle's
 * own storage domain (`multiroot_workspace`), so installing/uninstalling the
 * bundle touches no host code.
 *
 * Derived ("shadow") workspaces: sessions created with cwd = a workspace's
 * primary root get a real identity in the host workspace registry — on
 * `session/created` the plugin ensures a registry entry exists for that
 * primary root (title = the multiroot title) and attaches the session. This
 * makes the standard UI surfaces (hero chip, session grouping, recent
 * workspace) resolve multiroot sessions correctly. The mapping is recorded in
 * the domain (`derived` table); reconciliation on boot and after every
 * mutation deletes shadows whose multiroot workspace vanished or whose
 * primary root moved, and `DELETE /data` purges every shadow plus all
 * multiroot records (the pre-uninstall cleanup step).
 *
 * Routes (prefix `/plugins/multiroot/api`), JSON `{ ok, value } | { ok, error }`:
 *   GET    /workspaces            list in durable order
 *   POST   /workspaces            create { title, roots }
 *   GET    /workspaces/:id        single
 *   PATCH  /workspaces/:id        { title?, roots? }
 *   PUT    /workspaces/:id/primary  { alias }
 *   DELETE /workspaces/:id        delete record
 *   GET    /workspaces/of-cwd?path=  lookup by canonical cwd
 *   GET    /ping                  liveness
 *   DELETE /data                  purge shadows + all multiroot records
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const name = 'dsh-multiroot-workspace'
export const inject = ['storageDomain', 'webServer', 'workspaceRegistry']

/** Config-declared roots become a read-only workspace record with this id. */
const CONFIG_WORKSPACE_ID = 'config-roots'

const rootSchema = z.object({
  alias: z.string(),
  path: z.string(),
  primary: z.boolean(),
})

const recordSchema = z.object({
  title: z.string(),
  roots: z.array(rootSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Derived-shadow mapping: multiroot workspace id → registry workspace id. */
const derivedSchema = z.object({
  registryWorkspaceId: z.string(),
  primaryPath: z.string(),
  owned: z.boolean(),
})

/** Plugin-owned current-root selection, keyed by Session id. */
const sessionRootSchema = z.object({
  workspaceId: z.string(),
  alias: z.string(),
})

const domainSpec = defineDomain({
  name: 'multiroot_workspace',
  // rc.6 has no domain migration API and rejects a changed version stamp.
  // New tables are additive at the same version, preserving existing v4 data.
  version: 4,
  global: {
    schema: z.object({ order: z.array(z.string()) }),
    initial: { order: [] },
  },
  tables: {
    workspaces: domainTable(recordSchema),
    derived: domainTable(derivedSchema),
    session_roots: domainTable(sessionRootSchema),
  },
})

function nowIso() {
  return new Date().toISOString()
}

/** Canonicalize a path; returns null when it does not exist. */
async function canonical(path) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/** Synchronous canonicalization for cwd lookups; falls back to the spelling. */
function canonicalSync(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Validate and canonicalize a root list. Throws a plain Error with a stable
 * `code` property on failure.
 */
async function validateRoots(roots, { tolerateMissing }) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw Object.assign(new Error('roots must be a non-empty array'), { code: 'invalid-roots' })
  }
  const seen = new Set()
  let primaryCount = 0
  const out = []
  for (const [index, root] of roots.entries()) {
    if (root === null || typeof root !== 'object') {
      throw Object.assign(new Error(`roots[${index}] must be an object`), { code: 'invalid-roots' })
    }
    const alias = typeof root.alias === 'string' ? root.alias.trim() : ''
    if (alias.length === 0) {
      throw Object.assign(new Error(`roots[${index}]: alias must be a non-empty string`), { code: 'invalid-roots' })
    }
    const key = alias.toLowerCase()
    if (seen.has(key)) {
      throw Object.assign(new Error(`roots[${index}]: alias "${alias}" is duplicated`), { code: 'alias-conflict' })
    }
    seen.add(key)
    const path = typeof root.path === 'string' ? root.path.trim() : ''
    if (path.length === 0) {
      throw Object.assign(new Error(`roots[${index}]: path must be a non-empty string`), { code: 'invalid-roots' })
    }
    let canonicalPath = await canonical(path)
    if (canonicalPath === null && !tolerateMissing) {
      throw Object.assign(new Error(`roots[${index}]: path "${path}" does not exist`), { code: 'path-not-found' })
    }
    canonicalPath ??= path
    const primary = root.primary === true
    if (primary) primaryCount += 1
    out.push({ alias, path: canonicalPath, primary })
  }
  if (primaryCount !== 1) {
    throw Object.assign(new Error('exactly one root must be marked primary'), { code: 'no-primary' })
  }
  return out
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function ok(res, value) {
  json(res, 200, { ok: true, value })
}

function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

/** Read and parse a JSON request body; returns null on malformed input. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(domainSpec)
  const table = domain.table('workspaces')
  const derivedTable = domain.table('derived')
  const sessionRootsTable = domain.table('session_roots')
  const order = domain.global
  ctx.effect(() => () => domain.close(), 'multiroot: domain close')

  const touch = async (id, patch) => {
    const record = table.get(id)
    if (record === undefined) return undefined
    const updated = { ...record, ...patch, updatedAt: nowIso() }
    await table.put(id, updated)
    invalidateCwdIndex()
    return updated
  }

  const prependOrder = (id) => order.set({ order: [id, ...order.get().order] })
  const removeOrder = (id) => order.set({ order: order.get().order.filter((entry) => entry !== id) })

  const view = (id, record) => ({
    id,
    ...record,
    shadowWorkspaceId: derivedTable.get(id)?.registryWorkspaceId,
  })

  // ---- derived-shadow management ----

  const prepareShadow = async (title, roots) => {
    const primary = roots.find((root) => root.primary)
    if (primary === undefined) {
      throw Object.assign(new Error('primary root is missing'), { code: 'no-primary' })
    }
    const existing = await ctx.workspaceRegistry.resolveByPath(primary.path).catch(() => undefined)
    if (existing !== undefined) {
      return {
        registryWorkspaceId: existing.id,
        primaryPath: primary.path,
        owned: false,
      }
    }
    let created
    try {
      created = await ctx.workspaceRegistry.create(primary.path, title)
    } catch {
      created = await ctx.workspaceRegistry.create(primary.path, `${title} (multiroot)`)
    }
    if (created?.id === undefined) {
      throw Object.assign(new Error('failed to prepare shadow Workspace'), { code: 'shadow-missing' })
    }
    return {
      registryWorkspaceId: created.id,
      primaryPath: primary.path,
      owned: true,
    }
  }

  /**
   * Delete one derived shadow (registry entry + mapping row). Missing registry
   * entries are tolerated (the user may have deleted them by hand).
   */
  const deleteShadow = async (multirootId) => {
    const mapping = derivedTable.get(multirootId)
    if (mapping === undefined) return
    if (mapping.owned && ctx.workspaceRegistry.get(mapping.registryWorkspaceId) !== undefined) {
      await ctx.workspaceRegistry.delete(mapping.registryWorkspaceId)
    }
    await derivedTable.delete(multirootId)
  }

  const migrateShadow = async (id, record, nextRoots) => {
    const previous = derivedTable.get(id)
    const prepared = await prepareShadow(record.title, nextRoots)
    const previousWorkspace = previous === undefined
      ? undefined
      : ctx.workspaceRegistry.get(previous.registryWorkspaceId)
    const sessionIds = [...(previousWorkspace?.sessionIds ?? [])]
    const preparedWorkspace = ctx.workspaceRegistry.get(prepared.registryWorkspaceId)
    if (preparedWorkspace === undefined) {
      throw Object.assign(new Error('prepared shadow Workspace is missing'), { code: 'shadow-missing' })
    }
    // Attach only sessions whose canonical cwd equals the new primary path.
    // Sessions anchored elsewhere (e.g. the former primary) stay with their
    // own workspace; forcing them onto the new shadow fails attachSession's
    // cwd validation and would block the primary switch entirely.
    const attached = []
    for (const sessionId of sessionIds) {
      try {
        await preparedWorkspace.attachSession(sessionId)
        attached.push(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`multiroot: session ${sessionId} stays with the previous primary (${error?.message ?? String(error)})`)
      }
    }
    await derivedTable.put(id, prepared)
    const updated = await touch(id, { roots: nextRoots })
    if (updated === undefined) {
      throw Object.assign(new Error(`workspace "${id}" not found`), { code: 'workspace-not-found' })
    }
    // Delete the previous shadow only when every session followed the primary
    // (or there were none). A shadow still owning sessions must survive, or
    // those sessions would be orphaned from the registry. Because it now
    // represents the former primary directory rather than the multiroot
    // workspace, retitle it to its path basename so the sidebar shows a
    // distinct, honest entry instead of a second copy of the same title.
    const keptPrevious = previous?.owned === true
      && previous.registryWorkspaceId !== prepared.registryWorkspaceId
      && attached.length < sessionIds.length
      && ctx.workspaceRegistry.get(previous.registryWorkspaceId) !== undefined
      ? ctx.workspaceRegistry.get(previous.registryWorkspaceId)
      : undefined
    if (previous?.owned === true
      && previous.registryWorkspaceId !== prepared.registryWorkspaceId
      && attached.length === sessionIds.length
      && ctx.workspaceRegistry.get(previous.registryWorkspaceId) !== undefined) {
      await ctx.workspaceRegistry.delete(previous.registryWorkspaceId)
    }
    if (keptPrevious !== undefined) {
      const previousPath = keptPrevious.path
      const base = typeof previousPath === 'string'
        ? String(previousPath).split('/').filter(Boolean).pop() ?? previousPath
        : previousPath
      if (base !== void 0 && base !== '' && base !== record.title) {
        await keptPrevious.setTitle(base).catch((error) => {
          ctx.logger?.warn?.(`multiroot: could not retitle kept shadow (${error?.message ?? String(error)})`)
        })
      }
    }
    return view(id, updated)
  }

  /**
   * Reconcile every derived mapping against live state: drop mappings whose
   * multiroot workspace vanished, whose primary root moved, or whose registry
   * entry was deleted by hand. Runs on boot and after every mutation.
   */
  const reconcileShadows = async () => {
    for (const [multirootId, mapping] of derivedTable.entries()) {
      const record = table.get(multirootId)
      const registryEntry = ctx.workspaceRegistry.get(mapping.registryWorkspaceId)
      if (registryEntry === undefined) {
        await derivedTable.delete(multirootId)
      } else if (record === undefined
        || record.roots.find((root) => root.primary)?.path !== registryEntry.path) {
        await deleteShadow(multirootId)
      }
    }
    // Leftover-shadow retitle (boot-time safety net). A registry workspace that
    // sits at a multiroot root path but still carries the multiroot title while
    // NOT being that workspace's current primary shadow is a leftover from a
    // previous primary switch (sessions anchored at the former primary had to
    // stay there). Retitle it to its path basename so the sidebar never shows
    // two entries with the same title. User-created workspaces that happen to
    // share a title are left alone: they must also sit on a multiroot root path
    // AND own the multiroot title to be touched.
    const currentShadows = new Set()
    const shadowTitleById = new Map()
    const rootPathsByTitle = new Map()
    for (const [multirootId, mapping] of derivedTable.entries()) {
      currentShadows.add(mapping.registryWorkspaceId)
      const record = table.get(multirootId)
      if (record !== void 0) {
        rootPathsByTitle.set(record.title, record.roots.map((root) => root.path))
        shadowTitleById.set(mapping.registryWorkspaceId, record.title)
      }
    }
    // B2: a current primary shadow must carry the multiroot title (consistent
    // with the retitle of leftover shadows below); fix drift from either side.
    for (const [registryId, expectedTitle] of shadowTitleById.entries()) {
      const workspace = ctx.workspaceRegistry.get(registryId)
      if (workspace !== void 0 && workspace.title !== expectedTitle) {
        await workspace.setTitle(expectedTitle).catch((error) => {
          ctx.logger?.warn?.(`multiroot: could not retitle current shadow (${error?.message ?? String(error)})`)
        })
      }
    }
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (currentShadows.has(workspace.id)) continue
      const rootPaths = rootPathsByTitle.get(workspace.title)
      if (rootPaths === void 0 || !rootPaths.includes(workspace.path)) continue
      const base = String(workspace.path).split('/').filter(Boolean).pop() ?? workspace.path
      if (base !== void 0 && base !== '' && base !== workspace.title) {
        await workspace.setTitle(base).catch((error) => {
          ctx.logger?.warn?.(`multiroot: could not retitle leftover shadow (${error?.message ?? String(error)})`)
        })
      }
    }
    // B3: drop session_roots whose session no longer exists in any registry
    // workspace (archived or deleted sessions should not linger).
    const liveSessionIds = new Set()
    for (const workspace of ctx.workspaceRegistry.list()) {
      for (const sessionId of workspace.sessionIds) liveSessionIds.add(sessionId)
    }
    for (const [sessionId] of [...sessionRootsTable.entries()]) {
      if (!liveSessionIds.has(sessionId)) {
        await sessionRootsTable.delete(sessionId)
      }
    }
  }

  /**
   * Ensure a registry shadow exists for the workspace's primary root and
   * attach the session to it. Reuses an existing registry entry for the same
   * canonical path (whether ours or the user's own); title conflicts on
   * creation fall back to a suffixed title.
   */
  const ensureShadowAndAttach = async (record, sessionId, sessionCwd) => {
    const primary = record.roots.find((root) => root.primary)
    if (primary === undefined) return
    let shadowId = derivedTable.get(record.id)?.registryWorkspaceId
    if (shadowId !== undefined && ctx.workspaceRegistry.get(shadowId)?.path !== primary.path) {
      await deleteShadow(record.id)
      shadowId = undefined
    }
    if (shadowId === undefined) {
      const prepared = await prepareShadow(record.title, record.roots)
      shadowId = prepared.registryWorkspaceId
      await derivedTable.put(record.id, prepared)
    }
    const shadow = ctx.workspaceRegistry.get(shadowId)
    await shadow?.attachSession(sessionId).catch((error) => {
      console.log('[multiroot] attachSession failed:', error?.message ?? String(error), '| session cwd:', sessionCwd, '| shadow path:', primary.path)
    })
  }

  // Attach freshly created sessions whose cwd anchors a multiroot primary.
  // Whole-handler containment: a bookkeeping bug must never fail the boot.
  ctx.on('session/created', (session) => {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return
      const key = canonicalSync(cwd)
      const record = registryList().find((entry) =>
        entry.roots.some((root) => root.primary && canonicalSync(root.path) === key))
      if (record === undefined) return
      void ensureShadowAndAttach(record, session.id, cwd).catch((error) => {
        ctx.logger?.warn?.(`multiroot attach: ${error?.message ?? String(error)}`)
      })
    } catch (error) {
      ctx.logger?.warn?.(`multiroot session/created handler: ${error?.message ?? String(error)}`)
    }
  })

  // ---- registry ----

  const registryList = () => {
    const records = []
    for (const id of order.get().order) {
      const record = table.get(id)
      if (record !== undefined) records.push(view(id, record))
    }
    for (const [id, record] of table.entries()) {
      if (!records.some((entry) => entry.id === id)) records.push(view(id, record))
    }
    return records
  }

  // B1: path->workspaceId cache so repeated cwd lookups (every ws_* call)
  // avoid re-canonicalizing and re-scanning all records. Invalidated on any
  // registry mutation by the mutation helpers below (touch/put/delete/purge).
  const cwdIndex = new Map()
  const invalidateCwdIndex = () => cwdIndex.clear()
  const workspaceOfCwd = (cwd) => {
    const key = cwd === undefined ? undefined : canonicalSync(cwd)
    if (key === undefined) return undefined
    const cachedId = cwdIndex.get(key)
    if (cachedId !== undefined) {
      const cached = table.get(cachedId)
      if (cached !== undefined) return view(cachedId, cached)
      cwdIndex.delete(key)
    }
    for (const record of registryList()) {
      const primary = record.roots.find((root) => root.primary)
      if (primary !== undefined && canonicalSync(primary.path) === key) {
        cwdIndex.set(key, record.id)
        return record
      }
    }
    return undefined
  }

  const deleteSessionRoots = async (workspaceId) => {
    for (const [sessionId, selection] of [...sessionRootsTable.entries()]) {
      if (selection.workspaceId === workspaceId) await sessionRootsTable.delete(sessionId)
    }
  }

  const clearSessionRoots = async () => {
    for (const [sessionId] of [...sessionRootsTable.entries()]) {
      await sessionRootsTable.delete(sessionId)
    }
  }

  const deleteInvalidSessionRoots = async (workspaceId, roots) => {
    const aliases = new Set(roots.map((root) => root.alias.toLowerCase()))
    for (const [sessionId, selection] of [...sessionRootsTable.entries()]) {
      if (selection.workspaceId === workspaceId && !aliases.has(selection.alias.toLowerCase())) {
        await sessionRootsTable.delete(sessionId)
      }
    }
  }

  const registry = {
    list: registryList,
    get(id) {
      const record = table.get(id)
      return record === undefined ? undefined : view(id, record)
    },
    /** The workspace whose canonical primary-root path equals the canonical cwd. */
    workspaceOfCwd(cwd) {
      return workspaceOfCwd(cwd)
    },
    currentRoot(sessionId, cwd) {
      const workspace = workspaceOfCwd(cwd)
      if (workspace === undefined) return undefined
      const selection = sessionRootsTable.get(sessionId)
      if (selection?.workspaceId === workspace.id) {
        const selected = workspace.roots.find((root) =>
          root.alias.toLowerCase() === selection.alias.toLowerCase())
        if (selected !== undefined) return selected.alias
      }
      return workspace.roots.find((root) => root.primary)?.alias ?? workspace.roots[0]?.alias
    },
    async setCurrentRoot(sessionId, cwd, alias) {
      const workspace = workspaceOfCwd(cwd)
      if (workspace === undefined) {
        throw Object.assign(new Error(`workspace for cwd "${cwd}" not found`), { code: 'workspace-not-found' })
      }
      const target = workspace.roots.find((root) =>
        root.alias.toLowerCase() === String(alias).toLowerCase())
      if (target === undefined) {
        throw Object.assign(new Error(`alias "${alias}" not found`), { code: 'alias-not-found' })
      }
      await sessionRootsTable.put(sessionId, { workspaceId: workspace.id, alias: target.alias })
    },
    async clearCurrentRoot(sessionId) {
      return sessionRootsTable.delete(sessionId)
    },
    async create({ title, roots }) {
      const cleanTitle = typeof title === 'string' ? title.trim() : ''
      if (cleanTitle.length === 0) {
        throw Object.assign(new Error('title must be a non-empty string'), { code: 'invalid-title' })
      }
      const canonicalRoots = await validateRoots(roots, { tolerateMissing: false })
      const id = randomUUID()
      const record = {
        title: cleanTitle,
        roots: canonicalRoots,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      const prepared = await prepareShadow(cleanTitle, canonicalRoots)
      try {
        await derivedTable.put(id, prepared)
        await table.put(id, record)
        await prependOrder(id)
        invalidateCwdIndex()
      } catch (error) {
        await derivedTable.delete(id)
        if (prepared.owned && ctx.workspaceRegistry.get(prepared.registryWorkspaceId) !== undefined) {
          await ctx.workspaceRegistry.delete(prepared.registryWorkspaceId)
        }
        throw error
      }
      return view(id, record)
    },
    async update(id, { title, roots }) {
      const record = table.get(id)
      if (record === undefined) {
        throw Object.assign(new Error(`workspace "${id}" not found`), { code: 'workspace-not-found' })
      }
      if (id === CONFIG_WORKSPACE_ID) {
        throw Object.assign(new Error('config-declared roots are read-only'), { code: 'config-roots-readonly' })
      }
      const patch = {}
      if (title !== undefined) {
        const clean = typeof title === 'string' ? title.trim() : ''
        if (clean.length === 0) {
          throw Object.assign(new Error('title must be a non-empty string'), { code: 'invalid-title' })
        }
        patch.title = clean
      }
      if (roots !== undefined) {
        const canonicalRoots = await validateRoots(roots, { tolerateMissing: false })
        const currentPrimary = record.roots.find((root) => root.primary)
        const nextPrimary = canonicalRoots.find((root) => root.primary)
        if (currentPrimary?.alias.toLowerCase() !== nextPrimary?.alias.toLowerCase()) {
          throw Object.assign(new Error('primary changes require the primary endpoint'), {
            code: 'primary-change-requires-endpoint',
          })
        }
        patch.roots = canonicalRoots
      }
      const updated = await touch(id, patch)
      if (updated !== undefined && patch.roots !== undefined) {
        await deleteInvalidSessionRoots(id, updated.roots)
      }
      await reconcileShadows()
      return updated === undefined ? undefined : view(id, updated)
    },
    async setPrimary(id, alias) {
      const record = table.get(id)
      if (record === undefined) {
        throw Object.assign(new Error(`workspace "${id}" not found`), { code: 'workspace-not-found' })
      }
      if (id === CONFIG_WORKSPACE_ID) {
        throw Object.assign(new Error('config-declared roots are read-only'), { code: 'config-roots-readonly' })
      }
      const target = record.roots.find((root) => root.alias.toLowerCase() === String(alias).toLowerCase())
      if (target === undefined) {
        throw Object.assign(new Error(`alias "${alias}" not found`), { code: 'alias-not-found' })
      }
      if (target.primary) return view(id, record)
      const roots = record.roots.map((root) => ({ ...root, primary: root === target }))
      return migrateShadow(id, record, roots)
    },
    async delete(id) {
      if (id === CONFIG_WORKSPACE_ID) {
        throw Object.assign(new Error('config-declared roots are read-only'), { code: 'config-roots-readonly' })
      }
      if (table.get(id) !== undefined) await deleteSessionRoots(id)
      const existed = await table.delete(id)
      if (existed) {
        invalidateCwdIndex()
        await deleteShadow(id)
        await removeOrder(id)
      }
      return existed
    },
    /** Purge everything this bundle owns: every shadow plus all records. */
    async purge() {
      let shadows = 0
      for (const [multirootId] of derivedTable.entries()) {
        await deleteShadow(multirootId)
        shadows += 1
      }
      await clearSessionRoots()
      let records = 0
      for (const [id] of table.entries()) {
        if (id !== CONFIG_WORKSPACE_ID) {
          await table.delete(id)
          records += 1
        }
      }
      await order.set({ order: [] })
      return { shadows, records }
    },
  }

  // Config-declared roots: a read-only record merged at startup. Missing
  // paths are tolerated (the deployment may mount them later); every other
  // validation rule applies.
  if (Array.isArray(config?.roots) && config.roots.length > 0) {
    const existing = table.get(CONFIG_WORKSPACE_ID)
    const roots = await validateRoots(config.roots, { tolerateMissing: true })
    const record = {
      title: typeof config?.title === 'string' && config.title.trim().length > 0 ? config.title.trim() : '配置根',
      roots,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    }
    await table.put(CONFIG_WORKSPACE_ID, record)
    await deleteInvalidSessionRoots(CONFIG_WORKSPACE_ID, roots)
    const orderState = order.get().order
    if (!orderState.includes(CONFIG_WORKSPACE_ID)) {
      await order.set({ order: [...orderState, CONFIG_WORKSPACE_ID] })
    }
  }

  await reconcileShadows()

  ctx.provide('multirootRegistry', registry)

  // ---- HTTP API ----
  const API_PREFIX = '/plugins/multiroot/api'
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const rest = rawPath.startsWith(`${API_PREFIX}/`) ? rawPath.slice(API_PREFIX.length + 1) : ''
      const segments = rest.split('/').filter(Boolean)
      const method = req.method ?? 'GET'

      try {
        // GET /ping — liveness probe
        if (method === 'GET' && segments.length === 1 && segments[0] === 'ping') {
          return ok(res, { tableSize: table.size })
        }

        // DELETE /data — pre-uninstall cleanup (shadows + records)
        if (method === 'DELETE' && segments.length === 1 && segments[0] === 'data') {
          return ok(res, await registry.purge())
        }

        // GET /workspaces/of-cwd?path=...  (literal before :id dispatch)
        if (method === 'GET' && segments.length === 2 && segments[0] === 'workspaces' && segments[1] === 'of-cwd') {
          const path = new URL(req.url ?? '/', 'http://x').searchParams.get('path')
          if (path === null || path.length === 0) {
            return fail(res, 400, 'invalid-request', 'missing path query parameter')
          }
          const key = canonicalSync(path)
          return ok(res, registry.workspaceOfCwd(key))
        }

        if (segments.length === 1 && segments[0] === 'workspaces') {
          if (method === 'GET') return ok(res, registry.list())
          if (method === 'POST') {
            const body = await readBody(req)
            if (body === null) return fail(res, 400, 'invalid-json', 'request body is not valid JSON')
            return ok(res, await registry.create(body))
          }
          return fail(res, 405, 'method-not-allowed', `unsupported method ${method}`)
        }

        if (segments.length === 2 && segments[0] === 'workspaces') {
          const id = segments[1]
          if (method === 'GET') {
            const record = registry.get(id)
            return record === undefined ? fail(res, 404, 'workspace-not-found', `workspace "${id}" not found`) : ok(res, record)
          }
          if (method === 'PATCH') {
            const body = await readBody(req)
            if (body === null) return fail(res, 400, 'invalid-json', 'request body is not valid JSON')
            return ok(res, await registry.update(id, body))
          }
          if (method === 'DELETE') {
            return await registry.delete(id) ? ok(res, true) : fail(res, 404, 'workspace-not-found', `workspace "${id}" not found`)
          }
          return fail(res, 405, 'method-not-allowed', `unsupported method ${method}`)
        }

        if (segments.length === 3 && segments[0] === 'workspaces' && segments[2] === 'primary' && method === 'PUT') {
          const body = await readBody(req)
          if (body === null) return fail(res, 400, 'invalid-json', 'request body is not valid JSON')
          return ok(res, await registry.setPrimary(segments[1], body.alias))
        }

        return fail(res, 404, 'not-found', `no such route /${rest}`)
      } catch (error) {
        const code = error?.code ?? 'internal'
        ctx.logger?.warn?.(`multiroot api ${method} /${rest}: ${error?.message ?? String(error)}`)
        const status = code === 'internal' ? 500 : 400
        return fail(res, status, code, error?.message ?? String(error))
      }
    },
  })
}
