import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import { loadLocalOfficeAssets } from '../localOfficeAssets.js';
import { activityAnimationMode } from '../localPipelineActivity.js';
import { startGameLoop } from '../office/engine/gameLoop.js';
import { OfficeState } from '../office/engine/officeState.js';
import { renderFrame } from '../office/engine/renderer.js';
import type { OfficeLayout } from '../office/types.js';
import { TILE_SIZE, TileType } from '../office/types.js';

export type ModelAgentRole = 'query' | 'ranking' | 'visual' | 'metadata';

export interface LocalAgentStatus {
  id: string;
  label: string;
  role: ModelAgentRole;
  model: string;
  apiKeyId: string;
  apiKeyLabel: string;
  groupId: string;
  state: 'idle' | 'active' | 'blocked' | 'error';
  activeProduct: string | null;
  manualAction: {
    type: 'google-captcha';
    message: string;
    url: string;
  } | null;
  counts: {
    completed: number;
    failed: number;
  };
  lastError: string | null;
}

export type JobActivityPhase =
  | 'product:start'
  | 'query:build'
  | 'ranking:search'
  | 'ranking:candidates'
  | 'visual:extract'
  | 'visual:evidence'
  | 'visual:validate'
  | 'metadata:generate'
  | 'captcha'
  | 'product:complete'
  | 'product:failed';

export interface LocalJobActivityEvent {
  id: string;
  jobId: string;
  timestamp: string;
  apiKeyId: string;
  agentId: string;
  role: ModelAgentRole;
  product?: {
    sku: string;
    title: string;
  };
  phase: JobActivityPhase;
  state: 'start' | 'progress' | 'success' | 'rejected' | 'blocked' | 'unblocked' | 'error';
  query?: string;
  candidate?: {
    url: string;
    title: string;
    snippet: string;
    reason?: string;
  };
  imageCount?: number;
  evidenceScore?: number;
  reason?: string;
  message: string;
}

interface ProductResult {
  sku: string;
  status: 'completed' | 'failed' | 'skipped';
  validationReason: string;
  sourceUrl?: string;
}

interface SceneHit {
  type: 'agent' | 'product';
  id: string;
}

interface LocalImageLabSceneProps {
  agents: LocalAgentStatus[];
  activities: LocalJobActivityEvent[];
  products: ProductResult[];
}

interface SceneRuntime {
  officeState: OfficeState;
  layout: OfficeLayout;
}

interface SceneTileBounds {
  minCol: number;
  minRow: number;
  maxCol: number;
  maxRow: number;
}

interface SceneFrame {
  zoom: number;
  panX: number;
  panY: number;
}

const sceneFitPadding = 0.96;
const sceneMinZoom = 2;
const sceneMaxZoom = 10;

const roleSeatTargets: Record<ModelAgentRole, Array<{ col: number; row: number }>> = {
  query: [{ col: 3, row: 14 }],
  ranking: [{ col: 7, row: 14 }],
  visual: [{ col: 3, row: 17 }, { col: 3, row: 19 }],
  metadata: [{ col: 7, row: 17 }, { col: 7, row: 19 }],
};

const rolePackageTiles: Record<ModelAgentRole, { col: number; row: number }> = {
  query: { col: 3, row: 13 },
  ranking: { col: 7, row: 13 },
  visual: { col: 3, row: 18 },
  metadata: { col: 7, row: 18 },
};

const phaseOrder: JobActivityPhase[] = [
  'product:start',
  'query:build',
  'ranking:search',
  'ranking:candidates',
  'visual:extract',
  'visual:evidence',
  'visual:validate',
  'metadata:generate',
  'product:complete',
  'product:failed',
];

export function LocalImageLabScene({ agents, activities, products }: LocalImageLabSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hitsRef = useRef<Array<{ hit: SceneHit; x: number; y: number; w: number; h: number }>>([]);
  const idToNumericRef = useRef(new Map<string, number>());
  const numericToIdRef = useRef(new Map<number, string>());
  const nextNumericIdRef = useRef(1);
  const latestByAgentRef = useRef(new Map<string, LocalJobActivityEvent>());
  const latestByProductRef = useRef(new Map<string, LocalJobActivityEvent>());
  const agentsRef = useRef<LocalAgentStatus[]>([]);
  const productsBySkuRef = useRef(new Map<string, ProductResult>());
  const dialoguesRef = useRef(new Map<string, string>());
  const selectedRef = useRef<SceneHit | null>(null);
  const [runtime, setRuntime] = useState<SceneRuntime | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<SceneHit | null>(null);

  const latestByAgent = useMemo(() => latestActivityByAgent(activities), [activities]);
  const latestByProduct = useMemo(() => latestActivityByProduct(activities), [activities]);
  const productsBySku = useMemo(() => new Map(products.map((product) => [product.sku, product])), [products]);
  const dialogues = useMemo(() => buildDialogues(agents, latestByAgent), [agents, latestByAgent]);

  useEffect(() => {
    let cancelled = false;
    void loadLocalOfficeAssets()
      .then(({ layout }) => {
        if (cancelled) return;
        setRuntime({ officeState: new OfficeState(layout), layout });
      })
      .catch((error: Error) => {
        if (!cancelled) setLoadError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    latestByAgentRef.current = latestByAgent;
    latestByProductRef.current = latestByProduct;
    agentsRef.current = agents;
    productsBySkuRef.current = productsBySku;
    dialoguesRef.current = dialogues;
    selectedRef.current = selected;
  }, [agents, dialogues, latestByAgent, latestByProduct, productsBySku, selected]);

  useEffect(() => {
    if (!runtime) return;
    syncAgentsToOffice(runtime.officeState, agents, latestByAgent, {
      idToNumeric: idToNumericRef.current,
      numericToId: numericToIdRef.current,
      nextNumericId: nextNumericIdRef,
    });
  }, [agents, latestByAgent, runtime]);

  useEffect(() => {
    if (!runtime) return undefined;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    const resize = () => resizeCanvas(canvas, container);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const stop = startGameLoop(canvas, {
      update: (dt) => runtime.officeState.update(dt),
      render: (ctx) => {
        const frame = sceneFrame(canvas, runtime.layout);
        const offset = renderFrame(
          ctx,
          canvas.width,
          canvas.height,
          runtime.officeState.tileMap,
          runtime.officeState.furniture,
          [...runtime.officeState.characters.values()],
          frame.zoom,
          frame.panX,
          frame.panY,
          {
            selectedAgentId: selectedRef.current?.type === 'agent'
              ? idToNumericRef.current.get(selectedRef.current.id) ?? null
              : null,
            hoveredAgentId: null,
            hoveredTile: null,
            seats: runtime.officeState.seats,
            characters: runtime.officeState.characters,
          },
          undefined,
          runtime.layout.tileColors,
          runtime.layout.cols,
          runtime.layout.rows,
        );
        hitsRef.current = [];
        drawProductPackages(
          ctx,
          latestByProductRef.current,
          productsBySkuRef.current,
          selectedRef.current,
          offset,
          frame.zoom,
          hitsRef.current,
          performance.now(),
        );
        drawTextBubbles(
          ctx,
          runtime.officeState,
          numericToIdRef.current,
          dialoguesRef.current,
          agentsRef.current,
          offset,
          frame.zoom,
          hitsRef.current,
        );
      },
    });

    return () => {
      observer.disconnect();
      stop();
    };
  }, [runtime]);

  if (loadError) {
    return <div className="local-scene-state">Failed to load office assets: {loadError}</div>;
  }

  if (!runtime) {
    return <div className="local-scene-state">Loading image lab...</div>;
  }

  return (
    <div className="local-image-lab">
      <div ref={containerRef} className="local-image-lab-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="local-image-lab-canvas"
          onClick={(event) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) * (canvas.width / rect.width);
            const y = (event.clientY - rect.top) * (canvas.height / rect.height);
            const hit = hitsRef.current.find(
              (candidate) =>
                x >= candidate.x &&
                x <= candidate.x + candidate.w &&
                y >= candidate.y &&
                y <= candidate.y + candidate.h,
            );
            setSelected(hit?.hit ?? null);
          }}
        />
      </div>
      <SceneDetails
        selected={selected}
        agents={agents}
        latestByAgent={latestByAgent}
        latestByProduct={latestByProduct}
        productsBySku={productsBySku}
      />
    </div>
  );
}

function syncAgentsToOffice(
  officeState: OfficeState,
  agents: LocalAgentStatus[],
  latestByAgent: Map<string, LocalJobActivityEvent>,
  maps: {
    idToNumeric: Map<string, number>;
    numericToId: Map<number, string>;
    nextNumericId: MutableRefObject<number>;
  },
): void {
  const incomingIds = new Set(agents.map((agent) => agent.id));
  for (const [id, numericId] of maps.idToNumeric) {
    if (incomingIds.has(id)) continue;
    officeState.removeAgent(numericId);
    maps.idToNumeric.delete(id);
    maps.numericToId.delete(numericId);
  }

  for (const agent of agents) {
    let numericId = maps.idToNumeric.get(agent.id);
    if (numericId === undefined) {
      numericId = maps.nextNumericId.current;
      maps.nextNumericId.current += 1;
      maps.idToNumeric.set(agent.id, numericId);
      maps.numericToId.set(numericId, agent.id);
      const preferredSeatId = findPreferredSeat(officeState, agent.role);
      officeState.addAgent(numericId, undefined, undefined, preferredSeatId ?? undefined);
    }

    const activity = latestByAgent.get(agent.id);
    const mode = activityAnimationMode(agent, activity);
    officeState.setAgentActive(numericId, mode === 'typing' || mode === 'reading');
    officeState.setAgentTool(numericId, mode === 'reading' ? readingToolForRole(agent.role) : 'Write');
    officeState.clearPermissionBubble(numericId);
  }
}

function findPreferredSeat(officeState: OfficeState, role: ModelAgentRole): string | null {
  for (const target of roleSeatTargets[role]) {
    for (const [seatId, seat] of officeState.seats) {
      if (!seat.assigned && seat.seatCol === target.col && seat.seatRow === target.row) {
        return seatId;
      }
    }
  }
  return null;
}

function readingToolForRole(role: ModelAgentRole): string {
  if (role === 'ranking') return 'WebSearch';
  if (role === 'visual') return 'WebFetch';
  return 'Read';
}

function resizeCanvas(canvas: HTMLCanvasElement, container: HTMLDivElement): void {
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}

function sceneFrame(canvas: HTMLCanvasElement, layout: OfficeLayout): SceneFrame {
  const bounds = visibleTileBounds(layout);
  const contentCols = Math.max(1, bounds.maxCol - bounds.minCol + 1);
  const contentRows = Math.max(1, bounds.maxRow - bounds.minRow + 1);
  const fitZoom = Math.min(
    canvas.width / (contentCols * TILE_SIZE),
    canvas.height / (contentRows * TILE_SIZE),
  ) * sceneFitPadding;
  const zoom = clampZoom(fitZoom);
  const fullCenterX = (layout.cols * TILE_SIZE * zoom) / 2;
  const fullCenterY = (layout.rows * TILE_SIZE * zoom) / 2;
  const contentCenterX = ((bounds.minCol + bounds.maxCol + 1) * TILE_SIZE * zoom) / 2;
  const contentCenterY = ((bounds.minRow + bounds.maxRow + 1) * TILE_SIZE * zoom) / 2;
  return {
    zoom,
    panX: Math.round(fullCenterX - contentCenterX),
    panY: Math.round(fullCenterY - contentCenterY),
  };
}

function visibleTileBounds(layout: OfficeLayout): SceneTileBounds {
  let minCol = layout.cols;
  let minRow = layout.rows;
  let maxCol = -1;
  let maxRow = -1;
  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      if (layout.tiles[row * layout.cols + col] === TileType.VOID) continue;
      minCol = Math.min(minCol, col);
      minRow = Math.min(minRow, row);
      maxCol = Math.max(maxCol, col);
      maxRow = Math.max(maxRow, row);
    }
  }
  if (maxCol < 0 || maxRow < 0) {
    return { minCol: 0, minRow: 0, maxCol: Math.max(0, layout.cols - 1), maxRow: Math.max(0, layout.rows - 1) };
  }
  return { minCol, minRow, maxCol, maxRow };
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return sceneMinZoom;
  return Math.max(sceneMinZoom, Math.min(sceneMaxZoom, Math.round(value)));
}

function buildDialogues(
  agents: LocalAgentStatus[],
  latestByAgent: Map<string, LocalJobActivityEvent>,
): Map<string, string> {
  const dialogues = new Map<string, string>();
  for (const agent of agents) {
    const activity = latestByAgent.get(agent.id);
    if (agent.manualAction) {
      dialogues.set(agent.id, agent.manualAction.message);
    } else if (agent.lastError) {
      dialogues.set(agent.id, `Erro: ${agent.lastError}`);
    } else if (activity?.message) {
      dialogues.set(agent.id, activity.message);
    } else if (agent.activeProduct) {
      dialogues.set(agent.id, `Trabalhando em ${agent.activeProduct}`);
    } else {
      dialogues.set(agent.id, 'Aguardando proximo produto.');
    }
  }
  return dialogues;
}

function drawTextBubbles(
  ctx: CanvasRenderingContext2D,
  officeState: OfficeState,
  numericToId: Map<number, string>,
  dialogues: Map<string, string>,
  agents: LocalAgentStatus[],
  offset: { offsetX: number; offsetY: number },
  zoom: number,
  hits: Array<{ hit: SceneHit; x: number; y: number; w: number; h: number }>,
): void {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const ch of officeState.characters.values()) {
    const agentId = numericToId.get(ch.id);
    if (!agentId) continue;
    const agent = byId.get(agentId);
    const text = dialogues.get(agentId) ?? 'Aguardando proximo produto.';
    const x = offset.offsetX + ch.x * zoom;
    const y = offset.offsetY + ch.y * zoom - 54 * zoom;
    drawPixelBubble(ctx, x, y, text, agent?.state ?? 'idle', zoom);
    hits.push({
      hit: { type: 'agent', id: agentId },
      x: offset.offsetX + (ch.x - 10) * zoom,
      y: offset.offsetY + (ch.y - 32) * zoom,
      w: 20 * zoom,
      h: 36 * zoom,
    });
  }
}

function drawPixelBubble(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  bottomY: number,
  text: string,
  state: LocalAgentStatus['state'],
  zoom: number,
): void {
  const fontSize = Math.max(12, Math.round(5 * zoom));
  ctx.font = `${fontSize}px "FS Pixel Sans", monospace`;
  const lines = wrapText(ctx, text, 150 * (zoom / 2), 3);
  const width = Math.max(74 * (zoom / 2), Math.min(180 * (zoom / 2), maxLineWidth(ctx, lines) + 18));
  const lineHeight = fontSize + 2;
  const height = lines.length * lineHeight + 12;
  const x = Math.round(centerX - width / 2);
  const y = Math.round(bottomY - height);
  ctx.fillStyle = state === 'blocked' ? '#fff0c0' : state === 'error' ? '#ffd4dc' : '#fff8dc';
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = state === 'blocked' ? '#ff8d14' : state === 'error' ? '#d14249' : '#0a0a14';
  ctx.lineWidth = Math.max(2, Math.round(zoom / 2));
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = '#0a0a14';
  lines.forEach((line, index) => {
    ctx.fillText(line, x + 9, y + 9 + fontSize + index * lineHeight);
  });
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillRect(Math.round(centerX - 4), y + height - 1, 8, Math.max(4, Math.round(zoom * 2)));
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length > 0 && lines.length === maxLines) {
    const last = lines[lines.length - 1];
    if (last && text.length > lines.join(' ').length) {
      lines[lines.length - 1] = `${last.replace(/[.,;:!?]*$/, '')}...`;
    }
  }
  return lines.length > 0 ? lines : ['Aguardando.'];
}

function maxLineWidth(ctx: CanvasRenderingContext2D, lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
}

function drawProductPackages(
  ctx: CanvasRenderingContext2D,
  latestByProduct: Map<string, LocalJobActivityEvent>,
  productsBySku: Map<string, ProductResult>,
  selected: SceneHit | null,
  offset: { offsetX: number; offsetY: number },
  zoom: number,
  hits: Array<{ hit: SceneHit; x: number; y: number; w: number; h: number }>,
  now: number,
): void {
  for (const [sku, activity] of latestByProduct) {
    const result = productsBySku.get(sku);
    const tile = packageTileForActivity(activity);
    const wobble = activity.state === 'rejected' ? Math.sin(now / 90) * 2 * zoom : 0;
    const x = offset.offsetX + (tile.col * TILE_SIZE + TILE_SIZE / 2) * zoom;
    const y = offset.offsetY + (tile.row * TILE_SIZE + TILE_SIZE / 2) * zoom + wobble;
    const w = 14 * zoom;
    const h = 9 * zoom;
    const done = activity.phase === 'product:complete' || result?.status === 'completed';
    const failed = activity.phase === 'product:failed' || result?.status === 'failed';
    ctx.fillStyle = failed ? '#d14249' : done ? '#89d185' : activity.state === 'rejected' ? '#ffb257' : '#7aa2ff';
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.strokeStyle = selected?.type === 'product' && selected.id === sku ? '#ffffff' : '#0a0a14';
    ctx.lineWidth = Math.max(2, Math.round(zoom / 2));
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(x - w / 4, y - h / 2 - 2 * zoom, w / 2, 2 * zoom);
    hits.push({ hit: { type: 'product', id: sku }, x: x - w, y: y - h, w: w * 2, h: h * 2 });
  }
}

function packageTileForActivity(activity: LocalJobActivityEvent): { col: number; row: number } {
  if (activity.phase === 'product:complete') return { col: 15, row: 15 };
  if (activity.phase === 'product:failed') return { col: 2, row: 20 };
  const phaseIndex = phaseOrder.indexOf(activity.phase);
  if (phaseIndex >= phaseOrder.indexOf('ranking:search') && phaseIndex < phaseOrder.indexOf('visual:extract')) {
    return rolePackageTiles.ranking;
  }
  if (phaseIndex >= phaseOrder.indexOf('visual:extract') && phaseIndex < phaseOrder.indexOf('metadata:generate')) {
    return rolePackageTiles.visual;
  }
  if (phaseIndex >= phaseOrder.indexOf('metadata:generate')) return rolePackageTiles.metadata;
  return rolePackageTiles.query;
}

function SceneDetails({
  selected,
  agents,
  latestByAgent,
  latestByProduct,
  productsBySku,
}: {
  selected: SceneHit | null;
  agents: LocalAgentStatus[];
  latestByAgent: Map<string, LocalJobActivityEvent>;
  latestByProduct: Map<string, LocalJobActivityEvent>;
  productsBySku: Map<string, ProductResult>;
}) {
  if (!selected) {
    return <div className="pipeline-details">Clique em um agente ou pacote para ver o historico do passo atual.</div>;
  }
  if (selected.type === 'agent') {
    const agent = agents.find((item) => item.id === selected.id);
    const activity = latestByAgent.get(selected.id);
    if (!agent) return <div className="pipeline-details">Agente nao encontrado.</div>;
    return (
      <div className="pipeline-details">
        <strong>{agent.label}</strong>
        <span>{agent.model}</span>
        <span>{activity ? `${activity.phase} - ${activity.state}` : agent.state}</span>
        <span>{activity?.message ?? agent.activeProduct ?? 'Aguardando proximo produto.'}</span>
        {agent.manualAction && <a href={agent.manualAction.url}>{agent.manualAction.message}</a>}
        {agent.lastError && <small>{agent.lastError}</small>}
      </div>
    );
  }
  const result = productsBySku.get(selected.id);
  const activity = latestByProduct.get(selected.id);
  return (
    <div className="pipeline-details">
      <strong>{selected.id}</strong>
      <span>{activity ? `${activity.phase} - ${activity.state}` : result?.status}</span>
      <span>{activity?.message ?? result?.validationReason ?? 'Sem detalhes ainda.'}</span>
      {activity?.candidate && <a href={activity.candidate.url}>{activity.candidate.title || activity.candidate.url}</a>}
      {result?.sourceUrl && <a href={result.sourceUrl}>{result.sourceUrl}</a>}
    </div>
  );
}

function latestActivityByAgent(activities: LocalJobActivityEvent[]): Map<string, LocalJobActivityEvent> {
  const byAgent = new Map<string, LocalJobActivityEvent>();
  for (const activity of activities) byAgent.set(activity.agentId, activity);
  return byAgent;
}

function latestActivityByProduct(activities: LocalJobActivityEvent[]): Map<string, LocalJobActivityEvent> {
  const byProduct = new Map<string, LocalJobActivityEvent>();
  for (const activity of activities) {
    if (activity.product?.sku) byProduct.set(activity.product.sku, activity);
  }
  return byProduct;
}
