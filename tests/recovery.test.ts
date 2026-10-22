import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Core } from '../server/core.js';
import type { Job } from '../shared/contracts.js';

const input = (deviceId = 'aurora-1') => ({ deviceIds: [deviceId], gameId: 'fortnite', variant: 36, operation: 'apply_marking' });

test('API/core restart with running work never replays mutation; lease timeout becomes unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paneltech-running-'));
  let store: Store | undefined;
  try {
    let now = 1_000_000;
    const path = join(dir, 'db.sqlite');
    store = new Store(path);
    let core = new Core(store, () => now);
    core.seed();
    const [job] = core.create(input(), 'admin');
    core.poll(core.device(job.deviceId)); // Persist delivery, then lose the API process before any result.
    store.close();
    store = new Store(path);
    core = new Core(store, () => now);
    core.tick();
    assert.equal(store.get<Job>('job', job.id)!.state, 'running');
    assert.equal(core.device(job.deviceId).rules.length, 0);
    assert.equal(core.poll(core.device(job.deviceId)), null);
    now += 31_000;
    core.tick();
    assert.equal(store.get<Job>('job', job.id)!.state, 'unknown');
    assert.equal(core.device(job.deviceId).rules.length, 0);
    assert.equal(core.create(input(), 'admin')[0].code, 'busy');
    assert.equal(core.reconcileDemo(job.id).state, 'failed');
    assert.equal(store.get<Job>('job', job.id)!.attempts, 1);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('lost response survives API restart and reconciles persisted facts without reapplying', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paneltech-unknown-'));
  let store: Store | undefined;
  try {
    const path = join(dir, 'db.sqlite');
    store = new Store(path);
    let core = new Core(store);
    core.seed();
    const [job] = core.create(input('aurora-5'), 'operator');
    core.tick();
    const before = structuredClone(core.device(job.deviceId).rules);
    assert.equal(store.get<Job>('job', job.id)!.state, 'unknown');
    store.close();
    store = new Store(path);
    core = new Core(store);
    core.tick();
    assert.equal(store.get<Job>('job', job.id)!.state, 'unknown');
    assert.equal(store.all<Job>('job').length, 1);
    assert.deepEqual(core.device(job.deviceId).rules, before);
    assert.equal(core.reconcileDemo(job.id).state, 'succeeded');
    assert.deepEqual(core.device(job.deviceId).rules, before);
    assert.equal(store.get<Job>('job', job.id)!.attempts, 1);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a variant removed while queued is rejected before simulator writes, keeping other rules', () => {
  const store = new Store(':memory:');
  try {
    const core = new Core(store);
    core.seed();
    const [job] = core.create(input(), 'admin');
    const club = store.get('club', 'aurora');
    club.variants = club.variants.filter((v: { id: number }) => v.id !== 36);
    store.put('club', club);
    core.tick();
    assert.equal(store.get<Job>('job', job.id)!.state, 'failed');
    assert.equal(store.get<Job>('job', job.id)!.code, 'variant');
    assert.equal(core.device(job.deviceId).rules.length, 0);
  } finally { store.close(); }
});

test('documented stopped-SQLite backup restores accounts, immutable job snapshot and human outcome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paneltech-backup-'));
  let store: Store | undefined;
  let restored: Store | undefined;
  try {
    const path = join(dir, 'db.sqlite'), backup = join(dir, 'backup.sqlite');
    store = new Store(path);
    const core = new Core(store);
    core.seed();
    const [job] = core.create(input(), 'admin');
    core.tick();
    const saved = store.get<Job>('job', job.id)!;
    saved.feedback = { outcome: 'helped', reason: 'voice', comment: 'DEMO backup fixture', author: 'operator', at: Date.now() };
    store.put('job', saved);
    const deviceId = core.device(job.deviceId).id;
    const userHash = store.get('user', 'operator').password;
    store.close(); store = undefined; // Checkpoint/close before copying: no live WAL is ignored.
    copyFileSync(path, backup);
    store = new Store(path);
    const game = store.get('game', 'fortnite');
    store.put('game', { ...game, revision: 2, exes: ['changed.exe'] });
    store.del('job', job.id);
    store.close(); store = undefined;
    restored = new Store(backup);
    assert.equal(restored.get<Job>('job', job.id)!.revision, 1);
    assert.equal(restored.get<Job>('job', job.id)!.state, 'succeeded');
    assert.equal(restored.get<Job>('job', job.id)!.feedback!.outcome, 'helped');
    assert.equal(restored.get('game', 'fortnite').revision, 1);
    assert.equal(restored.get('user', 'operator').password, userHash);
    assert.equal(restored.get('device', deviceId).id, deviceId);
    const afterRestore = new Core(restored);
    assert.equal(afterRestore.poll(afterRestore.device(deviceId)), null); // History is not an auto-restore queue.
  } finally { store?.close(); restored?.close(); rmSync(dir, { recursive: true, force: true }); }
});
