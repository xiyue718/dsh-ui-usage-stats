# @dsh-external/ui-usage-stats

在 DSH Web 客户端的“设置”页面中新增一个“用量统计”页面。

页面按 **工作区 → 会话 → 时段 → 模型** 展示 token 用量与费用，并给出每一层的总计。

## 功能详情

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
- 持久化缓存：每个会话的统计结果通过项目 storage domain 持久化保存；只有持久化 revision 变化的会话会重新读取并计算，未变化的会话直接复用缓存结果，显著提升整体计算效率。
- 分叉去重：分叉会话继承自原会话的 `seedLength` 前缀聊天记录不会重复计入，只统计分叉后自己产生的用量。
- 点击“刷新”会重新检查所有会话的 revision，仅重算更新过的会话。

## 价格计算

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

## Host API

```http
GET /@dsh-external/ui-usage-stats/api/stats
```

```http
GET  /@dsh-external/ui-usage-stats/api/filters
POST /@dsh-external/ui-usage-stats/api/filters
```

响应结构：

```json
{
  "generatedAt": 1786858398464,
  "workspaces": [
    {
      "path": "E:\\Git\\deepseek-harness",
      "cacheMissTokens": 0,
      "cacheHitTokens": 0,
      "outputTokens": 0,
      "cost": 0,
      "sessions": [
        {
          "sessionId": "session-xxx",
          "title": "会话标题",
          "cwd": "E:\\Git\\deepseek-harness",
          "cacheMissTokens": 0,
          "cacheHitTokens": 0,
          "outputTokens": 0,
          "cost": 0,
          "periods": [
            {
              "id": "peak",
              "label": "高峰时段",
              "cacheMissTokens": 0,
              "cacheHitTokens": 0,
              "outputTokens": 0,
              "cost": 0,
              "models": [
                {
                  "model": "deepseek-official/deepseek-v4-flash",
                  "cacheMissTokens": 0,
                  "cacheHitTokens": 0,
                  "outputTokens": 0,
                  "cost": 0
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## 安装到其他 DSH 客户端

与 `@dsh-external/ui-prompt-optimizer` 相同，支持三种方式。

### 方式一：超级模组注入器（推荐，不修改项目文件）

1. 复制插件目录或解压 `dsh-external-ui-usage-stats-0.0.1.tgz`。
2. 在目标 DSH 会话中执行：

   ```text
   dev_build_plugin  {"dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats"}
   dev_inject_plugin {"dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats"}
   ```

3. 打开或刷新 DSH Web，进入设置 → 用量统计。

### 方式二：本地 bundle 装配

```text
dev_install_package {
  "dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats",
  "profile": "web"
}
```

### 方式三：手动 bundle 配置

将插件目录放入目标 DSH 可解析位置，在 profile 的 `package.json` 中声明依赖和 `bundles` 条目，然后重启 DSH Web。

## 使用步骤

1. 启动 DSH Web 客户端。
2. 打开设置面板。
3. 点击左侧或导航中的“用量统计”。
4. 等待统计加载完成，按工作区查看各会话、各时段、各模型的用量和费用。

## 常见问题

- **页面长时间显示“加载中…”**：统计需要读取全部会话日志，会话较多或日志较大时会比较慢，可等待或点击刷新重试。
- **费用显示为 0**：当前模型不是 `deepseek-v4-flash` / `deepseek-v4-pro`，或日志中没有可识别的 token 用量。
- **设置页没有“用量统计”入口**：确认插件已注入成功并刷新浏览器页面。

## 构建产物

- host：`lib/index.js`
- client：`lib/client.js`
- 打包文件：`dsh-external-ui-usage-stats-0.0.1.tgz`
