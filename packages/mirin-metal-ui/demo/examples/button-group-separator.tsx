import { Button } from "../../src/components/button.tsx";
import { ButtonGroup, ButtonGroupSeparator } from "../../src/components/button-group.tsx";

export default function ButtonGroupSeparatorDemo() {
  return (
    <ButtonGroup>
      <Button variant="secondary" size="sm">
        Copy
      </Button>
      <ButtonGroupSeparator />
      <Button variant="secondary" size="sm">
        Paste
      </Button>
    </ButtonGroup>
  );
}
