import { useState, useCallback } from 'react';

export type PRStatus = 'draft' | 'open' | 'in_review' | 'merged' | 'closed';

export interface PRData {
  id: string;
  title: string;
  repo: string;
  author: string;
  status: PRStatus;
  url: string;
  createdAt: number;
  updatedAt: number;
  additions: number;
  deletions: number;
  reviewers: string[];
  labels: string[];
}

export function usePRData() {
  const [prs, setPRs] = useState<PRData[]>([]);
  const [loading, setLoading] = useState(false);

  const addPR = useCallback((pr: PRData) => {
    setPRs((prev) => [...prev.filter((p) => p.id !== pr.id), pr]);
  }, []);

  const updatePR = useCallback((id: string, updates: Partial<PRData>) => {
    setPRs((prev) => prev.map((p) => p.id === id ? { ...p, ...updates } : p));
  }, []);

  const removePR = useCallback((id: string) => {
    setPRs((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const getByStatus = useCallback((status: PRStatus): PRData[] => {
    return prs.filter((p) => p.status === status);
  }, [prs]);

  return { prs, setPRs, addPR, updatePR, removePR, getByStatus, loading, setLoading };
}

export default usePRData;
