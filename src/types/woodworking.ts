export type GrainDirection = 'length' | 'width' | 'none';
export type PartKind = '侧板' | '顶底板' | '门板' | '背板' | '搁板' | '桌腿' | '横撑' | '抽屉件';

export type JointType = '直榫' | '燕尾榫' | '搭槽' | '圆木榫' | '饼干榫' | '45°斜接';

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
  updatedAt: number;
}

export type OffcutStatus = 'available' | 'occupied';

export interface Offcut {
  /** 余料编号，入库与合并的幂等键 */
  code: string;
  /** 所属板材 */
  stockId: string;
  length: number;
  width: number;
  thickness: number;
  registeredBy: string;
  registeredAt: number;
  status: OffcutStatus;
  occupiedBy: string | null;
  occupiedAt: number | null;
  note: string;
}

export interface OffcutLedger {
  /** 台账结构版本，旧数据升级时补成首版 */
  schemaVersion: number;
  /** 余料库容量，满了以后新登记进入 pending 排队等位 */
  capacity: number;
  /** 已入库的余料，按编号唯一 */
  records: Offcut[];
  /** 容量满 / 写入失败后排队等位的记录 */
  pending: Offcut[];
  /** 断网时各工位本地暂存、等待回网合并的记录 */
  outbox: Offcut[];
  online: boolean;
  lastSyncAt: number | null;
  updatedAt: number;
}

export interface Placement {
  key: string;
  partId: string;
  instance: number;
  stockId: string;
  /** 所在板面：'sheet:{stockId}:{n}' 或 'offcut:{code}' */
  boardKey: string;
  sheetIndex: number;
  /** 排在余料上时为余料编号，新板为 null */
  offcutCode: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotated: boolean;
  manual: boolean;
}

export interface SheetLayout {
  /** 板面唯一键，与 Placement.boardKey 对应 */
  boardKey: string;
  source: 'sheet' | 'offcut';
  stockId: string;
  sheetIndex: number;
  stock: StockSheet;
  /** source 为 'offcut' 时指向对应余料 */
  offcut: Offcut | null;
  boardLength: number;
  boardWidth: number;
  /** 新板沿用项目修边，余料已是净料不再修边 */
  trim: number;
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
  /** 本次利用的余料总面积 */
  offcutArea: number;
  /** 用掉的余料块数 */
  offcutCount: number;
  utilization: number;
  wasteArea: number;
  purchaseCost: number;
  sheetCount: number;
  /** 未受改动影响、沿用上次计算结果的板材名 */
  reusedStocks: string[];
  elapsedMs: number;
  collisions: string[];
}

export interface ManualPosition {
  /** 手动拖拽时所在的板面；旧数据没有该字段时按 sheetIndex 落到新板 */
  boardKey?: string;
  sheetIndex: number;
  x: number;
  y: number;
  rotated: boolean;
}

