# 梗判定指南（操作 agent 判定手册 v0.13）

本文档是 `meme surf` / `meme check` 榜单的操作判定指南：候选呈现什么、证据怎么读、收录/封禁/搁置如何决策。
判定依据 = 操作员 2026-11-22 两轮人工判定、2026-11-24 triggered 队列补标，以及 2026-11-25 确认的候选状态机与 CLI 工作流。
评估真梗集以 `scripts/replay.ts` 的 **TRUTH v5** 为准；`benchmarks/` 的人工标签只用于离线评估。

## 一、操作员硬约束（永远优先）

1. **评估标签禁入运行时**：TRUTH v5、`benchmarks/` 金标只能用于回放和评分，不得进入运行时词表、规则或提示。
2. **治理噪音只产出精确黑名单**：`meme ban <词头...>` 沉淀 `generic_auto`，`meme allow <词头...>` 可逆解除；不做子串或语义家族封禁。
3. **统计门不是语义判决**：话题词、普通词、泛夸词都可能过门；★只表示待人工判断。
4. gta6 类事件性词头收录时注明“谨慎采纳”，不与其他梗同等对待。

## 二、主判据：表述的形成时间

判定一个候选先问三个问题：

1. **形成时间**：这种表述此前（前几个月）不存在、近期才出现吗？管道不自动判定形成时间，由操作员按记忆与用例判断。
2. **典故/公式含义**：它承载事件引用（“生死不明那就是死了”）或可填槽公式（“学了三天<X>做出来的<Y>”）吗？
3. **新惯用用法**：它是旧词的新用法吗（“神了”= 哭笑不得式赞叹，不是普通夸赞）？

旧词用量突增（burst）不是形成时间证据；“神”系旧词回潮照样爆发。burst/keyness 只进排序，不参与触发。

## 三、候选行的读法

```
c_3293 "<X>来吧"  公式  3视频/3up  b=2  梗证3.0 泛回应? ★待判断
```

- **词头**：`<X>`=边缘槽，`<ent>`=内部间隙槽；紧凑连接是模板。
- **通道**：无标=固定表达，复读=整句字面复读，公式=带槽模板，图梗=pHash 图片簇，⛓=楼中楼接龙。
- **b=N**：Kleinberg 爆发等级，只代表用量突增，不影响触发。
- **梗证 N**：复读/骨架坍缩/独立成评/文本重复 + keyness + burst − 语义罚分。
- **n_usages / lifetime_volume / meme_score**：当前证据数、终身体量、纯特征分；`meme_score` 不含 keyness/burst/语义罚分。
- **标记**：`泛回应?` 否决触发；`泛夸?` 只罚分；`弱模板?`/`虚词核?` 否决 skeleton 触发。
- **★待判断**：已过当前统计触发门，不代表已确认是梗。每轮重算，失去资格会 demoted 回 pending。

触发门：存活 ≥2 轮、pending 至少 2 条有效用例（skeleton 至少 3 条）、绝对出现次数达线（phrase ≥10，copy/skeleton ≥15，image 跨视频 ≥8）、纯特征分 ≥0.7、无语义否决。独立成评只认归一化文本等于或严格包含候选完整形，模板按槽位形状另算。

## 四、失败模式判定清单

### 1. 专名/话题词 ≠ 梗

作品名/角色名/战队名提及量天然巨大。看用例是否“变着句子谈同一对象”：例句各不相同、语义都在谈论该对象 → 话题词，搁置或精确 ban。专名 ban 会挡住未来句式梗证据时，优先 `note add --head` 记录，不 ban。

### 2. 泛回应词 ≠ 梗

“是的/来啦/来吧/哦哦哦”可能高频复读并过统计门。带 `泛回应?` 的优先判定为非梗；确认是噪音变体后 `meme ban <精确词头>`。

### 3. 梗单元比词头大

真实梗常是完整句式或模板。若看到“启动”而证据支持“原神，启动”，收录时亲写完整标准形，并用 aliases 收家族变体。

### 4. 语法模式伪装成模板

`<X>分钟`/`<X>行了` 的槽位受语法限制，不是自由公式。弱模板/虚词核标记命中 → 判非梗。

### 5. 泛夸词也可能是真梗

“可爱/好看/天才/牛”是主要噪音，但泛夸云会覆盖真梗（如“神了”“可爱喵”）。带 `泛夸?` 必须回到 §二 主判据，不能机械拒绝。

### 6. 交互梗

完整形态是“前评—追评”配对。没有父评上下文的样本不进交互留出分母；至少需要一个有效触发对。例句可写“上句：X 本句：Y”。

## 五、决策树

```
候选带 泛回应? / 弱模板? / 虚词核?？
├─ 是 → 判非梗；确认是噪音再 ban 精确词头
└─ 否 → 按 §二 三问：
    ├─ 话题词/专名，用例只在谈论对象 → 搁置或精确 ban
    ├─ 事件性整句复读，无复用 → 搁置
    ├─ 泛夸? + 全是普通夸赞语境 → 搁置
    ├─ 有复读/化用/换词复用/槽位填充，或承载典故/公式 → 收录
    └─ 存疑 → note add --head 记疑点，等下一轮证据
```

**家族阅读法**：同一梗会以多形态立户（没绷住/绷住/绷了）。按家族给结论，收录为一个 entry，用 aliases 收变体；add/iterate 会自动收口 head 精确等于 canonical name/aliases 的 active 候选（跨通道）。

**模板收录**：entry matcher 用 skeleton tokens，examples 从不同填充中挑 3–5 条。交互梗必须保留父评上下文。

## 六、收录与回测契约

- `--cid` 可重复；`--text` 先精确、再仅在前缀/包含匹配唯一时解析，多义必须 `--cid`。所有 cid 写库前预检。
- 候选用例按 canonical evidence keys（name/实际 lex terms/skeleton 字面核心；`--match-aliases` 后别名才进入 lex terms）筛选：只保留命中完整形的用例，剔除截断宿主词的普通用法；空集报 `MEME_HOLDOUT_REQUIRED`，必须用可重复 `--holdout-text` 提供独立例句，不能回退污染全集。
- aliases 默认只做元数据、名字解析、重名守卫与家族收口；`--match-aliases` 才把非槽位 aliases 合并进 lex matcher。交互梗 aliases 不得绕过上下文。
- 纯向量词条恢复 matcher 需要独立野外/候选证据或显式留出；否则 `MEME_MATCHER_EVIDENCE_REQUIRED`，确认绕过可加 `--force` 并审计。
- `forced_vector_only` 按实际是否降级记录；`--force` 但 matcher 通过时记录 false。

## 七、语义层边界

1. 上下文离散度不能区分话题词与梗（韩立 0.648 ≈ 绷 0.696）；话题词靠人工。
2. 泛回应阈值边距薄；发现真梗误标，记 note 并向操作员报告。
3. 泛夸可分性中等，只罚分不否决。
4. keyness 需要 ≥8 天基线，burst 需要自身多天历史；缺失时判定靠人工。
5. 回放压缩时间线，keyness/burst 指标不代表生产排序。

## 八、部署生命周期与封禁

- **休眠**：末次证据超过 `surf_survive_rounds`（7）轮，不评估、不呈现；新证据唤醒。
- **低价值早清**：休眠且从未达体量线，直接删除。
- **28 天死亡**：pending/triggered 一视同仁；inducted 豁免。
- **状态重算**：每轮醒着的 pending/triggered 都重算；pending 达标 → triggered，triggered 失格 → pending。没有永久待裁决队列。
- **封禁**：精确归一化词头，跨 phrase/copy/skeleton/image；`ban “启动”` 不封 `<X>启动` 或 `启动器`。review.ts 按 phrase + skel 账本合计近 7 天出现量；零出现可考虑 `meme allow`。
- **原始湖留存**：开发期默认 0（不清理）；部署期设 7，接受历史不可重审的代价。群聊 `round_id=0` 行永不被留存清理。

## 九、常用命令

```sh
node lib/cli.js surf                       # 执行一轮并呈现当前过门条目
node lib/cli.js surf --no-fetch            # 不联网，但仍推进轮次、认领群聊、更新证据、重算状态与收割
node lib/cli.js check                      # 只读查看当前窗口过门条目
node lib/cli.js check --focus c_1234       # 只读查看完整证据（含父评）
node lib/cli.js check --page 1 --round-size 20
node lib/cli.js ban 启动 "<X>来吧"          # 精确词头，不做家族封禁
node lib/cli.js allow 启动                  # 精确解除
node lib/cli.js add --entry-file f --cid c_1 --cid c_2 --holdout-text "独立例句"
node lib/cli.js iterate m_0001 --entry-file f --match-aliases
npx tsx scripts/review.ts                  # 广泛审查 + phrase/skel 合计封禁复核
npx tsx scripts/replay.ts --rounds 99       # TRUTH v5 召回 + 负例侵入（只读临时库）
npx tsx scripts/rebuild.ts                 # 候选池重建预览；--apply 就地重建
```

`surf` 只负责执行轮次；焦点查看与分页统一使用 `check`。`rejected` 状态用于记录精确封禁，`allow` 可恢复对应候选；不提供 `remove`/`reject` 命令。
