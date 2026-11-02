// Resource primitives (roadmap Шаг 3): find_resource, navigate_to, mine_block are
// independent tools; gather_resource(type, amount) composes them. The resource TYPE is
// a parameter — nothing here is hard-wired to logs. Failures are classified with the
// Шаг 7 taxonomy (target_not_found / target_unreachable / interaction_failed /
// inventory_full / candidates_exhausted) so recovery policies can key off them.
import Vec3 from 'vec3'
import { countItems, withTimeout } from './skills.js'
import { navigatorFor, waitOperation } from './navigation.js'
import { getInventory } from './perception.js'
import { record } from './events.js'
import { config } from './config.js'

const PATH = config.params.path
const GATHER = config.params.gather || {}

const MAX_CANDIDATE_FAILURES = GATHER.max_candidate_failures ?? 4
const MINE_VERIFY_MS = GATHER.mine_verify_ms ?? 2500   // wait for the drop to reach the inventory
const NAV_RANGE = GATHER.nav_range ?? 2

/** Resource catalogue: which blocks, what they drop, where to look for them. */
export const RESOURCES = Object.freeze({
  logs: Object.freeze({
    match: /^(oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_log$/,
    drop: /_log$/,
    heightWindow: 'feet' // logs are only chopped at or above feet level (matches the old search)
  }),
  dirt: Object.freeze({
    match: /^(dirt|coarse_dirt|grass_block|podzol|rooted_dirt)$/,
    drop: /^dirt$/, // grass_block drops dirt
    heightWindow: 'any'
  }),
  sand: Object.freeze({ match: /^sand$/, drop: /^sand$/, heightWindow: 'any' }),
  stone: Object.freeze({ match: /^stone$/, drop: /^cobblestone$/, heightWindow: 'any' }),
  leaves: Object.freeze({ match: /_leaves$/, drop: null, heightWindow: 'feet' }) // diggable, no guaranteed drop
})

export function resourceDef (type) {
  const def = RESOURCES[type]
  if (!def) throw new Error(`Unknown resource "${type}" (known: ${Object.keys(RESOURCES).join(', ')})`)
  return def
}

const round1 = n => Math.round(n * 10) / 10
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const toVec = p => (p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z))

/**
 * find_resource(type, searchArea): candidates of the resource around `center`
 * (default: the bot), nearest first, optionally ranked towards an `anchor`.
 * The height window lives inside the findBlocks predicate — mineflayer's palette
 * gate feeds name-only stubs (position null), and the count cap fires before any
 * post-filter (Шаг 0 lesson), so stubs must pass the gate.
 */
export function findResource (bot, type, { center = null, anchor = null, radius = PATH.log_search_radius, limit = 20, excluded = null } = {}) {
  const def = resourceDef(type)
  const origin = center || bot.entity?.position
  if (!origin || !bot.findBlocks) return []
  const feetY = bot.entity?.position?.y ?? 0
  const heightOk = p => def.heightWindow === 'any' ||
    (p.y >= Math.floor(feetY) && p.y <= feetY + (PATH.max_log_height_above_feet ?? 2))
  const from = bot.entity?.position
  const extra = from ? Math.ceil(from.distanceTo(origin)) + 1 : 0
  return (bot.findBlocks({
    matching: b => def.match.test(b.name) && (!b.position || heightOk(b.position)),
    maxDistance: radius + extra,
    count: limit * 4
  }) || [])
    .map(p => {
      const name = bot.blockAt?.(p)?.name
      if (!name || !def.match.test(name)) return null
      const position = { x: p.x, y: p.y, z: p.z }
      const distance = round1(dist3(position, origin))
      if (distance > radius || (excluded && excluded.has(`${position.x},${position.y},${position.z}`))) return null
      return { type, name, position, distance, anchorDistance: anchor ? round1(dist3(position, anchor)) : null }
    })
    .filter(Boolean)
    .sort((a, b) => (anchor ? a.anchorDistance - b.anchorDistance : a.distance - b.distance))
    .slice(0, limit)
}

/**
 * navigate_to(position): a managed operation from Шаг 2. Resolves with the final
 * snapshot — 'success' means close enough to mine, 'partial' means "near, not there".
 */
export async function navigateTo (bot, position, { range = NAV_RANGE, timeoutMs = PATH.skill_timeout_ms } = {}) {
  const nav = navigatorFor(bot)
  const id = nav.start({ x: position.x, y: position.y, z: position.z }, { range, timeoutMs })
  return waitOperation(nav, id, { timeoutMs: timeoutMs + 5000 })
}

/**
 * mine_block(position, toolPolicy): assumes the bot is already close enough (navigation
 * is a separate tool). Digs the block, verifies the world actually changed and waits
 * briefly for the drop to land in the inventory.
 */
export async function mineBlock (bot, position, { toolPolicy = 'auto', verifyMs = MINE_VERIFY_MS } = {}) {
  const target = toVec(position)
  const block = bot.blockAt?.(target)
  if (!block) return { ok: false, reason: 'chunk_not_loaded', gained: 0 }
  if (block.name === 'air' || block.boundingBox === 'empty') return { ok: false, reason: 'nothing_to_mine', gained: 0 }
  const def = Object.values(RESOURCES).find(d => d.match.test(block.name)) || null
  const dropPattern = def?.drop || null
  const before = dropPattern ? countItems(bot, dropPattern) : 0
  if (toolPolicy === 'auto' && bot.tool?.equipForBlock) {
    await bot.tool.equipForBlock(block, {}).catch(() => {})
  }
  try {
    await withTimeout(bot.dig(block), PATH.skill_timeout_ms, 'mine_block')
  } catch (err) {
    return { ok: false, reason: 'interaction_failed', error: err.message, gained: 0 }
  }
  const deadline = Date.now() + verifyMs
  while (Date.now() < deadline) {
    const after = bot.blockAt?.(target)
    const gone = !after || after.name !== block.name
    const gained = dropPattern ? countItems(bot, dropPattern) - before : 0
    if (gone && gained > 0) return { ok: true, reason: null, gained, block: block.name }
    if (gone && Date.now() - (deadline - verifyMs) > 400) {
      // The world changed; the drop may still be flying — report the dig, not the pickup.
      return { ok: true, reason: gained > 0 ? null : 'drop_not_picked_up', gained, block: block.name }
    }
    if (!gone && gained > 0) return { ok: true, reason: null, gained, block: block.name }
    await sleep(150)
  }
  const after = bot.blockAt?.(target)
  const gained = dropPattern ? countItems(bot, dropPattern) - before : 0
  if (gained > 0) return { ok: true, reason: null, gained, block: block.name }
  return {
    ok: Boolean(after && after.name !== block.name),
    reason: after && after.name === block.name ? 'dig_did_not_take' : 'drop_not_picked_up',
    gained,
    block: block.name
  }
}

const key = c => `${c.position.x},${c.position.y},${c.position.z}`

/**
 * gather_resource(type, amount): inventory check → find → navigate → mine → verify,
 * repeated until the amount is reached or the candidates are exhausted. Returns
 * { status: success|partial|failed, gathered, requested, reason, attempts } —
 * the unified result shape the registry (Шаг 5) will standardise.
 */
export async function gatherResource (bot, type, amount, {
  anchor = null,
  center = null,
  radius = undefined,
  shouldStop = () => false,
  onGain = () => {},
  maxCandidateFailures = MAX_CANDIDATE_FAILURES
} = {}) {
  const def = resourceDef(type) // validate early
  const startedAt = Date.now()
  const before = countItems(bot, def.drop)
  let gathered = 0
  let attempts = 0
  let reason = null

  const freeSlots = getInventory(bot).freeSlots
  if (freeSlots === 0) {
    return { skill: 'gather_resource', type, requested: amount, gathered: 0, status: 'failed', reason: 'inventory_full', attempts: 0, elapsedMs: Date.now() - startedAt }
  }

  const candidates = findResource(bot, type, { center, anchor, radius: radius ?? PATH.log_search_radius })
  if (candidates.length === 0) {
    return { skill: 'gather_resource', type, requested: amount, gathered: 0, status: 'failed', reason: 'target_not_found', attempts: 0, elapsedMs: Date.now() - startedAt }
  }

  const unreachable = new Set()
  let failures = 0
  for (const candidate of candidates) {
    if (shouldStop()) { reason = 'interrupted'; break }
    if (gathered >= amount) break
    if (failures >= maxCandidateFailures) { reason = 'candidates_exhausted'; break }
    if (getInventory(bot).freeSlots === 0) { reason = 'inventory_full'; break }
    attempts += 1
    const walk = await navigateTo(bot, candidate.position, { range: NAV_RANGE })
    if (walk.status !== 'success') {
      // A failing approach is not retried verbatim; only FAILURES consume the budget —
      // mine_block digs one block at a time, so a working run needs many candidates.
      unreachable.add(key(candidate))
      failures += 1
      reason = 'target_unreachable'
      record('gather', { agent: bot.username, type, candidate: key(candidate), phase: 'navigate', status: walk.status, error: walk.error, attempts, failures })
      continue
    }
    const mine = await mineBlock(bot, candidate.position)
    if (!mine.ok) {
      unreachable.add(key(candidate))
      failures += 1
      reason = mine.reason === 'nothing_to_mine' ? 'resource_depleted' : 'interaction_failed'
      record('gather', { agent: bot.username, type, candidate: key(candidate), phase: 'mine', ok: false, error: mine.reason, attempts, failures })
      continue
    }
    // Drops are picked up asynchronously while the bot walks on — the only honest
    // counter is the whole-run inventory delta, not per-dig instant gains.
    gathered = countItems(bot, def.drop) - before
    record('gather', { agent: bot.username, type, candidate: key(candidate), phase: 'gain', gained: mine.gained, gathered, attempts, failures })
    onGain(candidate, mine)
  }

  const status = gathered >= amount ? 'success' : gathered > 0 ? 'partial' : 'failed'
  if (status === 'success') reason = null
  else if (!reason) reason = attempts === 0 ? 'interrupted' : 'candidates_exhausted'
  return {
    skill: 'gather_resource',
    type,
    requested: amount,
    gathered,
    status,
    reason,
    attempts,
    elapsedMs: Date.now() - startedAt,
    carried: countItems(bot, def.drop) - before
  }
}
