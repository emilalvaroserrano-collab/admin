import { createFileRoute } from "@tanstack/react-router";
import { handleZendeskWebhook } from "@/lib/portal/zendesk-webhook.server";

export const Route = createFileRoute("/api/zendesk/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => handleZendeskWebhook(request),
    },
  },
});
