# Liyuan Agent 1.6.0

本次更新主题：整体重做

## 更新

### 桌面版
新增桌面版。

### 扮演引擎回归 pi
内核回归 pi 0.84.4，扮演轮改为原生 agent 循环。

### 卡＝工作空间
每张卡是一个工作空间，卡 → 子项目 → 会话两层布局；会话、世界线、账本与记忆随卡存放，卡目录可整体迁移。顶栏「新建」拆为新建项目与新建对话。

### 提示词三层体系
全局 SYSTEM.md（引擎协议）、APPEND_SYSTEM.md（身份契约）、卡档案 AGENTS.md（世界与写法）分层落位。提示词面板按层分栏，条目可编辑、可开关。

### 预设装载与转译
预设装载即转译为带来源标注的提示词条目，可在库内逐块拨开关，装卸即时生效；快速处理（默认，约 30 秒）与深度处理（模型重组，分钟级）按预设自选。挂载的世界书随蓝灯镜像进卡档案。

### 工作模式与角色卡工坊
扮演会话内切换「工作」模式即可开放文件与代码工具，直接改卡改前端，切回扮演后维护过程封闭；文件工具以卡目录为界。工坊与聊天区 4:6 分栏并立，提供结构账本、预览验证与写卡手册。

### 前端重排

---

## 安装包

| 平台 | 文件 |
|------|------|
| Windows 桌面安装版 | `Liyuan-1.6.0-win-desktop-setup.exe` |
| Windows 桌面便携版 | `Liyuan-1.6.0-win-desktop-portable.zip` |
| macOS 桌面版 | `Liyuan-1.6.0-mac-desktop-arm64.dmg` · `Liyuan-1.6.0-mac-desktop-x64.dmg` |
| Linux 桌面版 | `Liyuan-1.6.0-linux-desktop.AppImage` |
| Windows 源码包 | `Liyuan-1.6.0-windows.zip` |
| Linux 源码包 | `Liyuan-1.6.0-linux.zip` |
| macOS 源码包 | `Liyuan-1.6.0-macos.zip` |
| 校验 | `SHA256SUMS.txt` |
| **Docker** | 仓库 `docker-compose.yml`，`docker compose up -d --build`（更新同样走 `--build`） |

> 装了旧版的用户，主页会出现「新版本 v1.6.0」提示，点开即可一键升级；桌面版通过内置更新检查升级。

## 快速开始

桌面版解压或安装即用。源码包见包内 `RELEASE.txt` / `start.bat` · `start.sh` · `start.command`，需要 Node.js **≥ 22**。

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 使用文档：https://docs.liyuan.pro
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。

## 提醒

梨园暂无官方适配的预设，导入的预设仍需自行调整。
