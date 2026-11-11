import Link from "../../src/compat/next-link.tsx";

import { Button } from "../../src/components/button.tsx";

export default function ButtonAsChild() {
  return (
    <Button asChild>
      <Link href="/login">Login</Link>
    </Button>
  );
}
