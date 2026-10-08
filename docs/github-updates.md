# GitHub 自定义更新

PI Desktop OCR 使用 `Naza3/pi-desktop-ocr` 自己的 GitHub Release 分发插件，不向官方插件中心提交。插件ID保持 `io.github.naza3.pi-desktop-ocr`。

## 用户配置

1. 确认可以访问本仓库的[最新正式Release](https://github.com/Naza3/pi-desktop-ocr/releases/latest)。Actions成功只表示构建完成，不能代替Release。
2. 打开PI Desktop的 **扩展 → 市场**，将来源切换为 **自定义**。
3. 填入完整地址，按Enter或点击输入框外保存：

   ```text
   https://github.com/Naza3/pi-desktop-ocr/releases/latest/download/catalog.json
   ```

4. 回到已安装插件，打开右上角 **更多操作 → 检查更新**。
5. 图片识别插件出现更高版本后点击更新。首次使用者也可以直接在该自定义市场安装。
6. 如需批量应用，在该插件行的菜单启用 **自动更新**，然后使用扩展页的 **应用自动更新**。新版本增加权限时，走单独更新的权限确认。

已有本地`.piplug`安装不必卸载重装。宿主按相同插件ID匹配更高版本；设置和历史位于独立数据目录，更新安装包不更换这些数据。

该自定义设置会切换整个市场，当前只列出PI Desktop OCR。其他已安装插件仍可运行，检查它们的更新时需要切回其来源。这个地址不是单个插件的独立更新设置。

依据PI Desktop参考源码`779e16d9c3ca2e966a7ae3db9dd0707243a2831f`（0.17.0），打开扩展页只对缓存目录检查版本，远端检查和应用更新由上述菜单触发；自动更新开关不是后台定时升级服务。后续宿主版本的行为以其实际实现为准。

## 维护者发布

1. 同步修改`package.json`、`package-lock.json`（含根package条目）及`manifest.json`中的版本。继续使用原插件ID。已有0.1.0安装要收到更新，正式版本必须大于0.1.0。
2. 执行本地检查：

   ```sh
   npm ci
   npm test
   npm run pack
   npm run check
   npm run catalog
   ```

   `pack`先运行严格类型检查。生成的`dist/catalog.json`仅供检查；此时其中指向的Release安装包可能尚未发布，不要将Actions预览目录当成已上线更新源。

3. 提交并推送，确认Linux和Windows构建通过。需要发布时创建与文件版本一致的`v<版本>` tag并推送。普通main推送不会发布Release。
4. tag工作流重新验证版本、测试、打包、生成目录。发布任务先核对目录、包的SHA256与源码commit，再创建草稿Release，上传三个附件并下载核验，最后公开发布。
5. 在GitHub Release中确认`.piplug`、`.piplug.sha256`、`catalog.json`三个附件齐全。最新正式版通过固定的`latest/download/catalog.json`提供目录；目录内安装包地址固定到具体tag。

Release发布任务串行执行。预发布版本（如`0.2.0-beta.1`）标记为prerelease，不更新稳定latest；补发比当前latest更旧的正式版也不切换更新源。已公开同一tag的附件不可覆盖；重跑只接受完全一致的文件。草稿阶段失败可以重跑恢复。

版本号不变时，即使代码或安装包已更新，PI Desktop也不会提示升级。main构建和生成目录不会自动递增版本、创建tag或对外发布。

## 目录兼容性

目录包含插件名称、版本、权限、最低PI Desktop版本、安装包绝对URL、大小、SHA256及源码commit，不包含用户设置、密钥、图片或识别文字。更新由PI Desktop宿主获取，无需扩大OCR插件的网络权限。

PI Desktop该版本的Rust解析器要求目录顶层及插件条目使用snake_case，而版本和provenance使用camelCase。生成器使用实际解析器字段，并补充官方JavaScript预检所需的`schemaVersion`、`providerId`别名。`minPiDesktop`输出裸版本`0.17.0`，避免宿主把`>=0.17.0`当作不可解析条件而跳过兼容检查。自定义源不声明官方认证。

每份目录只包含所属Release的一个版本。正在操作时恰好发布新版，若宿主提示旧版本不存在，刷新市场并选择当前版本重试。需要旧包时可在GitHub对应Release手动下载。

## 常见情况

- **地址404**：先确认有成功公开的正式Release，且其中包含`catalog.json`。仅有Actions构建或预发布不会启用该固定地址。
- **没有更新**：确认来源已保存并执行远端“检查更新”，再比较已安装版本和最新正式版；同版本不会更新。网络不可达时宿主可能继续使用旧缓存。
- **校验不通过**：不要替换同版本附件或修改校验值绕过验证，应检查发布任务，修正后递增版本重新发布。
- **开启自动更新仍未升级**：在核对过的宿主版本中还需执行“应用自动更新”；增加权限的新版需单独确认。

本次接入实现发布与目录生成流程。真正的GitHub下载链路及Windows完整宿主更新，应在发布首个正式版本后验收。

## 验证记录

2026-10-08（北京时间），任务 PI-OCR-GITHUB-UPDATES。

- `npm test`：142项通过、0失败/跳过。其中目录生成8项、发布流程16项，覆盖包hash、权限与文件范围、来源commit、版本/tag一致性、宿主最低版本、可重复生成、草稿分页查询/重试、已发布版本不覆盖、损坏下载拒绝发布及稳定源不回退。
- 固定官方devkit生产打包与check通过；业务代码的Node/DOM严格类型检查通过。
- 固定官方`check-marketplace-catalog.mjs`对实际生成的目录执行v2预检通过。
- 从同一官方commit原样抽取Rust目录结构定义，离线编译临时Serde夹具，成功读取真实`dist/catalog.json`的schema、provider、版本、readme、安装包URL/hash/大小和provenance。此项是实际类型解析验证，不是完整宿主安装。
- 发布流程通过注入GitHub命令适配器验证，不使用真实Release充当测试数据。
- GitHub Actions工作流通过actionlint检查。

本轮不将历史Windows CI、官方子进程或真实模型测试作为新发布流程的远端验收证据。插件业务运行时未修改，新增的是开发和发布工具。
