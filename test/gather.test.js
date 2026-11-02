import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Vec3 from 'vec3'
import { RESOURCES, resourceDef, findResource, mineBlock, gatherResource, navigateTo } from '../src/gather.js'
import { config } from '../src/config.js'

const GATHER = config.params.gather || {}
const NAV_RANGE = GATHER.nav_range ?? 2
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = p => `${p.x},${p.y},${p.z}`

/** Map-based bot double for findResource/mineBlock; findBlocks emulates the palette gate. */
function makeBot ({ pos = new Vec3(0, 71, 0), blocks = new Map(), inv = [], slots = [], dig = null } = {}) {
  const bot = new EventEmitter()
  bot.username = 'GatherTest'
  bot.entity = { position: pos.clone() }
  bot.inventory = { items: () => inv, slots }
  bot.blockAt = v => {
    const name = blocks.get(key(v))
    return name ? { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new Vec3(v.x, v.y, v.z) } : null
  }
  bot.findBlocks = ({ matching, maxDistance, count }) => [...blocks.entries()]
    .map(([k, name]) => { const [x, y, z] = k.split(',').map(Number); return { name, position: new Vec3(x, y, z) } })
    .filter(matching)
    .map(b => b.position)
    .filter(p => p.distanceTo(pos) <= maxDistance)
    .slice(0, count)
  bot.dig = dig || (async block => {
    blocks.set(key(block.position), 'air')
    inv.push({ name: 'oak_log', count: 1 })
  })
  bot.pathfinder = { setGoal: g => { if (g) bot.entity.position = new Vec3(g.x, g.y, g.z) } }
  return bot
}

test('resourceDef validates types; the catalogue is not log-only', () => {
  assert.equal(resourceDef('logs').heightWindow, 'feet')
  assert.equal(resourceDef('dirt').drop.source, '^dirt$', 'grass_block drops dirt, not grass')
  assert.throws(() => resourceDef('diamond_ore'), /Unknown resource/)
  assert.ok(Object.keys(RESOURCES).length >= 4, 'several types must be supported')
})

test('findResource applies the height window for logs but not for dirt', () => {
  const blocks = new Map([
    ['3,71,0', 'oak_log'],
    ['4,78,0', 'oak_log'],   // canopy log above the window
    ['0,70,0', 'grass_block'], // below feet: dirt is fine, logs would be filtered
    ['6,71,0', 'birch_log']
  ])
  const logs = findResource(makeBot({ blocks, pos: new Vec3(0, 71, 0) }), 'logs', { radius: 16 })
  assert.deepEqual(logs.map(c => c.name).sort(), ['birch_log', 'oak_log'], 'canopy log stays out')
  const dirt = findResource(makeBot({ blocks, pos: new Vec3(0, 71, 0) }), 'dirt', { radius: 16 })
  assert.equal(dirt[0].name, 'grass_block', 'dirt may be below feet, nearest first')
})

test('findResource honors radius, ranks towards the anchor and skips excluded candidates', () => {
  const blocks = new Map([
    ['2,71,0', 'oak_log'],
    ['10,71,0', 'oak_log'],
    ['20,71,0', 'oak_log']
  ])
  const bot = makeBot({ blocks, pos: new Vec3(0, 71, 0) })
  assert.equal(findResource(bot, 'logs', { radius: 5 }).length, 1, 'radius filters')
  const anchored = findResource(bot, 'logs', { anchor: { x: 20, y: 71, z: 0 } })
  assert.equal(anchored[0].position.x, 20, 'anchor-nearest first')
  const excluded = new Set(['20,71,0', '10,71,0'])
  assert.deepEqual(findResource(bot, 'logs', { excluded }).map(c => c.position.x), [2])
  assert.deepEqual(findResource({}, 'logs', {}), [], 'no world → empty, not a crash')
})

test('navigateTo resolves with the operation snapshot (success when the bot arrives)', async () => {
  const bot = makeBot()
  const p = navigateTo(bot, { x: 6, y: 71, z: 0 }, { range: 2, timeoutMs: 4000 })
  await sleep(60)
  const snap = await p
  assert.equal(snap.status, 'success', 'the fake pathfinder teleports to the goal')
})

test('mineBlock verifies the world changed and the drop reached the inventory', async () => {
  const blocks = new Map([['3,71,0', 'oak_log']])
  const inv = []
  const bot = makeBot({ blocks, inv })
  const equipped = []
  bot.tool = { equipForBlock: async (block, opts) => equipped.push(block.name) }
  const res = await mineBlock(bot, { x: 3, y: 71, z: 0 })
  assert.deepEqual({ ok: res.ok, gained: res.gained }, { ok: true, gained: 1 })
  assert.equal(equipped[0], 'oak_log', 'auto policy equips the best tool')
  assert.equal(blocks.get('3,71,0'), 'air')
  const air = await mineBlock(bot, { x: 3, y: 71, z: 0 })
  assert.equal(air.reason, 'nothing_to_mine')
  const unloaded = await mineBlock(bot, { x: 999, y: 71, z: 999 })
  assert.equal(unloaded.reason, 'chunk_not_loaded')
})

test('mineBlock reports interaction_failed when the dig throws', async () => {
  const blocks = new Map([['3,71,0', 'stone']])
  const bot = makeBot({ blocks })
  bot.dig = async () => { throw new Error('aborted') }
  bot.tool = null
  const res = await mineBlock(bot, { x: 3, y: 71, z: 0 })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'interaction_failed')
})

test('mineBlock waits for a late pickup and tells the truth when the drop never lands', async () => {
  const blocks = new Map([['3,71,0', 'oak_log']])
  const inv = []
  const bot = makeBot({ blocks, inv })
  // Drop lands only after 700 ms — inside the default verify window.
  const realDig = bot.dig
  bot.dig = async block => { await sleep(700); return realDig(block) }
  const res = await mineBlock(bot, { x: 3, y: 71, z: 0 }, { verifyMs: 2000 })
  assert.deepEqual({ ok: res.ok, gained: res.gained }, { ok: true, gained: 1 })
  // Drop never picked up and the block survives the dig: honest failure.
  const stubborn = new Map([['4,71,0', 'bedrock']])
  const bot2 = makeBot({ blocks: stubborn })
  bot2.dig = async () => {}
  const res2 = await mineBlock(bot2, { x: 4, y: 71, z: 0 }, { verifyMs: 200 })
  assert.equal(res2.ok, false)
  assert.equal(res2.reason, 'dig_did_not_take')
})

test('gatherResource reaches the amount, falls back from unreachable candidates and reports honestly', async () => {
  // Candidate 1 is behind an invisible wall (the fake stop position is 3.5 away → partial),
  // candidates 2 and 3 work. The pipeline must blacklist and continue, then report success.
  const blocks = new Map([['4,71,0', 'oak_log'], ['-6,71,1', 'oak_log'], ['-9,71,0', 'oak_log']])
  const inv = []
  const bot = makeBot({ blocks, inv })
  bot.pathfinder.setGoal = g => {
    if (!g) return
    // Move near the goal; the walled candidate stops 3.5 blocks short (partial).
    const stop = Math.abs(g.x - 4) < 0.6 ? new Vec3(7.5, 71, 0) : new Vec3(g.x, 71, g.z)
    bot.entity.position = stop
    bot.emit('path_update', { status: 'success' }) // let the navigator enter the moving phase
  }
  const res = await gatherResource(bot, 'logs', 2, {})
  assert.deepEqual(
    { status: res.status, gathered: res.gathered, attempts: res.attempts },
    { status: 'success', gathered: 2, attempts: 3 },
    'unreachable candidate consumed one attempt, the fallbacks finished the job'
  )

  const none = await gatherResource(makeBot(), 'logs', 8, {})
  assert.deepEqual({ status: none.status, reason: none.reason }, { status: 'failed', reason: 'target_not_found' })

  const full = makeBot({ blocks: new Map([['4,71,0', 'oak_log']]), slots: buildFullSlots() })
  const fullRes = await gatherResource(full, 'logs', 4, {})
  assert.deepEqual({ status: fullRes.status, reason: fullRes.reason, attempts: fullRes.attempts },
    { status: 'failed', reason: 'inventory_full', attempts: 0 }, 'full inventory stops the pipeline before any walk')

  await assert.rejects(gatherResource(makeBot(), 'coins', 1), /Unknown resource/)
})

function buildFullSlots () {
  const slots = new Array(46).fill(null)
  for (let i = 9; i <= 44; i++) slots[i] = { name: 'oak_planks', count: 64 }
  return slots
}

test('gatherResource stops as partial when only some candidates succeed', async () => {
  const blocks = new Map([['4,71,0', 'oak_log']])
  const inv = []
  const bot = makeBot({ blocks, inv })
  bot.pathfinder.setGoal = g => { if (g) bot.entity.position = new Vec3(g.x, 71, g.z) }
  const res = await gatherResource(bot, 'logs', 8, { maxCandidateFailures: GATHER.max_candidate_failures ?? 4 })
  assert.equal(res.status, 'partial')
  assert.equal(res.gathered, 1)
  assert.equal(res.reason, 'candidates_exhausted')
})
