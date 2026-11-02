import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAILURE_TAXONOMY, POLICIES, recoverFrom, runWithRecovery } from '../src/recovery.js'
import { decomposeSteps } from '../src/planner.js'

const BOT = { entity: { position: { x: 0, y: 71, z: 0 } } }

test('every taxonomy reason has a policy — no silent failures', () => {
  for (const reason of FAILURE_TAXONOMY) {
    assert.equal(typeof POLICIES[reason], 'function', `no policy for "${reason}"`)
  }
})

test('recoverFrom never throws and answers bounded decisions', async () => {
  for (const reason of FAILURE_TAXONOMY) {
    const decision = await recoverFrom(reason, { bot: BOT, args: {}, attempts: 0 })
    assert.ok(['retry', 'alternative', 'obtain', 'deposit', 'replan', 'abort'].includes(decision.action), `${reason} -> ${decision.action}`)
    assert.ok(typeof decision.hint === 'string', `${reason} must explain itself`)
  }
  const mystery = await recoverFrom('nonexistent_reason', { bot: BOT })
  assert.equal(mystery.action, 'abort')
  assert.match(mystery.hint, /no policy/)
})

test('target_not_found consults spatial memory: alternative if known, replan if not', async () => {
  const memory = {
    exploreArea: async () => { throw new Error('should not be called when the map already knows') },
    knownResources: () => [{ position: { x: 10, y: 71, z: 20 } }]
  }
  const d = await recoverFrom('target_not_found', { bot: BOT, memory, args: { type: 'logs' } })
  assert.equal(d.action, 'alternative')
  assert.deepEqual(d.target, { x: 10, y: 71, z: 20 })

  const empty = {
    exploreArea: async () => {},
    knownResources: () => []
  }
  const d2 = await recoverFrom('target_not_found', { bot: BOT, memory: empty, args: { type: 'logs' } })
  assert.equal(d2.action, 'replan', 'explored once, still nothing → replan')
  const d3 = await recoverFrom('target_not_found', { bot: BOT, memory: null, args: {} })
  assert.equal(d3.action, 'replan', 'no memory → straight replan')
})

test('missing_tool proposes the deterministic recipe chain', async () => {
  const d = await recoverFrom('missing_tool', { bot: BOT, args: { tool: 'logs' } })
  assert.equal(d.action, 'obtain')
  assert.deepEqual(d.steps, [{ skill: 'gather_resource', args: { type: 'logs', amount: 1 } }])
  const d2 = await recoverFrom('missing_tool', { bot: BOT, args: { tool: 'wither_skull' } })
  assert.equal(d2.action, 'abort', 'no recipe → abort, no infinite chase')
})

test('runWithRecovery: success needs no recovery', async () => {
  let runs = 0
  const result = await runWithRecovery(decomposeSteps([{ skill: 'x' }], { g: 1 }), BOT, {
    executePlan: async () => { runs++; return { status: 'success', completed: 1, total: 1 } }
  })
  assert.equal(result.status, 'success')
  assert.equal(runs, 1)
  assert.equal(result.recoveries, 0)
})

test('runWithRecovery: danger aborts on the first failure without any retry', async () => {
  let runs = 0
  const result = await runWithRecovery(decomposeSteps([{ skill: 'x' }], { g: 1 }), BOT, {
    executePlan: async () => { runs++; return { status: 'failed', completed: 0, total: 1, failedTask: { skill: 'x', reason: 'danger_detected', args: {} } } },
    maxRecoveries: 3
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.recovery.action, 'abort')
  assert.equal(runs, 1, 'danger must not loop')
  assert.equal(result.recoveries, 0)
})

test('runWithRecovery: replan rebuilds the plan and the second round succeeds', async () => {
  let runs = 0
  const fresh = decomposeSteps([{ skill: 'y' }], { g: 2 })
  const result = await runWithRecovery(decomposeSteps([{ skill: 'x' }], { g: 1 }), BOT, {
    executePlan: async plan => {
      runs++
      return runs === 1
        ? { status: 'failed', completed: 0, total: 1, failedTask: { skill: 'x', reason: 'target_not_found', args: {} } }
        : { status: 'success', completed: 1, total: 1 }
    },
    decomposeGoal: () => fresh,
    maxRecoveries: 2
  })
  assert.equal(result.status, 'success')
  assert.equal(runs, 2, 'one replan, then the fresh plan ran')
  assert.equal(result.recoveries, 1)
  assert.deepEqual(result.decisions[0].reason, 'target_not_found')
})

test('runWithRecovery: the budget is hard — retry-forever reasons still stop', async () => {
  let runs = 0
  const result = await runWithRecovery(decomposeSteps([{ skill: 'x' }], { g: 1 }), BOT, {
    executePlan: async () => { runs++; return { status: 'failed', completed: 0, total: 1, failedTask: { skill: 'x', reason: 'timeout', args: {} } } },
    maxRecoveries: 2
  })
  assert.equal(result.status, 'failed')
  assert.ok(runs <= 4, `bounded runs (got ${runs})`)
  assert.match(result.recovery.hint, /budget exhausted/)
})
