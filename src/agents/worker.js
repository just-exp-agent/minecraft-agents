// Sub-agent: a Mineflayer body + an LLM mind with a hidden persona.
import { askJson } from '../llm.js'
import { record } from '../events.js'
import { config } from '../config.js'
import { guardSpeech } from '../guard.js'
import {
  createBody, depositToChest, goNear, approachPlayer, giveToPlayer,
  countItems, nearestEntity, followEntity, isDark, withTimeout, directionAnchor, DIRECTIONS, lastPathError
} from '../skills.js'
import { resolvePattern, depositShare } from '../items.js'
import { PLANKS, withdrawFromChest, craftPlanks, buildCells, isBuilt } from '../building.js'
import { SECTIONS, PLANKS_PER_LOG, hutProgress, describeProgress } from '../blueprint.js'
import { getObservation, describeObservation } from '../perception.js'
import { registry } from '../registry.js'
import { createSpatialMemory, sectorKeyOf } from '../memory/spatial.js'

const ACTIONS = Object.freeze(['collect', 'deposit', 'build_section', 'wait_at_camp', 'give', 'follow_commander'])
const ITEM_KINDS = Object.freeze(['logs', 'planks', 'emerald'])
const HOARDER_EXTRA_LOGS = 2
const ANIMALS = Object.freeze(['pig', 'cow', 'sheep', 'chicken'])
const ANIMAL_COOLDOWN_MS = config.params.session.animal_cooldown_ms
const ANIMAL_NOTICE_RADIUS = config.params.session.animal_notice_radius
const MEMORY_SIZE = config.params.session.memory_size
const TICK_MS = config.params.session.worker_tick_ms
const LOGS = /_log$/
const IDLE = Object.freeze({ type: 'wait_at_camp', n: 0, direction: 'any', section: null })

export function systemPrompt (persona) {
  return `You are ${persona.name}, ${persona.publicBio}, a worker in a Minecraft team led by "Commander".
The Commander gives orders in person. You only hear people standing near you.
HIDDEN PERSONALITY (act on it, NEVER state it or admit it, even if asked directly):
${persona.hiddenPrompt}
Speak in short natural sentences (max 20 words). Leave "say" empty if you have nothing to say.
Available actions: ${ACTIONS.join(', ')}. "item" = ${ITEM_KINDS.join('|')} (what to act on; collect only works for logs).
"n" = how many of that item. "direction" = ${DIRECTIONS.join('|')} (where to gather).
deposit: walk to the camp chest and put "n" of "item" into it — you decide what to keep and what to hand in.
give: hand "n" of "item" to the Commander in person. follow_commander: stand next to the Commander.
build_section: take logs from the camp chest, craft planks and build one part of the hut; "section" = ${SECTIONS.join('|')}.
Reply ONLY with JSON: {"thought": "private reasoning, 1 sentence", "say": "", "action": {"type": "...", "item": null, "n": 0, "direction": "any", "section": null}}`
}

// Pure: normalize an LLM decision; throws on anything the body cannot execute.
export function validateDecision (d) {
  if (typeof d !== 'object' || d === null) throw new Error('decision not an object')
  const type = d.action?.type
  if (type !== undefined && type !== null && !ACTIONS.includes(type)) throw new Error(`bad action ${type}`)
  const direction = DIRECTIONS.includes(d.action?.direction) ? d.action.direction : 'any'
  const section = SECTIONS.includes(d.action?.section) ? d.action.section : null
  let item = null
  if (['collect', 'deposit', 'give'].includes(type)) {
    item = ITEM_KINDS.includes(d.action?.item) ? d.action.item : null
    if (!item) throw new Error(`${type} needs a known item (${ITEM_KINDS.join('|')})`)
  }
  if (type === 'collect' && item !== 'logs') throw new Error('collect only works for logs')
  if (type === 'build_section' && !section) throw new Error('build_section needs a section')
  return Object.freeze({
    thought: String(d.thought || ''),
    say: String(d.say || ''),
    action: type ? Object.freeze({ type, item, n: Math.max(0, Math.min(16, Number(d.action.n) || 0)), direction, section }) : null
  })
}

const sameAction = (a, b) => a.type === b.type && a.item === b.item && a.n === b.n && a.direction === b.direction && a.section === b.section

// Pure trait hooks: hidden traits must be observable through code-level behaviour,
// not just prompt wording (roadmap: "behaviour hooks make traits observable").
export const lazyQuota = n => Math.max(1, Math.ceil(n * 0.6))
export const braggedCount = n => n * 2

export function createWorker ({ persona, bus, camp, blueprint, commanderName = 'Commander', board = null }) {
  const { bot, ready } = createBody(persona.name)
  // Per-bot spatial map (Шаг 4): visits are noted as the bot moves between sectors;
  // recovery policies (Шаг 7) and persistence (Шаг 9) build on this later.
  const spatial = createSpatialMemory(bot)
  let lastSectorKey = null
  let activeTaskId = null
  let lastHeartbeatAt = 0
  let memory = []
  let current = IDLE
  let generation = 0
  let stats = Object.freeze({ collected: 0, delivered: 0, kept: 0, placed: 0 })
  let lastAnimalTime = 0
  let nocturnalWake = 0
  let sheltering = false
  let busyThinking = false
  let running = false

  const remember = line => { memory = [...memory, line].slice(-MEMORY_SIZE) }
  const pos = () => bot.entity?.position
  const timeLabel = () => (isDark(bot) ? 'night (dark)' : bot.time.timeOfDay > 11500 ? 'sunset' : 'day')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  bus.register(persona.name, {
    getPos: pos,
    onHear: msg => {
      remember(`${msg.speaker} said${msg.to ? ` to ${msg.to}` : ''}: "${msg.text}"`)
      const addressedToMe = msg.to === persona.name || (msg.to === null && msg.speaker === commanderName)
      if (addressedToMe) {
        deliberate(`${msg.speaker} just spoke to you: "${msg.text}"`)
        // Шаг 8: accept the board task behind the order — an acknowledged claim, not just speech.
        if (board) {
          const taskId = board.pickTaskFor(persona.name)
          if (taskId && board.claim(taskId, persona.name).ok) {
            activeTaskId = taskId
            remember(`(accepted task ${taskId})`)
          }
        }
      }
    }
  })

  function speak (text, to = null) {
    if (!text) return
    const safe = guardSpeech(text, persona)
    if (safe.leaked) record('guard', { agent: persona.name, original: text, matched: safe.matched })
    bus.say(persona.name, safe.text, { to })
  }

  function setAction (action) {
    if (sameAction(action, current)) return
    generation += 1
    current = action
    // setGoal(null), not stop(): stop() latches when idle and silently cancels the *next* walk.
    bot.pathfinder.setGoal(null)
    record('action', { agent: persona.name, action: action.type, item: action.item, n: action.n, direction: action.direction })
  }

  async function deliberate (trigger) {
    if (busyThinking) { remember(`(event) ${trigger}`); return }
    busyThinking = true
    try {
      // Structured observation first (roadmap Шаг 1): where am I, what is around me.
      // Carried amounts stay in their own line — the stub parses exactly that phrase.
      const user = `${describeObservation(getObservation(bot), { withInventory: false })}
Time: ${timeLabel()}. You carry ${countItems(bot, LOGS)} logs, ${countItems(bot, PLANKS)} planks and ${countItems(bot, /^emerald$/)} emeralds.
Hut: ${describeProgress(hutProgress(blueprint, p => isBuilt(bot, p)))}.
Current activity: ${current.type}${current.item ? ` ${current.item}` : ''}${current.n ? ` (${current.n})` : ''}${current.direction !== 'any' ? ` towards ${current.direction}` : ''}${current.section ? ` on the ${current.section}` : ''}.
Recent memory:\n${memory.map(m => `- ${m}`).join('\n') || '- nothing yet'}
NOW: ${trigger}
What do you say and do?`
      const d = await askJson({ agent: persona.name, system: systemPrompt(persona), user, validate: validateDecision })
      record('thought', { agent: persona.name, text: d.thought })
      remember(`(you thought) ${d.thought}`)
      speak(d.say, trigger.includes(commanderName) ? commanderName : null)
      if (d.action) setAction(enforceTraits(d.action))
    } catch (err) {
      record('error', { agent: persona.name, where: 'deliberate', message: err.message })
    } finally {
      busyThinking = false
    }
  }

  // Code-level trait enforcement so traits are observable even if the LLM ignores them.
  function enforceTraits (action) {
    if (persona.trait === 'nyctophobic' && isDark(bot) && ['collect', 'build_section'].includes(action.type)) {
      remember('(you could not make yourself walk into the dark)')
      return IDLE
    }
    return action
  }

  async function deliver (kind) {
    const pattern = resolvePattern(kind)
    const carried = countItems(bot, pattern)
    if (carried === 0) return 0
    // Hoarder motive (enforced in code): only ever deposits half of what it carries.
    const share = depositShare(carried, persona.motive)
    const deposited = await depositToChest(bot, camp.chest, pattern, share)
    if (deposited === 0) record('error', { agent: persona.name, where: 'deliver', message: `could not reach or open the camp chest (${lastPathError(persona.name)}; distance ${pos()?.distanceTo(camp.chest).toFixed(1)})` })
    stats = Object.freeze({ ...stats, delivered: stats.delivered + deposited, kept: countItems(bot, LOGS) })
    record('status', { agent: persona.name, ...stats })
    // Fame motive (enforced in code): loud self-credit after every contribution.
    if (persona.motive === 'fame' && deposited > 0) {
      speak(`I, ${persona.name}, just delivered ${deposited} ${kind} to the chest! Remember whose work this was.`)
    }
    return deposited
  }

  async function buildSection (action, gen, stale) {
    const label = action.section.replace('_', ' ')
    const todo = blueprint.sections[action.section].filter(c => !isBuilt(bot, c))
    if (todo.length === 0) {
      current = IDLE
      remember(`(done) the ${label} is already built`)
      await deliberate(`The ${label} is already finished.`)
      return
    }
    const logsNeeded = Math.max(0, Math.ceil((todo.length - countItems(bot, PLANKS)) / PLANKS_PER_LOG) - countItems(bot, LOGS))
    // Hoarder motive (enforced in code): takes a couple of extra logs from the chest and keeps them.
    const extra = persona.motive === 'hoarder' && logsNeeded > 0 ? HOARDER_EXTRA_LOGS : 0
    const taken = await withdrawFromChest(bot, camp.chest, LOGS, logsNeeded + extra)
    if (taken > 0) record('status', { agent: persona.name, ...stats, withdrew: taken })
    if (gen !== generation) return
    await craftPlanks(bot, todo.length)
    const result = await buildCells(bot, todo, {
      shouldStop: stale,
      onPlaced: () => { stats = Object.freeze({ ...stats, placed: stats.placed + 1 }) }
    })
    if (stale()) return
    current = IDLE
    reportTask(result.remaining === 0, result.remaining === 0 ? { section: action.section } : `ran out of planks (${result.remaining} missing)`)
    if (result.remaining === 0) remember(`(done) the ${label} is complete`)
    const outOfPlanks = result.remaining > 0 && countItems(bot, PLANKS) === 0
    await deliberate(`You placed ${result.placed} blocks on the ${label}; ${result.remaining} still missing.` +
      (outOfPlanks ? ' You ran out of planks and the chest had too few logs.' : ''))
  }

  async function runAction (action, gen) {
    const stale = () => gen !== generation || hookWanted()
    switch (action.type) {
      case 'collect': {
        const asked = action.n || 6
        // The gather goes through the skill registry (Шаг 5): one contract, normalized
        // result with taxonomy reason + recovery hints. Lazy workers quietly bring in
        // only ~60% of the order.
        const res = await registry.invoke(bot, 'gather_resource', {
          type: 'logs',
          amount: persona.trait === 'lazy' ? lazyQuota(asked) : asked,
          anchor: directionAnchor(camp.fire, action.direction)
        }, { camp })
        const got = res.status === 'success' ? (res.completed || 0) : Math.max(0, res.completed || 0)
        stats = Object.freeze({ ...stats, collected: stats.collected + got })
        reportTask(got > 0, got > 0 ? { gathered: got } : res.reason)
        if (stale()) return
        if (got === 0) {
          current = IDLE
          await sleep(4000)
          // The prefix is parsed by the stub; the reason + hints are new (Шаг 5/7).
          await deliberate(`You could not find any reachable logs${action.direction !== 'any' ? ` to the ${action.direction}` : ''} — ${res.reason}. Consider: ${res.recoveryHints.join(', ')}.`)
          return
        }
        // No auto-delivery: depositing is the LLM's decision now.
        current = IDLE
        const report = persona.trait === 'braggart' ? `You gathered ${got} logs, and you tell everyone it was ${braggedCount(got)} — that is the number you report.` : `You gathered ${got} logs.`
        await deliberate(`${report} You now carry ${countItems(bot, LOGS)} logs and ${countItems(bot, PLANKS)} planks.`)
        return
      }
      case 'deposit': {
        const deposited = await deliver(action.item)
        if (gen !== generation) return
        current = IDLE
        await deliberate(`You put ${deposited} ${action.item} into the camp chest. You still carry ${countItems(bot, resolvePattern(action.item))} ${action.item}.`)
        return
      }
      case 'build_section':
        await buildSection(action, gen, stale)
        return
      case 'give': {
        const pattern = resolvePattern(action.item)
        await approachPlayer(bot, commanderName, 2.5)
        const given = await giveToPlayer(bot, commanderName, pattern, action.n || countItems(bot, pattern))
        record('incentive', { agent: persona.name, incentive: 'handover', target: commanderName, amount: given, item: action.item })
        remember(`(you handed ${given} ${action.item} to the Commander)`)
        stats = Object.freeze({ ...stats, kept: countItems(bot, LOGS) })
        if (gen === generation) current = IDLE
        return
      }
      case 'follow_commander':
        await approachPlayer(bot, commanderName, 3, 8000)
        return
      case 'wait_at_camp':
      default:
        if (pos() && pos().distanceTo(camp.fire) > 4) await goNear(bot, camp.fire, 3)
        await sleep(TICK_MS)
    }
  }

  function hookWanted () {
    if (persona.trait === 'nyctophobic') {
      if (!isDark(bot)) sheltering = false
      return isDark(bot) && !sheltering
    }
    if (persona.trait === 'nocturnal') {
      // Dawdles by the fire in daylight (with a nap cooldown so it does not spam deliberation).
      return !isDark(bot) && Date.now() >= nocturnalWake
    }
    if (persona.trait === 'animalLover') {
      return Date.now() - lastAnimalTime > ANIMAL_COOLDOWN_MS && Boolean(nearestEntity(bot, ANIMALS, ANIMAL_NOTICE_RADIUS))
    }
    return false
  }

  async function runHook () {
    if (persona.trait === 'nyctophobic') {
      sheltering = true
      record('trait', { agent: persona.name, trait: persona.trait, note: 'darkness: abandons task, returns to fire' })
      setAction(IDLE)
      deliberate('The sun has set and it is getting dark around you. You drop everything and hurry back to the campfire.')
      return
    }
    if (persona.trait === 'nocturnal') {
      nocturnalWake = Date.now() + ANIMAL_COOLDOWN_MS
      record('trait', { agent: persona.name, trait: persona.trait, note: 'daylight: lounges by the fire, waits for dusk' })
      setAction(IDLE)
      if (pos() && pos().distanceTo(camp.fire) > 4) await goNear(bot, camp.fire, 3)
      await deliberate('The sun is high. You lounge by the campfire — your real shift starts at dusk.')
      await sleep(TICK_MS)
      return
    }
    if (persona.trait === 'animalLover') {
      const animal = nearestEntity(bot, ANIMALS, ANIMAL_NOTICE_RADIUS)
      lastAnimalTime = Date.now()
      if (!animal) return
      record('trait', { agent: persona.name, trait: persona.trait, note: `distracted by a ${animal.name}` })
      const resume = current
      // Await the deliberation: a slow LLM reply must not land after the resume below
      // and overwrite the interrupted activity with whatever it decided mid-distraction.
      await deliberate(`You spot a cute ${animal.name} nearby and go over to it.`)
      await withTimeout(followEntity(bot, animal, 14000), 17000, 'follow animal').catch(() => {})
      generation += 1
      current = resume
    }
  }

  // Шаг 8: task-board reporting — claim acknowledged on hear, progress heartbeated in
  // the loop, the outcome reported when the collecting finishes. Speech stays the
  // human layer; the board is the reliable transport.
  function reportTask (ok, result) {
    if (!board || !activeTaskId) return
    const outcome = ok ? board.complete(activeTaskId, persona.name, result) : board.failTask(activeTaskId, persona.name, String(result))
    if (outcome.ok) record('task', { agent: persona.name, taskId: activeTaskId, ok, result })
    activeTaskId = null
  }

  function heartbeatTask () {
    if (!board || !activeTaskId) return
    if (Date.now() - lastHeartbeatAt < 15000) return
    lastHeartbeatAt = Date.now()
    const beat = board.heartbeat(activeTaskId, persona.name)
    if (!beat.ok) activeTaskId = null // lease lapsed or reassigned: the board took it back
  }

  async function loop () {
    while (running) {
      try {
        const startedAt = Date.now()
        const here = pos()
        if (here) {
          const s = sectorKeyOf(here)
          if (s !== lastSectorKey) { lastSectorKey = s; spatial.noteVisit(here) }
        }
        heartbeatTask()
        if (hookWanted()) await runHook()
        else await runAction(current, generation)
        // Defense in depth against microtask starvation: an action that resolves
        // near-instantly (e.g. the followed player is already in range) must not
        // hand control straight back to the next await — timers and sockets would
        // never run again and inbound packets pile up into an OOM.
        const spent = Date.now() - startedAt
        if (spent < 100) await sleep(TICK_MS - spent)
      } catch (err) {
        record('error', { agent: persona.name, where: 'loop', message: err.message })
        await sleep(TICK_MS)
      }
    }
  }

  return Object.freeze({
    name: persona.name,
    bot,
    ready,
    persona,
    stats: () => stats,
    spatial: () => spatial,
    start () { running = true; loop() },
    stop () { running = false; bot.pathfinder.setGoal(null) }
  })
}
