import { Button } from "../../src/components/button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "../../src/components/item.tsx";
import { Progress } from "../../src/components/progress.tsx";
import { Spinner } from "../../src/components/spinner.tsx";

export default function SpinnerItem() {
  return (
    <div className="flex w-full max-w-md flex-col gap-4 [--radius:1rem]">
      <Item variant="outline">
        <ItemMedia variant="icon">
          <Spinner />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Downloading...</ItemTitle>
          <ItemDescription>129 MB / 1000 MB</ItemDescription>
        </ItemContent>
        <ItemActions className="hidden sm:flex">
          <Button variant="outline" size="sm">
            Cancel
          </Button>
        </ItemActions>
        <ItemFooter>
          <Progress value={75} />
        </ItemFooter>
      </Item>
    </div>
  );
}
