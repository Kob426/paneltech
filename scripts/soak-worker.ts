// Private synthetic harness only. These control endpoints never enter the product API.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { Core } from '../server/core.js';
import { createApp } from '../server/app.js';
import { restoreBackup, verifyBackup } from '../server/database-backup.js';
import type { Job } from '../shared/contracts.js';

const directory = realpathSync(process.env.PANELTECH_LOAD_DIR ?? '');
if (!directory.startsWith(join(realpathSync(tmpdir()), 'paneltech-load-')) ||
    readFileSync(join(directory, 'SYNTHETIC'), 'utf8') !== 'PANELTECH SYNTHETIC LOAD ONLY') {
  throw Error('Private synthetic temporary directory required');
}
const source = join(directory, 'case.sqlite');
const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const canaries = ['soak-queued', 'soak-running'];

function hashRows(db: DatabaseSync, kind: string, predicate = '1', args: number[] = []) {
  const hash = createHash('sha256');
  for (const row of db.prepare(`SELECT id,data FROM records WHERE kind=? AND ${predicate} ORDER BY rowid`).iterate(kind, ...args)) {
    hash.update(JSON.stringify([row.id, row.data]) + '\n');
  }
  return hash.digest('hex');
}
const countJobs = (db: DatabaseSync) => Number(db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='job'").get()!.n);
function marker(db: DatabaseSync) {
  const rows = db.prepare("SELECT data FROM records WHERE kind='meta' AND id IN ('soak-left','soak-right') ORDER BY id").all();
  const values = rows.map(row => JSON.parse(String(row.data)).sequence);
  if (values.length !== 2 || values[0] !== values[1] || values[0] < 1) throw Error('Incoherent transaction marker');
  return Number(values[0]);
}

if (process.env.PANELTECH_SOAK_PHASE === 'verify') {
  const results = [];
  for (const [index, name] of readdirSync(join(directory, 'copies')).filter(name => name.startsWith('backup-')).sort().entries()) {
    const verified = await verifyBackup(join(directory, 'copies', name));
    const before = new DatabaseSync(verified.file, { readOnly: true });
    let terminalHash: string, auditHash: string, jobs: number, sequence: number;
    try {
      terminalHash = hashRows(before, 'job', "json_extract(data,'$.state') IN ('succeeded','failed','expired')");
      auditHash = hashRows(before, 'audit');
      jobs = countJobs(before);
      sequence = marker(before);
    } finally { before.close(); }
    const target = join(directory, 'restored-' + index + '.sqlite');
    const restored = await restoreBackup(verified.path, target);
    const store = new Store(target), core = new Core(store);
    try {
      const preserved = () => {
        // Queued jobs legitimately become expired; compare only the original terminal rows.
        const original = new DatabaseSync(verified.file, { readOnly: true });
        try {
          for (const row of original.prepare("SELECT id,data FROM records WHERE kind='job' AND json_extract(data,'$.state') IN ('succeeded','failed','expired')").iterate()) {
            const actual = store.db.prepare("SELECT data FROM records WHERE kind='job' AND id=?").get(row.id!);
            if (actual?.data !== row.data) throw Error('Terminal history changed');
          }
        } finally { original.close(); }
      };
      preserved();
      if (hashRows(store.db, 'audit') !== auditHash) throw Error('Audit changed after restore');
      if (store.all('session').length || store.all('enrollment').length) throw Error('Restored access survived');
      if (store.all('device').some(device => device.tokenHash || (!device.demo && !device.revoked) ||
          (device.demo && device.rules.some((rule: { owned: boolean }) => rule.owned)))) throw Error('Restored device trust/rules survived');
      const queued = store.get<Job>('job', canaries[0])!, running = store.get<Job>('job', canaries[1])!;
      if (queued.state !== 'expired' || queued.attempts !== 0 || running.state !== 'unknown' || running.attempts !== 1) throw Error('Unsafe restore states');
      const allBefore = hashRows(store.db, 'job');
      for (let n = 0; n < 3; n++) core.tick();
      if (hashRows(store.db, 'job') !== allBefore || countJobs(store.db) !== jobs) throw Error('Restored command replay');
      preserved();
      results.push({ backup: name, bytes: verified.manifest.bytes, records: verified.manifest.records, jobs,
        markerSequence: sequence, terminalHash, auditHash, terminalHistoryPreserved: true, auditPreserved: true,
        sessionsRevoked: true, deviceTrustRevoked: true, demoRulesCleared: true,
        queuedExpired: restored.expired, runningOrUnknown: restored.unknown, noReplayAfterTicks: 3 });
    } finally { store.close(); }
  }
  if (results.length !== 2) throw Error('Expected two verified backups');
  console.log(JSON.stringify({ restored: results }));
} else {
  const store = new Store(source), meta = store.get('meta', 'load-fixture');
  if (!meta?.synthetic) throw Error('Synthetic fixture required');
  const core = new Core(store);
  const anchor = Number(store.db.prepare("SELECT MAX(rowid) AS n FROM records WHERE kind='job'").get()!.n);
  const originalHash = hashRows(store.db, 'job', 'rowid<=?', [anchor]);
  store.transaction(() => {
    for (let n = 0; n < 60; n++) {
      const device = core.device(id(n)); device.demo = true; delete device.tokenHash; device.lastSeen = Date.now();
      store.put('device', device);
    }
    const base = store.get<Job>('job', id(100000))!;
    for (const [n, name] of canaries.entries()) {
      const now = Date.now(), device = core.device(id(60 + n));
      store.put('job', { ...base, id: name, batchId: name, deviceId: device.id, deviceName: device.name,
        demo: false, state: n ? 'running' : 'queued', attempts: n,
        created: now, expires: now + 7200000, finished: undefined });
    }
  });
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let sequence = 0, timerError = false;
  function tick() {
    try {
      core.tick();
      store.transaction(() => {
        sequence++;
        for (const side of ['left', 'right']) store.put('meta', { id: 'soak-' + side, sequence });
      });
    } catch { timerError = true; }
  }
  tick();
  const timer = setInterval(tick, 1000);
  const bytes = (suffix: string) => { try { return statSync(source + suffix).size; } catch { return 0; } };
  const started = performance.now();
  const metrics = () => ({ elapsedSeconds: (performance.now() - started) / 1000, markerSequence: sequence,
    rssMiB: process.memoryUsage().rss / 1048576, maxRssMiB: process.resourceUsage().maxRSS / 1024,
    heapUsedMiB: process.memoryUsage().heapUsed / 1048576, eventLoopP95Ms: lag.percentile(95) / 1e6,
    eventLoopMaxMs: lag.max / 1e6, mainBytes: bytes(''), walBytes: bytes('-wal'), halted: store.halted, timerError });
  const app = createApp(core, { realAgents: true });
  const server = app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true,
    port: (server.address() as { port: number }).port, node: process.version, cpuModel: cpus()[0]?.model,
    clubs: meta.clubs, devices: meta.pcs, completedJobs: meta.completedJobs, demoDevices: 60,
    protocolHeartbeatDevices: meta.pcs - 64, sqlite: store.db.prepare('SELECT sqlite_version() AS v').get()!.v })));
  app.get('/__soak__/metrics', (_request, response) => response.json(metrics()));
  app.post('/__soak__/stop', (_request, response) => {
    clearInterval(timer); tick(); lag.disable();
    const originalHistoryPreserved = hashRows(store.db, 'job', 'rowid<=?', [anchor]) === originalHash;
    const added = store.db.prepare("SELECT data FROM records WHERE kind='job' AND rowid>? AND id NOT IN (?,?) ORDER BY rowid").all(anchor, ...canaries).map(row => store.decode(String(row.data)) as Job);
    const valid = originalHistoryPreserved && !store.halted && !timerError &&
      added.length > 0 && added.every(job => job.demo && job.state === 'succeeded' && job.attempts === 1);
    response.json({ ...metrics(), originalHistoryPreserved, addedJobs: added.length,
      allNewDemoJobsSucceededOnce: valid, historySHA256: originalHash, jobs: countJobs(store.db) });
    server.close(() => { store.close(); process.exit(valid ? 0 : 1); });
  });
}
