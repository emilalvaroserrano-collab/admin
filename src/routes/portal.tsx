import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { PortalShell } from "@/components/customer-portal";
import { openPortalFromAuth } from "@/lib/portal/api";
import { setShopToken, useShopToken } from "@/lib/portal/shop-session";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Boot } from "@/components/ui";

export const Route = createFileRoute("/portal")({
  component: PortalLayout,
});

function PortalLayout() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { user, isPending } = useCurrentUserState();
  const token = useShopToken();
  // The call screen is standalone: it talks to the CSR directly and must not
  // wait on the shop-token handshake (which can take a slow Zendesk round trip).
  const isCall = path === "/portal/call";
  const link = useQuery({
    queryKey: ["portal-auth", user?.id],
    queryFn: () => openPortalFromAuth(),
    enabled: Boolean(user) && !isCall,
  });
  useEffect(() => {
    if (link.data?.token) setShopToken(link.data.token);
  }, [link.data?.token]);
  if (isCall) {
    if (isPending) return <Boot />;
    return user ? <Outlet /> : <Navigate to="/upgrade" />;
  }
  if (isPending || (user && (link.isPending || link.data?.token !== token))) return <Boot />;
  if (!user) return <Navigate to="/upgrade" />;
  return (
    <PortalShell>
      <Outlet />
    </PortalShell>
  );
}
