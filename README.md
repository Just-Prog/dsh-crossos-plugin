# dsh-crossos

> 单机双系统（Windows + Linux）下，把"另一套系统里写下的" DeepSeek Harness 会话与其工作区归属，迁移到本机真实路径上的 DSH 插件。路径映射与「启动时自动导入」开关直接在 **设置 → dsh-crossos** 里填。

同一个项目在两套系统里的绝对路径不同：

```
Windows:  D:\Projects\demo-app
Linux:    /mnt/data/Projects/demo-app
```

（以上为示例路径，映射规则按你自己的目录填。）

而 DSH 把**绝对路径**固化在了四个地方，所以直接拷贝 `sessions/` 只会得到"未分组"会话，甚至打不开：

| 位置 | 内容 |
| --- | --- |
| 会话日志首行 header | `{"type":"session","version":4,"id":"…","cwd":"D:\\…"}`，zstd 第一帧 |
| `sessions/<projectKey>/<sessionId>/` | `projectKey` 由 cwd 编码而来（`--D-Projects-demo-app--` vs `--mnt-data-Projects-demo-app--`） |
| `storages/workspace.json` | 工作区记录的 `path` 与 `sessionIds` |
| `storages/session_projcache/` | 会话投影缓存里的 `identity.cwd` |

本插件在 DSH 启动早期按**可配置的路径映射**把这四处统一到本机路径：改写 header、挪会话目录、修正 `workspace.json` 归属、修正 projcache。只重压 header 所在的第一帧，其余 zstd 帧与事件行逐字节保留；带备份、可 dry-run、失败整体回滚。

---

## 安装

```bash
# 从源码安装：在仓库根目录执行（profile 名按实际使用的写，常见是 web / default）
dsh plugin --profile web add "$PWD"

# 发布到 npm 后
dsh plugin --profile web add dsh-crossos
```

`dsh plugin --profile <name> <pnpm 参数>` 会把参数原样转发给 profile 目录里的 pnpm，并读包里的 `dsh.bundle.patch`（`cordis.patch.yml`）把插件行插入宿主组合。本地路径会被 pnpm 以 `file:`/`link:` 方式登记，**移动插件目录后需要重装**。装完**重启一次 DSH**。

装完重启 DSH，打开 **设置 → dsh-crossos**，就能填映射、开关「启动时自动导入」：

```
设置
└─ dsh-crossos
   ├─ 路径映射            [系统 A 的路径]  [系统 B 的路径]  [删除]
   │                      [+ 添加映射]
   ├─ □ 启动时自动导入    每次启动 DSH 自动迁移可映射的会话
   ├─ □ 试运行            只打印计划，不改文件
   └─ 保存                （写入 $DSH_HOME/crossos.json）
```

设置页显示当前 `crossos.json` 路径、DSH_HOME、待迁移会话数与上次运行摘要；保存后写入配置，**重启 DSH 生效**（或用带 HMR 的 profile 重载插件）。

设置页通过插件自带的 HTTP API 读写配置：`GET/PUT /dsh-crossos/api/config`（先过 DSH 的 Host/Origin 信任栅栏）。

---

## 配置

三处来源，后者覆盖前者：

| 来源 | 用途 |
| --- | --- |
| 内置默认值 | 保守默认：不迁移、dry-run 关闭 |
| `$DSH_HOME/crossos.json` | **设置页写这里**，也可手工编辑 |
| profile 的插件 `config` | 部署级覆盖（一般不用） |

### 1. `$DSH_HOME/crossos.json`（设置页写的就是这个文件）

```json
{
  "maps": ["D:\\=/mnt/data"],
  "auto": true
}
```

也可以写成对象形式，双系统更直观：

```json
{
  "maps": [
    { "windows": "D:\\", "linux": "/mnt/data" }
  ]
}
```

### 2. profile 里的插件配置行

`~/.dsh/profiles/<profile>/cordis.patch.yml` 中该插件的 `config`：

```yaml
- id: dsh-crossos
  name: dsh-crossos
  config:
    maps:
      - 'D:\=/mnt/data'
    auto: true
```

**映射自动展开为双向**（`D:\→/mnt/data` 与 `/mnt/data→D:\`），因此同一份配置在两个系统通用；方向由"映射后的目标路径在本机是否真实存在"决定。不需要为每个系统维护不同的配置，也**没有写死任何挂载点**。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maps` | `[]` | 路径映射；`"FROM=TO"` 或 `{ from, to }` / `{ windows, linux }` |
| `auto` | `true` | DSH 启动时自动迁移 |
| `dryRun` | `false` | 只打印计划，不落盘 |
| `adoptWorkspace` | `true` | 把迁移后的会话归入迁移后路径对应的工作区记录 |
| `requireTargetExists` | `true` | 目标路径在本机不存在则跳过（也是方向判定依据） |
| `skipCollision` | `true` | 目标目录已被另一个会话占用则跳过，不报错 |
| `skipLive` | `true` | 日志正被进程打开则跳过 |
| `keepOld` | `false` | 旧目录改名为 `<name>.migrated` 保留，而不是移入备份 |
| `home` | 空 | 覆盖 `$DSH_HOME`（一般不需要） |

---

## 两种典型部署

### A. 两个系统共用同一个 `$DSH_HOME`（放在 NTFS 数据盘）

这是"单机双系统同步"最省事的方式——会话只有一份，插件负责把路径拼写改成当前系统：

```bash
# Windows（管理员或用户环境变量）
setx DSH_HOME "D:\dsh-home"
# Linux
export DSH_HOME=/mnt/data/dsh-home
```

启动 DSH 时，插件把上次由另一系统写下的会话改成当前系统路径；工作区记录也同步改写。**每次切换系统启动都会发生一次这样的迁移**，属预期行为——备份目录会随之增长，可定期清理 `$DSH_HOME/backups/dsh-crossos/`。

### B. 两个系统各自独立的 `$DSH_HOME`

- 把源系统的 `sessions/` 目录拷贝（或用任意文件同步工具同步）到另一系统对应的 `$DSH_HOME/sessions/`；
- 接收方启动 DSH，插件自动把外来会话 rebase 到本机路径；
- 工作区归属不必手工搬：插件在迁移时会顺带把会话归入目标路径已存在的工作区记录；若没有，则新建一条。

---

## 迁移具体做了什么

1. **header cwd 改写**：只重压第一帧（header 帧），后续帧原样复制；`none` 压缩的明文 `.jsonl` 直接改首行。迁移后校验 `id` 不变、行数不变、除 header 外明文 sha256 一致。
2. **会话目录落位**：`sessions/<projectKey(新 cwd)>/<encodeSegment(id)>/`，命名与 DSH 自己的实现一致（`~XXXX` 编码）。
3. **`workspace.json`**：记录路径按映射改写（只改本机存在的，避免把记录改坏）、同路径重复记录合并（并集 sessionIds、修 `defaultWorkspaceId`）、迁移后的会话 id 归入对应记录。
4. **projcache**：只改 `identity.cwd`，保留标题等投影数据。
5. **备份与回滚**：改动前备份到 `$DSH_HOME/backups/dsh-crossos/<时间戳>/`，旧目录移入 `old-dirs/`；任何一步失败按 undo 栈整体回滚。

---

## 安全边界

- 启动时执行，此时还没有会话被打开；日志若正被进程占用（`/proc/*/fd`）会跳过。
- 幂等：已经在本机的会话不会重复迁移。
- 现网验证、不想直接落盘时用 `plan`（dry-run）。
- 迁移完建议**再重启一次 DSH**，让工作区分组从磁盘重新加载（首次迁移时宿主可能已缓存了旧 header）。

---

## 命令行（与插件共用同一引擎）

```bash
cd dsh-crossos-plugin
node bin/crossos.cjs status        # 列出会话、cwd、归属、是否需要迁移
node bin/crossos.cjs maps          # 打印解析后的双向映射
node bin/crossos.cjs plan          # 只打印迁移计划
node bin/crossos.cjs apply         # 执行（检测到 DSH 在运行会拒绝，可加 --force）
```

通用参数：`--home PATH`、`--map "FROM=TO"`（可重复）、`--json`、`--force`、`--keep-old`。

输出示例（示意，路径与会话 ID 均为 mock）：

```
DSH_HOME: /home/you/.dsh
  迁移  session-00000000-1111-4222-8333-444455556666
        cwd: D:\Projects\demo-app
        目标: /mnt/data/Projects/demo-app
  保持  session-77777777-8888-4999-a000-bbbbbbbbbbbb
        cwd: /mnt/data/Projects/demo-app
        工作区: demo-app
```

---

## 自测

```bash
node test/plugin.test.mjs     # 17 项：配置解析、双向映射、dry-run、迁移、归组、projcache、备份、幂等、边界、API 注册、宿主自检
node test/api.test.mjs        # 6 项：配置校验、原子写入、GET/PUT、404/405、信任栅栏
node test/client.test.mjs     # 6 项：bundle 注册协议、client 契约、settings.section 注册、文案字典

npm test                      # 以上三个都跑，共 29 项
```

测试会在工作区临时目录里造一个 DSH_HOME（Windows 会话 + Linux 工作区 + projcache），跑完自动校验落位、事件行逐字节一致、workspace 合并去重、冲突跳过等。

---

## 已知限制

- 只处理会话 `cwd` 这一条路径链；skills、附件等其它绝对路径不改。
- 前缀匹配用最长匹配 + "目标必须存在"双重约束：`/mnt/database` 不会被 `/mnt/data` 误匹配（有测试覆盖）。
- Windows 侧要求 Node ≥ 22.15（`zlib.zstdCompressSync`）。
- 迁移是"改写 + 搬运"，不做内容合并；同一会话不会被两边同时改写（双系统不会同时运行）。
- 设置页只负责写配置；配置在插件 `apply` 时读取，因此**保存后需重启 DSH**（HMR profile 会重载插件，但迁移动作只在启动时执行一次）。

---

## License

MIT。见 [LICENSE](LICENSE)。
