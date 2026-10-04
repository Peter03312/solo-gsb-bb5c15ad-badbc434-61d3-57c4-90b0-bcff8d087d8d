'use strict';

// 盲投房间端到端验证（临时库、不写正式数据）：
//   node scripts/test-blind-room.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-room-'));
const dbPath = path.join(tmpDir, 'test.db');

const { open } = require('../server/db');
const { seed } = require('../server/seed');
const roomOps = require('../server/room');

const db = open(dbPath);
seed(db);

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✅ ${name}`);
}
function eq(name, a, b) {
  assert.strictEqual(a, b, `${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
  passed++;
  console.log(`  ✅ ${name}`);
}

const scenarioId = db.prepare('SELECT id FROM scenarios LIMIT 1').get().id;

function backfillStep(roomCode, stepNo, deadlineMs, status = 'open') {
  // 模拟“时间已经过去”：把持久化的截止时间改到过去
  db.prepare('UPDATE room_steps SET deadline_ms = ?, status = ? WHERE room_code = ? AND step_no = ?')
    .run(deadlineMs, status, roomCode, stepNo);
}

(async () => {
  // ---------- 1. 开房参数校验 ----------
  console.log('1) 开房：省略/false=公开旧用法；true=盲投；非布尔报错且不开房');
  const pub0 = roomOps.createRoom(db, { scenarioId, version: 1 });
  ok('省略 blindVote 开房成功', pub0.ok);
  eq('省略时 blind_vote=0（公开）', pub0.room.blind_vote, 0);
  const pub1 = roomOps.createRoom(db, { scenarioId, version: 1, blindVote: false });
  ok('blindVote=false 开房成功', pub1.ok);
  eq('false → blind_vote=0', pub1.room.blind_vote, 0);

  const roomCountBefore = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  for (const bad of ['true', 'false', 1, 0, {}, [], 'yes']) {
    const r = roomOps.createRoom(db, { scenarioId, version: 1, blindVote: bad });
    eq(`非布尔 ${JSON.stringify(bad)} 被拒绝`, r.ok, false);
    eq('错误码 BLIND_VOTE_INVALID', r.errorCode, 'BLIND_VOTE_INVALID');
    eq('HTTP 400', r.status, 400);
  }
  eq('非法盲投参数一律不开房', db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c, roomCountBefore);

  const created = roomOps.createRoom(db, { scenarioId, version: 1, blindVote: true });
  ok('blindVote=true 开盲投房成功', created.ok);
  const room = created.room;
  eq('blind_vote=1', room.blind_vote, 1);

  // ---------- 2. 盲投阶段：结算前三类视角都只能看到已投人数 ----------
  console.log('2) 盲投阶段：围观/学员/主持人均只见已投人数，不见各选项票数与逐人选项');
  const m1 = roomOps.joinRoom(db, { code: room.code, name: '张三' });
  const m2 = roomOps.joinRoom(db, { code: room.code, name: '李四' });
  ok('两人加入盲投房', m1.ok && m2.ok);
  eq('加入响应即盲投快照', m1.snapshot.blindVote, true);
  eq('加入响应处于盲投阶段', m1.snapshot.blindActive, true);

  const hostSnap0 = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  const [optA, optB] = hostSnap0.options.map((o) => o.id);
  ok('第 0 步有 2 个可选项', !!optA && !!optB);

  roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: optA, stepNo: 0 });
  roomOps.castVote(db, { code: room.code, memberToken: m2.memberToken, optionId: optB, stepNo: 0 });

  const watchSnap = roomOps.buildRoomSnapshot(db, room, {}).snapshot;
  eq('围观：blindVote=true', watchSnap.blindVote, true);
  eq('围观：blindActive=true', watchSnap.blindActive, true);
  eq('围观：可见已投人数=2', watchSnap.totalVotes, 2);
  ok('围观：各选项票数被隐藏（null）', watchSnap.options.every((o) => o.votes === null));
  eq('围观：无逐人明细字段', watchSnap.votes, undefined);

  const memSnap = roomOps.buildRoomSnapshot(db, room, { memberToken: m1.memberToken }).snapshot;
  ok('学员：各选项票数同样被隐藏', memSnap.options.every((o) => o.votes === null));
  eq('学员：已投人数=2', memSnap.totalVotes, 2);
  eq('学员：可见自己的票 myVote', memSnap.myVote && memSnap.myVote.optionId, optA);
  eq('学员：无逐人明细', memSnap.votes, undefined);

  const hostSnap = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  ok('主持人：各选项票数也被隐藏', hostSnap.options.every((o) => o.votes === null));
  eq('主持人：已投人数=2', hostSnap.totalVotes, 2);
  eq('主持人：逐人明细恒为 null（姓名-选项不公开）', hostSnap.votes, null);
  ok('主持人：成员名单可见', Array.isArray(hostSnap.members) && hostSnap.members.length === 2);
  eq('主持人：成员名单含姓名', hostSnap.members.map((m) => m.name).sort().join(','), '张三,李四');

  // 学员改票照常（只计最后一票），且改票后依旧保密
  const chg = roomOps.castVote(db, { code: room.code, memberToken: m2.memberToken, optionId: optA, stepNo: 0 });
  ok('盲投房改票成功', chg.ok);
  eq('改票响应仍隐藏各选项票数', chg.snapshot.options.every((o) => o.votes === null), true);
  eq('改票后已投人数仍为 2', chg.snapshot.totalVotes, 2);
  eq('改票后我的票已更新', chg.snapshot.myVote.optionId, optA);

  // 盲投房沿用凭证与步号校验
  const badTok = roomOps.castVote(db, { code: room.code, memberToken: 'mem_nope', optionId: optA, stepNo: 0 });
  eq('无效成员凭证 → MEMBER_TOKEN_INVALID', badTok.errorCode, 'MEMBER_TOKEN_INVALID');
  const stale = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: optA, stepNo: 7 });
  eq('过期步号 → STEP_STALE', stale.errorCode, 'STEP_STALE');
  eq('拒绝时回传当前步号=0', stale.current.stepNo, 0);

  // ---------- 3. 主持人提前结算：公布该步各选项票数与获胜处置 ----------
  console.log('3) 主持人提前结算：公布各选项票数与获胜处置；姓名-选项仍不公开');
  const settled = roomOps.settleRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: 0 });
  ok('盲投房主持人结算成功', settled.ok);
  eq('结算方式 manual', settled.settled.kind, 'manual');
  eq('获胜处置为多数票 optA', settled.settled.optionId, optA);
  const tallyA = settled.settled.tallies.find((t) => t.optionId === optA);
  const tallyB = settled.settled.tallies.find((t) => t.optionId === optB);
  eq('公布 optA 票数=2', tallyA.votes, 2);
  eq('公布 optB 票数=0', tallyB.votes, 0);
  eq('推进到第 1 步', settled.snapshot.stepNo, 1);
  const st0 = settled.snapshot.settlements.find((s) => s.stepNo === 0);
  ok('已结算步结果在快照中保持可见', !!st0 && st0.tallies.length === 2 && st0.voterCount === 2);
  eq('新当前步仍是盲投阶段', settled.snapshot.blindActive, true);
  ok('新当前步各选项票数重新保密', settled.snapshot.options.every((o) => o.votes === null));

  const hostSnap1 = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  eq('结算后主持人仍无逐人明细', hostSnap1.votes, null);
  ok('结算后主持人仍可见成员名单', Array.isArray(hostSnap1.members) && hostSnap1.members.length === 2);

  // ---------- 4. 限时盲投房：到点自动结算同样只公布结果 ----------
  console.log('4) 限时+盲投：到点自动结算公布该步票数；零票暂停与重开期间继续保密');
  const timed = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: 30, blindVote: true });
  ok('限时盲投房创建成功', timed.ok);
  eq('限时盲投房 blind_vote=1', timed.room.blind_vote, 1);
  const tm1 = roomOps.joinRoom(db, { code: timed.room.code, name: '王五' });
  const tm2 = roomOps.joinRoom(db, { code: timed.room.code, name: '赵六' });
  const tSnap0 = roomOps.buildRoomSnapshot(db, timed.room, {}).snapshot;
  const [tA] = tSnap0.options.map((o) => o.id);
  roomOps.castVote(db, { code: timed.room.code, memberToken: tm1.memberToken, optionId: tA, stepNo: 0 });
  roomOps.castVote(db, { code: timed.room.code, memberToken: tm2.memberToken, optionId: tA, stepNo: 0 });
  const tHostBefore = roomOps.buildRoomSnapshot(db, timed.room, { hostToken: timed.hostToken }).snapshot;
  ok('到点前主持人只见已投人数', tHostBefore.options.every((o) => o.votes === null) && tHostBefore.totalVotes === 2);

  backfillStep(timed.room.code, 0, Date.now() - 1000);
  const swept = roomOps.sweepDueRooms(db, Date.now());
  ok('到点有票自动结算', swept.autoSettled >= 1);
  const tSettle0 = db.prepare('SELECT * FROM room_settlements WHERE room_code=? AND step_no=0').get(timed.room.code);
  eq('自动结算留痕 kind=auto', tSettle0.kind, 'auto');
  eq('自动结算公布获胜选项', tSettle0.option_id, tA);
  ok('自动结算公布各选项票数', JSON.parse(tSettle0.tallies).some((t) => t.votes === 2));
  const tHostAfter = roomOps.buildRoomSnapshot(db, timed.room, { hostToken: timed.hostToken }).snapshot;
  eq('自动结算后主持人仍无逐人明细', tHostAfter.votes, null);
  eq('第 1 步仍是盲投阶段', tHostAfter.blindActive, true);

  // 第 1 步零票到点 → 暂停；暂停与重开期间继续保密
  backfillStep(timed.room.code, 1, Date.now() - 1000);
  roomOps.sweepDueRooms(db, Date.now());
  const pausedSnap = roomOps.buildRoomSnapshot(db, timed.room, { hostToken: timed.hostToken }).snapshot;
  eq('零票暂停 phase=awaiting_reopen', pausedSnap.timer.phase, 'awaiting_reopen');
  eq('暂停期间仍是盲投阶段', pausedSnap.blindActive, true);
  ok('暂停期间各选项票数保密', pausedSnap.options.every((o) => o.votes === null));
  eq('暂停期间逐人明细仍不公开', pausedSnap.votes, null);
  const votePaused = roomOps.castVote(db, { code: timed.room.code, memberToken: tm1.memberToken, optionId: tA, stepNo: 1 });
  eq('暂停期间投票 → STEP_AWAITING_REOPEN', votePaused.errorCode, 'STEP_AWAITING_REOPEN');

  const reopened = roomOps.reopenRoom(db, { code: timed.room.code, hostToken: timed.hostToken, observedStepNo: 1 });
  ok('主持人重开成功', reopened.ok);
  eq('重开期间仍是盲投阶段', reopened.snapshot.blindActive, true);
  ok('重开期间各选项票数保密', reopened.snapshot.options.every((o) => o.votes === null));
  eq('重开期间逐人明细仍不公开', reopened.snapshot.votes, null);

  // 重开后投票并结算到结局方向推进（验证盲投房完整走通）
  const tSnap1 = roomOps.buildRoomSnapshot(db, timed.room, {}).snapshot;
  const tA1 = tSnap1.options[0].id;
  roomOps.castVote(db, { code: timed.room.code, memberToken: tm1.memberToken, optionId: tA1, stepNo: 1 });
  const tSettled1 = roomOps.settleRoom(db, { code: timed.room.code, hostToken: timed.hostToken, observedStepNo: 1 });
  ok('重开后结算成功', tSettled1.ok);
  eq('第 1 步结果已公布', tSettled1.snapshot.settlements.some((s) => s.stepNo === 1), true);

  // ---------- 5. 非盲投房间行为完全不变（回归） ----------
  console.log('5) 公开房间（旧用法）行为保持原样');
  const pm = roomOps.joinRoom(db, { code: pub0.room.code, name: '公开学员' });
  const pSnap0 = roomOps.buildRoomSnapshot(db, pub0.room, {}).snapshot;
  eq('公开房 blindVote=false', pSnap0.blindVote, false);
  eq('公开房 blindActive=false', pSnap0.blindActive, false);
  const [pA] = pSnap0.options.map((o) => o.id);
  roomOps.castVote(db, { code: pub0.room.code, memberToken: pm.memberToken, optionId: pA, stepNo: 0 });
  const pHost = roomOps.buildRoomSnapshot(db, pub0.room, { hostToken: pub0.hostToken }).snapshot;
  eq('公开房各选项票数为数字', pHost.options.find((o) => o.id === pA).votes, 1);
  ok('公开房主持人可见逐人明细', Array.isArray(pHost.votes) && pHost.votes.length === 1);
  eq('逐人明细含姓名与选项', pHost.votes[0].name, '公开学员');
  eq('逐人明细含选项', pHost.votes[0].optionId, pA);
  const pWatch = roomOps.buildRoomSnapshot(db, pub0.room, {}).snapshot;
  eq('公开房围观可见各选项票数', pWatch.options.find((o) => o.id === pA).votes, 1);

  // ---------- 6. 盲投选择创建后不可更改 + 房间结束后仍不公开姓名-选项 ----------
  console.log('6) 盲投设置不可更改；房间走到结局后结果可见、姓名-选项仍不公开');
  eq('盲投房设置保持 blind_vote=1', db.prepare('SELECT blind_vote FROM rooms WHERE code=?').get(room.code).blind_vote, 1);
  // 把盲投房一路结算到结局（每步投第一个可选项）
  let guard = 0;
  while (guard++ < 20) {
    const s = roomOps.buildRoomSnapshot(db, room, {}).snapshot;
    if (s.status !== 'active') break;
    const m = guard % 2 ? m1 : m2;
    roomOps.castVote(db, { code: room.code, memberToken: m.memberToken, optionId: s.options[0].id, stepNo: s.stepNo });
    const r = roomOps.settleRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: s.stepNo });
    if (!r.ok) break;
  }
  const endSnap = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  eq('盲投房已到达结局', endSnap.status, 'ended');
  eq('结束后盲投阶段结束', endSnap.blindActive, false);
  ok('结束后各步结算结果保持可见', endSnap.settlements.length >= 1 && endSnap.settlements.every((s) => s.tallies.length > 0));
  eq('结束后主持人仍无逐人明细（姓名-选项全程不公开）', endSnap.votes, null);
  ok('结束后成员名单仍可见', Array.isArray(endSnap.members) && endSnap.members.length === 2);
  eq('盲投设置始终为 1', db.prepare('SELECT blind_vote FROM rooms WHERE code=?').get(room.code).blind_vote, 1);

  // ---------- 7. 老库迁移：存量房间默认公开投票 ----------
  console.log('7) 老库迁移：无 blind_vote 列的存量库自动加列，老房间维持公开投票');
  const Database = require('better-sqlite3');
  const legacyPath = path.join(tmpDir, 'legacy.db');
  const ldb = new Database(legacyPath);
  ldb.exec(`CREATE TABLE rooms (
    code TEXT PRIMARY KEY, host_token TEXT NOT NULL UNIQUE, scenario_id TEXT NOT NULL,
    version INTEGER NOT NULL, session_code TEXT NOT NULL,
    step_duration INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ldb.prepare(`INSERT INTO rooms (code, host_token, scenario_id, version, session_code, step_duration)
               VALUES ('legacyroom1', 'host_legacy', 'sc_x', 1, 'sess_x', NULL)`).run();
  ldb.close();
  const migrated = open(legacyPath); // open 内执行与正式库一致的建表+迁移
  const cols = migrated.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  ok('迁移后存在 blind_vote 列', cols.includes('blind_vote'));
  eq('存量房间 blind_vote 迁移为 0（公开投票）',
    migrated.prepare('SELECT blind_vote FROM rooms WHERE code=?').get('legacyroom1').blind_vote, 0);
  migrated.close();

  console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌ 测试失败：', e);
  process.exit(1);
});
