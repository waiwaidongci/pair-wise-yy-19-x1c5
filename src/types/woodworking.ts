export type GrainDirection = 'length' | 'width' | 'none';
export type PartKind = '侧板' | '顶底板' | '门板' | '背板' | '搁板' | '桌腿' | '横撑' | '抽屉件';

export type JointType = '直榫' | '燕尾榫' | '搭槽' | '圆木榫' | '饼干榫' | '45°斜接';

/** 余料状态：可用 / 已被占用（排队确认中）/ 已消耗（排入料单） */
export type LeftoverStatus = 'available' | 'occupied' | 'consumed';

/**
 * 余料（开料账中的余料库条目）。
 * 编号 id 是合并与幂等恢复的主键；version 为首版/升级版本号。
 */
export interface Leftover {
  id: string;
  /** 长 mm */
  length: number;
  /** 宽 mm */
  width: number;
  /** 厚 mm */
  thickness: number;
  /** 所属板材（StockSheet.id），材质与厚度以所属板材为准 */
  stockId: string;
  status: LeftoverStatus;
  /** 占用者标识（先到先得，后到者据此看到占用者并换料） */
  occupiedBy?: string;
  occupiedAt?: number;
  /** 版本号，旧数据升级补成首版 v1 */
  version: number;
  /** 来源：排料产生 / 手工登记 */
  source?: 'nesting' | 'manual';
  createdAt: number;
}

export interface StockSheet {
  id: string;
  name: string;
  material: string;
  length: number;
  width: number;
  thickness: number;
  price: number;
  quantity: number;
}

export interface Part {
  id: string;
  name: string;
  kind: PartKind;
  stockId: string;
  length: number;
  width: number;
  thickness: number;
  quantity: number;
  grain: GrainDirection;
  edgeBanding: string;
  notes: string;
}

export interface Joinery {
  id: string;
  partAId: string;
  partBId: string;
  type: JointType;
  count: number;
  depth: number;
  offset: number;
  notes: string;
}

export interface WoodworkingProject {
  id: string;
  name: string;
  client: string;
  sheet: string;
  kerf: number;
  trim: number;
  stocks: StockSheet[];
  parts: Part[];
  joinery: Joinery[];
  /** 余料库（与零件、排料图同一份开料账） */
  leftovers: Leftover[];
  /** 项目档案版本，旧数据读取时据此升级补全 */
  schemaVersion: number;
  updatedAt: number;
}

export interface Placement {
  key: string;
  partId: string;
  instance: number;
  stockId: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotated: boolean;
  manual: boolean;
  /** 排在哪块余料上（sheetIndex 为 -1 时有效） */
  leftoverId?: string;
  sheetKind?: SheetKind;
}

export type SheetKind = 'full' | 'leftover';

export interface SheetLayout {
  key: string;
  kind: SheetKind;
  stockId: string;
  /** 整板序号；余料排料图固定为 -1 */
  sheetIndex: number;
  leftoverId?: string;
  stock: StockSheet;
  /** 排料图名称（整板名 / 余料编号） */
  name: string;
  length: number;
  width: number;
  placements: Placement[];
  usedArea: number;
  usableArea: number;
  wasteArea: number;
}

export interface NestingResult {
  layouts: SheetLayout[];
  placements: Placement[];
  totalParts: number;
  placedParts: number;
  unplaced: Array<{ partId: string; instance: number; reason: string }>;
  usedArea: number;
  sheetArea: number;
  utilization: number;
  wasteArea: number;
  purchaseCost: number;
  sheetCount: number;
  elapsedMs: number;
  collisions: string[];
  /** 本次排料消耗的余料编号 */
  usedLeftoverIds: string[];
  leftoverCount: number;
  /** 各板材排料图的缓存命中情况：hit 沿用原结果 / miss 已重算 */
  cacheByStock: Record<string, 'hit' | 'miss'>;
  recomputedStockIds: string[];
  reusedStockIds: string[];
  /** 排料自动固定到余料上的定位（供 store 写回 manualPositions） */
  autoPins: Array<{ key: string; manual: ManualPosition }>;
}

export interface ManualPosition {
  sheetIndex: number;
  x: number;
  y: number;
  rotated: boolean;
  /** 余料定位（自动销钉或手工拖到余料上） */
  leftoverId?: string;
  /** true = 排料自动固定的余料位；false/缺省 = 手工微调 */
  auto?: boolean;
}

