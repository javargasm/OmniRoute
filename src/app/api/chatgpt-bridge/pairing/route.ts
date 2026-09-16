import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createChatGptWebBridgeManagementHandlers } from "@/lib/chatgptWebBridge/managementApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const handlers = createChatGptWebBridgeManagementHandlers({
  authorize: (request) => requireManagementAuth(request, { alwaysRequireAuth: true }),
});

/** POST /api/chatgpt-bridge/pairing — issue one ephemeral pairing secret after management auth. */
export const POST = handlers.createPairing;
