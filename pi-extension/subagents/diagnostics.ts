import type { Loadout } from "./loadout.ts";

// Provider/transport failures that pi-ai already treats as retryable network drops.
// Quota, auth, and ordinary provider errors stay out of this set.
const TRANSPORT_FAILURE = /(?:^|[^a-z0-9])(?:terminated|connection error|connection refused|connection lost|fetch failed|socket hang up|socket connection was closed|other side closed|reset before headers|network error|upstream connect|websocket closed|websocket error|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|pending stream has been canceled|getaddrinfo|enotfound|eai_again|econnreset|econnrefused|etimedout)(?:$|[^a-z0-9])/i;

export function isTransportFailure(error: string | undefined): boolean {
  return !!error && TRANSPORT_FAILURE.test(error);
}

// Classify only known signals; retain the original error rather than guessing a cause.
export function diagnoseFailure(error: string, loadout: Loadout, phase?: string): string {
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
