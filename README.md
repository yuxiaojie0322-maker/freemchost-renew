# freemchost-renew

FreeMCHost (`https://freemchost.com`) 服务器自动续期脚本，基于 Playwright。

## 登录方式：Supabase 会话注入（已绕过登录表单）

站点使用 **Supabase Auth**，登录表单带 `bylegit` 反机器人组件，直接驱动表单易被拦截。
本脚本改为 **会话注入登录**：先拿到 Supabase 会话，再在每个页面脚本执行前写入
`localStorage`（键 `sb-laehfeigoiycigkfknfn-auth-token`），使 SPA 加载即处于已登录状态，
**完全不经过 `/login` 表单**。

支持两种取会话方式（二选一）：

### 方式 A（默认，全自动）：Supabase REST API 邮箱密码登录
直接调用 `POST /auth/v1/token?grant_type=password`（REST 接口无 captcha/bylegit 校验）
换取 session，再注入。**仍用邮箱密码，但绕过了 bylegit 表单。**

- `FREE_EMAIL` — 账号邮箱
- `FREE_PASSWORD` — 账号密码

### 方式 B（可选，纯 token 登录，免密码）：注入预先导出的会话
若设置了 `FREE_SESSION`，则跳过 REST 登录，直接注入。

- `FREE_SESSION` — 从浏览器 localStorage 复制的 `sb-laehfeigoiycigkfknfn-auth-token`
  整段 JSON 值（DevTools → Application → Local Storage）。含 `refresh_token`，
  access_token 过期会自动刷新；refresh_token 失效时需重新导出。

> 优先级：`FREE_SESSION` > `FREE_EMAIL/FREE_PASSWORD`。两者都配则用 `FREE_SESSION`。

## Secrets 清单（Settings → Secrets and variables → Actions）

| Secret | 说明 | 必填 |
| :--- | :--- | :--- |
| `FREE_EMAIL` | 账号邮箱（方式 A） | 方式 A 必填 |
| `FREE_PASSWORD` | 账号密码（方式 A） | 方式 A 必填 |
| `FREE_SESSION` | 导出的会话 JSON（方式 B，免密码） | 方式 B 必填 |
| `SERVER_PAGE_URL` | 服务器页面地址，多个用换行/逗号分隔（如 `https://new.freemchost.com/server/xxxx`） | 必填 |
| `TG_BOT_TOKEN` | Telegram Bot Token（可选通知） | 选填 |
| `TG_CHAT_ID` | Telegram Chat ID | 选填 |
| `NODE_LINK` | 代理节点链接（可选，部署 Mihomo 本地代理） | 选填 |

## 手动触发测试
Actions → **Freemchost Auto Renew Permanent** → Run workflow。
之后每 6 小时（`cron: '10 */6 * * *'`）自动巡检：剩余 < 46h 自动续满 60h。
