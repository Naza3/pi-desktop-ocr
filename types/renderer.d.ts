import type { OcrInvoke } from '../shared/contracts.ts';
interface PluginBridge {
  invoke: OcrInvoke & ((channel: 'clipboard.writeText', payload: { text: string }) => Promise<unknown>)
    & ((channel: 'app.getAppearance') => Promise<unknown>);
  on(event: 'appearance:changed', callback: (value: unknown) => void): void;
}
declare global { interface Window { pluginBridge?: PluginBridge } }
export {};
