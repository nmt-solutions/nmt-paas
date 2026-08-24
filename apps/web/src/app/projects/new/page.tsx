import NewProject from "@/components/repositories/new-project";

const NewProjectPage = () => {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-8">
        <p className="text-sm font-medium text-primary">Create</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Import a repository
        </h1>
        <p className="mt-2 text-muted-foreground">
          Select a GitHub project to configure and deploy.
        </p>
      </div>
      <div className="glass-panel overflow-hidden">
        <div className="border-b border-emerald-950/10 px-6 py-5 dark:border-white/10">
          <p className="font-medium">Connected repositories</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the source code you want NMT Deploy to build.
          </p>
        </div>
        <div className="p-3 sm:p-5">
          <NewProject />
        </div>
      </div>
    </div>
  );
};

export default NewProjectPage;
