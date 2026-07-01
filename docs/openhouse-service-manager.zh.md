# OpenHouseAI service-manager 部署说明

本文记录 Ackem 在 Termux Ubuntu 中作为本地 Web 服务运行，并接入
OpenHouseAI Android Shell 侧边栏的约定。

## 范围

这个部署目标是单用户、本机访问的 Ackem Web runtime。它不会把 Electron 桌面窗口
能力搬到 Android 上。系统托盘、BrowserWindow 控制等 Electron 窗口专属能力仍然不
属于 Web runtime。

Web runtime 应包含不依赖 Electron 窗口的后端能力，包括微信桥接通道。

## 运行约定

使用 OpenHouseAI 本地服务已有的 5 位端口规范：

| 项目 | 值 |
|------|----|
| Service ID | `ackem-web` |
| Web URL | `http://127.0.0.1:23085` |
| 端口 | `23085` |
| 数据目录 | `/root/ackem-data` |
| 项目目录 | `/root/ackem` |
| service-manager URL | `http://127.0.0.1:20087` |

构建与运行命令：

```bash
npm run build:web
ACKEM_DATA_ROOT=/root/ackem-data /usr/local/bin/node out/web/server.mjs --host 127.0.0.1 --port 23085
```

service-manager 中的服务也应从 `/root/ackem` 执行同一条 server 命令。

## 通过 API 注册

注册应走 service-manager API，不要手动改 OpenHouseAI registry 文件。组件 manifest
通过 `POST /api/v1/registry/apply` 写入。

Bearer token 只应在手机本机读取，不要提交或公开 token 值。

```bash
TOKEN="$($HOME/.local/bin/service-manager token show 2>/dev/null | head -n1)"
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @payload.json \
  http://127.0.0.1:20087/api/v1/registry/apply
```

payload 应包含：

- `component`：`ackem-web` 的 OpenHouseAI 组件 manifest。
- `services`：`ackem-web` 进程对应的 service-manager service spec。
- `aiDocs`：可选的 AI 说明文档。路径是相对于 registry 的 `ai-docs/` 目录，
  所以应使用 `ackem-web/openhouse.ai.md`，不要写成
  `ai-docs/ackem-web/openhouse.ai.md`。

## 组件 manifest 要求

组件 manifest 需要同时暴露 Android Shell 侧边栏入口和 SmallPhone 应用入口：

```json
{
  "schemaVersion": 1,
  "id": "ackem-web",
  "title": "Ackem",
  "kind": "ai-partner",
  "ports": [
    {
      "name": "web",
      "host": "127.0.0.1",
      "port": 23085,
      "url": "http://127.0.0.1:23085"
    }
  ],
  "shellMenu": {
    "visible": true,
    "section": "ai",
    "order": 45,
    "entry": {
      "type": "webview",
      "url": "http://127.0.0.1:23085"
    },
    "controlEntry": {
      "type": "service-control",
      "serviceNames": ["ackem-web"],
      "serviceRefs": ["service-manager://services/ackem-web"]
    }
  },
  "smallphoneApp": {
    "visible": true,
    "section": "ai",
    "order": 45,
    "icon": "sparkles",
    "entry": {
      "type": "webview",
      "url": "http://127.0.0.1:23085"
    },
    "controlEntry": {
      "type": "service-control",
      "serviceNames": ["ackem-web"],
      "serviceRefs": ["service-manager://services/ackem-web"]
    }
  },
  "serviceManager": {
    "required": true,
    "services": [
      {
        "name": "ackem-web",
        "title": "Ackem Web",
        "role": "web",
        "port": 23085,
        "url": "http://127.0.0.1:23085",
        "serviceRef": "service-manager://services/ackem-web",
        "controls": ["status", "start", "stop", "restart", "logs"],
        "health": {
          "type": "http",
          "url": "http://127.0.0.1:23085/api/health"
        }
      }
    ]
  }
}
```

不要在 component manifest 中放 `command`、`shell`、`script`、`args` 这类可执行
字段。进程启动命令只能放在 service-manager 的 service spec 中。

## 验证

检查 service-manager 注册：

```bash
TOKEN="$($HOME/.local/bin/service-manager token show 2>/dev/null | head -n1)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:20087/api/v1/registry/components/ackem-web
```

检查服务状态：

```bash
TOKEN="$($HOME/.local/bin/service-manager token show 2>/dev/null | head -n1)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:20087/api/v1/services/ackem-web/status
```

检查 Ackem Web 健康状态：

```bash
curl -sS http://127.0.0.1:23085/api/health
```

期望看到：

- `ok: true`
- `mode: "local-web"`
- `capabilities.channels` 包含 `weixin:startLogin`
- `capabilities.channels` 包含 `weixin:pollLogin`
- `capabilities.pendingChannels` 为空，或至少不包含微信通道

如果界面显示 `window.ackem.weixinStartLogin is not available in Ackem Web
runtime yet`，说明部署的是旧构建，或 Web 服务没有运行当前的
`out/web/server.mjs`。执行 `npm run build:web` 后重启 `ackem-web`，再检查
`/api/health`。

## Android Shell 侧边栏

侧边栏读取 OpenHouseAI component registry。满足以下条件时，组件可以出现在侧边栏：

- `shellMenu.visible` 为 `true`。
- `shellMenu.entry.type` 为 `webview`。
- `shellMenu.entry.url` 指向 `http://127.0.0.1:23085`。

如果组件已注册但没有立刻出现，刷新或重启 Android Shell。如果 Shell 依赖
SmallPhone core，则确认 `smallphone-core` 正在运行，并且
`http://127.0.0.1:22000/api/components` 能正常响应。

## Android 桌面独立图标

如果需要 Android 桌面上的独立入口，在 Android 浏览器或 WebView Shell 中打开
Ackem Web URL，然后使用浏览器的“添加到主屏幕”或 PWA 安装动作。安装后的快捷方式
仍应指向本机 URL：

```text
http://127.0.0.1:23085
```

这和 service-manager 注册是两件事。service-manager 负责保持后端服务运行；桌面
快捷方式只负责打开 Web 前端。

## 运行注意事项

- 除非明确需要远程访问，否则服务应绑定到 `127.0.0.1`。
- 手机部署默认保持单用户，不要在未加固前开放多人访问。
- 不要提交运行时 token、API Key、`data/` 或 `/root/ackem-data`。
- 换手机或重装环境时，应重新走 `/api/v1/registry/apply`，这样 registry state 和
  Termux 外层配置会保持同步。
