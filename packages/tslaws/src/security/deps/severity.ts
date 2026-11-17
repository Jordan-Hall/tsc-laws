// Advisory severity: the GitHub rating when the record has one, otherwise the CVSS v3 base score worked out from the vector.

export type Severity = 'unknown' | 'low' | 'moderate' | 'high' | 'critical';

const ranks: Record<Severity, number> = { unknown: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** 0 for unknown, up to 4 for critical. */
export function severityRank(severity: Severity): number {
  return ranks[severity];
}

/** `medium` is read as `moderate`. Undefined for text that names no level. */
export function parseSeverity(text: unknown): Severity | undefined {
  if (typeof text !== 'string') return undefined;
  const lower = text.trim().toLowerCase();
  if (lower === 'medium') return 'moderate';
  return lower === 'low' || lower === 'moderate' || lower === 'high' || lower === 'critical' ? lower : undefined;
}

const weights = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

function roundUp(value: number): number {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

/** The CVSS v3.0 and v3.1 base score of a vector string, or undefined for any other vector (v2 and v4 are not read). */
export function cvssScore(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined;
  const metrics = new Map(
    vector
      .split('/')
      .slice(1)
      .map((part) => part.split(':') as [string, string]),
  );
  const get = (key: string): string | undefined => metrics.get(key);
  const changed = get('S') === 'C';
  const av = weights.AV[get('AV') as keyof typeof weights.AV];
  const ac = weights.AC[get('AC') as keyof typeof weights.AC];
  const ui = weights.UI[get('UI') as keyof typeof weights.UI];
  const privilege = get('PR');
  const pr =
    privilege === 'N'
      ? 0.85
      : privilege === 'L'
        ? changed
          ? 0.68
          : 0.62
        : privilege === 'H'
          ? changed
            ? 0.5
            : 0.27
          : undefined;
  const c = weights.CIA[get('C') as keyof typeof weights.CIA];
  const i = weights.CIA[get('I') as keyof typeof weights.CIA];
  const a = weights.CIA[get('A') as keyof typeof weights.CIA];
  if ([av, ac, ui, pr, c, i, a].some((n) => n === undefined) || (get('S') !== 'C' && get('S') !== 'U'))
    return undefined;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

export function severityOfScore(score: number): Severity {
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'unknown';
}

interface Rated {
  id?: string;
  severity?: { type?: string; score?: string }[];
  database_specific?: { severity?: unknown };
  affected?: { ecosystem_specific?: { severity?: unknown } }[];
}

/** The severity of an OSV record: the rating it names, else its CVSS v3 score; `MAL-` records (malicious packages) are critical. */
export function severityOf(vuln: Rated): Severity {
  const named =
    parseSeverity(vuln.database_specific?.severity) ??
    vuln.affected?.map((a) => parseSeverity(a.ecosystem_specific?.severity)).find((s) => s !== undefined);
  if (named !== undefined) return named;
  for (const entry of vuln.severity ?? []) {
    const score = typeof entry.score === 'string' ? cvssScore(entry.score) : undefined;
    if (score !== undefined) return severityOfScore(score);
  }
  return vuln.id?.startsWith('MAL-') === true ? 'critical' : 'unknown';
}
