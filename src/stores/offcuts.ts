import { atomWithStorage } from 'jotai/utils';
import { createInitialLedger, migrateLedger } from '../utils/offcuts';
import { createInitialProject } from '../utils/project';
import type { OffcutLedger } from '../types/woodworking';

const LEDGER_KEY = 'joinery-nest:offcuts';

/**
 * 读取时自动升级：旧数据没有余料编号 / 台账结构，
 * 在 getItem 里补成首版（schemaVersion = 1）后照常读回。
 */
const ledgerStorage = {
  getItem: (key: string, initialValue: OffcutLedger): OffcutLedger => {
    const raw = localStorage.getItem(key);
    if (!raw) return initialValue;
    try {
      return migrateLedger(JSON.parse(raw), () => initialValue);
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, value: OffcutLedger) => {
    localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem: (key: string) => {
    localStorage.removeItem(key);
  },
};

export const offcutLedgerAtom = atomWithStorage<OffcutLedger>(
  LEDGER_KEY,
  createInitialLedger(createInitialProject().stocks),
  ledgerStorage,
);

/** 当前操作的工位，用于演示两人同时提交同一块余料的占用 */
export const operatorAtom = atomWithStorage<string>('joinery-nest:operator', '工位A');
