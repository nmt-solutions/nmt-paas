import { ArrowLeft, ArrowRight } from "lucide-react";
import usePaginate from "@/hooks/paginate/use-paginate";
import { Button } from "../ui/button";

const Pagination = ({ id, data }: { id: string; data: unknown[] }) => {
  const {
    prev,
    disablePrev,
    next,
    disableNext,
    showingFrom,
    showingTill,
    totalItems,
  } = usePaginate(data, { id });

  return (
    <div className="text-right text-muted-foreground py-2 flex items-center justify-between">
      <Button variant="outline" disabled={disablePrev} onClick={prev}>
        <ArrowLeft />
      </Button>
      <p>
        Showing {showingFrom} to {showingTill} of {totalItems} records
      </p>
      <Button variant="outline" disabled={disableNext} onClick={next}>
        <ArrowRight />
      </Button>
    </div>
  );
};

export default Pagination;
