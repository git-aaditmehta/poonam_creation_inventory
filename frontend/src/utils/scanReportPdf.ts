/**
 * Visual search TEST report (PDF) — testing phase only.
 * Data-only: accuracy summary, latency, token usage and per-scan diagnostics. No photos.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { JewelryAttributes } from '../types';
import { estimateNeurons, NEURON_RATES, summarize, type LatencyStats, type ScanTestRecord } from '../lib/scanTestLog';

const ATTRIBUTE_FIELDS: (keyof JewelryAttributes)[] = [
  'category',
  'structure',
  'outline_shape',
  'center_stone_color',
  'center_stone_shape',
  'accent_colors',
  'enamel_color',
  'jhumka_count',
  'stone_layout',
  'main_stone_type',
  'motif',
  'has_pearls',
  'has_hanging_beads',
  'has_cz_border',
  'metal_tone',
];

const OUTCOME_LABEL: Record<ScanTestRecord['outcome'], string> = {
  unmarked: 'Not marked',
  found: 'Found',
  not_in_top6: 'Not in top 6',
  true_reject: 'Correctly rejected',
  false_reject: 'Wrongly rejected',
  false_accept: 'Non-catalog object matched',
  error: 'Error',
};

const pct = (n: number, d: number) => (d > 0 ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : '-');
const ms = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v)} ms` : '-');
const num = (v: number | null | undefined, digits = 3) => (typeof v === 'number' ? v.toFixed(digits) : '-');

function attrValue(a: JewelryAttributes | null | undefined, key: string): string {
  if (!a) return '';
  const v = (a as unknown as Record<string, unknown>)[key];
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `${k}=${String(x)}`)
      .join('; ');
  }
  return String(v);
}

/** Preferred order first, then any other (v3 category-specific) fields present on either side. */
function attributeFields(...sources: (JewelryAttributes | null | undefined)[]): string[] {
  const seen = new Set<string>(ATTRIBUTE_FIELDS);
  const extra: string[] = [];
  for (const a of sources) {
    if (!a) continue;
    for (const k of Object.keys(a)) {
      if (k === 'is_jewelry' || seen.has(k)) continue;
      seen.add(k);
      extra.push(k);
    }
  }
  return [...ATTRIBUTE_FIELDS, ...extra];
}

function outcomeText(r: ScanTestRecord): string {
  if (r.outcome === 'found' && r.selection?.rank) return `Found at #${r.selection.rank}`;
  return OUTCOME_LABEL[r.outcome];
}

/**
 * variant 'llama' = cloud Llama + BGE section (default, unchanged)
 * variant 'dino'  = on-device DINOv2 section (no tokens/neurons/attributes/rejections; adds on-device timings)
 */
export function generateScanTestReport(records: ScanTestRecord[], variant: 'llama' | 'dino' = 'llama'): void {
  const isDino = variant === 'dino';
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 36;
  const s = summarize(records);
  let y = margin;

  const nextY = (gap = 14) => ((doc as any).lastAutoTable?.finalY ?? y) + gap;
  const heading = (text: string, size = 13) => {
    if (y > doc.internal.pageSize.getHeight() - 80) {
      doc.addPage();
      y = margin;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.text(text, margin, y);
    y += size + 4;
  };
  const table = (head: string[][] | undefined, body: (string | number)[][], opts: Record<string, unknown> = {}) => {
    autoTable(doc, {
      startY: y,
      head,
      body,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [30, 74, 96], textColor: 255 },
      theme: 'grid',
      ...opts,
    });
    y = nextY();
  };

  // ── Title ──
  const versions = Array.from(new Set(records.map((r) => r.prompt_version || 'unknown'))).join(', ');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(isDino ? 'Visual Search Test Report - On-device DINOv2' : 'Visual Search Test Report', margin, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const first = records[0]?.ts ? new Date(records[0].ts).toLocaleString() : '-';
  const last = records[records.length - 1]?.ts ? new Date(records[records.length - 1].ts).toLocaleString() : '-';
  doc.text(`Generated: ${new Date().toLocaleString()}   |   Scans: ${first} to ${last}`, margin, y);
  y += 12;
  doc.text(
    isDino
      ? `Pipeline: DINOv2-small (ONNX fp32) on the device, 224px padded square, CLS 384 -> Vectorize   |   Model version(s): ${versions}`
      : `Pipeline: Llama 3.2 11B Vision (JSON) + BGE-small 384   |   Prompt version(s): ${versions}`,
    margin,
    y
  );
  y += 12;
  doc.text(`Device: ${navigator.userAgent.slice(0, 120)}`, margin, y);
  y += 16;

  // ── Accuracy ──
  heading('1. Accuracy');
  table(
    [['Metric', 'Result', 'Notes']],
    [
      ['Total scans', s.total, `${s.marked} marked, ${s.unmarked} not marked, ${s.errors} errors`],
      ['Catalog scans with known answer', s.catalogScans, isDino ? 'Found + Not in top 6' : 'Found + Not in top 6 + Wrongly rejected'],
      ['Rank #1', pct(s.rank1, s.catalogScans), 'Correct item was the first result'],
      ['Top 3', pct(s.top3, s.catalogScans), ''],
      ['Top 6', pct(s.top6, s.catalogScans), ''],
      ['Not in top 6', s.notInTop6, ''],
      ...(isDino
        ? []
        : [
            ['Wrongly rejected (real piece called not-jewelry)', s.falseReject, ''],
            ['Correctly rejected (non-jewelry)', s.trueReject, ''],
          ]),
      [
        'Non-catalog object still matched',
        s.falseAccept,
        isDino ? 'DINO has no jewelry check; see #1 scores below to set a cut-off' : 'Should have been rejected',
      ],
      ['With category chip: rank #1 / top 6', `${pct(s.withChip.rank1, s.withChip.scans)} / ${pct(s.withChip.top6, s.withChip.scans)}`, ''],
      ['Without chip: rank #1 / top 6', `${pct(s.withoutChip.rank1, s.withoutChip.scans)} / ${pct(s.withoutChip.top6, s.withoutChip.scans)}`, ''],
    ],
    { columnStyles: { 0: { cellWidth: 200 } } }
  );

  // ── Latency ──
  heading('2. Latency');
  const latRow = (label: string, l: LatencyStats) => [label, ms(l.avg), ms(l.median), ms(l.p95), ms(l.max)];
  table(
    [['Stage', 'Average', 'Median', 'P95', 'Max']],
    isDino
      ? [
          latRow('Phone round trip (tap to results)', s.latency.roundTrip),
          latRow('On device: prepare photo', s.latency.preprocess),
          latRow('On device: DINOv2 model', s.latency.inference),
          latRow('Server search total', s.latency.serverTotal),
          latRow('Vectorize query', s.latency.vectorize),
          latRow('Model load, first time (download + start)', s.latency.modelLoadFirst),
          latRow('Model load, from phone cache', s.latency.modelLoadCached),
        ]
      : [
          latRow('Phone round trip (tap to results)', s.latency.roundTrip),
          latRow('Server pipeline total', s.latency.serverTotal),
          latRow('Vision (Llama)', s.latency.vision),
          latRow('Embedding (BGE)', s.latency.embedding),
          latRow('Vectorize query', s.latency.vectorize),
        ]
  );

  // ── Diagnostics ──
  heading('3. Diagnostics');
  table(
    [['Metric', 'Value']],
    [
      ...(isDino
        ? [
            ['Compute on device', `GPU (WebGPU): ${s.backends.webgpu} scans, CPU (WASM): ${s.backends.wasm} scans`],
            ['Workers AI neurons used', '0 (the model runs on the device)'],
          ]
        : [
            ['Avg vision prompt tokens (image + prompt)', num(s.avgPromptTokens, 0)],
            ['Avg vision output tokens', num(s.avgCompletionTokens, 0)],
            ['Scans that needed a JSON retry', s.retries],
          ]),
      ...(isDino ? [] : [['Close calls (#1 and #2 within 0.03)', `${s.closeCalls.total} (#1 was right in ${s.closeCalls.top1Correct})`]]),
      ['Avg #1 score when #1 was correct', num(s.top1ScoreWhenCorrect)],
      ['Avg #1 score when #1 was wrong', num(s.top1ScoreWhenWrong)],
      ['Avg score of the correct item', num(s.avgCorrectItemScore)],
    ],
    { columnStyles: { 0: { cellWidth: 260 } } }
  );

  // ── Attribute reliability (Llama only): which fields the model gets wrong between photo and catalog ──
  if (!isDino && Object.keys(s.fieldAgreement).length) {
    heading('3b. Attribute agreement (phone photo vs correct item)');
    table(
      [['Attribute', 'Compared', 'Agreed', 'Agreement']],
      Object.entries(s.fieldAgreement)
        .sort((a, b) => a[1].agreed / a[1].compared - b[1].agreed / b[1].compared)
        .map(([k, v]) => [k, v.compared, v.agreed, pct(v.agreed, v.compared)]),
      { columnStyles: { 0: { cellWidth: 160 } } }
    );
  }

  // ── AI usage (neurons) — Llama only ──
  const n = s.neurons;
  if (!isDino) heading('4. AI usage (neurons, estimated)');
  if (!isDino) table(
    [['Metric', 'Value']],
    [
      ['Scans with token counts', `${n.scansWithTokens} of ${s.total}${n.scansWithoutTokens ? ` (${n.scansWithoutTokens} had no token data)` : ''}`],
      ['Total neurons this session', num(n.total, 1)],
      ['Share of daily free allocation (10,000)', `${(n.shareOfDailyFree * 100).toFixed(1)}%`],
      ['Neurons per scan: average / median / max', `${num(n.avg, 1)} / ${num(n.median, 1)} / ${num(n.max, 1)}`],
      ['Scans per day within the free allocation', n.scansPerDayFree ?? '-'],
      [
        'How this is calculated',
        `Vision tokens reported by the model x published rates: input ${NEURON_RATES.visionInputPerMillion} and output ${NEURON_RATES.visionOutputPerMillion} neurons per million tokens. Embedding (${NEURON_RATES.embeddingInputPerMillion}/M) estimated from text length. Includes retries and failed scans. Re-indexing is not included. Cross-check against the Cloudflare dashboard.`,
      ],
    ],
    { columnStyles: { 0: { cellWidth: 200 } } }
  );

  // ── Overview ──
  heading(isDino ? '4. All scans' : '5. All scans');
  const overviewHead = ['#', 'Time', 'Chip', 'Outcome', 'Correct item', 'Its score', '#1 result', '#1 score', 'Total'];
  if (!isDino) overviewHead.push('Neurons');
  table(
    [overviewHead],
    records.map((r) => [
      r.n,
      new Date(r.ts).toLocaleTimeString(),
      r.category_filter || '-',
      outcomeText(r),
      r.selection?.item_id || '-',
      num(r.selection?.score),
      r.matches[0]?.item_id || '-',
      num(r.matches[0]?.score),
      ms(r.client_round_trip_ms),
      ...(isDino ? [] : [num(estimateNeurons(r)?.total, 1)]),
    ])
  );

  // ── Per-scan details ──
  doc.addPage();
  y = margin;
  heading(isDino ? '5. Scan details' : '6. Scan details');
  for (const r of records) {
    heading(`Scan #${r.n}  -  ${outcomeText(r)}${r.category_filter ? `  -  chip: ${r.category_filter}` : ''}`, 10);
    const info: (string | number)[][] = isDino
      ? [
          ['Time / source', `${new Date(r.ts).toLocaleString()} / ${r.source}`],
          ['Photo used', `${r.image.width}x${r.image.height} (padded to a square, scaled to 224x224 on the device)`],
          [
            'Latency',
            `round trip ${ms(r.client_round_trip_ms)} | prepare ${ms(r.telemetry.preprocess_ms)} | model ${ms(r.telemetry.inference_ms)} | server ${ms(r.telemetry.total_pipeline_ms)} | vectorize ${ms(r.telemetry.vectorize_ms)} | db ${ms(r.telemetry.db_ms)}`,
          ],
          [
            'Device',
            `${r.telemetry.compute_backend === 'webgpu' ? 'GPU (WebGPU)' : r.telemetry.compute_backend === 'wasm' ? 'CPU (WASM)' : '-'}${
              typeof r.telemetry.model_load_ms === 'number'
                ? ` | model load ${ms(r.telemetry.model_load_ms)} (${r.telemetry.model_from_cache ? 'from phone cache' : `downloaded in ${ms(r.telemetry.model_download_ms)}`})`
                : ''
            }`,
          ],
        ]
      : [
      ['Time / source', `${new Date(r.ts).toLocaleString()} / ${r.source}`],
      ['Image sent', `${r.image.width}x${r.image.height}, ${Math.round(r.image.bytes / 1024)} KB`],
      [
        'Latency',
        `round trip ${ms(r.client_round_trip_ms)} | vision ${ms(r.telemetry.vision_ms)} | embed ${ms(r.telemetry.embedding_ms)} | vectorize ${ms(r.telemetry.vectorize_ms)} | db ${ms(r.telemetry.db_ms)}`,
      ],
      [
        'Tokens / attempts',
        `prompt ${r.telemetry.prompt_tokens ?? '-'} | output ${r.telemetry.completion_tokens ?? '-'} | vision attempts ${r.telemetry.vision_attempts ?? '-'} | neurons ${num(estimateNeurons(r)?.total, 1)}`,
      ],
      ['Query text (embedded)', r.embedding_text || '-'],
    ];
    if (r.selection) {
      info.push([
        'Correct item',
        `${r.selection.item_id} | rank ${r.selection.rank ?? 'not in top 6'} | score ${num(r.selection.score)}${
          typeof r.selection.cosine === 'number' ? ` (cosine ${num(r.selection.cosine)}, attributes ${num(r.selection.attr_score)})` : ''
        } | ${r.selection.indexed ? 'indexed' : 'NOT INDEXED'}`,
      ]);
      if (r.selection.embedding_text) info.push(['Correct item text', r.selection.embedding_text]);
    }
    if (r.uncertain) info.push(['Close call', '#1 and #2 were within 0.03 of each other']);
    if (r.category_hint_warning) info.push(['Chip warning', r.category_hint_warning]);
    if (r.reason) info.push(['Your note', r.reason]);
    if (r.filter_warning) info.push(['Filter warning', r.filter_warning]);
    if (r.error) info.push(['Error', r.error]);
    if (!isDino && (r.error || !r.ai_attributes)) info.push(['Raw vision output', (r.raw_vision_output || '-').slice(0, 600)]);
    table(undefined, info, { columnStyles: { 0: { cellWidth: 110, fontStyle: 'bold' } } });

    if (r.ai_attributes) {
      const correct = r.selection?.attributes ?? null;
      // Show the #1 result's attributes only when #1 was not the correct item
      const top1 = r.matches[0] && r.matches[0].id !== r.selection?.id ? r.top1_attributes : null;
      const head = ['Attribute', 'Phone photo (AI)', 'Correct item (catalog)'];
      if (top1) head.push('#1 result (catalog)');
      table(
        [head],
        attributeFields(r.ai_attributes, correct, top1).map((f) => {
          const row = [f, attrValue(r.ai_attributes, f), attrValue(correct, f)];
          if (top1) row.push(attrValue(top1, f));
          return row;
        }),
        {
          didParseCell: (data: any) => {
            // Highlight attributes where the phone photo disagrees with the correct item
            if (data.section === 'body' && data.column.index === 2 && correct) {
              const q = data.row.raw[1];
              const c = data.row.raw[2];
              if (q && c && q !== c) data.cell.styles.fillColor = [253, 226, 226];
            }
          },
        }
      );
    }

    if (r.matches.length) {
      table(
        isDino ? [['Rank', 'Item', 'Score', 'Category', 'Correct?']] : [['Rank', 'Item', 'Final', 'Cosine', 'Attributes', 'Category', 'Correct?']],
        r.matches.map((m) =>
          isDino
            ? [m.rank, m.item_id, num(m.score), m.category || '-', r.selection?.id === m.id ? 'YES' : '']
            : [m.rank, m.item_id, num(m.score), num(m.cosine), num(m.attr_score), m.category || '-', r.selection?.id === m.id ? 'YES' : '']
        )
      );
    }
    y += 6;
  }

  doc.save(`${isDino ? 'dino' : 'visual-search'}-test-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pdf`);
}
