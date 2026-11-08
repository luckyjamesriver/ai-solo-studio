/** 持久化层的失败：全部显式、可识别，不吞错（ADR 0005）。 */

/** 修订号对不上：别处已经更新了这条记录。调用方应重新读取后再提出变更，不能覆盖。 */
export class StateConflictError extends Error {
  constructor(
    public readonly collection: string,
    public readonly id: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`记录 ${collection}/${id} 的修订号不一致：期望 ${expected}，实际 ${actual}`);
    this.name = 'StateConflictError';
  }
}

/** 过期的运行身份（runId）：这次回传来自已经被取代的运行，一律拒绝。 */
export class StaleRunError extends Error {
  constructor(
    public readonly collection: string,
    public readonly id: string,
    public readonly runId: string,
    public readonly currentRunId: string | undefined,
  ) {
    super(`记录 ${collection}/${id} 的运行 ${runId} 已过期（当前运行 ${currentRunId ?? '无'}）`);
    this.name = 'StaleRunError';
  }
}

/** 数据目录已被另一个写入者占用（另一个进程，或本进程的另一个持有者）。 */
export class WriterLockedError extends Error {
  constructor(public readonly root: string, detail: string) {
    super(`数据目录正被另一个写入者使用，已拒绝写入：${detail}`);
    this.name = 'WriterLockedError';
  }
}

/** 记录的 schema_version 高于本应用能理解的版本：拒绝读取，提示升级，不当作“不存在”，也不覆盖。 */
export class UnsupportedSchemaError extends Error {
  constructor(public readonly file: string, public readonly found: number, public readonly supported: number) {
    super(`记录的格式版本（${found}）比本应用支持的（${supported}）更新，请升级应用后再打开：${file}`);
    this.name = 'UnsupportedSchemaError';
  }
}

/** 记录无法解析或结构不对：不接受半成品作为权威数据。 */
export class CorruptRecordError extends Error {
  constructor(public readonly file: string, detail: string) {
    super(`记录无法解析或结构不对：${file}（${detail}）`);
    this.name = 'CorruptRecordError';
  }
}

export class VolumeNotSupportedError extends Error {
  constructor(public readonly dir: string, detail: string) {
    super(`数据目录不在本地 APFS 磁盘上，工作台不会在这里保存数据：${detail}`);
    this.name = 'VolumeNotSupportedError';
  }
}
