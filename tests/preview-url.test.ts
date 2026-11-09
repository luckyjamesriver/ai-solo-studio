import { describe, it, expect } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';

describe('预览路径编码', () => {
  it('worktree 路径包含空格、中文、# 时，生成的 URL 正确', () => {
    const rawPath = '/Users/test/workspace/my worktree/中文项目/#1-issue/index.html';
    const url = pathToFileURL(rawPath).href;

    // 必须以 file:/// 开头
    expect(url.startsWith('file:///')).toBe(true);

    // 空格转为 %20（避免被截断）
    expect(url).toContain('my%20worktree');
    expect(url).not.toContain('my worktree');

    // 中文转为 UTF-8 百分号编码
    expect(url).toContain('%E4%B8%AD%E6%96%87%E9%A1%B9%E7%9B%AE');
    expect(url).not.toContain('中文项目');

    // # 转为 %23（避免被浏览器误判为 URL fragment / 锚点）
    expect(url).toContain('%231-issue');
    expect(url).not.toContain('#1-issue');

    // 能够通过 fileURLToPath 完美双向还原为原始文件系统路径
    expect(fileURLToPath(url)).toBe(rawPath);
  });
});
