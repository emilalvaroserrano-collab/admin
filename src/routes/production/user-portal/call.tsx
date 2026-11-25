import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { openZendeskVoice } from "@/components/zendesk-voice-call";

export const Route = createFileRoute("/production/user-portal/call")({
  component: StartCall,
});

function StartCall() {
  useEffect(() => {
    openZendeskVoice();
  }, []);
  return <Navigate to="/production/user-portal" replace />;
}
