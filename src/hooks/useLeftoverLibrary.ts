import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { useAtom } from 'jotai';
import { getLeftoverLibrary, type LibraryState, type RegisterResult, type ClaimResult } from '../utils/leftoverLibrary';
import { projectAtom } from '../stores/project';
import type { Leftover } from '../types/woodworking';

const library = getLeftoverLibrary();

function sameLeftovers(a: Leftover[], b: Leftover[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      item.id === other.id &&
      item.status === other.status &&
      item.version === other.version &&
      item.occupiedBy === other.occupiedBy &&
      item.length === other.length &&
      item.width === other.width &&
      item.thickness === other.thickness &&
      item.stockId === other.stockId
    );
  });
}

/** 订阅余料库运行时状态。 */
export function useLeftoverLibrary() {
  const leftovers = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  return {
    leftovers,
    state: library.getState() as LibraryState,
    isOnline: library.isOnline(),
    register: useCallback(
      (input: Partial<Leftover> & { length: number; width: number; thickness: number; stockId: string }): Promise<RegisterResult> =>
        library.register(input),
      [],
    ),
    claim: useCallback((id: string, claimer: string): ClaimResult => library.claim(id, claimer), []),
    release: useCallback((id: string) => library.release(id), []),
    consume: useCallback((ids: string[]) => library.consume(ids), []),
    remove: useCallback((id: string) => library.remove(id), []),
    recoverById: useCallback((id: string) => library.recoverById(id), []),
    flushOutbox: useCallback(() => library.flushOutbox(), []),
    setOnline: useCallback((online: boolean) => library.setOnline(online), []),
    armNextFailure: useCallback(() => library.armNextFailure(), []),
  };
}

/**
 * 把余料库运行时数据镜像到项目档案（同一份开料账）。
 * 项目文件仍是持久化/导出的台账：载入项目时由 ExportView 调 library.replaceAll 整体替换。
 */
export function useLeftoverBridge() {
  const [project, setProject] = useAtom(projectAtom);
  const leftovers = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);

  // 首次挂载：若库为空则用项目档案中的余料镜像播种（内部会做升级补号）。
  useEffect(() => {
    if (!library.isHydrated()) return;
    library.hydrate(project.leftovers);
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 库变更 → 项目档案镜像。
  useEffect(() => {
    setProject((current) => {
      if (sameLeftovers(current.leftovers ?? [], leftovers)) return current;
      return { ...current, leftovers };
    });
  }, [leftovers, setProject]);
}
