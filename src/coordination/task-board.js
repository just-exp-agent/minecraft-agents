// Multi-agent task board (roadmap Шаг 8). The commander posts structured tasks — not
// just speech; workers claim them, heartbeat, report progress and results. Leases
// prevent two workers on one task and re-queue hung ones; proximity speech and hidden
// personas stay a separate layer and never manage task reliability.
import { record } from '../events.js'
import { config } from '../config.js'

const BOARD = config.params.board || {}
const DEFAULT_LEASE_MS = BOARD.lease_ms ?? 90000        // a claim expires after this without heartbeats
const DEFAULT_STALE_MS = BOARD.stale_ms ?? 30000        // no heartbeat for this long → the lease lapses early

const now = () => Date.now()

export function createTaskBoard ({ onEvent = () => {}, leaseMs = DEFAULT_LEASE_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  let nextId = 1
  let tasks = new Map()
  let reservations = new Map() // sectorKey -> { by, until }

  const emit = (kind, data) => {
    record(kind, data)
    onEvent({ kind, ...data })
  }

  /** Post a structured task: { goal, args, targetArea?, assignedTo? } */
  function postTask ({ goal, args = {}, targetArea = null, assignedTo = null }) {
    const task = {
      taskId: `task${nextId++}`,
      goal,
      args,
      targetArea,
      assignedTo,
      status: 'pending',
      assignee: null,
      leaseUntil: null,
      heartbeatAt: null,
      progress: 0,
      blocker: null,
      result: null,
      postedAt: now()
    }
    tasks = new Map(tasks)
    tasks.set(task.taskId, task)
    emit('task', { phase: 'posted', taskId: task.taskId, goal, args, assignedTo })
    return task.taskId
  }

  /** Worker takes a task: fails if already claimed by someone else (no duplicate work). */
  function claim (taskId, worker) {
    const task = tasks.get(taskId)
    if (!task) return { ok: false, reason: 'no_such_task' }
    if (task.status !== 'pending') return { ok: false, reason: `status_${task.status}` }
    if (task.assignee && task.assignee !== worker) return { ok: false, reason: 'already_claimed' }
    const t = { ...task, status: 'accepted', assignee: worker, leaseUntil: now() + leaseMs, heartbeatAt: now() }
    tasks = new Map(tasks)
    tasks.set(taskId, t)
    emit('task', { phase: 'claimed', taskId, worker })
    return { ok: true, task: t }
  }

  /** Lease renewal; a lapsed lease means the task is no longer ours. */
  function heartbeat (taskId, worker, progress = null) {
    const task = tasks.get(taskId)
    if (!task || task.assignee !== worker) return { ok: false, reason: 'not_assignee' }
    if (task.leaseUntil && now() > task.leaseUntil) return { ok: false, reason: 'lease_lapsed' }
    const t = { ...task, heartbeatAt: now(), leaseUntil: now() + leaseMs, status: task.status === 'accepted' ? 'running' : task.status }
    if (progress !== null) t.progress = progress
    tasks = new Map(tasks)
    tasks.set(taskId, t)
    return { ok: true, task: t }
  }

  function complete (taskId, worker, result = {}) {
    const task = tasks.get(taskId)
    if (!task || task.assignee !== worker) return { ok: false, reason: 'not_assignee' }
    const t = { ...task, status: 'completed', result, leaseUntil: null, progress: 1 }
    tasks = new Map(tasks)
    tasks.set(taskId, t)
    emit('task', { phase: 'completed', taskId, worker, result })
    return { ok: true, task: t }
  }

  function failTask (taskId, worker, reason) {
    const task = tasks.get(taskId)
    if (!task || task.assignee !== worker) return { ok: false, reason: 'not_assignee' }
    const t = { ...task, status: 'failed', blocker: reason, result: null, leaseUntil: null }
    tasks = new Map(tasks)
    tasks.set(taskId, t)
    emit('task', { phase: 'failed', taskId, worker, reason })
    return { ok: true, task: t }
  }

  /** Requeue tasks whose leases lapsed (hung workers) — happens on significant ticks only. */
  function requeueExpired () {
    const requeued = []
    let changed = false
    const t2 = new Map(tasks)
    for (const [id, task] of t2) {
      const active = ['accepted', 'running'].includes(task.status)
      const lapsed = task.leaseUntil && now() > task.leaseUntil
      const silent = task.heartbeatAt && now() - task.heartbeatAt > staleMs && now() > (task.leaseUntil || 0)
      if (active && (lapsed || silent)) {
        t2.set(id, { ...task, status: 'pending', assignee: null, leaseUntil: null, heartbeatAt: null, blocker: 'lease_expired' })
        requeued.push(id)
        changed = true
        emit('task', { phase: 'requeued', taskId: id, reason: 'lease_expired' })
      }
    }
    if (changed) tasks = t2
    return requeued
  }

  /** Best pending task for a worker: honour explicit assignment, prefer nearest target. */
  function pickTaskFor (worker, { position = null } = {}) {
    requeueExpired()
    const pending = [...tasks.values()].filter(t => t.status === 'pending' && (!t.assignee || t.assignee === worker))
    const explicit = pending.find(t => t.assignedTo === worker)
    const pool = explicit ? [explicit] : pending.filter(t => !t.assignedTo)
    if (!pool.length) return null
    const ranked = position
      ? pool.sort((a, b) => (dist(a.targetArea, position) - dist(b.targetArea, position)))
      : pool
    return ranked[0].taskId
  }

  const dist = (area, p) => area && area.x !== undefined && p ? Math.hypot(area.x - p.x, area.z - p.z) : 0

  /** Sector reservation so two workers do not strip the same grove. */
  function reserve (sectorKey, worker, ms = leaseMs) {
    const existing = reservations.get(sectorKey)
    if (existing && existing.by !== worker && now() < existing.until) return { ok: false, reason: 'reserved_by_other' }
    reservations = new Map(reservations)
    reservations.set(sectorKey, { by: worker, until: now() + ms })
    return { ok: true }
  }

  function release (sectorKey, worker) {
    const existing = reservations.get(sectorKey)
    if (!existing || existing.by !== worker) return false
    reservations = new Map(reservations)
    reservations.delete(sectorKey)
    return true
  }

  function snapshot () {
    requeueExpired()
    return [...tasks.values()].map(t => ({ ...t }))
  }

  function reset () {
    tasks = new Map()
    reservations = new Map()
  }

  return Object.freeze({ postTask, claim, heartbeat, complete, failTask, requeueExpired, pickTaskFor, reserve, release, snapshot, reset })
}

export const board = createTaskBoard()
