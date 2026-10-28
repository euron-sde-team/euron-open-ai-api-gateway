/** The API key form: its fields as typed, and their conversion to API input. Pure (tested in test/console). */
import type { ApiKeyInput } from "@open-gateway/types";
import { dollarsToMicros } from "./money";

export interface KeyForm {
  name: string;
  expiresAt: string;
  allModels: boolean;
  models: string[];
  budget: string;
  rpm: string;
  tpm: string;
  ips: string;
  logBodies: boolean;
}

/** The form to API input, or field errors. */
export function formToInput(f: KeyForm): { input: ApiKeyInput } | { errors: Partial<Record<keyof KeyForm, string>> } {
  const errors: Partial<Record<keyof KeyForm, string>> = {};
  if (!f.name.trim()) errors.name = "Name the key so you can recognise it later.";
  const budget = f.budget.trim() ? dollarsToMicros(f.budget) : null;
  if (f.budget.trim() && (!budget || budget <= 0)) errors.budget = "Enter an amount in dollars, such as 25.";
  const int = (v: string) => (v.trim() ? (/^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : NaN) : null);
  const rpm = int(f.rpm);
  const tpm = int(f.tpm);
  if (Number.isNaN(rpm)) errors.rpm = "A whole number of requests per minute.";
  if (Number.isNaN(tpm)) errors.tpm = "A whole number of tokens per minute.";
  if (!f.allModels && !f.models.length) errors.models = "Pick at least one model, or allow all.";
  if (Object.keys(errors).length) return { errors };
  return {
    input: {
      name: f.name.trim(),
      expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59.000Z`).toISOString() : null,
      allowedModels: f.allModels ? [] : f.models,
      monthlyBudgetMicros: budget,
      rpm: rpm as number | null,
      tpm: tpm as number | null,
      ipAllowlist: f.ips
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      logBodies: f.logBodies,
    },
  };
}

