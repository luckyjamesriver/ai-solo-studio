// write-file-atomic 与 proper-lockfile 不带类型声明；这里只声明本项目用到的那部分（不新增 @types 依赖，见 ADR 0008）。
declare module 'write-file-atomic' {
  interface Options {
    encoding?: string;
    mode?: number;
    chown?: { uid: number; gid: number };
    /** 默认 true：落盘（fsync）后才 rename */
    fsync?: boolean;
    /** 临时文件创建后的回调（测试里用来模拟中断） */
    tmpfileCreated?: (tmpfile: string) => void | Promise<void>;
  }
  function writeFile(filename: string, data: string | Uint8Array, options?: Options | string): Promise<void>;
  export = writeFile;
}

declare module 'proper-lockfile' {
  interface LockOptions {
    stale?: number;
    update?: number;
    retries?: number | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean };
    realpath?: boolean;
    lockfilePath?: string;
    onCompromised?: (err: Error) => void;
  }
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function check(file: string, options?: { stale?: number; realpath?: boolean; lockfilePath?: string }): Promise<boolean>;
  const lockfile: { lock: typeof lock; check: typeof check };
  export default lockfile;
}
