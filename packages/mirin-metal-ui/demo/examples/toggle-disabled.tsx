import { Toggle } from "../../src/components/toggle.tsx";
import { Underline } from "../../src/icons/index.ts";

export default function ToggleDisabled() {
  return (
    <Toggle aria-label="Toggle italic" disabled>
      <Underline className="h-4 w-4" />
    </Toggle>
  );
}
