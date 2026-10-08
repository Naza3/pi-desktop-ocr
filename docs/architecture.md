# 调用层与后端边界

PI Desktop renderer → 插件Controller → 后端工厂 → OpenAIClient / 可选NexaClient → 本机推理服务。

Controller只持有统一的连接、识别、流式增量与结果合同。OpenAI默认路径不依赖Nexa存在，不调用`/healthz`、`/runtime/*`或模型加载接口。其模型能力为未知，用户选择视觉模型；手填ID不依赖模型列表登记。

Nexa适配器独立保留服务证明、加载/取消所有权、实例绑定及真实性能检查。snapshot通过capabilities声明自动加载、性能、必需令牌与手填模型能力，renderer按实际后端展示。

网络权限先通过宿主不带凭据的健康/模型列表读取取得，流式请求由Node HTTP处理。每个适配器都在建立连接前固定校验回环地址；不允许重定向或隐式代理。通用模式的密钥发送给用户明确选定的本机服务，Nexa模式另有同TCP HMAC验证。

API地址或backend切换清除旧密钥和连接，显式提供的新密钥只归新端点。PI私有目录中的TOML保持调用层所有权，默认不持久化密钥，图片/队列仅内存。新插件ID独立于旧Nexa OCR，保留旧插件数据原位。

批量最多20张，Controller队列按导入顺序逐张运行。renderer只逆序显示队列，使新导入的位于顶部，保留原执行编号；移动使用原队列索引，不倒转实际识别顺序。失败/停止/截断/保存异常暂停；继续只处理pending。通用API断开不是后台取消确认，用户须在后端确认任务已结束后再连接。性能字段为后端事实，不能把UI墙钟总耗时换算为引擎prefill/decode。

历史以独立插件内dialog查看，选择、视图、异步请求编号与当前结果独立。磁盘HistoryResult仅为内部id、原文件名name及正文text，最多100条/16MiB；不存图片、模型、性能或凭据。旧schema 1完整记录读取时映射为上述字段，下次保存原子写入简化记录。实时OcrResult保留状态和性能，历史不冒称完整成功。

TypeScript业务源码由esbuild生成CJS主入口及浏览器JavaScript，再由固定官方PI devkit检查和打包。shared/contracts.ts作为编译期合同；主进程宿主输入、HTTP/SSE/TOML仍从unknown执行运行时校验。Controller的MutationHandlers逐频道限定返回类型，renderer的invoke关联频道、参数和返回值，避免只改文件后缀。

tsconfig.node.json与tsconfig.renderer.json分别启用Node和DOM类型，strict/noEmit/verbatimModuleSyntax/erasableSyntaxOnly检查；不以esbuild转译代替类型检查。宿主API采用锁定0.17.0实际使用的最小本地声明。测试直接用Node类型擦除导入.ts，生产包不依赖TS运行时。CI分别在Linux与Windows运行；完整Windows Electron宿主验证单列，不由打包成功推定。
