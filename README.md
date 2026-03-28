<p align="center">
  <img src="icons/icon-256.png" alt="ClawTalk logo">
</p>

# ClawTalk（Chrome 扩展）

`ClawTalk` 是一个运行在 Chrome 侧边栏里的轻量语音/文本面板，用来把 **OpenClaw Gateway** 变成一个更接近“随手对讲”的助手入口。

它的目标很简单：

- 不需要额外桌面应用
- 直接复用现有 OpenClaw 网关
- 可以和 Control UI / WebChat 共享同一个会话上下文
- 文本和语音都能用
- 首次配对、重连、权限申请这些细节尽量自动处理

## 适合什么场景

- 你已经有一个本地或远端 OpenClaw Gateway
- 你想在浏览器里随时叫出一个聊天/语音助手入口
- 你想复用 `main` 或其它现有 `sessionKey` 的上下文
- 你不想一直开着完整的 Control UI 页面

## 主要能力

- 通过 WebSocket 连接 OpenClaw Gateway
- 把文本消息通过 `chat.send` 发到指定 `sessionKey`
- 将助手回复实时显示在侧边栏 `CHAT` 区
- 支持两种语音输入方式
  - 免按键模式（VAD 自动判断说话结束）
  - 按住说话模式（push-to-talk）
- 支持两种 TTS 输出方式
  - 浏览器原生 `SpeechSynthesis`
  - ElevenLabs
- 带连接诊断、自动重连和有限缓冲，避免无限重连或日志失控

## 安装方式

当前版本默认按“开发者模式加载解压扩展”的方式使用。

### 方式一：加载当前仓库

1. 打开 Chrome
2. 访问 `chrome://extensions`
3. 打开右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择 `ClawTalk/` 根目录

### 方式二：加载发布包

1. 下载发布 ZIP
2. 解压到本地目录
3. 打开 `chrome://extensions`
4. 打开“开发者模式”
5. 点击“加载已解压的扩展程序”
6. 选择解压后的目录

安装后，点击扩展图标或从扩展菜单中打开侧边栏即可。

## 快速开始

如果你连接的是本机 OpenClaw，最小步骤如下：

1. 启动本地 OpenClaw Gateway
2. 打开 `ClawTalk` 侧边栏
3. 点击右上角 `Settings`
4. 保持 `Gateway URL` 为 `ws://127.0.0.1:18789`
5. 把本地网关 token 填到 `Gateway Token (or Device Token)`
6. 点击 `Save`
7. 回到侧边栏点击 `Connect`
8. 如果提示 `pairing required`，到网关主机执行配对批准
9. 连接成功后，直接输入文本或点击 `Talk`

## 配置说明

### 1. Gateway

#### Gateway URL

默认值：

```text
ws://127.0.0.1:18789
```

适用于本机 OpenClaw。

如果你接远端网关，也可以填：

```text
wss://gateway.example.com
```

或：

```text
ws://192.168.1.20:18789
```

#### Gateway Token (or Device Token)

- 本地 OpenClaw 通常需要先填 `gateway.auth.token`
- token 存在 `chrome.storage.local`
- 不会直接打印到扩展日志中

如果你是本机 OpenClaw，一般可以从这些位置取到 token：

```bash
openclaw config get gateway.auth.token
```

或者直接看：

```text
~/.openclaw/openclaw.json
```

#### Test Connection

`Test Connection` 不是简单地“打开一个 WebSocket 就算成功”，而是会跑一轮带认证的网关握手。

它会尽量把下面几类情况区分开：

- URL 格式不对
- 扩展没有该网关 origin 的访问权限
- token 不对
- 需要首次设备配对
- 服务不可达

这比单纯探测端口是否打开更接近真实可用性。

#### Gateway Headers (optional)

可以给网关连接附加额外请求头，适合：

- Cloudflare Access
- 反向代理网关
- 其它上游认证场景

### 2. 首次配对与 Device Token

首次成功发起认证握手时，OpenClaw 可能要求这个浏览器扩展先完成一次设备配对。

如果扩展提示 `pairing required`，请在 OpenClaw 网关主机执行：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

配对通过后：

- 网关会给扩展下发一个 `deviceToken`
- `ClawTalk` 会自动保存在 `chrome.storage.local`
- 后续重连优先使用这个 `deviceToken`

为了避免旧配对把新配置卡死，现在有两个保护：

- 如果你修改了 `Gateway URL`
- 或者修改了 `Gateway Token`

扩展会自动清掉旧的 `deviceToken`，避免陈旧配对继续覆盖新设置。

### 3. Session

#### Session key

默认值：

```text
main
```

如果你希望和 OpenClaw Control UI / WebChat 共用上下文，直接填同一个 `sessionKey` 就行。

例如你在 Control UI 里一直用 `main`，这里也用 `main`，那么双方就共享同一段会话历史。

### 4. 语音输入

#### Language (STT default)

用于语音识别的默认语言提示，例如：

```text
zh-CN
```

或：

```text
en-US
```

#### Push-to-talk mode

- 关闭：免按键模式，自动判断说话结束
- 打开：按住 `Talk` 说话，松开后发送

### 5. 历史记录

#### Load session history

连接或切换会话时，是否把最近的 `chat.history` 拉到侧边栏。

#### History lines

一次最多拉多少条历史消息。

### 6. Text-to-speech

#### Provider

- `Default (SpeechSynthesis)`：浏览器原生语音
- `ElevenLabs`：需要单独配置 API Key 和 Voice ID

`Test speech` 可以在不启动完整 Talk 循环的情况下单独验证 TTS 是否可用。

## 使用说明

### 文本聊天

1. 先点击 `Connect`
2. 在 `CHAT` 区输入消息
3. 点击 `Send` 或直接按回车
4. 消息会通过 `chat.send` 发送到当前 `sessionKey`
5. 助手回复会显示在聊天区

### 语音对话

1. 先点击 `Connect`
2. 再点击 `Talk`
3. 开始说话
4. 扩展会在检测到说话结束后自动发给网关
5. 回复会显示在 `CHAT`
6. 如果打开了 `Speaking`，回复还会被朗读

### 和现有会话共享上下文

1. 打开 OpenClaw Control UI / WebChat
2. 确认你正在使用的 `sessionKey`
3. 在 `ClawTalk Settings` 里填同一个 `sessionKey`
4. 保存并重连

这样两边会共享同一段对话上下文。

## 常见问题

### 1. 点了 Connect 还是连不上

先看 `Settings` 里这几项：

- `Gateway URL` 是否正确
- `Gateway Token` 是否正确
- 是否已经点击 `Save`

然后可以点一次 `Test Connection`，看它返回的是：

- 权限问题
- token 问题
- pairing required
- 服务不可达

### 2. 显示 pairing required

说明这台浏览器扩展还没被 OpenClaw 批准为可用设备。

在网关主机上执行：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

批准后再回扩展点 `Connect`。

### 3. 切换网关后怎么还是连不上

旧的 `deviceToken` 可能和新网关或新 token 不匹配。

现在扩展在你修改以下任一项时会自动清掉旧 `deviceToken`：

- `Gateway URL`
- `Gateway Token`

所以正常情况下重新 `Save` 后再 `Connect` 即可。

### 4. 连接测试显示成功，但聊天不工作

当前版本已经修正了这个问题：`Test Connection` 走的是完整认证握手，不再把“底层 WebSocket 打开”误判成可聊天。

### 5. 远端网关怎么配置

对于远端网关：

- 当前 `Gateway URL` 对应的 origin 会自动加入权限检查
- 额外 origin 可以写进 `Additional Gateway permissions`
- Chrome 会在需要时弹出权限请求

默认发布包不再内置某个固定的环境专用远端网关地址。

## 权限说明

扩展当前使用的权限：

- `storage`
  保存网关地址、token、sessionKey、语音和日志配置
- `microphone`
  语音输入
- `offscreen`
  后台音频播放 / TTS
- `sidePanel`
  承载侧边栏 UI
- `declarativeNetRequest`
  给网关请求附加配置好的头
- `notifications`（可选）
  预留给未来用户提示

默认 host permissions：

- `ws://127.0.0.1:18789/*`
- `https://api.elevenlabs.io/*`

按需申请：

- `ws://*/*`
- `wss://*/*`

## 项目结构

```text
manifest.json
service_worker.js          后台状态机、连接管理、语音循环
sidepanel.html/.js/.css    侧边栏 UI
options.html/.js           设置页
offscreen.html/.js         后台音频播放和 TTS
icons/                     扩展图标
shared/
  device-identity.mjs      设备身份与签名
  gateway-defaults.mjs     默认网关与旧配置迁移
  gateway-probe.mjs        连接测试握手探针
  gateway-settings.mjs     设置保存与 device token 失效规则
  gateway_client.js        网关客户端
  state.js                 默认状态与设置
  stt.js                   语音识别
  tts.js                   文本转语音
  vad.js                   语音活动检测
tests/                     Playwright 测试
```

## 开发与验证

安装测试依赖：

```bash
cd tests
npm install
```

运行测试：

```bash
cd tests
npm test
```

## 当前限制

- 这不是一个“完整的 OpenClaw 聊天客户端”，而是一个浏览器侧边栏里的轻量入口
- 语音体验受浏览器语音识别和系统麦克风环境影响
- TTS 质量取决于浏览器内置语音或 ElevenLabs 配置
- 远端网关场景下，权限、代理和配对比本机场景更容易出问题

## 参考

- [OpenClaw 相关文章](https://www.ryadel.com/en/clawtalk-talk-to-your-assistant-chrome-extension-openclaw/)
