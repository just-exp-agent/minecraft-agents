import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Vec3 from 'vec3'
import { neighborsOfSector, sectorCenter, createSpatialMemory } from '../src/memory/spatial.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = p => `${p.x},${p.y},${p.z}`

/** Map-world bot: teleporting pathfinder (navigator), blockAt/findBlocks for scanArea. */
function makeBot ({ pos = new Vec3(0, 71, 0), blocks = new Map(), stayPutAt = null } = {}) {
  const bot = new EventEmitter()
  bot.username = 'MemTest'
  bot.entity = { position: pos.clone() }
  bot.entities = {}
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
    setGoal: g => {
      if (!g) return
      if (stayPutAt && Math.abs(g.x - stayPutAt.x) < 1 && Math.abs(g.z - stayPutAt.z) < 1) {
        bot.emit('path_update', { status: 'noPath' })
        return
      }
      bot.entity.position = new Vec3(g.x, g.y, g.z)
      bot.emit('path_update', { status: 'success' })
    }
  }
  return bot
}

test('sector math: keys are stable across negative coordinates; neighbours are the 8-ring', () => {
  assert.equal(neighborsOfSector('0,0').length, 8)
  assert.ok(neighborsOfSector('0,0').includes('-1,-1'))
  const c = sectorCenter('-1,2')
  assert.deepEqual({ x: c.x, z: c.z }, { x: -16, z: 80 }, '32-block sectors, world coordinates')
})

test('visits and scans fold into the sector indexes', () => {
  const bot = makeBot()
  const mem = createSpatialMemory(bot)
  mem.noteVisit({ x: 10, y: 71, z: 10 })
  mem.recordScan({ x: 10, y: 71, z: 10 }, {
    blocks: [
      { category: 'logs', name: 'oak_log', position: { x: 6, y: 71, z: 14 }, distance: 5 },
      { category: 'containers', name: 'chest', position: { x: 8, y: 71, z: 6 }, distance: 5 }
    ],
    entities: []
  })
  const stats = mem.stats()
  assert.equal(stats.visited, 1)
  assert.equal(stats.records, 2)
  const logs = mem.knownResources('logs')
  assert.equal(logs.length, 1)
  assert.deepEqual(logs[0].position, { x: 6, y: 71, z: 14 })
})

test('knownResources filters stale records by age but keeps them stored', async () => {
  const bot = makeBot()
  const mem = createSpatialMemory(bot)
  mem.noteVisit({ x: 0, y: 71, z: 0 })
  mem.recordScan({ x: 0, y: 71, z: 0 }, { blocks: [{ category: 'logs', name: 'oak_log', position: { x: 5, y: 71, z: 5 }, distance: 7 }], entities: [] })
  assert.equal(mem.knownResources('logs', { maxAgeMs: 100 }).length, 1, 'fresh record offered')
  await sleep(30)
  assert.equal(mem.knownResources('logs', { maxAgeMs: 10 }).length, 0, 'stale record not offered')
  assert.equal(mem.knownResources('logs', { maxAgeMs: 60000 }).length, 1, 'still stored for inspection')
  assert.equal(mem.knownResources('dirt').length, 0, 'absence of a record is not checked wrongly')
})

test('frontier picks the nearest unknown neighbour of the known world', () => {
  const bot = makeBot({ pos: new Vec3(0, 71, 0) })
  const mem = createSpatialMemory(bot)
  assert.equal(mem.frontier(), null, 'nothing known → no boundary yet')
  mem.noteVisit({ x: 0, y: 71, z: 0 })
  const first = mem.frontier()
  assert.ok(first, 'boundary exists after the first visit')
  assert.notEqual(first.key, '0,0')
  // Explore it: the next frontier must be a different sector.
  mem.noteVisit(first.center)
  const second = mem.frontier()
  assert.ok(second && second.key !== first.key, 'frontier moves on')
  // Mark the next one unreachable: frontier skips it.
  mem.markUnreachable(second.center, 'navigation failed: no path')
  const third = mem.frontier()
  assert.ok(third && third.key !== second.key, 'blocked sector is not suggested again')
})

test('exploreArea walks the frontier loop, scans and indexes what it finds', async () => {
  // Every sector center in a 5x5 grid holds a log: whichever frontier sector the
  // nearest-first walk picks, its scan is guaranteed to index something.
  const blocks = new Map()
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) blocks.set(`${cx * 32 + 16},71,${cz * 32 + 16}`, 'oak_log')
  }
  const bot = makeBot({ pos: new Vec3(0, 71, 0), blocks })
  const mem = createSpatialMemory(bot)
  mem.noteVisit({ x: 0, y: 71, z: 0 })
  const result = await mem.exploreArea({ maxSteps: 2, scanRadius: 24 })
  assert.equal(result.steps, 2, 'two new sectors explored')
  assert.ok(result.discovered.logs >= 2, `logs indexed along the way (${JSON.stringify(result.discovered)})`)
  const known = mem.knownResources('logs')
  assert.ok(known.length >= 2, 'resource index grew')
  assert.equal(mem.stats().visited, 3, 'home + two frontier sectors')
})

test('exploreArea marks a blocked sector and moves on to the next one', async () => {
  const bot = makeBot({ pos: new Vec3(0, 71, 0), stayPutAt: sectorCenter('1,0') })
  const mem = createSpatialMemory(bot)
  mem.noteVisit({ x: 0, y: 71, z: 0 })
  const result = await mem.exploreArea({ maxSteps: 3, scanRadius: 16 })
  assert.ok(result.steps >= 1, 'at least one reachable sector was explored')
  const blocked = mem.frontier()
  assert.ok(blocked === null || blocked.key !== '1,0', 'the no-path sector is not suggested again')
})

test('serialize/restore round-trips the map into a fresh memory', () => {
  const bot = makeBot()
  const mem = createSpatialMemory(bot)
  mem.noteVisit({ x: 10, y: 71, z: 10 })
  mem.recordScan({ x: 10, y: 71, z: 10 }, { blocks: [{ category: 'logs', name: 'oak_log', position: { x: 6, y: 71, z: 14 }, distance: 5 }], entities: [] })
  mem.markUnreachable({ x: -40, y: 71, z: 40 }, 'navigation failed: no path')
  const data = mem.serialize()
  const mem2 = createSpatialMemory(makeBot())
  mem2.restore(JSON.parse(JSON.stringify(data)))
  assert.deepEqual(mem2.stats(), mem.stats())
  assert.equal(mem2.knownResources('logs').length, 1)
})
