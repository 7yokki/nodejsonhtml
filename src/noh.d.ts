export interface NOHAssets {
  wasm: string;
  seabios: string;
  vgabios: string;
  /** Hızlı yol: boot edilmiş snapshot. Verilirse bzimage/initrd yok sayılır. */
  initialState?: string;
  bzimage?: string;
  initrd?: string;
  hda?: string;
}
export interface NOHOptions {
  V86: new (config: any) => any;
  assets: NOHAssets;
  cmdline?: string;
  memoryMB?: number;
  vgaMemoryMB?: number;
  bootTimeoutMs?: number;
  execTimeoutMs?: number;
  nodeBin?: string;
  workdir?: string;
  mountPoint?: string;
  /** Verilirse ağ açılır (varsayılan: kapalı). WebSocket relay URL'si. */
  networkRelay?: string;
  onLog?(line: string): void;
  onProgress?(p: { phase: string; ratio: number }): void;
}
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array | ArrayBuffer;
  timeoutMs?: number;
}
export interface RunNodeOptions extends ExecOptions {
  args?: string[];
  esm?: boolean;
}
export interface ExecResult { code: number; stdout: string; stderr: string }

export class NOHError extends Error { code?: string; stdout?: string; stderr?: string }

export class NOH {
  constructor(opts: NOHOptions);
  readonly state: "idle" | "booting" | "ready" | "closed";
  boot(): Promise<this>;
  exec(command: string, o?: ExecOptions): Promise<ExecResult>;
  run(command: string, o?: ExecOptions): Promise<ExecResult>;
  nodeVersion(): Promise<string>;
  runNode(code: string, o?: RunNodeOptions): Promise<ExecResult>;
  runNodeFile(path: string, o?: RunNodeOptions): Promise<ExecResult>;
  npm(args: string, o?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void>;
  writeFiles(map: Record<string, string | Uint8Array>, baseDir?: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  rm(path: string, o?: { recursive?: boolean }): Promise<void>;
  ls(path?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  saveSnapshot(): Promise<ArrayBuffer>;
  destroy(): Promise<void>;
}
export function shq(s: string): string;
export function b64encode(b: Uint8Array): string;
export function b64decode(s: string): Uint8Array;
export default NOH;

/* ---- tarayıcı katmanı (dist/noh.js, window.NOH) ---- */
export interface NOHRunResult { code: number; stdout: string; stderr: string }
export interface NOHBrowserOptions {
  base: string; memoryMB: number; auto: boolean; outputSelector: string; consoleOutput: boolean;
  v86: string; wasm: string; seabios: string; vgabios: string; state: string; bzimage: string; initrd: string;
}
export interface NOHLibrarySpec { name?: string; url?: string; code?: string; main?: string }
export interface NOHBrowserEvents {
  ready: { node: string };
  progress: { phase: string; ratio: number };
  stdout: { text: string; label: string };
  stderr: { text: string; label: string };
  exit: { code: number; label: string };
  library: { name: string; path: string };
  error: Error;
}
export class NOHBrowser {
  options: NOHBrowserOptions;
  ready: Promise<this>;
  Core: typeof NOH;
  config(o: Partial<NOHBrowserOptions>): this;
  boot(): Promise<this>;
  on<K extends keyof NOHBrowserEvents>(ev: K, fn: (e: NOHBrowserEvents[K]) => void): () => void;
  off<K extends keyof NOHBrowserEvents>(ev: K, fn: (e: NOHBrowserEvents[K]) => void): void;
  addLibrary(src: string | NOHLibrarySpec): Promise<string>;
  run(code: string, o?: { esm?: boolean; args?: string[]; env?: Record<string, string>; cwd?: string; stdin?: string | Uint8Array; timeoutMs?: number; label?: string }): Promise<NOHRunResult>;
  exec(cmd: string, o?: ExecOptions): Promise<ExecResult>;
  container(): Promise<NOH>;
  scan(root?: ParentNode): void;
  observe(): void;
  idle(): Promise<void>;
  destroy(o?: { force?: boolean }): Promise<void>;
}
export function install(target?: object): NOHBrowser;
export function guessLibName(url: string): string;
declare global { interface Window { NOH: NOHBrowser } }
