import CheckGithub from "@/components/github/check-github";
import ConnectGithub from "@/components/github/connect-github";
import Repositories from "@/components/repositories/repositories";

export default function Dashboard() {
  return (
    <div>
      <ConnectGithub />
      <CheckGithub />
      <Repositories />
    </div>
  );
}
