import React, { useMemo } from 'react';
import { Server, Users, RefreshCw } from 'lucide-react';
import { useContracts } from './useContracts.js';
import { ContractDriftPanel } from './ContractDriftPanel.js';
import type {
  ContractKind,
  ContractSummary,
} from './contract-ui-types.js';

export interface ContractsMapPageProps {
  project: string | null;
  ws: WebSocket | null;
}

// ── Style tokens ─────────────────────────────────────────────────────

function kindColor(kind: ContractKind): string {
  switch (kind) {
    case 'openapi':
      return 'var(--accent)';
    case 'protobuf':
      return 'var(--color-warning)';
    case 'graphql':
      return 'var(--color-success)';
    case 'jsonschema':
      return 'var(--text-secondary)';
    case 'avro':
      return 'var(--text-tertiary)';
    default:
      return 'var(--text-tertiary)';
  }
}

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  fontFamily: 'var(--font-sans)',
  color: 'var(--text-primary)',
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: 'var(--space-md) var(--space-lg)',
  borderBottom: '1px solid var(--separator)',
  background: 'var(--bg-elevated-1)',
  flexShrink: 0,
};

const paneStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};

const leftPaneStyle: React.CSSProperties = {
  width: '30%',
  minWidth: 260,
  borderRight: '1px solid var(--separator)',
  overflowY: 'auto',
  background: 'var(--bg-base)',
};

const rightPaneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  background: 'var(--bg-base)',
  padding: 'var(--space-lg)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-lg)',
};

const repoHeaderStyle: React.CSSProperties = {
  padding: '8px var(--space-md)',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-tertiary)',
  background: 'var(--bg-elevated-1)',
  borderTop: '1px solid var(--separator)',
  borderBottom: '1px solid var(--separator)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

function KindPill({ kind }: { kind: ContractKind }) {
  const color = kindColor(kind);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 'var(--radius-full)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color,
        border: `1px solid ${color}`,
        background: 'var(--bg-base)',
      }}
    >
      {kind}
    </span>
  );
}

function contractKey(summary: ContractSummary): string {
  return `${summary.repoName}::${summary.sourceFile}`;
}

function ContractRow({
  contract,
  selected,
  onSelect,
}: {
  contract: ContractSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '10px var(--space-md)',
        border: 'none',
        background: selected ? 'var(--bg-elevated-2)' : 'transparent',
        borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        cursor: 'pointer',
        color: 'var(--text-primary)',
        borderBottom: '1px solid var(--separator)',
      }}
    >
      <Server
        size={14}
        strokeWidth={1.75}
        color="var(--text-tertiary)"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={contract.name}
        >
          {contract.name}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={contract.sourceFile}
        >
          {contract.sourceFile}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
          flexShrink: 0,
        }}
      >
        <KindPill kind={contract.kind} />
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
          }}
        >
          {contract.endpointCount} ep
        </span>
      </div>
    </button>
  );
}

function EmptyContracts() {
  return (
    <div
      style={{
        padding: 'var(--space-xl)',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <Server size={28} strokeWidth={1.5} aria-hidden="true" />
      <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
        No contracts detected
      </div>
      <div style={{ fontSize: 13, maxWidth: 280 }}>
        Try <code
          style={{
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-elevated-1)',
            padding: '1px 4px',
            borderRadius: 'var(--radius-sm)',
          }}
        >anvil contracts list</code> from your repo.
      </div>
    </div>
  );
}

function LoadingList() {
  const row: React.CSSProperties = {
    height: 52,
    background: 'var(--bg-elevated-1)',
    borderBottom: '1px solid var(--separator)',
    animation: 'pulse var(--duration-slow, 1s) ease-in-out infinite',
    opacity: 0.6,
  };
  return (
    <div aria-busy="true" aria-label="Loading contracts">
      <div style={row} />
      <div style={row} />
      <div style={row} />
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────

export function ContractsMapPage({ project, ws }: ContractsMapPageProps) {
  const {
    contracts,
    selected,
    select,
    impact,
    loading,
    rescan,
    generateTests,
  } = useContracts(ws, project);

  const grouped = useMemo(() => {
    const byRepo = new Map<string, ContractSummary[]>();
    for (const c of contracts) {
      const list = byRepo.get(c.repoName);
      if (list) list.push(c);
      else byRepo.set(c.repoName, [c]);
    }
    return Array.from(byRepo.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [contracts]);

  const selectedKey = selected ? contractKey(selected) : null;

  const handleGenerate = (): void => {
    if (selected) generateTests(selected);
  };

  const callGroups = impact?.affectedCallsByChange ?? [];

  return (
    <div style={pageStyle}>
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Users size={16} strokeWidth={1.75} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Contract Guard
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {project ? `· ${project}` : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={rescan}
          disabled={!project || loading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--separator)',
            background: 'var(--bg-elevated-2)',
            color: 'var(--text-primary)',
            cursor: project && !loading ? 'pointer' : 'not-allowed',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <RefreshCw
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            style={loading ? { animation: 'spin 1s linear infinite' } : undefined}
          />
          Rescan
        </button>
      </div>

      <div style={paneStyle}>
        <div style={leftPaneStyle}>
          {loading && contracts.length === 0 ? (
            <LoadingList />
          ) : contracts.length === 0 ? (
            <EmptyContracts />
          ) : (
            grouped.map(([repoName, repoContracts]) => (
              <div key={repoName}>
                <div style={repoHeaderStyle}>{repoName}</div>
                {repoContracts.map((c) => {
                  const key = contractKey(c);
                  return (
                    <ContractRow
                      key={key}
                      contract={c}
                      selected={selectedKey === key}
                      onSelect={() => select(c)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div style={rightPaneStyle}>
          {!selected ? (
            <div
              style={{
                padding: 'var(--space-xl)',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 13,
              }}
            >
              Select a contract to see its consumers and drift.
            </div>
          ) : (
            <>
              <section
                aria-label="Consumer map"
                style={{
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-lg)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-md)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Users size={14} strokeWidth={1.75} aria-hidden="true" />
                  <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                    Consumers of {selected.name}
                  </h3>
                </div>

                {callGroups.length === 0 ? (
                  <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                    No consumer call-sites detected for this contract yet.
                  </div>
                ) : (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    {callGroups.flatMap((group, gi) =>
                      group.calls.map((call, ci) => (
                        <li
                          key={`${gi}:${ci}:${call.repoName}:${call.filePath}:${call.lineNumber}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 10px',
                            background: 'var(--bg-elevated-1)',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--separator)',
                            fontSize: 12,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--text-secondary)',
                              flexShrink: 0,
                            }}
                          >
                            {call.repoName}
                          </span>
                          <span style={{ color: 'var(--text-tertiary)' }}>·</span>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}
                            title={call.filePath}
                          >
                            {call.filePath}
                          </span>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--text-tertiary)',
                              flexShrink: 0,
                            }}
                          >
                            :{call.lineNumber}
                          </span>
                          {call.endpointId && (
                            <span
                              style={{
                                marginLeft: 'auto',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                color: 'var(--text-secondary)',
                                background: 'var(--bg-base)',
                                border: '1px solid var(--separator)',
                                borderRadius: 'var(--radius-sm)',
                                padding: '1px 6px',
                                flexShrink: 0,
                              }}
                              title={call.endpointId}
                            >
                              {call.endpointId}
                            </span>
                          )}
                        </li>
                      )),
                    )}
                  </ul>
                )}
              </section>

              <ContractDriftPanel
                report={impact}
                loading={loading}
                onGenerateTests={handleGenerate}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ContractsMapPage;
