# 受控测试数据清理

`maintenance.py` 是通过标准输入 JSON 调用的运维工具，不是 HTTP 接口，不随网站页面提供，也不是通用“清空数据”功能。只可处理已经明确授权、逐条确认的测试任务内部 ID；不得按影片模糊匹配、日期范围或名称批量猜测目标。实际目标清单、计划、备份、生产凭据及业务记录只保存在私有运维位置，不能提交 Git。

先验证兼容 API 已上线，且全部服务请求已切换到支持 `fullSnapshotRevision` 与 `retiredTaskIds` 的版本。保留旧容器不代表可让旧 API 继续接收清理后的业务流量；清理前必须确认旧 Nginx worker / 在途请求已排空。兼容后端不存在时禁止执行 apply。

## 准备与执行

两步均使用 Python 3 标准库，从 stdin 接收 JSON。以下是字段模板，尖括号内容必须由已审核的私有运维记录提供；不能直接照抄执行。

`prepare` 请求：

```json
{
  "operation": "prepare",
  "database": "<已核对的现有SQLite绝对路径>",
  "backup": "<私有位置中的全新备份绝对路径>",
  "plan": "<私有位置中的全新计划绝对路径>",
  "targetTaskIds": ["<已授权的内部任务UUID>"],
  "operationId": "<本次操作的新UUID>"
}
```

prepare 只读打开原库，用 SQLite 在线备份接口生成一致备份并检查完整性，在备份上生成精确计划，原库不写入。计划与备份为私有文件；若已存在则拒绝覆盖。输出包含统计数量及 `planDigest`，不输出任务内容。

操作者应核对计划是否只包含授权目标及其关联流水/批次，再提交 `apply`：

```json
{
  "operation": "apply",
  "database": "<与prepare相同的现有SQLite绝对路径>",
  "plan": "<prepare实际生成的私有计划绝对路径>",
  "planDigest": "<prepare返回的精确SHA-256>"
}
```

apply 验证计划、备份散列、数据库文件身份、createdAt、目标记录和相关事务内容，允许无关业务在准备后继续推进。目标发生变化或存在混合了无关任务的批次时拒绝执行，不能自动扩大清理范围。一次短 `BEGIN IMMEDIATE` 事务内移除目标任务及相关流水/批次，裁剪幂等结果中对它们的引用；保留原请求 ID、payload hash、操作者与其他事务字段。原追加保护触发器在同一事务内恢复，无关记录、会话和元信息逐项核对不变。

成功后 revision 只增不减，写入全量同步屏障、停用内部任务 ID 集合及维护审计。达到锁等待或事务时限就失败回滚，不长时间阻塞正常保存。再次提交相同计划会验证已应用状态并返回 `alreadyApplied`，不是再次清理。失败后应先查清原因；不要修改计划来绕过散列或并发校验。

## 同步与回退限制

- 旧页面在下一次同步跨过屏障时收到全量 state，现有 shared-store 替换 tasks/events/batches，不强制刷新或重新登录。正在编辑的无关任务草稿保留，正常保存继续。
- 停用的是已清理任务的内部 ID；后续 tasks、events、batches 引用这些 ID 时整个新事务返回 `409 TASK_REMOVED`。历史幂等重试使用经过裁剪的结果，不复活清理记录。
- 清理后禁止把业务路由回滚到 prod7 或任何不认识上述元数据的 API。需要修复时继续使用兼容版本；静态前端仍为 prod8，本轮不改变前端资源。
- 不能直接用准备时的整库备份覆盖正在作业的数据库，否则会丢失准备后新增的数据。需要恢复时先在新隔离库检查备份、核对后续写入，再设计受控的精准恢复；不覆盖生产库，不重置会话或 revision。

## 隔离验证

```text
python workbench-api/maintenance/verify-maintenance.py
node workbench-api/verify-maintenance-cleanup.cjs
```

两个 Python 文件须保持同目录。Python 测试只创建系统临时目录中的合成 SQLite，验证目标保护、备份/计划、回滚、并发 WAL、触发器恢复、幂等与 CLI；Node 测试另验证真实 HTTP、两服务共享 WAL、旧客户端缓存替换、旧会话和普通作业。测试不读取生产路径或实际任务。
