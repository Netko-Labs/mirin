import { InputGroup, InputGroupAddon, InputGroupInput } from "../../src/components/input-group.tsx";
import { Kbd } from "../../src/components/kbd.tsx";
import { SearchIcon } from "../../src/icons/index.ts";

export default function KbdInputGroup() {
  return (
    <div className="flex w-full max-w-xs flex-col gap-6">
      <InputGroup>
        <InputGroupInput placeholder="Search..." />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupAddon align="inline-end">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
