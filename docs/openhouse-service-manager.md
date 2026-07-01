# OpenHouseAI Service-Manager Deployment

This note documents the local Web deployment used for running Ackem inside
Termux Ubuntu and exposing it through the OpenHouseAI Android shell.

## Scope

This deployment keeps Ackem as a single-user local Web runtime. It does not
move the Electron desktop window features to Android. Electron window-only
features, such as tray and BrowserWindow control, stay out of the Web runtime.

The Web runtime should include the portable backend capabilities that are not
Electron-window-specific, including the WeChat bridge channels.

## Runtime Contract

Use the 5-digit app-service port range already used by OpenHouseAI services:

| Item | Value |
|------|-------|
| Service ID | `ackem-web` |
| Web URL | `http://127.0.0.1:23085` |
| Port | `23085` |
| Data root | `/root/ackem-data` |
| Repo dir | `/root/ackem` |
| service-manager URL | `http://127.0.0.1:20087` |

Build and run command:

```bash
npm run build:web
ACKEM_DATA_ROOT=/root/ackem-data /usr/local/bin/node out/web/server.mjs --host 127.0.0.1 --port 23085
```

The service-manager service should run the same server command from
`/root/ackem`.

## API Registration

Register through service-manager APIs instead of editing OpenHouseAI registry
files by hand. The component manifest is written through
`POST /api/v1/registry/apply`.

The bearer token should be read locally on the phone host. Do not commit or
publish the token value.

```bash
TOKEN="$($HOME/.local/bin/service-manager token show 2>/dev/null | head -n1)"
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @payload.json \
  http://127.0.0.1:20087/api/v1/registry/apply
```

The payload should include:

- `component`: OpenHouseAI component manifest for `ackem-web`.
- `services`: service-manager service spec for the `ackem-web` process.
- `aiDocs`: optional AI-facing docs. Paths are relative to the registry
  `ai-docs/` directory, so use paths such as
  `ackem-web/openhouse.ai.md`, not `ai-docs/ackem-web/openhouse.ai.md`.

## Component Manifest Requirements

The component manifest should expose both an Android shell sidebar entry and a
SmallPhone app entry:

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

Do not put executable fields such as `command`, `shell`, `script`, or `args` in
the component manifest. The process command belongs only in the service-manager
service spec.

## Verification

Check service-manager registration:

```bash
TOKEN="$($HOME/.local/bin/service-manager token show 2>/dev/null | head -n1)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:20087/api/v1/registry/components/ackem-web
```

Check service state:

```bash
TOKEN="$($HOME/.local/bin/service-manager token show 2>/dev/null | head -n1)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:20087/api/v1/services/ackem-web/status
```

Check Ackem Web health:

```bash
curl -sS http://127.0.0.1:23085/api/health
```

Expected health details:

- `ok: true`
- `mode: "local-web"`
- `capabilities.channels` contains `weixin:startLogin`
- `capabilities.channels` contains `weixin:pollLogin`
- `capabilities.pendingChannels` is empty or does not include WeChat channels

If the UI shows `window.ackem.weixinStartLogin is not available in Ackem Web
runtime yet`, the deployed build is stale or the Web service is not running the
current `out/web/server.mjs`. Rebuild with `npm run build:web`, restart
`ackem-web`, then recheck `/api/health`.

## Android Shell Sidebar

The sidebar reads OpenHouseAI component manifests from the registry. A component
is eligible for the sidebar when:

- `shellMenu.visible` is `true`.
- `shellMenu.entry.type` is `webview`.
- `shellMenu.entry.url` points to `http://127.0.0.1:23085`.

If the component is registered but does not appear immediately, refresh or
restart the Android shell. If the shell depends on SmallPhone core, confirm that
`smallphone-core` is running and that `http://127.0.0.1:22000/api/components`
responds.

## Android Home-Screen Icon

For a standalone Android launcher icon, open the Ackem Web URL in the Android
browser or WebView shell and use the browser's "Add to Home screen" or PWA
install action. The installed shortcut should still point to the local URL:

```text
http://127.0.0.1:23085
```

This is separate from service-manager registration. service-manager keeps the
backend alive; the home-screen shortcut only opens the Web frontend.

## Operational Notes

- Keep the service bound to `127.0.0.1` unless there is an explicit remote
  access requirement.
- Keep Ackem single-user on phone deployments unless the backend is hardened
  for multiple users.
- Do not commit runtime tokens, API keys, `data/`, or `/root/ackem-data`.
- When moving to another phone, re-register through
  `/api/v1/registry/apply` so the registry state and Termux outer config stay in
  sync.
