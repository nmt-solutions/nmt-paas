import { PlusCircle } from "lucide-react";
import Link from "next/link";
import Search from "@/components/search/search";
import Empty from "@/components/states/empty";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const ProjectsPage = () => {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Search placeholder="Search Projects..." />
        <Link className={buttonVariants()} href="/projects/new">
          <PlusCircle /> New Project
        </Link>
      </div>
      <Separator orientation="horizontal" className="my-8" />
      <div className="flex items-center justify-center">
        <Empty title="No Projects Found" />
      </div>
    </div>
  );
};

export default ProjectsPage;
