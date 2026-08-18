# @dsh-external/ui-usage-stats

## 介绍

`ui-usage-stats` 是 DSH Web 客户端的“用量统计”插件。它在“设置”页面中新增“用量统计”页面，按 **工作区 → 会话 → 时段 → 模型** 展示 token 用量与费用，并提供每一层的总计、会话类型筛选、分叉去重、持久化缓存和增量计算能力。

## 安装

### 方式一：超级模组注入器

```text
dev_build_plugin  {"dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats"}
dev_inject_plugin {"dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats"}
```

打开或刷新 DSH Web，进入“设置 → 用量统计”。

### 方式二：dsh 命令安装（项目官方方式）

如果你已安装 `dsh` CLI，可以按项目官方教程使用 `dsh plugin` 命令安装：

```bash
# 从本地插件目录安装
dsh plugin --profile web add C:/Users/<user>/.dsh/plugins/ui-usage-stats

# 或从 GitHub 仓库安装
dsh plugin --profile web add github:xiyue718/dsh-ui-usage-stats
```

安装后启动：

```bash
dsh --profile web
```

查看组合配置：

```bash
dsh --profile web --dump-config
```

详细命令说明见项目文档：`docs/user/develop/basic/publish.md`。

构建产物：host 为 `lib/index.js`，client 为 `lib/client.js`，打包文件为 `dsh-external-ui-usage-stats-0.1.0.tgz`。

## 使用

1. 启动 DSH Web 客户端。
2. 打开“设置”面板。
3. 点击左侧或导航中的“用量统计”。
4. 等待统计加载完成，按工作区查看各会话、各时段、各模型的用量和费用。
5. 使用页面顶部的“总计”查看所有工作区汇总。
6. 在刷新行最右侧勾选或取消会话类型，页面只显示当前选中的类型。
7. 点击“刷新”会重新检查所有会话的 revision，仅重算更新过的会话。

## 功能

- 设置页新增入口：设置 → 用量统计。
- 展示字段：
  - 工作区路径
  - 会话 ID
  - 会话标题
  - 高峰/空闲时段
  - 模型
  - 未命中缓存 tokens（缓存未命中输入）
  - 命中缓存 tokens（缓存命中输入）
  - 输出 tokens
  - 费用（人民币）
- 层级总计：
  - 页面顶部“总计”：汇总所有工作区的用量与费用
  - 工作区总计
  - 会话总计
  - 时段总计
  - 模型行本身即为最细粒度
- 会话类型筛选：
  - 刷新行最右侧提供四个复选框：普通用户会话、子代理会话、分叉会话、其他会话
  - 默认只勾选“普通用户会话”
  - 页面仅展示当前选中类型对应的数据
  - 筛选状态通过项目 storage domain 持久化保存，刷新/重开页面后保持
- 聊天窗口统计行：
  - 自动将“缓存命中 xx%”替换为按真实 token 比例计算的“缓存命中 xx.xx%”，保留两位小数
  - 通过插件侧组件读取 tokenUsage 投影计算，不是简单补 `.00`，也不改动项目核心文件
- 排序：工作区和会话按最近修改时间（会话最后活动时间）倒序排列，不再按费用排序。
- 收缩：工作区、会话、时段标题均可点击展开/折叠，默认折叠，减少页面渲染量。
- 性能：host 侧并行读取会话日志，并直接从原始 JSONL 聚合 token，避免完整日志重放。
- 持久化缓存：每个会话的统计结果通过项目 storage domain 持久化保存；只有持久化 revision 变化的会话会重新读取并计算，未变化的会话直接复用缓存结果。
- 分叉去重：分叉会话继承自原会话的 `seedLength` 前缀聊天记录不会重复计入，只统计分叉后自己产生的用量。
- 点击“刷新”会重新检查所有会话的 revision，仅重算更新过的会话。

### 价格计算

按照 DeepSeek 官方峰谷定价，高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为空闲时段。

| 模型 | 时段 | 百万 tokens 输入（缓存命中） | 百万 tokens 输入（缓存未命中） | 百万 tokens 输出 |
|---|---|---|---|---|
| deepseek-v4-flash | 空闲 | 0.05 元 | 1.5 元 | 4.5 元 |
| deepseek-v4-flash | 高峰 | 0.10 元 | 3.0 元 | 9.0 元 |
| deepseek-v4-pro | 空闲 | 0.15 元 | 4.5 元 | 13.5 元 |
| deepseek-v4-pro | 高峰 | 0.30 元 | 9.0 元 | 27.0 元 |

费用公式：

```text
费用 = 未命中缓存 tokens / 1_000_000 × 未命中单价
     + 命中缓存 tokens / 1_000_000 × 命中单价
     + 输出 tokens / 1_000_000 × 输出单价
```

未在上表中的模型显示费用为 `0`。

### Host API

```http
GET /@dsh-external/ui-usage-stats/api/stats
```

```http
GET  /@dsh-external/ui-usage-stats/api/filters
POST /@dsh-external/ui-usage-stats/api/filters
```

## 原理

插件由 host 和 client 两部分组成。

Host 侧通过 `sessionPersistence.readRaw` 或 `sessionQuery.readSession` 读取会话日志，只关注 `assistant/message` 事件中的模型 `usage` 数据，按模型和高峰/空闲时段聚合未命中缓存、命中缓存、输出 tokens，再根据 DeepSeek 官方价格计算费用。分叉会话通过 `header.seedLength` 跳过继承自原会话的聊天记录，避免重复统计。

统计结果会以会话为单位缓存到 storage domain，缓存键为会话的持久化 revision；请求 `/api/stats` 时，只有 revision 变化的会话会重新读取日志并计算，未变化的会话直接复用缓存。多个会话使用并发数为 4 的 mapLimit 并行处理。最后按工作区路径分组，并按最近活动时间排序返回树形结果。

Client 侧渲染“用量统计”页面，调用 `/api/stats` 获取数据，按工作区、会话、时段、模型逐层展示，并提供折叠、总计、会话类型筛选和刷新操作。聊天窗口中的百分比修正由插件侧组件读取 tokenUsage 投影计算后显示为两位小数。
