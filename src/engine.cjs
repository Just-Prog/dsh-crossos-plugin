/**
 * dsh-crossos — 让 DeepSeek Harness 会话跨操作系统/跨路径拼接可用。
 *
 * 背景：DSH 把「会话 ↔ 项目目录」的绑定硬编码在两处：
 *   1. 会话日志首行 header 里的 cwd（绝对路径，Windows 与 Linux 拼写不同）；
 *   2. $DSH_HOME/storages/workspace.json 里 workspace.path（同一条绝对路径）。
 * 换个系统直接拷 sessions/ 目录，header 里的 cwd 在本机不存在 → 会话落到"未分组"，
 * workspace 记录变成幽灵目录；反过来在 Windows 上则指向 D:\Projects\...。
 *
 * 本工具做的是「路径重定位（rebase）」而不是合并：
 *   - 把 header.cwd 按映射前缀改写（只重压第一帧，其余字节原样保留）；
 *   - 把会话目录搬到 sessions/<projectKey(新cwd)>/<encodeSegment(id)>/；
 *   - 同步修正 workspace.json 的 path、合并同一路径的重复记录、补登记会话；
 *   - 修正 session_projcache 缓存里的 cwd。
 *
 * 用法见 README.md。默认 dry-run，必须加 --apply 才会落盘。
 *
 * 无第三方依赖，需要 Node >= 22（用到 zlib zstd；Node 22.15+ / 24+ 自带）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const process = require("node:process");

/* ------------------------------------------------------------------ */
/* 常量（与 @deepseek-ai/dsh-session-persistence-jsonl 保持一致）        */
/* ------------------------------------------------------------------ */

const SESSION_FORMAT_VERSION = 4;
const LOG_BASENAME = "session";
const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const SUPPORTED_LOG_EXT = [".jsonl.zstd"]; // v4 默认；`.jsonl`（compression=none）另行处理
const MANIFEST_FORMAT = "dsh-crossos/1";
const SESSIONS_SUBDIR = "sessions";

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const ok = (msg) => console.log(`✓ ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const warn = (msg) => console.log(`! ${msg}`);

function parseArgs(argv) {
  const args = { _: [], map: [], session: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--map") args.map.push(argv[++i]);
    else if (a === "--session") args.session.push(argv[++i]);
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

/** 展开 ~，解析为绝对路径 */
function expand(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** DSH_HOME：--home > $DSH_HOME > ~/.dsh（与 dsh-home-paths 优先级一致） */
function resolveHome(args) {
  if (args.home) return expand(args.home);
  if (process.env.DSH_HOME) return expand(process.env.DSH_HOME);
  return path.join(os.homedir(), ".dsh");
}

/** 会话 id → 单个安全路径段（port 自 encodeSegment） */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 项目路径 → sessions/ 下的目录名（port 自 projectKey） */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

const isAbsoluteAny = (p) => typeof p === "string" && (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p));

/** 统一成比较用的形式：\ → /，去掉尾部分隔符，盘符小写 */
function norm(p) {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

/** 在映射表里找最长前缀匹配，返回改写后的路径（保持目标风格的分隔符） */
function mapPath(input, maps) {
  const p = norm(input);
  let best = null;
  for (const m of maps) {
    const from = norm(m.from);
    const isDrive = /^[A-Za-z]:$/.test(from);
    const cmpP = isDrive ? p.toLowerCase() : p;
    const cmpFrom = isDrive ? from.toLowerCase() : from;
    const hit = cmpP === cmpFrom || cmpP.startsWith(cmpFrom + "/");
    if (!hit) continue;
    if (best === null || from.length > best.from.length) best = { m, from, rest: p.slice(cmpFrom.length) };
  }
  if (!best) return undefined;
  const to = norm(best.m.to);
  const winTarget = /^[A-Za-z]:/.test(to);
  let out = to + best.rest;
  if (winTarget) out = out.replace(/\//g, "\\");
  return out;
}

/* ------------------------------------------------------------------ */
/* Zstandard 帧层                                                       */
/* ------------------------------------------------------------------ */

/** 解析完整帧边界（port 自 scanZstdFrames） */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
      throw new Error(`corrupt Zstandard frame: invalid magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard frame: reserved header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt Zstandard frame: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 明文日志（compression=none）——临时文件也按原名判断 */
const isPlainLog = (p) => /\.jsonl(\.tmp-\d+)?$/.test(p);

const zstdFrame = (bytes) => zlib.zstdCompressSync(bytes, CHECKSUM_OPTIONS);
const unzstdFrame = (bytes) => zlib.zstdDecompressSync(bytes);

/** 读取 artifacts（`.jsonl.zstd` 多帧 / `.jsonl` 明文）的完整明文 */
function readLogText(file) {
  const buf = fs.readFileSync(file);
  if (isPlainLog(file)) return { text: buf.toString("utf8"), file, buf, frames: null };
  const { frames, tornStart } = scanZstdFrames(buf);
  if (tornStart !== undefined) {
    throw new Error(`日志尾部有未完成的帧（torn tail @${tornStart}），拒绝改写：${file}（请先在 DSH 里正常关闭该会话）`);
  }
  let text = "";
  for (const f of frames) text += unzstdFrame(buf.subarray(f.start, f.end)).toString("utf8");
  return { text, file, buf, frames };
}

/**
 * 只重写第一行（header）的 cwd，其余内容与帧边界尽量保持原样。
 * 返回新文件的 Buffer。
 */
function rewriteHeaderCwd(file, newCwd) {
  const { text, buf, frames } = readLogText(file);
  const lines = text.split("\n");
  const header = JSON.parse(lines[0]);
  if (header.type !== "session" || typeof header.id !== "string") throw new Error(`不是会话 header：${file}`);
  header.cwd = newCwd;
  const newHeaderLine = JSON.stringify(header);

  if (!isPlainLog(file)) {
    // 快路径：第一帧正好只装 header 行（DSH 的正常布局）
    const firstFrameText = unzstdFrame(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
    if (firstFrameText === lines[0] + "\n" || firstFrameText === lines[0]) {
      const head = Buffer.concat([zstdFrame(Buffer.from(newHeaderLine + "\n", "utf8"))]);
      return { buffer: Buffer.concat([head, buf.subarray(frames[0].end)]), header, changedFrames: 1 };
    }
  } else {
    const plain = newHeaderLine + text.slice(lines[0].length);
    return { buffer: Buffer.from(plain, "utf8"), header, changedFrames: 0 };
  }

  // 慢路径：header 与事件混在同一帧 → 按行边界重新分帧
  const rest = text.slice(lines[0].length + 1); // 跳过原 header 行
  const chunks = [];
  let cursor = 0;
  while (cursor < rest.length) {
    let end = Math.min(cursor + (1 << 20), rest.length);
    if (end < rest.length) {
      const nl = rest.lastIndexOf("\n", end);
      if (nl > cursor) end = nl + 1;
    }
    chunks.push(Buffer.from(rest.slice(cursor, end), "utf8"));
    cursor = end;
  }
  const parts = [zstdFrame(Buffer.from(newHeaderLine + "\n", "utf8")), ...chunks.map(zstdFrame)];
  return { buffer: Buffer.concat(parts), header, changedFrames: chunks.length + 1 };
}

/** 读 header（只解到第一个换行为止，快） */
function readHeader(file) {
  const buf = fs.readFileSync(file);
  if (isPlainLog(file)) {
    const nl = buf.indexOf(10);
    return JSON.parse(buf.subarray(0, nl === -1 ? buf.length : nl).toString("utf8"));
  }
  const { frames } = scanZstdFrames(buf, 8);
  let text = "";
  for (const f of frames) {
    text += unzstdFrame(buf.subarray(f.start, f.end)).toString("utf8");
    const nl = text.indexOf("\n");
    if (nl !== -1) return JSON.parse(text.slice(0, nl));
  }
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ */
/* 会话/工作区读取                                                       */
/* ------------------------------------------------------------------ */

function sessionsRoot(home) {
  return path.join(home, SESSIONS_SUBDIR);
}

function logFileName(compression) {
  return `${LOG_BASENAME}.v${SESSION_FORMAT_VERSION}.jsonl${compression === "none" ? "" : ".zstd"}`;
}

/** 枚举 sessions/<projectKey>/<encodedId>/<log> */
function scanSessions(home, warnings) {
  const root = sessionsRoot(home);
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const projEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue;
    const projDir = path.join(root, projEntry.name);
    for (const sessEntry of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!sessEntry.isDirectory()) continue;
      const dir = path.join(projDir, sessEntry.name);
      const files = fs.readdirSync(dir);
      const logName = files.find((f) => /^session\.v4\.jsonl(\.zstd)?$/.test(f));
      if (!logName) continue;
      const file = path.join(dir, logName);
      let header;
      try {
        header = readHeader(file);
      } catch (error) {
        warnings.push(`${file}: 无法解析 header（${error.message}），已跳过`);
        continue;
      }
      if (header.type !== "session" || !header.id) {
        warnings.push(`${file}: header 缺少 id，已跳过`);
        continue;
      }
      out.push({
        id: header.id,
        header,
        cwd: typeof header.cwd === "string" ? header.cwd : undefined,
        dir,
        file,
        logName,
        projectKey: projEntry.name,
        sizeBytes: fs.statSync(file).size,
        livePids: liveHolders(file),
        hasLock: files.includes("session.lock"),
      });
    }
  }
  return out;
}

function loadWorkspaceFile(home) {
  const file = path.join(home, "storages", "workspace.json");
  if (!fs.existsSync(file)) return { file, exists: false, data: { unit: { name: "workspace", version: 2 }, global: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } } };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.tables ??= { workspaces: {} };
  data.tables.workspaces ??= {};
  data.global ??= {};
  data.global.workspaceIds ??= [];
  data.global.archivedSessionIds ??= [];
  data.global.pinnedSessionIds ??= [];
  return { file, exists: true, data };
}

/* ------------------------------------------------------------------ */
/* 运行中检测（只读 /proc，Linux）                                       */
/* ------------------------------------------------------------------ */

/** 从 /proc/<pid>/environ 读 DSH_HOME（读不到返回 null） */
function envHomeOf(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const kv of raw.split("\0")) {
      if (kv.startsWith("DSH_HOME=")) return kv.slice("DSH_HOME=".length);
    }
    return "";
  } catch {
    return null;
  }
}

/** 哪些进程打开了这个文件。非 Linux 返回 []。 */
function liveHolders(target) {
  if (process.platform !== "linux") return [];
  const hits = [];
  let pids;
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const pid of pids) {
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (link === target) {
        hits.push(Number(pid));
        break;
      }
    }
  }
  return hits;
}

/**
 * 正在使用这个 DSH_HOME 的 DSH 进程。只认真正的 DSH 入口
 * （`@deepseek-ai/dsh`、`dsh web|desktop|tui`、`bin/dsh`），
 * 避免把命令行里碰巧带 "dsh" 字样的 shell 误判。
 * 注意：在 bwrap/容器里 /proc 是隔离的，看不到宿主上的 DSH，
 * 这种环境下只能靠用户自己确认。
 */
function dshProcesses(home) {
  if (process.platform !== "linux") return [];
  const defaultHome = path.join(os.homedir(), ".dsh");
  const isDefaultHome = path.resolve(home) === path.resolve(defaultHome);
  const out = [];
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      continue;
    }
    if (!cmd) continue;
    const looksDsh = /@deepseek-ai\/dsh\b/.test(cmd) || /\bdsh\s+(web|desktop|tui)\b/.test(cmd) || /(^|\s)\S*\/bin\/dsh(\s|$)/.test(cmd);
    if (!looksDsh) continue;
    const envHome = envHomeOf(pid);
    const homeMatches =
      envHome === null || envHome === "" ? isDefaultHome : path.resolve(expand(envHome)) === path.resolve(home);
    if (!homeMatches) continue;
    out.push({ pid: Number(pid), cmd });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 计划构建                                                             */
/* ------------------------------------------------------------------ */

function basenameTitle(p) {
  const n = norm(p);
  const base = n.split("/").filter(Boolean).pop();
  return base || "workspace";
}

/**
 * 生成整体计划。
 * options: { home, maps, adopt, onlySessionIds }
 */
function buildPlan({ home, maps, adopt = true, onlySessionIds = null, requireTargetExists = false, skipCollisions = false, skipLive = false, onlyExistingWorkspacePaths = false }) {
  const warnings = [];
  const sessions = scanSessions(home, warnings).filter((s) => !onlySessionIds || onlySessionIds.has(s.id));
  const wsFile = loadWorkspaceFile(home);
  const workspaces = wsFile.data.tables.workspaces;
  const root = sessionsRoot(home);

  /** 目标 cwd：能映射就映射，否则保持原样 */
  const desiredCwd = (s) => (s.cwd ? mapPath(s.cwd, maps) ?? s.cwd : undefined);

  const moves = [];
  for (const s of sessions) {
    const targetCwd = desiredCwd(s);
    if (!targetCwd) {
      warnings.push(`${s.id}: header 没有 cwd（_no-cwd），跳过`);
      continue;
    }
    if (!isAbsoluteAny(targetCwd)) {
      warnings.push(`${s.id}: 目标路径不是绝对路径（${targetCwd}），跳过`);
      continue;
    }
    if (skipLive && s.livePids && s.livePids.length > 0) {
      warnings.push(`${s.id}: 日志正被进程 ${s.livePids.join(", ")} 打开，跳过`);
      continue;
    }
    const targetDir = path.join(root, projectKey(targetCwd), encodeSegment(s.id));
    const targetFile = path.join(targetDir, s.logName);
    if (path.resolve(targetDir) === path.resolve(s.dir) && targetCwd === s.cwd) continue; // 无需处理
    const collision = fs.existsSync(targetDir);
    if (requireTargetExists && !fs.existsSync(targetCwd)) {
      // 双向映射会为"已经在本机的那一侧"生成一个本机不存在的反向目标；
      // 原 cwd 存在就说明这条分支只是反方向，静默跳过即可。
      if (!(s.cwd && fs.existsSync(s.cwd))) warnings.push(`${s.id}: 目标目录不存在（${targetCwd}），跳过`);
      continue;
    }
    if (skipCollisions && collision && !listSessionDirs(targetDir).includes(s.id)) {
      warnings.push(`${s.id}: 目标目录已被另一个会话占用（${targetDir}），跳过`);
      continue;
    }
    moves.push({
      session: s,
      targetCwd,
      targetDir,
      targetFile,
      collision,
      cwdChanged: targetCwd !== s.cwd,
    });
  }

  /* ---- workspace.json 变更 ---- */
  const wsOps = { pathRewrites: [], merges: [], adoptions: [], created: [], removed: [] };
  const now = new Date().toISOString();
  const newWorkspaces = {}; // uuid -> record（深拷贝后改写）
  for (const [uuid, rec] of Object.entries(workspaces)) {
    const mappedPath = mapPath(rec.path, maps);
    const newPath = mappedPath !== undefined && (!onlyExistingWorkspacePaths || fs.existsSync(mappedPath)) ? mappedPath : rec.path;
    const copy = { ...rec, sessionIds: [...(rec.sessionIds ?? [])] };
    if (newPath !== rec.path) {
      wsOps.pathRewrites.push({ uuid, from: rec.path, to: newPath });
      copy.path = newPath;
      copy.updatedAt = now;
    }
    newWorkspaces[uuid] = copy;
  }

  // 同一新路径的重复记录合并
  const byPath = new Map();
  for (const [uuid, rec] of Object.entries(newWorkspaces)) {
    const key = norm(rec.path);
    const existing = byPath.get(key);
    if (!existing) byPath.set(key, uuid);
    else {
      const keep = new Date(newWorkspaces[existing].createdAt ?? 0) <= new Date(rec.createdAt ?? 0) ? existing : uuid;
      const drop = keep === existing ? uuid : existing;
      const a = newWorkspaces[keep];
      const b = newWorkspaces[drop];
      a.sessionIds = [...new Set([...(a.sessionIds ?? []), ...(b.sessionIds ?? [])])];
      a.title = a.title || b.title;
      a.createdAt = new Date(a.createdAt ?? 0) <= new Date(b.createdAt ?? 0) ? a.createdAt : b.createdAt;
      a.updatedAt = a.updatedAt && new Date(a.updatedAt) >= new Date(b.updatedAt ?? 0) ? a.updatedAt : b.updatedAt;
      delete newWorkspaces[drop];
      byPath.set(key, keep);
      wsOps.merges.push({ kept: keep, dropped: drop, path: a.path });
      wsOps.removed.push(drop);
    }
  }

  // 让每个需要搬迁的会话落到其 cwd 对应的 workspace 记录里
  if (adopt) {
    const touchedSessionIds = new Set(moves.map((m) => m.session.id));
    for (const m of moves) {
      if (!touchedSessionIds.has(m.session.id)) continue;
      const key = norm(m.targetCwd);
      let uuid = byPath.get(key);
      if (!uuid) {
        uuid = crypto.randomUUID();
        newWorkspaces[uuid] = {
          path: m.targetCwd,
          title: basenameTitle(m.targetCwd),
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        };
        byPath.set(key, uuid);
        wsOps.created.push({ uuid, path: m.targetCwd });
      }
      for (const [otherUuid, rec] of Object.entries(newWorkspaces)) {
        if (otherUuid === uuid) continue;
        if (rec.sessionIds?.includes(m.session.id)) {
          rec.sessionIds = rec.sessionIds.filter((id) => id !== m.session.id);
          rec.updatedAt = now;
        }
      }
      const rec = newWorkspaces[uuid];
      if (!rec.sessionIds.includes(m.session.id)) {
        rec.sessionIds.push(m.session.id);
        rec.updatedAt = now;
        wsOps.adoptions.push({ uuid, sessionId: m.session.id, path: rec.path });
      }
    }
  }

  /* ---- 组装新的 global ---- */
  const global = { ...wsFile.data.global };
  const ordered = [];
  for (const id of wsFile.data.global.workspaceIds ?? []) {
    if (newWorkspaces[id] && !ordered.includes(id)) ordered.push(id);
  }
  for (const id of Object.keys(newWorkspaces)) if (!ordered.includes(id)) ordered.push(id);
  global.workspaceIds = ordered;
  if (!newWorkspaces[global.defaultWorkspaceId]) global.defaultWorkspaceId = ordered[0];

  const newData = {
    ...wsFile.data,
    global,
    tables: { ...wsFile.data.tables, workspaces: newWorkspaces },
  };

  const wsChanged = JSON.stringify(newData) !== JSON.stringify(wsFile.data);

  /* ---- 校验：目标目录是否存在 ---- */
  for (const m of moves) {
    if (!fs.existsSync(m.targetCwd)) {
      warnings.push(`目标目录在本机不存在：${m.targetCwd}（会话仍会迁移，但在 DSH 里会显示为"缺失目录/未分组"）`);
    }
    if (m.collision) {
      const sameId = listSessionDirs(m.targetDir).includes(m.session.id);
      m.collisionSameSession = sameId;
    }
  }

  return { home, sessions, moves, wsFile, newData, wsChanged, wsOps, warnings, maps };
}

function listSessionDirs(dir) {
  const ids = [];
  if (!fs.existsSync(dir)) return ids;
  try {
    const log = fs.readdirSync(dir).find((f) => /^session\.v4\.jsonl(\.zstd)?$/.test(f));
    if (log) ids.push(readHeader(path.join(dir, log)).id);
  } catch {
    /* ignore */
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* 执行                                                                 */
/* ------------------------------------------------------------------ */

async function applyPlan(plan, { home, force, keepOld }) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(home, "backups", "dsh-crossos", ts);
  const undo = [];
  const done = [];

  const running = dshProcesses(home);
  if (running.length > 0 && !force) {
    die(
      `检测到正在运行的 DSH 进程（PID ${running.map((r) => r.pid).join(", ")}）。\n` +
        `  workspace.json 与 sessions/ 由运行中的实例持有，改写会被内存表覆盖。\n` +
        `  请先完全退出 DSH（含桌面端/Web 服务），再重新执行；确认无写入风险可加 --force。`
    );
  }
  for (const m of plan.moves) {
    if (m.session.livePids.length > 0) {
      die(`会话 ${m.session.id} 的日志正被进程 ${m.session.livePids.join(", ")} 打开，先关闭它再迁移。`);
    }
  }

  fs.mkdirSync(backupRoot, { recursive: true });

  /** 备份一个文件到备份目录，登记 undo */
  const backupFile = (file) => {
    const rel = path.relative(home, file);
    const dest = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    undo.push({ type: "file", path: file, backup: dest });
    return dest;
  };

  try {
    // 1) workspace.json 先备份（若会改写）
    if (plan.wsChanged && plan.wsFile.exists) backupFile(plan.wsFile.file);

    // 2) 逐个迁移会话
    for (const m of plan.moves) {
      const s = m.session;
      if (m.collision && !m.collisionSameSession) {
        throw new Error(`目标已存在另一个会话目录：${m.targetDir}（若确认覆盖请先手工移走）`);
      }
      fs.mkdirSync(m.targetDir, { recursive: true });
      const tmpFile = `${m.targetFile}.tmp-${process.pid}`;
      const { buffer, header } = rewriteHeaderCwd(s.file, m.targetCwd);
      const mode = fs.statSync(s.file).mode & 0o777;
      fs.writeFileSync(tmpFile, buffer, { mode });
      // 校验：id 不变、行数不变、除 header 外的明文逐字节一致
      verifyRewrite(s.file, tmpFile, header);

      // 复制同目录下的其它文件（活会话已排除，正常只有日志）
      for (const entry of fs.readdirSync(s.dir)) {
        if (entry === s.logName || entry.includes(".tmp-" + process.pid)) continue;
        fs.copyFileSync(path.join(s.dir, entry), path.join(m.targetDir, entry));
      }
      fs.renameSync(tmpFile, m.targetFile);
      undo.push({ type: "createdFile", path: m.targetFile });

      // 3) 旧目录：移入备份（可回滚），或按 --keep-old 改名保留
      const oldDirBackup = path.join(backupRoot, "old-dirs", path.basename(s.dir) + "-" + done.length);
      fs.mkdirSync(path.dirname(oldDirBackup), { recursive: true });
      if (keepOld) {
        const renamed = path.join(path.dirname(s.dir), path.basename(s.dir) + ".migrated");
        fs.renameSync(s.dir, renamed);
        undo.push({ type: "renamedDir", from: s.dir, to: renamed });
      } else {
        fs.renameSync(s.dir, oldDirBackup);
        undo.push({ type: "movedOldDir", from: oldDirBackup, to: s.dir });
      }
      done.push({ id: s.id, from: s.cwd, to: m.targetCwd, dir: m.targetDir, bytes: buffer.length });
      info(`${s.id}  ${s.cwd}  →  ${m.targetCwd}`);
    }

    // 3.5) 旧 projectKey 目录已空则一并清掉，避免 sessions/ 下留空壳
    for (const dir of new Set(plan.moves.map((m) => path.dirname(m.session.dir)))) {
      try { fs.rmdirSync(dir) } catch {}
    }

    // 4) 修正 projcache 里对应会话的 cwd（保留标题等投影数据）
    for (const d of done) patchProjcache(home, d.id, d.to, undo);

    // 5) 写入 workspace.json（原子：tmp + rename）
    if (plan.wsChanged) {
      fs.mkdirSync(path.dirname(plan.wsFile.file), { recursive: true });
      const tmp = plan.wsFile.file + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(plan.newData, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, plan.wsFile.file);
    }
    return { done, backupRoot };
  } catch (error) {
    console.error(`\n✗ 执行失败：${error.message}\n  开始回滚……`);
    for (const u of undo.reverse()) {
      try {
        if (u.type === "file") fs.copyFileSync(u.backup, u.path);
        else if (u.type === "createdFile") fs.rmSync(u.path, { force: true });
        else if (u.type === "movedOldDir") {
          fs.mkdirSync(path.dirname(u.to), { recursive: true });
          if (fs.existsSync(u.to)) fs.rmSync(u.to, { recursive: true, force: true });
          fs.renameSync(u.from, u.to);
        } else if (u.type === "renamedDir") {
          if (fs.existsSync(u.to)) fs.renameSync(u.to, u.from);
        }
      } catch (rollbackError) {
        console.error(`  回滚 ${u.path} 失败：${rollbackError.message}`);
      }
    }
    throw error;
  }
}

function verifyRewrite(originalFile, newFile, header) {
  const before = readLogText(originalFile);
  const after = readLogText(newFile);
  const beforeLines = before.text.split("\n");
  const afterLines = after.text.split("\n");
  if (beforeLines.length !== afterLines.length) throw new Error(`改写后行数变化（${beforeLines.length} → ${afterLines.length}）`);
  const beforeHeader = JSON.parse(beforeLines[0]);
  const afterHeader = JSON.parse(afterLines[0]);
  if (afterHeader.id !== beforeHeader.id) throw new Error("改写后会话 id 变了");
  if (afterHeader.cwd !== header.cwd) throw new Error("改写后 cwd 未生效");
  const tailBefore = beforeLines.slice(1).join("\n");
  const tailAfter = afterLines.slice(1).join("\n");
  if (crypto.createHash("sha256").update(tailBefore).digest("hex") !== crypto.createHash("sha256").update(tailAfter).digest("hex"))
    throw new Error("改写后事件内容发生变化（除 header 外的行不一致）");
}

function patchProjcache(home, sessionId, newCwd, undo) {
  const file = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
  if (!fs.existsSync(file)) return false;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data.record?.identity || data.record.identity.cwd === newCwd) return false;
  const dest = file + ".bak-dsh-crossos";
  fs.copyFileSync(file, dest);
  undo.push({ type: "file", path: file, backup: dest });
  data.record.identity.cwd = newCwd;
  fs.writeFileSync(file + ".tmp-" + process.pid, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(file + ".tmp-" + process.pid, file);
  return true;
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入                                                          */
/* ------------------------------------------------------------------ */

function exportStore({ home, out, onlyIds, projectFilter }) {
  const warnings = [];
  const sessions = scanSessions(home, warnings).filter((s) => {
    if (onlyIds && !onlyIds.has(s.id)) return false;
    if (projectFilter && !(s.cwd ?? "").includes(projectFilter)) return false;
    return true;
  });
  if (sessions.length === 0) die("没有匹配的会话可导出");
  const ws = loadWorkspaceFile(home).data.tables.workspaces;
  const wsByPath = new Map(Object.entries(ws).map(([uuid, r]) => [norm(r.path), { uuid, ...r }]));
  const wsBySession = new Map();
  for (const [uuid, r] of Object.entries(ws)) for (const id of r.sessionIds ?? []) wsBySession.set(id, { uuid, ...r });

  fs.mkdirSync(path.join(out, "sessions"), { recursive: true });
  const manifest = { format: MANIFEST_FORMAT, exportedAt: new Date().toISOString(), source: { home, platform: process.platform }, workspaces: [], sessions: [] };
  for (const s of sessions) {
    const dir = path.join(out, "sessions", encodeSegment(s.id));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, s.logName);
    fs.copyFileSync(s.file, dest);
    const w = wsBySession.get(s.id) ?? (s.cwd ? wsByPath.get(norm(s.cwd)) : undefined);
    manifest.sessions.push({
      id: s.id,
      cwd: s.cwd,
      header: s.header,
      file: s.logName,
      size: fs.statSync(dest).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex"),
      live: false,
      workspace: w ? { uuid: w.uuid, path: w.path, title: w.title } : undefined,
    });
    if (w && !manifest.workspaces.some((x) => x.uuid === w.uuid)) manifest.workspaces.push({ uuid: w.uuid, path: w.path, title: w.title });
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, out, warnings };
}

function importStore({ home, from, maps, adopt = true }) {
  const manifestFile = path.join(from, "manifest.json");
  if (!fs.existsSync(manifestFile)) die(`${from} 下没有 manifest.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!manifest.format?.startsWith("dsh-crossos/")) die(`不认识的 manifest 格式：${manifest.format}`);
  const warnings = [];
  const existing = new Map(scanSessions(home, warnings).map((s) => [s.id, s]));
  const wsFile = loadWorkspaceFile(home);
  const root = sessionsRoot(home);
  const now = new Date().toISOString();
  const plan = { copies: [], skipped: [], warnings };

  for (const entry of manifest.sessions) {
    if (existing.has(entry.id)) {
      plan.skipped.push({ id: entry.id, reason: "本机已存在同 id 会话" });
      continue;
    }
    const src = path.join(from, "sessions", encodeSegment(entry.id), entry.file ?? "session.v4.jsonl.zstd");
    if (!fs.existsSync(src)) {
      warnings.push(`${entry.id}: 源文件缺失 ${src}`);
      continue;
    }
    const srcCwd = entry.cwd ?? entry.header?.cwd;
    let targetCwd = srcCwd ? mapPath(srcCwd, maps) ?? srcCwd : undefined;
    if (!targetCwd) {
      warnings.push(`${entry.id}: 没有 cwd，跳过`);
      continue;
    }
    if (!isAbsoluteAny(targetCwd)) {
      warnings.push(`${entry.id}: 映射结果不是绝对路径（${targetCwd}），跳过`);
      continue;
    }
    const targetDir = path.join(root, projectKey(targetCwd), encodeSegment(entry.id));
    plan.copies.push({ entry, src, targetCwd, targetDir, targetFile: path.join(targetDir, path.basename(src)) });
  }

  // workspace 映射与合并
  const newWorkspaces = JSON.parse(JSON.stringify(wsFile.data.tables.workspaces));
  const byPath = new Map(Object.entries(newWorkspaces).map(([uuid, r]) => [norm(r.path), uuid]));
  const wsOps = { created: [], merges: [], adopted: [] };
  const mapWorkspacePath = (p) => mapPath(p, maps) ?? p;

  for (const c of plan.copies) {
    const wsEntry = c.entry.workspace;
    const wsPath = wsEntry ? mapWorkspacePath(wsEntry.path) : c.targetCwd;
    let uuid = byPath.get(norm(wsPath));
    if (!uuid) {
      uuid = crypto.randomUUID();
      newWorkspaces[uuid] = { path: wsPath, title: basenameTitle(wsPath), sessionIds: [], createdAt: now, updatedAt: now };
      byPath.set(norm(wsPath), uuid);
      wsOps.created.push({ uuid, path: wsPath });
    } else {
      // 同一个 workspace 在两个系统上 UUID 不同：按路径合并
      const rec = newWorkspaces[uuid];
      if (wsEntry && wsEntry.uuid !== uuid && newWorkspaces[wsEntry.uuid]) {
        const other = newWorkspaces[wsEntry.uuid];
        rec.sessionIds = [...new Set([...(rec.sessionIds ?? []), ...(other.sessionIds ?? [])])];
        rec.title = rec.title || other.title;
        delete newWorkspaces[wsEntry.uuid];
        wsOps.merges.push({ kept: uuid, dropped: wsEntry.uuid, path: rec.path });
      }
    }
    c.workspaceUuid = uuid;
    const rec = newWorkspaces[uuid];
    if (!rec.sessionIds.includes(c.entry.id)) {
      rec.sessionIds.push(c.entry.id);
      rec.updatedAt = now;
      wsOps.adopted.push({ uuid, sessionId: c.entry.id });
    }
  }

  return { manifest, plan, newWorkspaces, wsFile, wsOps, warnings };
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

function fmtSize(n) {
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + "M";
  if (n > 1 << 10) return (n / (1 << 10)).toFixed(1) + "K";
  return n + "B";
}

function cmdList(args, home) {
  const warnings = [];
  const sessions = scanSessions(home, warnings).sort((a, b) => a.cwd?.localeCompare(b.cwd ?? "") ?? 0);
  const ws = loadWorkspaceFile(home).data.tables.workspaces;
  const owner = new Map();
  for (const [uuid, r] of Object.entries(ws)) for (const id of r.sessionIds ?? []) owner.set(id, { uuid, ...r });
  const byPath = new Map(Object.entries(ws).map(([uuid, r]) => [norm(r.path), { uuid, ...r }]));

  if (args.json) {
    console.log(JSON.stringify(sessions.map((s) => ({ id: s.id, cwd: s.cwd, dir: s.dir, size: s.sizeBytes, workspace: owner.get(s.id) ?? (s.cwd ? byPath.get(norm(s.cwd)) : undefined) ?? null, live: s.livePids.length > 0 })), null, 2));
    return;
  }

  console.log(`DSH_HOME = ${home}`);
  console.log(`会话数：${sessions.length}\n`);
  for (const s of sessions) {
    const w = owner.get(s.id) ?? (s.cwd ? byPath.get(norm(s.cwd)) : undefined);
    const exists = s.cwd ? fs.existsSync(s.cwd) : false;
    console.log(`${s.id}`);
    console.log(`  cwd        ${s.cwd ?? "(无)"} ${exists ? "" : " ← 本机不存在"}`);
    console.log(`  归属       ${w ? `${w.title} (${w.uuid})` : "未分组（不在任何 workspace.sessionIds 里）"}`);
    console.log(`  目录       ${s.dir}`);
    console.log(`  大小/状态  ${fmtSize(s.sizeBytes)}${s.livePids.length ? ` · 运行中 pid ${s.livePids.join(",")}` : ""}${s.hasLock ? " · 有 session.lock" : ""}`);
    console.log();
  }
  for (const w of warnings) warn(w);
}

async function cmdRebase(args, home) {
  const maps = parseMaps(args.map);
  if (maps.length === 0) die("至少给一个 --map 'D:\\=/mnt/data' 形式的映射");
  const only = args.session?.length ? new Set(args.session) : null;
  const running = dshProcesses(home);
  const plan = buildPlan({ home, maps, adopt: args["no-adopt"] !== true, onlySessionIds: only });

  console.log(`DSH_HOME = ${home}`);
  console.log(`映射：${maps.map((m) => `${m.from} → ${m.to}`).join("   ")}\n`);

  if (plan.moves.length === 0) ok("所有会话的 cwd 与所在目录都已就位，无需迁移");
  else {
    console.log(`待迁移 ${plan.moves.length} 个会话：`);
    for (const m of plan.moves) {
      console.log(`  ${m.session.id}`);
      console.log(`    cwd    ${m.session.cwd} → ${m.targetCwd}${m.cwdChanged ? "" : "（cwd 不变，仅挪目录）"}`);
      console.log(`    目录   ${m.session.dir}`);
      console.log(`        →  ${m.targetDir}${m.collision ? (m.collisionSameSession ? "  (目标已有同一会话，将合并)" : "  ⚠ 目标已存在其它会话") : ""}`);
    }
    console.log();
  }

  const ops = plan.wsOps;
  if (plan.wsChanged) {
    console.log("workspace.json 变更：");
    for (const r of ops.pathRewrites) console.log(`  路径改写 ${r.from}\n        →  ${r.to}`);
    for (const m of ops.merges) console.log(`  合并重复记录 ${m.dropped} → ${m.kept}  (${m.path})`);
    for (const c of ops.created) console.log(`  新建 workspace ${c.uuid}  (${c.path})`);
    for (const a of ops.adoptions) console.log(`  归位会话 ${a.sessionId} → ${a.path}`);
    console.log();
  } else console.log("workspace.json 无需变更\n");

  for (const w of plan.warnings) warn(w);
  if (running.length > 0) warn(`检测到正在使用 ${home} 的 DSH 进程（PID ${running.map((r) => r.pid).join(", ")}）：--apply 前请完全退出它，否则 workspace.json 会被内存表覆盖。`);

  if (!args.apply) {
    console.log("\n（dry-run）加 --apply 执行。执行前请完全退出 DSH。");
    return;
  }
  const { done, backupRoot } = await applyPlan(plan, { home, force: args.force === true, keepOld: args["keep-old"] === true });
  ok(`完成：迁移 ${done.length} 个会话，备份与旧目录在 ${backupRoot}`);
  console.log("重启 DSH 后即可在对应工作区看到这些会话（workspace.json 已同步改写）。");
}

function parseMaps(list) {
  return (list ?? []).map((raw) => {
    const idx = raw.indexOf("=");
    if (idx <= 0) die(`--map 需要 FROM=TO 形式，收到：${raw}`);
    const from = raw.slice(0, idx);
    const to = raw.slice(idx + 1);
    if (!from || !to) die(`--map 需要 FROM=TO 形式，收到：${raw}`);
    return { from: norm(from), to: norm(to) };
  });
}

function cmdExport(args, home) {
  const out = expand(args.out ?? path.join(home, "port-store"));
  const only = args.session?.length ? new Set(args.session) : null;
  const { manifest, warnings } = exportStore({ home, out, onlyIds: only, projectFilter: args.project });
  ok(`已导出 ${manifest.sessions.length} 个会话 → ${out}`);
  info(`清单：${path.join(out, "manifest.json")}`);
  for (const w of warnings) warn(w);
  console.log("\n把整个目录拷到另一台系统，然后：\n  dsh-crossos import <该目录> --map '/mnt/data=D:\\' --apply");
}

function cmdImport(args, home) {
  const from = expand(args._[1] ?? "");
  if (!from || !fs.existsSync(from)) die("用法：dsh-crossos import <导出目录> --map ... [--apply]");
  const maps = parseMaps(args.map);
  const { plan, newWorkspaces, wsFile, wsOps, warnings } = importStore({ home, from, maps, adopt: args["no-adopt"] !== true });

  console.log(`DSH_HOME = ${home}`);
  if (plan.copies.length === 0) ok("没有需要导入的会话（本机已有，或全部被跳过）");
  for (const c of plan.copies) {
    console.log(`  ${c.entry.id}`);
    console.log(`    cwd    ${c.entry.cwd} → ${c.targetCwd}`);
    console.log(`    → ${c.targetDir}`);
  }
  for (const s of plan.skipped) info(`跳过 ${s.id}：${s.reason}`);
  for (const w of warnings) warn(w);
  for (const c of wsOps.created) console.log(`  新建 workspace ${c.uuid}  (${c.path})`);
  for (const m of wsOps.merges) console.log(`  合并 workspace ${m.dropped} → ${m.kept}  (${m.path})`);

  if (!args.apply) {
    console.log("\n（dry-run）加 --apply 执行。执行前请完全退出 DSH。");
    return;
  }
  const running = dshProcesses(home);
  if (running.length && !args.force) die(`检测到运行中的 DSH（PID ${running.map((r) => r.pid).join(", ")}），请先退出，或加 --force。`);

  const backupRoot = path.join(home, "backups", "dsh-crossos", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(backupRoot, { recursive: true });
  if (wsFile.exists) {
    fs.mkdirSync(path.join(backupRoot, "storages"), { recursive: true });
    fs.copyFileSync(wsFile.file, path.join(backupRoot, "storages", "workspace.json"));
  }
  let n = 0;
  for (const c of plan.copies) {
    fs.mkdirSync(c.targetDir, { recursive: true });
    const { buffer } = rewriteHeaderCwd(c.src, c.targetCwd);
    const tmp = c.targetFile + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, buffer);
    verifyRewrite(c.src, tmp, { ...c.entry.header, cwd: c.targetCwd });
    fs.renameSync(tmp, c.targetFile);
    n++;
  }
  const orderedIds = [];
  for (const id of wsFile.data.global.workspaceIds ?? []) if (newWorkspaces[id] && !orderedIds.includes(id)) orderedIds.push(id);
  for (const id of Object.keys(newWorkspaces)) if (!orderedIds.includes(id)) orderedIds.push(id);
  const newGlobal = { ...wsFile.data.global, workspaceIds: orderedIds };
  if (!newWorkspaces[newGlobal.defaultWorkspaceId]) newGlobal.defaultWorkspaceId = orderedIds[0];
  const newData = { ...wsFile.data, global: newGlobal, tables: { ...wsFile.data.tables, workspaces: newWorkspaces } };
  const tmpWs = wsFile.file + ".tmp-" + process.pid;
  fs.writeFileSync(tmpWs, JSON.stringify(newData, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpWs, wsFile.file);
  ok(`导入 ${n} 个会话；workspace.json 已更新；备份在 ${backupRoot}`);
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 模块导出（供 cordis 插件与 bin 复用）                                  */
/* ------------------------------------------------------------------ */

module.exports = {
  SESSION_FORMAT_VERSION,
  MANIFEST_FORMAT,
  encodeSegment,
  projectKey,
  norm,
  expand,
  mapPath,
  scanZstdFrames,
  scanSessions,
  readHeader,
  readLogText,
  loadWorkspaceFile,
  buildPlan,
  applyPlan,
  rewriteHeaderCwd,
  verifyRewrite,
  patchProjcache,
  exportStore,
  importStore,
  listSessionDirs,
  liveHolders,
  dshProcesses,
  sessionsRoot,
  logFileName,
  basenameTitle,
};
