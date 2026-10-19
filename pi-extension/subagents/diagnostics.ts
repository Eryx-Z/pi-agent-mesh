import type { Loadout } from "./loadout.ts";

// Classify only known signals; retain the original error rather than guessing a cause.
export function diagnoseFailure(error: string, loadout: Pick<Loadout, "model" | "agentDir">, phase?: string): string {
  let category: string, hint: string;
  if (/No API key found|missing api key|invalid api key|unauthorized|authentication failed|\b401\b/i.test(error)) {
    category = "credentials";
    hint = "Check this provider's credentials in the child agent directory or inherited environment. Parent-only in-memory authentication is not copied; authenticate/configure the provider, then explicitly continue or retry.";
  } else if (phase && /Unknown provider|Model .*not found|Requested model was not selected|canonical provider\/model/i.test(error)) {
    category = "model/provider";
    hint = "Check the canonical provider/model ID and available models. Custom providers must reload in the child via a provider-source entrypoint; parent-only registrations are not inherited.";
  } else if (phase && /tool|skill|provenance|bridge|extension/i.test(error)) {
    category = "loadout/extension";
    hint = "Check inherited tool/skill files and extension startup errors. Definitions and provenance must match the saved loadout in a fresh RPC process; do not bypass preflight. Relaunch if the parent configuration has changed.";
  } else if (phase) {
    category = "startup";
    hint = "Check the original error, Pi executable, child working directory and configuration. No automatic retry was attempted.";
  } else return error;
  return `[subagent ${category}] phase=${phase ?? "model run"}; model=${loadout.model}; agentDir=${loadout.agentDir}\n${hint}\nOriginal error: ${error}`;
}
