import { ButtonGroup, ButtonGroupText } from "../../src/components/button-group.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../src/components/input-group.tsx";
import { Label } from "../../src/components/label.tsx";
import { Link2Icon } from "../../src/icons/index.ts";

export default function InputGroupButtonGroup() {
  return (
    <div className="grid w-full max-w-sm gap-6">
      <ButtonGroup>
        <ButtonGroupText asChild>
          <Label htmlFor="url">https://</Label>
        </ButtonGroupText>
        <InputGroup>
          <InputGroupInput id="url" />
          <InputGroupAddon align="inline-end">
            <Link2Icon />
          </InputGroupAddon>
        </InputGroup>
        <ButtonGroupText>.com</ButtonGroupText>
      </ButtonGroup>
    </div>
  );
}
