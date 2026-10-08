# 项目来源与第三方许可

本项目从 `Naza3/Nexa` 提交 `93cdf6d4493570714f744cd7c246ccc908a4a8d3` 中的 `integrations/pi-desktop-ocr` 提取后独立维护；原作者MIT版权声明保留在LICENSE。项目名称、默认后端、ID和发布流程已独立。Nexa服务仅为可选外部后端，未随包分发。


This plugin's appearance integration is adapted from Side Chat by VastSa,
MIT licensed, revision `a815de103f3f28f6bbdbe4824753ad761d393284`:
https://github.com/vastsa/pi-desktop-side-chat
The original license is retained in `licenses/side-chat-MIT.txt`.

The production JavaScript bundles include:

| Component | Version | License | Original license files in package |
| --- | --- | --- | --- |
| marked | 18.1.0 | MIT | licenses/marked-LICENSE.txt |
| DOMPurify | 3.4.16 | Apache-2.0 OR MPL-2.0 | licenses/dompurify-LICENSE.txt, licenses/dompurify-LICENSE-MPL.txt |
| smol-toml | 1.9.0 | MIT | licenses/smol-toml-LICENSE.txt |

PI Desktop and Nexa runtime are external applications, not bundled here.
PI's official SDK/devkit is used to validate/package the plugin, not included
as a runtime dependency. Its pinned reference is
`vastsa/PI-Desktop@779e16d9c3ca2e966a7ae3db9dd0707243a2831f`.
