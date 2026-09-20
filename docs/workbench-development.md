# 新作业模式开发

`group-workbench/` 是正式多人共享模式的前端，`workbench-api/` 是独立 HTTP / SQLite API。当前源码为 `20260920-prod5` 验收直接流转版本；发布事实见 `docs/releases/workbench-20260920-prod5.json`，业务变更见 `group-workbench/HANDOFF.md`。

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
node workbench-api/verify-direct-acceptance.cjs
node scripts/verify-direct-acceptance-reports.cjs
node workbench-api/verify-boundaries.cjs
node tools/workbench/verify-dev-server.cjs --repo .
```

`workbench-api/fixtures/` 保存只读历史客户端 / Demo 规则测试基线，用于旧页面兼容断言；它们不参与生产运行。不要用当前客户端替换旧客户端基线。`scripts/verify-group-workbench-reports.cjs` 是复用的历史报表用例，通过正式 wrapper 运行。

`verify-direct-acceptance.cjs` 是本轮状态流转的专项验证，包含真实 HTTP、两个独立进程共享临时 WAL、旧会话恢复、验收三种结果、批量原子性和报表。仓库保留 `verify-api.cjs`、`verify-deletions.cjs` 和 `verify-workbench-*.cjs` 的 prod4 历史用例；其中有旧验收建包轮次、当前源码必须字节等于历史 fixture 的断言，不属于本轮默认通过清单。后续需要按新业务语义及跨平台换行方式维护，不能恢复旧流转或覆盖历史 fixture 来迎合断言。

Git 中六个资源引用使用未版本化文件名，五个 JavaScript 加 `?v=20260920-prod5`、CSS 加 `?v=20260920-prod5a`，本地启动器可直接提供文件；线上构建将这些引用转换为不可变版本文件名。不要用生产版本文件名覆盖本地源文件名，也不要复用已发布的版本资产。

## 代码与数据

- `index.html` / `styles.css` / `app.js`：页面、批量 TID 操作、表单与草稿保护。
- `workflow.js`：事件投影、最新状态，前后端共用。
- `data-io.js` / `reports.js`：解析、校验和导出。
- `shared-store.js`：会话、共享读取、冲突重试、完整备份。
- API `server.cjs` / `rules.cjs`：SQLite WAL、会话、权限、PIN、流程、CAS 与幂等校验。

任务 / 事件 / 批次为追加记录，更正通过事件保存。整批删除仅允许从未开始作业的导入，必须重新校验管理密码；追加墓碑保留完整审计。同 TID 重导必须使用新 ID。旧客户端会话、进行中的表单与后续保存必须兼容。

## 发布约束

Git 提交不等于网站发布。先在隔离环境完成验证，再根据本轮授权发布。保留原模式及两个 Demo，不强制刷新、重登或清空任何人的未提交内容。

前端使用新版本资源并保留旧资源，只原子替换新模式入口。后端准备兼容新实例后再平滑切换；不能停止现有服务再启动替代版本，不能重复后台任务。当前部署的备份职责与数据路径须由内部运维材料核实，不能猜测或直接运行历史发布脚本。

已启用删除事件之后，不得回退到不认识删除墓碑的旧 API。需要回退时仍须保持有效 TID 唯一性、历史审计和旧页面兼容。
