import { Button } from "../../src/components/button.tsx";
import { ButtonGroup } from "../../src/components/button-group.tsx";
import { Input } from "../../src/components/input.tsx";
import { SearchIcon } from "../../src/icons/index.ts";

export default function ButtonGroupInput() {
  return (
    <ButtonGroup>
      <Input placeholder="Search..." />
      <Button variant="outline" aria-label="Search">
        <SearchIcon />
      </Button>
    </ButtonGroup>
  );
}
