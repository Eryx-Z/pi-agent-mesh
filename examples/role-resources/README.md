# Optional role resources (not the baseline demo)

These independent examples extend the [minimal builtin team](../team/README.md). Nothing here is enabled by the offline role demo or its tests. Requires aligned Pi 1.0.2+ (verified baseline 1.0.2), a persistent parent session and trusted executable resources. Local imports and MCP require host project trust; `full` is required to enable them. `read-only` removes both before loading/connecting, regardless of a server's read-only hints. Access is not a sandbox.

## Validate without executing resources

From the package root, with installed dependencies and the optional `tsx` runner:

```sh
node --import tsx examples/role-resources/validate.ts
```

This calls the **production RoleCatalog** on all three authored team YAML files, including role manifests and builtin PM. It only reads configuration/resource bytes: it does not import the tool factory, invoke server commands or make network connections. For static validation only, the script temporarily supplies a dummy HTTP token if none exists. It prints no credential values. Successful parsing establishes neither executable compatibility nor service readiness.

## 1. Local tool-only extension

`local/team.yaml` selects `greeter`, whose role declares exactly `greet` from `greeting.ts`. The factory only registers one tool; execution returns a deterministic greeting with no filesystem or network I/O. It registers no hooks, commands, flags, providers or MCP servers. Imports still execute trusted JavaScript: this contract is not a code sandbox.

Optional real-model trial from the package root, **only after reviewing the resource and granting Pi project trust**:

```sh
PI_AGENT_MESH_CONFIG="$PWD/examples/role-resources/local/team.yaml" pi
```

Ask PM to call `subagent` with `{"role":"greeter","task":"Use greet with name Ada and report the actual result"}`. The role defaults to `none` context and full access. New roles require only config/resources, not scheduler changes. This interactive command consumes your configured model quota; it is not run by validation/tests.

## 2. Stdio filesystem MCP (external prerequisite)

`stdio/team.yaml` uses executable `mcp-server-filesystem` with literal argument `.` and explicit `cwd: .`. Install/provide a reviewed compatible `@modelcontextprotocol/server-filesystem` executable on PATH **separately** before trying it; this package does not install or download it. No `npx` or shell command is launched implicitly. Server/version compatibility is not established by this example.

The server cwd canonicalizes relative to this team YAML, so its allowed directory is `examples/role-resources/stdio/`, not your project or an isolated task's cwd. If you copy the configuration, review/restrict that path explicitly. Only the server's exact raw name **`list_directory`** is selected. Verify that raw name against the installed server version; do not substitute a guessed Pi-wrapped tool name. Other filesystem operations and automatically generated resource tools are not authorized.

Optional launch after installing/reviewing the server and granting project trust:

```sh
PI_AGENT_MESH_CONFIG="$PWD/examples/role-resources/stdio/team.yaml" pi
```

Ask PM to dispatch `directory_reader` to list the allowed directory using the selected MCP tool. Catalog inspection does not spawn the server; dispatch preflight does. A missing executable/tool or failed readiness prevents model submission. **No server command was executed to validate this example; readiness is not established.**

## 3. Streamable HTTP MCP (illustrative placeholder)

`http/team.yaml` is intentionally **not runnable until configured**. `https://mcp.example.invalid/mcp` is a reserved non-resolving placeholder, not a live service. Replace it with a trusted Streamable HTTP MCP endpoint. The selected exact raw name **`lookup_document`** is an authored hypothetical contract, not a claim about a real server: replace it in both manifest and instructions if your endpoint exposes a different name. Obtain the actual schema/name through your server's trusted documentation or controlled discovery before granting access.

The header uses Pi's `${ROLE_RESOURCES_HTTP_TOKEN}` environment reference; set a real token out of band only for your configured endpoint. Missing references are diagnosed even during parsing. Plans retain the reference, not the resolved token. Do not paste secrets into YAML, prompts or tool output. This example adds no OAuth/login flow or credential-command evaluation.

After replacing the endpoint/tool and granting host project trust, the **opt-in** launch is:

```sh
# Set ROLE_RESOURCES_HTTP_TOKEN securely in your environment first.
PI_AGENT_MESH_CONFIG="$PWD/examples/role-resources/http/team.yaml" pi
```

Ask PM to dispatch `document_reader` with an explicit document assignment. No external endpoint or login is contacted by static validation/tests. **HTTP service readiness, authentication and tool compatibility remain unverified.**

## Shared boundaries

Each manifest references only its team's named service and exact raw tools. Ambient `mcp.json` is not merged. Native Pi generates the actual exposed tool names; do not manually construct wrappers. MCP preflight must discover every required tool within the role readiness deadline before any worker model request. Remote results remain untrusted data, and HTTP client close does not stop the remote service or undo side effects. Local/stdio executable code must be reviewed independently of these declarative examples.
