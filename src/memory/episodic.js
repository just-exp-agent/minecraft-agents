// Long-term memory (roadmap Шаг 9): episodic records are objective game events —
// which task, which skill, arguments, world/inventory changes, outcome and the reason —
// not just the agent's inner monologue. Semantic memory is the checked recipe/tool
// catalogue the planner already uses. Persistence saves per-agent memory (episodes +
// the spatial map) to JSON on session end and restores it on start, so a worker
// remembers known resource spots and past failure modes across restarts.
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { record } from '../events.js'

const MEMORY_DIR = path.join(config.logDir, 'memory')
const MAX_EPISODES = 200

export function memoryPath (agent) {
  return path.join(MEMORY_DIR, `${agent}.json`)
}

/**
 * Episodic memory: append-only objective episodes with timestamps. Not every thought
 * lands here — the caller records one episode per completed (or failed) action.
 */
export function createEpisodicMemory (agent) {
  let episodes = []

  /** episode: { task, skill, args, outcome: success|partial|failed, reason, position, delta } */
  function add (episode) {
    const record_ = { t: Date.now(), agent, ...episode }
    episodes = [...episodes, record_].slice(-MAX_EPISODES)
    return record_
  }

  /** Success rate of a skill from real outcomes — the basis for strategy choice. */
  function skillStats (skill) {
    const mine = episodes.filter(e => e.skill === skill)
    const ok = mine.filter(e => e.outcome === 'success').length
    return { attempts: mine.length, successes: ok, rate: mine.length ? ok / mine.length : null }
  }

  /** Episodes similar to a current situation (same skill/task) — "what worked last time". */
  function similar ({ skill, task }, limit = 3) {
    return episodes
      .filter(e => (skill && e.skill === skill) || (task && e.task === task))
      .slice(-limit)
  }

  function serialize () { return [...episodes] }
  function restore (data) { episodes = Array.isArray(data) ? data.slice(-MAX_EPISODES) : [] }
  return Object.freeze({ add, skillStats, similar, serialize, restore, size: () => episodes.length })
}

/** Save one agent's long-term memory (episodes + spatial map) to disk. */
export function saveAgentMemory (agent, { episodes, spatial }) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  const payload = { agent, savedAt: new Date().toISOString(), episodes, spatial }
  fs.writeFileSync(memoryPath(agent), JSON.stringify(payload))
  record('memory', { agent, saved: true, episodes: episodes.length, sectors: spatial?.sectors?.length ?? 0 })
}

/** Restore an agent's long-term memory; null when nothing was saved yet. */
export function loadAgentMemory (agent) {
  const file = memoryPath(agent)
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { savedAt: data.savedAt, episodes: data.episodes || [], spatial: data.spatial || null }
  } catch (err) {
    record('error', { agent, where: 'memory-load', message: err.message })
    return null
  }
}
