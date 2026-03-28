# ClawTalk 使用说明（中文）

## 什么是 ClawTalk

`ClawTalk` 是一个运行在 Chrome 侧边栏里的轻量语音 / 文本面板，用来连接 **OpenClaw Gateway**。

它的定位不是完整聊天客户端，而是一个更轻、更快的入口：

- 浏览器里随时打开
- 文本和语音都能用
- 可复用 OpenClaw 现有 `sessionKey`
- 不需要一直开着完整控制台

## 适合什么场景

- 你已经有本地或远端 OpenClaw 网关
- 你想在浏览器里随时和助手说一句话
- 你希望和 Control UI / WebChat 共用上下文
- 你更喜欢“侧边栏 + 对讲”而不是完整后台页面

## 安装方式

当前版本默认按开发者模式加载。

### 加载当前仓库

1. 打开 Chrome
2. 访问 `chrome://extensions`
3. 打开右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择 `ClawTalk/` 根目录

### 加载发布包

1. 下载 ZIP
2. 解压
3. 打开 `chrome://extensions`
4. 打开“开发者模式”
5. 点击“加载已解压的扩展程序”
6. 选择解压后的目录

安装后，点击扩展图标或从扩展菜单中打开侧边栏。

## 第一次设置

下面以“连接本机 OpenClaw”为例。

### 第 1 步：确认 OpenClaw 网关已启动

本机默认网关地址通常是：

```text
ws://127.0.0.1:18789
```

### 第 2 步：拿到网关 token

优先用命令读取：

```bash
openclaw config get gateway.auth.token
```

如果你想直接看文件，也可以查看：

```text
~/.openclaw/openclaw.json
```

通常对应字段是：

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "..."
    }
  }
}
```

### 第 3 步：填入 ClawTalk 设置

打开 `ClawTalk` 侧边栏，进入 `Settings`。

至少填这两项：

- `Gateway URL`
  默认本机值：

```text
ws://127.0.0.1:18789
```

- `Gateway Token (or Device Token)`
  这里填刚才拿到的 `gateway.auth.token`

然后点击 `Save`。

### 第 4 步：测试连接

你可以先点一次 `Test Connection`。

当前版本的 `Test Connection` 会跑一轮**带认证的真实握手**，不是单纯地探测端口是否打开，所以它能更准确地区分：

- URL 不对
- 扩展没有目标 origin 权限
- token 不对
- 需要首次设备配对
- 服务不可达

### 第 5 步：首次配对（如果需要）

第一次连接时，OpenClaw 可能要求浏览器扩展先完成一次设备配对。

如果扩展提示 `pairing required`，在网关主机执行：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

批准后，再回扩展点击 `Connect`。

### 第 6 步：开始聊天

连接成功后：

- 直接在 `CHAT` 输入框里发文本
- 或点击 `Talk` 进行语音输入

## 配置说明

### Gateway URL

本机默认值：

```text
ws://127.0.0.1:18789
```

远端网关也可以填，例如：

```text
wss://gateway.example.com
```

或者：

```text
ws://192.168.1.20:18789
```

### Gateway Token (or Device Token)

- 这里最开始通常填 `gateway.auth.token`
- 成功配对后，扩展可能会收到并保存 `deviceToken`
- 后续重连时，扩展优先使用这个 `deviceToken`

### Gateway Headers (optional)

适用于：

- Cloudflare Access
- 反向代理
- 其它上游认证头

### Session key

默认值：

```text
main
```

如果你想和 OpenClaw 的 Control UI / WebChat 共用上下文，就把这里设置成同一个 `sessionKey`。

### Load session history

用于在连接或切换会话时，把最近 `chat.history` 拉进侧边栏。

### History lines

控制历史消息拉取条数。

### Language (STT default)

用于语音识别的语言提示，例如：

```text
zh-CN
```

```text
en-US
```

### Push-to-talk mode

- 关闭：VAD 自动判断什么时候说完
- 打开：按住 `Talk` 说话，松开发送

### Text-to-speech

支持两种方式：

- `Default (SpeechSynthesis)`
- `ElevenLabs`

如果使用 ElevenLabs，需要额外配置：

- `ElevenLabs API Key`
- `ElevenLabs Voice ID`

## 如何使用

### 文本聊天

1. 点 `Connect`
2. 在 `CHAT` 里输入内容
3. 点 `Send` 或回车
4. 等待助手回复

### 语音聊天

1. 点 `Connect`
2. 点 `Talk`
3. 开始说话
4. 说完后等待扩展自动发送
5. 助手回复会显示在 `CHAT`
6. 如果打开了 `Speaking`，还会朗读回复

### 与现有会话共享上下文

如果你在 OpenClaw Control UI / WebChat 里已经在用某个会话，比如：

```text
main
```

那就在 `ClawTalk Settings` 中把 `Session key` 也设置成同一个值。这样两边会共享上下文。

## `deviceToken` 机制

首次配对成功后，OpenClaw 可能给扩展下发一个 `deviceToken`。

它的作用是：

- 后续重连更顺滑
- 避免每次都重复使用共享 token 做首次身份建立

为了防止旧配对把新配置卡死，现在 `ClawTalk` 会在以下任一项变化时自动清掉旧 `deviceToken`：

- `Gateway URL`
- `Gateway Token`

这样当你切换网关或轮换 token 时，不会被旧配对凭据卡住。

## 常见问题

### 1. 点了 Connect 没反应或连不上

先检查：

- `Gateway URL` 对不对
- `Gateway Token` 对不对
- 有没有点 `Save`
- OpenClaw 网关是否已启动

然后点一次 `Test Connection` 看结果。

### 2. 提示 pairing required

说明这台浏览器扩展还没有被网关批准。

在网关主机执行：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

### 3. 切换网关后还是连不上

旧的 `deviceToken` 可能和新网关不匹配。

现在扩展会在你修改下面任一项时自动清掉旧 `deviceToken`：

- `Gateway URL`
- `Gateway Token`

### 4. 连接测试显示成功，但聊天不工作

当前版本已经修复这个问题：`Test Connection` 走的是完整认证握手，不再把“底层 WebSocket 打开”误判成可聊天。

### 5. 远端网关怎么接

远端场景下：

- 当前 `Gateway URL` 的 origin 会自动进入权限检查
- 额外 origin 可以写进 `Additional Gateway permissions`
- Chrome 需要时会请求你授权

默认发布包不会再内置某个特定环境的远端网关地址。

## 权限说明

`ClawTalk` 当前使用这些权限：

- `storage`
  保存 URL、token、sessionKey、语音和日志配置
- `microphone`
  语音输入
- `offscreen`
  后台音频播放 / TTS
- `sidePanel`
  承载侧边栏 UI
- `declarativeNetRequest`
  给网关连接附加额外请求头
- `notifications`（可选）
  预留给未来提示

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
icons/                     图标资源
shared/
  device-identity.mjs      设备身份与签名
  gateway-defaults.mjs     默认网关与旧配置迁移
  gateway-probe.mjs        带认证的连接探针
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

- 它不是完整的 OpenClaw 聊天客户端，而是一个浏览器侧边栏入口
- 语音效果受浏览器、麦克风和系统语音能力影响
- 远端网关场景下更容易遇到权限、代理和配对问题
- ElevenLabs 依赖你的账号和 voice 配置

## 参考

- [安全说明](/Users/gooddream/Desktop/projects/GovCopilot/ClawTalk/SECURITY.md)
