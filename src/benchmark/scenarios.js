// Benchmark scenarios (roadmap Шаг 0): four fixed, repeatable scenarios on the seeded
// test world. Each scenario resets the camp with the self-healing setupCommands, applies
// its own world edits, then drives the skill layer deterministically (no LLM) and checks
// a mechanical success predicate. The point is a comparable baseline across code changes:
// the same primitives the LLM worker gets, executed end-to-end.
import Vec3 from 'vec3'
import { setupCommands } from '../gm.js'
import { countItems, goNear } from '../skills.js'
import { buildCells } from '../building.js'
import { createNavigator, waitOperation } from '../navigation.js'
import { gatherResource } from '../gather.js'
import { createSpatialMemory } from '../memory/spatial.js'
import { config } from '../config.js'

const WORLD = config.params.world
const BENCH = config.params.benchmark || {}

const LOGS = /_log$/
const SETTLE_COMMAND_MS = BENCH.settle_command_ms ?? 150

const vec = ([x, y, z]) => new Vec3(x, y, z)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const round1p = n => Math.round(n * 10) / 10

/** All coordinates the scenarios need, derived from params.yaml so they follow the camp. */
export function makeContext (username = 'Bench') {
  const c = {
    pad: vec(WORLD.camp.pad),
    chest: vec(WORLD.camp.chest),
    fire: vec(WORLD.camp.fire),
    hut: vec(WORLD.camp.hut),
    table: vec(WORLD.camp.table)
  }
  const f = c.fire
  return Object.freeze({
    username,
    camp: Object.freeze(c),
    // Scenario 2: an unbreakable (protected-blocks) wall between the camp and the north grove —
    // the pathfinder has to route around it, digging through is not an option.
    wall: Object.freeze({ x1: f.x - 4, y1: f.y, z1: f.z - 8, x2: f.x + 4, y2: f.y + 2, z2: f.z - 8 }),
    northAnchor: Object.freeze({ x: f.x, y: f.y, z: f.z - 20 }),
    // Scenario 3: a sealed plank box with logs inside — the target exists and is visible,
    // but every approach must fail. Success = the failure is detected fast, no hang.
    box: Object.freeze({ x: f.x - 10, y: f.y, z: f.z + 10 }),
    // Scenario 4: a 3x3 platform on the camp pad, built cell by cell from coordinates.
    platformCells: Object.freeze([-2, -1, 0].flatMap(dz => [0, 1, 2].map(dx => ({
      x: c.pad.x + 2 + dx, y: c.pad.y, z: c.pad.z + 2 + dz
    }))))
  })
}

/** Fresh, self-healing camp (same machinery as the demo), then the bot teleported to the pad. */
export function baseSetupCommands (ctx) {
  return [
    ...setupCommands({ camp: ctx.camp, workers: [ctx.username], commander: ctx.username }),
    `tp ${ctx.username} ${ctx.camp.pad.x} ${ctx.camp.pad.y} ${ctx.camp.pad.z}`
  ]
}

const wallCommands = ctx => [
  `fill ${ctx.wall.x1} ${ctx.wall.y1} ${ctx.wall.z1} ${ctx.wall.x2} ${ctx.wall.y2} ${ctx.wall.z2} oak_planks`
]

const boxCommands = ctx => {
  const o = ctx.box
  return [
    `fill ${o.x - 2} ${o.y - 1} ${o.z - 2} ${o.x + 2} ${o.y + 3} ${o.z + 2} oak_planks`,
    `fill ${o.x - 1} ${o.y} ${o.z - 1} ${o.x + 1} ${o.y + 2} ${o.z + 1} air`,
    `fill ${o.x - 1} ${o.y} ${o.z - 1} ${o.x + 1} ${o.y} ${o.z + 1} oak_log`
  ]
}

// logs_sealed must offer NO alternative: every log within the 48-block search radius is
// swept (sliced fills — vanilla caps one command at 32768 blocks), then the sealed box
// is placed. "Take another resource instead" stops being an option, so the failure
// detection itself is what gets measured.
const clearLogSlices = ctx => {
  const f = ctx.camp.fire
  const cmds = []
  for (let y = 60; y <= 78; y += 3) {
    cmds.push(`fill ${f.x - 48} ${y} ${f.z - 48} ${f.x + 48} ${y + 2} ${f.z + 48} air replace #minecraft:logs`)
  }
  return cmds
}

const platformCommands = ctx => [
  `give ${ctx.username} oak_planks 64`
]

export const SCENARIOS = Object.freeze({
  // 1. Find a tree, collect 8 logs, walk back to the camp chest. Runs on the Шаг 3
  //    gather primitives (find → navigate → mine), not the legacy collectLogs.
  logs_return: Object.freeze({
    id: 'logs_return',
    title: 'Gather 8 logs and return to the camp chest',
    timeoutMs: BENCH.scenario_timeout_ms ?? 180000,
    setupCommands: baseSetupCommands,
    run: async (bot, ctx) => {
      const gather = await gatherResource(bot, 'logs', 8, {})
      const returned = await goNear(bot, ctx.camp.chest, 3)
      return { gather, returned }
    },
    evaluate: (bot, r, ctx) => {
      if (r.gather.gathered < 8) return { success: false, reason: `collected ${r.gather.gathered}/8 logs (${r.gather.reason})` }
      if (!r.returned) return { success: false, reason: 'did not return to the chest' }
      const d = bot.entity.position.distanceTo(ctx.camp.chest)
      if (d > 4.5) return { success: false, reason: `ended ${d.toFixed(1)}m from the chest` }
      return { success: true, reason: null }
    }
  }),

  // 2. The north grove is behind an unbreakable wall — the path must go around it.
  logs_obstacle: Object.freeze({
    id: 'logs_obstacle',
    title: 'Gather 8 logs anchored behind a wall (route around required)',
    timeoutMs: BENCH.scenario_timeout_ms ?? 180000,
    setupCommands: ctx => [...baseSetupCommands(ctx), ...wallCommands(ctx)],
    run: async (bot, ctx) => {
      const gather = await gatherResource(bot, 'logs', 8, { anchor: { x: ctx.northAnchor.x, y: ctx.northAnchor.y, z: ctx.northAnchor.z } })
      return { gather }
    },
    evaluate: (_bot, r) => r.gather.gathered >= 8
      ? { success: true, reason: null }
      : { success: false, reason: `collected ${r.gather.gathered}/8 logs behind the wall (${r.gather.reason})` }
  }),

  // 3. Every log in the search radius is swept away except nine sealed inside an
  //    unbreakable box: the targets are visible but unreachable. Success means the
  //    gather pipeline reports a bounded, diagnosable failure — no hang, no fake win.
  logs_sealed: Object.freeze({
    id: 'logs_sealed',
    title: 'Detect unreachable logs (only sealed ones remain) and fail fast',
    timeoutMs: BENCH.sealed_timeout_ms ?? 150000,
    setupCommands: ctx => [...baseSetupCommands(ctx), ...clearLogSlices(ctx), ...boxCommands(ctx)],
    run: async (bot, ctx) => gatherResource(bot, 'logs', 8, {}),
    evaluate: (bot, r, ctx) => {
      // The palette gate passes name-only stubs (position null) — let them through the
      // matcher and filter positions on the results, or whole sections get skipped.
      const inBox = p => Math.abs(p.x - ctx.box.x) <= 1 && p.y === ctx.box.y && Math.abs(p.z - ctx.box.z) <= 1
      const boxLogs = (bot.findBlocks({
        matching: b => /_log$/.test(b.name) && (!b.position || inBox(b.position)),
        maxDistance: 32,
        count: 16
      }) || []).filter(inBox)
      if (boxLogs.length === 0) return { success: false, reason: 'setup broken: no logs in the sealed box region' }
      if (r.gathered > 0) return { success: false, reason: `mined ${r.gathered} logs out of a sealed box` }
      if (r.status === 'failed' && r.elapsedMs < (BENCH.sealed_timeout_ms ?? 150000)) return { success: true, reason: `bounded failure: ${r.reason}` }
      return { success: false, reason: `gather ended ${r.status} (${r.reason}) in ${r.elapsedMs} ms` }
    }
  }),

  // 3b. The same gather pipeline on a DIFFERENT resource type — no log special-casing.
  gather_dirt: Object.freeze({
    id: 'gather_dirt',
    title: 'Gather 4 dirt (a non-log resource through the same pipeline)',
    timeoutMs: 120000,
    setupCommands: baseSetupCommands,
    run: async (bot, ctx) => gatherResource(bot, 'dirt', 4, {}),
    evaluate: (_bot, r) => r.gathered >= 4
      ? { success: true, reason: null }
      : { success: false, reason: `gathered ${r.gathered}/4 dirt (${r.reason})` }
  }),

  // 4. Build a 3x3 plank platform from explicit coordinates.
  build_platform: Object.freeze({
    id: 'build_platform',
    title: 'Build a 3x3 plank platform at given coordinates',
    timeoutMs: BENCH.scenario_timeout_ms ?? 180000,
    setupCommands: ctx => [...baseSetupCommands(ctx), ...platformCommands(ctx)],
    run: async (bot, ctx) => {
      await goNear(bot, ctx.camp.pad, 3)
      return buildCells(bot, ctx.platformCells)
    },
    evaluate: (_bot, r) => r.remaining === 0
      ? { success: true, reason: null }
      : { success: false, reason: `${r.remaining}/9 cells missing` }
  }),

  // --- Roadmap Шаг 2: navigation as a managed operation -------------------------
  // 5. Open ground: the navigator walks to a point and the operation succeeds.
  goto_open: Object.freeze({
    id: 'goto_open',
    title: 'Navigator walks to an open-ground point 28 blocks away',
    timeoutMs: 90000,
    setupCommands: baseSetupCommands,
    run: async (bot, ctx) => {
      const nav = createNavigator(bot)
      const f = ctx.camp.fire
      const id = nav.start({ x: f.x + 20, y: f.y, z: f.z + 20 }, { range: 2, timeoutMs: 60000 })
      return waitOperation(nav, id, { timeoutMs: 75000 })
    },
    evaluate: (_bot, snap) => snap.status === 'success'
      ? { success: true, reason: null }
      : { success: false, reason: `navigation ${snap.status}: ${snap.error || 'no error given'}` }
  }),

  // 6. The only target is inside the sealed box: diagnosable failure, bounded time.
  goto_unreachable: Object.freeze({
    id: 'goto_unreachable',
    title: 'Navigator fails diagnosably on an unreachable target (sealed box)',
    timeoutMs: 90000,
    setupCommands: ctx => [...baseSetupCommands(ctx), ...boxCommands(ctx)],
    run: async (bot, ctx) => {
      const nav = createNavigator(bot)
      const id = nav.start({ x: ctx.box.x, y: ctx.box.y, z: ctx.box.z }, { range: 1, timeoutMs: 45000 })
      return waitOperation(nav, id, { timeoutMs: 60000 })
    },
    evaluate: (_bot, snap) => {
      if (snap.status === 'success') return { success: false, reason: 'sealed target reported as reached — the setup leaked' }
      if (snap.status === 'partial') {
        // Honest "I got near but not there": correct for a sealed target, but only if
        // it really stopped outside any plausible approach distance.
        return snap.distance > 2.5
          ? { success: true, reason: `honest partial: stopped ${snap.distance} blocks from the sealed target` }
          : { success: false, reason: `partial too close (${snap.distance}) — the box is not actually sealed` }
      }
      if (snap.status === 'failed' && /no path|stuck/.test(snap.error || '') && snap.elapsedMs < 45000) {
        return { success: true, reason: null }
      }
      return { success: false, reason: `navigation ${snap.status}: ${snap.error || 'no error given'}` }
    }
  }),

  // 7. Cancel mid-walk: the operation reports cancelled and the bot actually stops.
  goto_cancel: Object.freeze({
    id: 'goto_cancel',
    title: 'Cancelling a long walk stops the bot',
    timeoutMs: 90000,
    setupCommands: baseSetupCommands,
    run: async (bot, ctx) => {
      const nav = createNavigator(bot)
      const f = ctx.camp.fire
      const id = nav.start({ x: f.x + 40, y: f.y, z: f.z + 40 }, { range: 2, timeoutMs: 60000 })
      await sleep(2500)
      const before = nav.status(id)
      nav.cancel(id)
      const frozen = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
      await sleep(1200)
      const drifted = round1p(bot.entity.position.distanceTo(new Vec3(frozen.x, frozen.y, frozen.z)))
      return { status: nav.status(id).status, walkedTo: before.distance, drifted }
    },
    evaluate: (_bot, r) => {
      if (r.status !== 'cancelled') return { success: false, reason: `expected cancelled, got ${r.status}` }
      if (r.drifted > 1.5) return { success: false, reason: `bot kept moving ${r.drifted} blocks after cancel` }
      return { success: true, reason: null }
    }
  }),

  // --- Roadmap Шаг 4: spatial memory & exploration -------------------------------
  // 8. Frontier exploration around camp: new sectors visited, resources indexed,
  //    no endless circling over one place.
  explore_frontier: Object.freeze({
    id: 'explore_frontier',
    title: 'Explore frontier sectors around camp and index resources',
    timeoutMs: 150000,
    setupCommands: baseSetupCommands,
    run: async (bot, ctx) => {
      const mem = createSpatialMemory(bot)
      mem.noteVisit(ctx.camp.pad)
      const result = await mem.exploreArea({ maxSteps: 3, scanRadius: 24 })
      return { ...result, knownLogs: mem.knownResources('logs').length, stats: mem.stats() }
    },
    evaluate: (_bot, r) => {
      if (r.steps < 2) return { success: false, reason: `explored only ${r.steps} new sectors (loop too short or frontier stuck)` }
      if (r.knownLogs < 4) return { success: false, reason: `indexed only ${r.knownLogs} log records (${JSON.stringify(r.discovered)})` }
      return { success: true, reason: `${r.steps} sectors, ${r.knownLogs} log records` }
    }
  })
})

/** Human-readable command echo + pacing helper shared by the runner. */
export const commandDelayMs = SETTLE_COMMAND_MS
export const logSummary = bot => ({ carriedLogs: countItems(bot, LOGS) })
