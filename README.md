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
  - 严格遵循 Pi 原生主题设计，调用 `theme.fg` 与当前主题配色自动对齐（常驻模式 `accent` 强调色、一次性模式 `warning` 琥珀色、重试状态 `dim` 暗色），绝无突兀失配。
  - 使用等高单宽标准圆点（`●`）取代双宽彩色 Emoji，字符大小与行高完全平齐，绝不撑大终端行高或产生违和感。
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
| `/pvp` | 常驻模式 | `PVP ON` | 开启无限重试常驻模式，输入框下方与状态栏均原生呈现 `● PVP ON`（不随聊天滚动）；成功后继续保持。 |
| `/pvp on` | 常驻模式 | `PVP ON` | 与 `/pvp` 等价，显式开启常驻模式。 |
| `/pvp one` | 一次性模式 | `PVP ONE` | 开启一次性重试模式，输入框下方与状态栏均原生呈现 `● PVP ONE`；**模型成功后自动关闭并提示 `PVP OFF`**。 |
| `/pvp off` | 关闭 | `PVP OFF` | 手动关闭 PVP 模式，取消所有挂起重试，彻底清理常驻挂件与状态栏。 |

### 参数补全

输入 `/pvp ` 并按 `Tab` 键即可自动补全参数：`on`、`one`、`off`。

---

## 🔍 工作原理

1. **提示词与上下文记录**：在 `before_agent_start` 生命周期中记录用户输入的 prompt 文本与多模态图片。
2. **核心延迟规避**：在 `message_end` 中捕获异常响应并注入轻量标记，引导 Pi 内部核心分类器识别为不可内置回退错误，从而规避 Pi 内置的 `settings.retry` 指数退避与次数耗尽机制。
3. **结算后无缝唤醒**：在 `turn_end` 捕获失败并在 `agent_settled`（Agent 运行结算）后，通过事件循环微任务无延迟触发 `sendUserMessage`，以 `deliverAs: "followUp"` 无冲突复用上下文重试。
4. **成功判定与生命周期**：
   - 收到 `stop` 或 `length` 等正常终结信号即判定为成功。
   - 一次性模式（`one`）成功后自动执行 `disable()` 并发送 `PVP OFF` 通知。
   - `toolUse` 作为工具调用的中间状态，保证工具执行链路不断裂。

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
