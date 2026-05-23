import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";
import SignIn from "@/components/auth/signin";
import SignOut from "@/components/auth/signout";
import { ToggleTheme } from "@/components/theme/toggle-theme";
import { buttonVariants } from "@/components/ui/button";
import { appRoutes } from "@/routes";

export default async function Home() {
  const { user } = await withAuth();

  const isLoggedIn = Boolean(user);

  return (
    <div className="h-screen w-screen flex justify-center items-center gap-2">
      <ToggleTheme />
      {!isLoggedIn && <SignIn />}
      {isLoggedIn && <SignOut />}
      {appRoutes.map((route) => (
        <Link key={route.path} href={route.path} className={buttonVariants()}>
          {route.label}
        </Link>
      ))}
    </div>
  );
}
