import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const rendererDir = path.join(root, 'src', 'renderer');
const fontsDir = path.join(rendererDir, 'fonts');

describe('视觉规范与随包字体（UI v2.1 第 10 节）', () => {
  it('tokens.css 定义 UI v2.1 第 10 节全部设计变量与本地 woff2 @font-face', () => {
    const tokens = fs.readFileSync(path.join(rendererDir, 'tokens.css'), 'utf8');
    for (const hex of [
      '#3D755D',
      '#2F5C49',
      '#E3ECE6',
      '#E8F0EB',
      '#C2410C',
      '#9A3412',
      '#FFF8F3',
      '#1A7F37',
      '#F5F3ED',
      '#E2DED3',
      '#1F2328',
      '#4B5560',
      '#D0D4DA',
      '#8C959F',
    ]) {
      expect(tokens, `缺少颜色变量 ${hex}`).toContain(hex);
    }
    for (const family of ['Instrument Serif', 'Lato', 'Noto Sans SC', 'Noto Serif SC']) {
      expect(tokens).toContain(`'${family}'`);
    }
    expect(tokens).not.toMatch(/https?:\/\//);
  });

  it('src/renderer 除 tokens.css 外不写死任何颜色值，且不从网络加载资源', () => {
    for (const f of fs.readdirSync(rendererDir)) {
      const full = path.join(rendererDir, f);
      if (!fs.statSync(full).isFile()) continue;
      if (f === 'tokens.css' || !/\.(css|ts|tsx|html)$/.test(f)) continue;
      const content = fs.readFileSync(full, 'utf8');
      expect(content, `${f} 不得写死十六进制颜色或 rgb()`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
      expect(content, `${f} 不得包含外部网址`).not.toMatch(/https?:\/\//);
    }
  });

  it('src/renderer/fonts/ 包含全部 4 套 woff2 字体和对应 OFL-1.1 许可证文本', () => {
    const expectedFiles = [
      'InstrumentSerif-Regular.woff2',
      'InstrumentSerif-OFL-1.1.txt',
      'Lato-Regular.woff2',
      'Lato-Bold.woff2',
      'Lato-OFL-1.1.txt',
      'NotoSansSC-VF.woff2',
      'NotoSansSC-OFL-1.1.txt',
      'NotoSerifSC-VF.woff2',
      'NotoSerifSC-OFL-1.1.txt',
    ];
    for (const f of expectedFiles) {
      const p = path.join(fontsDir, f);
      expect(fs.existsSync(p), `缺少 ${f}`).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }
    for (const f of expectedFiles.filter((x) => x.endsWith('.txt'))) {
      const txt = fs.readFileSync(path.join(fontsDir, f), 'utf8');
      expect(txt).toContain('SIL OPEN FONT LICENSE');
      expect(txt).toContain('Version 1.1');
    }
  });
});
