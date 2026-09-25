'use strict';

/**
 * 写盘失败的状态漂移防护测试：
 * 普通变更、备份恢复与撤销都遵守「先落盘、后发布」——
 * 临时文件写入或重命名失败时，内存中的成员、关系、纪念日、版本与
 * 最近一次撤销信息全部保持原值，本次临时文件被清理，
 * 请求返回可识别的 PERSIST_FAILED 错误，恢复写盘条件后可再次提交。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-persist-'));
  return path.join(dir, 'family.json');
}

/** 与 store 内部一致的临时文件路径（同进程 pid） */
function tmpPathOf(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
}

/** 让临时文件写入失败：在临时文件路径上放置同名目录（writeFileSync 报 EISDIR） */
function blockTmpWrite(file) {
  fs.mkdirSync(tmpPathOf(file));
}

function unblockTmpWrite(file) {
  fs.rmSync(tmpPathOf(file), { recursive: true, force: true });
}

/** 让 rename 失败：把数据文件路径替换为非空目录（文件不能 rename 到目录上） */
function blockRename(file) {
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'occupant'), 'x');
}

function unblockRename(file) {
  fs.rmSync(file, { recursive: true, force: true });
}

/** 数据目录中残留的临时文件（只算文件；阻塞用的同名目录不算） */
function leftoverTmpFiles(file) {
  return fs
    .readdirSync(path.dirname(file), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tmp'))
    .map((e) => e.name);
}

test('添加成员写盘失败（临时文件不可写）：内存、版本、撤销快照与磁盘全部保持原值，可重试', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('甲');
  store.addMember('乙');
  const before = store.list();
  const beforeVersion = store.getVersion();
  const diskBefore = fs.readFileSync(file, 'utf8');

  blockTmpWrite(file);
  const result = store.addMember('丙');
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  assert.match(result.error, /写入磁盘失败/);

  // 内存无漂移：成员、版本、最近一次撤销信息保持原值
  assert.deepEqual(store.list(), before);
  assert.equal(store.getVersion(), beforeVersion);
  // 磁盘文件未被改动，也没有残留临时文件
  assert.equal(fs.readFileSync(file, 'utf8'), diskBefore);
  assert.deepEqual(leftoverTmpFiles(file), []);
  // 「重启」（重新加载）与内存一致：不存在内存显示新数据、重启后消失的漂移
  assert.deepEqual(createStore(file).list(), before);

  // 恢复写盘条件后可再次提交
  unblockTmpWrite(file);
  const retry = store.addMember('丙');
  assert.equal(retry.error, null);
  assert.equal(store.getVersion(), beforeVersion + 1);
  assert.equal(store.list().members.length, 3);
  assert.equal(createStore(file).list().members.length, 3);
  assert.deepEqual(leftoverTmpFiles(file), []);
});

test('重命名失败（rename 不可达）：已写出的临时文件被清理，内存保持原值，恢复后可提交', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('甲').member;
  const b = store.addMember('乙').member;
  assert.equal(store.addEdge(a.id, b.id).error, null);
  const before = store.list();
  const beforeVersion = store.getVersion();

  blockRename(file);
  const result = store.renameMember(b.id, '乙二');
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');

  // 内存无漂移：姓名、关系、版本、撤销快照保持原值
  assert.deepEqual(store.list(), before);
  assert.equal(store.getVersion(), beforeVersion);
  // rename 失败前临时文件已完整写出，必须被清理
  assert.deepEqual(leftoverTmpFiles(file), []);

  // 恢复写盘条件后可再次提交
  unblockRename(file);
  assert.equal(store.renameMember(b.id, '乙二').error, null);
  assert.equal(store.getVersion(), beforeVersion + 1);
  const reloaded = createStore(file).list();
  assert.ok(reloaded.members.some((m) => m.id === b.id && m.name === '乙二'));
});

test('纪念日变更写盘失败：生日与忌日保持原值', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('甲').member;
  assert.equal(
    store.setAnniversaries(a.id, { birthday: { month: 1, day: 1 }, deathday: null }).error,
    null,
  );
  const before = store.list();
  const beforeVersion = store.getVersion();

  blockTmpWrite(file);
  const result = store.setAnniversaries(a.id, {
    birthday: { month: 2, day: 2 },
    deathday: { month: 3, day: 3 },
  });
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  assert.deepEqual(store.list(), before);
  assert.equal(store.getVersion(), beforeVersion);
  assert.deepEqual(store.list().members[0].birthday, { month: 1, day: 1 });
  assert.equal(store.list().members[0].deathday, null);
  assert.deepEqual(leftoverTmpFiles(file), []);

  unblockTmpWrite(file);
  assert.equal(
    store.setAnniversaries(a.id, {
      birthday: { month: 2, day: 2 },
      deathday: { month: 3, day: 3 },
    }).error,
    null,
  );
  assert.deepEqual(createStore(file).list().members[0].deathday, { month: 3, day: 3 });
});

test('批量关系提交写盘失败：整批不生效、版本不变，可携原版本号重试', () => {
  const file = tmpFile();
  const store = createStore(file);
  const ids = ['A', 'B', 'C'].map((n) => store.addMember(n).member.id);
  const v = store.getVersion();
  const before = store.list();
  const edges = [
    { parentId: ids[0], childId: ids[1] },
    { parentId: ids[1], childId: ids[2] },
  ];

  blockTmpWrite(file);
  const result = store.commitEdges(edges, v);
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  // 零写入：关系、版本、撤销快照（仍指向「添加成员 C」）全部保持原值
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.getVersion(), v);
  assert.deepEqual(store.list(), before);
  assert.deepEqual(leftoverTmpFiles(file), []);

  // 版本未漂移，恢复后携带预检时的版本号即可再次提交
  unblockTmpWrite(file);
  assert.equal(store.commitEdges(edges, v).error, null);
  assert.equal(store.getVersion(), v + 1);
  assert.equal(createStore(file).list().edges.length, 2);
});

test('合并成员写盘失败：成员与关系保持原值，可携原版本号重试', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('张三').member;
  const b = store.addMember('张叁').member;
  const v = store.getVersion();
  const before = store.list();

  blockTmpWrite(file);
  const result = store.commitMerge(a.id, b.id, v);
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  assert.deepEqual(store.list(), before);
  assert.equal(store.getVersion(), v);
  assert.deepEqual(leftoverTmpFiles(file), []);

  unblockTmpWrite(file);
  assert.equal(store.commitMerge(a.id, b.id, v).error, null);
  assert.equal(store.getVersion(), v + 1);
  assert.equal(store.list().members.length, 1);
  assert.equal(createStore(file).list().members.length, 1);
});

test('备份恢复写盘失败：家谱保持原值，可携原指纹与版本重试', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('甲');
  const before = store.list();
  const beforeVersion = store.getVersion();

  const backup = JSON.stringify({
    members: [
      { id: 'x1', name: '张三' },
      { id: 'x2', name: '张四' },
    ],
    edges: [{ parentId: 'x1', childId: 'x2' }],
  });
  const preview = store.previewRestore(backup);
  assert.equal(preview.valid, true);

  blockTmpWrite(file);
  const result = store.restoreBackup(backup, preview.fingerprint, beforeVersion);
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  // 家谱未被替换：成员、版本、撤销快照保持原值
  assert.deepEqual(store.list(), before);
  assert.equal(store.getVersion(), beforeVersion);
  assert.deepEqual(leftoverTmpFiles(file), []);

  // 恢复写盘条件后，携带同一指纹与版本可再次恢复
  unblockTmpWrite(file);
  const retry = store.restoreBackup(backup, preview.fingerprint, beforeVersion);
  assert.equal(retry.error, null);
  assert.equal(store.getVersion(), beforeVersion + 1);
  const reloaded = createStore(file).list();
  assert.deepEqual(reloaded.members.map((m) => m.id).sort(), ['x1', 'x2']);
  assert.equal(reloaded.edges.length, 1);
});

test('撤销写盘失败：家谱、版本与最近一次撤销信息保持原值，恢复后可再次撤销', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('甲');
  store.addMember('乙');
  const before = store.list();
  const beforeVersion = store.getVersion();
  assert.ok(before.undo);

  blockTmpWrite(file);
  const result = store.undoLast(beforeVersion);
  assert.equal(result.status, 500);
  assert.equal(result.code, 'PERSIST_FAILED');
  // 撤销未生效：成员仍在、版本未推进、最近一次撤销信息未清空
  assert.deepEqual(store.list(), before);
  assert.equal(store.getVersion(), beforeVersion);
  assert.deepEqual(leftoverTmpFiles(file), []);
  // 磁盘与内存一致（重新加载得到相同状态）
  assert.deepEqual(createStore(file).list(), before);

  // 恢复写盘条件后可再次撤销（版本未漂移，原版本号仍有效）
  unblockTmpWrite(file);
  const retry = store.undoLast(beforeVersion);
  assert.equal(retry.error, null);
  assert.match(retry.label, /添加成员「乙」/);
  assert.equal(store.getVersion(), beforeVersion + 1);
  assert.equal(store.list().members.length, 1);
  assert.equal(store.list().undo, null);
  assert.equal(createStore(file).list().members.length, 1);
});

test('连续失败不产生漂移：多次写盘失败后第一次成功提交才推进版本', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.addMember('甲');
  const before = store.list();
  const beforeVersion = store.getVersion();

  blockTmpWrite(file);
  for (const name of ['乙', '丙', '丁']) {
    const result = store.addMember(name);
    assert.equal(result.code, 'PERSIST_FAILED');
    assert.deepEqual(store.list(), before);
    assert.equal(store.getVersion(), beforeVersion);
  }
  unblockTmpWrite(file);

  assert.equal(store.addMember('乙').error, null);
  assert.equal(store.getVersion(), beforeVersion + 1);
  assert.equal(store.list().members.length, 2);
  assert.equal(createStore(file).list().members.length, 2);
});
