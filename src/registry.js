// Skill registry (roadmap Шаг 5): one contract for every skill — name, purpose,
// parameter schema, preconditions, timeout, cancellability — and ONE normalized result
// shape: { skill, status: success|partial|failed, requested, completed, reason,
// position, recoveryHints, ...data }. New skills plug in without touching the worker
// loop. Composites that need planning (obtain_item, build_structure) are registered by
// src/planner.js (Шаг 6) on top of these primitives.
import { scanArea, findBlocks, inspectBlock, getEntities, getInventory, getEnvironment, serializePos } from './perception.js'
import { navigatorFor } from './navigation.js'
import { gatherResource, mineBlock, navigateTo } from './gather.js'
import { placeAt, craftPlanks, craftAtTable } from './building.js'
import { depositToChest, giveToPlayer, goNear } from './skills.js'

// Recovery hints per failure reason (Шаг 7 policies key off the same taxonomy).
export const RECOVERY_HINTS = Object.freeze({
  target_not_found: ['explore_area', 'find_resource'],
  target_unreachable: ['find_resource', 'can_reach'],
  resource_depleted: ['find_resource', 'explore_area'],
  inventory_full: ['deposit_resources'],
  missing_tool: ['obtain_item'],
  interaction_failed: ['retry', 'mine_block'],
  path_stuck: ['stop_navigation', 'navigate_to'],
  timeout: ['retry'],
  bad_params: [],
  unknown_skill: []
})

const ITEM_PATTERNS = Object.freeze({
  logs: '_log$', planks: '_planks$', emerald: '^emerald$',
  dirt: '^dirt$', stone: '^cobblestone$', sand: '^sand$'
})
const itemPattern = item => {
  const p = ITEM_PATTERNS[item]
  if (!p) throw new Error(`unknown item "${item}"`)
  return p
}

const COMPLETED_FIELD = { gather_resource: 'gathered', deposit_resources: 'deposited', give_items: 'given', craft_item: 'crafted' }

/** Minimal parameter check: { name: { type, required, enum } }. Returns an error string or null. */
export function validateParams (schema, args = {}) {
  for (const [name, rule] of Object.entries(schema || {})) {
    const value = args?.[name]
    if (value === undefined || value === null) {
      if (rule.required) return `missing required param "${name}"`
      continue
    }
    if (rule.type === 'number' && !Number.isFinite(Number(value))) return `param "${name}" must be a number`
    if (rule.type === 'string' && typeof value !== 'string') return `param "${name}" must be a string`
    if (rule.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return `param "${name}" must be an object`
    if (rule.type === 'array' && !Array.isArray(value)) return `param "${name}" must be an array`
    if (rule.enum && !rule.enum.includes(String(value))) return `param "${name}" must be one of ${rule.enum.join('|')}`
  }
  return null
}

/** Wrap a raw skill return into the unified contract, keeping the taxonomy reasons. */
export function normalizeResult (skillName, requested, raw) {
  const data = raw && typeof raw === 'object' ? { ...raw } : {}
  const hintsFor = reason => RECOVERY_HINTS[reason] || ['retry']
  let status = 'success'
  let reason = null
  let recoveryHints = []
  if (data.status === 'failed') { status = 'failed'; reason = data.reason || 'interaction_failed'; recoveryHints = hintsFor(reason) }
  else if (data.status === 'partial') { status = 'partial'; reason = data.reason || null; recoveryHints = hintsFor(reason || 'interaction_failed') }
  delete data.status
  delete data.reason
  delete data.skill
  const completed = COMPLETED_FIELD[skillName] ? data[COMPLETED_FIELD[skillName]] : (requested !== undefined ? requested : undefined)
  return { skill: skillName, status, reason, recoveryHints, requested, completed, ...data }
}

/**
 * Skill definitions. run(bot, args, ctx) returns plain data (→ success) or an object
 * whose status is already set (gather/navigate do). A throw = interaction_failed.
 * ctx carries session context (e.g. ctx.camp.chest) so skills stay position-free.
 */
export const SKILL_DEFS = [
  // Perception (Шаг 1)
  {
    name: 'scan_area', description: 'Look around: interest blocks by category + creatures, with coordinates', params: { radius: { type: 'number' } },
    run: (bot, a) => {
      const scan = scanArea(bot, { radius: a.radius })
      return { blocks: scan.blocks, entities: scan.entities }
    }
  },
  { name: 'find_blocks', description: 'Find blocks by type(s) around a point; nearest first', params: { types: { type: 'array', required: true }, center: { type: 'object' }, radius: { type: 'number' }, limit: { type: 'number' } }, run: (bot, a) => ({ candidates: findBlocks(bot, a.types, a) }) },
  { name: 'inspect_block', description: 'Details about one block; distinguishes unknown from air', params: { position: { type: 'object', required: true } }, run: (bot, a) => inspectBlock(bot, a.position) },
  { name: 'get_entities', description: 'Nearest creatures/players', params: { radius: { type: 'number' }, types: { type: 'array' }, limit: { type: 'number' } }, run: (bot, a) => ({ entities: getEntities(bot, a) }) },
  { name: 'inspect_inventory', description: 'Items, free slots, equipment', params: {}, run: bot => getInventory(bot) },
  { name: 'get_environment', description: 'Dimension, time, day phase, weather', params: {}, run: bot => getEnvironment(bot) },
  // Navigation (Шаг 2)
  {
    name: 'navigate_to', description: 'Walk to a point as a managed operation (supersedes the current walk)', params: { position: { type: 'object', required: true }, range: { type: 'number' }, timeoutMs: { type: 'number' } },
    precondition: bot => null,
    run: (bot, a) => navigateTo(bot, a.position, { range: a.range, timeoutMs: a.timeoutMs })
  },
  { name: 'navigation_status', description: 'Current navigation operation snapshot or null', params: {}, run: bot => ({ operation: navigatorFor(bot).active() }) },
  {
    name: 'stop_navigation', description: 'Cancel the active navigation', params: {},
    run: bot => {
      const snap = navigatorFor(bot).active()
      return { cancelled: snap ? navigatorFor(bot).cancel(snap.id) : true }
    }
  },
  {
    name: 'can_reach', description: 'Preliminary reachability check with a reason', params: { position: { type: 'object', required: true } },
    precondition: bot => (navigatorFor(bot).active() ? 'navigation in progress' : null),
    run: (bot, a) => navigatorFor(bot).canReach(a.position)
  },
  // Gathering / mining (Шаг 3)
  { name: 'mine_block', description: 'Dig one block, verify the world changed and the drop landed', params: { position: { type: 'object', required: true } }, run: (bot, a) => mineBlock(bot, a.position) },
  { name: 'gather_resource', description: 'Gather N of a resource type (find → navigate → mine, repeated)', params: { type: { type: 'string', required: true }, amount: { type: 'number' }, anchor: { type: 'object' }, center: { type: 'object' } }, run: (bot, a) => gatherResource(bot, a.type, a.amount || 1, { anchor: a.anchor, center: a.center }) },
  // Building
  { name: 'place_block', description: 'Place a plank-type block at a cell', params: { position: { type: 'object', required: true } }, run: (bot, a) => placeAt(bot, a.position).then(placed => ({ ok: placed })) },
  { name: 'craft_item', description: 'Craft planks from carried logs (table-less recipes only for now)', params: { item: { type: 'string', required: true, enum: ['planks'] }, amount: { type: 'number' } }, run: (bot, a) => craftPlanks(bot, a.amount || 4).then(held => ({ crafted: held })) },
  // Transfer / composites
  { name: 'deposit_resources', description: 'Carry items to the camp chest and deposit them', params: { item: { type: 'string', required: true }, n: { type: 'number' } }, run: (bot, a, ctx) => depositToChest(bot, ctx.camp.chest, new RegExp(itemPattern(a.item)), a.n || 64).then(deposited => ({ deposited })) },
  { name: 'return_to_base', description: 'Walk back to the camp chest', params: {}, run: (bot, _a, ctx) => goNear(bot, ctx.camp.chest, 3).then(reached => ({ reached })) },
  { name: 'give_items', description: 'Hand items to a player standing nearby', params: { item: { type: 'string', required: true }, n: { type: 'number' }, player: { type: 'string', required: true } }, run: (bot, a) => giveToPlayer(bot, a.player, new RegExp(itemPattern(a.item)), a.n || 64).then(given => ({ given })) }
]

export function createRegistry () {
  const skills = new Map(SKILL_DEFS.map(def => [def.name, Object.freeze({ ...def })]))

  function registerSkill (def) {
    skills.set(def.name, Object.freeze({ ...def }))
  }

  async function invoke (bot, name, args = {}, ctx = {}) {
    const def = skills.get(name)
    const fail = (reason, extra = {}) => Object.freeze({
      skill: name, status: 'failed', reason, recoveryHints: RECOVERY_HINTS[reason] || ['retry'],
      requested: args?.amount ?? args?.n, completed: 0, position: serializePos(bot.entity?.position), ...extra
    })
    if (!def) return fail('unknown_skill', { requestedSkill: name })
    const paramError = validateParams(def.params, args)
    if (paramError) return fail('bad_params', { error: paramError })
    if (def.precondition) {
      const reason = def.precondition(bot, args, ctx)
      if (reason) return fail(reason, {})
    }
    try {
      const raw = await def.run(bot, args, ctx)
      const normalized = normalizeResult(name, args?.amount ?? args?.n, raw)
      return Object.freeze({ ...normalized, skill: name, position: serializePos(bot.entity?.position) })
    } catch (err) {
      return fail('interaction_failed', { error: err.message })
    }
  }

  function describeSkills () {
    return [...skills.values()].map(def => ({
      name: def.name,
      description: def.description,
      params: Object.fromEntries(Object.entries(def.params || {}).map(([k, r]) => [k, { type: r.type, required: Boolean(r.required), enum: r.enum }]))
    }))
  }

  return Object.freeze({ invoke, registerSkill, describeSkills, has: name => skills.has(name) })
}

export const registry = createRegistry()
