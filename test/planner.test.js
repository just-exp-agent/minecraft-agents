import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Vec3 from 'vec3'
import { recipeFor, decomposeGoal, decomposeSteps, executePlan, registerPlannerSkills } from '../src/planner.js'
import { createRegistry } from '../src/registry.js'
import { createHutBlueprint } from '../src/blueprint.js'

const CAMP = { chest: new Vec3(-90, 71, 58), fire: new Vec3(-93, 71, 61) }

test('recipeFor decomposes known items and admits ignorance for unknown ones', () => {
  assert.deepEqual(recipeFor('logs', 8), [{ skill: 'gather_resource', args: { type: 'logs', amount: 8 } }])
  const planks = recipeFor('planks', 12)
  assert.equal(planks.length, 2)
  assert.equal(planks[0].args.amount, 3, 'ceil(12/4) logs needed')
  assert.equal(planks[1].skill, 'craft_item')
  assert.equal(recipeFor('netherite_ingot', 1), null, 'no recipe — only the LLM decomposer could help')
})

test('decomposeGoal builds a dependency chain with completion criteria', () => {
  const plan = decomposeGoal({ item: 'planks', amount: 8 })
  assert.equal(plan.unknown, false)
  assert.equal(plan.tasks.length, 2)
  assert.deepEqual(plan.tasks[1].dependsOn, [plan.tasks[0].id], 'craft depends on gather')
  assert.ok(typeof plan.tasks[0].completion === 'function')

  const shelter = decomposeGoal({
    shelter: true,
    camp: CAMP,
    blueprint: createHutBlueprint(new Vec3(-84, 71, 51))
  })
  assert.equal(shelter.unknown, false)
  const skills = shelter.tasks.map(t => t.skill)
  assert.deepEqual(skills, ['gather_resource', 'build_section', 'build_section', 'build_section', 'build_section', 'build_section', 'verify_progress'])
  assert.ok(shelter.tasks.every((t, i) => i === 0 || t.dependsOn.length === 1), 'a strict chain')
})

test('decomposeSteps turns LLM-shaped steps into a chain', () => {
  const plan = decomposeSteps([{ skill: 'scan_area', args: { radius: 16 } }, { skill: 'get_environment', args: {} }], { item: 'recon' })
  assert.equal(plan.tasks.length, 2)
  assert.deepEqual(plan.tasks[1].dependsOn, [plan.tasks[0].id])
})

test('executePlan runs registry skills in order and reports the failing task', async () => {
  const reg = createRegistry()
  const log = []
  const bot = new EventEmitter()
  bot.username = 'PlanTest'
  bot.entity = { position: new Vec3(0, 71, 0) }
  bot.calls = 0
  reg.registerSkill({
    name: 'always_ok', description: 'test stub', params: {},
    run: async () => { bot.calls++; return { ok: true, n: bot.calls } }
  })
  reg.registerSkill({
    name: 'always_fails', description: 'test stub', params: {},
    run: async () => ({ status: 'failed', reason: 'target_unreachable' })
  })
  const plan = decomposeSteps([
    { skill: 'always_ok', args: {} },
    { skill: 'always_fails', args: {} },
    { skill: 'always_ok', args: {} }
  ], { item: 'demo' })
  const result = await executePlan(plan, bot, { ctx: { camp: CAMP }, maxRetries: 1, registry: reg })
  assert.equal(result.status, 'failed')
  assert.equal(result.completed, 1)
  assert.equal(result.total, 3)
  assert.deepEqual(result.failedTask, { skill: 'always_fails', reason: 'target_unreachable', args: {} })
  assert.equal(bot.calls, 1, 'only the first task ran; the retry hit always_fails, which has no counter')
  assert.equal(plan.tasks[2].status, 'blocked', 'dependents of a failure are blocked')
})

test('executePlan succeeds fully when every task passes', async () => {
  const reg = createRegistry()
  const bot = new EventEmitter()
  bot.username = 'PlanTest'
  bot.entity = { position: new Vec3(0, 71, 0) }
  reg.registerSkill({ name: 'fine', description: 'stub', params: {}, run: async () => ({ ok: true }) })
  const plan = decomposeSteps([{ skill: 'fine' }, { skill: 'fine' }], { item: 'x' })
  const result = await executePlan(plan, bot, { ctx: {}, registry: reg })
  assert.deepEqual({ status: result.status, completed: result.completed, total: result.total }, { status: 'success', completed: 2, total: 2 })
})

test('obtain_item registered by the planner plans, executes and reports', async () => {
  const reg = createRegistry()
  registerPlannerSkills(reg)
  const inv = []
  const blocks = new Map([['3,71,0', 'oak_log']])
  const bot = new EventEmitter()
  bot.username = 'Obtain'
  bot.entity = { position: new Vec3(0, 71, 0) }
  bot.inventory = { items: () => inv, slots: [] }
  bot.findBlocks = ({ matching, count }) => [...blocks.entries()]
    .map(([k, name]) => { const [x, y, z] = k.split(',').map(Number); return { name, position: new Vec3(x, y, z) } })
    .filter(matching).map(b => b.position).slice(0, count)
  bot.blockAt = v => blocks.get(key(v)) ? { name: blocks.get(key(v)), boundingBox: 'block', position: new Vec3(v.x, v.y, v.z) } : { name: 'air', boundingBox: 'empty', position: new Vec3(v.x, v.y, v.z) }
  bot.dig = async block => { blocks.set(key(block.position), 'air'); inv.push({ name: 'oak_log', count: 1 }) }
  bot.pathfinder = { setGoal: g => { if (g) { bot.entity.position = new Vec3(g.x, 71, g.z); bot.emit('path_update', { status: 'success' }) } } }
  bot.registry = { itemsByName: { oak_planks: { id: 5, name: 'oak_planks' } } }
  bot.recipesFor = () => [{ recipe: true }]
  bot.craft = async () => {
    const log = inv.find(i => /_log$/.test(i.name) && i.count > 0)
    if (!log) throw new Error('no logs')
    log.count -= 1
    const planks = inv.find(i => i.name === 'oak_planks')
    if (planks) planks.count += 4
    else inv.push({ name: 'oak_planks', count: 4, type: 5 })
  }
  const res = await reg.invoke(bot, 'obtain_item', { item: 'planks', amount: 4 }, { camp: CAMP })
  assert.equal(res.status, 'success', `plan result: ${JSON.stringify(res)}`)
  assert.deepEqual({ steps: res.steps, totalSteps: res.totalSteps }, { steps: 2, totalSteps: 2 })
  const mystery = await reg.invoke(bot, 'obtain_item', { item: 'netherite_ingot' }, { camp: CAMP })
  assert.equal(mystery.status, 'failed')
  assert.equal(mystery.reason, 'interaction_failed', 'unknown recipes fail cleanly, not silently')
})

const key = p => `${p.x},${p.y},${p.z}`
