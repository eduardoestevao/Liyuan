# Liyuan Agent 1.5.4

## 修复

- 重型角色卡的加载：客户端不再对服务端已处理过的正文重复应用显示正则，打开卡与其后点开面板不再有整段无响应。
- 用户角色未注入：预设声明了人设槽位而人设正文为空时，用户名与人设双双缺席，模型不知道用户扮演谁；现已无条件送达。

---

## 安装包

| 平台 | 文件 |
|------|------|
| Windows | `Liyuan-1.5.4-windows.zip` |
| Linux | `Liyuan-1.5.4-linux.zip` |
| macOS | `Liyuan-1.5.4-macos.zip` |
| 校验 | `SHA256SUMS.txt` |
| **Docker** | 仓库 `docker-compose.yml`，`docker compose up -d --build` |

> 装了旧版的用户，主页会出现「新版本 v1.5.4」提示，点开即可一键升级。

## 快速开始

见各包内 `RELEASE.txt` / `start.bat` · `start.sh` · `start.command`。需要 Node.js **≥ 22**。

## 说明

- 不含个人 API Key、私有角色卡或运行时会话数据。
- 许可证：PolyForm Noncommercial 1.0.0（个人/非商业）。

## 提醒

梨园暂无官方适配的预设，导入的预设仍需自行调整。
