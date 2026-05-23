import { Search as SearchIcon } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";

const Search = ({
  resultsCount,
  ...inputProps
}: React.ComponentProps<"input"> & {
  resultsCount?: number;
}) => {
  return (
    <InputGroup>
      <InputGroupInput {...inputProps} />
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      {resultsCount != null && (
        <InputGroupAddon align="inline-end">
          {resultsCount} results
        </InputGroupAddon>
      )}
    </InputGroup>
  );
};

export default Search;
