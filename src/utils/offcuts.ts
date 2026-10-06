import type { Offcut, OffcutLedger, StockSheet } from '../types/woodworking';

/** 台账结构首版版本号：旧数据升级时补齐字段后标记为该版本 */
export const OFFCUT_SCHEMA_VERSION = 1;
export const OFFCUT_CAPACITY = 8;
export const OFFCUT_CODE_PREFIX = 'YL';

const LEGACY_MIGRATOR = '老数据迁移';

export function createEmptyLedger(): OffcutLedger {
  return {
    schemaVersion: OFFCUT_SCHEMA_VERSION,
    capacity: OFFCUT_CAPACITY,
    records: [],
    pending: [],
    outbox: [],
    online: true,
    lastSyncAt: null,
    updatedAt: Date.now(),
  };
}

export function createInitialLedger(stocks: StockSheet[]): OffcutLedger {
  const ledger = createEmptyLedger();
  const at = Date.now() - 3 * 24 * 3600 * 1000;
  const seed = (index: number, stockId: string, length: number, width: number, thickness: number, note: string): Offcut => ({
    code: formatOffcutCode(index),
    stockId,
    length,
    width,
    thickness,
    registeredBy: '工位A',
    registeredAt: at + index * 1000,
    status: 'available',
    occupiedBy: null,
    occupiedAt: null,
    note,
  });
  const find = (id: string) => stocks.find((stock) => stock.id === id);
  const records: Offcut[] = [];
  if (find('stock-walnut')) {
    records.push(seed(1, 'stock-walnut', 900, 500, 18, '餐边柜顶板裁剩'));
    records.push(seed(2, 'stock-walnut', 700, 420, 18, '侧板裁剩，纹理完整'));
  }
  if (find('stock-oak')) records.push(seed(3, 'stock-oak', 800, 560, 20, '门板裁剩'));
  if (find('stock-poplar')) records.push(seed(4, 'stock-poplar', 640, 400, 18, '背板裁剩'));
  return { ...ledger, records, updatedAt: Date.now() };
}

export function formatOffcutCode(index: number) {
  return `${OFFCUT_CODE_PREFIX}-${String(index).padStart(4, '0')}`;
}

/** 从已有编号中推出下一个编号，重号自动顺延 */
export function nextOffcutCode(ledger: OffcutLedger) {
  const all = [...ledger.records, ...ledger.pending, ...ledger.outbox];
  const max = all.reduce((acc, offcut) => {
    const match = /^YL-(\d+)$/.exec(offcut.code);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return formatOffcutCode(max + 1);
}

function normalizeOffcut(raw: Partial<Offcut>, code: string, registeredAt: number): Offcut {
  return {
    code,
    stockId: String(raw.stockId ?? ''),
    length: Number(raw.length) || 0,
    width: Number(raw.width) || 0,
    thickness: Number(raw.thickness) || 0,
    registeredBy: raw.registeredBy || LEGACY_MIGRATOR,
    registeredAt,
    status: raw.status === 'occupied' ? 'occupied' : 'available',
    occupiedBy: raw.occupiedBy ?? null,
    occupiedAt: raw.occupiedAt ?? null,
    note: raw.note ?? '',
  };
}

/**
 * 旧数据升级：没有编号 / 没有台账结构的记录统一补成首版结构。
 * 缺编号的按顺序补 YL-0001 起，登记时间按原顺序排在过去，保证合并时先到先得。
 */
export function migrateLedger(raw: unknown, fallback: () => OffcutLedger): OffcutLedger {
  if (!raw || typeof raw !== 'object') return fallback();
  const legacy = raw as Partial<OffcutLedger> & { records?: Partial<Offcut>[] };
  const legacyRecords = Array.isArray(legacy.records) ? legacy.records : Array.isArray(raw) ? (raw as Partial<Offcut>[]) : null;
  if (!legacyRecords) return fallback();

  const base = Date.now() - 30 * 24 * 3600 * 1000;
  let maxCode = 0;
  legacyRecords.forEach((item) => {
    const match = typeof item?.code === 'string' ? /^YL-(\d+)$/.exec(item.code) : null;
    if (match) maxCode = Math.max(maxCode, Number(match[1]));
  });
  const migrateList = (list: Partial<Offcut>[], offset: number) =>
    list
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => {
        const code = typeof item.code === 'string' && item.code ? item.code : formatOffcutCode((maxCode += 1));
        const registeredAt = Number(item.registeredAt) > 0 ? Number(item.registeredAt) : base + (offset + index) * 1000;
        return normalizeOffcut(item, code, registeredAt);
      });

  const records = dedupeFirstWins(migrateList(legacyRecords, 0));
  const pending = dedupeFirstWins(migrateList(Array.isArray(legacy.pending) ? legacy.pending : [], records.length));
  const outbox = dedupeFirstWins(migrateList(Array.isArray(legacy.outbox) ? legacy.outbox : [], records.length + pending.length));

  return {
    schemaVersion: OFFCUT_SCHEMA_VERSION,
    capacity: Number(legacy.capacity) > 0 ? Number(legacy.capacity) : OFFCUT_CAPACITY,
    records,
    pending,
    outbox,
    online: legacy.online !== false,
    lastSyncAt: Number(legacy.lastSyncAt) > 0 ? Number(legacy.lastSyncAt) : null,
    updatedAt: Number(legacy.updatedAt) > 0 ? Number(legacy.updatedAt) : Date.now(),
  };
}

/** 按编号合并：同一编号只留先登记的，晚到的直接丢弃；完全相同的重传自然去重 */
export function dedupeFirstWins(list: Offcut[]): Offcut[] {
  const byCode = new Map<string, Offcut>();
  list.forEach((offcut) => {
    const existing = byCode.get(offcut.code);
    if (!existing || offcut.registeredAt < existing.registeredAt) byCode.set(offcut.code, offcut);
  });
  return [...byCode.values()].sort((a, b) => a.registeredAt - b.registeredAt || a.code.localeCompare(b.code));
}

export interface IngestResult {
  ledger: OffcutLedger;
  stored: number;
  queued: number;
  duplicates: number;
}

/**
 * 入库：按编号合并，同一编号只留登记时间最早的一条（晚到的不盖掉先登记的）；
 * 容量内直接入库，满了进 pending 排队等位；完全相同的重传只入库一次。
 */
export function ingestOffcuts(ledger: OffcutLedger, incoming: Offcut[]): IngestResult {
  const records = [...ledger.records];
  const pending = [...ledger.pending];
  let stored = 0;
  let queued = 0;
  let duplicates = 0;

  incoming.forEach((offcut) => {
    const recordIndex = records.findIndex((item) => item.code === offcut.code);
    if (recordIndex >= 0) {
      if (offcut.registeredAt < records[recordIndex].registeredAt) records[recordIndex] = offcut;
      duplicates += 1;
      return;
    }
    const pendingIndex = pending.findIndex((item) => item.code === offcut.code);
    if (pendingIndex >= 0) {
      if (offcut.registeredAt < pending[pendingIndex].registeredAt) pending[pendingIndex] = offcut;
      duplicates += 1;
      return;
    }
    if (records.length < ledger.capacity) {
      records.push(offcut);
      stored += 1;
    } else {
      pending.push(offcut);
      queued += 1;
    }
  });

  records.sort((a, b) => a.registeredAt - b.registeredAt || a.code.localeCompare(b.code));
  return {
    ledger: { ...ledger, records, pending, updatedAt: Date.now() },
    stored,
    queued,
    duplicates,
  };
}

/** 登记入口：在线直接入库，断网进 outbox 等回网后按编号合并 */
export function registerOffcut(ledger: OffcutLedger, offcut: Offcut): { ledger: OffcutLedger; queuedOffline: boolean } {
  if (!ledger.online) {
    const outbox = ledger.outbox.some((item) => item.code === offcut.code)
      ? ledger.outbox
      : [...ledger.outbox, offcut];
    return { ledger: { ...ledger, outbox, updatedAt: Date.now() }, queuedOffline: true };
  }
  return { ledger: ingestOffcuts(ledger, [offcut]).ledger, queuedOffline: false };
}

/** 回网同步：outbox 按编号合并进库，重传只入库一次；容量满则排队等位 */
export function syncOutbox(ledger: OffcutLedger): IngestResult {
  if (ledger.outbox.length === 0) return { ledger, stored: 0, queued: 0, duplicates: 0 };
  const result = ingestOffcuts(ledger, ledger.outbox);
  return {
    ...result,
    ledger: { ...result.ledger, outbox: [], lastSyncAt: Date.now(), updatedAt: Date.now() },
  };
}

/** 释放库位后，把排队等位的记录按登记顺序补进库 */
export function drainPending(ledger: OffcutLedger): OffcutLedger {
  if (ledger.pending.length === 0 || ledger.records.length >= ledger.capacity) return ledger;
  const records = [...ledger.records];
  const pending = [...ledger.pending];
  while (records.length < ledger.capacity && pending.length > 0) {
    records.push(pending.shift()!);
  }
  records.sort((a, b) => a.registeredAt - b.registeredAt || a.code.localeCompare(b.code));
  return { ...ledger, records, pending, updatedAt: Date.now() };
}

export interface ClaimResult {
  ledger: OffcutLedger;
  /** null 表示占用成功；否则返回当前占用中的记录 */
  conflict: Offcut | null;
}

/** 占用余料：同一块余料只留先到的占用，后来者拿到占用者信息去换料 */
export function claimOffcut(ledger: OffcutLedger, code: string, operator: string): ClaimResult {
  const target = ledger.records.find((offcut) => offcut.code === code);
  if (!target) return { ledger, conflict: null };
  if (target.status === 'occupied') return { ledger, conflict: target };
  const records = ledger.records.map((offcut) =>
    offcut.code === code
      ? { ...offcut, status: 'occupied' as const, occupiedBy: operator, occupiedAt: Date.now() }
      : offcut,
  );
  return { ledger: { ...ledger, records, updatedAt: Date.now() }, conflict: null };
}

export function releaseOffcut(ledger: OffcutLedger, code: string): OffcutLedger {
  const records = ledger.records.map((offcut) =>
    offcut.code === code ? { ...offcut, status: 'available' as const, occupiedBy: null, occupiedAt: null } : offcut,
  );
  return { ...ledger, records, updatedAt: Date.now() };
}

/** 用掉 / 移除余料：释放库位并自动让排队记录补位 */
export function removeOffcut(ledger: OffcutLedger, code: string): OffcutLedger {
  return drainPending({
    ...ledger,
    records: ledger.records.filter((offcut) => offcut.code !== code),
    updatedAt: Date.now(),
  });
}

/** 占用冲突时给另一人推荐可换的同板材余料（能放下原尺寸） */
export function suggestAlternatives(ledger: OffcutLedger, offcut: Offcut): Offcut[] {
  return ledger.records
    .filter(
      (candidate) =>
        candidate.code !== offcut.code &&
        candidate.status === 'available' &&
        candidate.stockId === offcut.stockId &&
        candidate.length >= offcut.length &&
        candidate.width >= offcut.width,
    )
    .sort((a, b) => a.length * a.width - b.length * b.width);
}
