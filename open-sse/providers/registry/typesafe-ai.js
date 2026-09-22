export default {
  id: "typesafe-ai",
  priority: 60,
  alias: "typesafe-ai",
  aliases: [
    "typesafe",
  ],
  uiAlias: "typesafe",  display: {
    name: "Typesafe AI",
    icon: "fact_check",
    color: "#2563EB",
    textIcon: "TS",
    website: "https://typesafe.ai",
    notice: {
      text: "System One — structured question answering. Send a state + questions, get back grounded answers with confidence scores (model jev-latest).",
      apiKeyUrl: "https://typesafe.ai",
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
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    defaultModel: "jev-latest",
    timeoutMs: 30000,
  },
};
