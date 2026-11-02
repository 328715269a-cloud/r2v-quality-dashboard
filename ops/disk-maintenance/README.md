# 磁盘维护接手说明

部署状态：2026-11-02 已启用独立维护与容量 timer；最终清理结果见同目录部署记录及服务器 `.retention/last-run.json`。没有更换线上前端或 API 版本。

## 范围与保护原则

本工具仅整理新作业模式的**备份副本**并采集容量状态，不修改任务、流水、人员、会话、成绩或正在使用的数据库。生产数据库为 `/opt/r2v/group-workbench-data/workbench.sqlite`；不得将它及其 WAL、SHM 作为清理对象。

现有 `r2v-group-workbench-api-prod1` 继续负责每小时在线备份，必须保留运行。不得为维护磁盘重启数据库、Docker 或任何业务服务。

## 备份保留政策

- 最近48小时：每小时保留最新一份。
- 最近14个自然日：每天保留最新一份。
- 最近4个自然周：每周保留最新一份，周一为起点。
- 日期分桶按北京时间；重合的恢复点只保留一份。
- 人工、发布和数据修正等非标准命名备份全部保留；维护程序不会清理它们。

上述期限指“恢复到某个时间点的副本频率”，不是业务数据保留期。每份完整备份仍包含该时间点之前的全部有效任务和流水；新作业模式不裁剪历史。原系统只有约14天小时副本，4周周级恢复点会随运行逐周积累，不能凭空补出更早的恢复点。

只处理 `/opt/r2v/group-workbench-data/backups` 内严格匹配 `workbench-YYYY-MM-DDTHH-MM-SS-mmmZ.sqlite` 的文件。需要长期保留的日/周恢复点放入 `tiered/`，避开原备份服务只扫描根目录的336份保留规则。

## 运行与记录

服务器脚本目录：`/opt/r2v/maintenance/disk`。

| 单元 | 周期 | 用途 |
|---|---|---|
| `r2v-workbench-retention.timer` | 每小时43分 | 验证恢复点后整理备份；避开现有每小时约28分的备份生成时段 |
| `r2v-capacity.timer` | 启动后约2分钟，此后每5分钟 | 采集磁盘和备份新鲜度 |

默认仅生成计划，不清理文件：

```sh
python3 /opt/r2v/maintenance/disk/retention.py
```

显式应用已核对的策略：

```sh
python3 /opt/r2v/maintenance/disk/retention.py --apply
```

应用会重新制定计划并校验，不复用过期清单。要求最新稳定自动备份不超过4小时；文件时间与修改时间至少稳定120秒；保留恢复点通过 SQLite 完整性、表结构和版本检查。验证结果按文件签名缓存，最多7天。符号链接、路径异常、备份变化、缺少恢复点或已有维护进程运行时停止执行。删除前持续核对文件签名和保留恢复点。

维护记录在备份目录的 `.retention/`：逐次 `run-*.json`、`last-run.json` 和完整性验证缓存 `verified.json`。首次完整性扫描与大日志归档应错峰，使用低 CPU/I/O 优先级。若发现根目录与 `tiered/` 同名文件，程序会安全停止；先核对是否为中断留下的同一 inode，不能直接重跑删除命令。

## 容量状态与提醒

`capacity.py` 只写 `/opt/r2v/maintenance/disk/capacity.json`。磁盘按与 `df` 一致的可用空间口径计算，设置80%、85%、90%阈值；自动备份超过4小时未更新也标记异常。阈值或恢复状态变化时写入 journal。

**只有外部巡检或通知系统消费该 JSON/日志后，用户才会收到提醒。**仅启用本 timer 不代表已经配置邮件、聊天消息或其他外部通知。

已更新现有 Codex 自动化 `r2v-2`（R2V腾讯云容量、可用性与备份巡检），沿用每6小时检查。新增本状态文件、80/85/90分级、小时备份和维护任务的新鲜度检查；正常或未变化时安静。服务器每5分钟采样不等于每5分钟向用户通知。未新增邮件或第三方消息通道。

## Docker 日志

`archive-log.py` 通过 `docker logs` API 导出 `r2v-db-1` 日志到 `/opt/r2v/maintenance/disk/log-archives`，压缩后重新解压核对字节数和 SHA-256，并确认容器未发生变化。它不截断、不删除原 Docker 日志，因此不能将归档大小当作已释放空间。

`docker-logging.future.json` 仅供将来安全创建容器时采用：10MB一份、保留3份并压缩。它尚未对现有 PostgreSQL 容器生效。不得直接覆盖 Docker 配置并重启服务，也不得启动两个 PostgreSQL 实例共享现有数据卷。

2026-11-02 只读检查确认约10.4GB历史日志仍由 dockerd 持有同一 inode，因此本次不截断、不删除，也未启动全量日志导出以争抢首次备份校验的磁盘资源。上述归档脚本是已准备工具，不能当作归档已执行的凭证。Docker 官方约束见 https://docs.docker.com/engine/logging/drivers/json-file/ 。

## 新旧作业数据与本机副本

本次没有删除任何业务数据。quality 根页旧模式使用 PostgreSQL `public.r2v_quality_*` 与 `r2v-quality-evidence` 附件；新模式 `/group-workbench/` 使用独立 SQLite。旧模式2026-11-02只读估算：业务表约186MB，附件实际占盘约233MB，总共约0.42GB，最近业务事件9月11日、最近导入9月12日，且108条申诉仍为 submitted。普通DELETE不保证立刻向操作系统回收文件空间，不能为省空间直接按日期删除。

本机完整备份下载被自动审批拒绝：尚未取得将约78MB生产任务/流水完整备份发送到本机工作区的明确授权。没有传输，也未用替代方式绕过。服务器内恢复点验证和副本分层照常执行。后续需用户明确同意本机路径后，才可单独执行下载、哈希及本机恢复校验。

## 安全停止与回退

需要暂停维护时，只停止并禁用本次新增的两个维护 timer；已经完成的备份分层不会因此影响业务。若维护 service 正在运行，优先等其结束，随后核对 `.retention/last-run.json`。

```sh
systemctl disable --now r2v-workbench-retention.timer r2v-capacity.timer
```

不得停止 `r2v-group-workbench-api-prod1`，不得恢复旧业务数据库覆盖当前数据，也不得为撤销维护而重置任务或会话。已删除的冗余小时副本无法通过停 timer 复原；仍保留的恢复点及人工备份是恢复依据。
