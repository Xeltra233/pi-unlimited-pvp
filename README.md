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
- 📌 **状态栏实时感知**：
  - 开启 PVP 时，底部状态栏显示 `PVP` 标记。
  - 关闭 PVP 或一次性模式成功后，状态栏标记自动移除。
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

| 命令 | 模式 | 说明 |
| :--- | :--- | :--- |
| `/pvp` | 常驻模式 | 开启无限重试常驻模式，状态栏显示 `PVP`；成功后继续保持。 |
| `/pvp on` | 常驻模式 | 与 `/pvp` 等价，显式开启常驻模式。 |
| `/pvp one` | 一次性模式 | 开启一次性重试模式，状态栏显示 `PVP`；**请求成功后自动关闭**。 |
| `/pvp off` | 关闭 | 手动关闭 PVP 模式，取消所有挂起重试，状态栏清除 `PVP`。 |

### 参数补全

输入 `/pvp ` 并按 `Tab` 键即可自动补全参数：`on`、`one`、`off`。

---

## 🔍 工作原理

1. **提示词与上下文记录**：在 `before_agent_start` 生命周期中记录用户输入的 prompt 文本与多模态图片。
2. **核心延迟规避**：在 `message_end` 中捕获异常响应并注入轻量标记，引导 Pi 内部核心分类器识别为不可内置回退错误，从而规避 Pi 内置的 `settings.retry` 指数退避与次数耗尽机制。
3. **结算后无缝唤醒**：在 `turn_end` 捕获失败并在 `agent_settled`（Agent 运行结算）后，通过事件循环微任务无延迟触发 `sendUserMessage`，以 `deliverAs: "followUp"` 无冲突复用上下文重试。
4. **成功判定与生命周期**：
   - 收到 `stop` 或 `length` 等正常终结信号即判定为成功。
   - 一次性模式（`one`）成功后自动执行 `disable()` 并发送通知。
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
