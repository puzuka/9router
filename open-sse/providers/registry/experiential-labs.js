export default {
  id: "experiential-labs",
  priority: 61,
  alias: "experiential-labs",
  aliases: [
    "experientiallabs",
    "xpl",
  ],
  uiAlias: "xpl",
  display: {
    name: "Experiential Labs",
    icon: "fact_check",
    color: "#7C3AED",
    textIcon: "XL",
    website: "https://experientiallabs.ai",
    notice: {
      text: "System One — structured question answering. Send a state + questions, get back grounded answers with confidence scores (model jev-latest).",
      apiKeyUrl: "https://experientiallabs.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: null,
  models: [
    { id: "jev-latest", name: "JEV Latest", kind: "systemOne" },
  ],
  serviceKinds: ["systemOne"],
  systemOneConfig: {
    baseUrl: "https://api.experientiallabs.ai/v1/systemone",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    defaultModel: "jev-latest",
    timeoutMs: 30000,
  },
};
