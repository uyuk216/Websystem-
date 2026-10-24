import type { FalcoAdapter } from 'platform';
import type { Db } from '../db/client.js';
import { handleSecuritySignal } from './incidents.js';
import { buildSignal } from './signals.js';
/** This collector is intentionally separate from public/admin routes. Observe mode never blocks. */
export async function ingestFalco(db: Db, adapter: FalcoAdapter, body: string, headers: { timestamp: string; nonce: string; signature: string }) {
  const event = await adapter.receive(body, headers);
  if (!event || adapter.status().mode !== 'enforce') return { observed: !!event };
  return handleSecuritySignal(db, buildSignal({ source: 'falco', sourceEventId: event.eventId, ruleVersion: '1', occurredAt: event.occurredAt,
    severity: 'high', target: { kind: 'app', appId: event.appId }, reasonCode: event.rule, evidence: { rule: event.rule } }));
}

import type { MetricSample, TelemetryProvider } from 'platform';
import { DEFAULT_THRESHOLDS, validateThresholds, type Thresholds } from './thresholds.js';
export interface MetricFinding { source: 'cpu' | 'egress'; severity: 'low' | 'medium'; metric: string; value: number; threshold: number }
/** Cumulative counters are separate streams. Gaps/resets are unknown, never an attack. */
export function evaluateMetrics(input: MetricSample[], at: number, t: Thresholds = DEFAULT_THRESHOLDS): MetricFinding[] {
  validateThresholds(t);
  const ordered = input.filter(s => s.at >= at - t.windowMs - t.maxGapMs && s.at <= at).sort((a, b) => a.at - b.at);
  const anchor = ordered.findLastIndex(s => s.at <= at - t.windowMs);
  const samples = anchor < 0 ? [] : ordered.slice(anchor);
  if (samples.length < t.minSamples) return [];
  const first = samples[0]!, last = samples.at(-1)!;
  if (last.at - first.at < t.windowMs || at - last.at > t.maxGapMs) return [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!, previous = samples[i - 1];
    if (s.appId !== first.appId || ![s.at, s.cpu, s.egressBytes, s.connections, s.servedBytes].every(Number.isFinite) || s.cpu < 0 || s.cpu > 1 || Math.min(s.egressBytes, s.connections, s.servedBytes) < 0) return [];
    if (previous && (s.at <= previous.at || s.at - previous.at > t.maxGapMs || s.egressBytes < previous.egressBytes || s.servedBytes < previous.servedBytes || s.connections < previous.connections)) return [];
  }
  const result: MetricFinding[] = [];
  if (samples.every(s => s.cpu >= t.cpu)) result.push({ source: 'cpu', severity: 'low', metric: 'cpu', value: samples.reduce((n, s) => n + s.cpu, 0) / samples.length, threshold: t.cpu });
  for (const metric of ['egressBytes', 'connections', 'servedBytes'] as const) {
    const value = last[metric] - first[metric];
    if (value >= t[metric]) result.push({ source: 'egress', severity: 'medium', metric, value, threshold: t[metric] });
  }
  return result;
}
export async function collectMetrics(db: Db, provider: TelemetryProvider, history: MetricSample[], at: number, thresholds: (appId: string) => Promise<Thresholds>): Promise<number> {
  const status = provider.status();
  if (!status.installed || status.mode === 'disabled') return 0;
  const incoming = await provider.samples(); let findings = 0; let cutoff = at;
  for (const appId of new Set(incoming.map(s => s.appId))) {
    const t = await thresholds(appId); cutoff = Math.min(cutoff, at - t.windowMs - t.maxGapMs);
    const samples = [...history, ...incoming].filter(s => s.appId === appId);
    for (const finding of evaluateMetrics(samples, at, t)) {
      findings++;
      if (status.mode !== 'enforce') continue;
      await handleSecuritySignal(db, buildSignal({ source: finding.source, sourceEventId: `${appId}:${finding.metric}:${Math.floor(at / t.windowMs)}`, ruleVersion: '1', occurredAt: new Date(at), severity: finding.severity,
        target: { kind: 'app', appId }, reasonCode: `sustained.${finding.metric.toLowerCase()}`, evidence: { metric: finding.metric, value: finding.value, threshold: finding.threshold, windowSeconds: t.windowMs / 1000 } }));
    }
  }
  history.splice(0, history.length, ...[...history, ...incoming].filter(s => s.at >= cutoff && s.at <= at).slice(-100000));
  return findings;
}
