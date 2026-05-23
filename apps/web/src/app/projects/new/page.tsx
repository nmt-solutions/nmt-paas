import ImportRepository from "@/components/github/import-repository";
import Search from "@/components/search/search";
import { Separator } from "@/components/ui/separator";

const NewProject = () => {
  return (
    <div>
      <Search placeholder="Enter a Git Repository URL" />
      <Separator orientation="horizontal" className="my-8" />
      <div className="flex items-center justify-center">
        <ImportRepository />
      </div>
    </div>
  );
};

export default NewProject;
