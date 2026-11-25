import { createFileRoute } from "@tanstack/react-router";
import { CsrCall } from "@/components/csr-call";

export const Route = createFileRoute("/portal/call")({
  component: CsrCall,
});
