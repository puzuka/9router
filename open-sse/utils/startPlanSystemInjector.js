// ZCode "start-plan" gateway does content inspection on the request body: if the
// `system` field does not carry the ZCode identity blocks, zcode.z.ai answers
// HTTP 405 with business code 3012 "request has been blocked due to unusual
// activity" (the reverse-engineered proxy documents the same 3012 as
// "method not allowed").
//
// Text below is byte-identical to ZCode 3.14.3 (zai-org/ZCode):
//   apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts  → CLI Prefix
//   apps/zcode-cli/packages/core/src/context/sections/identity.ts    → Agent Identity + # Harness
// Order mirrors ContextBuilder.assembleSystemMessages: CLI Prefix, then the
// stable identity block, then the client's own system blocks.
//
// ponytail: prompt text pinned to that release — re-extract when a new ZCode
// build changes identity.ts, otherwise the gateway may start rejecting again.
const CLI_PREFIX = "You are ZCode, an interactive coding agent";

const IDENTITY = "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";

const ephemeral = () => ({ type: "ephemeral" });

export function injectStartPlanSystem({ provider, body, credentials }) {
  if (provider !== "glm-start" || !body || typeof body !== "object") return body;
  const system = body.system;

  // transformRequest runs once per retry attempt — never stack the blocks twice.
  const firstText =
    typeof system === "string"
      ? system
      : Array.isArray(system) && system[0] && typeof system[0] === "object"
        ? system[0].text
        : "";
  const next = firstText === CLI_PREFIX
    ? body
    : {
        ...body,
        system: [
          { type: "text", text: CLI_PREFIX, cache_control: ephemeral() },
          { type: "text", text: IDENTITY, cache_control: ephemeral() },
          ...normalizeSystem(system),
        ],
      };

  // ZCode binds the account to the request (Anthropic metadata.user_id).
  const userId = credentials?.providerSpecificData?.userId;
  if (userId && !next.metadata?.user_id) {
    return { ...next, metadata: { ...(next.metadata || {}), user_id: userId } };
  }
  return next;
}

function normalizeSystem(system) {
  if (system == null) return [];
  if (typeof system === "string") {
    return system.trim() ? [{ type: "text", text: system }] : [];
  }
  if (!Array.isArray(system)) return [];
  const blocks = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) blocks.push({ type: "text", text: item });
    } else if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()) {
      blocks.push({ ...item });
    }
  }
  return blocks;
}
