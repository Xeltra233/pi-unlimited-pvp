# pi-unlimited-pvp

Pi 编码智能体（Pi Coding Agent）的无限自动重试插件。

用户在 Pi 中输入 `/pvp` 即可开启自动重试模式：在模型请求或网络失败时**无限自动重试**，**不用冷却**（0 延迟调度），**不受默认重试次数限制**，直到请求成功或用户主动停止。

---

## 🌟 核心特性

- ⚡ **无冷却立即重试（Zero Cooldown）**：绕过 Pi 内置的指数回退延迟（2s、4s、8s 等），在请求失败并结算后立即重新发起。
- ♾️ **无限次重试（Unlimited Retries）**：突破 Pi 默认 3 次重试上限，自动循环重试直至成功。
- 🎯 **双重运行模式**：
  - **常驻模式（`/pvp` 或 `/pvp on`）**：PVP 状态持续生效；单次请求成功后依然保持开启，适合不稳定网络或高频调优。
  - **一次性模式（`/pvp one`）**：开启后遇到失败无限自动重试，**一旦模型请求成功便自动关闭 PVP 模式**。
- 📌 **无缝融入原生 TUI 的固定指示（防滚走）**：
  - 采用组件工厂直接渲染，消除 Pi 内置字符串组件的强制左侧边距，实现 **0 缩进顶格对齐**，与上方的 Git 分支及终端左边缘 100% 垂直平齐。
  - 严格遵循原生状态栏设计规范，使用标准小写字形（`pvp on` / `pvp one`）与主题中性灰阶（`theme.fg("muted")`），字体大小、行高、基线完全对齐，低调舒适不刺眼。
  - 采用 Pi UI 的 Widget 机制（`placement: "belowEditor"`）将状态挂载在输入框下方，并同步更新底部状态栏 `setStatus`，即使聊天产生海量文本向上滚动，状态依然清晰常驻。
  - 关闭 PVP 或一次性模式成功后，挂件与状态栏标记均自动彻底移除。
- 💬 **极简明了的切换提示**：
  - 切换模式时统一以最简洁的形式提示：`PVP ON`、`PVP ONE`、`PVP OFF`，绝不输出啰嗦多余的长句子。
- 🛡️ **安全清理与中断响应**：
  - 用户按下 `Ctrl+C` 主动 abort 或关闭时，立即取消待执行重试并清理计时器。
  - 会话退出或切换（`session_shutdown`）自动完成全量状态清理，防止悬挂任务。

---

## 📦 安装方法

### 方式 1：通过 Git 远程一键安装（推荐）

在终端中运行以下命令，Pi 会自动克隆并添加到全局配置中（`~/.pi/agent/settings.json`）：

```bash
pi install https://github.com/Xeltra233/pi-unlimited-pvp
# 或使用 git 协议简写
pi install git:github.com/Xeltra233/pi-unlimited-pvp
```

如果只想在当前项目生效，可加上 `-l` 参数：

```bash
pi install -l https://github.com/Xeltra233/pi-unlimited-pvp
```

### 方式 2：本地目录指令安装

如果已经将代码克隆到本地，也可以直接使用 `pi install` 指定本地路径安装：

```bash
pi install /path/to/pi-unlimited-pvp
# 或在项目根目录下直接运行
pi install .
```

### 方式 3：单次免安装试用

无需安装到配置，仅在本次会话中加载：

```bash
pi -e git:github.com/Xeltra233/pi-unlimited-pvp
# 或指定本地路径
pi -e /path/to/pi-unlimited-pvp
```
---

## 🚀 使用指南

进入 Pi 交互会话后，直接在输入框输入以下命令：

| 命令 | 模式 | 交互提示 | 显示位置与行为 |
| :--- | :--- | :--- | :--- |
| `/pvp` | 常驻模式 | `PVP ON` | 开启无限重试常驻模式，输入框下方与状态栏均原生呈现顶格对齐的 `pvp on`（不随聊天滚动）；成功后继续保持。 |
| `/pvp on` | 常驻模式 | `PVP ON` | 与 `/pvp` 等价，显式开启常驻模式。 |
| `/pvp one` | 一次性模式 | `PVP ONE` | 开启一次性重试模式，输入框下方与状态栏均原生呈现顶格对齐的 `pvp one`；**模型成功后自动关闭并提示 `PVP OFF`**。 |
| `/pvp off` | 关闭 | `PVP OFF` | 手动关闭 PVP 模式，取消所有挂起重试，彻底清理常驻挂件与状态栏。 |

### 参数补全

输入 `/pvp ` 并按 `Tab` 键即可自动补全参数：`on`、`one`、`off`。

---

## 🔍 工作原理

1. **原生就地重试（In-Place Retry）**：当开启 PVP 模式时，插件深度联动 Pi 核心 Agent 运行循环，在模型请求或网络失败时直接在底层状态机就地继续（`agent.continue()`），**绝不通过发送新消息来模拟重试**，不污染聊天历史与上下文。
2. **解除限制与零延迟调度**：接管 Pi 的重试判定与退避逻辑，突破默认的 3 次重试上限与指数回退延迟（2s、4s、8s 等），实现无冷却即时无限重试。
3. **状态同步与尝试计数**：重试发生时实时更新挂载在输入框下方的 widget 与底部状态栏标记（`pvp on (第 X 次重试)`），清楚感知当前重试进度。
4. **成功判定与生命周期**：
   - 收到 `stop` 或 `length` 等正常终结信号即判定为成功，重试计数清零。
   - 一次性模式（`one`）成功后自动执行 `disable()` 并发送 `PVP OFF` 通知。
   - 用户主动按下 `Ctrl+C` 中断时立即停止重试，重试计数清零。
---

## 🛠️ 本地开发与测试

本项目使用 TypeScript 与 Vitest 构建：

```bash
# 安装依赖
npm install

# 类型检查
npm run typecheck

# 运行自动化测试套件
npm test

# 生产构建
npm run build
```

---

## Pi 版本兼容

0.2.1 已用真实 pi CLI 验证以下版本：

| Pi 版本 | 失败回复处理 |
| --- | --- |
| 0.84.2、0.84.3、0.84.4 | 内存上下文移除 |
| 0.85.0、0.85.1 | 内存上下文移除 |
| 0.86.0、0.86.1 | 内存上下文移除，保留宿主取消标记 |
| 0.87.0、0.87.1 | 原生持久化上下文排除（`_omitRecoveryAttempt`） |

0.87 起，Pi 从会话记录重建模型上下文；旧插件只删除内存消息会导致失败回复重新出现，并报 `Cannot continue from message role: assistant`。现在按宿主能力选择处理方式，不重复发送用户提示词。旧版的运行中取消也会阻止随后发生的 PVP 重试。

每个版本验证 5 个真实 CLI 场景：`one`、`on` 连续失败 3 次后成功；`off` 不重试；失败后 abort；失败后关闭。测试使用本地 HTTP 模型服务、独立配置目录，关闭 Pi 原生重试，不使用真实凭据。界面样式没有改动；本轮没有进行 TUI 视觉验收。

```bash
# 测试当前开发依赖的真实 CLI
node test/compat-cli.mjs
# 测试另一个已安装版本（目录中需有该版本的 package.json 和依赖）
node test/compat-cli.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
# 更新已通过 Git 安装的插件
pi update https://github.com/Xeltra233/pi-unlimited-pvp
```

更新后在已打开的 Pi 会话运行 `/reload`，或重新启动 Pi。插件依赖宿主内部方法，未验证版本不承诺兼容；缺失必要接口时会明确报错。

---

## 🗑️ 卸载方法

1. 若通过 `pi install` 安装：
   ```bash
   pi remove pi-unlimited-pvp
   ```
2. 若在 `settings.json` 中配置：
   从 `extensions` 数组中移除对应路径即可。

---

## 📄 开源许可

[MIT License](LICENSE)
