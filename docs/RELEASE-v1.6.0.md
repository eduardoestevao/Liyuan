# Liyuan Agent 1.6.0

## 更新

### 桌面版
新增桌面安装包：Windows 便携版与安装版、macOS dmg、Linux AppImage，自带运行时，无需安装 Node.js。角色卡、会话与配置存放在独立的用户数据目录（默认「文档/Liyuan」），整体拷贝即迁移；桌面版内置更新检查。安装包未签名：Windows 首次运行需在 SmartScreen 选「仍要运行」，macOS 需清除隔离位（方法见源码包 RELEASE.txt）。

### 卡＝工作空间
每张角色卡是一个工作空间：卡 → 子项目 → 会话。会话、世界线、记忆随卡存放，卡目录可物理迁移；顶栏「新建」拆为新建项目与新建对话两项。跨会话记忆分层落卡文件夹，常驻摘要设有上限。

### 提示词三层体系
全局 SYSTEM.md（引擎协议）、APPEND_SYSTEM.md（身份契约）、卡档案 AGENTS.md（世界与写法）分层落位。提示词面板按此定名分栏，条目级编辑、开关与新增。

### 预设装载与转译
预设装载即转译为提示词条目，带来源标注；快速处理（默认，逐块声明约 30 秒）与深度处理（模型重组，分钟级）按预设自选。活动预设在库内展开拨开关，装卸与开关即时重转译；挂载的世界书随蓝灯镜像进卡档案。

### 工作模式
扮演会话内切换「扮演｜工作」：工作模式开放文件与代码工具，同一会话里改卡改前端；切回扮演后维护过程重新封闭。文件工具以卡目录为界。

### 角色卡工坊
顶栏进入工坊，与聊天区 4:6 分栏并立：结构账本、agent 预览验证、写卡手册分册。JSON 卡支持侧挂封面图。

### 界面
状态栏与会话并立分栏，输入框位置不再被占用；会话树两层展开；手机端右栏与大纲改为全屏抽屉。

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
| **Docker** | 仓库 `docker-compose.yml`，`docker compose up -d --build` |

桌面版解压或安装即用，无需任何环境。源码包需要 Node.js **≥ 22**，见包内 `RELEASE.txt`。

使用文档：https://docs.liyuan.pro

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 桌面版更新元数据（`latest.yml` / `latest-linux.yml`）随 Release 一并挂载，缺失则桌面端更新检查静默无效。
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。

## 提醒

梨园暂无官方适配的预设，导入的预设仍需自行调整。
