import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createChatGptWebBridgeManagementHandlers } from "@/lib/chatgptWebBridge/managementApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const handlers = createChatGptWebBridgeManagementHandlers({
  authorize: (request) => requireManagementAuth(request, { alwaysRequireAuth: true }),
});

/** GET /api/chatgpt-bridge/status — safe local bridge status for the authenticated dashboard. */
export const GET = handlers.status;
