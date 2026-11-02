#!/usr/bin/env node
// Roadmap Шаг 0: repeatable skill-level benchmark against the live seeded server.
// Runs fixed scenarios (src/benchmark/scenarios.js) with a deterministic driver,
// records movement/stuck/path metrics into the run JSONL and a compact per-run
// JSONL for batch comparison.
//
// Usage:
//   node scripts/benchmark.js                              # every scenario, 1 repeat each
//   node scripts/benchmark.js --scenario logs_return --repeat 3
//   node scripts/benchmark.js --tag baseline               # writes logs/benchmark-baseline.jsonl
//
// Requires the Minecraft server to be up (scripts/start-server.sh). No LLM involved.
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../src/config.js'
import { record } from '../src/events.js'
import { createBody, withTimeout } from '../src/skills.js'
import { consoleCommand } from '../src/gm.js'
import { SCENARIOS, makeContext, commandDelayMs } from '../src/benchmark/scenarios.js'
import { createTracker } from '../src/benchmark/tracker.js'

const args = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const scenarioId = opt('scenario')
const repeats = Number(opt('repeat', '1')) || 1
const tag = opt('tag', 'runs')
const username = opt('name', 'Bench')
const sampleIntervalMs = Number(opt('interval', '500')) || 500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const outDir = config.logDir
const outFile = path.join(outDir, `benchmark-${tag}.jsonl`)

async function runScenario (sc, run, ctx) {
  const { bot, ready } = createBody(username)
  await ready
  try {
    record('benchmark', { phase: 'setup', scenario: sc.id, run })
    for (const cmd of sc.setupCommands(ctx)) {
      consoleCommand(cmd)
      await sleep(commandDelayMs)
    }
    await sleep(1200) // world edits settle, chunks re-sync

    const tracker = createTracker(bot, { intervalMs: sampleIntervalMs })
    tracker.start()
    const t0 = Date.now()
    let result = null
    let timedOut = false
    try {
      result = await withTimeout(sc.run(bot, ctx), sc.timeoutMs, sc.id)
    } catch (err) {
      if (!/timed out/.test(err.message)) throw err
      timedOut = true
      await bot.collectBlock?.cancelTask?.().catch?.(() => {})
      bot.pathfinder.setGoal(null)
    }
    tracker.stop()
    const move = tracker.snapshot()
    const verdict = timedOut ? { success: false, reason: 'timeout' } : sc.evaluate(bot, result, ctx)
    // Leave no trace in the shared world: air-fill whatever the scenario built.
    for (const cmd of (sc.teardownCommands?.(ctx) || [])) {
      consoleCommand(cmd)
      await sleep(commandDelayMs)
    }
    const p = bot.entity.position
    return {
      scenario: sc.id,
      run,
      success: Boolean(verdict.success),
      reason: verdict.reason || null,
      timedOut,
      durationMs: Date.now() - t0,
      distance: move.distance,
      stuckMs: move.stuckMs,
      result,
      position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      t: new Date().toISOString()
    }
  } finally {
    bot.quit()
  }
}

async function main () {
  const ctx = makeContext(username)
  const ids = scenarioId ? [scenarioId] : Object.keys(SCENARIOS)
  for (const id of ids) {
    const sc = SCENARIOS[id]
    if (!sc) throw new Error(`Unknown scenario "${id}" (known: ${Object.keys(SCENARIOS).join(', ')})`)
    for (let run = 1; run <= repeats; run++) {
      const row = await runScenario(sc, run, ctx)
      fs.appendFileSync(outFile, JSON.stringify(row) + '\n')
      record('benchmark', { phase: 'result', ...row })
      console.log(`[${sc.id} #${run}] ${row.success ? 'PASS' : 'FAIL'}${row.timedOut ? ' (timeout)' : ''}` +
        ` ${row.durationMs}ms dist=${row.distance} stuck=${row.stuckMs}ms` +
        (row.reason ? ` — ${row.reason}` : ''))
      await sleep(1500)
    }
  }

  // Batch summary over this tag's accumulated history (previous runs included).
  const rows = fs.readFileSync(outFile, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  console.log(`\n=== benchmark summary (${path.basename(outFile)}, ${rows.length} runs) ===`)
  const byScenario = new Map()
  for (const r of rows) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, [])
    byScenario.get(r.scenario).push(r)
  }
  for (const [id, list] of byScenario) {
    const ok = list.filter(r => r.success)
    const median = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? null
    console.log(`${id.padEnd(16)} runs=${list.length} pass=${ok.length}` +
      ` rate=${Math.round(100 * ok.length / list.length)}%` +
      ` medDuration=${median(list.map(r => r.durationMs))}ms` +
      ` medDistance=${median(list.map(r => r.distance))}`)
  }
  process.exit(0)
}

main().catch(err => {
  record('error', { where: 'benchmark', message: err.stack || err.message })
  console.error(err)
  process.exit(1)
})
