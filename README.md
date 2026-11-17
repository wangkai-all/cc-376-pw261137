# 撤销传播处置台

某批数据发布之后才发现关键字段错误，下游已经用它生成了汇总和导出。这个项目从零实现一条**真实的数据流**：质量处置服务、数据目录、两个消费端（可逆的区域汇总 / 不可逆的工作簿导出）完成撤销传播；能发反向贡献，也能通知重建；网页可发起撤销、跟踪影响、重新发布修正版并核对消费结果。

历史输出不被篡改：导出文件写一次即不可变，失效只是状态而不是删除或改写。

## 运行

```bash
npm start          # http://127.0.0.1:4173 ，首次启动注入演示场景
npm test           # 16 个用例：领域流程 + HTTP 面
npm run simulate   # 控制台完整走一遍处置流程（独立临时库）
npm run seed       # 只注入演示数据
npm run check      # 语法检查
```

无需安装依赖：Node ≥ 22.5，使用内置的 `node:sqlite`。数据默认落在 `data/revocation.db`，导出文件在 `data/exports/`（两者均不入库）。可以用 `PORT` / `HOST` / `DB_FILE` / `SEED=0` 覆盖。

## 演示场景

| 批次 | 内容 | 状态 |
|---|---|---|
| B-2026-100 | 11-15 常规销售 | 已双端消费，有效 |
| B-2026-101 | 11-16 促销销售，`amount` 被多乘 10 | 已被撤销，源批次 superseded |
| B-2026-104 | 处置过程中到达的新正常批次 | 有效，已消费 |

打开处置台时 B-2026-101 的处置单正处在传播中：数据目录、三个区域的区域汇总、一个不可逆导出共 5 项工作项待处理。处置期间 B-2026-104 的正常消费已经发生，不会因为撤销而被重复扣减。

`npm run simulate` 会在控制台把以下步骤跑一遍并逐项打印结果：

1. 坏批次已被两个消费端使用
2. 打开处置单，按**真实消费记录**展开影响
3. 正常新批次到达并被消费
4. 执行反向贡献，然后模拟旧处置进程恢复、重复执行 → 幂等跳过
5. 消费端确认导出丢失 → 影响仍显示为未处理
6. 发布修正版并重放修正数据（重复重放 → 幂等跳过）
7. 消费端生成修正版导出，运行消费核对 → 11 项全部通过，处置单关闭

## 三条核心不变量

**1. 可逆汇总靠重算，不靠扣减。** `consumptions` 每行带状态（`applied` / `unwound` / …），区域汇总 `consumer_summaries` 只由 `recomputeRegion()` 从仍然 `applied` 的行重算。撤销就是把该批次的行标记为 `unwound` 再重算，所以重复执行、旧进程恢复、乱序到达都不会二次扣减。`summary_ledger` 以 `UNIQUE(work_item_id, region)` 再兜一层：同一个工作项对同一区域的任何移动只允许发生一次。

**2. 不可逆导出写一次即冻结。** 导出用 `writeFileSync(..., { flag: 'wx' })` 落地并记录 sha256。发现错误时只把状态改为 `invalidated`；修正版是**新文件**，旧文件以 `superseded` / `invalidated` 留在案。下载接口会先校验哈希，被篡改的文件拒绝下发；`export_history_intact` 核对项会在核对时发现任何改写。

**3. "确认丢失"不等于"已处理"。** 工作项终态有四种：`done`（完成）、`superseded`（已由核对通过的修正版替代）、`acknowledged_loss`（消费端承认导出收不回来）、`failed`（明确了原因但无法推进）。只有前两种算已处理。`acknowledged_loss` 和 `failed` 持续计入未处理影响，处置单不会因此关闭——只有修正版导出生成并核对通过，丢失项才转为 `superseded`。

## 处置流程与接口

```
POST /api/ingest                         发布普通批次（按 batch_id 幂等）
GET  /api/batches[/:id]                  批次列表 / 明细
GET  /api/overview                       未关闭处置单、未处理影响、按目标分布、区域汇总
GET  /api/summaries                      区域汇总当前值
GET  /api/artifacts                      导出文件与状态
GET  /api/artifacts/:id/download         下载（校验哈希；失效文件仍可审计下载）
POST /api/consumers/:name/consume        消费端消费一个批次
GET  /api/cases[/:id]                    处置单
POST /api/cases                          发起撤销：按真实消费展开工作项
POST /api/work/:id/execute               执行反向贡献（可逆）
POST /api/work/:id/ack-loss              消费端确认丢失（ack key 幂等）
POST /api/work/:id/fail                  标记无法推进，影响继续显示
POST /api/corrections                    发布修正版（生成 replay + rebuild 工作项）
POST /api/work/:id/replay                重放修正版到区域汇总（幂等）
POST /api/corrections/:id/verify         运行消费核对
GET  /api/health /api/catalog /api/consumptions /api/ledger
```

一次撤销的传播：

1. **发起** `POST /api/cases`：源批次标为 `invalidated`，目录资产标 `flagged`，为每个受影响区域、每个当前导出各建一个工作项。导出在同一事务里标为 `invalidated`，但文件不动。
2. **反向贡献**：目录撤回是状态迁移；区域汇总是把对应消费行标 `unwound` 后重算。目标为 `region-summary`，按区域分片，重试只影响一个区域。
3. **通知重建**：`workbook-export` 工作项只有 `rebuild_notice` 方法，没有"修改文件"这条路。消费端重新生成导出时，待处理的通知自动结项。
4. **发布修正版** `POST /api/corrections`：要求可逆传播已完成。修正批次 `kind='corrected'`，源批次转 `superseded`；生成每个区域的重放项（`replay_corrected`）和每个旧导出的重建通知（`rebuild:` 前缀，避免"已重新导出"被误当作丢失已解决）。
5. **核对** `POST /api/corrections/:id/verify`：9 类核对项（逐区域展开后 11 行）——字段确实变了、行数没丢、源批次贡献已完全撤回、修正贡献已入账（逐区域）、无负总额、旧导出已失效、导出历史哈希未变、存在替换导出、重放已结清。全部通过后，丢失项转 `superseded`，处置单 `resolved`。

修正版不能由普通导入接口创建（`kind='corrected'` 会被拒绝），可逆消费端也不能直接汇总修正批次——修正数据的回补必须走处置单，保证有账可查。

## 网页

四个视图：

- **总览**：KPI、按目标（目录 / 汇总 / 导出）的已处理 vs 未处理条形对比、区域汇总单系列条形图（带表格视图）、进行中的处置单、未处理影响的逐项清单。
- **处置单**：左侧列表，右侧详情——影响传播工作项按目标分组、每项可展开轨迹、处置时间线、修正版核对表。可一键执行全部可逆反向贡献、确认丢失、发布修正版、运行核对。
- **批次**：批次列表与明细，普通批次导入（CSV 行）。
- **消费端**：各消费端状态计数、不可变导出列表与下载（含已失效的审计下载）、模拟消费。

无障碍与可视化约定：状态一律「图标 + 文字 + 颜色」，不只靠颜色；所有 API 文本用 `textContent` 插入；单系列图不放图例（标题即说明）、双系列图例在位；配色经过 CVD / 对比度校验，明暗两套独立取值。

## 代码结构

```
src/lib/db.js            schema、迁移、BEGIN IMMEDIATE 事务
src/lib/util.js          ApiError、hash、fingerprint、数值规整
src/lib/http.js          手写路由与 JSON 响应
src/services/quality.js  全部领域逻辑（批次、消费、撤销、修正、核对）
src/server.js            HTTP 接口 + 静态文件（带目录穿越防护）
public/                  原生 HTML / CSS / ES module 前端
scripts/seed.js          演示场景
scripts/simulate.js      端到端控制台演练
test/flow.test.js        16 个测试
```

## 测试覆盖

`node --test` 覆盖：导入幂等与冲突、撤销影响按真实消费展开、反向贡献精确且可重试、目录撤回不是删除、丢失确认不关闭处置单、修正发布 → 重放 → 替换导出 → 核对关闭、修正发布的前置条件与重复发布、核对失败时显式报错、导出被篡改可被发现、旧工作项恢复不复活坏数据、两个处置单互不影响，以及完整 HTTP 往返与非法请求处理。
