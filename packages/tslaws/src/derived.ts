// What the type checker works out from a build (each law's generator plans and shapes, the coverage report) depends
// on nothing but that build, so it is kept next to it: an unchanged project never starts the checker.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoverageReport } from './coverage.ts';
import { arbitraryOf, type Plan } from './plan.ts';
import type { LawTypes } from './property.ts';
import type { Shape } from './smt.ts';
import type { ManifestLaw } from './types.ts';

interface Stored {
  key: string;
  laws: Record<string, { plans: Plan[]; shapes: (Shape | null)[] }>;
  coverage?: CoverageReport;
}

export interface DerivedStore {
  law(law: ManifestLaw, compute: () => LawTypes): LawTypes;
  coverage(compute: () => CoverageReport): CoverageReport;
}

export function derivedStore(cwd: string, key: string | undefined): DerivedStore {
  if (key === undefined) return { law: (_law, compute) => compute(), coverage: (compute) => compute() };
  const path = join(cwd, '.tslaws', 'derived.json');
  let stored: Stored = { key, laws: {} };
  try {
    const read = JSON.parse(readFileSync(path, 'utf8')) as Stored;
    if (read.key === key) stored = read;
  } catch {
    // Nothing kept yet.
  }
  const save = (): void => {
    try {
      mkdirSync(join(cwd, '.tslaws'), { recursive: true });
      writeFileSync(path, JSON.stringify(stored));
    } catch {
      // Not keeping it is only slower.
    }
  };
  return {
    law(law, compute) {
      const id = `${law.file}::${law.symbol ?? law.name}`;
      const kept = stored.laws[id];
      if (kept !== undefined)
        return {
          generators: kept.plans.map(arbitraryOf),
          plans: kept.plans,
          shapes: kept.shapes.map((shape) => shape ?? undefined) as Shape[],
        };
      const types = compute();
      stored.laws[id] = { plans: types.plans, shapes: types.shapes.map((shape) => shape ?? null) };
      save();
      return types;
    },
    coverage(compute) {
      if (stored.coverage !== undefined) return stored.coverage;
      const report = compute();
      stored.coverage = report;
      save();
      return report;
    },
  };
}
