import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";
import SignIn from "@/components/auth/signin";
import { ToggleTheme } from "@/components/theme/toggle-theme";
import { buttonVariants } from "@/components/ui/button";
import {
  ArrowRight,
  Boxes,
  Cloud,
  GitBranch,
  GitCommitHorizontal,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

export default async function Home() {
  const { user } = await withAuth();

  const isLoggedIn = Boolean(user);

  return (
    <main className="landing-shell min-h-screen overflow-hidden px-5 py-5 md:px-8">
      <nav className="mx-auto flex max-w-7xl items-center justify-between rounded-2xl border border-white/45 bg-white/45 px-4 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-emerald-950/30 md:px-5">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Cloud className="size-4" />
          </span>
          NMT Deploy
        </Link>
        <div className="flex items-center gap-2">
          <ToggleTheme />
          {isLoggedIn ? (
            <Link href="/dashboard" className={buttonVariants({ size: "sm" })}>
              Open console <ArrowRight />
            </Link>
          ) : (
            <SignIn />
          )}
        </div>
      </nav>
      <section className="mx-auto grid max-w-7xl items-center gap-12 py-20 lg:min-h-[calc(100vh-6rem)] lg:grid-cols-[1.05fr_.95fr] lg:py-12">
        <div className="relative z-10">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary">
            <Sparkles className="size-3.5" />
            Deploy with quiet confidence
          </div>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-[-0.055em] text-balance sm:text-6xl lg:text-7xl">
            Your code deserves a <span className="text-primary">beautiful</span>{" "}
            way to ship.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
            Connect a repository, configure your runtime, and follow every
            deployment from commit to production—without leaving your workspace.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {isLoggedIn ? (
              <Link
                href="/dashboard"
                className={buttonVariants({ size: "lg" })}
              >
                Go to dashboard <ArrowRight />
              </Link>
            ) : (
              <SignIn />
            )}
            <Link
              href="#how-it-works"
              className={buttonVariants({ size: "lg", variant: "outline" })}
            >
              See how it works
            </Link>
          </div>
          <div className="mt-12 flex flex-wrap gap-x-7 gap-y-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" />
              Private by default
            </span>
            <span className="inline-flex items-center gap-2">
              <GitCommitHorizontal className="size-4 text-primary" />
              Commit-pinned releases
            </span>
          </div>
        </div>
        <div className="hero-console relative mx-auto w-full max-w-xl rounded-[2rem] border border-white/50 bg-white/65 p-3 shadow-2xl shadow-emerald-950/15 backdrop-blur-2xl dark:border-white/10 dark:bg-emerald-950/35">
          <div className="rounded-[1.4rem] border border-emerald-950/10 bg-emerald-50/70 p-5 dark:border-white/10 dark:bg-black/20">
            <div className="flex items-center justify-between">
              <div className="flex gap-1.5">
                <i className="size-2.5 rounded-full bg-rose-400" />
                <i className="size-2.5 rounded-full bg-amber-400" />
                <i className="size-2.5 rounded-full bg-emerald-400" />
              </div>
              <span className="text-xs text-muted-foreground">
                Deployment overview
              </span>
            </div>
            <div className="mt-7 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-emerald-500 text-white">
                  <Boxes className="size-5" />
                </div>
                <div>
                  <p className="font-medium">marketing-site</p>
                  <p className="text-xs text-muted-foreground">
                    main · 4d81b2c
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                Ready
              </span>
            </div>
            <div className="mt-7 space-y-4 border-t border-emerald-950/10 pt-5 dark:border-white/10">
              <Status label="Repository cloned" />
              <Status label="Dependencies installed" />
              <Status label="Build completed" />
              <Status label="Live at nmt.app" active />
            </div>
          </div>
        </div>
      </section>
      <section
        id="how-it-works"
        className="mx-auto grid max-w-7xl gap-4 pb-12 md:grid-cols-3"
      >
        <Feature
          icon={<GitBranch />}
          title="Connect"
          body="Bring any GitHub repository into your workspace."
        />
        <Feature
          icon={<Boxes />}
          title="Configure"
          body="Set the framework, commands, ports, and secrets once."
        />
        <Feature
          icon={<Cloud />}
          title="Deploy"
          body="Watch a commit become a healthy production app."
        />
      </section>
    </main>
  );
}

function Status({
  label,
  active = false,
}: {
  label: string;
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className={`size-2 rounded-full ${active ? "bg-emerald-500 shadow-[0_0_12px] shadow-emerald-400" : "bg-emerald-500/50"}`}
      />
      <span>{label}</span>
      {active && (
        <span className="ml-auto text-xs text-primary">Production</span>
      )}
    </div>
  );
}
function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="glass-panel p-5">
      <div className="mb-5 text-primary">{icon}</div>
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}
