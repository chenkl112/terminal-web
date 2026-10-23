# 局域网远程 Codex 工作台

一个运行在个人电脑上的 Codex Web 工作台。浏览器通过局域网访问本机服务，在网页中与本机 Codex 对话、操作终端、上传文件并查看使用统计。代码任务由本机的 Codex CLI 执行，项目数据默认保存在本机。

## 功能

- 对话式 Codex 工作区，支持流式回复、Markdown、历史会话、固定、归档和工作区切换。
- 按对话选择模型、思考深度、权限模式和 Fast 模式；新任务成功启动后才加入历史。
- 展示任务阶段、当前命令或工具及运行时间。
- 每个工作区共享一个默认 Codex 终端，也可打开独立 Shell 终端；手机端提供触控终端键盘。
- 将文件或文件夹拖入网页并上传到运行服务的电脑。显示圆形进度和传输速度，支持断点续传；上传大小不由应用限制。
- 查看本机 Codex 历史中的 Token 活动、模型用量和连续使用情况；数量以“万”和“亿”显示。
- 提供资源管理器、文件变更、工具执行、审批请求和上下文用量显示。

## 技术结构

- `src/`：React 前端，使用 Vite 构建，终端界面使用 xterm.js。
- `server/`：Node.js 与 Express 服务，提供 REST API、WebSocket、文件上传和本机资源访问。
- `server/codex.js`：启动 `codex app-server --stdio`，通过 JSON-RPC 与 Codex 通信。
- `server/terminals.js`：使用 `node-pty` 创建本机 Codex CLI 和 Shell 终端。
- `shared/`：前后端共用的会话、设置、媒体和终端逻辑。
- `test/`：Node.js 单元测试和 Playwright 浏览器测试。

浏览器首次连接时通过 WebSocket 获取工作区、会话、模型、审批和终端状态。之后状态变更及终端输出继续通过 WebSocket 推送；创建任务、修改设置、归档会话和上传文件通过 HTTP API 完成。上传内容直接流式写入服务所在电脑，不经过第三方存储。

## 环境要求

- Node.js 18 或更新版本、npm。
- 已完成登录和配置的 Codex CLI，且命令 `codex` 可在服务进程环境中运行。
- 支持 `node-pty` 的操作系统及构建环境。

## 安装和运行

```bash
git clone <仓库地址>
cd terminal-web
npm ci
cp .env.example .env
npm run build
npm start
```

默认监听 `0.0.0.0:3210`。同一局域网内访问：

```text
http://<运行服务电脑的局域网 IP>:3210
```

开发模式可运行 `npm run dev`。生产模式修改前端后执行 `npm run build`；修改服务端代码后需重启 Node 服务。

## 配置

在 `.env` 中设置以下可选项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `3210` | HTTP 端口 |
| `WORKSPACE_DIR` | 项目目录的父目录 | 初始工作区路径 |
| `DATA_DIR` | 项目目录下的 `.data` | 会话状态与上传文件目录 |
| `CODEX_BIN` | `codex` | Codex 可执行文件路径 |
| `ACCESS_KEY` | 空 | 设置后网页需要输入访问 key |
| `CODEX_HOME` | `~/.codex` | Codex 历史和使用统计读取位置 |

默认不启用访问 key，因此应只在可信的局域网中使用。需要跨互联网访问时，应设置访问 key，并在 HTTPS/WSS 反向代理或 VPN 后使用，不要直接把无认证的端口暴露到公网。

## 数据和服务重启

- `.data/state.json` 保存网页会话、设置和工作区状态。
- `.data/uploads/` 保存上传到本机的文件。
- Token 统计从 `CODEX_HOME` 下的 Codex 会话历史读取。
- `.env`、`.data/`、`dist/`、`node_modules/` 和测试输出均由 `.gitignore` 排除，不应提交。
- 服务退出时会保存会话状态，但会终止当前终端进程和正在执行的终端任务。重启服务后默认 Codex 终端会重新创建。

本机如已安装 `mono-workspace.service`，可用以下命令管理：

```bash
systemctl --user status mono-workspace
systemctl --user restart mono-workspace
journalctl --user -u mono-workspace -f
```

## 测试

运行单元测试：

```bash
npm test
```

安装 Playwright 浏览器：

```bash
npx playwright install chromium
```

浏览器测试需要一个测试服务。建议使用单独的数据目录，避免测试写入正式会话：

```bash
PORT=3211 HOST=127.0.0.1 DATA_DIR="$PWD/.data/qa" npm start
```

另开终端运行：

```bash
TEST_URL=http://127.0.0.1:3211 npx playwright test
```

只有明确需要真实 Codex 请求时才设置 `LIVE_CODEX=1`。测试完成后停止测试服务即可。
