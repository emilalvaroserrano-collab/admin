import { createFileRoute } from "@tanstack/react-router";
import { handleZendeskWebhook } from "@/lib/portal/zendesk-webhook.server";

/**
 * Zendesk's configured "MTS portal sync" webhook target:
 *   https://mtsportal.cloudgpu.site/ai-agents/automation/support/v1/webhook
 *
 * Same verification and ingest as `/api/zendesk/webhook`, mounted on the exact
 * path the Zendesk admin panel points at.
 */
export const Route = createFileRoute("/ai-agents/automation/support/v1/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => handleZendeskWebhook(request),
    },
  },
});
