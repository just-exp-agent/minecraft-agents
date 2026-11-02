import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Vec3 from 'vec3'
import { pathLength, stuckMs, createTracker } from '../src/benchmark/tracker.js'
import { SCENARIOS, makeContext, baseSetupCommands, commandDelayMs } from '../src/benchmark/scenarios.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('pathLength sums the walked polyline', () => {
  const s = (t, x, y, z) => ({ t, pos: { x, y, z } })
  assert.equal(pathLength([s(0, 0, 0, 0), s(500, 3, 0, 0), s(1000, 3, 4, 0)]), 7)
  assert.equal(pathLength([]), 0)
  assert.equal(pathLength([s(0, 1, 2, 3)]), 0)
})

test('stuckMs counts only spans of immobility that reach the threshold', () => {
  const s = (t, x, z) => ({ t, pos: { x, y: 71, z } })
  const parked = Array.from({ length: 10 }, (_, i) => s(i * 500, 5, 5))
  assert.equal(stuckMs(parked), 4500, 'standing still for 4.5s is stuck')
  const walking = Array.from({ length: 10 }, (_, i) => s(i * 500, i, 5))
  assert.equal(stuckMs(walking), 0, 'a steady walk is not stuck')
  const briefPause = [...Array.from({ length: 4 }, (_, i) => s(i * 500, i, 5)),
    ...Array.from({ length: 4 }, (_, i) => s(2000 + i * 500, 3, 5))]
  assert.equal(stuckMs(briefPause), 0, 'a 1.5s pause stays under the threshold')
  // Four seconds parked, then a teleport, then one more second parked: the worst span
  // must stay the pre-teleport 4s, not grow across the jump to 5s.
  const parkedThenTeleport = [
    ...Array.from({ length: 9 }, (_, i) => s(i * 500, 0, 0)),
    s(4500, 5000, 0),
    s(5000, 5000, 0),
    s(5500, 5000, 0)
  ]
  assert.equal(stuckMs(parkedThenTeleport), 4000, 'a teleport resets the span instead of extending it')
})

test('createTracker samples positions and summarizes distance', async () => {
  const bot = { entity: { position: new Vec3(0, 71, 0) } }
  const tracker = createTracker(bot, { intervalMs: 30 })
  tracker.start()
  await sleep(80)
  bot.entity.position = new Vec3(10, 71, 0)
  await sleep(80)
  tracker.stop()
  const snap = tracker.snapshot()
  assert.ok(snap.distance >= 9, `expected ~10 blocks of travel, got ${snap.distance}`)
  assert.ok(snap.samples >= 4, `expected several samples, got ${snap.samples}`)
  assert.equal(snap.stuckMs, 0, 'the walk resets stuck spans')
})

test('makeContext derives scenario geometry from params.yaml', () => {
  const ctx = makeContext('Bench')
  assert.equal(ctx.username, 'Bench')
  // The wall stands between the camp pad and the north anchor, 8 blocks north of the fire.
  assert.equal(ctx.wall.z1, ctx.camp.fire.z - 8)
  assert.equal(ctx.wall.z1, ctx.wall.z2)
  assert.ok(ctx.wall.x1 < ctx.camp.pad.x && ctx.camp.pad.x < ctx.wall.x2, 'wall spans across the pad')
  assert.ok(ctx.northAnchor.z < ctx.wall.z1, 'north grove is behind the wall')
  // The sealed box sits away from the camp and holds 9 logs at feet level (3x3).
  assert.equal(ctx.box.x, ctx.camp.fire.x - 10)
  assert.equal(ctx.platformCells.length, 9)
  const xs = new Set(ctx.platformCells.map(c => c.x))
  const zs = new Set(ctx.platformCells.map(c => c.z))
  assert.equal(xs.size, 3)
  assert.equal(zs.size, 3)
  assert.ok(ctx.platformCells.every(c => c.y === ctx.camp.pad.y))
})

test('scenario setup commands are plausible console commands with the scenario-specific edits', () => {
  const ctx = makeContext('Bench')
  const sanity = re => cmd => assert.ok(re.test(cmd), `malformed command: ${cmd}`)
  const head = /^(fill|setblock|tp|give|clear|kill|time|weather|gamerule|execute|summon) /
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    const cmds = sc.setupCommands(ctx)
    assert.ok(cmds.length > 10, `${id}: base setup present`)
    cmds.forEach(sanity(head))
    assert.ok(cmds.includes(`tp Bench ${ctx.camp.pad.x} ${ctx.camp.pad.y} ${ctx.camp.pad.z}`), `${id}: bot starts on the pad`)
    assert.ok(cmds.includes(`give Bench stone_axe 1`), `${id}: bot has an axe`)
  }
  const wall = SCENARIOS.logs_obstacle.setupCommands(ctx)
  assert.ok(wall.some(c => c === `fill ${ctx.wall.x1} ${ctx.wall.y1} ${ctx.wall.z1} ${ctx.wall.x2} ${ctx.wall.y2} ${ctx.wall.z2} oak_planks`), 'obstacle scenario builds the wall')
  const box = SCENARIOS.logs_sealed.setupCommands(ctx)
  assert.ok(box.some(c => c.includes('air replace #minecraft:logs')), 'sealed scenario sweeps every other log first')
  assert.ok(box.some(c => c === `fill ${ctx.box.x - 1} ${ctx.box.y} ${ctx.box.z - 1} ${ctx.box.x + 1} ${ctx.box.y} ${ctx.box.z + 1} oak_log`), 'sealed scenario places logs inside the box')
  assert.ok(box.some(c => c.startsWith(`fill ${ctx.box.x - 1} ${ctx.box.y} ${ctx.box.z - 1}`) && c.endsWith(' air')), 'interior is hollowed first')
  assert.ok(box.indexOf(box.find(c => c.includes('replace #minecraft:logs'))) <
    box.indexOf(box.find(c => c.endsWith(' oak_log'))), 'the sweep runs before the box is placed')
  const platform = SCENARIOS.build_platform.setupCommands(ctx)
  assert.ok(platform.includes('give Bench oak_planks 64'), 'platform scenario supplies planks')
  // Leave-no-trace: every scenario that builds something must air-fill it afterwards.
  const wallTear = SCENARIOS.logs_obstacle.teardownCommands(ctx)
  assert.ok(wallTear.some(c => c.startsWith(`fill ${ctx.wall.x1 - 1} ${ctx.wall.y1 - 1} ${ctx.wall.z1 - 1}`) && c.endsWith(' air')), 'wall is air-filled, one block wider')
  const boxTear = SCENARIOS.logs_sealed.teardownCommands(ctx)
  assert.ok(boxTear.some(c => c.startsWith(`fill ${ctx.box.x - 3} ${ctx.box.y - 2} ${ctx.box.z - 3}`) && c.endsWith(' air')), 'sealed box is air-filled')
  assert.ok(SCENARIOS.build_platform.teardownCommands(ctx).some(c => c.endsWith(' air')), 'platform is air-filled')
  assert.ok(SCENARIOS.gather_dirt.teardownCommands(ctx).some(c => c.includes(' grass_block')), 'dug surface is re-grassed')
  for (const id of ['logs_return', 'goto_open', 'goto_cancel', 'explore_frontier']) {
    assert.equal((SCENARIOS[id].teardownCommands?.(ctx) || []).length, 0, `${id} leaves nothing to tear down`)
  }
})

test('evaluate() accepts real completions and rejects shortfalls', () => {
  const ctx = makeContext('Bench')
  const boxLog = { name: 'oak_log', position: { x: ctx.box.x, y: ctx.box.y, z: ctx.box.z } }
  const atBox = () => [boxLog.position]
  const nearChest = {
    entity: { position: new Vec3(ctx.camp.chest.x + 1, ctx.camp.chest.y, ctx.camp.chest.z) },
    findBlocks: atBox
  }
  const farAway = {
    entity: { position: new Vec3(ctx.camp.chest.x + 30, ctx.camp.chest.y, ctx.camp.chest.z) },
    findBlocks: atBox
  }
  const brokenSetup = { entity: nearChest.entity, findBlocks: () => [] }
  const okGather = { gather: { gathered: 8, reason: null }, returned: true }
  const shortGather = { gather: { gathered: 5, reason: 'candidates_exhausted' }, returned: true }
  const notBack = { gather: { gathered: 8, reason: null }, returned: false }
  const obstacleOk = { gather: { gathered: 8, reason: null } }
  const obstacleShort = { gather: { gathered: 2, reason: 'target_unreachable' } }
  const sealedFailed = { status: 'failed', gathered: 0, reason: 'target_unreachable', elapsedMs: 14000 }
  const sealedMined = { status: 'failed', gathered: 9, reason: 'candidates_exhausted', elapsedMs: 60000 }
  assert.equal(SCENARIOS.logs_return.evaluate(nearChest, okGather, ctx).success, true)
  assert.equal(SCENARIOS.logs_return.evaluate(nearChest, shortGather, ctx).reason, 'collected 5/8 logs (candidates_exhausted)')
  assert.equal(SCENARIOS.logs_return.evaluate(farAway, notBack, ctx).success, false)
  assert.equal(SCENARIOS.logs_obstacle.evaluate(nearChest, obstacleOk, ctx).success, true)
  assert.match(SCENARIOS.logs_obstacle.evaluate(nearChest, obstacleShort, ctx).reason, /2\/8/)
  assert.equal(SCENARIOS.logs_sealed.evaluate(nearChest, sealedFailed, ctx).success, true, 'bounded diagnosable failure is the point')
  assert.equal(SCENARIOS.logs_sealed.evaluate(nearChest, sealedMined, ctx).success, false, 'mining a sealed box means the setup failed')
  assert.match(SCENARIOS.logs_sealed.evaluate(brokenSetup, sealedFailed, ctx).reason, /setup broken/, 'empty box must not fake a pass')
  assert.equal(SCENARIOS.build_platform.evaluate(nearChest, { placed: 9, remaining: 0 }, ctx).success, true)
  assert.equal(SCENARIOS.build_platform.evaluate(nearChest, { placed: 5, remaining: 4 }, ctx).reason, '4/9 cells missing')
  assert.equal(SCENARIOS.gather_dirt.evaluate(nearChest, { status: 'success', gathered: 4, reason: null }, ctx).success, true)
  assert.match(SCENARIOS.gather_dirt.evaluate(nearChest, { status: 'partial', gathered: 2, reason: 'target_unreachable' }, ctx).reason, /2\/4 dirt/)
  assert.equal(SCENARIOS.explore_frontier.evaluate(nearChest, { steps: 3, knownLogs: 7 }, ctx).success, true)
  assert.match(SCENARIOS.explore_frontier.evaluate(nearChest, { steps: 1, knownLogs: 9 }, ctx).reason, /explored only 1/)
  assert.match(SCENARIOS.explore_frontier.evaluate(nearChest, { steps: 3, knownLogs: 2 }, ctx).reason, /indexed only 2/)
})

test('logs_return run() drives the Шаг 3 gather pipeline against a fake world (smoke)', async () => {
  // Fake bot: two minable logs near the start, instant pathfinder, dig fills the inventory.
  const carried = []
  const logSpots = [new Vec3(3, 71, 0), new Vec3(-4, 71, 1)]
  const bot = new EventEmitter()
  bot.username = 'Bench'
  bot.entity = { position: new Vec3(0, 71, 0) }
  bot.inventory = { items: () => carried, slots: [] }
  bot.findBlocks = ({ matching, count }) => logSpots
    .map(p => ({ name: 'oak_log', position: p.clone() }))
    .filter(matching)
    .slice(0, count)
    .map(b => b.position)
  bot.blockAt = p => logSpots.some(s => s.equals(p))
    ? { name: 'oak_log', boundingBox: 'block', position: p.clone() }
    : { name: 'air', boundingBox: 'empty', position: p.clone() }
  bot.dig = async block => {
    logSpots.splice(logSpots.findIndex(s => s.equals(block.position)), 1)
    carried.push({ name: 'oak_log', count: 1 })
  }
  bot.pathfinder = {
    setGoal: g => { if (g) bot.entity.position = new Vec3(g.x, 71, g.z) },
    goto: async () => {}
  }
  bot.lookAt = async () => {}
  const ctx = makeContext('Bench')
  const result = await SCENARIOS.logs_return.run(bot, ctx)
  assert.deepEqual(
    { gathered: result.gather.gathered, status: result.gather.status, returned: result.returned },
    { gathered: 2, status: 'partial', returned: true },
    '2 of 8 is an honest partial, and the pipeline says so'
  )
  const verdict = SCENARIOS.logs_return.evaluate(bot, result, ctx)
  assert.equal(verdict.success, false)
  assert.match(verdict.reason, /2\/8/)
})

test('commandDelayMs comes from params (benchmark.settle_command_ms)', () => {
  assert.ok(Number.isFinite(commandDelayMs) && commandDelayMs >= 0 && commandDelayMs < 5000)
})

test('goto scenarios evaluate navigator outcomes', () => {
  const ctx = makeContext('Bench')
  const boxLog = { name: 'oak_log', position: { x: ctx.box.x, y: ctx.box.y, z: ctx.box.z } }
  const bot = { entity: { position: new Vec3(0, 71, 0) }, findBlocks: () => [boxLog] }
  const ok = { status: 'success', error: null, elapsedMs: 21000 }
  const noPath = { status: 'failed', error: 'pathfinder: no path to the target', elapsedMs: 8000 }
  const slow = { status: 'timeout', error: 'not within 1 blocks of the target in 45000 ms', elapsedMs: 45000 }
  const honestPartial = { status: 'partial', error: 'arrived 3.5 blocks from the target (requested 1)', distance: 3.5, elapsedMs: 8000 }
  const tooClosePartial = { status: 'partial', error: 'arrived 2 blocks from the target (requested 1)', distance: 2, elapsedMs: 8000 }
  assert.equal(SCENARIOS.goto_open.evaluate(bot, ok, ctx).success, true)
  assert.match(SCENARIOS.goto_open.evaluate(bot, noPath, ctx).reason, /navigation failed/)

  assert.equal(SCENARIOS.goto_unreachable.evaluate(bot, noPath, ctx).success, true, 'diagnosable bounded failure is the point')
  assert.equal(SCENARIOS.goto_unreachable.evaluate(bot, honestPartial, ctx).success, true, 'honest partial at a distance is a valid outcome')
  assert.equal(SCENARIOS.goto_unreachable.evaluate(bot, tooClosePartial, ctx).success, false, 'partial near a sealed box means it is not sealed')
  assert.equal(SCENARIOS.goto_unreachable.evaluate(bot, ok, ctx).success, false, 'reaching a sealed target means the setup leaked')
  assert.equal(SCENARIOS.goto_unreachable.evaluate(bot, slow, ctx).success, false, 'timeout is not a bounded diagnosable failure')
  assert.match(SCENARIOS.goto_unreachable.evaluate(bot, { status: 'failed', error: '???', elapsedMs: 1000 }, ctx).reason, /navigation failed/)

  assert.equal(SCENARIOS.goto_cancel.evaluate(bot, { status: 'cancelled', walkedTo: 8, drifted: 0.3 }, ctx).success, true)
  assert.match(SCENARIOS.goto_cancel.evaluate(bot, { status: 'cancelled', walkedTo: 8, drifted: 4 }, ctx).reason, /kept moving/)
  assert.equal(SCENARIOS.goto_cancel.evaluate(bot, { status: 'running', walkedTo: 8, drifted: 0 }, ctx).success, false)
})

test('baseSetupCommands reuses the demo world reset and teleports the bot to the pad', () => {
  const ctx = makeContext('Bench')
  const cmds = baseSetupCommands(ctx)
  assert.ok(cmds.includes('gamerule doMobSpawning false'), 'same self-healing setup as the demo')
  assert.ok(cmds.some(c => c.includes('place feature minecraft:oak')), 'grove planted')
  assert.equal(cmds[cmds.length - 1], `tp Bench ${ctx.camp.pad.x} ${ctx.camp.pad.y} ${ctx.camp.pad.z}`)
})
