import type { NestingResult, OffcutLedger, WoodworkingProject } from '../types/woodworking';
import { formatArea } from './nesting';
import { migrateLedger, createEmptyLedger } from './offcuts';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 项目文件连同余料台账一起导出，同一份开料账整体交接 */
export function downloadProject(project: WoodworkingProject, ledger?: OffcutLedger) {
  downloadBlob(
    new Blob([JSON.stringify({ ...project, offcutLedger: ledger ?? null }, null, 2)], { type: 'application/json;charset=utf-8' }),
    `${project.name}.joinery.json`,
  );
}

export interface LoadedProjectFile {
  project: WoodworkingProject;
  ledger: OffcutLedger | null;
}

export function loadProjectFile(file: File): Promise<LoadedProjectFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as WoodworkingProject & { offcutLedger?: unknown };
        if (!Array.isArray(raw.parts) || !Array.isArray(raw.stocks)) throw new Error('文件结构不完整');
        const { offcutLedger, ...project } = raw;
        // 旧文件里的余料记录可能没有编号，载入时补成首版结构
        const ledger = offcutLedger ? migrateLedger(offcutLedger, createEmptyLedger) : null;
        resolve({ project, ledger });
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function downloadCutList(project: WoodworkingProject) {
  const rows = [
    ['零件名', '类型', '材质', '长(mm)', '宽(mm)', '厚(mm)', '数量', '纹理', '封边', '备注'],
    ...project.parts.map((part) => {
      const stock = project.stocks.find((item) => item.id === part.stockId);
      return [
        part.name,
        part.kind,
        stock?.material ?? '',
        part.length,
        part.width,
        part.thickness,
        part.quantity,
        part.grain === 'length' ? '长边顺纹' : part.grain === 'width' ? '短边顺纹' : '不限',
        part.edgeBanding,
        part.notes,
      ];
    }),
  ];
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  downloadBlob(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), `${project.name}-零件表.csv`);
}

export function downloadPurchaseList(project: WoodworkingProject, result: NestingResult) {
  const sheetLayouts = result.layouts.filter((layout) => layout.source === 'sheet');
  const offcutLayouts = result.layouts.filter((layout) => layout.source === 'offcut');
  const stockCount = new Map<string, number>();
  sheetLayouts.forEach((layout) => stockCount.set(layout.stockId, (stockCount.get(layout.stockId) ?? 0) + 1));
  const lines = [
    `项目：${project.name}`,
    `客户 / 安装位置：${project.client} / ${project.sheet}`,
    `锯缝：${project.kerf} mm，四周修边：${project.trim} mm`,
    `需新开板材：${result.sheetCount} 张，余料利用：${result.offcutCount} 块（${formatArea(result.offcutArea)}），利用率：${result.utilization.toFixed(1)}%，废料：${formatArea(result.wasteArea)}`,
    `预计材料成本：￥${result.purchaseCost.toFixed(2)}（余料不计新购成本）`,
    '',
    '新开板材：',
    ...project.stocks.map((stock) => {
      const count = stockCount.get(stock.id) ?? 0;
      return `${stock.name} | ${stock.material} | ${stock.length} × ${stock.width} × ${stock.thickness} mm | 排料需要 ${count} 张 | 单价 ￥${stock.price} | 小计 ￥${(count * stock.price).toFixed(2)}`;
    }),
    '',
    '余料利用：',
    ...(offcutLayouts.length
      ? offcutLayouts.map(
          (layout) =>
            `${layout.offcut?.code ?? ''} | ${layout.stock.name} | ${layout.boardLength} × ${layout.boardWidth} × ${layout.stock.thickness} mm | 排入 ${layout.placements.length} 件`,
        )
      : ['（本次未使用余料）']),
    '',
    '采购说明：',
    '1. 同一材质的板材应尽量同批采购，避免色差。',
    '2. 到货后按排料图标号复核尺寸、翘曲和含水率。',
    '3. 开料前先进行四面修边，按实际锯片锯缝复核尺寸。',
    '4. 门板和桌面应在恒温环境存放 48 小时后再精裁。',
  ];
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), `${project.name}-采购用料说明.txt`);
}

export function downloadNestingSvg(project: WoodworkingProject, result: NestingResult) {
  const margin = 30;
  const maxWidth = Math.max(900, ...result.layouts.map((layout) => layout.boardLength));
  let yOffset = 0;
  const pieces: string[] = [];
  result.layouts.forEach((layout) => {
    const isOffcut = layout.source === 'offcut';
    const title = isOffcut
      ? `余料 ${layout.offcut?.code ?? ''} · ${layout.stock.name}`
      : `${layout.stock.name} · 第 ${layout.sheetIndex + 1} 张`;
    pieces.push(`<text x="0" y="${yOffset + 18}" font-size="14" font-family="sans-serif" font-weight="700">${title}</text>`);
    pieces.push(`<rect x="0" y="${yOffset + 30}" width="${layout.boardLength}" height="${layout.boardWidth}" fill="${isOffcut ? '#e3efd9' : '#f5e7c8'}" stroke="${isOffcut ? '#5a8a68' : '#8b6f47'}" stroke-width="3"/>`);
    if (layout.trim > 0) {
      pieces.push(`<rect x="${layout.trim}" y="${yOffset + 30 + layout.trim}" width="${layout.boardLength - layout.trim * 2}" height="${layout.boardWidth - layout.trim * 2}" fill="none" stroke="#b79b70" stroke-dasharray="8 6"/>`);
    }
    layout.placements.forEach((placement) => {
      const part = project.parts.find((item) => item.id === placement.partId);
      pieces.push(`<rect x="${placement.x}" y="${yOffset + 30 + placement.y}" width="${placement.width}" height="${placement.height}" fill="#d8b77e" stroke="#5f4935" stroke-width="1.5"/>`);
      pieces.push(`<text x="${placement.x + 6}" y="${yOffset + 30 + placement.y + 18}" font-size="12" font-family="sans-serif">${part?.name ?? ''}</text>`);
    });
    yOffset += layout.boardWidth + 70;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maxWidth + margin * 2}" height="${yOffset + margin * 2}" viewBox="${-margin} ${-margin} ${maxWidth + margin * 2} ${yOffset + margin * 2}">
    <rect x="${-margin}" y="${-margin}" width="${maxWidth + margin * 2}" height="${yOffset + margin * 2}" fill="#fffdf8"/>
    ${pieces.join('\n')}
  </svg>`;
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${project.name}-排料图.svg`);
}
