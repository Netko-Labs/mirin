import { IconGitBranch } from "../../src/compat/tabler-icons.ts";

import { Button } from "../../src/components/button.tsx";

export default function ButtonWithIcon() {
  return (
    <Button variant="outline" size="sm">
      <IconGitBranch /> New Branch
    </Button>
  );
}
