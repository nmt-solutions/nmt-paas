import NewProject from "@/components/repositories/new-project";
import Search from "@/components/search/search";
import { Separator } from "@/components/ui/separator";

const NewProjectPage = () => {
  return (
    <div>
      <Search placeholder="Enter a Git Repository URL" />
      <Separator orientation="horizontal" className="my-8" />
      <div className="flex items-center justify-center">
        <NewProject />
      </div>
    </div>
  );
};

export default NewProjectPage;
