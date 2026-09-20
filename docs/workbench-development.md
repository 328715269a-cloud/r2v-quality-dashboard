# 新作业模式开发

`group-workbench/` 是正式多人共享模式的前端，`workbench-api/` 是独立 HTTP / SQLite API。当前 `20260920-prod8` 验收退回后的质检批量转交修复已于 2026-09-20 18:05（北京时间）上线；发布事实见 `docs/releases/workbench-20260920-prod8.json`，最新业务说明见 `group-workbench/HANDOFF.md`。

prod8 只改前端批量事件选择与表单保护，API 继续使用 prod7，数据库保持原状。管理员导入边界等 prod7 规则继续有效。

只读 / 修改新模式时，不要改根看板、`group-beta/` 或 `group-workbench-beta/`。完整内部运维接手包由项目负责人单独保存；生产访问凭据、环境文件、真实数据库与内部密码不进 Git。

## 本地运行

需要 Node 22.23.2+（22.x）或 24.18.0+，无需 npm 运行依赖。从项目根运行 PowerShell：

```powershell
$env:WB_LOCAL_ADMIN_PIN = '9038'
$env:WB_LOCAL_GROUP_PIN = '9036'
node .\tools\workbench\dev-server.cjs --repo .
```

打开输出的 `127.0.0.1` 地址。以上数字仅为本地测试配置。默认新建独立空数据库；加 `--data-dir '<已记录的本地目录>'` 可续用本工具创建的数据。`Ctrl+C` 停止服务并保留数据。启动器不读取生产配置、不连接云端，也不带 Demo 预置任务。

## 验证

在项目根运行，均使用本地测试数据：

```powershell
node --check group-workbench/app.js
node --check workbench-api/server.cjs
node scripts/verify-workbench-qc-return.cjs
node workbench-api/verify-admin-import.cjs
node workbench-api/verify-direct-acceptance.cjs
node scripts/verify-direct-acceptance-reports.cjs
node scripts/verify-workbench-efficiency.cjs
node workbench-api/verify-boundaries.cjs
node tools/workbench/verify-dev-server.cjs --repo .
```

`workbench-api/fixtures/` 保存只读历史客户端 / Demo 规则测试基线，用于旧页面兼容断言；它们不参与生产运行。不要用当前客户端替换旧客户端基线。`scripts/verify-group-workbench-reports.cjs` 是复用的历史报表用例，通过正式 wrapper 运行。

`verify-direct-acceptance.cjs` 是验收流转专项验证，包含真实 HTTP、两个独立进程共享临时 WAL、旧会话恢复、验收三种结果、批量原子性和报表。仓库保留 `verify-api.cjs`、`verify-deletions.cjs`、`verify-workbench-tid-input.cjs` 和 `verify-workbench-reports.cjs` 的 prod4 历史用例；其中有旧验收建包轮次、当前源码必须字节等于历史 fixture 的断言，不属于本轮默认通过清单。后续需要按新业务语义及跨平台换行方式维护，不能恢复旧流转或覆盖历史 fixture 来迎合断言。

prod6 效率专项为 `verify-workbench-efficiency.cjs`，14 类统计检查全部通过；direct-acceptance 报表测试通过 37 条合成事件，本地启动器通过 9 项检查。效率验证覆盖去重后的实际完成量、人天、实际代修人、日期和小组范围、人数异常及导出。prod6 实际办公浏览器界面、宽表滚动和最终 12 个公网文件比对也已完成。

prod7 新增 `verify-admin-import.cjs`，使用测试专属假 PIN 和独立临时 SQLite。它检查管理员单/多镜头导入、非管理员所有入口 403、旧会话有效、拒绝事务原子性与幂等、常规质检/返修、每日设置和既有资料更正权限。固定 Node 22.23.2 镜像下，该专项、direct-acceptance 与边界回归已通过；本轮效率和验收报表回归也通过。旧 QC 页面在隔离环境中验证了导入 403 保留草稿与普通质检包保存成功；最终 12 个公网文件及正式 QC 只读界面已核验。

prod8 的 `verify-workbench-qc-return.cjs` 直接提取实际 app 函数并结合既有服务端规则，以合成数据完成 8 类检查：验收退回转交、普通质检与混选、错误等级/标签范围、过期状态、小组权限、整批原子性、草稿保留和重复提交保护。隔离浏览器复现了旧页面错误，新页面纯验收退回 2 条与混选 2 条实际保存成功；漏标签和过期任务整批拒绝并保留说明/勾选。保持打开的 prod7 页在发布后草稿原样，普通质检批量打回仍成功保存。公网只预览表单并核对 12 个静态文件，无真实任务提交；真实业务任务不进入测试或文档。

已知历史限制：`verify-workbench-reports.cjs` 的 `qcOperator` / `acceptance_pass` 旧断言在 `d222657` 基线也失败；本次不修改该操作人解析规则。不要把这一基线问题混同为新增效率测试通过或失败的结论。

Git 中 prod8 的六个资源引用使用未版本化文件名加 `?v=20260920-prod8`，本地启动器可直接提供文件；线上构建将这些引用转换为不可变版本文件名。不要用生产版本文件名覆盖本地源文件名，也不要复用已发布的版本资产。

## 代码与数据

- `index.html` / `styles.css` / `app.js`：页面、批量 TID 操作、表单与草稿保护。
- `workflow.js`：事件投影、最新状态，前后端共用。
- `data-io.js` / `reports.js`：解析、校验和导出。
- `shared-store.js`：会话、共享读取、冲突重试、完整备份。
- API `server.cjs` / `rules.cjs`：SQLite WAL、会话、权限、PIN、流程、CAS 与幂等校验。

任务 / 事件 / 批次为追加记录，更正通过事件保存。整批删除仅允许从未开始作业的导入，必须重新校验管理密码；追加墓碑保留完整审计。同 TID 重导必须使用新 ID。旧客户端会话、进行中的表单与后续保存必须兼容。

prod7 初始影片/TID 导入仅管理员执行；前端隐藏质检入口，服务端对新增任务、导入批次与 dispatch 全入口检查。旧 QC 导入草稿提交收到 403 是授权后的预期权限变化，输入必须保留；质检建包、审核、返修分配、每日设置及既有资料更正权限保持原样。不要把“管理 PIN 正确”当成导入角色授权。

prod8 批量转交按每条最新状态分流：`acceptance_return_pending` 使用已有 `acceptance_route` 事件，`route` 为 `annotation`；`pending_qc` / `pending_reqc` 使用 `qc_fail`。混选时在一个事务中提交两类事件；全部任务共用说明，错误等级和标签只适用于普通质检事件。身份、小组、选择集合和任务版本任一变化都应拒绝本批并保留草稿，不能静默跳过失败条目或落下一部分任务。

prod6 的实际完成量从有效标注提交记录按本地日期与 TID 去重得到，和手填总量分开。单天效率用当日完成量除当日在班人数；多天效率用完成量合计除在班人天合计。个人每日产出归实际提交人，代修不回记原操作人；0.5 人天只影响组均分母。完成量非零但人数为零时返回 `null` 并提示核对。新增个人每日导出表保留明细，既有历史流水和统计继续保留。

## 发布约束

Git 提交不等于网站发布。先在隔离环境完成验证，再根据本轮授权发布。保留原模式及两个 Demo，不强制刷新、重登或清空任何人的未提交内容。

前端使用新版本资源并保留旧资源，只原子替换新模式入口。后端准备兼容新实例后再平滑切换；不能停止现有服务再启动替代版本，不能重复后台任务。当前部署的备份职责与数据路径须由内部运维材料核实，不能猜测或直接运行历史发布脚本。

上一轮 prod6 是静态发布：不修改 API / 数据库 / Nginx，不启停服务。前端封包对未改变的解析、共享协议及状态投影先校验与线上一致，再保留原字节；Windows checkout 的 CRLF/LF 差异需单独记录，不视为业务修改。

prod7 使用新 API 实例与平滑路由切换，复用原数据库/会话；server 启动与备份逻辑不改，禁止初始化原库或重复后台备份。旧服务继续处理在途请求，排空后再切换新模式 HTML。原九个服务和唯一备份任务均未停止，发布未写生产业务记录。不得停旧服务后再启动替代服务，也不得把旧 QC 导入重新放开来规避预期 403。

prod8 已完成仅静态发布，继续使用 prod7 API。除 app/index 外的五个前端文件先核对与线上相同（仅允许 checkout 换行差异），封包保留线上原字节；API 源不打包。发布前后核对全部十个容器身份与启动时间、API 源、Nginx、旧资源、原模式和两个 Demo，均保持不变。发布工具不读取真实任务或数据库，用户业务 revision 可正常推进；切换必须同时具备验证证明、旧页草稿连续性和精确源散列。

已启用删除事件之后，不得回退到不认识删除墓碑的旧 API。需要回退时仍须保持有效 TID 唯一性、历史审计和旧页面兼容。
