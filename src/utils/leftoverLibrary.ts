import type { Leftover, LeftoverStatus } from '../types/woodworking';

/**
 * 余料库（运行时开料账）。
 *
 * 设计要点（对应车间场景）：
 * - 编号 id 是合并与幂等恢复的主键：断网回网后按编号合并，重传只入库一次。
 * - 占用采用先到先得的同步比较-交换：两人同时提交同一块余料，只留先到的，
 *   后到者拿到占用者信息后换料。
 * - 库容满了先排队等位，有空位再按 FIFO 写入。
 * - 写入失败不丢记录：留在待重传队列，之后可按编号恢复。
 * - 旧数据没有编号，升级时补成首版（version = 1）后照常读回。
 *
 * 库内数据是唯一运行时权威，持久化到 localStorage；项目档案中的 leftovers
 * 字段是它的镜像（同一份开料账）。
 */

export const LEFTOVER_LIBRARY_CAPACITY = 12;
const STORAGE_KEY = 'joinery-nest:leftovers';
const SCHEMA_VERSION = 1;

export interface ClaimResult {
  status: 'ok' | 'occupied' | 'missing' | 'consumed';
  /** 先到的占用者（后到者据此换料） */
  occupiedBy?: string;
  occupiedAt?: number;
  version?: number;
}

export interface RegisterResult {
  status: 'stored' | 'duplicate' | 'queued-capacity' | 'queued-offline' | 'failed';
  leftover?: Leftover;
  error?: string;
}

export interface LibraryState {
  online: boolean;
  capacity: number;
  activeCount: number;
  waitQueue: Array<{ id: string; name: string }>;
  outbox: Array<{ id: string; name: string; reason: string }>;
}

type Listener = () => void;
type Waiter = {
  id: string;
  leftover: Leftover;
  resolve: (result: RegisterResult) => void;
};

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 旧数据升级：没有编号的补编号，没有版本的补首版 v1。 */
export function migrateLeftovers(raw: unknown): Leftover[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item, index) => {
      const id = typeof item.id === 'string' && item.id ? item.id : `leftover-v1-${index}-${createId('legacy')}`;
      const length = Number(item.length) || 0;
      const width = Number(item.width) || 0;
      const thickness = Number(item.thickness) || 0;
      const stockId = typeof item.stockId === 'string' && item.stockId ? item.stockId : 'unknown';
      const status: LeftoverStatus =
        item.status === 'occupied' || item.status === 'consumed' ? item.status : 'available';
      return {
        id,
        length,
        width,
        thickness,
        stockId,
        status,
        occupiedBy: typeof item.occupiedBy === 'string' ? item.occupiedBy : undefined,
        occupiedAt: typeof item.occupiedAt === 'number' ? item.occupiedAt : undefined,
        version: typeof item.version === 'number' && item.version >= 1 ? item.version : SCHEMA_VERSION,
        source: item.source === 'manual' ? 'manual' : 'nesting',
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      } satisfies Leftover;
    });
}

class LeftoverLibrary {
  private leftovers: Leftover[] = [];
  private listeners = new Set<Listener>();
  private online = true;
  private outbox = new Map<string, Leftover>();
  private waitQueue: Waiter[] = [];
  private capacity = LEFTOVER_LIBRARY_CAPACITY;
  private failNextWrite = false;
  private hydrated = false;

  constructor() {
    this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.setOnline(true));
      window.addEventListener('offline', () => this.setOnline(false));
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.leftovers = migrateLeftovers(JSON.parse(raw));
    } catch {
      /* 损坏的缓存忽略，按空库启动 */
    }
    this.hydrated = true;
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.leftovers));
    } catch {
      /* 存储不可用时仅保留内存态 */
    }
    this.emit();
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  getSnapshot = (): Leftover[] => this.leftovers;

  isHydrated() {
    return this.hydrated;
  }

  getState(): LibraryState {
    return {
      online: this.online,
      capacity: this.capacity,
      activeCount: this.activeCount(),
      waitQueue: this.waitQueue.map((waiter) => ({ id: waiter.leftover.id, name: this.nameOf(waiter.leftover) })),
      outbox: [...this.outbox.values()].map((leftover) => ({
        id: leftover.id,
        name: this.nameOf(leftover),
        reason: this.online ? '写入失败待恢复' : '断网待重传',
      })),
    };
  }

  private nameOf(leftover: Leftover) {
    return `${leftover.id} · ${leftover.length}×${leftover.width}×${leftover.thickness}`;
  }

  /** 活跃库容：可用 + 已占用（已消耗的归档不占库容）。 */
  private activeCount() {
    return this.leftovers.filter((item) => item.status !== 'consumed').length;
  }

  setOnline(online: boolean) {
    this.online = online;
    if (online) this.flushOutbox();
    else this.emit();
  }

  isOnline() {
    return this.online;
  }

  /** 手动触发一次“写入失败”，用于演示按编号恢复。 */
  armNextFailure() {
    this.failNextWrite = true;
  }

  /** 升级/读档：用项目档案中的余料镜像初始化（仅当库为空）。 */
  hydrate(seed: unknown) {
    if (this.leftovers.length === 0) {
      this.leftovers = migrateLeftovers(seed);
      this.persist();
    }
  }

  /** 载入项目文件：整体替换为升级后的余料镜像。 */
  replaceAll(next: unknown) {
    this.leftovers = migrateLeftovers(next);
    this.outbox.clear();
    this.waitQueue.forEach((waiter) => waiter.resolve({ status: 'failed', error: '项目已切换' }));
    this.waitQueue = [];
    this.persist();
  }

  /**
   * 登记一块余料。断网进待重传队列；库容满进等位队列；写入失败进待恢复队列。
   * 全程按编号幂等：重传不会重复入库。
   */
  register(input: Partial<Leftover> & { length: number; width: number; thickness: number; stockId: string }): Promise<RegisterResult> {
    const leftover: Leftover = {
      id: input.id && typeof input.id === 'string' ? input.id : createId('leftover'),
      length: input.length,
      width: input.width,
      thickness: input.thickness,
      stockId: input.stockId,
      status: 'available',
      version: input.version && input.version >= 1 ? input.version : SCHEMA_VERSION,
      source: input.source ?? 'manual',
      createdAt: input.createdAt ?? Date.now(),
    };

    if (!this.online) {
      this.outbox.set(leftover.id, leftover);
      this.emit();
      return Promise.resolve({ status: 'queued-offline', leftover });
    }

    if (this.activeCount() >= this.capacity) {
      return new Promise<RegisterResult>((resolve) => {
        this.waitQueue.push({ id: leftover.id, leftover, resolve });
        this.emit();
      });
    }

    return Promise.resolve(this.doStore(leftover));
  }

  /** 实际写入：按编号去重（重传只入库一次），失败则留待恢复。 */
  private doStore(leftover: Leftover): RegisterResult {
    const existing = this.leftovers.find((item) => item.id === leftover.id);
    if (existing) return { status: 'duplicate', leftover: existing };

    if (this.failNextWrite) {
      this.failNextWrite = false;
      this.outbox.set(leftover.id, leftover);
      this.emit();
      return { status: 'failed', leftover, error: '写入失败：已按编号留待恢复' };
    }

    this.leftovers = [...this.leftovers, leftover];
    this.persist();
    return { status: 'stored', leftover };
  }

  /** 空位出现时按 FIFO 处理等位队列。 */
  private processWaitQueue() {
    while (this.waitQueue.length > 0 && this.activeCount() < this.capacity) {
      const waiter = this.waitQueue.shift()!;
      const result = this.doStore(waiter.leftover);
      waiter.resolve(result);
    }
    this.emit();
  }

  /**
   * 占用同一块余料：先到先得，同步比较-交换。
   * 后到者拿到占用者信息，应换料（改占其它 available 余料）。
   */
  claim(id: string, claimer: string): ClaimResult {
    const target = this.leftovers.find((item) => item.id === id);
    if (!target) return { status: 'missing' };
    if (target.status === 'consumed') return { status: 'consumed' };
    if (target.status === 'occupied') {
      return { status: 'occupied', occupiedBy: target.occupiedBy, occupiedAt: target.occupiedAt, version: target.version };
    }
    this.leftovers = this.leftovers.map((item) =>
      item.id === id
        ? { ...item, status: 'occupied', occupiedBy: claimer, occupiedAt: Date.now(), version: item.version + 1 }
        : item,
    );
    this.persist();
    return { status: 'ok', version: this.leftovers.find((item) => item.id === id)?.version };
  }

  /** 释放占用（换料后原占用归还）。 */
  release(id: string) {
    this.leftovers = this.leftovers.map((item) =>
      item.id === id && item.status === 'occupied'
        ? { ...item, status: 'available', occupiedBy: undefined, occupiedAt: undefined }
        : item,
    );
    this.persist();
  }

  /** 排料消耗：标记已用，腾出的库容让等位队列继续。 */
  consume(ids: string[]) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    let changed = false;
    this.leftovers = this.leftovers.map((item) => {
      if (idSet.has(item.id) && item.status !== 'consumed') {
        changed = true;
        return { ...item, status: 'consumed' as LeftoverStatus, occupiedBy: undefined, occupiedAt: undefined };
      }
      return item;
    });
    if (changed) {
      this.persist();
      this.processWaitQueue();
    }
  }

  /** 作废/移除：腾出的库容让等位队列继续。 */
  remove(id: string) {
    this.leftovers = this.leftovers.filter((item) => item.id !== id);
    this.outbox.delete(id);
    this.persist();
    this.processWaitQueue();
  }

  /** 按编号恢复单条待重传记录。 */
  recoverById(id: string): Promise<RegisterResult> {
    const leftover = this.outbox.get(id);
    if (!leftover) return Promise.resolve({ status: 'duplicate' });
    this.outbox.delete(id);
    if (this.activeCount() >= this.capacity) {
      return new Promise<RegisterResult>((resolve) => {
        this.waitQueue.push({ id, leftover, resolve });
        this.emit();
      });
    }
    return Promise.resolve(this.doStore(leftover));
  }

  /** 回网后重传全部待传记录（按编号幂等）。 */
  flushOutbox() {
    if (!this.online) return;
    const pending = [...this.outbox.entries()];
    pending.forEach(([id, leftover]) => {
      this.outbox.delete(id);
      if (this.activeCount() < this.capacity) {
        this.doStore(leftover);
      } else {
        this.waitQueue.push({ id, leftover, resolve: () => undefined });
      }
    });
    this.emit();
  }
}

let singleton: LeftoverLibrary | null = null;
export function getLeftoverLibrary(): LeftoverLibrary {
  if (!singleton) singleton = new LeftoverLibrary();
  return singleton;
}
