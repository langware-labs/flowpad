import {
  AnchoredSurface,
  buildIssueTrack,
  buildTraceTrack,
  useReactMarkdownAnchor,
} from '@src/components/anchored-markdown';
import { cn } from '@src/lib/utils';
import { AgenticProcess, FSRef, Workflow, dataContext } from '@sdk';
import { parseClaudeTranscriptUsage } from '@sdk/transcript-analyzer';
import { useEffect, useMemo, useState } from 'react';

import { extractStepLines, reduceAnalysis } from './reduceAnalysis';
import { reduceTraceEvents } from './reduceTraceEvents';

interface AnnotatedTraceViewProps {
  workflow: Workflow;
  process: AgenticProcess;
}

/**
 * Composes the AnchoredSurface with a TraceTrack (left) and IssueTrack (right)
 * for one workflow runner. Reads:
 *   - workflow markdown source via workflow.doc
 *   - workflow.trace.jsonl + workflow.analysis.jsonl from process.output_folder
 *
 * Body never reflows when switching processes — the workflow source is stable
 * across runs of the same workflow. Track contents fade between runs (handled
 * via opacity transition wrapper in the parent).
 */
export function AnnotatedTraceView({ workflow, process }: AnnotatedTraceViewProps) {
  const [source, setSource] = useState<string>('');
  const [trace, setTrace] = useState<string>('');
  const [analysis, setAnalysis] = useState<string>('');
  const [transcript, setTranscript] = useState<string>('');

  // Load the workflow markdown body once per workflow id.
  useEffect(() => {
    let cancelled = false;
    const doc = workflow.doc;
    if (!doc) {
      setSource('');
      return;
    }
    void doc.read().then((text) => {
      if (!cancelled) setSource(text);
    }).catch(() => {
      if (!cancelled) setSource('');
    });
    return () => { cancelled = true; };
  }, [workflow.id, workflow.doc]);

  // Load trace + analysis per process.
  useEffect(() => {
    let cancelled = false;
    const out = process.output_folder;
    const computeNodeId = dataContext.computeNodeTypeId;
    if (!out?.path || !computeNodeId) {
      setTrace('');
      setAnalysis('');
      return;
    }
    const traceRef = new FSRef(`${out.path}/workflow.trace.jsonl`, computeNodeId);
    const analysisRef = new FSRef(`${out.path}/workflow.analysis.jsonl`, computeNodeId);
    void traceRef.read().then((t) => { if (!cancelled) setTrace(t); }).catch(() => { if (!cancelled) setTrace(''); });
    void analysisRef.read().then((a) => { if (!cancelled) setAnalysis(a); }).catch(() => { if (!cancelled) setAnalysis(''); });
    return () => { cancelled = true; };
  }, [process.id, process.output_folder?.path]);

  // Load transcript JSONL via process.session_id + project_encoded_name.
  // ${homeDir}/.claude/projects/${project_encoded_name}/${session_id}.jsonl
  // Per-anchor cost is then derived in reduceTraceEvents by pairing the
  // (startedAt, endedAt) window with usage entries' timestamps.
  const sessionId = (process as unknown as { session_id?: string | null }).session_id ?? null;
  const projectEnc = (process as unknown as { project_encoded_name?: string | null }).project_encoded_name ?? null;
  useEffect(() => {
    let cancelled = false;
    const computeNodeId = dataContext.computeNodeTypeId;
    const homeDir = dataContext.computeNode?.home_dir;
    if (!sessionId || !projectEnc || !computeNodeId || !homeDir) {
      setTranscript('');
      return;
    }
    const path = `${homeDir.replace(/\/$/, '')}/.claude/projects/${projectEnc}/${sessionId}.jsonl`.replace(/^\//, '');
    const ref = new FSRef(path, computeNodeId);
    void ref.read().then((t) => { if (!cancelled) setTranscript(t); }).catch(() => { if (!cancelled) setTranscript(''); });
    return () => { cancelled = true; };
  }, [process.id, sessionId, projectEnc]);

  const usage = useMemo(() => (transcript ? parseClaudeTranscriptUsage(transcript) : []), [transcript]);
  const traceItems = useMemo(() => reduceTraceEvents(trace, usage), [trace, usage]);
  const stepLines = useMemo(() => extractStepLines(source), [source]);
  const issueItems = useMemo(() => reduceAnalysis(analysis, stepLines), [analysis, stepLines]);

  const { body, provider } = useReactMarkdownAnchor(source);

  const traceTrack = useMemo(() => buildTraceTrack(traceItems), [traceItems]);
  const issueTrack = useMemo(() => buildIssueTrack(issueItems), [issueItems]);

  return (
    <AnchoredSurface
      provider={provider}
      leftTracks={[traceTrack]}
      rightTracks={[issueTrack]}
      className={cn('transition-opacity duration-150')}
    >
      {body}
    </AnchoredSurface>
  );
}
