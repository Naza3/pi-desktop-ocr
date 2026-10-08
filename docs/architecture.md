# 调用层与后端边界

PI Desktop renderer → 插件Controller → 后端工厂 → OpenAIClient / 可选NexaClient → 本机推理服务。

Controller只持有统一的连接、识别、流式增量与结果合同。OpenAI默认路径不依赖Nexa存在，不调用`/healthz`、`/runtime/*`或模型加载接口。其模型能力为未知，用户选择视觉模型；手填ID不依赖模型列表登记。

Nexa适配器独立保留服务证明、加载/取消所有权、实例绑定及真实性能检查。snapshot通过capabilities声明自动加载、性能、必需令牌与手填模型能力，renderer按实际后端展示。

网络权限先通过宿主不带凭据的健康/模型列表读取取得，流式请求由Node HTTP处理。每个适配器都在建立连接前固定校验回环地址；不允许重定向或隐式代理。通用模式的密钥发送给用户明确选定的本机服务，Nexa模式另有同TCP HMAC验证。

API地址或backend切换清除旧密钥和连接，显式提供的新密钥只归新端点。PI私有目录中的TOML保持调用层所有权，默认不持久化密钥，图片/队列仅内存。新插件ID独立于旧Nexa OCR，保留旧插件数据原位。

批量最多20张，按导入顺序逐张运行。失败/停止/截断/保存异常暂停；继续只处理pending。通用API断开不是后台取消确认，用户须在后端确认任务已结束后再连接。性能字段为后端事实，不能把UI墙钟总耗时换算为引擎prefill/decode。

纯JavaScript包由esbuild生成CJS主入口及浏览器脚本，经固定官方PI devkit检查和打包。CI分别在Linux与Windows运行；完整Windows Electron宿主验证单列，不由打包成功推定。
