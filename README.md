# claude-usage-hud

在 **Claude Code 终端状态栏**里实时显示：当前模型、本会话 token 用量、预估费用，以及 **智谱 GLM 编程套餐的 5 小时 / 每周额度百分比与重置时间**。

```
GLM-5.3  tok 128.4k  ≈$0.42  5h 59%→17:10  wk 11%→11/2  max
<原有 claude-hud 输出照常显示在下面>
```

## 为什么是“桥接”

Claude Code 只有一个 statusline 槽位。这个脚本读入 Claude Code 喂给状态栏的 JSON，先打印自己那一行，再把**同一份 stdin 原样**交给链式的原有命令（比如 claude-hud），把它的输出接在后面——两者都保留，互不干扰。

## 安装

```bash
mkdir -p ~/.claude/usage-hud
cp statusline.mjs ~/.claude/usage-hud/
cp config.example.json ~/.claude/usage-hud.json   # 然后填 glmAuthorization / chainCommand
```

1. **GLM 额度**（可选，不填就不显示）：登录 [bigmodel.cn](https://bigmodel.cn) → F12 → Network → 任一请求的 `authorization` 请求头完整值，填到 `~/.claude/usage-hud.json` 的 `glmAuthorization`。
2. **链式原有状态栏**（可选）：把 `~/.claude/settings.json` 里原来的 `statusLine.command` 整串复制到 `chainCommand`，然后把 `statusLine` 改成：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /Users/you/.claude/usage-hud/statusline.mjs"
  }
}
```

改完重启 Claude Code（或新开会话）生效。

## 显示内容

| 段 | 来源 | 说明 |
| --- | --- | --- |
| 模型 | 状态栏 stdin 的 `model.display_name`（去掉 `[1M]` 等后缀） | |
| tok | 本会话 transcript 按**消息 id 去重**累加（输入/输出/缓存读/缓存写） | 与实际计费口径一致 |
| ≈$ | transcript 中每条消息的模型单价估算；若 Claude Code 自己给了 `cost.total_cost_usd`（非 0）则优先用官方的 | 订阅套餐下为“按牌价估算”，不是账单 |
| `5h` / `wk` | 智谱 monitor 接口（同官网用量页），百分比为**已用**，箭头后是重置时刻 | 60 秒磁盘缓存，不拖慢刷新 |
| `max` | 套餐等级 | |

## 配置项（`~/.claude/usage-hud.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `glmAuthorization` | 空 | 智谱 monitor 接口的 authorization 请求头；留空则不显示额度段 |
| `chainCommand` | 空 | 原有状态栏命令，原样透传 stdin |
| `quotaTtlSeconds` | 60 | 额度查询缓存秒数（10–3600） |
| `showCost` | true | 是否显示费用估算 |

## 费率表

内置本机实际使用的路由单价（每 1M token，USD，取自 harness 模型目录）：

- `glm-5.3`：1.4 / 4.4 / 缓存读 0.26
- `glm-5.3-flash`：0.15 / 0.5 / 0.03
- `deepseek-flash`：0.15 / 0.6 / 0.003

未知模型只统计 token、不估算费用（不会瞎猜）。要加新模型，改 `statusline.mjs` 顶部的 `PRICES`。

## 安全

`~/.claude/usage-hud.json` 含 bigmodel 会话 JWT，已在 `.gitignore` 中；不要提交。额度走官网同一接口，仅供本地查看。

MIT License.
