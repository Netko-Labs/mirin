import { Button } from "../../src/components/button.tsx";
import { ArrowUpIcon } from "../../src/icons/index.ts";

export default function ButtonRounded() {
  return (
    <div className="flex flex-col gap-8">
      <Button variant="outline" size="icon" className="rounded-full">
        <ArrowUpIcon />
      </Button>
    </div>
  );
}
