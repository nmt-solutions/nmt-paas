import { ArrowUpRightIcon, FolderCode } from "lucide-react";
import Link from "next/link";
import { Button } from "../ui/button";
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

const Empty = ({
  title,
  description,
  primaryButton,
  secondaryButton,
}: {
  title: string;
  description?: string;
  primaryButton?: React.ComponentProps<"button">;
  secondaryButton?: React.ComponentProps<"button">;
}) => {
  return (
    <EmptyContent>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderCode />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center gap-2">
        {primaryButton && <Button {...primaryButton} />}
        {secondaryButton && <Button {...secondaryButton} variant="outline" />}
      </EmptyContent>
      <Button
        variant="link"
        asChild
        className="text-muted-foreground"
        size="sm"
      >
        <Link href="#">
          Learn More <ArrowUpRightIcon />
        </Link>
      </Button>
    </EmptyContent>
  );
};

export default Empty;
