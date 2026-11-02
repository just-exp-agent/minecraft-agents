import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Vec3 from 'vec3'
import { createNavigator, waitOperation } from '../src/navigation.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Event-emitting bot double: the tests drive pathfinder events manually. */
function makeBot ({ pos = new Vec3(0, 71, 0), onSetGoal = null } = {}) {
  const bot = new EventEmitter()
  bot.username = 'NavTest'
  bot.entity = { position: pos.clone() }
  bot.calls = { setGoal: [] }
  bot.pathfinder = {
    setGoal: g => {
      bot.calls.setGoal.push(g)
      if (onSetGoal) onSetGoal(g)
    }
  }
  return bot
}

test('operation succeeds on arrival; the snapshot carries the contract fields', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 1000 })
  const id = nav.start({ x: 5, y: 71, z: 0 }, { range: 2, timeoutMs: 5000 })
  const first = nav.status(id)
  assert.equal(first.status, 'running')
  assert.equal(first.attempts, 1)
  assert.deepEqual(first.target, { x: 5, y: 71, z: 0 })
  bot.emit('path_update', { status: 'success' })
  assert.equal(nav.status(id).phase, 'moving')
  bot.entity.position = new Vec3(4, 71, 0)
  const snap = await waitOperation(nav, id, { timeoutMs: 2000 })
  assert.equal(snap.status, 'success')
  assert.equal(snap.phase, 'done')
  assert.equal(nav.active(), null, 'no operation left active')
  assert.equal(bot.calls.setGoal.at(-1), null, 'goal released on finish')
})

test('persistent noPath exhausts the retry ladder and fails diagnosably', async () => {
  const bot = makeBot({ onSetGoal: g => { if (g) bot.emit('path_update', { status: 'noPath' }) } })
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 1000 })
  const id = nav.start({ x: 30, y: 71, z: 0 }, { range: 2, timeoutMs: 8000 })
  const snap = await waitOperation(nav, id, { timeoutMs: 4000 })
  assert.equal(snap.status, 'failed')
  assert.match(snap.error, /no path/)
  assert.equal(snap.attempts, 2, 'ladder length comes from params (2 attempts), no infinite retries')
})

test('stuck while moving triggers recovery; persistent stuck fails bounded', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 30, stuckTimeoutMs: 120 })
  const id = nav.start({ x: 20, y: 71, z: 0 }, { range: 2, timeoutMs: 30000 })
  bot.emit('path_update', { status: 'success' }) // now "moving", but position never changes
  await sleep(950) // stuck span + settle pause of the retry ladder (600 ms)
  const mid = nav.status(id)
  assert.equal(mid.attempts, 2, 'one recovery attempt was made')
  // Second attempt also stands still: the ladder is exhausted -> failed, no hang.
  bot.emit('path_update', { status: 'success' })
  await sleep(400)
  const final = nav.status(id)
  assert.equal(final.status, 'failed')
  assert.match(final.error, /stuck/)
  assert.equal(final.attempts, 2)
})

test('cancel stops the operation, clears the goal and ignores late movement', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  const id = nav.start({ x: 50, y: 71, z: 0 }, { range: 2, timeoutMs: 30000 })
  assert.equal(nav.cancel(id), true)
  assert.equal(nav.cancel(id), false, 'second cancel is a no-op')
  assert.equal(nav.status(id).status, 'cancelled')
  assert.equal(bot.calls.setGoal.at(-1), null)
  bot.entity.position = new Vec3(49, 71, 0)
  await sleep(80)
  assert.equal(nav.status(id).status, 'cancelled', 'poll loop is stopped')
})

test('a newer start supersedes the running operation', () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  const a = nav.start({ x: 30, y: 71, z: 0 }, { timeoutMs: 30000 })
  const b = nav.start({ x: -30, y: 71, z: 0 }, { timeoutMs: 30000 })
  assert.equal(nav.status(a).status, 'cancelled')
  assert.match(nav.status(a).error, /superseded/)
  assert.equal(nav.status(b).status, 'running')
  assert.equal(nav.active().id, b)
})

test('operation times out when the bot never arrives; the walk is stopped', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 30, stuckTimeoutMs: 100000 })
  const id = nav.start({ x: 40, y: 71, z: 0 }, { range: 2, timeoutMs: 150 })
  bot.emit('path_update', { status: 'success' })
  bot.entity.position = new Vec3(10, 71, 0)
  const snap = await waitOperation(nav, id, { timeoutMs: 2000 })
  assert.equal(snap.status, 'timeout')
  assert.match(snap.error, /not within/)
  assert.equal(bot.calls.setGoal.at(-1), null)
})

test('arriving only after the ladder widened the range reports partial, not success', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 120 })
  const id = nav.start({ x: 10, y: 71, z: 0 }, { range: 2, timeoutMs: 30000 })
  bot.emit('path_update', { status: 'success' })
  // Stand still next to an obstacle: stuck triggers recovery, the widened attempt (range 4)
  // stops 3.5 blocks from the target — near, but not the requested 2.
  await sleep(950)
  bot.entity.position = new Vec3(13.5, 71, 0)
  bot.emit('path_update', { status: 'success' })
  const snap = await waitOperation(nav, id, { timeoutMs: 2000 })
  assert.equal(snap.status, 'partial', 'widened-range arrival must not be sold as success')
  assert.match(snap.error, /3\.5 blocks from the target \(requested 2\)/)
})

test('goal_reached event finishes the operation successfully', () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  const id = nav.start({ x: 8, y: 71, z: 0 }, { range: 2, timeoutMs: 30000 })
  bot.emit('goal_reached')
  assert.equal(nav.status(id).status, 'success')
})

test('canReach reads the first verdict and clears the throwaway goal', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  const p = nav.canReach({ x: 30, y: 71, z: 0 })
  await sleep(20)
  bot.emit('path_update', { status: 'noPath' })
  assert.deepEqual(await p, { reachable: false, reason: 'no path to the target' })
  assert.equal(bot.calls.setGoal.at(-1), null)
})

test('canReach refuses to answer while an operation is running; its goal stays untouched', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  const id = nav.start({ x: 30, y: 71, z: 0 }, { timeoutMs: 30000 })
  const before = bot.calls.setGoal.length
  const result = await nav.canReach({ x: -30, y: 71, z: 0 }, { budgetMs: 100 })
  assert.deepEqual(result, { reachable: null, reason: 'navigation in progress' })
  assert.equal(bot.calls.setGoal.length, before, 'no extra goal was set')
  assert.equal(nav.status(id).status, 'running')
})

test('canReach answers "cannot say" when the pathfinder stays silent within the budget', async () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  const result = await nav.canReach({ x: 10, y: 71, z: 0 }, { budgetMs: 60 })
  assert.equal(result.reachable, null)
  assert.match(result.reason, /no path verdict/)
})

test('start rejects a malformed target; unknown ids report unknown', () => {
  const bot = makeBot()
  const nav = createNavigator(bot, { sampleMs: 25, stuckTimeoutMs: 5000 })
  assert.throws(() => nav.start({ x: NaN, z: 3 }), /numeric x\/z/)
  assert.equal(nav.status(99).status, 'unknown')
})
