// Hierarchical goal planner (roadmap Шаг 6): a goal becomes a task chain (DAG); every
// task carries inputs, dependencies, status and a completion criterion. Known sequences
// (recipes, obtain chains, the shelter build order) decompose deterministically; an LLM
// decomposer hook exists for ambiguous goals — the LLM only shapes the task list, it
// never executes mechanics. Execution runs Шаг-5 registry skills; failure reasons feed
// Шаг-7 recovery policies.
import { registry } from './registry.js'
import { countItems } from './skills.js'
import { craftPlanks, buildCells, isBuilt, withdrawFromChest, PLANKS } from './building.js'
import { PLANKS_PER_LOG, hutProgress } from './blueprint.js'

const ITEM_PATTERNS = Object.freeze({ logs: /_log$/, planks: /_planks$/, emerald: /^emerald$/, dirt: /^dirt$/, stone: /^cobblestone$/, sand: /^sand$/ })
const GATHERABLE = Object.freeze(['dirt', 'stone', 'sand'])

/** Pure: known recipe steps to obtain an item (the deterministic part of decomposition). */
export function recipeFor (item, amount = 1) {
  if (item === 'logs' || /_log$/.test(item)) {
    return [{ skill: 'gather_resource', args: { type: 'logs', amount } }]
  }
  if (item === 'planks' || /_planks$/.test(item)) {
    return [
      { skill: 'gather_resource', args: { type: 'logs', amount: Math.ceil(amount / PLANKS_PER_LOG) } },
      { skill: 'craft_item', args: { item: 'planks', amount } }
    ]
  }
  if (GATHERABLE.includes(item)) return [{ skill: 'gather_resource', args: { type: item, amount } }]
  return null // unknown: only an LLM decomposer could shape this
}

let taskId = 0
const nextTaskId = () => `t${++taskId}`

const stepOk = r => r.status === 'success'

/** Pure: goal { item, amount } | { shelter } → task chain. unknown:true = no recipe. */
export function decomposeGoal (goal) {
  if (typeof goal !== 'object' || goal === null) throw new Error('goal must be { item, amount } or a shelter goal')
  if (goal.shelter && goal.blueprint && goal.camp) {
    // BuildShelter → EnsureResources → BuildSections → Verify (the demo's known order).
    const tasks = []
    const sections = Object.keys(goal.blueprint.sections)
    const totalCells = sections.reduce((sum, s) => sum + goal.blueprint.sections[s].length, 0)
    const logsNeeded = Math.ceil(totalCells / PLANKS_PER_LOG)
    const ensure = { id: nextTaskId(), skill: 'gather_resource', args: { type: 'logs', amount: logsNeeded }, dependsOn: [], status: 'pending', completion: r => (r.completed || 0) >= Math.floor(logsNeeded * 0.6) }
    tasks.push(ensure)
    let prev = ensure.id
    for (const section of sections) {
      const t = { id: nextTaskId(), skill: 'build_section', args: { section }, dependsOn: [prev], status: 'pending', completion: stepOk }
      tasks.push(t)
      prev = t.id
    }
    tasks.push({ id: nextTaskId(), skill: 'verify_progress', args: {}, dependsOn: [prev], status: 'pending', completion: stepOk })
    return { goal, tasks, unknown: false }
  }
  const steps = recipeFor(goal.item, goal.amount || 1)
  if (!steps) return { goal, tasks: [], unknown: true }
  return decomposeSteps(steps, goal)
}

/** Optional LLM hook (off by default): shape an unknown goal into registry steps. */
export async function decomposeWithLLM (goal, askJson) {
  const answer = await askJson({
    agent: 'planner',
    system: 'Decompose the Minecraft goal into registry skill steps. Reply ONLY with JSON: {"tasks":[{"skill":"...","args":{}}]}',
    user: `Goal: ${JSON.stringify(goal)}. Known skills: ${registry.describeSkills().map(s => s.name).join(', ')}.`,
    validate: d => {
      if (!Array.isArray(d.tasks) || !d.tasks.length) throw new Error('no tasks')
      return d
    }
  })
  return decomposeSteps(answer.tasks, goal)
}

/** Pure: turn {skill, args} steps into a dependency chain. */
export function decomposeSteps (steps, goal) {
  let prev = null
  const tasks = steps.map(step => {
    const t = { id: nextTaskId(), skill: step.skill, args: step.args || {}, dependsOn: prev ? [prev] : [], status: 'pending', completion: stepOk }
    prev = t.id
    return t
  })
  return { goal, tasks, unknown: false }
}

/**
 * Execute a task chain through the registry, respecting dependencies. A failed task
 * gets bounded retries, then the rest of the chain is blocked and the failure reported
 * with the failing task (Шаг-7 recovery policies key off its reason).
 */
export async function executePlan (plan, bot, { ctx = {}, onTaskDone = () => {}, shouldStop = () => false, maxRetries = 1, registry: reg = registry } = {}) {
  const byId = new Map(plan.tasks.map(t => [t.id, t]))
  let failedTask = null
  for (const task of plan.tasks) {
    if (shouldStop()) break
    const unmet = task.dependsOn.some(id => byId.get(id)?.status !== 'success')
    if (unmet) {
      task.status = 'blocked'
      continue
    }
    let result = null
    for (let attempt = 0; attempt <= maxRetries && !shouldStop(); attempt++) {
      result = await reg.invoke(bot, task.skill, task.args, ctx)
      if (task.completion(result)) break
    }
    task.result = result
    if (result && task.completion(result)) {
      task.status = 'success'
    } else {
      task.status = 'failed'
      task.failureReason = result?.reason || 'interaction_failed'
      failedTask = task
    }
    onTaskDone(task, result)
    if (task.status === 'failed') break
  }
  for (const task of plan.tasks) {
    if (task.status === 'pending' && failedTask) task.status = 'blocked'
  }
  const allDone = plan.tasks.every(t => t.status === 'success')
  return {
    status: allDone ? 'success' : failedTask ? 'failed' : 'partial',
    completed: plan.tasks.filter(t => t.status === 'success').length,
    total: plan.tasks.length,
    failedTask: failedTask ? { skill: failedTask.skill, reason: failedTask.failureReason, args: failedTask.args } : null
  }
}

/** Composite skills (roadmap Шаг 5/6) registered on top of the planner. */
export function registerPlannerSkills (reg = registry) {
  reg.registerSkill({
    name: 'obtain_item',
    description: 'Obtain an item by any means: gather it, or gather inputs and craft',
    params: { item: { type: 'string', required: true }, amount: { type: 'number' } },
    run: async (bot, a, ctx) => {
      const plan = decomposeGoal({ item: a.item, amount: a.amount || 1 })
      if (plan.unknown) throw new Error(`no known recipe for ${a.item}`)
      const result = await executePlan(plan, bot, { ctx, registry: reg })
      return {
        status: result.status,
        reason: result.failedTask?.reason || null,
        obtained: a.item,
        steps: result.completed,
        totalSteps: result.total
      }
    }
  })
  reg.registerSkill({
    name: 'build_section',
    description: 'Withdraw logs from the camp chest, craft planks, build one blueprint section (ctx.blueprint, ctx.camp)',
    params: { section: { type: 'string', required: true } },
    run: async (bot, a, ctx) => {
      const section = ctx.blueprint?.sections?.[a.section]
      if (!section) throw new Error(`unknown section "${a.section}"`)
      const todo = section.filter(c => !isBuilt(bot, c))
      if (todo.length === 0) return { status: 'success', placed: 0, remaining: 0, section: a.section }
      const logsNeeded = Math.max(0, Math.ceil((todo.length - countItems(bot, PLANKS)) / PLANKS_PER_LOG))
      await withdrawFromChest(bot, ctx.camp.chest, /_log$/, logsNeeded)
      await craftPlanks(bot, todo.length)
      const result = await buildCells(bot, todo)
      return {
        status: result.remaining === 0 ? 'success' : 'partial',
        reason: result.remaining === 0 ? null : 'ran_out_of_planks_or_time',
        placed: result.placed,
        remaining: result.remaining,
        section: a.section
      }
    }
  })
  reg.registerSkill({
    name: 'verify_progress',
    description: 'Check shelter progress against the blueprint (ctx.blueprint)',
    params: {},
    run: (bot, _a, ctx) => {
      const progress = hutProgress(ctx.blueprint, p => isBuilt(bot, p))
      const complete = progress.total > 0 && progress.built === progress.total
      return { status: complete ? 'success' : 'partial', built: progress.built, total: progress.total }
    }
  })
}

registerPlannerSkills()
