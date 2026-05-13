import { Home, LayoutDashboard, type Loader2 } from "lucide-react";
import { match } from "path-to-regexp";

export type Route = {
  label: string;
  path: string;
  icon: typeof Loader2;
  isProtected: boolean;
  sidebar: boolean;
  isSidebarItem: boolean;
};

export const appRoutes: Route[] = [
  {
    label: "Home",
    path: "/",
    icon: Home,
    isProtected: false,
    sidebar: false,
    isSidebarItem: true,
  },
  {
    label: "Dashboard",
    path: "/dashboard",
    icon: LayoutDashboard,
    isProtected: true,
    sidebar: true,
    isSidebarItem: true,
  },
];

export const getActiveRoute = (pathname: string) => {
  return appRoutes.find((route) => match(route.path)(pathname));
};
