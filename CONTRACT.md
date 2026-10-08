# PI Desktop OCR 插件内部接口

宿主固定研究基线：PI-Desktop 779e16d9c3ca2e966a7ae3db9dd0707243a2831f（0.17.0）。独立 `.piplug`，无宿主/后端补丁。main 由 Node 进程执行，renderer 只用 `window.pluginBridge.invoke`。每个调用快速返回；推理在 main 后台运行，UI 单飞轮询 `ocr.snapshot`（运行时 500–750ms，空闲时 2s）。一个插件实例共享一个队列。

## Settings

`{backend:'openai', baseUrl:'http://127.0.0.1:8080/v1', modelId:'', prompt:'Text Recognition:', maxTokens:4096, timeoutSeconds:1800, maxImageEdge:0, view:'markdown', autoLoad:false, rememberToken:false}`。

`maxImageEdge` 为0（原图）或256..8192整数；`timeoutSeconds`为30..86400；maxTokens在OpenAI兼容模式为1..32768，Nexa模式为1..4096；服务实际容量独立。凭据不放进settings/snapshot/history，`ocr.settings`中单独提供token（通用模式可空、≤4096可打印ASCII；Nexa为64位小写hex）。主进程只有显式rememberToken=true才写入插件私有credential文件，其他偏好TOML、history TOML；UI用`hasToken`布尔状态，不回显已保存的令牌。可用password输入框或用户主动选择纯文本密钥文件导入，不扫描或后台读取用户凭据目录。

## Bridge channels

- `ocr.snapshot({})` -> Snapshot（下表）
- `ocr.settings({patch,token?})` -> Snapshot。运行期间拒绝修改；省略token表示保持，显式空token或`ocr.clearToken`表示清除；端点或后端变更时省略token也清除旧凭据，明确的新token只用于新端点。
- `ocr.clearToken({})` -> Snapshot。
- `ocr.connect({})` -> `{started:true}`，后台连接后snapshot更新；需先保存设置。
- `ocr.image.begin({name,width,height,bytes,mimeType,dataLength})` -> `{uploadId}`。PNG/JPEG、≤4MiB、8192边、≤16777216像素；一次一个暂存上传，dataLength≤5600000。
- `ocr.image.chunk({uploadId,chunk})` -> `{received}`。chunk是dataURL字符串片段，≤196608字符。
- `ocr.image.commit({uploadId})` -> `{id}`。main完整核对dataURL/尺寸后入队，状态pending。最多20图，默认导入顺序。
- `ocr.image.abort({uploadId})` -> `{ok:true}`。
- `ocr.image.read({id,offset})` -> `{chunk,total}`，每次最多196608字符；可供新打开窗口恢复预览。
- `ocr.queue({action:'move',id,direction:-1|1})` / `{action:'remove',id}` / `{action:'clear'}` -> Snapshot。运行中拒绝变动；已开始图不能改回pending或自动重放。
- `ocr.start({})` -> `{started:true}`，后台按顺序处理pending，复用模型。停止/失败暂停整批，再开始仅继续pending，不重做已开始项。
- `ocr.stop({})` -> `{stopping:true}`，中止本插件当前请求并保存部分文字。Nexa等待原生清理确认；通用模式只断开请求，标记后台清理无法确认，继续前提示用户确认服务端结束并重新连接。
- `ocr.result({id})` -> Result|HistoryResult|null，可查队列已运行项/历史。仍在内存队列中的条目含实时状态；磁盘历史只返回id/name/text。
- `ocr.history.delete({id})` / `ocr.history.clear({})` -> Snapshot（运行中拒绝）。
- `ocr.export({id})`通过主进程 `pi.fs.requestDirectory`+`pi.fs.writeText` 写用户选择目录，不允许UI提供任意磁盘路径。

复制使用`pluginBridge.invoke('clipboard.writeText', {text})`。

## Snapshot

```ts
{
 settings: Settings, hasToken: boolean,
 capabilities: {autoLoad:boolean,performance:boolean,requiresToken:boolean,manualModelId:boolean},
 connection: {state:'disconnected'|'connecting'|'connected'|'error', message:string, instanceId:string|null},
 models: Array<{id:string, name:string, hasProjector:boolean|null, loadable:boolean}>,
 runtime: object|null,
 busy:boolean, stopping:boolean, phase:string, error:string|null,
 queue: Array<{id:string,name:string,width:number,height:number,bytes:number,status:'pending'|'running'|'completed'|'failed'|'cancelled',error:string|null}>,
 activeId:string|null,
 result: Result|null,
 history: Array<{id:string,name:string,preview:string}>,
 persistenceError:string|null, needsRefresh:boolean,
 exporting:boolean, exportMessage:string|null
}
type Result = {
 id:string,name:string,backend:'openai'|'nexa',modelId:string,createdAt:string,
 status:'running'|'completed'|'failed'|'cancelled',
 text:string,complete:boolean,error:string|null,requestId:string|null,
 finishReason:string|null,usage:object|null,performance:object|null, elapsedMs:number
}
type HistoryResult = {id:string,name:string,text:string}
```

通用模式没有统一阶段计时，performance=null；可选Nexa适配器使用原始PerformanceRecord（performance.timings含prepare_us/prefill_us/decode_us/output_callback_us，外层timings为queue_ms/load_ms/execution_ms），不把页面计时冒充引擎指标。无数据写null。只有匹配实例+request ID的记录可附加。

历史只保存最近100条非空HistoryResult：内部id、原文件名name、正文text；不保存原图、令牌、模型、时间、性能或完整性状态。文本总上限单条1MiB，历史总上限16MiB；写入失败要提示并暂停批次，不能假称已保存。旧schema 1历史读取保留id/name/text，下次写入转换为精简形状；部分识别正文仍保存，历史窗口不将其标为完整成功。

Snapshot.queue始终是实际FIFO执行顺序；renderer以倒序显示、原index+1编号。历史dialog维护独立选中ID/视图/异步请求序号，查看或关闭不改变当前结果和队列。编译期完整接口见[shared/contracts.ts](shared/contracts.ts)，运行时验证仍在各入口执行。

`ocr.export`快速返回`{started:true}`，主进程后台弹目录窗口、写入新名字的Markdown，结果放snapshot的`exporting:boolean`与`exportMessage:string|null`。

## 生命周期

运行按钮属于本插件，不进入PI Agent工具历史。默认OpenAIClient只使用标准models/chat端点，不管理后端模型；可选NexaClient独立提供专有服务证明、空闲自动加载、拥有权取消与实例性能。不给未知模型标记视觉能力。卸载插件时Abort并尽力保存当前部分结果。
