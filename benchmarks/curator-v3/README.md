# curator-v3 —— 2026-11-28 surf 增量定稿草案

`curator-v3` 是 `curator-v2` 的独立累积版，保留 v1/v2 数据与成绩。金标源为 [`candidate-judgment-v6`](../candidate-judgment-v6/)，候选来自 2026-11-27/28 六轮 B站 surf 增量。

> 当前状态：**草案，不跑模型评测**。等 benchmark 基本定稿后再进行大规模测试。

## 数据

- 种子候选：144 行，无金标字段。
- 家族：22 个（v2 的 13 个 + 本轮 9 个）。
- 噪音候选：136 个（`candidate_verdict=not-meme`，含真家族的截断候选头）。
- 查询：382 条 = 22 家族 ×5（2 正 + 3 负）+ 136 噪音候选 ×2。
- 排除在评分外：41 个暂缓/存疑 cid，见 [`excluded.json`](../candidate-judgment-v6/excluded.json)。

## 本轮新增 9 个家族

| family | canonical | 操作员裁定 |
|---|---|---|
| yu-ba-gu | 鱼八股 | 大肥鱼人格套话；通用“我认/这句话稳”不作独立 matcher |
| neng-gong-zhi-ren | 能工智人 | “人工智能”四字重排调侃 |
| nao-yu-zai | 闹鱼灾 | AI评论区/拟人鱼账号泛滥的固定比喻 |
| gu-gu-ge-ge | 谷谷歌歌 | Gemini 叠词人格昵称 |
| da-fei-yu | 大肥鱼 | DeepSeek 社区人格；只收完整“大肥鱼” |
| kong-bei-qie | 空悲切 | 操作员确认真梗 |
| chao-da-bei | 超大杯 | 表示“非常厉害”；普通容器尺寸作硬负例 |
| claude-da-xiao-jie | Claude大小姐 | “克劳德大小姐”也是别名；query 必须提供 AI/模型上下文 |
| wo-qu-zhen-x-le | 我去真\<X\>了 | 起源于“康神开播了？真的假的？我去真开播了” |

## 本轮明确排除/回退

- `AI味`：操作员判非梗，只作噪音负例。
- `此乃何物 / 这乃何物 / 不知天地为何物`：操作员回退，暂缓，不入金标。
- `够童`：语义/来源无法拿准，暂缓。
- `玩<X>抓不到<Y>`：明日方舟卫戍协议梗，Y 是 X 体系重要角色，“抓”=获取；证据不足暂缓。
- `<N>个<X>可以合成一个<Y>`：Y 是同领域更强但显然不能直接合成的事物；证据不足暂缓。

## 命令

```sh
export CURATOR_BENCH_ROOT=benchmarks/curator-v3
export CURATOR_GOLD_DIR=benchmarks/candidate-judgment-v6

npx tsx scripts/curator-seed.ts --export
npx tsx scripts/curator-queries.ts merge
npx tsx scripts/curator-queries.ts check
npx tsx scripts/curator-run.ts init --run-id R --model M
npx tsx scripts/curator-perfect.ts --run perfect
npx tsx scripts/curator-run.ts judge --run-id R --finish-reason X
npx tsx scripts/curator-run.ts verify --run-id R
npx tsx scripts/curator-score.ts --run R
```

PowerShell 用 `$env:CURATOR_BENCH_ROOT=...` / `$env:CURATOR_GOLD_DIR=...`。

## 验证边界

- 查询集机械校验已通过：382 条、22 家族、噪音覆盖 136/136；2 条“超大杯”普通容器负例标记为 `constraint-dependent`，由满分库不收录裸“超大杯”的 matcher 兜住。
- 本轮只做数据导出、查询合并与机械校验；不运行答题模型，不跑空库/满分库评测。
- v1/v2 的既有基线与模型成绩保留，不被本草案覆盖。
