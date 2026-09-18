# HarnessWindTunnel 缰绳风洞

给 AI Agent 脚手架做风洞实验：固定模型与任务，对 20 个 harness 模块做受控消融与反事实对比，经人的批准做可回滚演化。

**Agent = 模型 + 脚手架。** 模型能力已经趋同，任务能不能可靠做完，取决于模型之外的执行脚手架——循环、工具、记忆、上下文压缩、校验器、权限门。现有工具要么只回放单次轨迹，要么是黑盒自动改脚手架的研究代码。这里是一台**风洞**：用受控实验证清每个模块的边际作用，再把失败炼成一条经过验证、人批准、可回滚的配置改动。

## 两分钟看懂

同模型、同任务、两套脚手架：**34% 对 77%**。差距不在模型。点进 12 步一键演示（`#/demo`），看一次失败是怎么变成一条配置改动的。

三屏一闭环：

1. **运行透视**（`#/insight`）——模型每一步看到了什么：分层上下文栈、五级压缩管线、校验器裁决、失败标签。
2. **风洞**（`#/tunnel`）——拨 20 个模块的开关，多配置并排对比（成功率、相对基线 Δ、token、时延、失败迁移），双轨迹逐步对齐到第一个分叉点。
3. **演化炉**（`#/forge`）——失败聚类、改动卡（带预测区间）、风洞证伪、人批准、版本树提交、一键回滚。

核心结论：**零件多不等于好**。加个验证器，跨应用任务掉 8.4 个点；先把范围写进文件，涨 5.5 个点。不做受控消融永远看不见。

## 跑起来

```bash
npm install
npm run dev        # 数据服务 :4000 + 页面 :5173
```

打开 http://localhost:5173/#/demo 进演示。不用 Key、不用联网——默认离线档，回放确定性 fixtures。

| 命令 | 干什么 |
|---|---|
| `npm run dev` | 数据服务＋页面一起起 |
| `npm run build` / `typecheck` | 打包 / 类型检查 |
| `npm test` | 文案＋数据测试 |
| `npm run check:paper` | 26 项断言：预设读数与引用论文一致 |
| `npm run gen:fixtures` | 从 `scripts/gen-fixture.ts` 重新生成 `data/`（禁止手改 JSONL） |

## 数据诚实标注

每个数字、每条轨迹都带来源徽标，三类绝不混标：

- `fixture`——演示用的剧本数据，保证稳定可复现
- `paper-reproduction`——方向与 Δ 引自论文，基线为示意
- `live`——连你自己配的模型跑出来的

一键论文预设（风洞空状态载入）：**NLAH** 受控消融（arXiv:2603.25723）、**AHE** 十代爬升 69.7%→77.0%（arXiv:2604.25850）、**Harness-R1** 反例 41.6%→35.4%（arXiv:2608.02276）。

## 失败标签

12 个一等标签＋`other`，对齐 MAST（arXiv:2503.13657，FM-1.1～FM-3.3）并按任务族补齐，映射表与逐条复查见 PRD §2.5。

## 目录

```
shared/        # 20 字段配置 DSL、事件结构、失败标签、论文预设
src/screens/   # 一键演示、运行透视、风洞、演化炉
src/stores/    # 回放、对照、演化三份状态
server/        # 数据服务（:4000）：回放＋读数接口
scripts/       # 数据生成、论文对数、文案测试
data/          # 生成的数据（场景×分支＋演化曲线），勿手改
HarnessWindTunnel-PRD-v1.1.html   # 产品需求文档
harness-research-v0.5.html        # 背后的调研报告
```

## 引用

- MAST：Why Do Multi-Agent LLM Systems Fail?（arXiv:2503.13657）
- NLAH：Natural-Language Agent Harnesses（arXiv:2603.25723）
- AHE：Agentic Harness Engineering（arXiv:2604.25850）
- Harness-R1（arXiv:2608.02276）、AutoHarness（arXiv:2603.03329）、Airbnb PRISM（arXiv:2609.05736）、L-MARS（arXiv:2509.00761）

## 原则

离线档默认零副作用（外发、写盘、花钱全是模拟）。铁律：先风洞证伪再下结论，改动必须人批准，永远可回滚。

## License

MIT — 见 [LICENSE](LICENSE)。
