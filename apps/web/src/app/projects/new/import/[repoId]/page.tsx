import ImportRepository from "@/components/repositories/import-repository";

const ImportProject = async ({
  params,
  searchParams,
}: {
  params: Promise<{ repoId: string }>;
  searchParams: Promise<{
    gitProvider: "github";
    repo: string;
    branch: string;
  }>;
}) => {
  const p = await params;
  const query = await searchParams;

  return (
    <ImportRepository
      gitProvider={query.gitProvider}
      repoId={p.repoId}
      repo={query.repo}
      branch={query.branch}
    />
  );
};

export default ImportProject;
