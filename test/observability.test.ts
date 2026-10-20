import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Observability, classifyToolOutcome, sanitizeObservation } from "../pi-extension/subagents/observability.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";
import { TaskStore } from "../pi-extension/subagents/store.ts";
import { RpcProcess } from "../pi-extension/subagents/rpc.ts";
import { WorkflowManager, type StepDefinition } from "../pi-extension/subagents/workflows.ts";
import { loadout } from "./fixtures/loadout.ts";
import type { RolePlan } from "../pi-extension/subagents/role-loadout.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-rpc.mjs", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } throw new Error("timed out waiting for observability task"); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("tool outcomes, durations, roles and secrets stay bounded and redacted", () => {
  let now = 1_000;
  const mesh = new Observability(() => now);
  mesh.beginTool("parent:1", { origin: "parent", name: "read" });
  now = 1_040;
  mesh.endTool("parent:1", { origin: "parent", name: "read", outcome: "success", roleId: "builder" });
  mesh.tool({ origin: "child", name: "bash", outcome: "error", error: "authorization: super-secret-value Bearer abcdefghijklmnop sk-supersecretvalue", roleId: "builder", durationMs: 12 });
  mesh.markBlocked("parent:2", "Tool outside verified role loadout");
  mesh.endTool("parent:2", { origin: "parent", name: "subagent_control", outcome: "error", action: "cancel", error: "Tool outside verified role loadout" });
  mesh.beginTool("child:task:hang", { origin: "child", name: "bash", taskId: "task" });
  mesh.abandonTools("child:task:");
  mesh.role({ event: "created", roleId: "builder", taskId: "task-1", access: "full", context: "partial", model: "fake/test" });
  mesh.role({ event: "created", roleId: "builder", taskId: "task-2", workflowId: "flow", access: "full", context: "none", model: "fake/test" });
  mesh.role({ event: "continued", roleId: "builder", taskId: "task-1", access: "read-only", context: "none", model: "fake/test", run: 2 });
  mesh.role({ event: "preflight_ok", roleId: "builder", taskId: "task-1" });
  mesh.role({ event: "failed", roleId: "builder", taskId: "task-2", error: "token=do-not-keep" });
  mesh.task({ event: "launched", taskId: "task-1", access: "full", context: "none", version: 3 });
  mesh.workflow({ event: "launched", workflowId: "flow", name: "auth", workspace: "shared", detail: "2 steps" });
  mesh.control({ event: "pm", name: "ready", outcome: "ready" });

  const totals = mesh.totals();
  assert.equal(totals.toolCalls, 4);
  assert.equal(totals.toolSuccesses, 1);
  assert.equal(totals.toolErrors, 1);
  assert.equal(totals.toolBlocked, 1);
  assert.equal(totals.toolAborted, 1);
  assert.equal(totals.rolesCreated, 2);
  assert.equal(totals.roleRuns, 3);
  const report = mesh.report();
  assert.match(report, /parent read  calls=1 ok=1/);
  assert.match(report, /avg=40ms/);
  assert.match(report, /roles: builder 1\/1 ok/);
  assert.match(report, /actions: cancel ok=0 err=0 blocked=1 aborted=0/);
  assert.match(report, /builder  created=2 standalone=1 workflow=1 continued=1 recovered=0 runs=3/);
  assert.match(report, /preflight ok=1 failed=0/);
  assert.match(report, /access: full=2, read-only=1/);
  assert.match(report, /pm:ready:ready=1/);
  assert.match(report, /In flight: 0/);
  assert.doesNotMatch(report, /super-secret-value|abcdefghijklmnop|sk-supersecretvalue|do-not-keep/);
  assert.match(report, /\[redacted\]/);
  const json = mesh.toJSON();
  assert.doesNotMatch(json, /super-secret-value|abcdefghijklmnop|sk-supersecretvalue|do-not-keep/);
  assert.match(json, /"arguments": "omitted"/);
  assert.equal(sanitizeObservation("password=hunter2"), "password=[redacted]");
  assert.equal(classifyToolOutcome(true, "Tool execution was blocked"), "blocked");
  assert.equal(classifyToolOutcome(true, "Question cancelled without an answer"), "aborted");
  assert.equal(classifyToolOutcome(false), "success");
  assert.throws(() => mesh.report("nope"), /Usage: \/mesh/);
});

test("credential fields redact complete authorization and quoted or space-separated values", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnop", "Authorization: [redacted]"],
    ["aUtHoRiZaTiOn = bAsIc dXNlcjpwYXNzd29yZA==", "aUtHoRiZaTiOn = [redacted]"],
    ['Authorization: Bearer "quoted-header-token"', "Authorization: [redacted]"],
    ['Authorization: Digest username="synthetic", response="synthetic-digest"', "Authorization: [redacted]"],
    ["Authorization: Bearer tiny\nstatus: failed", "Authorization: [redacted] status: failed"],
    ['{"Authorization": "Bearer json-bearer-credential"}', '{"Authorization": [redacted]}'],
    ["{'authorization': 'Basic json-basic-credential'}", "{'authorization': [redacted]}"],
    ['{"credentials": "quoted credential with spaces"}', '{"credentials": [redacted]}'],
    ['{"credentials":"https://example.invalid/?token=synthetic","status":"failed"}', '{"credentials":[redacted],"status":"failed"}'],
    ['{"credentials":"https://example.invalid/?token=synthetic with spaces","status":"failed"}', '{"credentials":[redacted],"status":"failed"}'],
    ['api key = "api credential with spaces"', "api key = [redacted]"],
    ["access token: short-value", "access token: [redacted]"],
    ['client secret: "escaped \\" credential"', "client secret: [redacted]"],
    ["password=hunter2", "password=[redacted]"],
    ["Bearer standalone-credential", "[redacted]"],
    ["sk-syntheticsecret rk-syntheticsecret AKIA1234567890ABCDEF", "[redacted] [redacted] [redacted]"],
    ["https://example.invalid/?access_token=query-credential&token=other-credential", "https://example.invalid/[redacted][redacted]"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeObservation(input), expected, input);
    assert.equal(sanitizeObservation(expected), expected, "Repeated sanitization preserves redaction");
  }
  assert.equal(sanitizeObservation('credentials="' + "synthetic ".repeat(500)), "credentials=[redacted]");
});

const compoundCredentials = [
  ["refresh_token", "synthetic-refresh-value"],
  ["id_token", "synthetic-id-value"],
  ["auth_token", "synthetic-auth-value"],
  ["refreshToken", "synthetic-camel-value"],
  ["DB_PASSWORD", "synthetic-db-value"],
  ["service_client_secret", "synthetic-client-value"],
] as const;
const punctuatedCredentials = [
  ["password", "alpha,beta"],
  ["password", "alpha;beta"],
  ["password", "alpha&beta"],
  ["api_key", "abc,def"],
  ["password", ",synthetic-leading-comma"],
  ["password", ";synthetic-leading-semicolon"],
  ["password", "&synthetic-leading-ampersand"],
  ["password", "]synthetic-leading-bracket"],
  ["password", "}synthetic-leading-brace"],
] as const;

const authorizationSuffixCases = [
  ["HTTP_AUTHORIZATION=synthetic-header-value", "HTTP_AUTHORIZATION=[redacted]", "synthetic-header-value"],
  ["http_authorization=synthetic-lower-header", "http_authorization=[redacted]", "synthetic-lower-header"],
  ["proxyAuthorization: tiny", "proxyAuthorization: [redacted]", "tiny"],
  ['{"HTTP_AUTHORIZATION":"Bearer synthetic-quoted-header"}', '{"HTTP_AUTHORIZATION":[redacted]}', "synthetic-quoted-header"],
  ["'Http_Authorization'='Basic synthetic-single-header'", "'Http_Authorization'=[redacted]", "synthetic-single-header"],
  ['HTTP_AUTHORIZATION="synthetic \\"escaped-header-secret\\" header"', "HTTP_AUTHORIZATION=[redacted]", "escaped-header-secret"],
  ["HTTP_AUTHORIZATION=synthetic-header,synthetic-header-tail;synthetic-header-end\nstatus: failed", "HTTP_AUTHORIZATION=[redacted] status: failed", "synthetic-header,synthetic-header-tail;synthetic-header-end"],
] as const;
const redactionMarkerSuffixCases = [
  ["password=[redacted],synthetic-tail", "password=[redacted]", "synthetic-tail"],
  ["DB_PASSWORD=[redacted];synthetic-semicolon-tail", "DB_PASSWORD=[redacted]", "synthetic-semicolon-tail"],
  ["ToKeN=[redacted]&synthetic-ampersand-tail", "ToKeN=[redacted]", "synthetic-ampersand-tail"],
  ["api_key=[redacted]}synthetic-brace-tail", "api_key=[redacted]", "synthetic-brace-tail"],
  ["password=[redacted]]synthetic-bracket-tail", "password=[redacted]", "synthetic-bracket-tail"],
  ["PASSWORD=[REDACTED]synthetic-direct-tail status=failed", "PASSWORD=[redacted] status=failed", "synthetic-direct-tail"],
  ["HTTP_AUTHORIZATION=[redacted],synthetic-auth-tail", "HTTP_AUTHORIZATION=[redacted]", "synthetic-auth-tail"],
  ["Authorization: [redacted],synthetic-bare-auth-tail", "Authorization: [redacted]", "synthetic-bare-auth-tail"],
  ['"PASSWORD"="[redacted],synthetic-quoted-tail"', '"PASSWORD"=[redacted]', "synthetic-quoted-tail"],
  ["'password'='[redacted];synthetic-single-tail'", "'password'=[redacted]", "synthetic-single-tail"],
  ['{"password":[redacted],synthetic-json-tail,"token":[redacted],"status":"failed"}', '{"password":[redacted],"token":[redacted],"status":"failed"}', "synthetic-json-tail"],
] as const;

test("compound Authorization suffixes redact complete header values", () => {
  for (const [input, expected] of authorizationSuffixCases) {
    assert.equal(sanitizeObservation(input), expected, input);
    assert.equal(sanitizeObservation(expected), expected, "Authorization suffix redaction is idempotent");
  }
});

test("redaction markers cannot expose attached credential tails or consume neighboring JSON fields", () => {
  for (const [input, expected] of redactionMarkerSuffixCases) {
    assert.equal(sanitizeObservation(input), expected, input);
    assert.equal(sanitizeObservation(expected), expected, "Marker tail redaction is idempotent");
  }
  for (const text of [
    "password=[redacted]",
    "HTTP_AUTHORIZATION=[redacted]",
    "password=[redacted] status=failed",
    '{"password":[redacted],"token":[redacted],"status":"failed"}',
    '{"HTTP_AUTHORIZATION":[redacted],"password":[redacted],"status":"failed"}',
    '{"password":[redacted], "token": [redacted], "status":"failed"}',
    '{"nested":[{"password":[redacted]}],"status":"failed"}',
    '{"nested":[{"password":[redacted]} ], "status":"failed"}',
    '{"password":[redacted],"escaped\\"key":[redacted],"status":"failed"}',
    "status=failed code=500 /tmp/build-output [redacted] ordinary text",
  ]) assert.equal(sanitizeObservation(text), text, "Preserve plain text and already-redacted fields");
});

const scannerRegressionCases = [
  {
    name: "redacted array entries cannot swallow a neighboring credential key",
    input: '[{"password":[redacted]},{"credentials":"synthetic spaced secret"}]',
    expected: '[{"password":[redacted]},{"credentials":[redacted]}]',
    secrets: ["synthetic spaced secret", "spaced secret"],
  },
  {
    name: "repeated sanitization preserves neighboring array objects",
    input: '[{"password":"synthetic"},{"status":"failed"}]',
    expected: '[{"password":[redacted]},{"status":"failed"}]',
    secrets: ["synthetic"],
  },
  {
    name: "redacted Authorization markers still consume a complete Basic header",
    input: "HTTP_AUTHORIZATION=[redacted],Basic dXNlcjpwYXNzd29yZA==",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["dXNlcjpwYXNzd29yZA=="],
  },
  {
    name: "quoted braces cannot terminate an unquoted Digest header",
    input: 'HTTP_AUTHORIZATION=Digest username="a}b", response="0123456789abcdef0123456789abcdef"',
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["a}b", "0123456789abcdef0123456789abcdef"],
  },
  {
    name: "exact Authorization markers preserve normalized status diagnostics",
    input: "HTTP_AUTHORIZATION=[redacted] status: failed",
    expected: "HTTP_AUTHORIZATION=[redacted] status: failed",
    secrets: [],
  },
  {
    name: "exact Authorization markers preserve normalized code diagnostics",
    input: "HTTP_AUTHORIZATION=[redacted] code=500",
    expected: "HTTP_AUTHORIZATION=[redacted] code=500",
    secrets: [],
  },
  {
    name: "exact Authorization markers preserve an already-redacted adjacent field",
    input: "HTTP_AUTHORIZATION=[redacted] password=[redacted]",
    expected: "HTTP_AUTHORIZATION=[redacted] password=[redacted]",
    secrets: [],
  },
  {
    name: "exact Authorization markers cannot expose unknown whitespace tails",
    input: "HTTP_AUTHORIZATION=[redacted] synthetic-unknown-header-tail",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-unknown-header-tail"],
  },
  {
    name: "exact Authorization markers cannot expose Basic scheme credentials",
    input: "HTTP_AUTHORIZATION=[redacted] Basic dXNlcjpwYXNzd29yZA==",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["dXNlcjpwYXNzd29yZA=="],
  },
  {
    name: "exact Authorization markers cannot expose short Bearer scheme credentials",
    input: "HTTP_AUTHORIZATION=[redacted] Bearer tiny",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["tiny"],
  },
  {
    name: "exact Authorization markers cannot expose Digest parameters",
    input: 'HTTP_AUTHORIZATION=[redacted] Digest response="synthetic-digest-parameter"',
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-digest-parameter"],
  },
  {
    name: "exact Authorization markers cannot expose unknown unredacted parameters",
    input: "HTTP_AUTHORIZATION=[redacted] response=synthetic-unknown-parameter",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-unknown-parameter"],
  },
  {
    name: "escaped quotes and braces stay inside a complete Digest header",
    input: 'HTTP_AUTHORIZATION=Digest username="a\\"}b", response="synthetic-escaped-response"',
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-escaped-response"],
  },
  {
    name: "unquoted Digest headers preserve adjacent JSON objects",
    input: '[{"HTTP_AUTHORIZATION":Digest username="a}b", response="synthetic-structured-response"},{"credentials":"synthetic adjacent secret"}]',
    expected: '[{"HTTP_AUTHORIZATION":[redacted]},{"credentials":[redacted]}]',
    secrets: ["synthetic-structured-response", "synthetic adjacent secret", "adjacent secret"],
  },
  {
    name: "marker Basic headers preserve adjacent JSON objects",
    input: '[{"HTTP_AUTHORIZATION":[redacted],Basic dXNlcjpwYXNzd29yZA==},{"status":"failed"}]',
    expected: '[{"HTTP_AUTHORIZATION":[redacted]},{"status":"failed"}]',
    secrets: ["dXNlcjpwYXNzd29yZA=="],
  },
  {
    name: "an adjacent redacted field cannot conceal an attached Basic tail",
    input: "HTTP_AUTHORIZATION=[redacted] password=[redacted],Basic tiny",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["tiny"],
  },
  {
    name: "an adjacent redacted field cannot conceal a whitespace Basic tail",
    input: "HTTP_AUTHORIZATION=[redacted] password=[redacted] Basic tiny",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["tiny"],
  },
  {
    name: "headers embedded in JSON text respect escaped quotes and outer structure",
    input: JSON.stringify({ message: 'HTTP_AUTHORIZATION=Digest username="a}b", response="synthetic-wrapped-header"' }),
    expected: JSON.stringify({ message: "HTTP_AUTHORIZATION=[redacted]" }),
    secrets: ["synthetic-wrapped-header"],
  },
] as const;
const boundaryRegressionCases = [
  {
    name: "a diagnostic closing brace cannot authorize an attached Basic tail",
    input: '{"HTTP_AUTHORIZATION":[redacted] code=500}Basic tiny,"status":"failed"}',
    expected: '{"HTTP_AUTHORIZATION":[redacted],"status":"failed"}',
    secrets: ["tiny"],
  },
  {
    name: "a spaced closing brace cannot authorize an attached Basic tail",
    input: '{"HTTP_AUTHORIZATION":[redacted] }Basic tiny,"status":"failed"}',
    expected: '{"HTTP_AUTHORIZATION":[redacted],"status":"failed"}',
    secrets: ["tiny"],
  },
  {
    name: "a redacted field closing brace cannot authorize an attached Basic tail",
    input: '{"HTTP_AUTHORIZATION":[redacted] password=[redacted]}Basic tiny,"status":"failed"}',
    expected: '{"HTTP_AUTHORIZATION":[redacted],"status":"failed"}',
    secrets: ["tiny"],
  },
  {
    name: "diagnostics preserve valid object endings and adjacent array objects",
    input: '[{"HTTP_AUTHORIZATION":[redacted] code=500},{"credentials":"synthetic valid neighbor"}]',
    expected: '[{"HTTP_AUTHORIZATION":[redacted] code=500},{"credentials":[redacted]}]',
    secrets: ["synthetic valid neighbor"],
  },
  {
    name: "a spaced valid object ending preserves nested surrounding containers",
    input: '{"nested":{"HTTP_AUTHORIZATION":[redacted] },"status":"failed"}',
    expected: '{"nested":{"HTTP_AUTHORIZATION":[redacted] },"status":"failed"}',
    secrets: [],
  },
  {
    name: "top-level double quoted URL scalars retain their own quote boundary",
    input: JSON.stringify("https://example.invalid/?token=synthetic'query-tail"),
    expected: '"https://example.invalid/[redacted]"',
    secrets: ["synthetic'query-tail", "query-tail"],
  },
  {
    name: "top-level single quoted URL scalars retain their own quote boundary",
    input: "'https://example.invalid/?token=synthetic\"query-tail'",
    expected: "'https://example.invalid/[redacted]'",
    secrets: ['synthetic"query-tail', "query-tail"],
  },
  {
    name: "top-level quoted URL scalars respect escaped quotes and ampersands",
    input: JSON.stringify('https://example.invalid/?token=synthetic\\"escaped-query&view=summary'),
    expected: '"https://example.invalid/[redacted]&view=summary"',
    secrets: ["synthetic", "escaped-query"],
  },
  {
    name: "top-level single quoted URL scalars respect escaped single quotes",
    input: "'https://example.invalid/?token=synthetic\\'escaped-query'",
    expected: "'https://example.invalid/[redacted]'",
    secrets: ["synthetic", "escaped-query"],
  },
  {
    name: "array URL scalars use the same boundary as top-level URL scalars",
    input: JSON.stringify(["https://example.invalid/?token=synthetic'array-query", { credentials: "synthetic scalar neighbor" }]),
    expected: '["https://example.invalid/[redacted]",{"credentials":[redacted]}]',
    secrets: ["synthetic'array-query", "array-query", "synthetic scalar neighbor"],
  },
  {
    name: "object URL strings use the same boundary as top-level URL scalars",
    input: JSON.stringify({ url: "https://example.invalid/?token=synthetic'query-tail" }),
    expected: '{"url":"https://example.invalid/[redacted]"}',
    secrets: ["synthetic'query-tail", "query-tail"],
  },
  {
    name: "quoted credential assignment keys still redact their complete quoted value",
    input: '"credentials"="synthetic quoted credential" status=failed',
    expected: '"credentials"=[redacted] status=failed',
    secrets: ["synthetic quoted credential", "quoted credential"],
  },
  {
    name: "ordinary diagnostic quotes do not change credential header parsing",
    input: 'diagnostic "ordinary text" HTTP_AUTHORIZATION=Digest username="a}b", response="synthetic diagnostic response"',
    expected: 'diagnostic "ordinary text" HTTP_AUTHORIZATION=[redacted]',
    secrets: ["synthetic diagnostic response"],
  },
  {
    name: "a leading quoted diagnostic still permits later quoted credential assignments",
    input: '"ordinary diagnostic" password="synthetic quoted password"',
    expected: '"ordinary diagnostic" password=[redacted]',
    secrets: ["synthetic quoted password"],
  },
  {
    name: "a diagnostic code does not authorize an unknown header suffix",
    input: 'HTTP_AUTHORIZATION=[redacted] code=500 response="synthetic-response"',
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-response"],
  },
  {
    name: "consecutive status and code diagnostics do not authorize unknown parameters",
    input: 'HTTP_AUTHORIZATION=[redacted] status=failed code=500 response="synthetic-chain-response"',
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-chain-response"],
  },
  {
    name: "the complete diagnostic and redacted field chain remains readable",
    input: "HTTP_AUTHORIZATION=[redacted] status=failed code=500 password=[redacted] token=[redacted]",
    expected: "HTTP_AUTHORIZATION=[redacted] status=failed code=500 password=[redacted] token=[redacted]",
    secrets: [],
  },
  {
    name: "a safe field chain cannot authorize a later unknown parameter",
    input: "HTTP_AUTHORIZATION=[redacted] password=[redacted] status=failed code=500 response=synthetic-late-response",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-late-response"],
  },
  {
    name: "a diagnostic field cannot authorize a following Basic scheme",
    input: "HTTP_AUTHORIZATION=[redacted] code=500 Basic tiny",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["tiny"],
  },
  {
    name: "quoted diagnostic atoms have explicit value boundaries",
    input: 'HTTP_AUTHORIZATION=[redacted] status="failed" code="500" password=[redacted]',
    expected: 'HTTP_AUTHORIZATION=[redacted] status="failed" code="500" password=[redacted]',
    secrets: [],
  },
  {
    name: "quoted diagnostics cannot absorb arbitrary header text as a safe value",
    input: 'HTTP_AUTHORIZATION=[redacted] status="failed response=synthetic-status-secret"',
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-status-secret"],
  },
  {
    name: "numeric diagnostic codes cannot absorb attached header parameters",
    input: "HTTP_AUTHORIZATION=[redacted] code=500,response=synthetic-attached-response",
    expected: "HTTP_AUTHORIZATION=[redacted]",
    secrets: ["synthetic-attached-response"],
  },
  {
    name: "atomic named diagnostic codes remain readable before redacted fields",
    input: 'HTTP_AUTHORIZATION=[redacted] status="failed" code=EACCES credentials=[redacted]',
    expected: 'HTTP_AUTHORIZATION=[redacted] status="failed" code=EACCES credentials=[redacted]',
    secrets: [],
  },
  {
    name: "empty query values cannot consume a neighboring short Authorization scheme",
    input: '{"url":"https://example.invalid/?token=","Authorization":"Basic tiny"}',
    expected: '{"url":"https://example.invalid/[redacted]","Authorization":[redacted]}',
    secrets: ["tiny"],
  },
  {
    name: "an opposite quote stays inside the containing JSON URL string",
    input: JSON.stringify({ url: "https://example.invalid/?token=synthetic'quoted-query", password: "synthetic quoted password" }),
    expected: '{"url":"https://example.invalid/[redacted]","password":[redacted]}',
    secrets: ["synthetic'quoted-query", "quoted-query", "synthetic quoted password"],
  },
  {
    name: "unquoted URL queries preserve ampersands and whitespace diagnostics",
    input: "https://example.invalid/?token=synthetic-query&view=summary status=failed password=synthetic-password",
    expected: "https://example.invalid/[redacted]&view=summary status=failed password=[redacted]",
    secrets: ["synthetic-query", "synthetic-password"],
  },
  {
    name: "query values cannot consume a neighboring short Authorization scheme",
    input: '{"url":"https://example.invalid/?token=query","Authorization":"Bearer tiny"}',
    expected: '{"url":"https://example.invalid/[redacted]","Authorization":[redacted]}',
    secrets: ["query", "tiny"],
  },
  {
    name: "query values cannot consume a neighboring quoted credentials field",
    input: '{"url":"https://example.invalid/?token=query","credentials":"synthetic spaced credential"}',
    expected: '{"url":"https://example.invalid/[redacted]","credentials":[redacted]}',
    secrets: ["query", "synthetic spaced credential", "spaced credential"],
  },
  {
    name: "query values cannot consume a neighboring quoted password field",
    input: '{"url":"https://example.invalid/?token=query","password":"synthetic spaced password"}',
    expected: '{"url":"https://example.invalid/[redacted]","password":[redacted]}',
    secrets: ["query", "synthetic spaced password", "spaced password"],
  },
  {
    name: "query scanning respects escaped quotes inside JSON strings",
    input: JSON.stringify({ url: 'https://example.invalid/?token=synthetic-escaped-query"tail', password: "synthetic escaped password" }),
    expected: '{"url":"https://example.invalid/[redacted]","password":[redacted]}',
    secrets: ["synthetic-escaped-query", "tail", "synthetic escaped password", "escaped password"],
  },
  {
    name: "query scanning respects escaped backslashes before a JSON closing quote",
    input: JSON.stringify({ url: "https://example.invalid/?token=synthetic-slash-query\\", Authorization: "Basic tiny" }),
    expected: '{"url":"https://example.invalid/[redacted]","Authorization":[redacted]}',
    secrets: ["synthetic-slash-query", "tiny"],
  },
  {
    name: "query redaction preserves ordinary URL ampersand parameters and the next field",
    input: '{"url":"https://example.invalid/?token=query&view=summary&access_token=other-query&mode=plain","Authorization":"Bearer tiny"}',
    expected: '{"url":"https://example.invalid/[redacted]&view=summary[redacted]&mode=plain","Authorization":[redacted]}',
    secrets: ["query", "other-query", "tiny"],
  },
  {
    name: "queries preserve neighboring array objects and credential fields",
    input: '[{"url":"https://example.invalid/?token=query"},{"credentials":"synthetic array credential"}]',
    expected: '[{"url":"https://example.invalid/[redacted]"},{"credentials":[redacted]}]',
    secrets: ["query", "synthetic array credential", "array credential"],
  },
  {
    name: "query boundaries also preserve single-quoted fields",
    input: "{'url':'https://example.invalid/?token=query','password':'synthetic single password'}",
    expected: "{'url':'https://example.invalid/[redacted]','password':[redacted]}",
    secrets: ["query", "synthetic single password", "single password"],
  },
  {
    name: "enclosing quoted credentials take precedence over nested queries",
    input: '{"credentials":"https://example.invalid/?token=synthetic-nested-query with spaces","Authorization":"Bearer tiny"}',
    expected: '{"credentials":[redacted],"Authorization":[redacted]}',
    secrets: ["synthetic-nested-query", "with spaces", "tiny"],
  },
] as const;
const markerTailBoundaryCases = ["", " code=500", " code=500 ", " password=[redacted]"].flatMap(diagnostic =>
  ["Basic tiny", "Bearer tiny", 'response="synthetic-tail"'].map(tail => ({
    name: `attached brace tails remain private after ${JSON.stringify(diagnostic)} before ${tail}`,
    input: `{"HTTP_AUTHORIZATION":[redacted]${diagnostic}}${tail},"status":"failed"}`,
    expected: '{"HTTP_AUTHORIZATION":[redacted],"status":"failed"}',
    secrets: [tail.includes("tiny") ? "tiny" : "synthetic-tail"],
  })));
const quotedQueryBoundaryCases = [
  "synthetic'query-tail",
  'synthetic"query-tail',
  "synthetic\\'query-tail",
  "synthetic'query-tail\\",
].flatMap(secret => ["\"", "'"].flatMap(quote => {
  const encode = (value: string) => quote + value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`) + quote;
  const input = encode(`https://example.invalid/?token=${secret}&view=summary`);
  const expected = encode("https://example.invalid/[redacted]&view=summary");
  return [
    { shape: "root", input, expected },
    { shape: "array", input: `[${input}]`, expected: `[${expected}]` },
    { shape: "object", input: `{${quote}url${quote}:${input}}`, expected: `{${quote}url${quote}:${expected}}` },
  ].map(value => ({
    name: `${value.shape} quoted URL boundary ${JSON.stringify(quote)} with ${JSON.stringify(secret)}`,
    input: value.input,
    expected: value.expected,
    secrets: ["synthetic", "query-tail"],
  }));
}));
for (const { name, input, expected } of [...scannerRegressionCases, ...boundaryRegressionCases, ...markerTailBoundaryCases, ...quotedQueryBoundaryCases]) {
  test(name, () => {
    assert.equal(sanitizeObservation(input), expected);
    assert.equal(sanitizeObservation(expected), expected, "Sanitized structure is idempotent");
  });
}

test("bounded scanning preserves nested containers, primitive neighbors and diagnostic boundaries", () => {
  const cases = [
    ['[{"password":"synthetic"},["ordinary spaced text"],false,null,3,{"credentials":"another spaced secret"}]', '[{"password":[redacted]},["ordinary spaced text"],false,null,3,{"credentials":[redacted]}]'],
    ['{"credentials":{"password":"nested secret"},"status":"failed"}', '{"credentials":[redacted],"status":"failed"}'],
    ['{"credentials":[[redacted],{"password":"nested secret"}],"status":"failed"}', '{"credentials":[redacted],"status":"failed"}'],
    ['{"HTTP_AUTHORIZATION":[redacted] , "password":[redacted]}', '{"HTTP_AUTHORIZATION":[redacted] , "password":[redacted]}'],
    ["HTTP_AUTHORIZATION=[redacted] STATUS=failed", "HTTP_AUTHORIZATION=[redacted] STATUS=failed"],
    ["HTTP_AUTHORIZATION=[redacted] code: 500", "HTTP_AUTHORIZATION=[redacted] code: 500"],
    ["HTTP_AUTHORIZATION=[redacted] password=[redacted] token=[redacted]", "HTTP_AUTHORIZATION=[redacted] password=[redacted] token=[redacted]"],
    ["HTTP_AUTHORIZATION=[redacted],Basic tiny status: failed", "HTTP_AUTHORIZATION=[redacted]"],
    ["HTTP_AUTHORIZATION=[redacted] Basic tiny status: failed", "HTTP_AUTHORIZATION=[redacted]"],
    ["password=[redacted] ordinary diagnostic words", "password=[redacted] ordinary diagnostic words"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeObservation(input), expected, input);
    assert.equal(sanitizeObservation(expected), expected, "Repeated scans preserve structure and plain text");
  }
});

function checkRedactionPipeline(cases: readonly { input: string; expected: string; secrets: readonly string[] }[]): void {
  const dir = mkdtempSync(join(tmpdir(), "mesh-obs-scanner-"));
  try {
    const mesh = new Observability(() => 5_000);
    mesh.attach(dir);
    cases.forEach(({ input: error }, i) => {
      mesh.tool({ origin: "child", name: `tool-${i}`, outcome: "error", error });
      mesh.role({ event: "failed", roleId: `role-${i}`, error });
      mesh.task({ event: "failed", taskId: `task-${i}`, error });
      mesh.workflow({ event: "step_failed", workflowId: `workflow-${i}`, error });
      mesh.control({ event: "command", name: `command-${i}`, outcome: "error", error });
    });
    mesh.flush();
    const check = (observer: Observability) => {
      const disk = readFileSync(join(dir, "observability.json"), "utf8");
      for (const output of [observer.report("all", 200), observer.toJSON(200), disk]) {
        for (const { secrets } of cases) {
          for (const secret of secrets) assert.equal(output.includes(secret), false, secret);
        }
      }
      for (const snapshot of [JSON.parse(observer.toJSON(200)), JSON.parse(disk)]) {
        cases.forEach(({ expected }, i) => {
          assert.equal(snapshot.tools[`child:tool-${i}`].lastError, expected);
          assert.equal(snapshot.roles[`role-${i}`].lastError, expected);
          for (const event of snapshot.events.slice(i * 5, i * 5 + 5)) assert.equal(event.error, expected);
        });
        assert.equal(snapshot.events.length, cases.length * 5);
      }
    };
    check(mesh);
    const reloaded = new Observability(() => 6_000);
    reloaded.attach(dir);
    check(reloaded);
    // Legacy plaintext errors must also be sanitized on import, not just creation.
    const saved = JSON.parse(readFileSync(join(dir, "observability.json"), "utf8"));
    cases.forEach(({ input }, i) => {
      saved.tools[`child:tool-${i}`].lastError = input;
      saved.roles[`role-${i}`].lastError = input;
      for (const event of saved.events.slice(i * 5, i * 5 + 5)) event.error = input;
    });
    writeFileSync(join(dir, "observability.json"), JSON.stringify(saved));
    const legacy = new Observability(() => 7_000);
    legacy.attach(dir);
    check(legacy);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("structured and complete-header errors stay redacted through exports, disk and reload", () => {
  const cases = [...scannerRegressionCases, ...boundaryRegressionCases, ...markerTailBoundaryCases, ...quotedQueryBoundaryCases];
  // Keep every batch below export/cardinality caps so assertions inspect actual
  // errors, not privacy achieved only by omitting an oversized event category.
  for (let first = 0; first < cases.length; first += 12) checkRedactionPipeline(cases.slice(first, first + 12));
});

test("compound credential suffixes stay readable but never expose their values", () => {
  for (const [field, value] of compoundCredentials) {
    for (const [input, expected] of [
      [`${field}=${value}`, `${field}=[redacted]`],
      [JSON.stringify({ [field]: value }), `{"${field}":[redacted]}`],
    ]) {
      assert.equal(sanitizeObservation(input), expected, input);
      assert.equal(sanitizeObservation(expected), expected, "Compound redaction is idempotent");
    }
  }
});

test("unquoted credential punctuation is conservatively part of the value", () => {
  for (const [field, value] of punctuatedCredentials) {
    const expected = `${field}=[redacted] status=failed`;
    assert.equal(sanitizeObservation(`${field}=${value} status=failed`), expected);
    assert.equal(sanitizeObservation(expected), expected, "Punctuation redaction is idempotent");
  }
  // Without whitespace/quotes, commas, semicolons and ampersands are ambiguous:
  // prefer masking a possible credential tail over retaining a possible field.
  for (const separator of [",", ";", "&"]) {
    assert.equal(sanitizeObservation(`password=synthetic${separator}status=failed`), "password=[redacted]");
  }
  assert.equal(sanitizeObservation("status=failed code=500 /tmp/build-output"), "status=failed code=500 /tmp/build-output");
  assert.equal(sanitizeObservation("password=x token=y"), "password=[redacted] token=[redacted]");
  assert.equal(sanitizeObservation("diagnostic ".repeat(100))?.length, 240);
  assert.equal(sanitizeObservation("password=" + "synthetic".repeat(1000)), "password=[redacted]");
});

test("error credentials never reach report, JSON or persisted lastError and events", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-obs-redaction-"));
  try {
    const mesh = new Observability(() => 5_000);
    const fixtures = [
      ["Authorization: Bearer synthetic-bearer-token", "synthetic-bearer-token"],
      ["AUTHORIZATION: Basic c3ludGhldGljOnBhc3N3b3Jk", "c3ludGhldGljOnBhc3N3b3Jk"],
      ['{"credentials": "synthetic quoted credential"}', "synthetic quoted credential"],
      ['api key: "synthetic spaced key"', "synthetic spaced key"],
      ...[...compoundCredentials, ...punctuatedCredentials].map(([field, value]) => [`${field}=${value}`, value]),
      ...[...authorizationSuffixCases, ...redactionMarkerSuffixCases].map(([input, , secret]) => [input, secret]),
    ];
    const secretParts = fixtures.flatMap(([, credential]) => credential.split(/[,;&]/).filter(Boolean));
    mesh.attach(dir, "synthetic-session");
    fixtures.forEach(([error], i) => {
      mesh.tool({ origin: "child", name: `tool-${i}`, outcome: "error", error });
      mesh.role({ event: "failed", roleId: `role-${i}`, error });
      mesh.task({ event: "failed", taskId: `task-${i}`, error });
      mesh.workflow({ event: "step_failed", workflowId: `workflow-${i}`, error });
      mesh.control({ event: "command", name: `command-${i}`, outcome: "error", error });
    });
    mesh.flush();
    const disk = readFileSync(join(dir, "observability.json"), "utf8");
    for (const output of [mesh.report("all", 200), mesh.toJSON(200), disk]) {
      for (const credential of secretParts) assert.equal(output.includes(credential), false, credential);
      assert.match(output, /\[redacted\]/);
    }
    const saved = JSON.parse(disk);
    assert.equal(Object.keys(saved.tools).length, fixtures.length);
    assert.equal(Object.keys(saved.roles).length, fixtures.length);
    for (const stat of [...Object.values(saved.tools), ...Object.values(saved.roles)] as { lastError: string }[]) {
      assert.match(stat.lastError, /\[redacted\]/);
    }
    assert.equal(saved.events.length, fixtures.length * 5);
    for (const event of saved.events) assert.match(event.error, /\[redacted\]/);
    // Simulate pre-fix persistence: loading must sanitize old plaintext errors too.
    Object.values(saved.tools).forEach((stat, i) => { (stat as { lastError: string }).lastError = fixtures[i][0]; });
    Object.values(saved.roles).forEach((stat, i) => { (stat as { lastError: string }).lastError = fixtures[i][0]; });
    saved.events.forEach((event: { error: string }, i: number) => { event.error = fixtures[Math.floor(i / 5)][0]; });
    writeFileSync(join(dir, "observability.json"), JSON.stringify(saved));
    const reloaded = new Observability(() => 6_000);
    reloaded.attach(dir);
    for (const output of [reloaded.report("all", 200), reloaded.toJSON(200), readFileSync(join(dir, "observability.json"), "utf8")]) {
      for (const credential of secretParts) assert.equal(output.includes(credential), false, credential);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("JSON snapshots remain parseable and explicitly bounded without misleading totals", () => {
  const mesh = new Observability(() => 5_000);
  const small = JSON.parse(mesh.toJSON());
  assert.equal(small.version, 1);
  assert.equal(small.truncated, undefined);
  assert.equal(small.totals, undefined, "Small snapshots retain the existing shape");
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 18; j++) {
      mesh.tool({ origin: "child", name: `tool-${i}`, roleId: `role-${j}`, action: `action_${String.fromCharCode(97 + j)}`,
        outcome: "error", error: "synthetic diagnostic ".repeat(15) });
    }
  }
  const text = mesh.toJSON(200);
  const snapshot = JSON.parse(text);
  assert.ok(text.length <= 64_000, `Snapshot contains ${text.length} characters`);
  assert.equal(snapshot.truncated.maxCharacters, 64_000);
  assert.ok(snapshot.truncated.omitted.events > 0);
  assert.ok(snapshot.truncated.omitted.tools > 0, "Large tool categories must also be bounded");
  assert.deepEqual(snapshot.totals, mesh.totals(), "Totals cover the full session, not retained detail rows");
  assert.equal(snapshot.totals.toolCalls, 1800);
  assert.deepEqual(snapshot.privacy, { arguments: "omitted", results: "omitted", prompts: "omitted" });
  assert.equal(mesh.totals().toolCalls, 1800, "Export pruning never mutates live counters");
  assert.equal(JSON.parse(mesh.toJSON(1)).totals.toolCalls, 1800);
  const inflight = new Observability(() => 5_000);
  for (let i = 0; i < 1000; i++) inflight.beginTool(`key-${i}`, { origin: "parent", name: "read" });
  const openText = inflight.toJSON();
  assert.ok(openText.length <= 64_000);
  const openSnapshot = JSON.parse(openText);
  assert.equal(openSnapshot.truncated.omitted.inflight, 1000);
  assert.equal(openSnapshot.totals.toolCalls, 0);

  const dir = mkdtempSync(join(tmpdir(), "mesh-obs-json-"));
  try {
    mesh.attach(dir, "synthetic-session");
    const persisted = JSON.parse(readFileSync(join(dir, "observability.json"), "utf8"));
    assert.equal(persisted.truncated, undefined, "Export pruning does not truncate persistence");
    assert.equal(Object.keys(persisted.tools).length, 97);
    assert.equal(persisted.events.length, 400);
    const longSession = new Observability(() => 5_000);
    longSession.attach(join(dir, "long-session"), "s".repeat(70_000));
    const sessionText = longSession.toJSON();
    assert.ok(sessionText.length <= 64_000);
    const sessionSnapshot = JSON.parse(sessionText);
    assert.equal(sessionSnapshot.truncated.omitted.sessionId, 1);
    assert.equal(sessionSnapshot.sessionId, undefined);
    assert.deepEqual(sessionSnapshot.totals, longSession.totals());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("report headers occupy separate lines with a blank line before the section", () => {
  const mesh = new Observability(() => 1_000);
  assert.equal(mesh.report("tools"), [
    "Agent mesh observability",
    "Counts are cumulative for this parent session. Tool arguments, results and prompts are omitted. Errors are truncated and redacted.",
    "Started: 1970-01-01T00:00:01.000Z · Updated: 1970-01-01T00:00:01.000Z",
    "Persistence: memory only",
    "Tools: 0 calls · 0 ok · 0 error · 0 blocked · 0 aborted · success n/a",
    "Roles created: 0 · role runs: 0 · tasks launched: 0 · task failures: 0",
    "In flight: 0 · dropped events: 0",
    "",
    "Tools",
    "  No tool calls recorded.",
  ].join("\n"));
});

test("cardinality, event ring and persistence merge without double counting or treating inflight as success", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-obs-"));
  try {
    const first = new Observability(() => 5_000);
    for (let i = 0; i < 97; i++) first.tool({ origin: "child", name: `tool-${i}`, outcome: "success" });
    assert.equal(first.totals().toolCalls, 97);
    assert.match(first.report("tools"), /other tools \(cardinality cap\)/);
    for (let i = 0; i < 401; i++) first.control({ event: "command", name: "ping", outcome: "success" });
    assert.match(first.report("events", 10), /older events dropped/);
    first.attach(dir, "session-a");
    first.flush();
    const second = new Observability(() => 6_000);
    second.tool({ origin: "parent", name: "subagent", outcome: "success" });
    second.beginTool("child:open:1", { origin: "child", name: "read" });
    second.attach(dir, "session-a");
    second.attach(dir, "session-a");
    assert.equal(second.totals().toolCalls, 98, "Reload merges prior calls once and keeps the new call");
    assert.equal(second.totals().toolSuccesses, 98);
    const reloaded = new Observability(() => 7_000);
    reloaded.attach(dir, "session-a");
    assert.equal(reloaded.totals().toolAborted, 1, "Unfinished calls from the previous process are aborted, not successful");
    assert.equal(reloaded.totals().toolSuccesses, 98);
    writeFileSync(join(dir, "observability.json"), "{not json");
    const dirty = new Observability(() => 8_000);
    dirty.role({ event: "created", roleId: "reviewer", taskId: "kept" });
    assert.doesNotThrow(() => dirty.attach(dir, "session-b"));
    assert.match(dirty.report("roles"), /reviewer  created=1/);
    assert.match(dirty.report("controls"), /persistence:reset:error=1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("child tool success, role creation and observer failures are recorded without changing execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-tasks-"));
  const mesh = new Observability();
  mesh.attach(dir, "session");
  const manager = new TaskManager(new TaskStore(dir), {
    command: process.execPath, createRpc: launch => new RpcProcess({ ...launch, args: [fake] }, 1000, 25), observe: mesh,
  });
  const throwing = new TaskManager(new TaskStore(join(dir, "throw")), {
    command: process.execPath, createRpc: launch => new RpcProcess({ ...launch, args: [fake] }, 1000, 25),
    observe: { tool() { throw new Error("boom"); }, task() { throw new Error("boom"); }, role() { throw new Error("boom"); }, workflow() { throw new Error("boom"); }, control() { throw new Error("boom"); },
      beginTool() { throw new Error("boom"); }, endTool() { throw new Error("boom"); }, abandonTools() { throw new Error("boom"); } },
  });
  const workflows = new WorkflowManager(manager, join(dir, "workflows"), undefined, mesh);
  try {
    const record = await manager.launch({ task: "investigate", access: "read-only", context: "none", loadout: loadout(dir) });
    await until(() => record.stopped);
    assert.equal(record.state, "completed");
    assert.equal(mesh.totals().toolSuccesses >= 1, true);
    assert.match(mesh.report("tools"), /child read  calls=1 ok=1/);
    assert.match(mesh.report("tasks"), /launched=1/);
    assert.match(mesh.report("tasks"), /completed=1/);
    assert.match(mesh.report("tasks"), /preflight_ok=1/);
    const prompt = "Saved body";
    const plan: RolePlan = { version: 1, schemaVersion: 1, promptVersion: 1, roleId: "builder", manifestPath: join(dir, "role.yaml"), manifestHash: digest("manifest"),
      systemPrompt: prompt, systemPromptHash: digest(prompt), skills: [], builtinTools: ["read"], extraTools: [], mcp: [],
      model: "fake/test", thinking: "off", context: "none", access: "full", cwd: dir, agentDir: dir };
    await assert.rejects(manager.launch({ task: "role work", access: "full", context: "none", rolePlan: plan }));
    assert.equal(mesh.totals().rolesCreated, 1);
    assert.match(mesh.report("roles"), /builder  created=1 standalone=1 workflow=0/);
    assert.match(mesh.report("roles"), /preflight ok=0 failed=1/);
    assert.match(mesh.report("tasks"), /preflight_failed=1/);
    const flow = workflows.launch({ context: "none", loadout: loadout(dir), steps: [{ id: "read", task: "look", access: "read-only", dependsOn: [] } satisfies StepDefinition] });
    assert.match(mesh.report("workflows"), /launched=1/);
    assert.equal(flow.state, "running");
    const noisy = await throwing.launch({ task: "still completes", access: "read-only", context: "none", loadout: loadout(dir) });
    await until(() => noisy.stopped);
    assert.equal(noisy.state, "completed");
    assert.doesNotMatch(noisy.error ?? "", /boom/);
    const saved = JSON.parse(readFileSync(join(dir, "observability.json"), "utf8"));
    assert.equal(saved.privacy.arguments, "omitted");
    assert.equal(JSON.stringify(saved).includes("src/auth.ts"), false);
  } finally {
    await workflows.shutdown();
    await manager.shutdown();
    await throwing.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
