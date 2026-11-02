import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Vec3 from 'vec3'
import { createEpisodicMemory, saveAgentMemory, loadAgentMemory, memoryPath } from '../src/memory/episodic.js'
import { createSpatialMemory } from '../src/memory/spatial.js'

test('episodic memory records objective outcomes and computes skill stats', () => {
  const mem = createEpisodicMemory('TestAgent')
  mem.add({ task: 'collect', skill: 'gather_resource', args: { type: 'logs', amount: 6 }, outcome: 'success', reason: null, position: { x: -92, y: 71, z: 60 }, delta: 6 })
  mem.add({ task: 'collect', skill: 'gather_resource', args: { type: 'logs', amount: 6 }, outcome: 'failed', reason: 'target_not_found', position: { x: -50, y: 71, z: 20 }, delta: 0 })
  mem.add({ task: 'collect', skill: 'gather_resource', args: { type: 'logs', amount: 6 }, outcome: 'partial', reason: 'candidates_exhausted', position: { x: -60, y: 71, z: 30 }, delta: 3 })
  assert.equal(mem.size(), 3)
  const stats = mem.skillStats('gather_resource')
  assert.deepEqual({ attempts: stats.attempts, successes: stats.successes }, { attempts: 3, successes: 1 })
  assert.ok(Math.abs(stats.rate - 1 / 3) < 1e-9)
  assert.equal(mem.skillStats('unknown_skill').rate, null, 'no data is not a fabricated rate')
})

test('similar() surfaces what worked last time for the same situation', () => {
  const mem = createEpisodicMemory('TestAgent')
  mem.add({ task: 'collect', skill: 'gather_resource', outcome: 'failed', reason: 'target_not_found' })
  mem.add({ task: 'collect', skill: 'gather_resource', outcome: 'success', reason: null, delta: 6 })
  const similar = mem.similar({ skill: 'gather_resource' })
  assert.equal(similar.length, 2)
  assert.equal(similar.at(-1).outcome, 'success', 'newest last — the LLM reads the tail')
  assert.equal(mem.similar({ skill: 'build_section' }).length, 0)
})

test('serialize/restore round-trips episodes into a fresh memory', () => {
  const mem = createEpisodicMemory('TestAgent')
  mem.add({ task: 'collect', skill: 'gather_resource', outcome: 'success', delta: 4 })
  const mem2 = createEpisodicMemory('TestAgent')
  mem2.restore(JSON.parse(JSON.stringify(mem.serialize())))
  assert.equal(mem2.size(), 1)
  assert.deepEqual(mem2.skillStats('gather_resource'), mem.skillStats('gather_resource'))
})

test('saveAgentMemory/loadAgentMemory persists episodes + the spatial map to disk', () => {
  const agent = 'MemPersistenceTest'
  const spatial = createSpatialMemory(makeBot())
  spatial.noteVisit({ x: 10, y: 71, z: 10 })
  spatial.recordScan({ x: 10, y: 71, z: 10 }, { blocks: [{ category: 'logs', name: 'oak_log', position: { x: 6, y: 71, z: 14 }, distance: 5 }], entities: [] })
  const episodes = createEpisodicMemory(agent)
  episodes.add({ task: 'collect', skill: 'gather_resource', outcome: 'success', delta: 4 })
  saveAgentMemory(agent, { episodes: episodes.serialize(), spatial: spatial.serialize() })

  const loaded = loadAgentMemory(agent)
  assert.ok(loaded, 'the file exists')
  assert.ok(loaded.savedAt)
  assert.equal(loaded.episodes.length, 1)

  const restoredSpatial = createSpatialMemory(makeBot())
  restoredSpatial.restore(loaded.spatial)
  assert.deepEqual(restoredSpatial.stats(), spatial.stats(), 'spatial map survives the round-trip')
  assert.equal(restoredSpatial.knownResources('logs').length, 1)

  assert.equal(loadAgentMemory('NeverSavedAgent'), null, 'no memory yet is null, not an error')
  fs.rmSync(memoryPath(agent), { force: true })
})

function makeBot () {
  return {
    entity: { position: new Vec3(0, 71, 0) },
    findBlocks: () => [],
    blockAt: () => null,
    pathfinder: { setGoal: () => {} }
  }
}
