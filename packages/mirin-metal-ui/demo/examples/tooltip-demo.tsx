import { Button } from "../../src/components/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../src/components/tooltip.tsx";

export default function TooltipDemo() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover</Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>Add to library</p>
      </TooltipContent>
    </Tooltip>
  );
}
