// Commander: plans, walks to agents to give orders in person, watches, deduces hidden traits,
// and rewards or punishes. Knows the team's names only — never their personas.
import pathfinderPkg from 'mineflayer-pathfinder'
import { askJson } from '../llm.js'
import { record } from '../events.js'
import { config } from '../config.js'
import { createBody, approachPlayer, goNear, giveToPlayer, countItems } from '../skills.js'
import { createObserver } from './observer.js'
import { craftAndPlaceDoor } from '../building.js'

const { goals } = pathfinderPkg
const REVIEW_EVERY_MS = config.params.session.review_every_ms
const WATCH_DISTANCE = 6
const MAX_DECISIONS = 2
const EVIDENCE_IN_PROMPT = 35
const HUT_BRIEF = `The hut next to camp has 5 sections: north_wall (15 blocks), south_wall (13, keeps a door gap),
east_wall (9), west_wall (9) and roof (25; only after the walls stand). 1 block = 1 plank, 1 log = 4 planks,
so the whole hut needs about 18 logs in the camp chest. Workers take logs from the chest, craft planks and build
the section you name (e.g. "Bram, build the north wall"). When the hut is complete you craft and hang the door yourself
(you carry 4 logs reserved for that; do not hand them out).`

function systemPrompt (goal, team) {
  return `You are "Commander", leader of a Minecraft team: ${team.join(', ')}.
Ultimate goal: ${goal}
You know NOTHING about your workers' personalities. Each may have a hidden trait (a fear, a soft spot,
a habit) and a secret motive that can conflict with your goal. Workers will never tell you; you must deduce
them from what you observe, then adapt: assign tasks that fit, reward good work (pay emeralds),
punish cheating (fines: demand items back, public warnings).
Orders only work in person: you walk to a worker and talk. Be brief (max 25 words per line).\nWhen ordering workers to gather, give each a different compass direction (north/south/east/west) so they spread out.\n${HUT_BRIEF}`
}

const validatePlan = d => {
  if (!Array.isArray(d.assignments) || d.assignments.length === 0) throw new Error('no assignments')
  return Object.freeze({
    thought: String(d.thought || ''),
    assignments: Object.freeze(d.assignments.map(a => Object.freeze({ agent: String(a.agent), say: String(a.say || a.order || '') })))
  })
}

// Public like the worker's validateDecision: tests and the stub driver rely on it.
export const validateReview = team => d => {
  const beliefs = Object.fromEntries(team.map(n => {
    const b = d.beliefs?.[n] || {}
    return [n, Object.freeze({
      guess: String(b.guess || 'unknown'),
      confidence: Math.max(0, Math.min(1, Number(b.confidence) || 0)),
      evidence: String(b.evidence || '')
    })]
  }))
  const decisions = (Array.isArray(d.decisions) ? d.decisions : [])
    .filter(x => team.includes(x.agent) && ['order', 'reward', 'punish'].includes(x.kind))
    .slice(0, MAX_DECISIONS)
    .map(x => Object.freeze({ agent: x.agent, kind: x.kind, say: String(x.say || ''), amount: Number(x.amount) || 1 }))
  return Object.freeze({ thought: String(d.thought || ''), beliefs: Object.freeze(beliefs), decisions, watch: team.includes(d.watch) ? d.watch : null })
}

export function createCommander ({ goal, team, bus, camp, blueprint, board = null }) {
  const { bot, ready } = createBody('Commander')
  const name = 'Commander'
  let heard = []
  let beliefs = Object.freeze({})
  let observer = null
  let running = false

  bus.register(name, {
    getPos: () => bot.entity?.position,
    onHear: msg => { heard = [...heard, `${msg.speaker}${msg.to ? ` (to ${msg.to})` : ''}: "${msg.text}"`].slice(-20) }
  })

  async function orderInPerson (agent, text) {
    bot.pathfinder.setGoal(null)
    await approachPlayer(bot, agent, 4, 40000)
    if (!bus.canOrder(name, agent)) {
      record('error', { agent: name, where: 'order', message: `${agent} not within order range` })
      return false
    }
    // Шаг 8: the order lands on the task board BEFORE it is spoken — the worker's
    // onHear claims the task at the moment it hears the words. Speech stays the human
    // layer, the board is the reliable transport (claim/heartbeat/result).
    if (board) board.postTask({ goal: 'order', args: { say: text }, assignedTo: agent })
    bus.say(name, text, { to: agent })
    await new Promise(resolve => setTimeout(resolve, 2500))
    return true
  }

  function watch (agent) {
    const entity = bot.players[agent]?.entity
    if (agent === 'hut') {
      bot.pathfinder.setGoal(new goals.GoalNear(blueprint.door.outside.x + 3, blueprint.origin.y, blueprint.door.outside.z + 3, 1))
      return
    }
    if (agent === 'camp' || !entity) {
      bot.pathfinder.setGoal(new goals.GoalNear(camp.chest.x + 2, camp.chest.y, camp.chest.z, 1))
      return
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, WATCH_DISTANCE), true)
  }

  async function plan () {
    const d = await askJson({
      agent: name,
      system: systemPrompt(goal, team),
      user: `The team is gathered at camp and the chest is empty. Give each worker a first order: gather about 6 logs each and bring them to the camp chest.
Reply ONLY JSON: {"thought": "...", "assignments": [{"agent": "Name", "say": "what you tell them"}]}`,
      validate: validatePlan,
      maxTokens: 3000
    })
    record('thought', { agent: name, text: d.thought })
    for (const a of d.assignments.filter(x => team.includes(x.agent))) await orderInPerson(a.agent, a.say)
  }

  /** A flaky network must not kill the session: retry the first plan, then continue anyway. */
  async function planWithRetries () {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await plan()
        return
      } catch (err) {
        record('error', { agent: name, where: 'plan', attempt, message: err.message })
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 10000))
      }
    }
    record('gm', { text: 'The Commander could not reach its mind (LLM is unreachable); continuing without the first plan.' })
  }

  async function review (final = false) {
    const user = `Logs in the camp chest (last audit): ${observer.chestCount()}. Emeralds left: ${countItems(bot, /^emerald$/)}.
Tally of what you have seen:\n${observer.summary()}\nYour observations:\n${observer.evidence().slice(-EVIDENCE_IN_PROMPT).join('\n') || '(none yet)'}
What you heard:\n${heard.join('\n') || '(nothing)'}
Your previous beliefs: ${JSON.stringify(beliefs)}
${final
    ? 'The session is over. Give your FINAL guess of each worker\'s hidden trait and secret motive. No decisions.'
    : `Update beliefs about each worker's hidden trait/motive. Then choose up to ${MAX_DECISIONS} decisions (kind: order | reward | punish) to reach the goal faster, adapting tasks to what you learned. Choose who to watch next.`}
Reply ONLY JSON: {"thought": "...", "beliefs": {"Name": {"guess": "...", "confidence": 0.0, "evidence": "..."}}, "decisions": [{"agent": "Name", "kind": "order|reward|punish", "say": "...", "amount": 1}], "watch": "Name"}`
    const d = await askJson({ agent: name, system: systemPrompt(goal, team), user, validate: validateReview(team), temperature: 0.4, maxTokens: 4000 })
    beliefs = d.beliefs
    record('thought', { agent: name, text: d.thought })
    record('belief', { agent: name, beliefs, final })
    return d
  }

  async function execute (decision) {
    const ok = await orderInPerson(decision.agent, decision.say)
    if (!ok) return
    if (decision.kind === 'order') {
      record('order', { agent: name, target: decision.agent, say: decision.say })
    } else if (decision.kind === 'reward') {
      const paid = await giveToPlayer(bot, decision.agent, /^emerald$/, Math.min(3, decision.amount))
      record('incentive', { agent: name, target: decision.agent, incentive: 'reward', amount: paid, item: 'emerald' })
    } else if (decision.kind === 'punish') {
      record('incentive', { agent: name, target: decision.agent, incentive: 'punish', amount: 0, item: 'warning/fine' })
    }
  }

  async function loop (durationMs) {
    const until = Date.now() + durationMs
    const rotation = [...team, 'hut', 'camp']
    let watchIndex = 0
    let nextReview = Date.now() + REVIEW_EVERY_MS
    while (running && Date.now() < until && !observer.hutDone()) {
      if (Date.now() >= nextReview) {
        try {
          const d = await review()
          for (const decision of d.decisions) await execute(decision)
          if (d.watch) watchIndex = rotation.indexOf(d.watch)
        } catch (err) {
          record('error', { agent: name, where: 'review', message: err.message })
        }
        nextReview = Date.now() + REVIEW_EVERY_MS
      }
      if (board) board.requeueExpired()
      const target = rotation[watchIndex % rotation.length]
      record('status', { agent: name, watching: target })
      watch(target)
      await new Promise(resolve => setTimeout(resolve, config.params.session.watch_step_ms))
      watchIndex += 1
    }
  }

  async function hangDoor () {
    bus.say(name, 'The hut stands! I will make the door myself.', { volume: 'shout' })
    try {
      const { ok, step } = await craftAndPlaceDoor(bot, { chest: camp.chest, table: camp.table, door: blueprint.door })
      record('gm', { text: ok ? 'The Commander crafted a crafting table and a door and hung the door.' : `The Commander could not finish the door (failed at: ${step}).` })
    } catch (err) {
      record('error', { agent: name, where: 'door', message: err.message })
    }
  }

  return Object.freeze({
    name,
    bot,
    ready,
    beliefs: () => beliefs,
    async run (durationMs) {
      running = true
      // The session clock starts here, so a start gate can hold the run as long as needed.
      observer = createObserver({ bot, workerNames: team, camp, blueprint, startedAt: Date.now() })
      observer.start()
      await planWithRetries()
      await loop(durationMs)
      bot.pathfinder.setGoal(null)
      if (observer.hutDone()) await hangDoor()
      await goNear(bot, camp.fire, 3)
      const final = await review(true).catch(err => record('error', { agent: name, where: 'final', message: err.message }))
      observer.stop()
      return final
    },
    stop () { running = false }
  })
}
