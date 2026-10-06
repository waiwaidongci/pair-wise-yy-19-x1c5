import type {
  GrainDirection,
  Leftover,
  ManualPosition,
  NestingResult,
  Part,
  Placement,
  SheetKind,
  SheetLayout,
  StockSheet,
  WoodworkingProject,
} from '../types/woodworking';

export const createId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const GRAIN_LABELS: Record<GrainDirection, string> = {
  length: '长边顺纹',
  width: '短边顺纹',
  none: '不限方向',
};

interface Row {
  y: number;
  height: number;
  usedWidth: number;
}

interface Sheet {
  key: string;
  kind: SheetKind;
  sheetIndex: number;
  leftoverId?: string;
  length: number;
  width: number;
  trim: number;
  frozen: boolean;
  placements: Placement[];
  rows: Row[];
}

interface StockResult {
  layouts: SheetLayout[];
  placements: Placement[];
  unplaced: NestingResult['unplaced'];
  usedLeftoverIds: string[];
  autoPins: Array<{ key: string; manual: ManualPosition }>;
}

function expandedParts(parts: Part[]) {
  return parts.flatMap((part) =>
    Array.from({ length: Math.max(1, part.quantity) }, (_, instance) => ({ part, instance })),
  );
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
  if (a.stockId !== b.stockId || a.sheetIndex !== b.sheetIndex || a.leftoverId !== b.leftoverId) return false;
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

function sortParts(a: { part: Part }, b: { part: Part }) {
  const areaA = a.part.length * a.part.width;
  const areaB = b.part.length * b.part.width;
  if (a.part.grain !== 'none' && b.part.grain === 'none') return -1;
  if (a.part.grain === 'none' && b.part.grain !== 'none') return 1;
  return areaB - areaA || b.part.length - a.part.length;
}

function partKey(partId: string, instance: number) {
  return `${partId}:${instance}`;
}

/** 把一个定位落到排料图上，并维护行结构。 */
function commitPlacement(
  sheet: Sheet,
  part: Part,
  instance: number,
  rotated: boolean,
  x: number,
  y: number,
  manual: boolean,
): Placement {
  const size = dimensions(part, rotated);
  const placement: Placement = {
    key: partKey(part.id, instance),
    partId: part.id,
    instance,
    stockId: part.stockId,
    sheetIndex: sheet.sheetIndex,
    x,
    y,
    width: size.width,
    height: size.height,
    rotated,
    manual,
    leftoverId: sheet.leftoverId,
    sheetKind: sheet.kind,
  };
  sheet.placements.push(placement);
  let row = sheet.rows.find((item) => item.y === y);
  if (!row) {
    row = { y, height: 0, usedWidth: 0 };
    sheet.rows.push(row);
  }
  row.height = Math.max(row.height, size.height);
  row.usedWidth = Math.max(row.usedWidth, x - sheet.trim + size.width);
  return placement;
}

/** 在余料/整板上按行排入一个零件；放不下返回 null。 */
function tryPack(
  sheet: Sheet,
  part: Part,
  instance: number,
  rotated: boolean,
  kerf: number,
): Placement | null {
  const size = dimensions(part, rotated);
  const usableWidth = sheet.length - sheet.trim * 2;
  const usableHeight = sheet.width - sheet.trim * 2;
  if (size.width > usableWidth || size.height > usableHeight) return null;

  const sortedRows = [...sheet.rows].sort((a, b) => a.y - b.y);
  for (const row of sortedRows) {
    if (size.height > row.height + 0.001) continue;
    const x = sheet.trim + row.usedWidth + (row.usedWidth > 0 ? kerf : 0);
    if (x + size.width > sheet.trim + usableWidth) continue;
    return commitPlacement(sheet, part, instance, rotated, x, row.y, false);
  }

  const lastRow = sortedRows.at(-1);
  const y = lastRow ? lastRow.y + lastRow.height + kerf : sheet.trim;
  if (y + size.height > sheet.trim + usableHeight) return null;
  return commitPlacement(sheet, part, instance, rotated, sheet.trim, y, false);
}

/** 校验定位是否落在排料图可用区内（重叠交给碰撞检测上报）。 */
function validPin(sheet: Sheet, part: Part, rotated: boolean, x: number, y: number) {
  const size = dimensions(part, rotated);
  return x >= 0 && y >= 0 && x + size.width <= sheet.length && y + size.height <= sheet.width;
}

function toLayout(sheet: Sheet, stock: StockSheet): SheetLayout {
  const usedArea = sheet.placements.reduce((sum, item) => sum + item.width * item.height, 0);
  const usableArea = (sheet.length - sheet.trim * 2) * (sheet.width - sheet.trim * 2);
  return {
    key: sheet.key,
    kind: sheet.kind,
    stockId: stock.id,
    sheetIndex: sheet.sheetIndex,
    leftoverId: sheet.leftoverId,
    stock,
    name: sheet.kind === 'leftover' ? `余料 ${sheet.leftoverId ?? ''}` : stock.name,
    length: sheet.length,
    width: sheet.width,
    placements: sheet.placements,
    usedArea,
    usableArea,
    wasteArea: Math.max(0, usableArea - usedArea),
  };
}

/**
 * 单块板材的排料：先排可用余料（能放下就先用余料），再开整板。
 * 已消耗的余料作为冻结排料图保留（零件通过 manualPositions 中的余料销钉固定）。
 */
function nestStock(
  stock: StockSheet,
  parts: Part[],
  leftovers: Leftover[],
  manualPositions: Record<string, ManualPosition>,
  kerf: number,
  trim: number,
): StockResult {
  const expanded = expandedParts(parts)
    .filter(({ part }) => part.stockId === stock.id)
    .sort(sortParts);

  const sheets: Sheet[] = [];
  const leftoverById = new Map<string, Leftover>();
  leftovers
    .filter((item) => item.stockId === stock.id)
    .forEach((item) => leftoverById.set(item.id, item));

  // 余料排料图：已消耗的冻结在前，可用的按面积升序（先小后大，省大料）。
  const frozenSheets: Sheet[] = [];
  const availableSheets: Sheet[] = [];
  [...leftoverById.values()]
    .sort((a, b) => a.length * a.width - b.length * b.width)
    .forEach((leftover) => {
      const sheet: Sheet = {
        key: `leftover:${leftover.id}`,
        kind: 'leftover',
        sheetIndex: -1,
        leftoverId: leftover.id,
        length: leftover.length,
        width: leftover.width,
        trim: 0,
        frozen: leftover.status === 'consumed',
        placements: [],
        rows: [],
      };
      if (sheet.frozen) frozenSheets.push(sheet);
      else if (leftover.status === 'available') availableSheets.push(sheet);
    });
  sheets.push(...frozenSheets, ...availableSheets);

  const fullSheets: Sheet[] = [];
  const ensureFullSheet = (index: number): Sheet => {
    let sheet = fullSheets[index];
    if (!sheet) {
      sheet = {
        key: `full:${stock.id}:${index}`,
        kind: 'full',
        sheetIndex: index,
        length: stock.length,
        width: stock.width,
        trim,
        frozen: false,
        placements: [],
        rows: [],
      };
      fullSheets[index] = sheet;
      sheets.push(sheet);
    }
    return sheet;
  };

  const placements: Placement[] = [];
  const unplaced: StockResult['unplaced'] = [];
  const usedLeftoverIds = new Set<string>();
  const autoPins: StockResult['autoPins'] = [];

  for (const { part, instance } of expanded) {
    const key = partKey(part.id, instance);
    const pin = manualPositions[key];
    let placed: Placement | null = null;

    if (pin) {
      if (pin.leftoverId && pin.sheetIndex === -1) {
        // 余料销钉：固定在某块余料上（冻结的已用余料或手工拖入的余料）。
        const sheet = sheets.find((item) => item.leftoverId === pin.leftoverId);
        if (sheet && validPin(sheet, part, pin.rotated, pin.x, pin.y)) {
          placed = commitPlacement(sheet, part, instance, pin.rotated, pin.x, pin.y, true);
          if (sheet.frozen) usedLeftoverIds.add(sheet.leftoverId!);
        }
      } else if (!pin.leftoverId && pin.sheetIndex >= 0 && pin.sheetIndex < 100) {
        // 整板手工定位：拖到哪张板的哪个位置就落在哪。
        const sheet = ensureFullSheet(pin.sheetIndex);
        if (validPin(sheet, part, pin.rotated, pin.x, pin.y)) {
          placed = commitPlacement(sheet, part, instance, pin.rotated, pin.x, pin.y, true);
        }
      }
    }

    if (!placed) {
      const candidates = part.grain === 'none' ? [false, true] : [part.grain === 'width'];
      for (const rotated of candidates) {
        // 先用余料（仅可用余料，冻结余料不再排新件）。
        for (const sheet of availableSheets) {
          placed = tryPack(sheet, part, instance, rotated, kerf);
          if (placed) {
            usedLeftoverIds.add(sheet.leftoverId!);
            autoPins.push({
              key,
              manual: {
                sheetIndex: -1,
                x: placed.x,
                y: placed.y,
                rotated: placed.rotated,
                leftoverId: sheet.leftoverId,
                auto: true,
              },
            });
            break;
          }
        }
        if (placed) break;

        // 再开整板（按需生成，前沿最多留一张空板）。
        for (let index = 0; ; index += 1) {
          const sheet = ensureFullSheet(index);
          placed = tryPack(sheet, part, instance, rotated, kerf);
          if (placed) break;
          if (index >= fullSheets.filter(Boolean).length - 1) break;
        }
        if (placed) break;
      }
    }

    if (!placed) {
      unplaced.push({ partId: part.id, instance, reason: '尺寸超过板材可用区域' });
      continue;
    }
    placements.push(placed);
  }

  const layouts = sheets.filter((sheet) => sheet.placements.length > 0).map((sheet) => toLayout(sheet, stock));
  return { layouts, placements, unplaced, usedLeftoverIds: [...usedLeftoverIds], autoPins };
}

/** 排料缓存：按板材分别缓存，未受牵连的板材沿用原结果。 */
const stockCache = new Map<string, { fingerprint: string; result: StockResult }>();

export function clearNestingCache() {
  stockCache.clear();
}

function stockFingerprint(
  stock: StockSheet,
  parts: Part[],
  leftovers: Leftover[],
  manualPositions: Record<string, ManualPosition>,
  kerf: number,
  trim: number,
) {
  const partIds = new Set(parts.map((part) => part.id));
  const manual = Object.entries(manualPositions)
    .filter(([key]) => partIds.has(key.split(':')[0]))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    s: [stock.id, stock.length, stock.width, stock.thickness, stock.price, stock.quantity],
    p: parts.map((part) => [part.id, part.length, part.width, part.thickness, part.quantity, part.grain, part.stockId]),
    l: leftovers
      .filter((item) => item.stockId === stock.id)
      .map((item) => [item.id, item.length, item.width, item.thickness, item.stockId, item.status])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    k: kerf,
    t: trim,
    m: manual,
  });
}

function nestStockCached(
  stock: StockSheet,
  parts: Part[],
  leftovers: Leftover[],
  manualPositions: Record<string, ManualPosition>,
  kerf: number,
  trim: number,
): { result: StockResult; cache: 'hit' | 'miss' } {
  const fingerprint = stockFingerprint(stock, parts, leftovers, manualPositions, kerf, trim);
  const cached = stockCache.get(stock.id);
  if (cached && cached.fingerprint === fingerprint) return { result: cached.result, cache: 'hit' };
  const result = nestStock(stock, parts, leftovers, manualPositions, kerf, trim);
  stockCache.set(stock.id, { fingerprint, result });
  return { result, cache: 'miss' };
}

export function nestProject(
  project: WoodworkingProject,
  manualPositions: Record<string, ManualPosition>,
): NestingResult {
  const startedAt = performance.now();
  const leftovers = project.leftovers ?? [];
  const stockById = new Map(project.stocks.map((stock) => [stock.id, stock]));

  const perStock = project.stocks.map((stock) => {
    const parts = project.parts.filter((part) => part.stockId === stock.id);
    return { stock, ...nestStockCached(stock, parts, leftovers, manualPositions, project.kerf, project.trim) };
  });

  const layouts: SheetLayout[] = [];
  const placements: Placement[] = [];
  const unplaced: NestingResult['unplaced'] = [];
  const usedLeftoverIds = new Set<string>();
  const autoPins: StockResult['autoPins'] = [];
  const cacheByStock: Record<string, 'hit' | 'miss'> = {};
  const recomputedStockIds: string[] = [];
  const reusedStockIds: string[] = [];

  perStock.forEach(({ stock, result, cache }) => {
    layouts.push(...result.layouts);
    placements.push(...result.placements);
    unplaced.push(...result.unplaced);
    result.usedLeftoverIds.forEach((id) => usedLeftoverIds.add(id));
    autoPins.push(...result.autoPins);
    cacheByStock[stock.id] = cache;
    if (cache === 'miss') recomputedStockIds.push(stock.id);
    else reusedStockIds.push(stock.id);
  });

  const collisions: string[] = [];
  placements.forEach((placement, index) => {
    placements.slice(index + 1).forEach((other) => {
      if (overlaps(placement, other)) collisions.push(`${placement.key}|${other.key}`);
    });
  });

  const fullLayouts = layouts.filter((layout) => layout.kind === 'full');
  const usedArea = placements.reduce((sum, item) => sum + item.width * item.height, 0);
  const materialArea = layouts.reduce((sum, layout) => sum + layout.length * layout.width, 0);
  const purchaseCost = fullLayouts.reduce((sum, layout) => sum + layout.stock.price, 0);
  const utilization = materialArea > 0 ? (usedArea / materialArea) * 100 : 0;
  const wasteArea = Math.max(0, materialArea - usedArea);

  return {
    layouts,
    placements,
    unplaced,
    totalParts: project.parts.reduce((sum, part) => sum + Math.max(1, part.quantity), 0),
    placedParts: placements.length,
    usedArea,
    sheetArea: materialArea,
    utilization,
    wasteArea,
    purchaseCost,
    sheetCount: fullLayouts.length,
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    collisions,
    usedLeftoverIds: [...usedLeftoverIds],
    leftoverCount: layouts.filter((layout) => layout.kind === 'leftover').length,
    cacheByStock,
    recomputedStockIds,
    reusedStockIds,
    autoPins,
  };
}

export function formatArea(area: number) {
  return `${(area / 1_000_000).toFixed(2)} m²`;
}
