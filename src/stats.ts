/**
 * Two-proportion z-test — the same math CRO tools run under the hood.
 * Pure functions, no dependencies.
 */

export interface VariantInput {
  name: string;
  visitors: number;
  conversions: number;
  isControl?: boolean;
}

export interface VariantVerdict {
  name: string;
  visitors: number;
  conversions: number;
  conversionRatePct: number;
  upliftVsControlPct: number | null;
  confidencePct: number | null;
  significant: boolean;
}

export interface TestVerdict {
  control: string;
  variants: VariantVerdict[];
  leader: string;
  significant: boolean;
  summary: string;
  requiredSamplePerVariant: number;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 approximation). */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function zTest(c: VariantInput, v: VariantInput): { confidencePct: number; significant: boolean } {
  if (c.visitors === 0 || v.visitors === 0) return { confidencePct: 0, significant: false };
  const p1 = c.conversions / c.visitors;
  const p2 = v.conversions / v.visitors;
  const pooled = (c.conversions + v.conversions) / (c.visitors + v.visitors);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / c.visitors + 1 / v.visitors));
  if (se === 0) return { confidencePct: 0, significant: false };
  const z = (p2 - p1) / se;
  const confidence = (2 * normCdf(Math.abs(z)) - 1) * 100; // two-tailed
  return { confidencePct: Math.round(confidence * 10) / 10, significant: confidence >= 95 };
}

/** Sample size per variant to detect `mdeRel` relative lift at 80% power, α=0.05. */
function requiredSample(baseRate: number, mdeRel: number): number {
  if (baseRate <= 0 || baseRate >= 1) return 0;
  const p1 = baseRate;
  const p2 = Math.min(0.999, baseRate * (1 + mdeRel));
  const zAlpha = 1.96;
  const zBeta = 0.84;
  const pBar = (p1 + p2) / 2;
  const numerator =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator / (p2 - p1)) ** 2);
}

export function evaluate(inputs: VariantInput[], mdeRel = 0.3): TestVerdict {
  const control = inputs.find((v) => v.isControl) ?? inputs[0];
  const rate = (v: VariantInput) => (v.visitors > 0 ? v.conversions / v.visitors : 0);

  const variants: VariantVerdict[] = inputs.map((v) => {
    const isCtrl = v === control;
    const t = isCtrl ? null : zTest(control, v);
    return {
      name: v.name,
      visitors: v.visitors,
      conversions: v.conversions,
      conversionRatePct: Math.round(rate(v) * 1000) / 10,
      upliftVsControlPct:
        isCtrl || rate(control) === 0
          ? null
          : Math.round(((rate(v) - rate(control)) / rate(control)) * 1000) / 10,
      confidencePct: t?.confidencePct ?? null,
      significant: t?.significant ?? false,
    };
  });

  const leader = [...variants].sort((a, b) => b.conversionRatePct - a.conversionRatePct)[0];
  const leaderVerdict = variants.find((v) => v.name === leader.name)!;
  const significant = leader.name !== control.name && leaderVerdict.significant;
  const needed = requiredSample(rate(control) || 0.02, mdeRel);

  const summary = significant
    ? `"${leader.name}" beats "${control.name}" with ${leaderVerdict.confidencePct}% confidence (${leaderVerdict.upliftVsControlPct}% uplift). Safe to declare a winner.`
    : leader.name === control.name
      ? `Control "${control.name}" is still ahead. No challenger has reached 95% confidence — keep the test running.`
      : `"${leader.name}" leads but only at ${leaderVerdict.confidencePct ?? 0}% confidence (needs 95%). ` +
        `Roughly ${needed.toLocaleString()} visitors per variant are needed to detect a ${Math.round(mdeRel * 100)}% lift — keep collecting.`;

  return {
    control: control.name,
    variants,
    leader: leader.name,
    significant,
    summary,
    requiredSamplePerVariant: needed,
  };
}
