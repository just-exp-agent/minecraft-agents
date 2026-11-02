// Demo scenario: Commander + 3 hidden-persona workers gather logs; night falls mid-session.
import { Vec3 } from 'vec3'
import { mineflayer as attachViewer } from 'prismarine-viewer'
import { config } from './config.js'
import { record, runInfo } from './events.js'
import { createSpeechBus } from './speech.js'
import { createHutBlueprint, hutProgress, describeProgress } from './blueprint.js'
import { isBuilt } from './building.js'
import { DEMO_ROSTER, rollRoster } from './personas.js'
import { createWorker } from './agents/worker.js'
import { createCommander } from './agents/commander.js'
import { setupWorld, sunset, revealTruth, mirrorToGameChat, announce } from './gm.js'
import { manageSpectators, waitForStart } from './startGate.js'
import { startDashboard } from './dashboard/server.js'
import { startHeapWatch } from './heap-watch.js'
import { createTaskBoard } from './coordination/task-board.js'

const GOAL = 'Build a small wooden hut next to camp before night: gather logs into the camp chest, then have the team craft planks and build the walls and roof.'
const campAt = (x, y, z) => new Vec3(x, y, z)
const CAMP = Object.freeze({
  pad: campAt(...config.params.world.camp.pad),
  chest: campAt(...config.params.world.camp.chest),
  fire: campAt(...config.params.world.camp.fire),
  hut: campAt(...config.params.world.camp.hut),
  table: campAt(...config.params.world.camp.table)
})
const SESSION_MS = Number(process.env.SESSION_MS || config.params.session.duration_ms)
const SUNSET_AT_MS = Number(process.env.SUNSET_AT_MS || config.params.session.sunset_at_ms)
const WAIT_FOR_START = process.env.WAIT_FOR_START === '1'
const MIRROR_CHAT = process.env.MIRROR_CHAT !== '0'
// GM_ROLL=1: the Game Master rolls hidden traits/motives per session; GM_SEED pins
// the roll so an experiment batch can replay the exact same cast (roadmap: fixed seeds).
const ROSTER = process.env.GM_ROLL === '1'
  ? rollRoster(DEMO_ROSTER.map(p => p.name), { seed: Number(process.env.GM_SEED || Date.now()) })
  : DEMO_ROSTER
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  if (ROSTER !== DEMO_ROSTER) {
    record('gm', { text: `Game Master rolled the cast (seed ${process.env.GM_SEED || 'random'}): ` +
      ROSTER.map(p => `${p.name} is ${p.traitLabel} / ${p.motiveLabel}`).join('; ') })
  }
  const bus = createSpeechBus({
    onMessage: m => {
      record('speech', { agent: m.speaker, text: m.text, to: m.to, heardBy: m.heardBy })
      if (MIRROR_CHAT) mirrorToGameChat(m)
    }
  })
  const dashboard = startDashboard({ team: ROSTER.map(p => p.name), goal: GOAL })
  // Шаг 8: one shared task board — commander posts structured tasks, workers claim,
  // heartbeat and report results. Speech stays the persona layer.
  const board = createTaskBoard()

  const blueprint = createHutBlueprint(CAMP.hut)
  const workers = []
  for (const persona of ROSTER) {
    workers.push(createWorker({ persona, bus, camp: CAMP, blueprint, board }))
    await sleep(1200)
  }
  const commander = createCommander({ goal: GOAL, team: ROSTER.map(p => p.name), bus, camp: CAMP, blueprint, board })
  await Promise.all([...workers.map(w => w.ready), commander.ready])
  record('gm', { text: `All bots connected. Log file: ${runInfo.logFile}` })
  // HEAP_WATCH=1: log memory + per-bot chunk-column counts every 5s; with
  // HEAP_SNAPSHOT_AT_MB set, also auto-write a heap snapshot when crossed.
  if (process.env.HEAP_WATCH === '1') {
    const bots = () => [...workers.map(w => w.bot), commander.bot]
    startHeapWatch(bots, sample => record('heap', sample))
  }

  await setupWorld({ camp: CAMP, workers: workers.map(w => w.name), commander: 'Commander' })
  await sleep(2500)
  // VIEWER=0 skips the spectator web renderer (memory-hungry on butchered worlds; also
  // handy for headless runs).
  if (process.env.VIEWER !== '0') {
    attachViewer(commander.bot, { port: config.viewerPort, firstPerson: false, viewDistance: 5 })
    await sleep(1500)
    record('viewer', { port: config.viewerPort })
  }
  const botNames = [...workers.map(w => w.name), 'Commander']
  manageSpectators(commander.bot, botNames)
  if (WAIT_FOR_START) await waitForStart(commander.bot, botNames)
  record('gm', { text: `Goal: ${GOAL}` })
  announce(`Goal: ${GOAL}`)

  workers.forEach(w => w.start())
  const sunsetTimer = setTimeout(() => sunset().catch(err => record('error', { where: 'sunset', message: err.message })), SUNSET_AT_MS)
  const final = await commander.run(SESSION_MS)
  clearTimeout(sunsetTimer)

  const rows = revealTruth(ROSTER, final?.beliefs)
  record('gm', { text: `Hut: ${describeProgress(hutProgress(blueprint, p => isBuilt(commander.bot, p)))}` })
  workers.forEach(w => record('status', { agent: w.name, ...w.stats(), final: true }))
  record('gm', { text: `Session over. Trait guesses correct: ${rows.filter(r => r.score.trait).length}/${rows.length}; motive guesses correct: ${rows.filter(r => r.score.motive).length}/${rows.length}.` })

  await sleep(15000)
  workers.forEach(w => { w.stop(); w.bot.quit() })
  commander.bot.quit()
  dashboard.close()
  process.exit(0)
}

main().catch(err => {
  record('error', { where: 'main', message: err.stack || err.message })
  console.error(err)
  process.exit(1)
})
