import { IconPlus } from "../../src/compat/tabler-icons.ts";

import { Button } from "../../src/components/button.tsx";
import { ButtonGroup, ButtonGroupSeparator } from "../../src/components/button-group.tsx";

export default function ButtonGroupSplit() {
  return (
    <ButtonGroup>
      <Button variant="secondary">Button</Button>
      <ButtonGroupSeparator />
      <Button size="icon" variant="secondary">
        <IconPlus />
      </Button>
    </ButtonGroup>
  );
}
