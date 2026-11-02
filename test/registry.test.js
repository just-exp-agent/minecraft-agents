import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Vec3 from 'vec3'
import { createRegistry, registry, validateParams, normalizeResult } from '../src/registry.js'
import { navigatorFor } from '../src/navigation.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = p => `${p.x},${p.y},${p.z}`

function makeBot ({ pos = new Vec3(0, 71, 0), blocks = new Map(), inv = [], slots = [] } = {}) {
  const bot = new EventEmitter()
  bot.username = 'RegTest'
  bot.entity = { position: pos.clone() }
  bot.entities = {}
  bot.players = {}
  bot.inventory = { items: () => inv, slots }
  bot.blockAt = v => {
    const name = blocks.get(key(v))
    return name ? { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new Vec3(v.x, v.y, v.z) } : null
  }
  bot.findBlocks = ({ matching, maxDistance }) => [...blocks.entries()]
    .map(([k, name]) => { const [x, y, z] = k.split(',').map(Number); return { name, position: new Vec3(x, y, z) } })
    .filter(matching)
    .map(b => b.position)
    .filter(p => p.distanceTo(bot.entity.position) <= maxDistance)
  bot.pathfinder = {
    setGoal: g => { if (g) { bot.entity.position = new Vec3(g.x, g.y, g.z); bot.emit('path_update', { status: 'success' }) } },
    goto: async g => { if (g) bot.entity.position = new Vec3(g.x, g.y, g.z) }
  }
  return bot
}

const CAMP = { chest: new Vec3(-90, 71, 58), fire: new Vec3(-93, 71, 61) }

test('validateParams enforces types, required and enum', () => {
  const schema = { type: { type: 'string', required: true, enum: ['logs', 'dirt'] }, amount: { type: 'number' }, position: { type: 'object' } }
  assert.equal(validateParams(schema, { type: 'logs', amount: 3 }), null)
  assert.match(validateParams(schema, {}), /missing required param "type"/)
  assert.match(validateParams(schema, { type: 'coins' }), /must be one of logs\|dirt/)
  assert.match(validateParams(schema, { type: 'logs', amount: 'x' }), /must be a number/)
  assert.match(validateParams(schema, { type: 'logs', position: [1, 2] }), /must be an object/)
})

test('invoke normalizes unknown skills and bad params into failed results', async () => {
  const reg = createRegistry()
  const bot = makeBot()
  const unknown = await reg.invoke(bot, 'teleport_home', {}, { camp: CAMP })
  assert.equal(unknown.status, 'failed')
  assert.equal(unknown.reason, 'unknown_skill')
  const bad = await reg.invoke(bot, 'gather_resource', {}, { camp: CAMP })
  assert.equal(bad.reason, 'bad_params')
  assert.match(bad.error, /missing required param "type"/)
  assert.ok(bad.recoveryHints, 'failed results carry recovery hints')
})

test('perception skills run through the unified contract', async () => {
  const reg = createRegistry()
  const blocks = new Map([['3,71,0', 'oak_log'], ['0,71,4', 'chest']])
  const bot = makeBot({ blocks })
  const slots = new Array(46).fill(null)
  slots[9] = { name: 'oak_log', count: 2 }
  bot.inventory.slots = slots
  bot.inventory.items = () => slots.filter(Boolean)
  const scan = await reg.invoke(bot, 'scan_area', { radius: 16 })
  assert.equal(scan.status, 'success')
  assert.ok(scan.blocks.length >= 2)
  assert.ok(scan.position, 'snapshot carries the bot position')
  const inv = await reg.invoke(bot, 'inspect_inventory', {})
  assert.equal(inv.items[0].name, 'oak_log')
  assert.equal(inv.freeSlots, 35)
  const env = await reg.invoke(bot, 'get_environment', {})
  assert.equal(env.dimension, 'unknown', 'fake has no game — still a clean result')
})

test('gather_resource through the registry reports completed amounts and taxonomy', async () => {
  const reg = createRegistry()
  const blocks = new Map([['3,71,0', 'oak_log'], ['5,71,1', 'oak_log']])
  const inv = []
  const bot = makeBot({ blocks })
  bot.inventory.items = () => inv
  bot.dig = async block => {
    blocks.set(key(block.position), 'air')
    inv.push({ name: 'oak_log', count: 1 })
  }
  const res = await reg.invoke(bot, 'gather_resource', { type: 'logs', amount: 2 }, { camp: CAMP })
  assert.deepEqual({ status: res.status, completed: res.completed, requested: res.requested }, { status: 'success', completed: 2, requested: 2 })
  const none = await reg.invoke(makeBot(), 'gather_resource', { type: 'logs', amount: 4 }, { camp: CAMP })
  assert.equal(none.status, 'failed')
  assert.equal(none.reason, 'target_not_found')
  assert.ok(none.recoveryHints.includes('explore_area'), 'hints point at exploration')
})

test('navigate_to reports through the contract; can_reach refuses mid-walk', async () => {
  const reg = createRegistry()
  const bot = makeBot()
  const walk = await reg.invoke(bot, 'navigate_to', { position: { x: 6, y: 71, z: 0 }, range: 2, timeoutMs: 3000 }, { camp: CAMP })
  assert.equal(walk.status, 'success', 'fake pathfinder teleports to the goal')

  // A walk that never arrives is ACTIVE when the check comes in: refusal, no hijack.
  const walker = makeBot()
  walker.pathfinder.setGoal = () => {}
  const nav = navigatorFor(walker)
  const id = nav.start({ x: 600, y: 71, z: 0 }, { timeoutMs: 20000 })
  await sleep(60)
  const busy = await reg.invoke(walker, 'can_reach', { position: { x: 60, y: 71, z: 0 } }, { camp: CAMP })
  assert.equal(busy.status, 'failed')
  assert.equal(busy.reason, 'navigation in progress')
  const stopped = await reg.invoke(walker, 'stop_navigation', {}, { camp: CAMP })
  assert.equal(stopped.cancelled, true, 'stop_navigation cancels the active walk')
  assert.equal(nav.status(id).status, 'cancelled')
})

test('deposit_resources and give_items complete transfers through the contract', async () => {
  const reg = createRegistry()
  const blocks = new Map([[key(CAMP.chest), 'chest']])
  const inv = [{ name: 'dirt', count: 5 }]
  const bot = makeBot({ blocks, inv })
  bot.openContainer = async () => ({
    deposit: async (type, meta, n) => { inv.length = 0 },
    containerItems: () => [],
    close: () => {}
  })
  const deposited = await reg.invoke(bot, 'deposit_resources', { item: 'dirt', n: 5 }, { camp: CAMP })
  assert.deepEqual({ status: deposited.status, completed: deposited.completed, requested: deposited.requested }, { status: 'success', completed: 5, requested: 5 })
  const back = await reg.invoke(bot, 'return_to_base', {}, { camp: CAMP })
  assert.equal(back.status, 'success', 'goNear over the instant fake pathfinder')

  const giver = makeBot()
  giver.players.Cmd = { entity: { position: new Vec3(2, 71, 0) } }
  giver.inventory.items = () => [{ name: 'oak_log', count: 3 }]
  const tossed = []
  giver.toss = async (type, meta, n) => tossed.push(n)
  giver.lookAt = async () => {}
  const given = await reg.invoke(giver, 'give_items', { item: 'logs', player: 'Cmd' }, { camp: CAMP })
  assert.equal(given.completed, 3)
  assert.deepEqual(tossed, [3])
})

test('craft_item wraps building.craftPlanks with the unified result', async () => {
  const reg = createRegistry()
  const inv = [{ name: 'oak_log', count: 2, type: 17 }]
  const bot = makeBot({ inv })
  bot.registry = { itemsByName: { oak_planks: { id: 5, name: 'oak_planks' } } }
  bot.recipesFor = () => [{ recipe: true }]
  bot.craft = async () => {
    inv[0].count -= 1
    const planks = inv.find(i => i.name === 'oak_planks')
    if (planks) planks.count += 4
    else inv.push({ name: 'oak_planks', count: 4, type: 5 })
  }
  const res = await reg.invoke(bot, 'craft_item', { item: 'planks', amount: 4 }, { camp: CAMP })
  assert.deepEqual({ status: res.status, completed: res.completed }, { status: 'success', completed: 4 })
  const bad = await reg.invoke(bot, 'craft_item', { item: 'diamond_sword' }, { camp: CAMP })
  assert.equal(bad.reason, 'bad_params', 'enum param rejected before any crafting')
})

test('normalizeResult keeps taxonomy hints and strips raw status fields', () => {
  const n = normalizeResult('gather_resource', 8, { status: 'partial', reason: 'target_unreachable', gathered: 3, carried: 3, elapsedMs: 500 })
  assert.equal(n.status, 'partial')
  assert.equal(n.reason, 'target_unreachable')
  assert.deepEqual(n.recoveryHints, ['find_resource', 'can_reach'])
  assert.equal(n.completed, 3)
  assert.equal(n.status, 'partial', 'raw status did not leak into the spread')
  const ok = normalizeResult('mine_block', undefined, { ok: true, gained: 1, block: 'oak_log' })
  assert.equal(ok.status, 'success')
  assert.equal(ok.completed, undefined, 'non-amount skills do not fake completed counts')
})

test('describeSkills is a complete LLM-facing catalog; registerSkill extends it', async () => {
  const reg = createRegistry()
  const catalog = reg.describeSkills()
  const names = catalog.map(s => s.name)
  assert.ok(names.length >= 15, `got ${names.length} skills`)
  assert.equal(new Set(names).size, names.length, 'unique names')
  for (const def of catalog) {
    assert.ok(def.description, `${def.name} lacks a description`)
    assert.ok(typeof def.params === 'object', `${def.name} lacks a param schema`)
  }
  for (const required of ['scan_area', 'find_blocks', 'inspect_block', 'navigate_to', 'navigation_status', 'stop_navigation', 'mine_block', 'place_block', 'craft_item', 'inspect_inventory', 'gather_resource', 'return_to_base', 'deposit_resources']) {
    assert.ok(names.includes(required), `roadmap primitive missing: ${required}`)
  }
  reg.registerSkill({ name: 'dance', description: 'Spin around', params: {}, run: async () => ({ danced: true }) })
  const result = await registryHas(reg, 'dance')
  assert.equal(result.status, 'success')
})

async function registryHas (reg, name) {
  await sleep(1)
  const bot = makeBot()
  return reg.invoke(bot, name, {}, { camp: CAMP })
}
