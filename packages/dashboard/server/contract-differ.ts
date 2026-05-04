/**
 * Computes a semantic diff between two `Contract` snapshots and classifies
 * each change as breaking / non-breaking / needs-review.
 */

import type {
  Contract,
  ContractChange,
  ContractDiff,
  ContractField,
  ContractType,
} from './contract-types.js';

export function diffContracts(before: Contract, after: Contract): ContractDiff {
  const changes: ContractChange[] = [];

  diffTypes(before, after, changes);
  diffEndpoints(before, after, changes);

  const breakingCount = changes.reduce(
    (acc, c) => acc + (c.severity === 'breaking' ? 1 : 0),
    0,
  );

  return { before, after, changes, breakingCount };
}

// ── Types ───────────────────────────────────────────────────────────────

function diffTypes(
  before: Contract,
  after: Contract,
  changes: ContractChange[],
): void {
  const beforeTypes = before.types;
  const afterTypes = after.types;

  for (const [typeName, beforeType] of Object.entries(beforeTypes)) {
    const afterType = afterTypes[typeName];
    if (!afterType) {
      // Type removed: treat each field as a removal under the type's namespace.
      if (beforeType.kind === 'object') {
        for (const f of beforeType.fields) {
          changes.push({
            kind: 'field-removed',
            severity: 'breaking',
            path: `${typeName}.${f.name}`,
            before: f.type,
            description: `Type ${typeName} removed (was an object with field ${f.name})`,
          });
        }
      }
      continue;
    }
    diffType(typeName, beforeType, afterType, changes);
  }

  for (const [typeName, afterType] of Object.entries(afterTypes)) {
    if (beforeTypes[typeName]) continue;
    if (afterType.kind === 'object') {
      for (const f of afterType.fields) {
        changes.push({
          kind: 'field-added',
          severity: 'non-breaking',
          path: `${typeName}.${f.name}`,
          after: f.type,
          description: `New type ${typeName} introduced with field ${f.name}`,
        });
      }
    }
  }
}

function diffType(
  typeName: string,
  before: ContractType,
  after: ContractType,
  changes: ContractChange[],
): void {
  // Enum comparison.
  if (before.kind === 'enum' || after.kind === 'enum') {
    const beforeVals = new Set(before.enumValues ?? []);
    const afterVals = new Set(after.enumValues ?? []);
    const removed = [...beforeVals].filter((v) => !afterVals.has(v));
    const added = [...afterVals].filter((v) => !beforeVals.has(v));
    if (removed.length > 0) {
      changes.push({
        kind: 'enum-shrunk',
        severity: 'breaking',
        path: typeName,
        before: removed.join(','),
        description: `Enum ${typeName} dropped value(s): ${removed.join(', ')}`,
      });
    }
    if (added.length > 0) {
      changes.push({
        kind: 'enum-extended',
        severity: 'non-breaking',
        path: typeName,
        after: added.join(','),
        description: `Enum ${typeName} added value(s): ${added.join(', ')}`,
      });
    }
    return;
  }

  if (before.kind !== 'object' || after.kind !== 'object') return;

  const beforeFields = indexFields(before.fields);
  const afterFields = indexFields(after.fields);

  for (const [fieldName, beforeField] of beforeFields) {
    const afterField = afterFields.get(fieldName);
    if (!afterField) {
      changes.push({
        kind: 'field-removed',
        severity: 'breaking',
        path: `${typeName}.${fieldName}`,
        before: beforeField.type,
        description: `Field ${typeName}.${fieldName} removed`,
      });
      continue;
    }
    diffField(typeName, beforeField, afterField, changes);
    // Field-level enum diff (on individual scalar+enum fields).
    diffFieldEnum(typeName, beforeField, afterField, changes);
  }

  for (const [fieldName, afterField] of afterFields) {
    if (beforeFields.has(fieldName)) continue;
    changes.push({
      kind: 'field-added',
      severity: afterField.required ? 'needs-review' : 'non-breaking',
      path: `${typeName}.${fieldName}`,
      after: afterField.type,
      description: afterField.required
        ? `Required field ${typeName}.${fieldName} added (may break producers)`
        : `Optional field ${typeName}.${fieldName} added`,
    });
  }
}

function indexFields(fields: ContractField[]): Map<string, ContractField> {
  const out = new Map<string, ContractField>();
  for (const f of fields) out.set(f.name, f);
  return out;
}

function diffField(
  typeName: string,
  before: ContractField,
  after: ContractField,
  changes: ContractChange[],
): void {
  const path = `${typeName}.${before.name}`;

  // Required flag transitions.
  if (!before.required && after.required) {
    changes.push({
      kind: 'required-added',
      severity: 'breaking',
      path,
      before: 'optional',
      after: 'required',
      description: `Field ${path} became required`,
    });
  } else if (before.required && !after.required) {
    changes.push({
      kind: 'required-removed',
      severity: 'non-breaking',
      path,
      before: 'required',
      after: 'optional',
      description: `Field ${path} is no longer required`,
    });
  }

  // Type changes (narrow/widen, or arbitrary).
  if (before.type !== after.type) {
    const beforeNullable = includesNull(before.type) || before.nullable;
    const afterNullable = includesNull(after.type) || after.nullable;
    if (beforeNullable && !afterNullable && stripNull(before.type) === stripNull(after.type)) {
      changes.push({
        kind: 'type-narrowed',
        severity: 'breaking',
        path,
        before: before.type,
        after: after.type,
        description: `Field ${path} narrowed: removed null from union`,
      });
    } else if (!beforeNullable && afterNullable && stripNull(before.type) === stripNull(after.type)) {
      changes.push({
        kind: 'type-widened',
        severity: 'non-breaking',
        path,
        before: before.type,
        after: after.type,
        description: `Field ${path} widened: now accepts null`,
      });
    } else {
      // Arbitrary type change — treat as breaking by default.
      changes.push({
        kind: 'type-narrowed',
        severity: 'breaking',
        path,
        before: before.type,
        after: after.type,
        description: `Field ${path} changed type: ${before.type} -> ${after.type}`,
      });
    }
  }
}

function diffFieldEnum(
  typeName: string,
  before: ContractField,
  after: ContractField,
  changes: ContractChange[],
): void {
  if (!before.enumValues && !after.enumValues) return;
  const path = `${typeName}.${before.name}`;
  const bVals = new Set(before.enumValues ?? []);
  const aVals = new Set(after.enumValues ?? []);
  const removed = [...bVals].filter((v) => !aVals.has(v));
  const added = [...aVals].filter((v) => !bVals.has(v));
  if (removed.length > 0) {
    changes.push({
      kind: 'enum-shrunk',
      severity: 'breaking',
      path,
      before: removed.join(','),
      description: `Field ${path} enum dropped value(s): ${removed.join(', ')}`,
    });
  }
  if (added.length > 0) {
    changes.push({
      kind: 'enum-extended',
      severity: 'non-breaking',
      path,
      after: added.join(','),
      description: `Field ${path} enum added value(s): ${added.join(', ')}`,
    });
  }
}

function includesNull(type: string): boolean {
  return type.split('|').map((p) => p.trim()).includes('null');
}
function stripNull(type: string): string {
  return type
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p !== 'null')
    .sort()
    .join('|');
}

// ── Endpoints ───────────────────────────────────────────────────────────

function diffEndpoints(
  before: Contract,
  after: Contract,
  changes: ContractChange[],
): void {
  const beforeMap = new Map(before.endpoints.map((e) => [e.id, e]));
  const afterMap = new Map(after.endpoints.map((e) => [e.id, e]));

  for (const [id, beforeEp] of beforeMap) {
    const afterEp = afterMap.get(id);
    if (!afterEp) {
      changes.push({
        kind: 'endpoint-removed',
        severity: 'breaking',
        path: id,
        before: id,
        description: `Endpoint ${id} removed`,
      });
      continue;
    }
    // Response-type reshaping: any field diff inside the responseType.
    if (beforeEp.responseType && afterEp.responseType) {
      const bt = before.types[beforeEp.responseType];
      const at = after.types[afterEp.responseType];
      if (bt && at && bt.kind === 'object' && at.kind === 'object') {
        if (hasFieldDiff(bt, at)) {
          changes.push({
            kind: 'response-shape-changed',
            severity: 'breaking',
            path: `${id}.response`,
            before: beforeEp.responseType,
            after: afterEp.responseType,
            description: `Endpoint ${id} response shape (${afterEp.responseType}) changed`,
          });
        }
      }
    }
    if (beforeEp.requestType && afterEp.requestType) {
      const bt = before.types[beforeEp.requestType];
      const at = after.types[afterEp.requestType];
      if (bt && at && bt.kind === 'object' && at.kind === 'object') {
        if (hasFieldDiff(bt, at)) {
          changes.push({
            kind: 'request-shape-changed',
            severity: 'needs-review',
            path: `${id}.request`,
            before: beforeEp.requestType,
            after: afterEp.requestType,
            description: `Endpoint ${id} request shape (${afterEp.requestType}) changed`,
          });
        }
      }
    }
  }

  for (const [id] of afterMap) {
    if (beforeMap.has(id)) continue;
    changes.push({
      kind: 'endpoint-added',
      severity: 'non-breaking',
      path: id,
      after: id,
      description: `Endpoint ${id} added`,
    });
  }
}

function hasFieldDiff(before: ContractType, after: ContractType): boolean {
  const b = indexFields(before.fields);
  const a = indexFields(after.fields);
  if (b.size !== a.size) return true;
  for (const [name, bf] of b) {
    const af = a.get(name);
    if (!af) return true;
    if (af.type !== bf.type) return true;
    if (af.required !== bf.required) return true;
    if (af.nullable !== bf.nullable) return true;
  }
  return false;
}
