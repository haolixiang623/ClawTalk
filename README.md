<p align="center">
  <img src="icons/icon-256.png" alt="ClawTalk logo">
</p>

# ClawTalk（Chrome 扩展）

`ClawTalk` 是一个运行在 Chrome 侧边栏里的轻量语音 / 文本面板，用来把 **OpenClaw Gateway** 变成一个更接近“随手对讲”的助手入口。

适合你已经有 OpenClaw 网关，希望：

- 在浏览器里快速发消息
- 直接说话给助手听
- 和 Control UI / WebChat 共用同一个 `sessionKey`
- 不想一直打开完整后台页面

## 你会得到什么

- 侧边栏里的文本聊天
- `Talk` 按钮发起的语音输入
- 助手回复显示在 `CHAT` 区
- 可选的 TTS 朗读
- 本地网关优先的默认配置
- 首次配对、后续重连、远端权限申请的基本支持

## 安装

当前默认按“开发者模式加载解压扩展”的方式使用。

1. 打开 Chrome
2. 访问 `chrome://extensions`
3. 打开右上角“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择 `ClawTalk/` 根目录

安装后，点击扩展图标或从扩展菜单中打开侧边栏即可。

## 第一次设置

如果你接的是本机 OpenClaw，最小步骤如下：

1. 启动本地 OpenClaw Gateway
2. 打开 `ClawTalk`
3. 进入 `Settings`
4. 确认 `Gateway URL` 是 `ws://127.0.0.1:18789`
5. 把本地网关 token 填到 `Gateway Token (or Device Token)`
6. 点击 `Save`
7. 回到侧边栏点击 `Connect`
8. 如果提示 `pairing required`，在网关主机执行：

```bash
openclaw devices list
openclaw devices approve <requestId>
```

9. 连接成功后，就可以直接发文本或点击 `Talk`

## Token 从哪里拿

本机 OpenClaw 通常可以这样查看网关 token：

```bash
openclaw config get gateway.auth.token
```

或者查看：

```text
~/.openclaw/openclaw.json
```

## 文本与语音使用

### 文本聊天

1. 先点 `Connect`
2. 在 `CHAT` 输入消息
3. 点 `Send` 或直接回车

### 语音对话

1. 先点 `Connect`
2. 再点 `Talk`
3. 开始说话
4. 说完后等待扩展自动发送

## 完整说明

更完整的中文文档见：

- [使用说明（中文）](/Users/gooddream/Desktop/projects/GovCopilot/ClawTalk/docs/getting-started.zh-CN.md)
- [安全说明](/Users/gooddream/Desktop/projects/GovCopilot/ClawTalk/SECURITY.md)

完整说明里包含：

- 所有配置项说明
- 首次配对 / `deviceToken` 机制
- `sessionKey` 共享上下文
- 远端网关接入
- 常见问题与排障
- 权限说明
- 项目结构与测试方式
