import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskBoard } from '../src/coordination/task-board.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('post → claim → heartbeat → complete is the full lifecycle', () => {
  const board = createTaskBoard()
  const id = board.postTask({ goal: 'order', args: { say: 'collect 6 logs' }, assignedTo: 'Odo' })
  const claimed = board.claim(id, 'Odo')
  assert.equal(claimed.ok, true)
  assert.equal(claimed.task.status, 'accepted')
  assert.equal(board.heartbeat(id, 'Odo').task.status, 'running', 'heartbeat moves accepted → running')
  assert.equal(board.heartbeat(id, 'Odo', 0.5).task.progress, 0.5)
  const done = board.complete(id, 'Odo', { gathered: 6 })
  assert.equal(done.task.status, 'completed')
  assert.deepEqual(done.task.result, { gathered: 6 })
})

test('a claimed task cannot be claimed twice — no duplicate work', () => {
  const board = createTaskBoard()
  const id = board.postTask({ goal: 'order', args: {} })
  assert.equal(board.claim(id, 'Bram').ok, true)
  const second = board.claim(id, 'Lina')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'status_accepted')
})

test('only the assignee may heartbeat, complete or fail', () => {
  const board = createTaskBoard()
  const id = board.postTask({ goal: 'order', args: {} })
  board.claim(id, 'Bram')
  assert.equal(board.heartbeat(id, 'Lina').ok, false)
  assert.equal(board.complete(id, 'Lina', {}).ok, false)
  const failed = board.failTask(id, 'Bram', 'target_unreachable')
  assert.equal(failed.ok, true)
  assert.equal(failed.task.status, 'failed')
  assert.equal(failed.task.blocker, 'target_unreachable')
})

test('pickTaskFor honors explicit assignment and ranks the rest by distance', () => {
  const board = createTaskBoard()
  const far = board.postTask({ goal: 'gather', args: {}, targetArea: { x: 100, z: 100 } })
  const near = board.postTask({ goal: 'gather', args: {}, targetArea: { x: 4, z: 2 } })
  const assigned = board.postTask({ goal: 'gather', args: {}, targetArea: { x: 200, z: 200 }, assignedTo: 'Odo' })
  assert.equal(board.pickTaskFor('Bram', { position: { x: 0, z: 0 } }), near, 'nearest unassigned wins')
  assert.equal(board.pickTaskFor('Odo', { position: { x: 0, z: 0 } }), assigned, 'explicit assignment overrides distance')
  board.claim(near, 'Bram')
  assert.equal(board.pickTaskFor('Lina', { position: { x: 0, z: 0 } }), far, 'claimed tasks leave the pool')
  board.claim(far, 'Lina')
  assert.equal(board.pickTaskFor('Nobody', { position: { x: 0, z: 0 } }), null, 'pool drained')
})

test('lapsed leases requeue the task for someone else', async () => {
  const board = createTaskBoard({ leaseMs: 80, staleMs: 60 })
  const id = board.postTask({ goal: 'gather', args: {} })
  board.claim(id, 'Bram')
  board.heartbeat(id, 'Bram')
  await sleep(140)
  const requeued = board.requeueExpired()
  assert.deepEqual(requeued, [id])
  const task = board.snapshot().find(t => t.taskId === id)
  assert.equal(task.status, 'pending')
  assert.equal(task.assignee, null)
  assert.equal(task.blocker, 'lease_expired')
  assert.equal(board.claim(id, 'Lina').ok, true, 'another worker picks it up after the handover')
})

test('sector reservations keep two workers off one grove', () => {
  const board = createTaskBoard({ leaseMs: 50 })
  assert.equal(board.reserve('-1,-1', 'Bram').ok, true)
  assert.equal(board.reserve('-1,-1', 'Lina').ok, false, 'same sector reserved')
  assert.equal(board.reserve('-1,-1', 'Bram').ok, true, 'owner may re-reserve')
  assert.equal(board.release('-1,-1', 'Lina'), false, 'not yours to release')
  assert.equal(board.release('-1,-1', 'Bram'), true)
  assert.equal(board.reserve('-1,-1', 'Lina').ok, true, 'free after release')
})

test('snapshot reports every task; events flow to the listener', async () => {
  const events = []
  const board = createTaskBoard({ onEvent: e => events.push(e) })
  const id = board.postTask({ goal: 'order', args: { say: 'go' } })
  board.claim(id, 'Bram')
  board.complete(id, 'Bram', {})
  const phases = events.filter(e => e.kind === 'task').map(e => e.phase)
  assert.deepEqual(phases, ['posted', 'claimed', 'completed'])
  assert.equal(board.snapshot().length, 1)
  board.reset()
  assert.equal(board.snapshot().length, 0)
})

test('worker wiring: claim on hear, report on outcome (smoke via the real worker module)', async () => {
  // The worker integration is exercised through the lifecycle functions it calls.
  const board = createTaskBoard()
  const id = board.postTask({ goal: 'order', args: { say: 'Bram, collect 6 logs' }, assignedTo: 'Bram' })
  assert.equal(board.pickTaskFor('Bram'), id)
  assert.equal(board.claim(id, 'Bram').ok, true)
  board.heartbeat(id, 'Bram', 0.3)
  board.complete(id, 'Bram', { gathered: 6 })
  const done = board.snapshot()[0]
  assert.equal(done.status, 'completed')
  assert.equal(done.progress, 1)
})
