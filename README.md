# FastClaw QQ Bot Plugin

QQ Bot channel plugin for [FastClaw](https://github.com/fastclaw-ai/fastclaw), using the official [QQ Bot API](https://bot.q.qq.com/wiki/).

## 安装

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/junbaor/fastclaw-qqbot/master/scripts/install.sh \
  | bash -s -- --token "YOUR_APPID:YOUR_SECRET"
```

### Windows (PowerShell)

```powershell
$env:QQBOT_TOKEN = "YOUR_APPID:YOUR_SECRET"
irm https://raw.githubusercontent.com/junbaor/fastclaw-qqbot/master/scripts/install.ps1 | iex
```

或下载后执行：

```powershell
.\install.ps1 -Token "YOUR_APPID:YOUR_SECRET"
```

安装脚本会自动：
- 下载对应平台的二进制文件到 `~/.fastclaw/plugins/qqbot/`
- 更新 `fastclaw.json` 配置（appId、clientSecret、binding）

安装完成后重启即可：

```bash
fastclaw daemon restart
```

> **注意：** 确保你的机器人在 QQ 开放平台上**没有配置「消息 URL / 回调地址」**，否则事件会走 Webhook 而不是 WebSocket，插件将无法收到消息。

## 升级

安装脚本始终下载最新版本。升级时不需要再传 token，只会更新二进制，不会覆盖已有配置：

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/junbaor/fastclaw-qqbot/master/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
.\install.ps1
```

升级后重启生效：

```bash
fastclaw daemon restart
```

## 手动安装

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，获取 AppID 和 AppSecret
2. 从 [Releases](https://github.com/junbaor/fastclaw-qqbot/releases) 下载对应平台的二进制文件
3. 放到插件目录：

```bash
mkdir -p ~/.fastclaw/plugins/qqbot
# 将下载的二进制重命名为 qqbot (Windows 为 qqbot.exe) 放入上述目录
# 同时下载 plugin.json 放入同一目录
```

4. 编辑 `~/.fastclaw/fastclaw.json`：

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "qqbot": {
        "enabled": true,
        "config": {
          "appId": "YOUR_APP_ID",
          "clientSecret": "YOUR_CLIENT_SECRET"
        }
      }
    }
  }
}
```

## Supported Message Types

| Type | Event | chatId Format |
|------|-------|---------------|
| C2C Private | `C2C_MESSAGE_CREATE` | `c2c:{user_openid}` |
| Group (@bot) | `GROUP_AT_MESSAGE_CREATE` | `group:{group_openid}` |
| Group (plain) | `GROUP_MESSAGE_CREATE` | `group:{group_openid}` |
| Guild Channel | `AT_MESSAGE_CREATE` | `channel:{channel_id}` |
| Guild DM | `DIRECT_MESSAGE_CREATE` | `dm:{guild_id}` |

## 附件处理

### 自动下载并内联的文本文件格式

用户发送以下格式的文件时，插件会自动下载内容并以代码块形式传给 AI（最大 50KB）：

| 分类 | 扩展名 |
|------|--------|
| SQL / 数据 | `.sql`, `.csv` |
| 配置文件 | `.json`, `.xml`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.env` |
| 文档 / 文本 | `.txt`, `.md`, `.log` |
| Shell | `.sh`, `.bash`, `.zsh` |
| Python | `.py` |
| JavaScript / TypeScript | `.js`, `.ts`, `.mjs`, `.cjs`, `.jsx`, `.tsx` |
| Go | `.go` |
| Rust | `.rs` |
| Java / Kotlin / Scala | `.java`, `.kt`, `.scala` |
| C / C++ | `.c`, `.cpp`, `.h`, `.hpp` |
| C# | `.cs` |
| Ruby | `.rb` |
| PHP | `.php` |
| Lua | `.lua` |
| R | `.r` |
| Swift | `.swift` |
| Web 前端 | `.html`, `.css`, `.scss`, `.less`, `.vue`, `.svelte` |
| DevOps | `.dockerfile`, `.makefile`, `.gitignore` |

### 其他附件类型

| 类型 | 处理方式 |
|------|----------|
| 图片 | 传递 URL（`[图片: URL]`） |
| 语音 | 传递 URL（`[语音: URL]`） |
| 视频 | 传递 URL（`[视频: URL]`） |
| 其他文件 | 传递文件名和 URL（`[文件: name URL]`） |

## Logs

运行日志写入 `~/.fastclaw/logs/qqbot.log`，每天自动滚动为 `qqbot-YYYY-MM-DD.log`。

```bash
# macOS / Linux
tail -f ~/.fastclaw/logs/qqbot.log

# Windows PowerShell
Get-Content ~\.fastclaw\logs\qqbot.log -Wait
```

## 构建

```bash
# 本地构建
make build

# 交叉编译所有平台
make build-all
```

## 发布

推送 tag 即可自动发布 GitHub Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 卸载

```bash
fastclaw plugin remove qqbot
```
