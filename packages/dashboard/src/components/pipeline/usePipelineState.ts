import { useState, useCallback } from 'react';
import type { PipelineUpdate, PipelineStage } from '../../../server/types.js';

export const PIPELINE_STAGES = [
  'discover',
  'analyze',
  'plan',
  'implement',
  'validate',
  'fix',
  'review',
  'ship',
] as const;

export type StageName = (typeof PIPELINE_STAGES)[number];

export interface PipelineState {
  pipeline: PipelineUpdate | null;
  selectedStage: number | null;
  expandedRepos: Set<string>;
}

export function usePipelineState() {
  const [pipeline, setPipeline] = useState<PipelineUpdate | null>(null);
  const [selectedStage, setSelectedStage] = useState<number | null>(null);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());

  const toggleRepo = useCallback((repo: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }, []);

  const getStageStatus = useCallback((index: number): PipelineStage['status'] => {
    if (!pipeline) return 'pending';
    return pipeline.stages[index]?.status ?? 'pending';
  }, [pipeline]);

  const getOverallProgress = useCallback((): number => {
    return pipeline?.overallProgress ?? 0;
  }, [pipeline]);

  return {
    pipeline,
    setPipeline,
    selectedStage,
    setSelectedStage,
    expandedRepos,
    toggleRepo,
    getStageStatus,
    getOverallProgress,
    stages: PIPELINE_STAGES,
  };
}

export default usePipelineState;
