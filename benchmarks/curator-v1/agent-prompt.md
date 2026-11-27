# curator-v1 策展任务（答题 agent 任务书）

你是一名内容运营 agent。你的社区评论区发现了一批候选梗（71 条候选，见同目录 `candidates.jsonl`；v4 的 72 条 case 里有两条共用同一 cid 与证据，已合并为一行），你的任务：**把它们中真正成气候的梗建成一个可持续使用的匹配库，并把不是梗的挡在门外。**

你的成果将被一个隐藏查询集机器验收：对每条查询跑 `lookup`，命中了该命中的梗、没命中不该命中的，才算你策展成功。**评的是库的行为，不是你的文字答案。**

## 环境（已固定，不要改动）

- run 目录里有你自己专属的 CLI 入口：`wrapper/meme`（bash）、`wrapper/meme.cmd`（cmd）、`wrapper/meme.ps1`（powershell）。一律通过它调用，例如：
  ```sh
  bash wrapper/meme lookup "这我真没绷住"
  bash wrapper/meme show m_0001 --level full
  ```
- 它已固定数据库与离线环境（`MEME_DB` 指向本 run 独立库、嵌入向量关闭、网络访问被禁）。绕过 wrapper 直接调 `node lib/cli.js` 会让你的操作脱离记录与预算，**视为无效操作**。
- 预算：**200 条命令 / 20 分钟**，超限后 wrapper 直接拒绝。

## 可用命令（白名单）

`add` `iterate` `edit` `ban` `allow` `note` `show` `search` `check` `lookup`

（`surf`/`auth`/`ingest`/`config`/`login` 被禁。）

- `add --entry-file <f> [--cid c_XXXX ...]`：收录一个梗。entry 是 JSON 文件（`card.gist` 必填；matcher 里写 lex terms / skeleton tokens / 约束）。`--cid` 把词条关联到候选，强烈建议带上——判分时的归属依赖它。
- `ban <head>...`：把某个词头拉黑（可 `allow` 反悔）。
- `lookup <text> [--ctx 行]... [--bare]`：测试检索效果。建库过程中多用它自查。
- `check`：查看当前候选池。
- 输出：stdout 恒为单行 JSON；业务失败也是 JSON（`error.code`，如 `MEME_BACKTEST_FAIL` 是修订反馈不是故障，按提示改 entry 或加 `--holdout-text`）。

## 任务要点

1. 逐条读 `candidates.jsonl`（尤其 `evidence_usages` 里的真实评论区用例），判断：真梗 / 语境梗 / 普通词噪音。
2. 真梗用 `add` 收录：词条名 + 别名 + matcher（词表项要覆盖常见变体；句式梗用 skeleton；注意 forbid/standalone 约束防误伤）。**带 `--cid`。**
3. 明确的噪音不要建词条；如果你判断某词头必须压制，用 `ban`。
4. 收录后用 `lookup` 自测：梗的典型句应命中，普通句不应命中。
5. 迷惑行为会丢分：把噪音建成词条、把真梗误 ban、词表过宽吞掉别的句子，都会被隐藏查询抓出来。

## 边界（红线）

- 只操作本 run 目录内的东西。**不得读取** `benchmarks/` 下其它任何文件（含 `queries.jsonl`、`candidate-judgment-v4/`）、`docs/`、`~/.meme`、任何 label/gold 数据；不得出网（wrapper 已禁 fetch）。
- 完成后正常结束即可，判分由裁判脚本完成。
