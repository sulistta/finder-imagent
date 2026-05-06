import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type LocalAgentStatus,
  type LocalJobActivityEvent,
  LocalPipelineOffice,
} from './components/LocalPipelineOffice.js';

type MetadataColumnKey = 'description' | 'category' | 'seoTitle' | 'seoDescription' | 'seoKeywords';

interface SheetPreview {
  name: string;
  headers: string[];
  samples: Record<string, string>[];
}

interface WorkbookPreview {
  workbookId: string;
  sheets: SheetPreview[];
}

interface ColumnMapping {
  sku: string;
  title: string;
  imageColumns: string[];
  metadataColumns: Partial<Record<MetadataColumnKey, string>>;
}

interface JobStatus {
  id: string;
  totals: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
  };
  currentStage: string;
  downloadable: boolean;
  state: 'queued' | 'running' | 'completed' | 'failed';
}

interface ProductResult {
  sku: string;
  status: 'completed' | 'failed' | 'skipped';
  images: string[];
  metadata: Partial<Record<MetadataColumnKey, string>>;
  sourceUrl?: string;
  validationReason: string;
}

interface Health {
  apiKeys: Array<{ id: string; label: string }>;
  models: Record<string, boolean>;
}

const metadataLabels: Record<MetadataColumnKey, string> = {
  description: 'Description',
  category: 'Category',
  seoTitle: 'SEO title',
  seoDescription: 'SEO description',
  seoKeywords: 'SEO keywords',
};

const metadataKeys = Object.keys(metadataLabels) as MetadataColumnKey[];

export default function AppLocal() {
  const [health, setHealth] = useState<Health | null>(null);
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping>({
    sku: '',
    title: '',
    imageColumns: [],
    metadataColumns: {},
  });
  const [targetImageCount, setTargetImageCount] = useState(4);
  const [maxProducts, setMaxProducts] = useState(0);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [agents, setAgents] = useState<LocalAgentStatus[]>([]);
  const [activities, setActivities] = useState<LocalJobActivityEvent[]>([]);
  const [products, setProducts] = useState<ProductResult[]>([]);
  const [message, setMessage] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void fetch('/api/health')
      .then((response) => response.json() as Promise<Health>)
      .then(setHealth)
      .catch((error: Error) => setMessage(error.message));
  }, []);

  const selectedSheet = useMemo(
    () => preview?.sheets.find((sheet) => sheet.name === selectedSheetName) ?? null,
    [preview, selectedSheetName],
  );

  const canStart =
    preview &&
    selectedSheet &&
    mapping.sku &&
    mapping.title &&
    mapping.imageColumns.length > 0 &&
    jobStatus?.state !== 'running';

  async function handleUpload(file: File): Promise<void> {
    setMessage('Reading workbook...');
    setPreview(null);
    setJobStatus(null);
    setAgents([]);
    setActivities([]);
    setProducts([]);

    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/api/workbooks/preview', { method: 'POST', body });
    if (!response.ok) throw new Error(await readError(response));
    const nextPreview = (await response.json()) as WorkbookPreview;
    setPreview(nextPreview);
    const firstSheet = nextPreview.sheets[0];
    setSelectedSheetName(firstSheet?.name ?? '');
    setMapping((current) => inferMapping(firstSheet?.headers ?? [], current));
    setMessage(`Loaded ${file.name}`);
  }

  async function startJob(): Promise<void> {
    if (!preview || !selectedSheet) return;
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workbookId: preview.workbookId,
        sheetName: selectedSheet.name,
        columnMapping: mapping,
        targetImageCount,
        writePolicy: 'fill-empty-only',
        limits: {
          maxProducts,
          maxCandidatesPerProduct: 5,
        },
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { status: JobStatus; agents: LocalAgentStatus[] };
    setJobStatus(payload.status);
    setAgents(payload.agents);
    setActivities([]);
    setProducts([]);
    connectEvents(payload.status.id);
  }

  function connectEvents(jobId: string): void {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    eventSourceRef.current = source;
    source.addEventListener('status', (event) => {
      const status = JSON.parse(event.data) as JobStatus;
      setJobStatus(status);
      if (status.state === 'completed' || status.state === 'failed') source.close();
    });
    source.addEventListener('agent', (event) => {
      const nextAgent = JSON.parse(event.data) as LocalAgentStatus;
      setAgents((current) => upsertById(current, nextAgent));
    });
    source.addEventListener('activity', (event) => {
      const activity = JSON.parse(event.data) as LocalJobActivityEvent;
      setActivities((current) => [...current.slice(-119), activity]);
    });
    source.addEventListener('product', (event) => {
      const result = JSON.parse(event.data) as ProductResult;
      setProducts((current) => [result, ...current.filter((item) => item.sku !== result.sku)]);
    });
    source.onerror = () => setMessage('SSE connection interrupted. The job continues on the backend.');
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>Localhost Image Finder</h1>
          <p>Upload a workbook, map columns, run model agents, download the filled XLSX.</p>
        </div>
        <div className="key-strip">
          {(health?.apiKeys ?? []).map((key) => (
            <span key={key.id}>{key.label}</span>
          ))}
          {health && health.apiKeys.length === 0 && <span>No API keys in .env</span>}
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel flow-panel">
          <label className="upload-box">
            <input
              type="file"
              accept=".xlsx"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void handleUpload(file).catch((error: Error) => setMessage(error.message));
              }}
            />
            <strong>Upload XLSX</strong>
            <span>{preview ? `${preview.sheets.length} sheet(s) ready` : 'Choose a workbook'}</span>
          </label>

          {selectedSheet && (
            <>
              <div className="field-row">
                <label>
                  Sheet
                  <select value={selectedSheetName} onChange={(event) => setSelectedSheetName(event.target.value)}>
                    {preview?.sheets.map((sheet) => (
                      <option key={sheet.name}>{sheet.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Target images
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={targetImageCount}
                    onChange={(event) => setTargetImageCount(Number(event.target.value))}
                  />
                </label>
                <label>
                  Limit
                  <input
                    type="number"
                    min={0}
                    value={maxProducts}
                    onChange={(event) => setMaxProducts(Number(event.target.value))}
                  />
                </label>
              </div>

              <ColumnMapper headers={selectedSheet.headers} mapping={mapping} onChange={setMapping} />

              <button
                className="primary-action"
                disabled={!canStart}
                onClick={() => void startJob().catch((error: Error) => setMessage(error.message))}
              >
                Start job
              </button>
            </>
          )}

          {message && <p className="status-line">{message}</p>}
        </div>

        <div className="panel office-panel">
          <div className="office-header">
            <div>
              <h2>API key office</h2>
              <p>Each API key seats four model agents that hand products between roles.</p>
            </div>
            {jobStatus && (
              <a
                className={`download-link ${jobStatus.downloadable ? '' : 'disabled'}`}
                href={jobStatus.downloadable ? `/api/jobs/${jobStatus.id}/download` : undefined}
              >
                Download XLSX
              </a>
            )}
          </div>
          <LocalPipelineOffice agents={agents} activities={activities} products={products} />
        </div>
      </section>

      <section className="bottom-grid">
        <ProgressPanel status={jobStatus} />
        <ResultsPanel products={products} />
        {selectedSheet && <SamplesPanel sheet={selectedSheet} />}
      </section>
    </main>
  );
}

function ColumnMapper({
  headers,
  mapping,
  onChange,
}: {
  headers: string[];
  mapping: ColumnMapping;
  onChange: (mapping: ColumnMapping) => void;
}) {
  return (
    <div className="mapper">
      <SelectField label="SKU" headers={headers} value={mapping.sku} onChange={(sku) => onChange({ ...mapping, sku })} />
      <SelectField
        label="Product name"
        headers={headers}
        value={mapping.title}
        onChange={(title) => onChange({ ...mapping, title })}
      />
      <label className="stacked">
        Image URL columns
        <select
          multiple
          value={mapping.imageColumns}
          onChange={(event) =>
            onChange({
              ...mapping,
              imageColumns: Array.from(event.currentTarget.selectedOptions).map((option) => option.value),
            })
          }
        >
          {headers.map((header) => (
            <option key={header}>{header}</option>
          ))}
        </select>
      </label>
      <div className="metadata-grid">
        {metadataKeys.map((key) => (
          <SelectField
            key={key}
            label={metadataLabels[key]}
            headers={headers}
            optional
            value={mapping.metadataColumns[key] ?? ''}
            onChange={(value) =>
              onChange({
                ...mapping,
                metadataColumns: { ...mapping.metadataColumns, [key]: value || undefined },
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function SelectField({
  label,
  headers,
  value,
  optional = false,
  onChange,
}: {
  label: string;
  headers: string[];
  value: string;
  optional?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {optional && <option value="">Not mapped</option>}
        {!optional && <option value="">Select...</option>}
        {headers.map((header) => (
          <option key={header}>{header}</option>
        ))}
      </select>
    </label>
  );
}

function ProgressPanel({ status }: { status: JobStatus | null }) {
  const total = status?.totals.total ?? 0;
  const done = status ? status.totals.completed + status.totals.failed : 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="panel">
      <h2>Progress</h2>
      <div className="progress-track">
        <div style={{ width: `${percent}%` }} />
      </div>
      <p>{status ? `${done}/${total} rows done - ${status.currentStage}` : 'No job running'}</p>
      {status && (
        <div className="metric-row">
          <span>Completed {status.totals.completed}</span>
          <span>Failed {status.totals.failed}</span>
          <span>Pending {status.totals.pending}</span>
        </div>
      )}
    </div>
  );
}

function ResultsPanel({ products }: { products: ProductResult[] }) {
  return (
    <div className="panel results-panel">
      <h2>Product results</h2>
      <div className="result-list">
        {products.map((product) => (
          <article key={product.sku}>
            <strong>{product.sku}</strong>
            <span>{product.status}</span>
            <p>{product.validationReason}</p>
            {product.sourceUrl && <a href={product.sourceUrl}>{product.sourceUrl}</a>}
          </article>
        ))}
        {products.length === 0 && <p>No processed products yet.</p>}
      </div>
    </div>
  );
}

function SamplesPanel({ sheet }: { sheet: SheetPreview }) {
  return (
    <div className="panel samples-panel">
      <h2>Preview</h2>
      <table>
        <thead>
          <tr>
            {sheet.headers.slice(0, 6).map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.samples.slice(0, 3).map((sample, rowIndex) => (
            <tr key={rowIndex}>
              {sheet.headers.slice(0, 6).map((header) => (
                <td key={header}>{sample[header]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inferMapping(headers: string[], current: ColumnMapping): ColumnMapping {
  const find = (patterns: RegExp[]) => headers.find((header) => patterns.some((pattern) => pattern.test(header))) ?? '';
  return {
    sku: current.sku || find([/sku/i, /codigo/i, /c[oó]digo/i]),
    title: current.title || find([/descr/i, /nome/i, /produto/i, /title/i]),
    imageColumns:
      current.imageColumns.length > 0
        ? current.imageColumns
        : headers.filter((header) => /imagem|image|foto|url imagem/i.test(header)),
    metadataColumns: current.metadataColumns,
  };
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || response.statusText;
  } catch {
    return response.statusText;
  }
}
