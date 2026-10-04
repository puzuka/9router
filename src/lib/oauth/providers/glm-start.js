import glm from "./glm.js";
import { GLM_START_OAUTH_CONFIG } from "../constants/oauth.js";

// Z.ai Start Plan (trial/promo quota). Same ZCode CLI polling login as `glm`,
// but mapTokens stores the ZCode JWT as the connection credential instead of a
// minted coding-plan API key (the poll handler skips key derivation when
// config.planKind === "start-plan").
const glmStart = { ...glm, config: GLM_START_OAUTH_CONFIG };

export default glmStart;