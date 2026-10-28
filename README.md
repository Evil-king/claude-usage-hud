# claude-usage-hud

**独立**的 Claude Code 终端状态栏：一行看清 当前模型 · 上下文占用 · 本会话 token · 预估费用 · 智谱 GLM 套餐 5 小时/周额度 · git 分支。零依赖、零插件冲突。

```
glm-5.3-flash[1m]  ctx 40%  tok 82.5M  ≈$22.17  5h 26%→20:53  wk 35%→11/2  max  git:main
```

## 为什么不再依赖 claude-hud

Claude Code 只有一个状态栏槽位。之前用“桥接”把 claude-hud 串在后面，但：
- claude-hud 会反复把 `settings.json` 的 `statusLine` 改回它自己（会话退出时把内存里的旧配置写回），桥接经常被覆盖；
- 你真正需要的上下文占用、活动统计，本脚本可以自己算。

现在本脚本独占状态栏，`ensure-statusline.mjs` 作为 **SessionStart 钩子**在每次会话启动时校正 `statusLine`——被覆盖也能自愈。想再串别的命令，把 `chainCommand` 填上即可。

## 显示内容

| 段 | 来源 | 说明 |
| --- | --- | --- |
| 模型 | 状态栏 stdin 的 `model.display_name`（`[1m]` 这类上下文后缀**保留**，用普通亮白跟在加粗模型名后面）；缺失时取最近一条消息的模型 | |
| `ctx 40%` | 最近一次请求的 prompt 大小（input + cache read + cache write）÷ 上下文窗口 | 窗口按模型推断：glm/deepseek 系 1M，claude 系 200k |
| `tok 82.5M` | 本会话 transcript 按**消息 id 去重**累加（输入/输出/缓存读/缓存写） | 与计费口径一致 |
| `≈$22.17` | 按内置费率表逐消息估算；Claude Code 若给出非 0 的 `cost.total_cost_usd` 则优先用官方的 | 订阅套餐下是牌价估算，不是账单 |
| `5h 26%→20:53` / `wk 35%→11/2` | 智谱 monitor 接口（同官网用量页），百分比为**已用**，箭头是重置时刻 | 60 秒磁盘缓存 |
| `max` | 套餐等级 | |
| `git:main` | 读 `.git/HEAD`（不 spawn git 进程），加粗亮青显示 | 非 git 目录则不显示；支持 worktree/submodule 与仓库子目录 |

配色：模型 = 加粗亮白；上下文后缀（`[1m]`）= 普通亮白；标签（ctx/tok/5h/wk/max/重置时刻）= 亮白；百分比 = 亮绿 <70% / 亮黄 <90% / 亮红 ≥90%；分支 = 加粗亮青。整体不用暗色 `dim`，暗色主题下也清晰。

## 安装

```bash
mkdir -p ~/.claude/usage-hud
cp statusline.mjs ensure-statusline.mjs ~/.claude/usage-hud/
cp config.example.json ~/.claude/usage-hud.json    # 填 glmAuthorization
```

1. **GLM 额度**（可选）：登录 [bigmodel.cn](https://bigmodel.cn) → F12 → Network → 任一请求的 `authorization` 请求头完整值 → 填到 `~/.claude/usage-hud.json` 的 `glmAuthorization`。留空则不显示额度段。
2. **`~/.claude/settings.json` 两处**：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /Users/you/.claude/usage-hud/statusline.mjs"
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node /Users/you/.claude/usage-hud/ensure-statusline.mjs" } ] }
    ]
  }
}
```

> 改这两处时**先完全退出 Claude Code**——运行中的会话会在退出时写回内存里的配置。装好钩子后，即使被写回，下次启动也会自动校正。

3. 完全退出并重开 Claude Code，随便说句话即生效。

## 配置（`~/.claude/usage-hud.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `glmAuthorization` | 空 | 智谱 monitor 接口的 authorization 请求头；留空则不显示额度段 |
| `chainCommand` | 空 | 可选：想串在后面的状态栏命令（stdin 会原样透传给它） |
| `quotaTtlSeconds` | 60 | 额度缓存秒数（10–3600） |
| `showCost` | true | 是否显示费用估算 |

## 费率表（每 1M token，USD，取自 harness 模型目录）

- `glm-5.3`：输入 1.4 / 输出 4.4 / 缓存读 0.26
- `glm-5.3-flash`：0.15 / 0.5 / 0.03
- `deepseek-flash`：0.15 / 0.6 / 0.003

未知模型只统计 token、不估算费用。加新模型改 `statusline.mjs` 顶部的 `PRICES`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `statusline.mjs` | 状态栏本体 |
| `ensure-statusline.mjs` | SessionStart 自愈钩子（校正 statusLine） |
| `config.example.json` | 配置模板 |
| `~/.claude/usage-hud.log` | 每次调用的诊断记录（会话 id / transcript / 模型 / 额度 / 输出），排查用 |

## 排查

模型名**完全来自 Claude Code 递进来的 stdin**：脚本不缓存，每次渲染都是新进程，所以改了脚本下一次渲染就生效。模型名没跟着 `/model` 变时，先看诊断日志：

```bash
tail -f ~/.claude/usage-hud.log | grep -o '"model":{[^}]*}'
```

| 日志里 | 结论 |
| --- | --- |
| 下一次渲染就变成新模型 | 正常，之前只是切到了别的窗口 / 面板 |
| 一直是旧模型 | `/model` 没落在该会话（比对 `sessionId`），或者 `settings.json` 的 `env` 只在进程启动时读取——改完要重开会话 |
| 来回跳 | 多个会话在写同一份日志，按 `sessionId` 分辨即可 |

`ANTHROPIC_MODEL` 这类 `env` 是**启动时的快照**：改 `settings.json` 对已在跑的会话无效，必须在会话里 `/model` 重选，或退出后 `claude --continue` 重开。

## 安全

`~/.claude/usage-hud.json` 含智谱会话 JWT，已在 `.gitignore`；不要提交。额度查询走官网同一接口，仅本地使用。

MIT License.
