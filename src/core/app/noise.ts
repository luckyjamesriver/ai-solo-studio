/**
 * 诊断记录展示层的噪音过滤：只去掉 Apple 自带 git 垫片（xcrun）与 xcodebuild 的几类已知无害行，
 * 它们出现在沙箱里运行 git 时（B3-1 实测：命令仍然成功）。原始记录保留不改，这里只用于“展示”。
 * 规则故意写死为这几类，不做模糊匹配——不能把真正的错误一起吞掉。
 */
const KNOWN_NOISE = [/xcrun_db/, /confstr\(\) failed/, /DVTFilePathFSEvents/, /DVTDeveloperPaths/];

export function isKnownNoiseLine(line: string): boolean {
  return KNOWN_NOISE.some((re) => re.test(line));
}

/** 去掉已知噪音行，其余原样保留（包括空行与顺序）。 */
export function filterDiagnosticNoise(text: string): string {
  return text
    .split('\n')
    .filter((l) => !isKnownNoiseLine(l))
    .join('\n');
}
