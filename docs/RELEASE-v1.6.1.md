# Liyuan Agent 1.6.1

## 修复

### 桌面版与原地更新漏发提示词槽位

1.6.0 桌面安装包未打入 `AUTHORING.md`，装包后每一拍开演失败；从 1.5.x 原地更新上来同样缺席。现按 `assets/*.md` 整取，原地更新同步同一批槽位文件。

### 悬浮球菜单

菜单挂在球旁边，不再把球顶出屏幕。触屏点球不会误开第一项。

### 其它

- 固定楼层压缩周期改完不再跳回 30。
- 手机端有会话记录时主页铺满，不再保持空态布局。
- 连接不稳不再打断正在写的稿；真断线标签有 3 秒静默窗口。
- 导入角色卡时，内嵌世界书可选择导入并挂载、导入暂不挂载、或不导入。
- 导入或新建的卡立即落成卡空间，会话落到卡的子项目里。
- 昼夜切换移到抽屉「设置」按钮上方。

## 更新

### Docker 预构建镜像

`ghcr.io/weidu12123/liyuan` 双架构镜像可直接拉取，免去服务器构建。见 `deploy/compose.ghcr.yml`。

---

## 安装包

| 平台 | 文件 |
|------|------|
| Windows 桌面安装版 | `Liyuan-1.6.1-win-desktop-setup.exe` |
| Windows 桌面便携版 | `Liyuan-1.6.1-win-desktop-portable.zip` |
| macOS 桌面版 | `Liyuan-1.6.1-mac-desktop-arm64.dmg` · `Liyuan-1.6.1-mac-desktop-x64.dmg` |
| Linux 桌面版 | `Liyuan-1.6.1-linux-desktop.AppImage` |
| Windows 源码包 | `Liyuan-1.6.1-windows.zip` |
| Linux 源码包 | `Liyuan-1.6.1-linux.zip` |
| macOS 源码包 | `Liyuan-1.6.1-macos.zip` |
| 校验 | `SHA256SUMS.txt` |
| **Docker** | 预构建镜像 `ghcr.io/weidu12123/liyuan:1.6.1`（`deploy/compose.ghcr.yml`）；或仓库 `docker-compose.yml` 本地构建 |

> 装了旧版的用户，主页会出现「新版本 v1.6.1」提示，点开即可一键升级；桌面版通过内置更新检查升级。1.6.0 桌面包请改用本版，不要继续装 1.6.0。

## 快速开始

桌面版解压或安装即用。源码包见包内 `RELEASE.txt` / `start.bat` · `start.sh` · `start.command`，需要 Node.js **≥ 22**。

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 使用文档：https://docs.liyuan.pro
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。

## 提醒

梨园暂无官方适配的预设，导入的预设仍需自行调整。
