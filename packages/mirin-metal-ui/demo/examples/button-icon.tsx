import { Button } from "../../src/components/button.tsx";
import { CircleFadingArrowUpIcon } from "../../src/icons/index.ts";

export default function ButtonIcon() {
  return (
    <Button variant="outline" size="icon">
      <CircleFadingArrowUpIcon />
    </Button>
  );
}
