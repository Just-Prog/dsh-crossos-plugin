#!/usr/bin/env node
'use strict'

/**
 * dsh-crossos 命令行。
 *
 * 插件负责"DSH 启动时自动迁移"；这个 CLI 负责在同一套逻辑上做
 * 手动检查与执行（例如首次安装后想先看看计划，或想在没有运行 DSH 时执行）。
 *
 *   node bin/crossos.cjs status            # 列出会话、cwd、归属与是否需要迁移
 *   node bin/crossos.cjs maps              # 打印解析后的映射表
 *   node bin/crossos.cjs plan              # 只打印迁移计划（dry-run）
 *   node bin/crossos.cjs apply             # 执行迁移（默认拒绝在 DSH 运行时执行）
 *   node bin/crossos.cjs apply --force     # 明知 DSH 在跑仍要执行
 *
 * 通用参数：--home PATH  --map "FROM=TO"（可重复）  --json
 */

const path = require('node:path')

const engine = require('../src/engine.cjs')
const { loadConfig, normalizeMaps, bidirectional } = require('../src/config.cjs')

function usage() {
  return `dsh-crossos — 双系统会话/工作区路径迁移

用法：
  crossos status [--json]                     列出会话与迁移状态
  crossos maps                                打印映射表（含反向）
  crossos plan [--json]                       打印迁移计划，不改动任何文件
  crossos apply [--force] [--keep-old]        执行迁移（默认 dry-run 关闭）

通用参数：
  --home PATH        指定 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
  --map FROM=TO      追加/覆盖一条路径映射（可重复）
  --json             以 JSON 输出
  --force            跳过"检测到运行中的 DSH"检查
`
}

function parseArgs(argv) {
  const args = { home: '', maps: [], json: false, force: false, keepOld: false, help: false, command: '' }
  const rest = [...argv]
  while (rest.length) {
    const a = rest.shift()
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--force') args.force = true
    else if (a === '--keep-old') args.keepOld = true
    else if (a === '--home') args.home = rest.shift() ?? ''
    else if (a.startsWith('--home=')) args.home = a.slice(7)
    else if (a === '--map') args.maps.push(rest.shift() ?? '')
    else if (a.startsWith('--map=')) args.maps.push(a.slice(6))
    else if (!args.command && !a.startsWith('-')) args.command = a
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== '') out[k] = v
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) {
    process.stdout.write(usage())
    return args.command ? 0 : args.help ? 0 : 1
  }

  const override = compact({ home: args.home, maps: args.maps.length ? args.maps : undefined })
  const { config, home, maps, notes } = loadConfig(override)
  if (args.keepOld) config.keepOld = true

  if (args.command === 'maps') {
    if (args.json) {
      process.stdout.write(JSON.stringify({ home, maps }, null, 2) + '\n')
      return 0
    }
    process.stdout.write(`DSH_HOME: ${home}\n`)
    if (!maps.length) process.stdout.write('（未配置任何映射）\n')
    for (const m of maps) process.stdout.write(`  ${m.from}  →  ${m.to}\n`)
    return 0
  }

  if (args.command === 'status') {
    const plan = engine.buildPlan({
      home,
      maps,
      adopt: false,
      requireTargetExists: config.requireTargetExists !== false,
      skipCollisions: config.skipCollision !== false,
      skipLive: true,
      onlyExistingWorkspacePaths: true,
    })
    const planned = new Map(plan.moves.map((m) => [m.session.id, m]))
    const wsFile = plan.wsFile
    const wsByPath = new Map()
    for (const [uuid, rec] of Object.entries(wsFile.data.tables.workspaces ?? {})) wsByPath.set(engine.norm(rec.path), { uuid, ...rec })
    const rows = plan.sessions.map((s) => {
      const m = planned.get(s.id)
      const owner = s.cwd ? wsByPath.get(engine.norm(s.cwd)) : undefined
      return {
        id: s.id,
        cwd: s.cwd,
        dir: path.relative(home, s.dir),
        workspace: owner ? owner.title || owner.uuid : null,
        action: m ? '迁移' : '保持',
        target: m ? m.targetCwd : undefined,
      }
    })
    if (args.json) {
      process.stdout.write(JSON.stringify({ home, maps, sessions: rows, warnings: plan.warnings }, null, 2) + '\n')
      return 0
    }
    process.stdout.write(`DSH_HOME: ${home}\n`)
    for (const note of notes) process.stdout.write(`注意：${note}\n`)
    process.stdout.write(`会话 ${rows.length} 个：\n\n`)
    for (const r of rows) {
      process.stdout.write(`  ${r.action}  ${r.id}\n`)
      process.stdout.write(`        cwd: ${r.cwd ?? '(无)'}\n`)
      if (r.target) process.stdout.write(`        目标: ${r.target}\n`)
      process.stdout.write(`        工作区: ${r.workspace ?? '(未分组)'}\n`)
    }
    if (plan.warnings.length) {
      process.stdout.write('\n警告：\n')
      for (const w of plan.warnings) process.stdout.write(`  - ${w}\n`)
    }
    return 0
  }

  if (args.command === 'plan' || args.command === 'apply') {
    if (!args.json) {
      for (const note of notes) process.stdout.write(`注意：${note}\n`)
      process.stdout.write(`DSH_HOME: ${home}\n`)
      for (const m of maps) process.stdout.write(`映射 ${m.from}  →  ${m.to}\n`)
      process.stdout.write('\n')
    }
    const dryRun = args.command === 'plan'
    const log = {
      info: (m) => process.stdout.write(`${m}\n`),
      warn: (m) => process.stderr.write(`警告：${m}\n`),
    }
    const summary = await pluginRun({ home, maps, config, log, dryRun, force: args.force })
    const report = require('../src/index.cjs').writeReport(home, summary)
    if (args.json) process.stdout.write(JSON.stringify({ ...summary, report }, null, 2) + '\n')
    else process.stdout.write(`\n完成：迁移 ${summary.done.length} 个会话${report ? `，报告 ${report}` : ''}\n`)
    return 0
  }

  process.stderr.write(`未知命令：${args.command}\n\n${usage()}`)
  return 1
}

/** 与插件共用同一执行路径（避免两套逻辑漂移） */
async function pluginRun({ home, maps, config, log, dryRun, force }) {
  return require('../src/index.cjs').runMigration({ home, maps, config, log, dryRun, force })
}

main()
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    process.stderr.write(`失败：${error && error.message}\n`)
    process.exitCode = 1
  })
