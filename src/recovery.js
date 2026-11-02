// Systematic recovery (roadmap Шаг 7): failures reduce to a bounded taxonomy, and every
// reason has a policy. A policy sees the failure context (bot, memory, task) and answers
// what to do next: retry the skill, pick an alternative target, obtain the missing tool,
// deposit to free the inventory, replan the goal, or abort with a clear report.
// Replanning happens on significant events only — never per tick — and every policy is
// bounded, so nothing loops forever.
import { recipeFor } from './planner.js'

export const FAILURE_TAXONOMY = Object.freeze([
  'target_not_found', 'target_unreachable', 'resource_depleted', 'missing_tool',
  'inventory_full', 'path_stuck', 'danger_detected', 'interaction_failed', 'timeout',
  'interrupted', 'candidates_exhausted', 'bad_params', 'unknown_skill'
])

const MAX_POLICIES_PER_FAILURE = 3 // a failure is analyzed at most this many times

/**
 * Policy table: reason -> async policy(ctx) -> decision
 *   { action: 'retry'|'alternative'|'obtain'|'deposit'|'replan'|'abort', hint?, plan? }
 * ctx: { bot, reason, task, args, memory, camp, attempts }
 * Every decision carries a bound (attempts) the caller must respect.
 */
export const POLICIES = {
  // Nothing was found nearby: ask the map first; only walk a frontier step if it is empty.
  target_not_found: async ctx => {
    const known = ctx.memory?.knownResources(ctx.args?.type || 'logs', { from: ctx.bot.entity?.position })[0]
    if (known) {
      return { action: 'alternative', target: known.position, hint: `spatial memory knows ${ctx.args?.type || 'logs'} at (${known.position.x}, ${known.position.z})` }
    }
    if (ctx.memory) await ctx.memory.exploreArea({ maxSteps: 1, scanRadius: 16 })
    return { action: 'replan', hint: 'explored one frontier sector; still nothing — replan the goal' }
  },

  // The target exists but cannot be approached: ask the map for another candidate.
  target_unreachable: async ctx => {
    const alternative = ctx.memory ? ctx.memory.knownResources(ctx.args?.type || 'logs', { from: ctx.bot.entity?.position })[0] : null
    ctx.memory?.markUnreachable?.(ctx.task?.args?.position || ctx.bot.entity?.position, `navigation failed (${ctx.reason})`)
    return alternative
      ? { action: 'alternative', target: alternative.position, hint: 'switching to a remembered candidate' }
      : { action: 'retry', hint: 'no alternative known — one bounded retry of the same skill' }
  },

  // The source ran dry (block gone before we got there): the map is stale, refresh it.
  resource_depleted: async ctx => {
    ctx.memory?.markUnreachable?.(ctx.task?.args?.position || ctx.bot.entity?.position, 'resource_depleted')
    return { action: 'retry', hint: 'candidate was stale; re-run find with the refreshed map' }
  },

  // Missing tool: the deterministic recipe chain is the recovery (gather → craft).
  missing_tool: async ctx => {
    const steps = recipeFor(ctx.args?.tool || 'logs', 1)
    return steps
      ? { action: 'obtain', steps, hint: 'obtain the tool through its recipe chain' }
      : { action: 'abort', hint: 'no recipe known for the missing tool' }
  },

  // Inventory full: free it at the base chest before continuing.
  inventory_full: async () => ({ action: 'deposit', hint: 'walk to camp and deposit, then resume the goal' }),

  // The pathfinder wedged: stop the operation, re-observe, then re-walk (bounded).
  path_stuck: async () => ({ action: 'retry', hint: 'stop_navigation, take a fresh observation, walk again' }),

  // Immediate danger: stop everything and let a human/LLM layer decide.
  danger_detected: async () => ({ action: 'abort', hint: 'danger — abort and report' }),

  // Misc mechanical failures: one bounded retry is the whole policy.
  interaction_failed: async ctx => ({ action: ctx.attempts >= MAX_POLICIES_PER_FAILURE ? 'abort' : 'retry', hint: 'bounded retry' }),
  timeout: async ctx => ({ action: ctx.attempts >= MAX_POLICIES_PER_FAILURE ? 'abort' : 'retry', hint: 'bounded retry' }),

  // Terminal-ish: nothing to recover automatically.
  interrupted: async () => ({ action: 'abort', hint: 'superseded by a newer order' }),
  candidates_exhausted: async ctx => {
    if (ctx.memory) await ctx.memory.exploreArea({ maxSteps: 1, scanRadius: 16 })
    return { action: 'replan', hint: 'candidates burned out; explored once — replan or report' }
  },
  bad_params: async () => ({ action: 'abort', hint: 'fix the arguments' }),
  unknown_skill: async () => ({ action: 'abort', hint: 'no such skill' })
}

/**
 * Apply the policy for a failure reason. Returns
 * { action, hint, target?, steps? } — always bounded, never throws.
 */
export async function recoverFrom (reason, ctx = {}) {
  const policy = POLICIES[reason]
  if (!policy) return { action: 'abort', hint: `no policy for "${reason}"` }
  try {
    const decision = await policy({ attempts: 0, ...ctx, reason })
    return { action: decision.action, hint: decision.hint || null, target: decision.target || null, steps: decision.steps || null }
  } catch (err) {
    return { action: 'abort', hint: `recovery itself failed: ${err.message}` }
  }
}

/**
 * Bounded replan loop for a goal: run the plan; on failure, ask the policy; retry,
 * take the suggested alternative, or abort. At most `maxRecoveries` recovery rounds.
 * executePlan/decomposeGoal are injected (planner stays import-cycle-free).
 */
export async function runWithRecovery (plan, bot, {
  ctx = {}, memory = null, maxRecoveries = 2, executePlan, decomposeGoal = null, onEvent = () => {}
} = {}) {
  let currentPlan = plan
  let recoveries = 0
  const decisions = []
  for (let round = 0; round <= maxRecoveries; round++) {
    const result = await executePlan(currentPlan, bot, { ctx, onEvent })
    if (result.status !== 'failed') return { ...result, recoveries, decisions }
    const decision = await recoverFrom(result.failedTask.reason, {
      bot, memory, args: result.failedTask.args, attempts: round
    })
    decisions.push({ round, reason: result.failedTask.reason, ...decision })
    onEvent({ kind: 'recovery', round, reason: result.failedTask.reason, decision })
    if (decision.action === 'abort') {
      return { ...result, status: 'failed', recoveries, decisions, recovery: decision }
    }
    if (decision.action === 'replan') {
      if (!decomposeGoal) return { ...result, status: 'failed', recoveries, decisions, recovery: decision }
      currentPlan = decomposeGoal(currentPlan.goal)
    }
    recoveries += 1
  }
  return { status: 'failed', completed: 0, total: plan.tasks.length, recoveries, decisions, recovery: { action: 'abort', hint: 'recovery budget exhausted' } }
}
