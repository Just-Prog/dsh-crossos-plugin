'use strict'

/**
 * dsh-crossos — Host 侧插件
 *
 * 单机双系统（Windows + Linux）场景：同一个项目在两套系统里的绝对路径不同
 * （`D:\Projects\…` 与 `/mnt/data/Projects/…`），而会话日志的 header、会话目录名
 * （projectKey）、`storages/workspace.json` 里的工作区记录都按 cwd 固化。
 * 本插件在 DSH 启动早期做三件事：
 *
 *   1. 扫描 sessions/ 下所有会话的 header cwd；
 *   2. 按可配置的路径映射，把"另一系统"的 cwd 改写成本机真实存在的路径，
 *      并把会话目录挪到本机 projectKey 下（只重压 header 所在的第一帧，
 *      其余字节原样保留，事件行逐字节不变）；
 *   3. 修正 workspace.json：记录路径按映射改写、同路径记录合并、
 *      迁移后的会话 id 归入对应工作区记录，重启后会话即出现在正确分组。
 *
 * 所有改动都有备份、dry-run 默认关闭但可开启、任何异常整体回滚。
 * 映射表不写死任何挂载点：来自 $DSH_HOME/crossos.json 或本插件在
 * cordis.patch.yml 里的 config.maps，且自动展开为双向，双系统共用一份配置。
 */

const fs = require('node:fs')
const path = require('node:path')

const engine = require('./engine.cjs')
const api = require('./api.cjs')
const { copyFromSources } = require('./import.cjs')
const { loadConfig } = require('./config.cjs')

const PLUGIN = 'dsh-crossos'

/** 输出到 DSH 日志；ctx.logger 不可用时退回 console */
function makeLogger(ctx) {
  const emit = (level, msg) => {
    const line = `${PLUGIN}: ${msg}`
    try {
      const fn = ctx && ctx.logger && ctx.logger[level]
      if (typeof fn === 'function') {
        fn.call(ctx.logger, line)
        return
      }
    } catch {}
    try {
      ;(level === 'warn' ? console.warn : console.info)(line)
    } catch {}
  }
  return { info: (m) => emit('info', m), warn: (m) => emit('warn', m) }
}

/** 把最近一次运行结果写到 <home>/crossos/last-run.json，便于事后核对 */
function writeReport(home, summary) {
  try {
    const dir = path.join(home, 'crossos')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'last-run.json')
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2) + '\n', { mode: 0o600 })
    return file
  } catch {
    return undefined
  }
}

/**
 * 扫描 + 规划 + 执行。
 * @returns {Promise<object>} 结构化结果（也用于 bin 打印）
 */
async function runMigration({ home, maps, config, log, dryRun, force }) {
  const summary = {
    home,
    scanned: 0,
    moves: 0,
    dryRun: dryRun === true,
    done: [],
    warnings: [],
    workspace: null,
    backupRoot: undefined,
    error: undefined,
    report: undefined,
  }

  const plan = engine.buildPlan({
    home,
    maps,
    adopt: config.adoptWorkspace !== false,
    requireTargetExists: config.requireTargetExists !== false,
    skipCollisions: config.skipCollision !== false,
    skipLive: config.skipLive !== false,
    onlyExistingWorkspacePaths: true,
  })
  summary.scanned = plan.sessions.length
  summary.moves = plan.moves.length
  summary.warnings = plan.warnings
  summary.workspace = plan.wsOps
  for (const w of plan.warnings) log.warn(w)

  if (!plan.moves.length) {
    log.info(`没有需要迁移的会话（共扫描 ${plan.sessions.length} 个）`)
    return summary
  }

  if (summary.dryRun) {
    for (const m of plan.moves) log.info(`[dry-run] ${m.session.id}  ${m.session.cwd}  →  ${m.targetCwd}`)
    for (const a of plan.wsOps.adoptions) log.info(`[dry-run] 会话 ${a.sessionId} 归入工作区 ${a.path}`)
    for (const r of plan.wsOps.pathRewrites) log.info(`[dry-run] 工作区路径 ${r.from}  →  ${r.to}`)
    return summary
  }

  const result = await engine.applyPlan(plan, { home, force: force === true, keepOld: config.keepOld === true })
  summary.done = result.done
  summary.backupRoot = result.backupRoot
  for (const d of result.done) log.info(`已迁移 ${d.id}  ${d.from}  →  ${d.to}`)
  if (result.backupRoot) log.info(`备份：${result.backupRoot}`)
  return summary
}

/**
 * 尽力把迁移后的会话补挂到工作区（磁盘上已经写好，这里是为了让当前进程
 * 的内存表也一致）。registry 已缓存旧 header 时会失败，属预期，重启即生效。
 */
function attachWorkspaces(ctx, done, log) {
  if (!ctx || typeof ctx.inject !== 'function' || !done.length) return
  try {
    ctx.inject(['workspaceRegistry'], ({ workspaceRegistry }) => {
      if (!workspaceRegistry) return
      void (async () => {
        for (const d of done) {
          try {
            let target = d.to
            try {
              target = fs.realpathSync(d.to)
            } catch {}
            const ws = await workspaceRegistry.resolveByPath(target)
            if (!ws) {
              log.info(`工作区记录尚未就绪（${target}），重启 DSH 后会话会出现在该分组`)
              continue
            }
            await ws.attachSession(d.id)
          } catch (error) {
            log.warn(`补挂工作区失败（重启后自动生效）：${error && error.message}`)
          }
        }
      })()
    })
  } catch (error) {
    log.warn(`workspaceRegistry 注入失败：${error && error.message}`)
  }
}

const plugin = {
  name: PLUGIN,

  apply(ctx, config = {}) {
    const log = makeLogger(ctx)
    let loaded
    try {
      loaded = loadConfig(config)
    } catch (error) {
      log.warn(`配置无效，跳过：${error.message}`)
      return
    }
    const { config: cfg, home, maps, mapsDeclared, notes } = loaded
    for (const note of notes) log.info(note)

    // 设置页 API 无论有没有映射都要注册：第一次安装时映射表就是空的，
    // 用户需要在 DSH 设置里把它填上（client/bundle.js 调这里）。
    try {
      ctx.inject(['webServer'], (scope) => {
        const webServer = scope && scope.webServer
        if (!webServer || typeof webServer.register !== 'function') return
        ctx.effect(
          () => webServer.register({ kind: 'prefix', path: api.API_PREFIX, handler: api.createHandler(ctx, config) }),
          `${PLUGIN}: 设置页 API`,
        )
      })
    } catch (error) {
      log.warn(`设置页 API 注册失败：${error && error.message}`)
    }

    if (!mapsDeclared.length) {
      log.info('maps 为空：不会自动迁移。请到 设置 → dsh-crossos 里填写路径映射')
      return
    }
    log.info(`已加载 ${mapsDeclared.length} 条路径映射，DSH_HOME=${home}`)

    if (cfg.auto === false) {
      log.info('auto=false：不在启动时自动迁移（可运行 node bin/crossos.cjs apply 手动执行）')
      return
    }

    ctx.effect(() => {
      void (async () => {
        try {
          // 先复制：把 sources 里"本机还没有"的会话搬进本机 sessions/，
          // 保持源 cwd 的目录名；随后的 rebase 会统一改写 header 并落位。
          const imported = copyFromSources({
            home,
            sources: cfg.sources,
            maps,
            config: cfg,
            log,
            dryRun: cfg.dryRun === true,
          })
          for (const warning of imported.warnings) log.warn(warning)
          if (imported.copied.length) {
            log.info(`从 ${imported.sources.length} 个源目录复制 ${imported.copied.filter((c) => c.copied).length} 个会话`)
          }

          // force 是必需的：迁移就在宿主进程内发生，dshProcesses(home) 必然
          // 认出"运行中的 DSH"（也就是我们自己的宿主）。真正的并发保护由
          // skipLive 完成——日志若被任何进程打开，该会话会被跳过。
          const summary = await runMigration({ home, maps, config: cfg, log, dryRun: cfg.dryRun === true, force: true })
          summary.imported = {
            copied: imported.copied.filter((c) => c.copied).length,
            skipped: imported.skipped.length,
            warnings: imported.warnings,
          }
          summary.report = writeReport(home, summary)
          if (summary.done.length) attachWorkspaces(ctx, summary.done, log)
        } catch (error) {
          log.warn(`迁移失败（已回滚，未改动任何会话）：${error && error.message}`)
        }
      })()
      return () => {}
    }, `${PLUGIN}: 启动迁移`)
  },
}

module.exports = plugin
module.exports.name = PLUGIN
module.exports.runMigration = runMigration
module.exports.writeReport = writeReport
