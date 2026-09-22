import { handleSystemOne } from "@/sse/handlers/systemOne.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/systemone - System One structured question answering
 */
export async function POST(request) {
  return await handleSystemOne(request);
}
