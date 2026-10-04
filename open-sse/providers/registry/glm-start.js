import { ANTHROPIC_API_VERSION } from "../shared.js";

// ZCode desktop release the identity headers below are copied from.
// ponytail: pinned constant — bump when ZCode ships a new major.
const ZCODE_APP_VERSION = "3.14.3";

// Z.ai "Start Plan" (free trial / promo quota). Unlike the paid Coding Plan,
// trial traffic is served by the ZCode platform gateway, not api.z.ai:
// ZCode's builtin catalog (config/provider/zcode-builtin.json,
// `account:zai-start-plan`) declares api.type "anthropic-messages" with
// baseUrl https://zcode.z.ai/api/v1/zcode-plan/anthropic.
//
// Credential = the ZCode JWT from the login flow (`token` in the poll `ready`
// payload), not a coding-plan API key: ZCode's
// accountProviderRequestAuthService maps start-plan -> { apiKey: zcodeJwtToken },
// and its anthropic path sends that key as x-api-key AND as
// `Authorization: Bearer` (withAnthropicAuthorizationHeader). Requests also
// carry the ZCode source headers (@zcode/shared zcode-source-headers.ts) —
// without them the gateway can reject the client as non-official.
const glmStart = {
  id: "glm-start",
  priority: 141,
  alias: "glm-start",
  display: {
    name: "Zai Start Plan",
    icon: "code",
    color: "#7C3AED",
    textIcon: "ZS",
    website: "https://zcode.z.ai",
    notice: {
      signupUrl: "https://chat.z.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  oauth: {
    providerId: "zai",
    planKind: "start-plan",
    cliInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    cliPollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll",
    businessLoginUrl: "https://api.z.ai/api/auth/z/login",
    apiBaseUrl: "https://api.z.ai",
    planApiKeyName: "zcode-api-key",
  },
  transport: {
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    format: "claude",
    headers: {
      "Anthropic-Version": ANTHROPIC_API_VERSION,
      "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
      "X-ZCode-App-Version": ZCODE_APP_VERSION,
      "X-Title": "Z Code@electron",
      "HTTP-Referer": "https://zcode.z.ai",
    },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
      hooks: ["glmStartAuthorization"],
    },
  },
  // ZCode's start-plan catalog: GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo. GLM-5.3 is
  // included because the trial quota advertised on z.ai/subscribe lists it.
  models: [
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
  ],
  serviceKinds: ["llm"],
  features: {},
};

export default glmStart;
