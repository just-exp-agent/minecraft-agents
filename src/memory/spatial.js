// Spatial memory (roadmap Шаг 4): a per-bot sector map, not a voxel world. Sectors are
// 32x32 columns; each holds visits, scans, resource records with timestamps, hazards,
// containers and unreachable marks. Absence of a record is NOT evidence of absence, and
// records go stale (the block may be mined, the path may be gone) — consumers filter by
// age. frontier() finds the nearest unknown sector adjacent to a known one; exploreArea()
// walks the frontier loop algorithmically (LLM decides goals, never individual blocks).
import { navigateTo } from '../gather.js'
import { scanArea } from '../perception.js'
import { config } from '../config.js'

const MEM = config.params.memory || {}
const SECTOR_SIZE = 32
const SCAN_CATEGORIES = ['logs', 'planks', 'containers', 'workstations', 'hazards']
const MAX_RECORDS_PER_SECTOR = 64

const key = p => `${p.x},${p.y},${p.z}`
export const sectorKeyOf = p => `${Math.floor(p.x / SECTOR_SIZE)},${Math.floor(p.z / SECTOR_SIZE)}`

/** Pure: the 8 surrounding sector keys of a sector key. */
export function neighborsOfSector (sector) {
  const [cx, cz] = sector.split(',').map(Number)
  const out = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx || dz) out.push(`${cx + dx},${cz + dz}`)
    }
  }
  return out
}

/** Pure: world-coordinate center of a sector (y is left to the walker). */
export function sectorCenter (sector) {
  const [cx, cz] = sector.split(',').map(Number)
  return { x: cx * SECTOR_SIZE + SECTOR_SIZE / 2, y: 0, z: cz * SECTOR_SIZE + SECTOR_SIZE / 2 }
}

export function createSpatialMemory (bot, { staleAfterMs = MEM.stale_after_ms ?? 600000 } = {}) {
  const sectors = new Map()

  const sector = k => {
    if (!sectors.has(k)) {
      const [cx, cz] = k.split(',').map(Number)
      sectors.set(k, {
        cx, cz,
        visits: 0,
        lastVisitAt: null,
        scans: 0,
        lastScanAt: null,
        resources: new Map(), // category -> Map<posKey, { position, name, seenAt }>
        unreachable: []       // [{ position, reason, at }]
      })
    }
    return sectors.get(k)
  }

  function noteVisit (position) {
    const s = sector(sectorKeyOf(position))
    s.visits += 1
    s.lastVisitAt = Date.now()
  }

  /** Fold a perception scanArea result into the sector's indexes. */
  function recordScan (center, scan) {
    const s = sector(sectorKeyOf(center))
    s.scans += 1
    s.lastScanAt = Date.now()
    const now = Date.now()
    for (const category of SCAN_CATEGORIES) {
      const found = (scan.blocks || []).filter(b => b.category === category)
      if (!found.length) continue
      if (!s.resources.has(category)) s.resources.set(category, new Map())
      const index = s.resources.get(category)
      for (const b of found) {
        index.set(key(b.position), { position: b.position, name: b.name, seenAt: now })
      }
      // Bounded: drop the oldest records when the sector index overflows.
      if (index.size > MAX_RECORDS_PER_SECTOR) {
        const sorted = [...index.values()].sort((a, b) => a.seenAt - b.seenAt)
        for (const old of sorted.slice(0, index.size - MAX_RECORDS_PER_SECTOR)) index.delete(key(old.position))
      }
    }
    return s
  }

  /** Fresh-enough records of a resource category, nearest first. Empty ≠ "none exist". */
  function knownResources (category, { maxAgeMs = staleAfterMs, from = null } = {}) {
    const now = Date.now()
    const out = []
    for (const s of sectors.values()) {
      const index = s.resources.get(category)
      if (!index) continue
      for (const record of index.values()) {
        if (now - record.seenAt > maxAgeMs) continue // stale: marked, kept, not offered
        out.push({ ...record, sector: `${s.cx},${s.cz}`, ageMs: now - record.seenAt })
      }
    }
    return from
      ? out.sort((a, b) => Math.hypot(a.position.x - from.x, a.position.z - from.z) - Math.hypot(b.position.x - from.x, b.position.z - from.z))
      : out
  }

  function markUnreachable (position, reason) {
    sector(sectorKeyOf(position)).unreachable.push({ position: { ...position }, reason, at: Date.now() })
  }

  const isBlocked = (s, now) => s.unreachable.some(u => now - u.at < staleAfterMs &&
    Math.hypot(u.position.x - (s.cx * SECTOR_SIZE + SECTOR_SIZE / 2), u.position.z - (s.cz * SECTOR_SIZE + SECTOR_SIZE / 2)) < SECTOR_SIZE)

  /**
   * Nearest unvisited sector adjacent to a visited one — the known/unknown boundary.
   * Returns { key, center } or null when the known world has no unknown neighbours.
   */
  function frontier ({ from = null } = {}) {
    const origin = from || bot.entity?.position
    if (!origin) return null
    const now = Date.now()
    const boundary = []
    for (const s of sectors.values()) {
      if (!s.visits) continue // unknown sectors are only reachable through known ones
      for (const n of neighborsOfSector(`${s.cx},${s.cz}`)) {
        const ns = sectors.get(n)
        if (ns && ns.visits) continue // already known
        const [cx, cz] = n.split(',').map(Number)
        const center = { x: cx * SECTOR_SIZE + SECTOR_SIZE / 2, y: 0, z: cz * SECTOR_SIZE + SECTOR_SIZE / 2 }
        if (ns && isBlocked(ns, now)) continue // a failed route stays banned until stale
        boundary.push({ key: n, center, distance: Math.hypot(center.x - origin.x, center.z - origin.z) })
      }
    }
    if (!boundary.length) return null
    // De-duplicate neighbour keys listed by several known sectors; keep the nearest entry.
    const byKey = new Map()
    for (const b of boundary) if (!byKey.has(b.key) || byKey.get(b.key).distance > b.distance) byKey.set(b.key, b)
    return [...byKey.values()].sort((a, b) => a.distance - b.distance)[0]
  }

  /**
   * The frontier loop: pick a boundary sector, walk there, scan, index, repeat.
   * Bounded by maxSteps and shouldStop; navigation failures mark the sector blocked
   * and the loop moves on instead of hammering one direction.
   */
  async function exploreArea ({ maxSteps = 4, scanRadius = 24, navTimeoutMs = 45000, shouldStop = () => false, onStep = () => {} } = {}) {
    const startedAt = Date.now()
    const visitedNow = []
    const discovered = {}
    for (let step = 0; step < maxSteps; step++) {
      if (shouldStop()) break
      const target = frontier()
      if (!target) break // the whole known boundary is explored
      const walk = await navigateTo(bot, { x: target.center.x, y: bot.entity?.position?.y ?? 0, z: target.center.z }, { range: 6, timeoutMs: navTimeoutMs })
      if (walk.status !== 'success' && walk.status !== 'partial') {
        markUnreachable(target.center, `navigation ${walk.status}: ${walk.error || 'unknown'}`)
        onStep({ step, target: target.key, status: walk.status })
        continue
      }
      const pos = bot.entity?.position
      if (!pos) break
      noteVisit(pos)
      if (!visitedNow.includes(sectorKeyOf(pos))) visitedNow.push(sectorKeyOf(pos))
      const scan = scanArea(bot, { radius: scanRadius })
      recordScan(pos, scan)
      for (const b of scan.blocks) {
        discovered[b.category] = (discovered[b.category] || 0) + 1
      }
      onStep({ step, target: target.key, status: walk.status, blocks: scan.blocks.length })
    }
    return { steps: visitedNow.length, visitedSectors: visitedNow, discovered, elapsedMs: Date.now() - startedAt }
  }

  function serialize () {
    return {
      staleAfterMs,
      sectors: [...sectors.values()].map(s => ({
        ...s,
        resources: Object.fromEntries([...s.resources.entries()].map(([c, m]) => [c, [...m.values()]]))
      }))
    }
  }

  function restore (data) {
    for (const s of data.sectors || []) {
      const record = sector(`${s.cx},${s.cz}`)
      Object.assign(record, { ...s, resources: new Map() })
      record.resources = new Map(Object.entries(s.resources || {}).map(([c, list]) => [c, new Map(list.map(r => [key(r.position), r]))]))
    }
  }

  return Object.freeze({
    noteVisit,
    recordScan,
    knownResources,
    markUnreachable,
    frontier,
    exploreArea,
    serialize,
    restore,
    stats: () => ({
      sectors: sectors.size,
      visited: [...sectors.values()].filter(s => s.visits).length,
      records: [...sectors.values()].reduce((sum, s) => sum + [...s.resources.values()].reduce((n, m) => n + m.size, 0), 0)
    })
  })
}
