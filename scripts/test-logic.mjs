import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const LOG = '/tmp/test-logic.log';
const log = (...args) => writeFileSync(LOG, args.join(' ') + '\n', { flag: 'a' });
writeFileSync(LOG, '');

log('starting server...');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
log('server created');

// Polyfill browser APIs used by the library.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};

const { getLeftoverLibrary, migrateLeftovers } = await server.ssrLoadModule('/src/utils/leftoverLibrary.ts');
const { nestProject, clearNestingCache } = await server.ssrLoadModule('/src/utils/nesting.ts');
const { createInitialProject } = await server.ssrLoadModule('/src/utils/project.ts');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; log('PASS', name); }
  else { fail++; log('FAIL', name); }
}

// --- 迁移：旧数据补编号与首版 ---
const migrated = migrateLeftovers([{ length: 100, width: 50, thickness: 18, stockId: 's1' }]);
check('迁移补编号与首版 v1', !!migrated[0].id && migrated[0].version === 1);

const lib = getLeftoverLibrary();
lib.replaceAll([]);

// --- 幂等登记：重传只入库一次 ---
const r1 = await lib.register({ id: 'L1', length: 100, width: 100, thickness: 18, stockId: 'stock-walnut' });
const r2 = await lib.register({ id: 'L1', length: 100, width: 100, thickness: 18, stockId: 'stock-walnut' });
check('首次登记入库', r1.status === 'stored');
check('重复编号不重复入库', r2.status === 'duplicate' && lib.getSnapshot().filter((l) => l.id === 'L1').length === 1);

// --- 并发占用：先到先得，后到者看到占用者 ---
const c1 = lib.claim('L1', '师傅A');
const c2 = lib.claim('L1', '师傅B');
check('先到者占用成功', c1.status === 'ok');
check('后到者看到占用者', c2.status === 'occupied' && c2.occupiedBy === '师傅A');
lib.release('L1');

// --- 断网登记 + 回网重传 ---
lib.setOnline(false);
const r3 = await lib.register({ id: 'L2', length: 100, width: 100, thickness: 18, stockId: 'stock-walnut' });
check('断网进入待重传', r3.status === 'queued-offline' && lib.getState().outbox.length === 1);
lib.setOnline(true);
check('回网按编号合并入库', lib.getState().outbox.length === 0 && lib.getSnapshot().some((l) => l.id === 'L2'));

// --- 库容满了排队等位，消耗后补位 ---
lib.replaceAll([]);
lib.setOnline(true);
for (let i = 0; i < 12; i++) await lib.register({ id: `C${i}`, length: 10, width: 10, thickness: 18, stockId: 'stock-walnut' });
const rFullPromise = lib.register({ id: 'CX', length: 10, width: 10, thickness: 18, stockId: 'stock-walnut' });
check('库容满进入等位', lib.getState().waitQueue.length === 1);
lib.consume(['C0']);
const rFull = await rFullPromise;
check('消耗腾出空位，等位记录入库', rFull.status === 'stored' && lib.getSnapshot().some((l) => l.id === 'CX') && lib.getState().waitQueue.length === 0);

// --- 写入失败后按编号恢复，只入库一次 ---
lib.replaceAll([]);
lib.armNextFailure();
const rFail = await lib.register({ id: 'F1', length: 100, width: 100, thickness: 18, stockId: 'stock-walnut' });
check('写入失败留待恢复', rFail.status === 'failed' && lib.getState().outbox.some((o) => o.id === 'F1'));
const rRec = await lib.recoverById('F1');
check('按编号恢复入库', rRec.status === 'stored' && lib.getSnapshot().filter((l) => l.id === 'F1').length === 1);
const rRec2 = await lib.recoverById('F1');
check('重复恢复不重复入库', rRec2.status === 'duplicate');

// --- 排料先用余料 ---
lib.replaceAll([]);
const project = createInitialProject();
const leftover = { id: 'T1', length: 720, width: 420, thickness: 18, stockId: 'stock-walnut', status: 'available', version: 1, source: 'manual', createdAt: Date.now() };
lib.replaceAll([leftover]);
project.leftovers = lib.getSnapshot();
const result = nestProject(project, {});
check('排料把零件排到余料上', result.usedLeftoverIds.includes('T1'));
check('余料排料图存在', result.layouts.some((l) => l.kind === 'leftover' && l.leftoverId === 'T1'));
lib.consume(result.usedLeftoverIds);
check('核销后余料状态为已用', lib.getSnapshot().find((l) => l.id === 'T1')?.status === 'consumed');

// --- 缓存：改尺寸只重算相关板材，其它沿用 ---
lib.replaceAll([]);
project.leftovers = [];
clearNestingCache();
const first = nestProject(project, {});
check('首次全部重算', first.recomputedStockIds.length === project.stocks.length);
const same = nestProject(project, {});
check('同输入全部沿用', same.reusedStockIds.length === project.stocks.length && same.recomputedStockIds.length === 0);
const project2 = { ...project, parts: project.parts.map((p) => (p.id === 'part-back' ? { ...p, length: 1000 } : p)) };
const changed = nestProject(project2, {});
check('改动板重算', changed.cacheByStock['stock-poplar'] === 'miss');
check('未牵连板沿用', changed.cacheByStock['stock-walnut'] === 'hit' && changed.cacheByStock['stock-oak'] === 'hit');
check('成本为有效数值', Number.isFinite(changed.purchaseCost) && changed.purchaseCost >= 0);
check('排料结果完整', changed.placedParts > 0 && changed.layouts.length > 0);

log(`${pass} passed, ${fail} failed`);
await server.close();
process.exit(fail ? 1 : 0);
