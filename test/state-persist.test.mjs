/**
 * test/state-persist.test.mjs — gh-watch 状态持久化最小回归（2026-09-20 首次补测）
 *
 * 本仓库此前**零测试**：v0.1.1 引入的「每日 state.json 基线备份」因 `fs.promises` 上没有
 * `existsSync` 而**连坏 5 天**且被 try/catch 静默（2026-09-19 由另一会话以 85ce7e8 修掉）。
 * 本文件把那次的教训固化成两条机械断言：
 *   ①每日备份**真的产出** .bak-YYYYMMDD（且内容是备份时刻的磁盘状态）——修复前必失败；
 *   ②写盘**并集**：持有旧快照的写入者不会抹掉磁盘上别人新增的 cursor key。
 *
 * 实现方式：把 DSH_HOME 指到临时目录（STATE_DIR/STATE_FILE 在模块顶层按 DSH_HOME 求值，
 * 故必须在 import 插件之前设置），再用桩 ctx 调 apply()，通过公开工具 gh_watch_configure
 * 触发 persist()。不触网、不碰真实 $DSH_HOME。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'gh-watch-state-'));
process.env.DSH_HOME = TMP; // 必须早于 import：index.js 顶层即求值 STATE_DIR

const { apply } = await import('../lib/index.js');

const STATE_DIR = path.join(TMP, 'gh-watch');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const DIAG_FILE = path.join(STATE_DIR, 'diag.log');
const day = new Date().toISOString().slice(0, 10);
const BAK_FILE = STATE_FILE + '.bak-' + day.replace(/-/g, '');

const registered = [];
function boot() {
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    timer: { interval: () => ({}) },
    agents: { get: () => undefined, resume: async () => ({ agent: {} }) },
    credentials: { resolve: async () => undefined },
  };
  apply(ctx, {});
  return registered.find((t) => t.name === 'gh_watch_configure');
}
const readDisk = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => rmSync(TMP, { recursive: true, force: true }));

test('① 每日基线备份真的产出 .bak-YYYYMMDD（回归：fs.promises 上没有 existsSync → 备份静默失败）', async () => {
  mkdirSync(STATE_DIR, { recursive: true });
  const before = { watchers: { 'session-old': { repos: ['a/b'], cursor: { 'a/b': { 'pull#1': { v: 1 } } } } } };
  writeFileSync(STATE_FILE, JSON.stringify(before, null, 2));

  const configure = boot();
  const res = await configure.execute({ repos: ['ggg123124/vrchat-assistant'], intervalMin: 10 }, { agent: { id: 'session-new' } });
  assert.equal(res.ok, true, 'configure 应成功');
  await sleep(50); // persistChain 是 Promise 链，等它落盘

  assert.ok(existsSync(BAK_FILE), '每日备份文件必须真的存在：' + BAK_FILE);
  assert.deepEqual(JSON.parse(readFileSync(BAK_FILE, 'utf8')), before, '备份内容应等于备份时刻的磁盘状态');
  assert.ok(readDisk().watchers['session-new'], '新配置应写入 state.json');
  assert.ok(readDisk().watchers['session-old'], '原有 watcher 不得丢失');
});

test('② 写盘并集：别人（旧快照写入者）新增的 cursor key 不会被抹掉，且 diag 留痕', async () => {
  // 模拟「另一个写入者」在插件内存快照之后往磁盘加了一个 key
  const disk = readDisk();
  disk.watchers['session-old'].cursor['a/b']['pull#999'] = { v: 999 };
  writeFileSync(STATE_FILE, JSON.stringify(disk, null, 2));

  const configure = registered.find((t) => t.name === 'gh_watch_configure');
  const res = await configure.execute({ repos: ['ggg123124/vrchat-assistant'], intervalMin: 10 }, { agent: { id: 'session-new' } });
  assert.equal(res.ok, true);
  await sleep(50);

  const after2 = readDisk();
  assert.ok(after2.watchers['session-old'].cursor['a/b']['pull#999'], '磁盘上新增的 key 必须被并集保留（不丢 key）');
  assert.ok(existsSync(DIAG_FILE) && readFileSync(DIAG_FILE, 'utf8').includes('补回'), '补回丢失 key 时应在 diag.log 留痕');
});
