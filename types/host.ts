/** Used subset of PluginHostApi at PI Desktop 779e16d9 (0.17.0).
 * Kept local so checking application code does not fetch/build the devkit.
 * The real host still enforces permissions and validates IPC at runtime.
 */
export interface PiHost {
  plugin: { getDataPath(): Promise<string> };
  commands: {
    register(command: { id: string; title: string; keywords?: string[]; run: () => Promise<void> | void }): Promise<void>;
    unregister(id: string): Promise<void>;
  };
  ui: { openPanel(options?: { title?: string }): Promise<void> };
  net: { fetch(input: { url: string; method?: string; timeoutMs?: number; headers?: Record<string, string> }): Promise<{ status: number }> };
  fs: { requestDirectory(): Promise<{ path: string; name: string } | null>; writeText(path: string, content: string): Promise<void> };
}
