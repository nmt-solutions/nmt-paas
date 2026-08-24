"use client";

import { CirclePlusIcon } from "lucide-react";
import Link from "next/link";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { appRoutes, getActiveRoute } from "@/routes";
import { usePathname } from "next/navigation";

export function NavMain() {
  const navItems = appRoutes.filter((route) => route.isSidebarItem);

  const pathname = usePathname();
  const activeRoute = getActiveRoute(pathname);

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            <SidebarMenuButton
              asChild
              tooltip="New project"
              className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
            >
              <Link href="/projects/new">
                <CirclePlusIcon />
                <span>New project</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu>
          {navItems.map((item) => (
            <Link key={item.path} href={item.path}>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={item.label}
                  isActive={item.path === activeRoute?.path}
                >
                  <item.icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </Link>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
