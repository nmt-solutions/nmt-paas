import AppDetails from "@/components/apps/app-details";

export default async function AppPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  return <AppDetails appId={Number(appId)} />;
}
