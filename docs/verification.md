# 独立项目验证记录

最新任务：2026-10-08 TypeScript迁移、队列倒序显示与精简历史弹窗，见[本轮验证](typescript-migration.md)。以下保留独立项目初建时的历史证据，不代替最新源码验证。

日期：2026-10-08（北京时间）。任务 PI-OCR-INITIAL。用户授权将插件独立为 `Naza3/pi-desktop-ocr`，改名、解除Nexa强制依赖并推送；随后要求增加1024/512/256缩放选项。

## 实现范围

从旧项目固定提交93cdf6d提取插件源文件及许可到用户已创建的空仓库，未复制Nexa模型、Rust/native源码、用户数据或旧Git历史。新ID `io.github.naza3.pi-desktop-ocr`，包名/界面/命令/构建/README均独立。Nexa只作为可选适配器，来源与版权保留。

默认通用模式仅调用本机标准 `/v1/models`、`/v1/chat/completions`，支持可选密钥、手填含斜线的模型ID。端点/后端变更清除旧凭据；通用模式不假称能加载/取消模型或取得精确阶段性能。缩放新增256、512、1024，UI、主进程参数范围和图片算法一致。

## 本地验证

| 层级 | 实际命令/方法 | 结果 |
| --- | --- | --- |
| 逻辑/HTTP协议 | `npm test` | 109通过、0失败/忽略：通用客户端53、Nexa客户端34、Controller/Store15、图片7 |
| 生产包 | `npm run pack`、`npm run check` | 固定官方PI devkit成功，14文件；项目名称、插件ID、三处版本一致 |
| 工具准备 | `node scripts/prepare-devkit.mjs` 从零缓存 | 固定官方commit下载、SDK/devkit编译成功；不依赖旧workspace路径 |
| 前端 | Chromium→真实Controller→真实Store，后端/PI API为明确fixture | 无密钥双图、手填模型、密钥隔离、可选Nexa、TOML重启、历史/导出均通过；1100/700/390/300无横向溢出 |
| 实际缩放 | 浏览器Canvas与图片单测 | 256实际得到256×128；用户长图3056×5812按256/512/1024得到135×256、269×512、538×1024；小图不放大 |
| 宿主整合 | 新生产CJS→固定官方PI plugin child→标准HTTP fixture | 新ID/ocr.open面板、无key手填模型两图、TOML重载、端点/后端密钥隔离通过；请求只有标准models/chat |
| 独立真实模型 | 新OpenAIClient→固定上游llama-server→GLM-OCR | 两图成功，完全没有Nexa进程或专用API，详情见下文 |

官方check保留必要的本机网络/写目录权限提示，以及clipboard写入只在renderer使用导致的main扫描提示。没有通过放宽网络域或删除实际权限来隐藏检查结果。

真实后端使用llama.cpp `2149c00f4442dc59302e134a02e4c99d5f7ed9fc` 构建的独立llama-server，GLM-OCR-Q8_0 + mmproj，CPU4线程/context8192/batch256。PNG/JPEG各960×300合成小票按序完成，各385输入/36输出token、finish=stop、3/3锚点，总6/6。请求审计仅一次标准models、两次标准chat。performance=null；17.474秒和17.358秒只代表Linux云机器，不代表用户i5-8400。自有服务正常退出0。

开发环境证据：`/workspace/onboarding/pi-ocr/standalone-unit-tests-final.log`、`standalone-real-llama-{result,observation,cleanup}.json`；浏览器证据 `/workspace/onboarding/pi-desktop-ocr/renderer-real-controller-evidence.json` 和四尺寸截图。证据不把令牌、原图或识别正文写进源码仓库。

宿主整合证据 `/workspace/onboarding/pi-desktop-ocr/standalone-host-smoke-result.json`。测试main SHA256为 `621d4d14a36aeb74f10a8134c2859c2849d366c46cca72c6a399a5005104b4f3`；父API broker与后端响应为明确fixture，官方子进程及生产插件代码真实运行。仓库统一LF，保持两个平台源码与复制进包的文本一致。

## 推送与平台边界

本项目为JavaScript插件，没有Nexa Rust/Windows EXE交叉编译目标。先完成本地生产打包和实际验证，再推送main；CI在Ubuntu24.04和Windows2022分别运行相同测试/打包。该流程不等同用户Windows10上的PI Desktop Electron安装、目录窗口或实际长图质量验证。

本次只初始化并推送源码，不创建tag或新Release。main成功构建的artifact提供独立ID安装包；未来有效v* tag才发布。旧Nexa插件的原安装包、标签和私有数据目录保持。
