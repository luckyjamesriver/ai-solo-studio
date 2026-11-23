import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  LearningEngine,
  LEARNING_ENGINE_DELIVERY_STATUS,
} from '../src/core/app/learning-engine.js';
import { LearningStore } from '../src/core/persistence/learning.js';

describe('LearningEngine 真实持久化与跨进程重启恢复', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiss-learning-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('交付状态明确标记为 experimental_unintegrated', () => {
    expect(LEARNING_ENGINE_DELIVERY_STATUS).toBe('experimental_unintegrated');
  });

  it('初始状态下无记录，返回空数组', () => {
    const engine = new LearningEngine();
    expect(engine.getLearnings(tmpDir)).toEqual([]);
    expect(engine.formatLearningsForPrompt(tmpDir)).toBe('');
  });

  it('记录学习经验并真实持久化到磁盘 .studio/learnings.json', () => {
    const engine = new LearningEngine();
    const res = engine.recordLearning(tmpDir, {
      taskTitle: '高精度计算器模块',
      trigger: '精度溢出',
      rule: '浮点运算必须采用 bignumber 或定点整数处理',
      origin: 'auto_reflection',
    });

    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data?.taskTitle).toBe('高精度计算器模块');

    // 验证物理磁盘文件确实生成
    const filePath = path.join(tmpDir, '.studio', 'learnings.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const onDiskRaw = fs.readFileSync(filePath, 'utf8');
    const onDiskJson = JSON.parse(onDiskRaw);
    expect(Array.isArray(onDiskJson)).toBe(true);
    expect(onDiskJson.length).toBe(1);
    expect(onDiskJson[0].rule).toContain('浮点运算必须采用');
  });

  it('重要验证：实例销毁后新建实例（模拟应用进程重启），能完整恢复持久化记录', () => {
    // 1. 第一个实例写入多条经验
    let engine1: LearningEngine | null = new LearningEngine();
    engine1.recordLearning(tmpDir, {
      taskTitle: '任务A',
      trigger: 'CI 检查失败',
      rule: '提交前必须本地运行全量类型检查',
      origin: 'system',
    });
    engine1.recordLearning(tmpDir, {
      taskTitle: '任务B',
      trigger: '文件冲突',
      rule: '写入状态必须经由 PersistenceService 原子写入',
      origin: 'user_feedback',
    });

    // 2. 彻底销毁第一个实例引用（模拟进程退出）
    engine1 = null;

    // 3. 创建全新实例（模拟重新启动 App）
    const engine2 = new LearningEngine();
    const recovered = engine2.getLearnings(tmpDir);

    expect(recovered.length).toBe(2);
    // 最新记录在前
    expect(recovered[0]?.taskTitle).toBe('任务B');
    expect(recovered[0]?.rule).toContain('PersistenceService');
    expect(recovered[0]?.origin).toBe('user_feedback');
    expect(recovered[1]?.taskTitle).toBe('任务A');

    // 验证 prompt 格式化输出包含历史记录
    const promptText = engine2.formatLearningsForPrompt(tmpDir);
    expect(promptText).toContain('【工程历史避坑经验库 (前车之鉴)】');
    expect(promptText).toContain('【任务B】写入状态必须经由 PersistenceService 原子写入');
  });

  it('容错保护：磁盘 JSON 损坏时优雅降级为 []，不向调用方抛出未捕获崩溃', () => {
    const studioDir = path.join(tmpDir, '.studio');
    fs.mkdirSync(studioDir, { recursive: true });
    // 写入损坏的非法 JSON
    fs.writeFileSync(path.join(studioDir, 'learnings.json'), '{ invalid json string content ::::', 'utf8');

    const engine = new LearningEngine();
    // 必须优雅返回 []，绝不崩溃
    expect(() => engine.getLearnings(tmpDir)).not.toThrow();
    expect(engine.getLearnings(tmpDir)).toEqual([]);
  });

  it('容错保护：磁盘内容非数组或存在残损记录时自动清洗', () => {
    const studioDir = path.join(tmpDir, '.studio');
    fs.mkdirSync(studioDir, { recursive: true });
    fs.writeFileSync(
      path.join(studioDir, 'learnings.json'),
      JSON.stringify([
        null,
        'not an object',
        { taskTitle: '缺少 rule' },
        { taskTitle: '合法项', rule: '规范守则', trigger: '触发条件' },
      ]),
      'utf8',
    );

    const engine = new LearningEngine();
    const learnings = engine.getLearnings(tmpDir);
    expect(learnings.length).toBe(1);
    expect(learnings[0]?.taskTitle).toBe('合法项');
    expect(learnings[0]?.rule).toBe('规范守则');
  });

  it('上限保护：单个项目最多保留 50 条最新经验', () => {
    const engine = new LearningEngine();
    for (let i = 1; i <= 60; i++) {
      engine.recordLearning(tmpDir, {
        taskTitle: `任务-${i}`,
        trigger: `触发-${i}`,
        rule: `规则-${i}`,
      });
    }

    const current = engine.getLearnings(tmpDir);
    expect(current.length).toBe(50);
    expect(current[0]?.taskTitle).toBe('任务-60');
  });
});
