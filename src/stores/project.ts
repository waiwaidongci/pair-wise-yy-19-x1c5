import { useEffect, useRef } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createInitialProject } from '../utils/project';
import { nestProject } from '../utils/nesting';
import { useLeftoverBridge, useLeftoverLibrary } from '../hooks/useLeftoverLibrary';
import type { ManualPosition, WoodworkingProject } from '../types/woodworking';

export const projectAtom = atomWithStorage<WoodworkingProject>(
  'joinery-nest:project',
  createInitialProject(),
);

export const manualPositionsAtom = atomWithStorage<Record<string, ManualPosition>>(
  'joinery-nest:manual',
  {},
);

export const selectedPartIdAtom = atom<string | null>('part-side-l');
export const selectedJointIdAtom = atom<string | null>(null);
export const revisionAtom = atom(0);

export const nestingResultAtom = atom((get) =>
  nestProject(get(projectAtom), get(manualPositionsAtom)),
);

export const selectedPartAtom = atom((get) => {
  const selectedId = get(selectedPartIdAtom);
  return get(projectAtom).parts.find((part) => part.id === selectedId) ?? null;
});

export const projectStatsAtom = atom((get) => {
  const project = get(projectAtom);
  const result = get(nestingResultAtom);
  const totalQuantity = project.parts.reduce((sum, part) => sum + part.quantity, 0);
  return {
    totalQuantity,
    partKinds: new Set(project.parts.map((part) => part.kind)).size,
    joints: project.joinery.reduce((sum, item) => sum + item.count, 0),
    result,
  };
});

/**
 * 台账桥接 + 排料副作用：
 * - 把余料库运行时数据镜像进项目档案（同一份开料账）；
 * - 排料自动固定到余料的定位写回 manualPositions（不覆盖手工微调）；
 * - 核销本次排料消耗的余料（已消耗的余料不再触发写入）。
 */
export function LedgerBridge() {
  useLeftoverBridge();
  const result = useAtomValue(nestingResultAtom);
  const [, setManualPositions] = useAtom(manualPositionsAtom);
  const { consume } = useLeftoverLibrary();
  const resultRef = useRef(result);
  resultRef.current = result;

  useEffect(() => {
    const current = resultRef.current;
    if (current.autoPins.length) {
      setManualPositions((prev) => {
        let next = prev;
        for (const pin of current.autoPins) {
          const existing = next[pin.key];
          if (existing && !existing.auto) continue;
          if (
            existing &&
            existing.x === pin.manual.x &&
            existing.y === pin.manual.y &&
            existing.rotated === pin.manual.rotated &&
            existing.leftoverId === pin.manual.leftoverId
          ) {
            continue;
          }
          if (next === prev) next = { ...prev };
          next[pin.key] = pin.manual;
        }
        return next;
      });
    }
    if (current.usedLeftoverIds.length) consume(current.usedLeftoverIds);
  }, [result, setManualPositions, consume]);

  return null;
}

