# 局域网远程 Codex 工作台

一个运行在个人电脑上的 Codex Web 工作台，目前为实验性项目。浏览器通过局域网访问本机服务，在网页中与本机 Codex 对话、操作终端、上传文件并查看使用统计。代码任务由本机的 Codex CLI 执行，项目数据默认保存在本机。

## 功能

- 对话式 Codex 工作区，支持流式回复、Markdown、历史会话、固定、归档和工作区切换。
- 任务运行中也能发送补充要求或问题，输入会交给当前任务继续处理；任务已结束时开始下一轮。发送和停止按钮独立显示，追加消息保留当前任务的用量和计时。
- 按对话选择模型、思考深度、权限模式和 Fast 模式；新任务成功启动后才加入历史。
- 展示任务阶段、当前命令或工具及运行时间。
- 网页消息按输入、工作过程和正式回答分组；连续过程消息可叠层展开，工具记录默认收起，连续回答共用一个标题和复制按钮。流式更新保留用户的展开状态。
- 终端在浏览器之间共享，所有终端都可通过标签上的「×」关闭。从「＋」打开 Codex 终端或新建 Shell 终端；进入网页、切换工作区和重连时不会自动创建终端。手机端提供触控终端键盘。
- 终端文字可直接拖动选择，按 Ctrl+C（Mac 为 ⌘C）或右键复制。Codex CLI 使用原生跨屏选择：按住鼠标拖到正文上下边缘会自动滚动，松手后复制完整选区；浏览器未能自动复制时，可点击顶部复制按钮重试。Shift 拖动保留网页终端的本地选择方式。没有选中文字时，Ctrl+C 仍用于中断命令。
- Codex CLI 的普通滚轮和手机滑动用于浏览 CLI 内容；按住 Shift 滚轮可查看网页终端缓存的历史。普通 Shell 的滚轮仍用于本地回滚。
- 终端工具栏可直接下载文件：选择最近输出中的文件、粘贴路径，或点击终端里的文件路径打开下载窗口；选中的路径会自动填入。文件通过浏览器流式下载到当前设备，支持大文件及断点续传。相对路径以终端所属工作区为起点，可下载服务进程有读取权限的本机文件，支持隐藏目录和符号链接；也支持 `/assets/...` 和当前网页同源的完整资源链接，目录需先打包为 ZIP。
- 将文件或文件夹拖入网页并上传到运行服务的电脑。显示圆形进度和传输速度，支持断点续传；上传大小不由应用限制。
- 对话回复中提供的本机文件链接会显示为下载卡片，包含文件名、主机保存路径和下载按钮，可保存到当前访问网页的设备。下载不设目录白名单，文件需在当前对话中提供过，并且服务进程有读取权限。
- 查看本机 Codex 历史中的 Token 活动、模型用量和连续使用情况；数量以“万”和“亿”显示。
- 用量底栏显示输出均速（tok/s），按网页观测到的真实输出 Token 增量及任务耗时计算，包含思考和工具等待；中途打开或重连时仅统计之后的部分，无数据时显示“—”。
- 底栏的会话统计显示轮数、工具步数、模型阶段用时、工具累计用时、TTFT 和 TPS；计时基于网页观测，历史缺失的指标不会填入估算值。
- 提供资源管理器、文件变更、工具执行、审批请求和上下文用量显示。

## 技术结构

- `src/`：React 前端，使用 Vite 构建，终端界面使用 xterm.js。
- `server/`：Node.js 与 Express 服务，提供 REST API、WebSocket、文件上传和本机资源访问。
- `server/codex.js`：启动 `codex app-server --stdio`，通过 JSON-RPC 与 Codex 通信。
- `server/terminals.js`：使用 `node-pty` 创建本机 Codex CLI 和 Shell 终端。
- `shared/`：前后端共用的会话、设置、媒体和终端逻辑。
- `test/`：Node.js 单元测试和 Playwright 浏览器测试。

浏览器首次连接时通过 WebSocket 获取工作区、会话、模型、审批和终端状态。之后状态变更及终端输出继续通过 WebSocket 推送；创建任务、修改设置、归档会话和上传文件通过 HTTP API 完成。上传内容直接流式写入服务所在电脑，不经过第三方存储。

网页消息组织参考了 [DeepSeek Harness 的过程分组](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts)与[过程折叠交互](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx)，使用本项目的 Codex 消息结构实现。

## 环境要求

- Node.js 18 或更新版本、npm。
- 已完成登录和配置的 Codex CLI，且命令 `codex` 可在服务进程环境中运行。
- 支持 `node-pty` 的操作系统及构建环境。

## 安装和运行

```bash
git clone https://github.com/chenkl112/terminal-web.git && cd terminal-web
npm ci --include=dev && cp .env.example .env && npm run build
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
| `UPLOAD_UNUSED_DAYS` | `7` | 未使用的已完成上传保留天数，`0` 关闭清理 |
| `UPLOAD_CLEANUP_INTERVAL_MINUTES` | `60` | 自动清理检查间隔，至少 1 分钟 |

默认不启用访问 key，因此应只在可信的局域网中使用。需要跨互联网访问时，应设置访问 key，并在 HTTPS/WSS 反向代理或 VPN 后使用，不要直接把无认证的端口暴露到公网。

## 数据和服务重启

- `.data/state.json` 保存网页会话、设置和工作区状态。
- `.data/uploads/` 保存上传到本机的文件。
- 服务启动 1 分钟后首次检查未使用附件，之后每小时检查。仅删除上传或最近访问超过 7 天、未用于对话或终端的已完成上传，同时移除上传记录。已发送、已归档对话以及 Codex 本地历史中引用的文件保留；历史读取失败时跳过删除。正在上传的文件不参与清理。当前打开的草稿附件每 30 分钟续期，过期的旧草稿会提示重新上传。可通过上述环境变量调整保留期和检查间隔。
- Token 统计从 `CODEX_HOME` 下的 Codex 会话历史读取。
- `.env`、`.data/`、`dist/`、`node_modules/`、本机下载资源 `public/assets/` 和测试输出均由 `.gitignore` 排除，不应提交。界面字体保存在 `public/fonts/`，许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 服务退出时会保存会话状态，但会终止当前终端进程和正在执行的终端任务。重启服务后需要从「＋」手动打开所需终端。

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
