"use client";

import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SiteHeader } from "@/components/app-sidebar/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getActiveRoute } from "@/routes";

const AppSidebarProvider = ({ children }: PropsWithChildren) => {
  const pathname = usePathname();

  const activeRoute = getActiveRoute(pathname);

  if (!activeRoute?.sidebar) {
    return <>{children}</>;
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "17rem",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar
        variant="inset"
        className="border-r border-white/35 bg-sidebar/60 backdrop-blur-2xl dark:border-white/8"
      />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-8">
              {children}
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default AppSidebarProvider;
