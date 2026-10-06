import type {
  ManualPosition,
  NestingResult,
  Offcut,
  Part,
  Placement,
  SheetLayout,
  StockSheet,
  WoodworkingProject,
} from '../types/woodworking';

interface Board {
  key: string;
  source: 'sheet' | 'offcut';
  stockId: string;
  sheetIndex: number;
  offcut: Offcut | null;
  length: number;
  width: number;
  trim: number;
  placements: Placement[];
}

interface StockGroupResult {
  layouts: SheetLayout[];
  placements: Placement[];
  unplaced: NestingResult['unplaced'];
}

function canRotate(part: Part) {
  return part.grain === 'none';
}

function dimensions(part: Part, rotated: boolean) {
  return rotated
    ? { width: part.width, height: part.length }
    : { width: part.length, height: part.width };
}

function overlaps(a: Placement, b: Placement) {
  if (a.boardKey !== b.boardKey) return false;
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

export function getPartPlacementSize(part: Part, rotated = false) {
  return dimensions(part, rotated);
}

function expandParts(parts: Part[]) {
  return parts
    .flatMap((part) =>
      Array.from({ length: Math.max(1, part.quantity) }, (_, instance) => ({ part, instance })),
    )
    .sort((a, b) => {
      const areaA = a.part.length * a.part.width;
      const areaB = b.part.length * b.part.width;
      if (a.part.grain !== 'none' && b.part.grain === 'none') return -1;
      if (a.part.grain === 'none' && b.part.grain !== 'none') return 1;
      return areaB - areaA || b.part.length - a.part.length;
    });
}

/** 在单块板面（新板或余料）上按行式排布找一个空位 */
function tryPlaceOnBoard(board: Board, size: { width: number; height: number }, kerf: number) {
  const usableWidth = board.length - board.trim * 2;
  const usableHeight = board.width - board.trim * 2;
  if (size.width > usableWidth || size.height > usableHeight) return null;

  const rows = new Map<number, { y: number; height: number; usedWidth: number }>();
  board.placements.forEach((item) => {
    const row = rows.get(item.y) ?? { y: item.y, height: 0, usedWidth: 0 };
    row.height = Math.max(row.height, item.height);
    row.usedWidth = Math.max(row.usedWidth, item.x - board.trim + item.width);
    rows.set(item.y, row);
  });

  for (const row of [...rows.values()].sort((a, b) => a.y - b.y)) {
    if (size.height > row.height + 0.001) continue;
    const x = board.trim + row.usedWidth + (row.usedWidth > 0 ? kerf : 0);
    if (x + size.width > board.trim + usableWidth) continue;
    return { x, y: row.y };
  }

  const sortedRows = [...rows.values()].sort((a, b) => a.y - b.y);
  const lastRow = sortedRows.at(-1);
  const y = lastRow ? lastRow.y + lastRow.height + kerf : board.trim;
  if (y + size.height <= board.trim + usableHeight) return { x: board.trim, y };
  return null;
}

function toLayout(board: Board, stock: StockSheet): SheetLayout {
  const usedArea = board.placements.reduce((sum, item) => sum + item.width * item.height, 0);
  const usableArea = (board.length - board.trim * 2) * (board.width - board.trim * 2);
  return {
    boardKey: board.key,
    source: board.source,
    stockId: board.stockId,
    sheetIndex: board.sheetIndex,
    stock,
    offcut: board.offcut,
    boardLength: board.length,
    boardWidth: board.width,
    trim: board.trim,
    placements: board.placements,
    usedArea,
    usableArea,
    wasteArea: Math.max(0, usableArea - usedArea),
  };
}

function nestStockGroup(
  project: WoodworkingProject,
  stock: StockSheet,
  parts: Part[],
  offcuts: Offcut[],
  manualPositions: Record<string, ManualPosition>,
): StockGroupResult {
  const makeSheetBoard = (index: number): Board => ({
    key: `sheet:${stock.id}:${index}`,
    source: 'sheet',
    stockId: stock.id,
    sheetIndex: index,
    offcut: null,
    length: stock.length,
    width: stock.width,
    trim: project.trim,
    placements: [],
  });

  // 余料优先：面积小的先用，尽量把大块余料留给后面的零件
  const offcutBoards: Board[] = offcuts
    .slice()
    .sort((a, b) => a.length * a.width - b.length * b.width)
    .map((offcut) => ({
      key: `offcut:${offcut.code}`,
      source: 'offcut' as const,
      stockId: stock.id,
      sheetIndex: 0,
      offcut,
      length: offcut.length,
      width: offcut.width,
      trim: 0,
      placements: [],
    }));
  const sheetBoards: Board[] = [];
  const placements: Placement[] = [];
  const unplaced: StockGroupResult['unplaced'] = [];

  const placeOn = (board: Board, part: Part, instance: number, rotated: boolean, size: { width: number; height: number }, spot: { x: number; y: number }): Placement => {
    const placement: Placement = {
      key: `${part.id}:${instance}`,
      partId: part.id,
      instance,
      stockId: stock.id,
      boardKey: board.key,
      sheetIndex: board.sheetIndex,
      offcutCode: board.offcut?.code ?? null,
      x: spot.x,
      y: spot.y,
      width: size.width,
      height: size.height,
      rotated,
      manual: false,
    };
    board.placements.push(placement);
    return placement;
  };

  expandParts(parts).forEach(({ part, instance }) => {
    const candidates = canRotate(part) ? [false, true] : [part.grain === 'width'];
    let placed: Placement | null = null;

    for (const rotated of candidates) {
      const size = dimensions(part, rotated);
      // 1. 先试余料
      for (const board of offcutBoards) {
        const spot = tryPlaceOnBoard(board, size, project.kerf);
        if (spot) {
          placed = placeOn(board, part, instance, rotated, size, spot);
          break;
        }
      }
      // 2. 再试已开的新板
      if (!placed) {
        for (const board of sheetBoards) {
          const spot = tryPlaceOnBoard(board, size, project.kerf);
          if (spot) {
            placed = placeOn(board, part, instance, rotated, size, spot);
            break;
          }
        }
      }
      // 3. 放不下才开新板
      if (!placed) {
        const board = makeSheetBoard(sheetBoards.length);
        const spot = tryPlaceOnBoard(board, size, project.kerf);
        if (spot) {
          sheetBoards.push(board);
          placed = placeOn(board, part, instance, rotated, size, spot);
        }
      }
      if (placed) break;
    }

    if (!placed) {
      unplaced.push({ partId: part.id, instance, reason: '余料和新板都放不下（尺寸超过可用区域）' });
      return;
    }
    const autoPlaced = placed;

    const manual = manualPositions[autoPlaced.key];
    if (manual) {
      const size = dimensions(part, manual.rotated);
      let target: Board | undefined;
      if (manual.boardKey?.startsWith('offcut:')) {
        target = offcutBoards.find((board) => board.key === manual.boardKey);
      } else {
        const sheetIndex = manual.boardKey?.startsWith('sheet:')
          ? Number(manual.boardKey.split(':').at(-1))
          : manual.sheetIndex;
        if (Number.isFinite(sheetIndex) && sheetIndex >= 0 && sheetIndex < 20) {
          while (sheetBoards.length <= sheetIndex) sheetBoards.push(makeSheetBoard(sheetBoards.length));
          target = sheetBoards[sheetIndex];
        }
      }
      if (target) {
        const autoBoard = [...offcutBoards, ...sheetBoards].find((board) => board.key === autoPlaced.boardKey);
        if (autoBoard) autoBoard.placements = autoBoard.placements.filter((item) => item.key !== autoPlaced.key);
        placed = {
          ...autoPlaced,
          boardKey: target.key,
          sheetIndex: target.sheetIndex,
          offcutCode: target.offcut?.code ?? null,
          x: manual.x,
          y: manual.y,
          width: size.width,
          height: size.height,
          rotated: manual.rotated,
          manual: true,
        };
        target.placements.push(placed);
      }
    }
    placements.push(placed);
  });

  const layouts: SheetLayout[] = [];
  offcutBoards.forEach((board) => {
    if (board.placements.length > 0) layouts.push(toLayout(board, stock));
  });
  sheetBoards.forEach((board) => layouts.push(toLayout(board, stock)));
  return { layouts, placements, unplaced };
}

/** 每种板材一份排料缓存：零件改动只让受牵连的板材重算，其余沿用原结果 */
interface CacheEntry {
  signature: string;
  group: StockGroupResult;
}
const groupCache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 60;

function stockSignature(
  stock: StockSheet,
  parts: Part[],
  offcuts: Offcut[],
  kerf: number,
  trim: number,
  manualPositions: Record<string, ManualPosition>,
) {
  const partIds = new Set(parts.map((part) => part.id));
  const manual = Object.entries(manualPositions)
    .filter(([key]) => partIds.has(key.slice(0, key.lastIndexOf(':'))))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    stock: [stock.id, stock.name, stock.material, stock.length, stock.width, stock.thickness, stock.price, stock.quantity],
    kerf,
    trim,
    parts: parts.map((part) => [part.id, part.length, part.width, part.thickness, part.quantity, part.grain]),
    offcuts: offcuts.map((offcut) => [offcut.code, offcut.length, offcut.width, offcut.thickness]),
    manual,
  });
}

export function nestProject(
  project: WoodworkingProject,
  manualPositions: Record<string, ManualPosition>,
  offcuts: Offcut[] = [],
): NestingResult {
  const startedAt = performance.now();
  const stockById = new Map(project.stocks.map((stock) => [stock.id, stock]));
  const availableOffcuts = offcuts.filter(
    (offcut) => offcut.status === 'available' && stockById.has(offcut.stockId),
  );

  const layouts: SheetLayout[] = [];
  const placements: Placement[] = [];
  const unplaced: NestingResult['unplaced'] = [];
  const reusedStocks: string[] = [];
  let totalParts = 0;

  project.stocks.forEach((stock) => {
    const parts = project.parts.filter((part) => part.stockId === stock.id);
    if (parts.length === 0) return;
    totalParts += parts.reduce((sum, part) => sum + Math.max(1, part.quantity), 0);
    const stockOffcuts = availableOffcuts.filter((offcut) => offcut.stockId === stock.id);
    const signature = stockSignature(stock, parts, stockOffcuts, project.kerf, project.trim, manualPositions);
    const cached = groupCache.get(stock.id);
    let group: StockGroupResult;
    if (cached && cached.signature === signature) {
      group = cached.group;
      reusedStocks.push(stock.name);
    } else {
      group = nestStockGroup(project, stock, parts, stockOffcuts, manualPositions);
      groupCache.set(stock.id, { signature, group });
      if (groupCache.size > CACHE_LIMIT) {
        const oldest = groupCache.keys().next().value;
        if (oldest !== undefined) groupCache.delete(oldest);
      }
    }
    layouts.push(...group.layouts);
    placements.push(...group.placements);
    unplaced.push(...group.unplaced);
  });

  const collisions: string[] = [];
  placements.forEach((placement, index) => {
    placements.slice(index + 1).forEach((other) => {
      if (overlaps(placement, other)) collisions.push(`${placement.key}|${other.key}`);
    });
  });

  const usedArea = placements.reduce((sum, item) => sum + item.width * item.height, 0);
  const sheetLayouts = layouts.filter((layout) => layout.source === 'sheet');
  const offcutLayouts = layouts.filter((layout) => layout.source === 'offcut');
  const sheetArea = sheetLayouts.reduce((sum, layout) => sum + layout.boardLength * layout.boardWidth, 0);
  const offcutArea = offcutLayouts.reduce((sum, layout) => sum + layout.boardLength * layout.boardWidth, 0);
  const boardArea = sheetArea + offcutArea;
  // 余料是已购板材的剩余，只新板计入采购成本
  const purchaseCost = sheetLayouts.reduce((sum, layout) => sum + layout.stock.price, 0);

  return {
    layouts,
    placements,
    totalParts,
    placedParts: placements.length,
    unplaced,
    usedArea,
    sheetArea,
    offcutArea,
    offcutCount: offcutLayouts.length,
    utilization: boardArea > 0 ? (usedArea / boardArea) * 100 : 0,
    wasteArea: layouts.reduce((sum, layout) => sum + layout.wasteArea, 0),
    purchaseCost,
    sheetCount: sheetLayouts.length,
    reusedStocks,
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    collisions,
  };
}

export function formatArea(area: number) {
  return `${(area / 1_000_000).toFixed(2)} m²`;
}
