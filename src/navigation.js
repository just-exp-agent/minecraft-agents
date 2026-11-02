// Navigation as a managed operation (roadmap Шаг 2). The Mineflayer pathfinder stays
// the engine; this executor adds the operation contract around it:
//   start(target) -> operationId, status(id) -> running/success/partial/failed/timeout/cancelled,
//   cancel(id), canReach(target) -> preliminary reachability with a failure reason.
// Status snapshots carry position, target, distance, elapsed time, phase
// (planning/moving/recovering), stuck flag, attempt count. Recovery is bounded by a
// retry ladder (pathRetryPlan) — no infinite retries. One active movement per bot:
// a new start() supersedes the running operation.
import pathfinderPkg from 'mineflayer-pathfinder'
import { config } from './config.js'
import { record } from './events.js'
import { pathRetryPlan } from './skills.js'

const { goals } = pathfinderPkg

const PATH = config.params.path
const NAV = config.params.navigation || {}

const SAMPLE_MS = NAV.sample_ms ?? 250          // status poll + stuck sampling
const STUCK_TIMEOUT_MS = NAV.stuck_timeout_ms ?? 4000
const STUCK_DISTANCE = 0.8                      // less movement per sample than this = standing
const REACH_EPS = 1.2                           // goal_reached can lag; this close counts as arrived

const round1 = n => Math.round(n * 10) / 10
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Reachability answers are coarse on purpose: null = "cannot say". */
const UNKNOWN = reason => Object.freeze({ reachable: null, reason })

export function createNavigator (bot, {
  sampleMs = SAMPLE_MS,
  stuckTimeoutMs = STUCK_TIMEOUT_MS
} = {}) {
  const ops = new Map()
  let nextId = 1
  let current = null

  const position = () => {
    const p = bot.entity?.position
    return p ? { x: round1(p.x), y: round1(p.y), z: round1(p.z) } : null
  }

  const snapshot = op => Object.freeze({
    id: op.id,
    status: op.status,
    phase: op.phase,
    target: op.target,
    position: position(),
    distance: bot.entity?.position ? round1(dist3(bot.entity.position, op.target)) : null,
    elapsedMs: op.done ? op.elapsedFinal : Date.now() - op.startedAt,
    attempts: op.attempts,
    stuck: op.stuckMs >= stuckTimeoutMs,
    stuckMs: op.stuckMs,
    error: op.error
  })

  function finish (op, status, error = null) {
    if (op.done) return
    op.done = true
    op.status = status
    op.phase = 'done'
    op.error = error
    op.elapsedFinal = Date.now() - op.startedAt
    if (op.timer) clearInterval(op.timer)
    op.timer = null
    if (current === op) current = null
    bot.pathfinder.setGoal(null)
    record('nav', { agent: bot.username, op: op.id, result: status, error, attempts: op.attempts, elapsedMs: op.elapsedFinal })
  }

  function recover (op, reason) {
    if (op.attempts >= op.ladder.length) return finish(op, 'failed', reason)
    op.phase = 'recovering'
    op.error = reason
    op.stuckMs = 0
    bot.pathfinder.setGoal(null)
    const next = op.ladder[op.attempts] // attempts is 1-based after the first beginAttempt
    setTimeout(() => beginAttempt(op, next.range), next.settleMs).unref?.()
  }

  function beginAttempt (op, range) {
    if (op.done) return
    op.attempts += 1
    op.phase = 'planning'
    op.range = range
    op.stuckMs = 0
    op.lastPos = null
    bot.pathfinder.setGoal(new goals.GoalNear(op.target.x, op.target.y, op.target.z, range))
  }

  function poll (op) {
    if (op.done) return
    const pos = bot.entity?.position
    if (!pos) return
    const d = dist3(pos, op.target)
    if (d <= op.range + REACH_EPS) {
      // Arriving only after the ladder widened the range is a PARTIAL, not a success:
      // "I got near, not there" is exactly what the Worker needs to hear.
      const widened = op.range > op.range0 + 0.1 && d > op.range0 + REACH_EPS
      return finish(op, widened ? 'partial' : 'success',
        widened ? `arrived ${round1(d)} blocks from the target (requested ${op.range0})` : null)
    }
    if (Date.now() - op.startedAt > op.timeoutMs) {
      return finish(op, 'timeout', `not within ${op.range} blocks of the target in ${op.timeoutMs} ms`)
    }
    if (op.phase === 'moving') {
      const moved = op.lastPos ? dist3(pos, op.lastPos) : Infinity
      op.stuckMs = moved < STUCK_DISTANCE ? op.stuckMs + sampleMs : 0
      if (op.stuckMs >= stuckTimeoutMs) recover(op, `stuck for ${Math.round(op.stuckMs)} ms`)
    }
    op.lastPos = { x: pos.x, y: pos.y, z: pos.z }
  }

  // Shared pathfinder event wiring: these flip phases and feed the recovery ladder.
  bot.on('path_update', res => {
    if (!current || current.done) return
    const status = res?.status
    if (status === 'noPath') recover(current, 'pathfinder: no path to the target')
    else if (status === 'timeout') recover(current, 'pathfinder: think timeout')
    else if (status === 'success' || status === 'partial') current.phase = 'moving'
  })
  bot.on('goal_reached', () => {
    if (!current || current.done) return
    const pos = bot.entity?.position
    const d = pos ? dist3(pos, current.target) : 0
    const widened = current.range > current.range0 + 0.1 && d > current.range0 + REACH_EPS
    finish(current, widened ? 'partial' : 'success',
      widened ? `arrived ${round1(d)} blocks from the target (requested ${current.range0})` : null)
  })

  function start (target, { range = 2, timeoutMs = PATH.skill_timeout_ms } = {}) {
    if (current && !current.done) cancel(current.id, 'superseded by a newer navigation')
    if (!Number.isFinite(target?.x) || !Number.isFinite(target?.z)) {
      throw new Error('navigation target needs numeric x/z')
    }
    const op = {
      id: nextId++,
      target: Object.freeze({ x: round1(target.x), y: round1(target.y ?? 0), z: round1(target.z) }),
      range,
      timeoutMs,
      status: 'running',
      phase: 'planning',
      attempts: 0,
      range0: range,
      error: null,
      stuckMs: 0,
      lastPos: null,
      startedAt: Date.now(),
      ladder: pathRetryPlan(range),
      done: false,
      timer: null
    }
    ops.set(op.id, op)
    current = op
    op.timer = setInterval(() => poll(op), sampleMs)
    op.timer.unref?.()
    beginAttempt(op, op.ladder[0].range)
    return op.id
  }

  function cancel (id, reason = 'cancelled by request') {
    const op = ops.get(Number(id))
    if (!op || op.done) return false
    finish(op, 'cancelled', reason)
    return true
  }

  /**
   * Preliminary reachability check: sets a throwaway goal and reads the first
   * pathfinder verdict. Not usable while an operation is moving (a check would
   * hijack its goal) — answers "cannot say" instead of corrupting the walk.
   */
  function canReach (target, { range = 2, budgetMs = NAV.can_reach_budget_ms ?? 6000 } = {}) {
    return new Promise(resolve => {
      if (!bot.entity?.position) return resolve(UNKNOWN('world not loaded'))
      if (current && !current.done) return resolve(UNKNOWN('navigation in progress'))
      let settled = false
      const done = result => {
        if (settled) return
        settled = true
        clearTimeout(budget)
        bot.removeListener('path_update', onUpdate)
        bot.pathfinder.setGoal(null)
        resolve(Object.freeze(result))
      }
      const onUpdate = res => {
        if (res?.status === 'success') done({ reachable: true, reason: null })
        else if (res?.status === 'partial') done({ reachable: true, reason: 'partial path only' })
        else if (res?.status === 'noPath') done({ reachable: false, reason: 'no path to the target' })
        else if (res?.status === 'timeout') done(UNKNOWN('pathfinder think timeout'))
      }
      const budget = setTimeout(() => done(UNKNOWN(`no path verdict within ${budgetMs} ms`)), budgetMs)
      budget.unref?.()
      bot.on('path_update', onUpdate)
      bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, range))
    })
  }

  return Object.freeze({
    start,
    cancel,
    canReach,
    status: id => {
      const op = ops.get(Number(id))
      return op ? snapshot(op) : Object.freeze({ id: Number(id), status: 'unknown' })
    },
    active: () => (current && !current.done ? snapshot(current) : null),
    all: () => Object.freeze([...ops.values()].filter(op => !op.done || Date.now() - op.startedAt < 60000).map(snapshot))
  })
}

/** Await an operation's terminal state (polls status); resolves with the final snapshot. */
export function waitOperation (navigator, id, { timeoutMs = 120000, pollMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const snap = navigator.status(id)
      if (snap.status !== 'running') {
        clearInterval(timer)
        return resolve(snap)
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer)
        navigator.cancel(id, 'waitOperation gave up')
        return reject(new Error(`operation ${id} still running after ${timeoutMs} ms`))
      }
    }, pollMs)
    timer.unref?.()
  })
}
