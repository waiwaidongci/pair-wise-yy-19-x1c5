import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createInitialProject } from '../utils/project';
import { nestProject } from '../utils/nesting';
import { offcutLedgerAtom } from './offcuts';
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

/** 余料库、零件和排料图在这里接成同一份开料账：任一变动都会让结果整体重算 */
export const nestingResultAtom = atom((get) =>
  nestProject(get(projectAtom), get(manualPositionsAtom), get(offcutLedgerAtom).records),
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

