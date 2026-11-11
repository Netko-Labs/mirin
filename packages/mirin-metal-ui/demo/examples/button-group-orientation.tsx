import { Button } from "../../src/components/button.tsx";
import { ButtonGroup } from "../../src/components/button-group.tsx";
import { MinusIcon, PlusIcon } from "../../src/icons/index.ts";

export default function ButtonGroupOrientation() {
  return (
    <ButtonGroup orientation="vertical" aria-label="Media controls" className="h-fit">
      <Button variant="outline" size="icon">
        <PlusIcon />
      </Button>
      <Button variant="outline" size="icon">
        <MinusIcon />
      </Button>
    </ButtonGroup>
  );
}
