# Agent 联网搜索

Ash 通过本地客户端访问自建 SearXNG，并提取公开网页正文。搜索不会通过当前 SSH 服务器发出，也不能据此判断远端服务器的联网能力。

## 配置

1. 在 SearXNG 的 `settings.yml` 中为现有 `search.formats` 列表添加 `json`，并按你的部署方式重新加载服务：

   ```yaml
   search:
     formats:
       - html
       - json
   ```

2. 打开 Ash 的 **设置 → AI → 联网搜索**，填写 SearXNG 服务根地址，如 `https://search.example.com`。支持子路径和自建内网地址，不需要添加 `/search`。如果服务重定向，请填写最终地址。
3. 如反向代理需要认证，在“认证信息”中填写完整的 Authorization 请求头值，例如 `Bearer …` 或 `Basic …`。这些值与模型密钥一样保存在本地配置文件中；不要把凭据放入 URL。
4. 点击 **测试搜索连接**，确认 JSON 接口可用。403 可能表示 JSON 未启用、认证失败或服务端限制访问；返回 HTML 通常表示地址不正确或进入了登录页。
5. 选择联网模式并保存：**关闭**、**按需自动搜索**、**仅明确要求时搜索**。最后一种模式通过本轮提问中的“联网搜索”“查文档”等关键词或网页链接启用。

默认勾选 **使用默认模型**，主 Agent 直接调用联网工具并读取结果，跟随“模型连接”配置。取消勾选后填写独立模型的 API Base URL、API Key、模型名称和超时，并通过 **测试联网模型** 检查流式回答和工具调用支持。

独立模型可以进一步搜索、读取资料，最终把总结与来源交给主 Agent。它没有终端工具，服务器操作仍由主 Agent 完成。独立模型错误会明确返回，不会自动改用默认模型。重新勾选会保留独立模型的设置，方便再次切换。

所有设置保存在 Electron 用户数据目录下的 `tabby-ai/config.yaml`。设置页保存后用于后续请求；旧版本配置会补齐默认值。搜索默认关闭，无需提供搜索配置也能使用原来的 Agent。

```yaml
web:
  mode: auto
  baseURL: "https://search.example.com"
  authorization: ""
  engines: []
  language: auto
  timeoutMs: 15000
  maxResults: 5
  maxCallsPerRun: 8
  maxPageChars: 12000
  useDefaultModel: true
  model:
    baseURL: ""
    apiKey: ""
    model: ""
    temperature: 0.2
    timeout: 60000
```

## 行为与限制

- `web_search` 返回标题、链接、摘要和可用的发布日期；可指定来源域名和时间范围。引擎列表留空时使用服务端配置；上游引擎失败会提示结果可能不完整。
- 搜索语言为 `auto` 或留空时，不发送 `language` 参数，使用 SearXNG 服务端默认值；明确填写语言代码时按该值查询。
- `web_fetch` 支持公开 HTTP/HTTPS 网页的 HTML、纯文本、Markdown 和 JSON；不运行 JavaScript、不登录网站、不读取 PDF。
- 终端和历史记录显示搜索、读取和整理状态，并记录来源与结果。模型应引用工具实际返回的 URL；搜索摘要与独立模型总结仍需核对。
- 网络请求限制超时、重定向和解压后的 2 MB 响应大小。正文和本轮累计结果另有限额；独立模型的联网调用共享主任务预算。
- 只有用户配置的 SearXNG 服务可以访问内网。任意网页读取会检查 IP、DNS 结果和每一次重定向，不允许内网、回环及保留地址。
- 搜索只发送必要的公开关键词；现有脱敏规则继续生效。搜索认证不会携带到网页，网页中的指令不能改变执行审批规则。
- 第一版 HTTP 客户端直接连接目标服务，不继承浏览器登录态或 Electron 代理设置。

## 开发验证

使用 Node.js 22：

```text
yarn test:ai-reliability
yarn test:native-agent
yarn test:ai-web-ui
yarn lint
yarn build
```

联网回归测试使用本地模拟的 SearXNG 与模型 SSE 服务，不调用付费模型。界面测试使用独立的 Electron 数据目录，不修改日常使用的配置。
