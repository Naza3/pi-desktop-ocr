# PI Desktop OCR

为 **PI Desktop** 提供独立的本机图片 OCR 工作台。连接支持图片输入的 OpenAI 兼容服务，按导入顺序生成 Markdown；Nexa 是可选适配器。

- 一次最多20张PNG/JPEG，按导入顺序处理，可调整顺序。
- Markdown预览/原文、复制与另存，性能摘要在输出下方。
- 最近100条非空结果，包含失败时已生成的部分文字。
- TOML保存后端、模型ID、提示词、输出预算、等待时间、缩放和视图。
- 图片最长边支持原图、**256 / 512 / 1024 / 2048 / 3072 / 4096 / 6144**。缩放仅影响之后导入的图片，不放大小图。

## 安装

需要 **PI Desktop 0.17.0 或更新版本**。本项目依据0.17.0固定源码契约验证，更新版本需按实际兼容性判断。

1. 从本仓库的 [Actions](https://github.com/Naza3/pi-desktop-ocr/actions) 下载成功构建的 artifact；解压得到 `io.github.naza3.pi-desktop-ocr-0.1.0.piplug`。后续tag发行附件见 [Releases](https://github.com/Naza3/pi-desktop-ocr/releases)。
2. PI Desktop 左下角 **扩展** → 右上角 **更多操作** → **安装插件包**，选择 `.piplug`。
3. 在右侧工作面板选择“图片识别”，或运行命令 **PI Desktop OCR：打开图片识别**。

用户安装无需Node/npm。若宿主提示权限，核对后允许本机网络、剪贴板及导出目录操作。

## 连接 OpenAI 兼容服务

默认使用通用模式，例如支持视觉模型的 **llama.cpp server** 或本机兼容服务。

1. 在服务中准备支持图片输入的模型，启动其HTTP服务；模型文件、线程、上下文和服务执行超时由服务管理。
2. 插件“后端类型”选择 **OpenAI兼容**，填写地址，例如 `http://127.0.0.1:8080/v1`。也接受 `http://localhost:8080`，自动规范化为回环 `/v1` 地址。
3. 服务未启用认证时密钥留空；启用时填写该服务的API密钥。
4. 点击连接，选择或手动填写服务要求的准确模型ID，允许大小写和斜线，例如 `Vendor/Vision-Model`。模型列表不保证每个模型都支持图片。
5. 导入图片，确认预览与队列顺序，点击开始识别。

首版仅支持同机 `127.0.0.1`/`localhost`、显式端口的HTTP服务，不包含LAN或云API接入。通用协议使用 `GET /v1/models` 和流式 `POST /v1/chat/completions`，消息中携带base64 `image_url`。模型列表接口404/405时可手填ID；其他连接或认证错误正常报告。兼容声明以 [验证记录](docs/verification.md) 的实际服务为准，不代表任意OpenAI接口都具有视觉能力。

通用接口没有统一的自动加载、任务取消确认或prefill/decode指标标准。本插件不调用Nexa管理接口来补齐这些能力；缺失阶段指标显示“不可用”，保留服务提供的token用量和插件总耗时。点击停止会断开当前请求并保存部分文字，服务端可能仍在计算；请确认服务端任务结束后再连接并继续。

## 可选 Nexa 适配器

已有Nexa用户可以选择 **Nexa** 后端，默认地址 `http://127.0.0.1:18080`：

1. 在Nexa登记视觉主模型及其mmproj，启动服务。
2. 点击选择令牌文件，选择 `%LOCALAPPDATA%\Nexa\secrets\api-token`；自定义数据目录使用其中的 `secrets/api-token`。
3. 连接后选择配对视觉模型。按需要启用“自动加载”，插件仅在空闲状态加载/切换，不抢占其他任务或自动恢复故障。

此适配器保留Nexa同TCP的HMAC身份验证、实例隔离、请求取消和真实阶段性能查询。切换后端或地址会清除旧密钥，避免把一个服务的凭据传给另一个服务；可以随后明确输入新密钥。

## 参数、队列和数据

- 每张最终发送图片≤4MiB、单边≤8192、总像素≤16,777,216；支持PNG/JPEG。256等小尺寸适合大字或简单图片，小字表格建议保留足够分辨率。
- 通用模式输出预算1–32768；Nexa模式1–4096。实际容量由模型/服务决定，不保证服务接受插件允许的所有预算。
- 插件等待30–86400秒，默认1800；后端执行超时独立配置。默认提示词 `Text Recognition:` 可按模型修改。
- 失败、停止、输出截断或保存失败暂停批次，继续只处理尚未开始的条目。已输出请求不自动重试。
- `preferences.toml`保存设置；`history.toml`保存最多100条非空结果且总文件≤16MiB，超限先移除最旧记录。单条正文≤1MiB。原图/未开始队列不落盘。
- 密钥默认只在内存；勾选记住后保存到插件私有 `credentials.toml`，没有额外加密。取消记住/清除密钥会删除该文件。
- 关闭面板继续后台工作；禁用插件/退出PI会尽力取消并保存部分内容。每约4秒保存文字检查点，突然退出仍可能丢失最后几秒输出。
- Markdown预览禁止主动链接和远程图片，识别正文不进入Agent工具执行链。

## 从旧 Nexa OCR 插件迁移

这是独立项目，插件ID为 **`io.github.naza3.pi-desktop-ocr`**；旧ID `io.github.naza3.nexa-ocr` 的设置/历史仍留在原私有目录，新插件不会后台读取或删除它们。安装后重新配置服务即可；需要保存旧识别结果时，可在旧插件先导出Markdown。两个插件可以并存，运行任务由后端服务协调。

## 开发

需要Git和Node22.19+（CI固定Node24.19.0）。

```sh
npm ci
npm test
npm run pack
npm run check
```

首次check/pack会自动准备固定版本官方PI SDK/devkit到 `.cache/pi-devkit`，需要网络；不安装PI完整桌面workspace。也可用 `PI_PLUGIN_DEVKIT_CLI` 明确指定同固定版本官方CLI。脚本支持Linux/Windows，Windows目录关联使用junction。

`build/plugin`是开发目录，`dist/*.piplug`是安装包，附带SHA256。三处版本（package.json、package-lock.json、manifest.json）一致，tag采用 `v0.1.0`；tag与文件版本不一致时发行失败。main构建仅产生Actions artifact，创建有效tag才发行。

协议见 [CONTRACT.md](CONTRACT.md)，架构/边界见 [docs/architecture.md](docs/architecture.md)，来源许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
