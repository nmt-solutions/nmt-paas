"use client";

import { usePathname } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { getActiveRoute } from "@/routes";
import { ToggleTheme } from "@/components/theme/toggle-theme";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus } from "lucide-react";

export function SiteHeader() {
  const pathname = usePathname();

  const activeRoute = getActiveRoute(pathname);

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b border-white/35 bg-background/50 backdrop-blur-xl transition-[width,height] ease-linear dark:border-white/8 group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2" />
        <h1 className="text-base font-semibold tracking-tight">
          {activeRoute?.label}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <ToggleTheme />
          <Button size="sm" asChild>
            <Link href="/projects/new">
              <Plus />
              New project
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
