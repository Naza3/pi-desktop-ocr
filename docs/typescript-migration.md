# TypeScript、倒序显示与历史弹窗

任务 PI-OCR-TS-1，2026-10-08（北京时间）。用户授权迁移TypeScript，追加新图片显示在上、先导入先识别，并选择插件内独立历史弹窗。版本保持0.1.0，当前任务本地交付，不自动推送或创建标签。

## 最终实现

全部7个主进程模块与2个renderer模块迁移为.ts。shared/contracts.ts统一Settings、Snapshot、结果、后端接口和频道参数/返回值；主进程用逐频道返回映射，renderer用关联频道的invoke。宿主入口及HTTP/SSE/TOML仍从unknown验证，Node与DOM类型分开。strict、noEmit、verbatimModuleSyntax、isolatedModules与erasableSyntaxOnly检查接入build和Linux/Windows CI；esbuild继续产出main.cjs和renderer/app.js，.piplug无需额外TS运行时。

队列数组和执行器仍为FIFO；显示逆序保留原编号，移动按钮“提前识别 / 延后识别”作用于原队列索引。历史dialog使用独立选择、视图和异步请求序号，查看或关闭不改变当前结果、预览或识别任务。支持Markdown/原文、复制、另存为、删除；复用Markdown净化，Esc关闭恢复入口焦点。

history.toml每条仅为id/name/text；内部id服务于选择、检查点替换及删除，用户内容仅原文件名与识别正文。100条/16MiB总量、1MiB单条与原子写入保持。旧schema 1记录可读，下次保存转为精简形状；图片仍仅内存。历史可能含中断时保存的部分输出，不将其标为完整成功；实时结果继续提供状态和性能。

## 验证

| 层级 | 命令或方法 | 结果 |
| --- | --- | --- |
| 迁移前基线 | npm test | 109通过，0失败/跳过 |
| 类型 | npm run typecheck | Node与DOM严格检查通过；11个负例验证错误频道/参数/返回值和历史字段受限 |
| 逻辑及协议 | npm test | 118通过，0失败/跳过；包含100条裁剪、检查点、旧TOML兼容、字段白名单、图片不落盘、结构化异常部分文字与预算 |
| 生产包 | npm run pack、npm run check | 固定PI官方devkit通过，14文件；保留本机网络/文件权限和renderer剪贴板的既有提示 |
| 官方宿主子进程 | 生产main.cjs→固定官方PI child→标准HTTP/SSE fixture | 两图FIFO、SSE终态/用量、无密钥/手填模型、设置/历史重启、服务切换凭据隔离通过；仅标准models/chat路径 |
| 浏览器整合 | Chromium→真实Controller→真实Store，后端/宿主明确fixture | UI逆序与执行FIFO、移动往返、运行中查看历史、净化/复制/导出/删除/空态、设置与历史重启通过；1100/700/390/300宽度无横向溢出 |

只读交叉审查用内存编译器将ocr.connect的started故意改为string，得到TS2322，确认handler约束并非名义类型。审查发现具体错误类instanceof会丢失第三方适配器的结构化partialResult，已改为逐字段验证；正式回归覆盖无onDelta部分文字、清理未确认、身份不可覆盖、超限正文和伪造指标。

另收紧Nexa的UUID响应字段：拒绝通过隐式转换伪装成字符串的单元素数组。新增status/models及performance用例，畸形性能仍显示不可用，不影响有效识别正文。合法协议原有87项客户端回归保持。

证据位于 `/workspace/onboarding/pi-ocr/ts-*`、`/workspace/onboarding/pi-ocr-typescript/renderer-real-controller-evidence.json`、`/workspace/onboarding/pi-ocr-typescript-host/standalone-host-smoke-result.json`；不提交夹具数据、图片或正文。生产main验证SHA256为 `cf81736298aa006c444f4e993602869684ac889d405f8521b237205ea1a353b4`。

本轮未将旧真实GLM-OCR结果当作新源码实测，也未声称Linux子进程/Chromium代表Windows完整PI宿主安装、文件窗口或实际长图质量。没有新增依赖或更改锁定第三方版本，现有Node/TypeScript/esbuild环境足够，无需新增环境配置。正式Windows CI和用户目标机验证仍待后续推送/试用。
